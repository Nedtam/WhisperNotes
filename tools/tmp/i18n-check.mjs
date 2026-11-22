import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
const src = readFileSync('src/shared/i18n.ts', 'utf-8')
function blocksOf(name) {
  const idx = src.indexOf(`const ${name}: Record<Lang, Record<string, string>> = {`)
  const out = []
  let i = src.indexOf('{', idx)
  for (let n = 0; n < 2; n++) {
    let depth = 0
    const start = i
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break } }
    }
    out.push(src.slice(start + 1, i - 1))
    i = src.indexOf('{', i)
  }
  return out
}
const keysOf = (b) => [...b.matchAll(/^\s*'([^']+)':/gm)].map((x) => x[1])
for (const name of ['DICT', 'EXTRA']) {
  const [en, zh] = blocksOf(name)
  const a = new Set(keysOf(en)); const b = new Set(keysOf(zh))
  const onlyA = [...a].filter((k) => !b.has(k)); const onlyB = [...b].filter((k) => !a.has(k))
  console.log(`[${name}] en=${a.size} zh=${b.size}`, onlyA.length || onlyB.length ? `\n  仅 en: ${onlyA}\n  仅 zh: ${onlyB}` : '✅ 一致')
}
const all = new Set([...keysOf(blocksOf('DICT')[0]), ...keysOf(blocksOf('EXTRA')[0])])
const used = execSync(`grep -rhoE "t\\\\('[a-zA-Z0-9_.]+'" src/renderer/src src/main | sed "s/t('//" | sort -u`, { shell: '/bin/bash' }).toString().trim().split('\n')
const missing = used.filter((k) => k && !all.has(k))
console.log('代码用到但字典缺失:', missing.length ? missing : '无')
