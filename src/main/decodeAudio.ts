// 导入录音文件的本地解码：把任意常见音频（m4a/mp3/wav…）解码成 16kHz mono s16 WAV Buffer
// 优先用 ffmpeg（存在时最通用），否则用 macOS 自带 afconvert 兜底
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { i18nCode, tm } from './i18n'
import * as os from 'node:os'
import * as path from 'node:path'
import { bundledFfmpegBin } from './bundled'

export function findFfmpeg(): string {
  const bundled = bundledFfmpegBin()
  if (bundled) return bundled
  const candidates = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  try {
    const r = spawnSync('which', ['ffmpeg'], { encoding: 'utf-8' })
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  } catch {
    /* ignore */
  }
  return ''
}

function runToBuffer(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    let err = ''
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-4000)
    })
    child.on('error', (e) => reject(new Error(i18nCode('err.ffmpegSpawn', { cmd: path.basename(cmd), msg: e.message }))))
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(i18nCode('err.ffmpegDecode', { cmd: path.basename(cmd), code: code ?? '', tail: err.slice(-300) })))
    })
  })
}

function isLikely16kMonoWav(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(44)
    fs.readSync(fd, head, 0, 44, 0)
    fs.closeSync(fd)
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return false
    const rate = head.readUInt32LE(24)
    const ch = head.readUInt16LE(22)
    const bits = head.readUInt16LE(34)
    return rate === 16000 && ch === 1 && bits === 16
  } catch {
    return false
  }
}

/** 解析 16kHz mono s16 WAV Buffer → float32 样本（-1..1）。用于导入录音的 VAD 分句。 */
export function wavBytesToSamples(wav: Buffer): Float32Array {
  // 找 data 块（兼容非 44 字节头的 WAV）
  let dataOff = -1
  let dataLen = 0
  for (let i = 12; i < Math.min(wav.length, 4096) - 8; ) {
    const id = wav.toString('ascii', i, i + 4)
    const size = wav.readUInt32LE(i + 4)
    if (id === 'data') {
      dataOff = i + 8
      dataLen = size
      break
    }
    i += 8 + size + (size % 2)
  }
  if (dataOff < 0) dataOff = 44
  if (dataLen <= 0) dataLen = wav.length - dataOff
  const n = Math.floor(dataLen / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = wav.readInt16LE(dataOff + i * 2)
    out[i] = v / 32768
  }
  return out
}

/** 解析 16kHz mono s16 WAV 头部，返回 data 块偏移与长度。 */
export function wavDataRange(wav: Buffer, wholeLen: number): { off: number; len: number } {
  for (let i = 12; i < Math.min(wholeLen, 8192) - 8; ) {
    const id = wav.toString('ascii', i, i + 4)
    const size = wav.readUInt32LE(i + 4)
    if (id === 'data') {
      return { off: i + 8, len: Math.min(size, Math.max(0, wholeLen - (i + 8))) }
    }
    i += 8 + size + (size % 2)
  }
  return { off: 44, len: Math.max(0, wholeLen - 44) }
}

function newTempWav(): string {
  return path.join(os.tmpdir(), `wn-import-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)
}

/** 把输入音频解码成 16kHz mono s16 WAV **文件**（避免长录音整段载入内存）。调用方负责删除返回的临时文件。 */
export async function decodeTo16kWavFile(file: string): Promise<string> {
  if (!fs.existsSync(file)) throw new Error(i18nCode('err.fileMissing'))
  const tmp = newTempWav()
  if (isLikely16kMonoWav(file)) {
    // 已是目标格式：直接复制，后续流式读
    fs.copyFileSync(file, tmp)
    return tmp
  }
  const ff = findFfmpeg()
  if (ff) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ff, ['-y', '-i', file, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmp], {
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let err = ''
      child.stderr.on('data', (d: Buffer) => {
        err = (err + d.toString()).slice(-3000)
      })
      child.on('error', (e) => reject(new Error(i18nCode('err.ffmpegNotSpawn', { msg: e.message }))))
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(tmp)) resolve()
        else reject(new Error(i18nCode('err.ffmpegDecodeShort', { code: code ?? '', tail: err.slice(-300) })))
      })
    })
    return tmp
  }
  // macOS 兜底 afconvert
  const af = '/usr/bin/afconvert'
  if (fs.existsSync(af)) {
    const r = spawnSync(af, ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', file, tmp], { encoding: 'utf-8' })
    if (r.status !== 0) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      throw new Error(i18nCode('err.ffmpegDecodeShort', { code: 'afconvert', tail: (r.stderr || tm('err.afconvertFailed')).slice(-300) }))
    }
    return tmp
  }
  try {
    fs.unlinkSync(tmp)
  } catch {
    /* ignore */
  }
  throw new Error(i18nCode('err.noDecoder'))
}

/** 把输入音频文件解码为 16kHz mono s16 WAV 字节（短录音便捷用；长录音请用 decodeTo16kWavFile 流式）。 */
export async function decodeTo16kWav(file: string): Promise<Buffer> {
  const tmp = await decodeTo16kWavFile(file)
  try {
    return fs.readFileSync(tmp)
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}
