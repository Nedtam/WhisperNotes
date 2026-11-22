import { readFileSync } from 'node:fs'
import { mdToHtml } from '../../src/shared/md'

const cases: Array<[string, string]> = [
  ['无前导竖线表格', 'A | B\n--- | ---\n1 | 2'],
  ['普通含竖线段落', '这里说 a == b | c 不是表格\n下一行是普通文字'],
  ['标准表格缺列', '| A | B | C |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |'],
  ['代码里的竖线', '| A | B |\n| --- | --- |\n| `x|y` | 2 |'],
  ['表格后接段落', '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n正文段落 | 带竖线']
]
for (const [name, md] of cases) {
  const { html } = mdToHtml(md)
  const tables = (html.match(/<table/g) ?? []).length
  const ths = (html.match(/<th/g) ?? []).length
  const tds = (html.match(/<td/g) ?? []).length
  console.log(`${tables === 1 ? '✅' : '⚠️ '} ${name}: tables=${tables} th=${ths} td=${tds}`)
  if (tables) console.log('   ' + html.slice(html.indexOf('<table'), html.indexOf('</table>') + 8).slice(0, 260))
}
// 真实讲座笔记：不应抛错，表格数量与单元格数应稳定
const md = readFileSync('/tmp/note-lecture.md', 'utf-8')
const t0 = Date.now()
const r = mdToHtml(md)
console.log(`真实笔记渲染: ${Date.now() - t0}ms 表格=${(r.html.match(/<table/g) ?? []).length} 单元格=${(r.html.match(/<t[dh]/g) ?? []).length} 高亮=${(r.html.match(/hl-yellow/g) ?? []).length} 标题=${r.headings.length}`)
