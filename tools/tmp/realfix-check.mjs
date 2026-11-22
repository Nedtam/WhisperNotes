// 真实修复验证：把用户那两篇"永远做不完"的转写，用真实模型跑通（新策略）
//   10-05: 1bbbe433-1c53-4560-9127-f69f4e4338ef（56,439 字，上次 19 段失败）
//   10-08: 54e67886-ffea-4bd5-aff6-a8f748908d5e（71,935 字，上次 2 段失败）
// 判定"成功"：笔记真正入库（note_status=ok）、没有 ⚠ 未完成横幅、每段内容都有痕迹、请求数 < 50
import { spawn, execFileSync } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => {
  results.push({ n, ok })
  console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`)
}
const KEY = fs.readFileSync('/tmp/wn-key.txt', 'utf8').trim()
const DB = process.env.HOME + '/Downloads/whisper-notes/library.db'
const rawOf = (id) => execFileSync('sqlite3', [DB, `SELECT raw_text FROM transcriptions WHERE id='${id}';`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const titleOf = (id) => execFileSync('sqlite3', [DB, `SELECT title FROM transcriptions WHERE id='${id}';`], { encoding: 'utf8' }).trim()

/** 完整性代理：把原文切 10 段，每段挑 3 个只出现一两次的稀有词，看笔记命中几段 */
function rareByRegion(text, regions = 10) {
  const per = Math.ceil(text.length / regions)
  const out = []
  for (let i = 0; i < regions; i++) {
    const seg = text.slice(i * per, (i + 1) * per)
    const tokens = [...new Set((seg.match(/[A-Za-z][A-Za-z0-9-]{5,}/g) || []).map((x) => x.toLowerCase()))]
    const low = text.toLowerCase()
    out.push(tokens.filter((t) => low.split(t).length - 1 <= 2).slice(0, 3))
  }
  return out
}

function conn(port) {
  return (async () => {
    for (let i = 0; i < 120; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const page = l.find((t) => t.type === 'page')
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl)
          await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
          let id = 0
          const pend = new Map()
          const errs = []
          ws.addEventListener('message', (ev) => {
            const m = JSON.parse(ev.data)
            if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) }
            else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
          })
          const send = (method, params = {}) => new Promise((r) => { const i2 = ++id; pend.set(i2, r); ws.send(JSON.stringify({ id: i2, method, params })) })
          return {
            errs,
            evalJs: async (e) => {
              const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true })
              if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
              return r.result?.value
            }
          }
        }
      } catch { /* retry */ }
      await sleep(500)
    }
    throw new Error('cdp')
  })()
}

const UD = '/tmp/wn-realfix'
fs.rmSync(UD, { recursive: true, force: true })
fs.mkdirSync(UD, { recursive: true })
fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ storage: { dataParent: '/tmp/wn-realfixbase' }, ui: { language: 'zh' } }, null, 2))
const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), '--remote-debugging-port=9540', `--user-data-dir=${UD}`], { cwd: ROOT })
child.stderr.on('data', () => {})
setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } process.exit(1) }, 45 * 60_000).unref?.()

const ids = process.argv.slice(2)
let dc = null
try {
  dc = await conn(9540)
  await sleep(4500)
  await dc.evalJs(`(async () => {
    const s = await window.api.settings.get()
    const real = ${JSON.stringify(JSON.parse(fs.readFileSync(process.env.HOME + '/Downloads/whisper-notes/config.json', 'utf8')).llm)}
    const next = await window.api.settings.set({ llm: { ...s.llm, ...real, apiKey: ${JSON.stringify(KEY)}, autoFallback: true, fallbackModels: [] }, autoOrganizeOnStop: false })
    window.__wnStore.getState().setSettings(next)
    return true
  })()`)
  console.log('真实模型:', JSON.parse(fs.readFileSync(process.env.HOME + '/Downloads/whisper-notes/config.json', 'utf8')).llm.modelId)

  for (const id of ids) {
    const text = rawOf(id)
    const title = titleOf(id)
    console.log(`\n===== ${title}（${text.length.toLocaleString()} 字）=====`)
    const t0 = Date.now()
    await dc.evalJs(`(async () => {
      const trs = await window.api.transcriptions.list()
      if (!trs.some((x) => x.id === ${JSON.stringify(id)})) {
        await window.api.transcriptions.save({ id: ${JSON.stringify(id)}, source: 'import', title: ${JSON.stringify(title)}, sourceName: 'real.mp4', rawText: window.__T, durationMs: 0 })
      }
      return true
    })()`.replace('window.__T', JSON.stringify(text)))
    const r = await dc.evalJs(`(async () => {
      window.__prog = []; window.__d = null
      window.api.onOrganizeJob((p) => window.__prog.push((p.detail || '').slice(0, 90)))
      window.api.onOrganizeDone((d) => { window.__d = d })
      window.api.onOrganizeError((e) => { window.__d = { error: e } })
      await window.api.llm.organizeStart({ title: ${JSON.stringify(title + ' [修复验证]')}, sourceText: window.__T, transcriptId: ${JSON.stringify(id)} })
      const t = Date.now()
      while (!window.__d && Date.now() - t < 2400000) await new Promise(r2 => setTimeout(r2, 1000))
      const notes = await window.api.notes.list()
      const mine = notes.find((n) => n.title === ${JSON.stringify(title + ' [修复验证]')})
      const full = mine ? await window.api.notes.get(mine.id) : null
      const trs = await window.api.transcriptions.list()
      const tr = trs.find((x) => x.id === ${JSON.stringify(id)})
      return { done: window.__d, noteMd: full?.noteMd ?? null, status: tr?.noteStatus ?? null, err: tr?.noteError ?? null, prog: window.__prog }
    })()`.replace('window.__T', JSON.stringify(text)))
    const wall = Math.round((Date.now() - t0) / 1000)
    const note = r.noteMd || ''
    const regions = rareByRegion(text)
    const hit = regions.filter((toks) => toks.some((tk) => note.toLowerCase().includes(tk))).length
    // 逐块覆盖（13k/块，与 App 分块一致）：每块至少要有一个"只在这块出现"的词出现在笔记里
    const per = 13000
    const chunks = []
    for (let i = 0; i < text.length; i += per) chunks.push(text.slice(i, i + per))
    const low = text.toLowerCase()
    const chunkHit = chunks.map((c) => {
      const toks = [...new Set((c.match(/[A-Za-z][A-Za-z0-9-]{5,}/g) || []).map((x) => x.toLowerCase()))]
      const rare = toks.filter((tk) => low.split(tk).length - 1 <= 2).slice(0, 8)
      return rare.length === 0 ? null : rare.some((tk) => note.toLowerCase().includes(tk))
    })
    const okChunks = chunkHit.filter((x) => x === true).length
    const known = chunkHit.filter((x) => x !== null).length
    rec(`${title}: 每个分块都有内容落进笔记（${okChunks}/${known}）`, known > 0 && okChunks === known, `逐块=${JSON.stringify(chunkHit)}`)
    if (note) {
      fs.writeFileSync(`/tmp/wn-note-${id.slice(0, 8)}.md`, note)
      fs.writeFileSync(`/tmp/wn-raw-${id.slice(0, 8)}.txt`, text)
      console.log('   笔记开头:', note.slice(0, 160).replace(/\n/g, ' '))
      console.log('   已导出笔记 →', `/tmp/wn-note-${id.slice(0, 8)}.md`)
    }
    if (r.done?.error) { rec(`${title}: 任务没有报错`, false, JSON.stringify(r.done.error).slice(0, 200)) }
    rec(`${title}: 笔记真正入库（note_status=ok）`, r.status === 'ok', `status=${r.status} err=${r.err ?? '-'}`)
    rec(`${title}: 没有"未完成/原文兜底"横幅`, !!note && !/⚠/.test(note), `noteChars=${note.length}`)
    rec(`${title}: failedParts=0`, (r.done?.failedParts ?? -1) === 0, JSON.stringify({ fp: r.done?.failedParts, inc: r.done?.incomplete }))
    rec(`${title}: 请求数 < 50`, (r.done?.requests ?? 999) < 50, `${r.done?.requests} 次 · ${wall}s`)
    // 粗略的"词面覆盖"只作参考（长短档会压缩，专名本来就可能不出现）
    console.log(`   参考：词面覆盖 ${hit}/10 段`)
    const tail = (r.prog || []).filter((x) => /精简|故障|失败|补齐|兜底|统一/.test(x)).slice(-6)
    console.log('   关键进度:', tail.join(' | ').slice(0, 400))
    // 保留笔记便于核对（脚本结束时统一清理）
  }
  rec('无渲染层异常', dc.errs.length === 0, dc.errs.slice(0, 2).join(' | '))
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try {
    await dc?.evalJs(`(async () => { for (const n of (await window.api.notes.list())) if (/\\[修复验证\\]/.test(n.title)) await window.api.notes.remove(n.id); return true })()`)
  } catch { /* ignore */ }
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(700)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  process.exit(0)
}
