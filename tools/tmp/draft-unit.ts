import { VadSegmenter } from '../../src/main/segmenter'
// 合成"连续说话"的 PCM（16k，0.3 幅度正弦），跑 60 秒，统计 partial 次数与每次音频长度
function speech(nSec: number): Float32Array {
  const sr = 16000
  const a = new Float32Array(Math.round(nSec * sr))
  for (let i = 0; i < a.length; i++) a[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr)
  return a
}
function trial(cadenceMs: number, minMs: number): { count: number; lengths: number[] } {
  const lengths: number[] = []
  const seg = new VadSegmenter(
    { onFinal: () => {}, onPartial: (s) => lengths.push(s.length / 16000) },
    { sampleRate: 16000, sensitivity: 65, minSilenceMs: 550, maxSpeechSec: 25, partialCadenceMs: cadenceMs, partialMinMs: minMs }
  )
  const chunk = speech(0.1)
  for (let t = 0; t < 600; t++) seg.process(chunk) // 60 秒连续说话
  return { count: lengths.length, lengths }
}
for (const [cad, min] of [[15000, 5000], [30000, 5000], [15000, 1500], [650, 1500]] as Array<[number, number]>) {
  const r = trial(cad, min)
  const avg = r.lengths.length ? (r.lengths.reduce((a, b) => a + b, 0) / r.lengths.length).toFixed(1) : '0'
  const ok = cad >= 15000 ? r.count <= 5 : true
  console.log(`${ok ? '✅' : '❌'} 间隔 ${cad}ms / 最短 ${min}ms → 60 秒说话产生 ${r.count} 次草稿（平均音频 ${avg}s）`)
}
console.log('\n核对：一节课(90min, 70%说话=3780s)')
for (const [cad, min] of [[15000, 5000], [30000, 5000], [650, 1500]] as Array<[number, number]>) {
  const r = trial(cad, min)
  const perMin = r.count / 1 // trial 是 60 秒
  const total = perMin * (3780 / 60)
  const cpu = cad >= 15000 ? 0.6 : 18 // 小模型 ~0.6s CPU / 大模型 ~18s CPU 每窗口
  const label = cad >= 15000 ? '草稿小模型' : '草稿大模型'
  console.log(`  间隔 ${cad}ms / 最短 ${min}ms → 约 ${Math.round(total)} 次草稿 × ${cpu}s = ${Math.round(total * cpu)}s CPU（${label}）`)
}
