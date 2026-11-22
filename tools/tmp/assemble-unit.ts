// 纯函数单测：分段笔记 → 完整文档（同名小节合并 / 小结去重 / 内容零丢失）
import { assembleNotes } from '../../src/main/llm/assemble'

let pass = 0
let total = 0
const rec = (n: string, ok: boolean, detail = ''): void => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? '✅' : '❌'} ${n}${detail ? ' — ' + detail : ''}`)
}

const part1 = `# 1. 采样与量化

- 采样率决定可表示的最高频率（奈奎斯特）。
- **量化误差**随位深下降。

## 抖动

- dithering 用噪声换线性度。

## Key takeaways

- 采样率 ≥ 2×最高频率
- 位深越大量化误差越小`

const part2 = `# 2. 滤波器

- 抗混叠滤波器必须在 ADC 之前。

## 抖动

- 抖动还能打散量化台阶。

## Key takeaways

- 采样率 ≥ 2×最高频率
- 抗混叠滤波器要放在前面`

const asm = assembleNotes([part1, part2])

rec('同名小节被合并（"抖动"只出现一次标题）', (asm.match(/## 抖动/g) || []).length === 1, `出现 ${(asm.match(/## 抖动/g) || []).length} 次`)
rec('不同小节都保留（滤波器在）', /滤波器/.test(asm))
rec('合并小节里两段内容都在（两处抖动的正文都保留）', /dithering 用噪声换线性度/.test(asm) && /抖动还能打散量化台阶/.test(asm))
rec('小结只留一节', (asm.match(/Key takeaways/g) || []).length === 1, `出现 ${(asm.match(/Key takeaways/g) || []).length} 次`)
rec('小结条目去重（重复条目只留一次）', (asm.match(/采样率 ≥ 2×最高频率/g) || []).length === 1)
rec('小结里各自独有的条目都保留', /位深越大量化误差越小/.test(asm) && /抗混叠滤波器要放在前面/.test(asm))
rec(
  '内容零丢失（原始要点全部在）',
  ['奈奎斯特', '量化误差', 'dithering', '抗混叠', '位深', 'ADC'].every((k) => asm.includes(k))
)
rec('顶层标题编号被重排为连续（1. / 2. / 3.）', /^# 1\. 采样与量化/m.test(asm) && /^# 2\. 滤波器/m.test(asm), asm.split('\n').filter((l) => /^#/.test(l)).join(' | '))
rec(
  '小结固定落在最后一节',
  asm.trimEnd().endsWith('- 抗混叠滤波器要放在前面') && asm.lastIndexOf('## Key takeaways') > asm.lastIndexOf('# 2. 滤波器'),
  JSON.stringify(asm.trimEnd().slice(-40))
)

const noHead = assembleNotes(['第一段没有标题的内容。', '第二段也没有标题。'])
rec('没有标题的分段按顺序原样保留', noHead.includes('第一段') && noHead.includes('第二段') && noHead.indexOf('第一段') < noHead.indexOf('第二段'))

const single = assembleNotes(['# 只有一段\n\n- a'])
rec('单段直接返回自己（不做任何改动）', single === '# 只有一段\n\n- a', JSON.stringify(single))

const withPrelude = assembleNotes(['开头一句话。\n\n# 小节\n\n- x', '# 小节\n\n- y'])
rec('正文前的内容不会丢', withPrelude.includes('开头一句话'), JSON.stringify(withPrelude.slice(0, 60)))
rec('同名小节内容按出现顺序相接', withPrelude.indexOf('- x') < withPrelude.indexOf('- y'))

const messy = assembleNotes(['### 深标题\n\n内容A', '### 深标题\n\n内容B'])
rec('多级标题也不会丢内容', messy.includes('内容A') && messy.includes('内容B'), JSON.stringify(messy))

console.log(`\n结果: ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
