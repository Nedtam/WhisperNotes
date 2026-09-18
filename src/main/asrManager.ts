// 转写编排：PCM 流入 → VAD 分句 → whisper 转写 → 本地清洗 → 上行事件
import type { AppSettings, AsrSegment, AsrDraft, EngineState } from '@shared/types'
import { VadSegmenter } from './segmenter'
import { WhisperCppEngine, type AsrEngine } from './whisperServer'
import { cleanSegment } from './clean'
import { i18nCode } from './i18n'
import { applyTermCorrection } from './course'
import { encodeWav, WavWriter } from './wav'
import { wavDataRange } from './decodeAudio'
import { agcNormalize, agcUtterance } from './agc'
import { Resampler } from './resample'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface AsrCallbacks {
  onSegment: (s: AsrSegment) => void
  onDraft: (d: AsrDraft) => void
  onState: (m: { state: EngineState; detail?: string }) => void
}

export interface StartOutcome {
  sessionId: string
  wavPath?: string
}

export interface StopOutcome {
  elapsedMs: number
  segmentCount: number
  wavPath?: string
}

export class AsrManager {
  private engine: AsrEngine = new WhisperCppEngine()
  private callbacks: AsrCallbacks
  private state: EngineState = 'idle'
  private seq = 0
  private sessionId = ''
  private startedAt = 0
  private segmenter: VadSegmenter | null = null
  private wavWriter: WavWriter | null = null
  private wavPath: string | null = null
  private queue: Array<{ samples: Float32Array; t0: number }> = []
  private processing = false
  private pendingPartial: Float32Array | null = null
  private partialBusy = false
  private lastDraftSentAt = 0
  private finalCount = 0
  private dirs: { recordings: string; models: string; logs: string }
  private modelPathCache = ''
  private promptCache = ''
  private gpuCache: boolean | null = null
  private resampler: Resampler | null = null
  private resamplerInRate = 0
  private correctionTerms: string[] = []
  private correctionEnabled = false

  constructor(callbacks: AsrCallbacks, dirs: { recordings: string; models: string; logs: string }) {
    this.callbacks = callbacks
    this.dirs = dirs
  }

  get currentState(): EngineState {
    return this.state
  }

  private setState(state: EngineState, detail?: string): void {
    this.state = state
    this.callbacks.onState({ state, detail })
  }

  /** 解析当前设置下的模型文件绝对路径 */
  resolveModelPath(settings: AppSettings): string {
    const f = settings.whisper.modelFile
    if (path.isAbsolute(f)) return f
    return path.join(this.dirs.models, f)
  }

  // ── 导入录音控制（暂停/继续/停止）─────────────────────
  private importPaused = false
  private importStop = false
  private importAbort: AbortController | null = null
  private importWake: (() => void) | null = null

  pauseImport(): void {
    if (this.importAbort) this.importPaused = true
  }
  get importStopped(): boolean {
    return this.importStop
  }

  /** 引擎是否正在做转写相关工作（用于禁止删模型等破坏性操作） */
  get busy(): boolean {
    return (
      this.state === 'starting' ||
      this.state === 'recording' ||
      this.state === 'paused' ||
      this.state === 'stopping' ||
      this.state === 'finalizing'
    )
  }
  resumeImport(): void {
    this.importPaused = false
    const w = this.importWake
    this.importWake = null
    w?.()
  }
  stopImport(): void {
    this.importStop = true
    this.importAbort?.abort()
    const w = this.importWake
    this.importWake = null
    w?.()
  }
  private resetImportCtl(): void {
    this.importPaused = false
    this.importStop = false
    this.importAbort = new AbortController()
    this.importWake = null
  }
  /** 暂停/停止协程：返回 false 表示应中止 */
  private async waitImportGo(): Promise<boolean> {
    while (this.importPaused && !this.importStop) {
      await new Promise<void>((r) => {
        this.importWake = r
      })
    }
    return !this.importStop
  }

  /** 一次性转写（导入录音文件用）：
   *  两遍法——① 快扫 VAD 建立“句段时间表”（含静音定位）→ ② 按 ≤23s 上下文窗口整窗送引擎。
   *  相比逐句请求，窗口内保留句子间上下文与静音节奏，避免长录音漏上下文导致的精度下降；
   *  窗口在静音处分界 → 天然跳过静音、便于显示当前进度/位置。支持暂停/停止。
   *  不进入录音状态机。全程只缓存 23s 窗口，长录音不会整段驻留内存。 */
  async transcribeFileOnce(
    settings: AppSettings,
    wavPath: string,
    onSegment?: (s: AsrSegment) => void,
    onProgress?: (p: { pct: number; posSec: number; totalSec: number; skipSec: number }) => void
  ): Promise<AsrSegment[]> {
    if (this.state === 'recording' || this.state === 'starting' || this.state === 'paused') {
      throw new Error(i18nCode('err.importBusy'))
    }
    if (!fs.existsSync(wavPath)) throw new Error(i18nCode('err.importTempMissing'))
    this.resetImportCtl()
    const abortSignal = this.importAbort!.signal

    const modelPath = this.resolveModelPath(settings)
    // 导入文件不套用会话提示词：引擎若带着旧课提示词需重启为干净状态
    const useGpu = settings.whisper.useGpu !== false
    const needRestart =
      modelPath !== this.modelPathCache ||
      !this.engine.isRunning ||
      this.promptCache !== '' ||
      this.gpuCache !== useGpu
    if (needRestart) {
      try {
        await this.engine.stop()
      } catch {
        /* ignore */
      }
      await this.engine.start({
        modelPath,
        language: settings.whisper.language || 'en',
        threads: settings.whisper.threads,
        logDir: this.dirs.logs,
        prompt: '', // 导入文件不套用会话提示词
        useGpu
      })
      this.modelPathCache = modelPath
      this.promptCache = ''
      this.gpuCache = useGpu
    }

    const fd = fs.openSync(wavPath, 'r')
    const out: AsrSegment[] = []
    let skippedSec = 0
    try {
      const stat = fs.fstatSync(fd)
      const head = Buffer.alloc(8192)
      const got = fs.readSync(fd, head, 0, head.length, 0)
      const { off, len } = wavDataRange(head.subarray(0, got), stat.size)
      const totalData = Math.min(len, Math.max(0, stat.size - off))
      const totalSec = totalData / 2 / 16000
      const readF32 = (startSec: number, endSec: number): Float32Array => {
        const start = Math.max(0, Math.min(totalData, Math.round(startSec * 32000)))
        const end = Math.max(start, Math.min(totalData, Math.round(endSec * 32000)))
        const n = Math.floor((end - start) / 2)
        const b = Buffer.alloc(Math.max(0, n * 2))
        if (n > 0) fs.readSync(fd, b, 0, n * 2, off + start)
        const f = new Float32Array(n)
        for (let i = 0; i < n; i++) f[i] = b.readInt16LE(i * 2) / 32768
        return f
      }

      // ① 快扫：VAD 找出所有“有语音的句段”（t0..t1），供后续窗口分界与静音统计
      const utts: Array<{ t0: number; t1: number }> = []
      const vad = new VadSegmenter(
        {
          onFinal: (_s, t0, t1) => {
            utts.push({ t0, t1 }) // t1 由 flush 提供，含尾 padding
          },
          onPartial: () => undefined
        },
        {
          sampleRate: 16000,
          sensitivity: settings.whisper.sensitivity,
          minSilenceMs: settings.whisper.minSilenceMs,
          maxSpeechSec: settings.whisper.maxSpeechSec
        }
      )
      const SCAN_BLOCK = 16000 * 10
      const scanBuf = Buffer.alloc(SCAN_BLOCK * 2)
      let pos = off
      for (;;) {
        const need = Math.min(scanBuf.length, totalData - (pos - off))
        if (need <= 0) break
        const readN = fs.readSync(fd, scanBuf, 0, need, pos)
        if (readN <= 0) break
        pos += readN
        const n = Math.floor(readN / 2)
        const blk = new Float32Array(n)
        for (let i = 0; i < n; i++) blk[i] = scanBuf.readInt16LE(i * 2) / 32768
        vad.process(agcNormalize(blk))
      }
      vad.flush()

      // ② 组装“上下文窗口”：把相邻句段按静音跨度并成一个 ≤ WINDOW 的整窗（保留窗内静音与节奏）
      const WINDOW = 23 // whisper 30s 上下文，留余量
      const finishWindow = async (startSec: number, endSec: number): Promise<void> => {
        const audio = agcNormalize(readF32(startSec, endSec))
        let rawSegs: Array<{ t0: number; t1: number; text: string }> = []
        try {
          rawSegs = await this.engine.transcribeWavDetailed(encodeWav(audio), 300_000, abortSignal)
        } catch (err) {
          if (this.importStop) throw err // 停止
          console.error('[asr] import-window transcription failed, skipped:', (err as Error).message)
        }
        for (const s of rawSegs) {
          const outcome = cleanSegment(s.text, settings.clean)
          if (!outcome.text) continue
          const segRec: AsrSegment = {
            seq: out.length,
            text: outcome.text,
            t0: Math.round((startSec + s.t0) * 1000) / 1000,
            t1: Math.round((startSec + s.t1) * 1000) / 1000,
            cleaned: outcome.changed
          }
          out.push(segRec)
          onSegment?.(segRec)
        }
        // 进度 = 已送达窗口末尾的文件位置；累计跳过静音单独统计
        const pct = totalSec > 0 ? Math.min(99, Math.round((endSec / totalSec) * 100)) : 0
        onProgress?.({
          pct,
          posSec: Math.round(endSec * 10) / 10,
          totalSec: Math.round(totalSec * 10) / 10,
          skipSec: Math.round(skippedSec * 10) / 10
        })
      }

      if (utts.length === 0) {
        // 全程没检出语音（音乐/纯静音/阈值偏高）：按固定 20s 窗退化处理，仍然支持暂停/停止/进度
        const CHUNK = 20
        let wStart = 0
        while (wStart < totalSec) {
          if (!(await this.waitImportGo())) break
          const wEnd = Math.min(totalSec, wStart + CHUNK)
          const audio = agcNormalize(readF32(wStart, wEnd))
          let text = ''
          try {
            const raw = await this.engine.transcribeWavDetailed(encodeWav(audio), 300_000, abortSignal)
            text = raw.map((s) => s.text).join(' ')
          } catch (err) {
            if (this.importStop) break
            console.error('[asr] import-window transcription failed, skipped:', (err as Error).message)
          }
          const outcome = cleanSegment(text, settings.clean)
          if (outcome.text) {
            const segRec: AsrSegment = {
              seq: out.length,
              text: outcome.text,
              t0: Math.round(wStart * 1000) / 1000,
              t1: Math.round(wEnd * 1000) / 1000,
              cleaned: outcome.changed
            }
            out.push(segRec)
            onSegment?.(segRec)
          }
          const pct = totalSec > 0 ? Math.min(99, Math.round((wEnd / totalSec) * 100)) : 0
          onProgress?.({ pct, posSec: Math.round(wEnd * 10) / 10, totalSec: Math.round(totalSec * 10) / 10, skipSec: 0 })
          wStart = wEnd
          if (this.importStop) break
        }
        if (!this.importStop) {
          onProgress?.({ pct: 100, posSec: Math.round(totalSec * 10) / 10, totalSec: Math.round(totalSec * 10) / 10, skipSec: 0 })
        }
        return out
      }

      // 用 VAD 句段构造窗口：同一窗口内保留句段间 ≤1.5s 静音（连同上下文一起送引擎）；
      // 句段跨度超窗长上限或出现大段静音时开新窗（该静音即被“跳过”，计入 skipSec）
      const padBefore = 0.25
      const padAfter = 0.35
      const winStartOf = (k: number): number => Math.max(0, utts[k].t0 - padBefore)
      const winEndOf = (k: number): number => Math.min(totalSec, utts[k].t1 + padAfter)
      let i = 0
      let prevEnd = 0
      while (i < utts.length) {
        if (!(await this.waitImportGo())) break
        // 贪心扩展窗口：窗口内累计到 WINDOW 秒，或句段间隙 > 1.5s 就封窗
        let j = i
        while (j + 1 < utts.length) {
          const gap = utts[j + 1].t0 - utts[j].t1
          if (gap > 1.5) break // 大段静音 → 天然分窗
          if (winEndOf(j + 1) - winStartOf(i) > WINDOW) break // 超出上下文窗长
          j++
        }
        const ws = winStartOf(i)
        const we = winEndOf(j)
        // 跳过静音累计：上一窗末尾(含尾 padding) → 本窗起点(含前 padding) 之间未发送的部分
        if (ws > prevEnd) skippedSec += ws - prevEnd
        try {
          await finishWindow(ws, we)
        } catch {
          break // 用户停止
        }
        prevEnd = we
        i = j + 1
        if (this.importStop) break
      }
      // 结尾若有未覆盖的静音（文件尾部）也计入
      if (totalSec > prevEnd) skippedSec += totalSec - prevEnd
      // 正常完成才报 100%；停止/中断由 ipc 层发 stopped 事件，不在此伪装完成
      if (!this.importStop) {
        onProgress?.({
          pct: 100,
          posSec: Math.round(totalSec * 10) / 10,
          totalSec: Math.round(totalSec * 10) / 10,
          skipSec: Math.round(skippedSec * 10) / 10
        })
      }
      return out
    } finally {
      fs.closeSync(fd)
    }
  }

  async start(settings: AppSettings, promptOverride = ''): Promise<StartOutcome> {
    if (this.state === 'recording' || this.state === 'starting' || this.state === 'paused') {
      throw new Error(i18nCode('err.alreadyRecording'))
    }
    this.setState('starting')

    // 模型不存在时自动改选任意已安装模型；一个都没有则给出明确指引（而不是启动超时死锁）
    let modelPath = this.resolveModelPath(settings)
    try {
      if (!fs.existsSync(modelPath)) {
        const candidates = fs
          .readdirSync(this.dirs.models)
          .filter((f) => /\.bin$/i.test(f))
          .map((f) => path.join(this.dirs.models, f))
          .filter((p) => fs.existsSync(p) && fs.statSync(p).size > 1_000_000)
        if (candidates.length) {
          modelPath = candidates[0]
        } else {
          throw new Error(i18nCode('err.noModel'))
        }
      }
    } catch (e) {
      this.setState('error', (e as Error).message)
      throw e
    }

    try {
      const useGpu = settings.whisper.useGpu !== false
      const needRestart =
        modelPath !== this.modelPathCache || !this.engine.isRunning || this.gpuCache !== useGpu
      if (needRestart) {
        try {
          await this.engine.stop()
        } catch {
          /* ignore */
        }
        await this.engine.start({
          modelPath,
          language: settings.whisper.language || 'en',
          threads: settings.whisper.threads,
          logDir: this.dirs.logs,
          prompt: promptOverride?.trim().slice(0, 800) || '',
          useGpu
        })
        this.modelPathCache = modelPath
        this.promptCache = promptOverride?.trim().slice(0, 800) || ''
        this.gpuCache = useGpu
      }
    } catch (e) {
      // 引擎启动失败：复位状态（否则会一直卡在 starting，页面“什么都做不了”）
      try {
        await this.engine.stop()
      } catch {
        /* ignore */
      }
      this.modelPathCache = ''
      this.setState('error', (e as Error).message || String(e))
      throw e
    }

    this.seq = 0
    this.finalCount = 0
    this.sessionId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    this.startedAt = Date.now()
    this.queue = []
    this.processing = false
    this.pendingPartial = null
    this.partialBusy = false
    this.lastDraftSentAt = 0
    this.resampler = null

    this.segmenter = new VadSegmenter(
      {
        onFinal: (samples, t0) => this.enqueueFinal(samples, t0),
        onPartial: (samples, t0) => this.onPartial(samples, t0)
      },
      {
        sampleRate: 16000,
        sensitivity: settings.whisper.sensitivity,
        minSilenceMs: settings.whisper.minSilenceMs,
        maxSpeechSec: settings.whisper.maxSpeechSec
      }
    )

    let wavPath: string | undefined
    if (settings.saveWav) {
      wavPath = path.join(this.dirs.recordings, `${this.sessionId}.wav`)
      this.wavPath = wavPath
      this.wavWriter = new WavWriter(wavPath)
    }

    this.setState('recording')
    return { sessionId: this.sessionId, wavPath }
  }

  /** 暂停：定稿当前句并进入 paused（期间忽略输入 PCM） */
  pause(): void {
    if (this.state !== 'recording') return
    this.segmenter?.flush()
    this.setState('paused')
  }

  /** 恢复录音 */
  resume(): void {
    if (this.state !== 'paused') return
    this.setState('recording')
  }

  pushPcm(chunk: Float32Array, rate: number, settings: AppSettings): void {
    if (this.state !== 'recording' || !this.segmenter) return
    let samples = chunk
    if (rate !== 16000) {
      if (!this.resampler || this.resamplerInRate !== rate) {
        this.resampler = new Resampler(rate, 16000)
        this.resamplerInRate = rate
      }
      samples = this.resampler.process(chunk)
      if (samples.length === 0) return
    }
    this.wavWriter?.writeSamples(samples)
    this.segmenter.process(samples)
  }

  private enqueueFinal(samples: Float32Array, t0: number): void {
    this.queue.push({ samples, t0 })
    void this.processQueue()
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()
        if (!item) break
        try {
          const text = await this.engine.transcribeWav(encodeWav(agcUtterance(item.samples)))
          this.emitFinal(text, item.t0, item.t0 + item.samples.length / 16000)
        } catch (err) {
          console.error('[asr] utterance transcription failed, skipped:', (err as Error).message)
        }
      }
    } finally {
      this.processing = false
      // 队列清空后若还有攒着的 partial，允许再吐一次
      if (this.pendingPartial) {
        const p = this.pendingPartial
        this.pendingPartial = null
        void this.runPartial(p)
      }
    }
  }

  private emitFinal(rawText: string, t0: number, t1: number): void {
    const settings = this.settingsSnapshot
    if (!settings) return
    const outcome = cleanSegment(rawText, settings.clean)
    let text = outcome.text
    let cleaned = outcome.changed
    if (!text) return
    // 课程词典保守术语校正（会话内课件提供时启用；大小写/连字符/拼写规范化）
    if (this.correctionEnabled && this.correctionTerms.length && text.length > 3) {
      const corr = applyTermCorrection(text, this.correctionTerms)
      if (corr.changed) {
        text = corr.text
        cleaned = true
      }
    }
    if (!text) return
    this.finalCount++
    this.callbacks.onSegment({
      seq: this.seq++,
      text,
      t0: Math.round(t0 * 1000) / 1000,
      t1: Math.round(t1 * 1000) / 1000,
      cleaned
    })
  }

  setCorrectionTerms(list: string[]): void {
    this.correctionTerms = list ?? []
    this.correctionEnabled = (list ?? []).length > 0
  }
  addCorrectionTerms(list: string[]): void {
    const set = new Set([...this.correctionTerms, ...(list ?? [])])
    this.correctionTerms = [...set]
    if ((list ?? []).length) this.correctionEnabled = true
  }

  private onPartial(samples: Float32Array, _t0: number): void {
    const settings = this.settingsSnapshot
    if (!settings || !settings.whisper.partialPreview) return
    if (this.queue.length >= settings.whisper.maxFinalQueue) return // 队列积压时跳过草稿
    if (this.partialBusy || this.processing) {
      this.pendingPartial = samples // 攒一份最新的
      return
    }
    void this.runPartial(samples)
  }

  private async runPartial(samples: Float32Array): Promise<void> {
    const settings = this.settingsSnapshot
    if (!settings) return
    this.partialBusy = true
    try {
      // 节流：与上一次草稿至少间隔
      const now = Date.now()
      if (now - this.lastDraftSentAt < 650) return
      const text = await this.engine.transcribeWav(encodeWav(agcUtterance(samples)))
      this.lastDraftSentAt = Date.now()
      if (!text) return
      const outcome = cleanSegment(text, settings.clean)
      if (!outcome.text) return
      this.callbacks.onDraft({ text: outcome.text, t0: 0, sinceLastUpdate: true })
    } catch {
      /* ignore */
    } finally {
      this.partialBusy = false
      if (this.pendingPartial && this.queue.length === 0 && !this.processing) {
        const p = this.pendingPartial
        this.pendingPartial = null
        void this.runPartial(p)
      }
    }
  }

  async stop(): Promise<StopOutcome> {
    if (this.state === 'recording' || this.state === 'paused') {
      this.setState('stopping')
      this.segmenter?.flush()
      // 等队列排空
      while (this.queue.length > 0 || this.processing) {
        await new Promise((r) => setTimeout(r, 50))
      }
      this.wavWriter?.finish()
      this.wavWriter = null
      const elapsedMs = Date.now() - this.startedAt
      this.setState('idle')
      return { elapsedMs, segmentCount: this.finalCount, wavPath: this.wavPath ?? undefined }
    }
    if (this.state === 'starting') {
      this.setState('idle')
    }
    return { elapsedMs: 0, segmentCount: this.finalCount, wavPath: this.wavPath ?? undefined }
  }

  async dispose(): Promise<void> {
    try {
      await this.engine.stop()
    } catch {
      /* ignore */
    }
    this.wavWriter = null
    this.state = 'idle'
  }

  // 由 ipc 层注入最新设置快照（转写回调需要）
  settingsSnapshot: AppSettings | null = null
}
