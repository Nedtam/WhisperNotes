// 闪卡创造系统单测：重要度门槛 / 类型过滤 / 行政内容兜底 / 预设尺度
import { parseCards, looksAdministrative, planCardCount, CARD_PRESETS, CARD_DEFAULTS } from '../../src/main/llm/cards'

const raw = JSON.stringify([
  { front: '什么是采样率？', back: '每秒采样次数。', importance: 5, kind: 'definition', quote: '采样率' },
  { front: '奈奎斯特频率公式？', back: 'fs/2', importance: 4, kind: 'formula', quote: '奈奎斯特' },
  { front: '作业什么时候交？', back: '下周五。', importance: 5, kind: 'fact', quote: '作业' },
  { front: '办公室在哪？', back: 'B 座 302。', importance: 4, kind: 'fact' },
  { front: 'VAD 和静音检测的区别？', back: 'VAD 判定语音活动，静音检测只看能量。', importance: 4, kind: 'comparison' },
  { front: '老师叫什么名字？', back: 'Sherman。', importance: 2, kind: 'fact' },
  { front: '如何安装 Audacity？', back: '打开官网下载。', importance: 4, kind: 'procedure' }
])
const parsed = parseCards(raw)
console.log('✅ 解析出', parsed.length, '张（含 importance/kind/quote）:', JSON.stringify(parsed[1]))
console.log('重要度分布:', parsed.map((c) => c.importance).join(','))
console.log('类型:', parsed.map((c) => c.kind).join(','))

const minImp = 4
const afterImp = parsed.filter((c) => (c.importance ?? 3) >= minImp)
console.log((afterImp.length === 6 ? '✅' : '❌') + ` 重要度 ≥${minImp} 过滤: ${parsed.length} → ${afterImp.length}`)

const afterAdmin = afterImp.filter((c) => !looksAdministrative(`${c.front} ${c.back}`))
console.log((afterAdmin.length === 3 ? '✅' : '❌') + ` 行政内容兜底过滤: ${afterImp.length} → ${afterAdmin.length}（剩下：${afterAdmin.map((c) => c.front).join(' / ')}）`)

const onlyFormulaDef = afterAdmin.filter((c) => c.kind === 'definition' || c.kind === 'formula')
console.log((onlyFormulaDef.length === 2 ? '✅' : '❌') + ` 类型过滤（只要定义/公式）: ${afterAdmin.length} → ${onlyFormulaDef.length}`)

console.log('预设尺度:')
for (const [k, v] of Object.entries(CARD_PRESETS)) {
  console.log(`  ${k}: 每1000字 ${v.per1000} 张 / 上限 ${v.maxPerNote} / 重要度 ≥${v.minImportance}`)
}
const md = 'x'.repeat(5000)
console.log('计划张数（5000字，考试冲刺）:', planCardCount(md, { per1000: CARD_PRESETS.exam.per1000, maxPerNote: CARD_PRESETS.exam.maxPerNote }))
console.log('计划张数（5000字，全面覆盖）:', planCardCount(md, { per1000: CARD_PRESETS.broad.per1000, maxPerNote: CARD_PRESETS.broad.maxPerNote }))
console.log('行政判定抽查:',
  ['作业下周五交', '什么是机会成本', '考试地点在 LT-3', 'Office hour 周三', 'Nash 均衡的定义']
    .map((t) => `${t}=${looksAdministrative(t) ? '行政' : '概念'}`).join(' | '))
console.log('默认门槛:', CARD_DEFAULTS.minImportance)
