import { normalizeHighlights, needsHighlightNormalization } from '../../src/shared/notation'
import { mdToHtml } from '../../src/shared/md'

const cases: Array<[string, string]> = [
  ['基本荧光', '这是 ==重点内容== 一句'],
  ['代码式比较', 'if (a == b == c) { return }'],
  ['行内代码', '用 `x == y` 判断相等'],
  ['围栏代码', '```cpp\nif (a == b) {}\n```\n正文 ==高亮=='],
  ['旧荧光贴边空格', '== 不该匹配 =='],
  ['等号串', 'a ==== b'],
  ['星号在代码里', '`a*b*c` 与 **加粗**'],
  ['表格含竖线代码', '| A | B |\n| --- | --- |\n| `x|y` | 2 |'],
  ['表格列数不齐', '| A | B | C |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |']
]

for (const [name, src] of cases) {
  const n1 = normalizeHighlights(src)
  const n2 = normalizeHighlights(n1)
  console.log(`\n--- ${name} ---`)
  console.log('src :', JSON.stringify(src))
  console.log('norm:', JSON.stringify(n1))
  console.log('幂等:', n1 === n2 ? 'OK' : 'FAIL ' + JSON.stringify(n2))
}
console.log('\n=== mdToHtml 表格 ===')
console.log(mdToHtml('| A | B | C |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |'))
console.log('\n=== mdToHtml 黄色高亮（HTML 与旧 ==）===')
console.log(mdToHtml('<mark class="hl-yellow">新</mark> 与 ==旧=='))
console.log('\n=== mdToHtml 代码里的 == ===')
console.log(mdToHtml('判断 `x == y` 是否成立，且 **加粗**'))
