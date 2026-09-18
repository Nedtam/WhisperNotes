// 线性重采样：把任意输入采样率降到目标（如 48k → 16k）
export class Resampler {
  private ratio: number
  private pos = 0
  private last = 0
  private hasLast = false

  constructor(private inRate: number, private outRate: number) {
    this.ratio = inRate / outRate
  }

  process(input: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return input
    const n = Math.floor(input.length / this.ratio)
    const out = new Float32Array(n)
    let j = 0
    while (this.pos + 1 < input.length && j < n) {
      const i = Math.floor(this.pos)
      const frac = this.pos - i
      const a = input[i]
      const b = i + 1 < input.length ? input[i + 1] : this.hasLast ? this.last : a
      out[j++] = a + (b - a) * frac
      this.pos += this.ratio
    }
    if (input.length > 0) {
      this.last = input[input.length - 1]
      this.hasLast = true
    }
    this.pos -= input.length
    if (this.pos < 0) this.pos = 0
    return j === out.length ? out : out.slice(0, j)
  }
}
