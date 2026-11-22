import { parseCards, planCardCount, buildCardPrompt } from '../../src/main/llm/cards'

const cases: Array<[string, string]> = [
  ['标准 JSON', '[{"front":"什么是 VAD?","back":"语音活动检测","tags":["音频"]}]'],
  ['带围栏+前后废话', '好的，这是卡片：\n```json\n[{"front":"Q1","back":"A1"},{"front":"Q2","back":"A2"}]\n```\n希望有帮助！'],
  ['尾逗号+中文引号', '[{“front”：“Q1”，“back”：“A1”，},]'],
  ['缺 back 的项目被丢弃', '[{"front":"只有问题"},{"front":"Q","back":"A"}]'],
  ['重复去重', '[{"front":"Same?","back":"A"},{"front":"same? ","back":"B"}]'],
  ['纯文本兜底', 'Q: 什么是积分?\nA: 累加求和\nQ: 什么是导数?\nA: 变化率'],
  ['空回复', '']
]
for (const [name, raw] of cases) {
  const out = parseCards(raw)
  console.log(`${out.length > 0 || name === '空回复' ? '✅' : '❌'} ${name}: ${out.length} 张 → ${JSON.stringify(out[0] ?? null)}`)
}
const md = 'x'.repeat(4000)
console.log('计划张数（4000字，默认）:', planCardCount(md, undefined))
console.log('计划张数（4000字，per1000=10, max=15）:', planCardCount(md, { per1000: 10, maxPerNote: 15 }))
const msgs = buildCardPrompt({ id: 'n1', title: '测试笔记', noteMd: '这是中文笔记内容', notebookId: null }, 5, { style: 'formula' }, ['旧卡片1'])
console.log('prompt 含公式侧重:', msgs[0].content.includes('formulas and rules'))
console.log('prompt 含中文语言规则:', msgs[0].content.includes('Simplified Chinese'))
console.log('prompt 含已有卡片去重:', msgs[1].content.includes('旧卡片1'))
