import { nextBackAction } from '../../mobile/src/backNav'
const cases: Array<[string, { hasReader: boolean; tab: string }, string]> = [
  ['阅读页 → 关阅读页', { hasReader: true, tab: 'notes' }, 'close-reader'],
  ['闪卡页 → 回笔记页', { hasReader: false, tab: 'cards' }, 'to-notes'],
  ['设置页 → 回笔记页', { hasReader: false, tab: 'settings' }, 'to-notes'],
  ['转写页 → 回笔记页', { hasReader: false, tab: 'transcripts' }, 'to-notes'],
  ['阅读页里按返回（转写详情）', { hasReader: true, tab: 'transcripts' }, 'close-reader'],
  ['笔记根页 → 退出', { hasReader: false, tab: 'notes' }, 'exit']
]
let pass = 0
for (const [name, st, want] of cases) {
  const got = nextBackAction(st)
  const ok = got === want
  if (ok) pass++
  console.log(`${ok ? '✅' : '❌'} ${name}: ${got}`)
}
console.log(`\n结果: ${pass}/${cases.length} 通过`)
