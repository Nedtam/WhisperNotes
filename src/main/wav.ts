// WAV 工具：增量写文件 + 单次编码（16kHz mono int16）
import * as fs from 'node:fs'

const SR = 16000

export class WavWriter {
  private fd: number
  private dataBytes = 0
  private path: string

  constructor(filePath: string) {
    this.path = filePath
    this.fd = fs.openSync(filePath, 'w')
    // 占位 44 字节头，最后回填
    const header = Buffer.alloc(44)
    fs.writeSync(this.fd, header, 0, 44)
  }

  writeSamples(f32: Float32Array): void {
    const buf = Buffer.allocUnsafe(f32.length * 2)
    for (let i = 0; i < f32.length; i++) {
      let v = f32[i]
      v = Math.max(-1, Math.min(1, v))
      buf.writeInt16LE((v < 0 ? v * 0x8000 : v * 0x7fff) | 0, i * 2)
    }
    fs.writeSync(this.fd, buf)
    this.dataBytes += buf.length
  }

  finish(): void {
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + this.dataBytes, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20) // PCM
    header.writeUInt16LE(1, 22) // mono
    header.writeUInt32LE(SR, 24)
    header.writeUInt32LE(SR * 2, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(this.dataBytes, 40)
    fs.writeSync(this.fd, header, 0, 44)
    fs.closeSync(this.fd)
  }

  get pathName(): string {
    return this.path
  }
}

/** 把一段 float32 PCM（16kHz mono）编码为完整 WAV Buffer（供引擎请求） */
export function encodeWav(samples: Float32Array, sampleRate = SR): Buffer {
  const n = samples.length
  const dataSize = n * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < n; i++) {
    let v = samples[i]
    v = Math.max(-1, Math.min(1, v))
    buf.writeInt16LE((v < 0 ? v * 0x8000 : v * 0x7fff) | 0, 44 + i * 2)
  }
  return buf
}
