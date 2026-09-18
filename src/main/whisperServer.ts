// whisper.cpp 引擎：常驻 whisper-server 子进程 + HTTP 逐句转写
// 接口（IAsrEngine）预留 faster-whisper 等其他实现。
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import { i18nCode } from './i18n'
import { bundledEngineBin } from './bundled'

export interface AsrEngineOptions {
  modelPath: string
  language: string
  threads: number
  logDir: string
  prompt?: string
  /** false = 强制 CPU（传 -ng） */
  useGpu?: boolean
}

export interface AsrEngine {
  start(opts: AsrEngineOptions): Promise<void>
  transcribeWav(wav: Buffer): Promise<string>
  transcribeWavDetailed(wav: Buffer, timeoutMs?: number, externalSignal?: AbortSignal): Promise<Array<{ t0: number; t1: number; text: string }>>
  stop(): Promise<void>
  readonly isRunning: boolean
}

export interface BinaryProbe {
  found: boolean
  binaryPath: string
  /** 该引擎是否带 Metal（GPU）后端 */
  gpu?: boolean
}

const COMMON_CANDIDATES = [
  '/opt/homebrew/opt/whisper-cpp/bin/whisper-server',
  '/opt/homebrew/bin/whisper-server',
  '/usr/local/bin/whisper-server'
]

/** 引擎是否带 Metal 后端：查二进制里是否引用了 libggml-metal（插件名会写进 dylib 列表） */
function hasMetalBackend(bin: string): boolean {
  try {
    const buf = fs.readFileSync(bin)
    return buf.includes(Buffer.from('libggml-metal')) || buf.includes(Buffer.from('ggml_metal_library_init'))
  } catch {
    return false
  }
}

export function probeBinary(customPath: string): BinaryProbe {
  if (customPath && fs.existsSync(customPath)) {
    return { found: true, binaryPath: customPath, gpu: hasMetalBackend(customPath) }
  }
  const env = process.env.WHISPER_SERVER
  if (env && fs.existsSync(env)) return { found: true, binaryPath: env, gpu: hasMetalBackend(env) }
  // 安装包内置引擎（新机器无需 brew）
  const bundled = bundledEngineBin()
  if (bundled) return { found: true, binaryPath: bundled, gpu: hasMetalBackend(bundled) }
  for (const c of COMMON_CANDIDATES) {
    if (fs.existsSync(c)) return { found: true, binaryPath: c, gpu: hasMetalBackend(c) }
  }
  try {
    const r = spawnSync('which', ['whisper-server'], { encoding: 'utf-8' })
    if (r.status === 0 && r.stdout.trim()) {
      return { found: true, binaryPath: r.stdout.trim(), gpu: hasMetalBackend(r.stdout.trim()) }
    }
  } catch {
    /* ignore */
  }
  return { found: false, binaryPath: '', gpu: false }
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error(i18nCode('err.portAlloc'))))
      }
    })
    srv.on('error', reject)
  })
}

function waitPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const sock = net.connect({ host: '127.0.0.1', port })
      sock.once('connect', () => {
        sock.destroy()
        resolve()
      })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() - start > timeoutMs) reject(new Error(i18nCode('err.whisperTimeout', { tail: '' })))
        else setTimeout(tick, 150)
      })
    }
    tick()
  })
}

export class WhisperCppEngine implements AsrEngine {
  private child: ChildProcess | null = null
  private port = 0
  private logFile: fs.WriteStream | null = null

  get isRunning(): boolean {
    return this.child !== null && !this.child.killed
  }
  async start(opts: AsrEngineOptions): Promise<void> {
    if (this.isRunning) await this.stop()
    const probe = probeBinary('')
    if (!probe.found) {
      throw new Error(i18nCode('err.whisperNotFound'))
    }
    if (!fs.existsSync(opts.modelPath)) {
      throw new Error(i18nCode('err.whisperModelMissing', { path: opts.modelPath }))
    }
    this.port = await findFreePort()
    fs.mkdirSync(opts.logDir, { recursive: true })
    this.logFile = fs.createWriteStream(
      path.join(opts.logDir, `whisper-server-${Date.now()}.log`),
      { flags: 'a' }
    )
    const args = [
      '--model', opts.modelPath,
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '-l', opts.language || 'en',
      '-t', String(opts.threads || 6)
    ]
    if (opts.useGpu === false) args.push('-ng')
    const prompt = (opts.prompt ?? '').trim().slice(0, 800)
    if (prompt) args.push('--prompt', prompt)
    const child = spawn(probe.binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    let errTail = ''
    child.stdout?.on('data', (d) => this.logFile?.write(`[out] ${d}`))
    child.stderr?.on('data', (d) => {
      const s = d.toString()
      this.logFile?.write(`[err] ${s}`)
      if (errTail.length < 4000) errTail = (errTail + s).slice(-4000)
    })
    child.on('exit', (code) => {
      this.logFile?.write(`[exit] code=${code}\n`)
      if (this.child === child) this.child = null
    })
    child.on('error', (err) => {
      this.logFile?.write(`[spawn error] ${err.message}\n`)
      if (this.child === child) this.child = null
    })

    try {
      await waitPort(this.port, 40_000)
    } catch (e) {
      // 超时：杀掉残留子进程、带上服务端最后几行输出，给出可诊断的报错
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      if (this.child === child) this.child = null
      const tail = errTail.trim().split('\n').slice(-6).join(' · ').slice(0, 500)
      // Windows 上最常见的原因：缺少 MSVC 运行库（VCRUNTIME140 / MSVCP140 / VCOMP140）
      if (/VCRUNTIME|MSVCP|VCOMP|MSVCR/i.test(errTail)) {
        throw new Error(i18nCode('err.whisperMsvcMissing', { tail: tail.slice(0, 300) }))
      }
      throw new Error(i18nCode('err.whisperTimeout', { tail: tail || String((e as Error).message) }))
    }
    // 预热：发一段 200ms 静音，确保解码器就绪
    try {
      await this.transcribeWav(silenceWav())
    } catch {
      /* 预热失败可忽略，正式请求会再试 */
    }
  }

  async transcribeWav(wav: Buffer): Promise<string> {
    const segs = await this.transcribeWavDetailed(wav)
    return segs.map((s) => s.text).join(' ')
  }

  /** 转写整段音频并返回带时间戳的句子（用于导入录音文件等一次性转写） */
  async transcribeWavDetailed(
    wav: Buffer,
    timeoutMs = 120_000,
    externalSignal?: AbortSignal
  ): Promise<Array<{ t0: number; t1: number; text: string }>> {
    if (!this.child) throw new Error(i18nCode('err.whisperNotRunning'))
    const fileBytes = new Uint8Array(wav.buffer as ArrayBuffer, wav.byteOffset, wav.byteLength)
    const fd = new FormData()
    fd.append('file', new Blob([fileBytes], { type: 'audio/wav' }), 'audio.wav')
    fd.append('response_format', 'verbose_json')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const onExtAbort = (): void => ctrl.abort()
    externalSignal?.addEventListener('abort', onExtAbort, { once: true })
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/inference`, {
        method: 'POST',
        body: fd,
        signal: ctrl.signal
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        this.logFile?.write(`[http ${res.status}] ${txt.slice(0, 300)}\n`)
        return []
      }
      const data = (await res.json()) as {
        text?: string
        segments?: Array<{ start?: number; end?: number; text?: string }>
      }
      const segs = data.segments ?? []
      const out = segs
        .map((s) => {
          const text = (s.text ?? '').trim()
          if (!text) return null
          // whisper verbose_json 的 start/end 为秒（老版本可能给毫秒，做兼容）
          let t0 = typeof s.start === 'number' ? s.start : 0
          let t1 = typeof s.end === 'number' ? s.end : 0
          if (t0 > 1000) t0 /= 1000
          if (t1 > 1000) t1 /= 1000
          return { t0: Math.max(0, t0), t1: t1 >= t0 ? t1 : t0 + 1, text }
        })
        .filter((x): x is { t0: number; t1: number; text: string } => x !== null)
      if (out.length) return out
      const whole = (data.text ?? '').trim()
      return whole ? [{ t0: 0, t1: 1, text: whole }] : []
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new Error(i18nCode('err.canceled'))
      this.logFile?.write(`[transcribe error] ${(err as Error).message}\n`)
      throw new Error(i18nCode('err.transcribeFailed', { msg: (err as Error).message }))
    } finally {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExtAbort)
    }
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    if (child && !child.killed) {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
          resolve()
        }, 2000)
        child.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
    this.logFile?.end()
    this.logFile = null
  }
}

function silenceWav(): Buffer {
  const samples = new Float32Array(3200) // 200ms
  const fs = 16000
  const n = samples.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(fs, 24)
  buf.writeUInt32LE(fs * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  return buf
}
