import { dominantLanguage, languageDirective } from '../../src/shared/notation'
const en = 'Today we discuss the efficient market hypothesis and its implications for portfolio choice.'
const zh = '今天我们讨论有效市场假说，以及它对投资组合选择的影响。'
const mixed = 'This lecture mixes 中文 and English a lot in the same paragraph with equal weight.'
const cases: Array<[string, string, string]> = [
  ['英文转写 → en', en, 'en'],
  ['中文转写 → zh', zh, 'zh'],
  ['中英混排 → mixed', mixed + mixed, 'mixed']
]
let pass = 0
for (const [name, text, want] of cases) {
  const got = dominantLanguage(text)
  const ok = got === want
  if (ok) pass++
  console.log(`${ok ? '✅' : '❌'} ${name}: ${got}`)
}
const dEn = languageDirective(en)
const dZh = languageDirective(zh)
const okEn = /ENGLISH/.test(dEn) && /Do not use any Chinese characters/.test(dEn)
const okZh = /CHINESE/.test(dZh)
console.log((okEn ? '✅' : '❌') + ' 英文转写给出"必须英文"硬约束')
console.log((okZh ? '✅' : '❌') + ' 中文转写给出"必须中文"硬约束')
console.log(`\n结果: ${pass}/${cases.length} + 约束文案 ${okEn && okZh ? '2/2' : '有失败'}`)
