// 语音自动增益（AGC）——只放大“说话”部分，不放大背景噪声。
//
// 原则：
//  1) 按 10ms 帧估能量；
//  2) 用较低分位估计噪声底 floor；
//  3) 只有当“语音帧能量明显高于噪声底”（真实语音对比度）时才提增益——
//     纯噪声/极低信噪比片段不做处理，避免把背景“放大到能被识别”；
//  4) 施益按帧门控：语音帧用目标增益，噪声帧回到 1.0，attack/release 平滑防爆音。

export const FRAME = 160 // 10ms @16k

export function frameRms(s: Float32Array, from: number, to: number): number {
  let sum = 0
  for (let i = from; i < to; i++) sum += s[i] * s[i]
  const rms = Math.sqrt(sum / (to - from))
  return Math.max(rms, 1e-6)
}

export function rmsDb(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-5))
}

const TARGET_DB = -16 // 目标语音电平
const TARGET_RMS = Math.pow(10, TARGET_DB / 20)
const MAX_GAIN = 30
const MIN_SNR_DB = 9 // 语音必须至少高出噪声底这么多，才认为存在语音
const MIN_CONTRAST = Math.pow(10, MIN_SNR_DB / 20) // ≈ 2.8

/**
 * 对一整段音频做噪声门控 AGC（返回新数组；不满足条件时原样拷贝，避免放大噪声）。
 */
export function agcNormalize(samples: Float32Array): Float32Array {
  const n = samples.length
  const out = new Float32Array(n)
  if (n < FRAME * 4) {
    out.set(samples)
    return out
  }
  const nFrames = Math.floor(n / FRAME)
  const dbs = new Float64Array(nFrames)
  for (let f = 0; f < nFrames; f++) {
    dbs[f] = rmsDb(frameRms(samples, f * FRAME, (f + 1) * FRAME))
  }
  // 噪声底：取低分位（句子间停顿/背景）
  const sorted = Array.from(dbs).sort((a, b) => a - b)
  const floorDb = sorted[Math.max(0, Math.floor(nFrames * 0.2))]
  const speechDb = floorDb + MIN_SNR_DB
  // 噪声平均能量 = 噪声底附近的帧；语音能量 = 高于 speechDb 的帧
  let nSum = 0
  let nCnt = 0
  let sSum = 0
  let sCnt = 0
  for (let f = 0; f < nFrames; f++) {
    if (dbs[f] <= floorDb + 2) {
      const v = frameRms(samples, f * FRAME, (f + 1) * FRAME)
      nSum += v * v
      nCnt++
    } else if (dbs[f] >= speechDb) {
      const v = frameRms(samples, f * FRAME, (f + 1) * FRAME)
      sSum += v * v
      sCnt++
    }
  }
  const noiseRms = nCnt ? Math.sqrt(nSum / nCnt) : 1e-5
  const speechRms = sCnt ? Math.sqrt(sSum / sCnt) : 0
  // 没有可辨语音，或语音相对噪声不够突出 → 不做增益（防止背景被放大识别）
  if (!sCnt || speechRms / Math.max(noiseRms, 1e-5) < MIN_CONTRAST) {
    out.set(samples)
    return out
  }
  const g = Math.max(1, Math.min(MAX_GAIN, TARGET_RMS / Math.max(speechRms, 1e-4)))
  // 应用：语音帧 g、噪声帧 1.0
  let gCur = 1
  const attack = 0.45
  const release = 0.06
  const gateDb = floorDb + 4
  for (let f = 0; f < nFrames; f++) {
    const want = dbs[f] >= gateDb ? g : 1
    gCur += (want - gCur) * (want > gCur ? attack : release)
    const base = f * FRAME
    const end = Math.min(base + FRAME, n)
    for (let i = base; i < end; i++) {
      const v = samples[i] * gCur
      out[i] = v > 1 ? 1 : v < -1 ? -1 : v
    }
  }
  for (let i = nFrames * FRAME; i < n; i++) {
    const v = samples[i] * gCur
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v
  }
  return out
}

/**
 * 实时麦克风：按“整句”归一（VAD 已剔除句间背景）。
 */
export function agcUtterance(samples: Float32Array): Float32Array {
  const n = samples.length
  const rms = frameRms(samples, 0, n)
  const g = Math.max(1, Math.min(MAX_GAIN, TARGET_RMS / Math.max(rms, 1e-4)))
  if (g <= 1.0 + 1e-3) return samples
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = samples[i] * g
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v
  }
  return out
}
