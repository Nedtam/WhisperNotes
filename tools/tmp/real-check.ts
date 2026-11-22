import { readFileSync } from 'node:fs'
import { normalizeHighlights, needsHighlightNormalization } from '../../src/shared/notation'
import { mdToHtml } from '../../src/shared/md'

for (const f of process.argv.slice(2)) {
  const md = readFileSync(f, 'utf-8')
  const ctx: string[] = []
  const lines = md.split('\n')
  lines.forEach((l, i) => {
    if (l.includes('==')) ctx.push(`  L${i + 1}: ${JSON.stringify(l.slice(0, 200))}`)
  })
  const out = normalizeHighlights(md)
  console.log(`\n### ${f}  (${md.length} 字符, 需要迁移=${needsHighlightNormalization(md)})`)
  console.log('含 == 的行：')
  console.log(ctx.join('\n') || '  （无）')
  if (out !== md) {
    const before = (md.match(/==/g) ?? []).length
    const after = (out.match(/==/g) ?? []).length
    console.log(`迁移后：== 数量 ${before} → ${after}，新增 mark ${(out.match(/<mark class="hl-yellow">/g) ?? []).length} 个`)
    console.log('差异片段（前 3 处）：')
    let shown = 0
    for (let i = 0; i < lines.length && shown < 3; i++) {
      const nl = out.split('\n')[i]
      if (nl !== lines[i]) {
        console.log('  - ' + JSON.stringify(lines[i].slice(0, 160)))
        console.log('  + ' + JSON.stringify(nl.slice(0, 160)))
        shown++
      }
    }
  } else {
    console.log('（无需改动）')
  }
  // 残留的 ==== 之类
  const stuck = out.split('\n').filter((l) => /={3,}/.test(l) || /\s==\s/.test(l))
  console.log('仍是纯文本等号的行数（需人工确认）:', stuck.length)
  stuck.slice(0, 4).forEach((l) => console.log('  ? ' + JSON.stringify(l.slice(0, 120))))
}
