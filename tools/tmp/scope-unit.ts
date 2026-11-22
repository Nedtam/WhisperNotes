// 分类逻辑纯函数单测（不依赖 DOM）：笔记本子树 / 未归档 / 多选笔记 / 卡片随笔记移动自动改归属
import { inScope, notesInScope, subtreeIds, noteOfCard, type CardScope } from '../../src/shared/cardScope'
import type { Card, NoteRecord, Notebook } from '../../src/shared/types'

const nb = (id: string, name: string, parentId: string | null = null, ord = 0): Notebook => ({ id, name, parentId, ord, createdAt: 0 })
const note = (id: string, title: string, notebookId: string | null): NoteRecord =>
  ({ id, title, notebookId, kind: 'lecture', createdAt: 0, updatedAt: 0, durationMs: 0, templateId: 'study', sourceText: '', noteMd: '', tags: [] }) as NoteRecord
const card = (id: string, noteId: string | null): Card =>
  ({ id, noteId, notebookId: null, front: 'f' + id, back: 'b', tags: [], source: 'ai', createdAt: 0, updatedAt: 0, reps: 0, lapses: 0, suspended: false }) as Card

const notebooks = [nb('sem', '26-27 Semester A'), nb('mgt', 'MGT2324', 'sem', 1), nb('geo', 'GE2254', 'sem', 2), nb('sub', 'MGT2324-子', 'mgt', 0)]
const notes = [
  note('w1', 'MGT2324 Week 1', 'mgt'),
  note('w2', 'MGT2324 Week 2', 'mgt'),
  note('w3', 'MGT2324 Week 3', 'mgt'),
  note('s1', 'MGT 子笔记', 'sub'),
  note('g1', 'GE2254 Week 1', 'geo'),
  note('f1', '未归档笔记', null)
]
const cards = [card('c1', 'w1'), card('c2', 'w1'), card('c3', 'w2'), card('c4', 's1'), card('c5', 'g1'), card('c6', 'f1'), card('c7', null)]

const cases: Array<[string, CardScope, string[]]> = [
  ['全部（含手动创建、无笔记的卡片）', { kind: 'all' }, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']],
  ['未归档', { kind: 'none' }, ['c6', 'c7']],
  ['学期笔记本（含所有子笔记本）', { kind: 'nb', id: 'sem', notes: new Set() }, ['c1', 'c2', 'c3', 'c4', 'c5']],
  ['单个课程笔记本（含它的子笔记本）', { kind: 'nb', id: 'mgt', notes: new Set() }, ['c1', 'c2', 'c3', 'c4']],
  ['子笔记本', { kind: 'nb', id: 'sub', notes: new Set() }, ['c4']],
  ['课程内多选笔记 Week1+Week2（= 你要的 Week2–4 场景）', { kind: 'nb', id: 'mgt', notes: new Set(['w1', 'w2']) }, ['c1', 'c2', 'c3']],
  ['课程内只选 Week3（还没出卡）', { kind: 'nb', id: 'mgt', notes: new Set(['w3']) }, []]
]
let pass = 0
for (const [name, scope, want] of cases) {
  const got = cards.filter((c) => inScope(c, scope, notes, notebooks)).map((c) => c.id)
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  console.log(`${ok ? '✅' : '❌'} ${name}: ${JSON.stringify(got)}${ok ? '' : ' 期望 ' + JSON.stringify(want)}`)
}
// 子树
const st = subtreeIds(notebooks, 'sem')
console.log((['sem', 'mgt', 'geo', 'sub'].every((x) => st.has(x)) ? '✅' : '❌') + ' subtreeIds 含全部后代')
// 未出卡统计（出卡范围用）
const countOf = (nid: string): number => cards.filter((c) => c.noteId === nid).length
const inMgt = notesInScope(notes, { kind: 'nb', id: 'mgt', notes: new Set() }, notebooks, countOf)
const uncarded = inMgt.filter((x) => x.cards === 0).map((x) => x.note.title)
console.log((JSON.stringify(uncarded) === JSON.stringify(['MGT2324 Week 3']) ? '✅' : '❌') + ' 未出卡识别: ' + JSON.stringify(uncarded))
// 笔记换笔记本后，卡片归属自动跟随（卡片按 noteId 关联）
const moved = notes.map((n) => (n.id === 'w1' ? { ...n, notebookId: 'geo' } : n))
const afterMove = cards.filter((c) => inScope(c, { kind: 'nb', id: 'geo', notes: new Set() }, moved, notebooks)).map((c) => c.id)
console.log((JSON.stringify(afterMove) === JSON.stringify(['c1', 'c2', 'c5']) ? '✅' : '❌') + ' 笔记移动后卡片归属自动跟随: ' + JSON.stringify(afterMove))
console.log('noteOfCard 无笔记卡片返回 undefined:', noteOfCard(card('x', null), notes) === undefined ? '✅' : '❌')
console.log(`\n结果: ${pass}/${cases.length} 通过`)
