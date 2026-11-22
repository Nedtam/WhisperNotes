// 完整性地板单测：统一润色有没有把某一段整块吃掉
import { coverageOk, distinctiveTokens } from '../../src/main/llm/coverage'
let pass = 0, total = 0
const rec = (n: string, ok: boolean, d = ''): void => { total++; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`) }

const parts = [
  '# Part 1\n\nSampling rate f_s >= 2 f_max, 44.1 kHz, SNR 96 dB',
  '# Part 2\n\nQuantization error falls with bit depth, 65536 levels, dithering',
  '# Part 3\n\nAnti-aliasing filter before the ADC, 20 kHz cutoff'
]
const full = parts.join('\n\n')
rec('内容都在 → 判定通过', coverageOk(parts, full).ok)
const dropped3 = parts[0] + '\n\n' + parts[1]
const c1 = coverageOk(parts, dropped3)
rec('整段丢掉第 3 段 → 被抓出来', !c1.ok && c1.missing.join(',') === '3', JSON.stringify(c1.missing))
const dropped2 = parts[0] + '\n\n' + parts[2]
const c2 = coverageOk(parts, dropped2)
rec('整段丢掉第 2 段 → 被抓出来', !c2.ok && c2.missing.join(',') === '2', JSON.stringify(c2.missing))
rec('压缩但每段都留了标记 → 视为通过', coverageOk(parts, '- 44.1 kHz\n- 65536 levels\n- anti-aliasing filter').ok)
rec('缩写/改述只剩数字也算留下痕迹', coverageOk([parts[0]], '- 采样率要 >= 2 f_max（44.1 kHz）').ok)
rec('纯短语料不参与判定（不会被误判）', coverageOk(['好，我们继续。', '对。'], '好').ok)
rec('标记提取同时覆盖数字与长词', distinctiveTokens(parts[1]).length >= 3, JSON.stringify(distinctiveTokens(parts[1])))
console.log(`\n结果: ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
