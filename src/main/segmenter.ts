// VAD 分段器：对 16kHz mono float32 PCM 做能量检测，
// 在有声/静音边界处切出「一句」utterance；说话期间周期性吐 partial。
export interface SegmenterEvents {
  onFinal: (samples: Float32Array, t0: number, t1: number) => void
  onPartial: (samples: Float32Array, t0: number) => void
}

export interface SegmenterOptions {
  sampleRate?: number
  /** 灵敏度 0-100：越高越不容易误判噪声为说话 */
  sensitivity?: number
  minSilenceMs?: number
  maxSpeechSec?: number
  partialMinMs?: number
  partialCadenceMs?: number
  speechPadMs?: number
  minSpeechMs?: number
}

const FRAME = 160 // 10ms @16k

export class VadSegmenter {
  private sr: number
  private onDb: number
  private offDb: number
  private minSilenceFrames: number
  private maxSpeechSamples: number
  private partialMinSamples: number
  private partialCadenceMs: number
  private padFrames: number
  private minSpeechSamples: number
  private ev: SegmenterEvents

  private frameBuf: number[] = []
  private recent: number[] = [] // 最近 padFrames*FRAME 个样本
  private absSamp = 0
  private speech = false
  private utt: number[] = []
  private silenceFrames = 0
  private uttStartAbs = 0
  private lastPartialAt = 0
  private maxSpeechStartAbs = 0

  constructor(ev: SegmenterEvents, opts: SegmenterOptions = {}) {
    this.ev = ev
    this.sr = opts.sampleRate ?? 16000
    const sens = opts.sensitivity ?? 55
    this.onDb = -62 + sens * 0.32 // 55 → -44.4 dBFS 说话起点
    this.offDb = this.onDb - 8
    this.minSilenceFrames = Math.max(10, Math.round((opts.minSilenceMs ?? 550) / 10))
    this.maxSpeechSamples = Math.round((opts.maxSpeechSec ?? 25) * 1000 * this.sr / 1000)
    this.partialMinSamples = Math.round(((opts.partialMinMs ?? 1500) * this.sr) / 1000)
    this.partialCadenceMs = opts.partialCadenceMs ?? 800
    this.padFrames = Math.round((opts.speechPadMs ?? 260) / 10)
    this.minSpeechSamples = Math.round(((opts.minSpeechMs ?? 300) * this.sr) / 1000)
  }

  process(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) {
      this.frameBuf.push(chunk[i])
      if (this.frameBuf.length === FRAME) {
        const frame = this.frameBuf
        this.frameBuf = []
        this.processFrame(frame)
      }
    }
  }

  private pushRecent(frame: number[]): void {
    this.recent.push(...frame)
    const maxLen = (this.padFrames + 2) * FRAME
    if (this.recent.length > maxLen) {
      this.recent.splice(0, this.recent.length - maxLen)
    }
  }

  private frameDb(frame: number[]): number {
    let sum = 0
    for (const s of frame) sum += s * s
    const rms = Math.sqrt(sum / frame.length)
    return 20 * Math.log10(Math.max(rms, 1e-5))
  }

  private processFrame(frame: number[]): void {
    const db = this.frameDb(frame)
    const t0Abs = this.absSamp
    this.absSamp += FRAME
    this.pushRecent(frame)

    if (!this.speech) {
      if (db >= this.onDb) {
        // 起句：用最近 pad 样本做前缀
        const pad = this.recent.length - FRAME * (this.padFrames + 2)
        const startIdx = Math.max(0, pad)
        this.utt = this.recent.slice(startIdx)
        this.uttStartAbs = Math.max(0, t0Abs - (this.recent.length - startIdx))
        this.speech = true
        this.silenceFrames = 0
        this.maxSpeechStartAbs = t0Abs
      }
      return
    }

    // 说话中
    this.utt.push(...frame)
    if (db >= this.offDb) this.silenceFrames = 0
    else this.silenceFrames++

    const nowMs = Math.round((this.absSamp / this.sr) * 1000)
    const uttSamples = this.utt.length
    const uttMs = Math.round((uttSamples / this.sr) * 1000)

    // 周期 partial（仅当尚未到句尾停顿）
    if (
      uttSamples >= this.partialMinSamples &&
      this.silenceFrames * 10 < this.minSilenceFrames - 2 &&
      nowMs - this.lastPartialAt >= this.partialCadenceMs
    ) {
      this.lastPartialAt = nowMs
      this.ev.onPartial(Float32Array.from(this.utt), this.uttStartAbs / this.sr)
    }

    const silenceMs = this.silenceFrames * 10
    const isMaxLen = uttMs >= (this.maxSpeechSamples / this.sr) * 1000
    if (silenceMs >= this.minSilenceFrames * 10 || isMaxLen) {
      this.endUtterance(isMaxLen)
    }
  }

  private endUtterance(forceBoundary: boolean): void {
    // 剪掉句尾静音，保留 ~120ms 尾垫
    const tailKeepFrames = Math.max(1, this.silenceFrames - Math.round(120 / 10))
    const trimFrames = Math.min(this.silenceFrames, Math.max(0, this.silenceFrames - tailKeepFrames))
    const keep = this.utt.length - trimFrames * FRAME
    const samples = this.utt.slice(0, Math.max(0, keep))
    const t0 = this.uttStartAbs / this.sr
    const t1 = (this.uttStartAbs + samples.length) / this.sr
    this.speech = false
    this.utt = []
    this.silenceFrames = 0
    this.lastPartialAt = 0

    if (samples.length >= this.minSpeechSamples) {
      this.ev.onFinal(Float32Array.from(samples), t0, t1)
    }

    if (forceBoundary) {
      // 句子过长被迫截断：无缝续接下一句（保留最近 pad）
      const pad = this.recent.length - FRAME * this.padFrames
      this.utt = this.recent.slice(Math.max(0, pad))
      this.uttStartAbs = Math.max(0, this.absSamp - this.utt.length)
      this.speech = true
    }
  }

  /** 停止时冲刷剩余语音 */
  flush(): void {
    if (this.speech) {
      this.speech = false
      const samples = this.utt
      this.utt = []
      this.silenceFrames = 0
      if (samples.length >= this.minSpeechSamples) {
        this.ev.onFinal(
          Float32Array.from(samples),
          this.uttStartAbs / this.sr,
          (this.uttStartAbs + samples.length) / this.sr
        )
      }
    }
  }
}
