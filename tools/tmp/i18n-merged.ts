import { MESSAGES } from '../../src/shared/i18n'
const zh = Object.keys(MESSAGES.zh)
const en = Object.keys(MESSAGES.en)
const onlyZh = zh.filter((k) => !(k in MESSAGES.en))
const onlyEn = en.filter((k) => !(k in MESSAGES.zh))
console.log('合并后 zh=%d en=%d', zh.length, en.length)
console.log('仅 zh:', onlyZh.length ? onlyZh : '无')
console.log('仅 en:', onlyEn.length ? onlyEn : '无')
// 值看起来像“语言错了”的抽样：en 字典里出现中文
const cjk = en.filter((k) => /[\u4e00-\u9fff]/.test(MESSAGES.en[k]))
console.log('en 字典里含中文的值:', cjk.length ? cjk.map((k) => `${k}=${MESSAGES.en[k]}`) : '无')
const lat = zh.filter((k) => !/[\u4e00-\u9fff]/.test(MESSAGES.zh[k]))
console.log('zh 字典里纯英文的值(抽样 12):', lat.slice(0, 12))
for (const k of ['nav.llm', 'set.engine.gpuOn', 'set.engine.gpuOff', 'llm.http', 'set.llm.apiKey', 'cap.importPosShort', 'set.llm.autoFallback', 'org.retrySame', 'set.llm.chTestOk']) {
  console.log(`  ${k} | zh=${JSON.stringify(MESSAGES.zh[k])} | en=${JSON.stringify(MESSAGES.en[k])}`)
}
