// 真实模型端到端：拿用户真实转写（61k / 101k）跑一遍新流程
// 关断言：完整笔记（无 ⚠ 横幅、每段都有内容痕迹）、请求数 < 50、耗时可见
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

// 完整性代理指标：把转写切成 10 段，每段挑 4 个"只出现一次"的稀有词，看笔记命中多少段
function rareByRegion(text, regions = 10) {
  const per = Math.ceil(text.length / regions)
  const out = []
  for (let i = 0; i < regions; i++) {
    const seg = text.slice(i * per, (i + 1) * per)
    const tokens = [...new Set((seg.match(/[A-Za-z][A-Za-z0-9\-]{5,}/g) || []).map((x) => x.toLowerCase()))]
    const rare = tokens.filter((t) => (text.toLowerCase().split(t).length - 1) <= 2).slice(0, 4)
    out.push(rare)
  }
  return out
}

function conn(port) {
  return (async () => {
    for (let i = 0; i < 120; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const p = l.find((t) => t.type === 'page')
        if (p) {
          const ws = new WebSocket(p.webSocketDebuggerUrl)
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
              const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true, timeout: 1800000 })
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

const UD = '/tmp/wn-real'
fs.rmSync(UD, { recursive: true, force: true })
fs.mkdirSync(UD, { recursive: true })
fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ storage: { dataParent: '/tmp/wn-realbase' }, ui: { language: 'zh' } }, null, 2))
const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), '--remote-debugging-port=9526', `--user-data-dir=${UD}`], { cwd: ROOT })
child.stderr.on('data', () => {})

const ids = process.argv.slice(2)
try {
  const dc = await conn(9526)
  await sleep(4000)
  const cfg = await dc.evalJs(`(async () => {
    const s = await window.api.settings.get()
    const next = await window.api.settings.set({ llm: { ...s.llm, baseUrl: 'https://openrouter.ai/api/v1', apiKey: ${JSON.stringify(KEY)}, modelId: 'dots-studio/dots-3-note-preview:free', maxOutputTokens: 32768, maxChunkChars: 14000, templateId: 'study', fallbackModels: [], autoFallback: false, providers: [] } })
    window.__wnStore.getState().setSettings(next)
    window.api.settings.resetDailyUsage && await window.api.settings.resetDailyUsage()
    return { model: next.llm.modelId, used: (await window.api.meta.dailyUsage()).used }
  })()`)
  rec('隔离环境已接真实模型（OpenRouter）', cfg.model.includes('dots'), JSON.stringify(cfg))

  for (const id of ids) {
    const text = rawOf(id)
    const title = titleOf(id)
    console.log(`\n===== ${title}（${text.length.toLocaleString()} 字）=====`)
    const t0 = Date.now()
    const r = await dc.evalJs(`(async () => {
      window.__prog = []; window.__d = null; window.__e = null
      window.api.onOrganizeJob((p) => window.__prog.push({ at: Date.now(), stage: p.stage, part: p.part, parts: p.parts, detail: p.detail }))
      window.api.onOrganizeDone((d) => { window.__d = d })
      window.api.onOrganizeError((e) => { window.__e = e })
      const before = (await window.api.notes.list()).length
      await window.api.llm.organizeStart({ title: ${JSON.stringify(title + ' [修复验证]')}, sourceText: ${JSON.stringify(text)} })
      const t = Date.now()
      while (!window.__d && !window.__e && Date.now() - t < 1800000) await new Promise(r2 => setTimeout(r2, 1000))
      const notes = await window.api.notes.list()
      const mine = notes.find(n => n.title === ${JSON.stringify(title + ' [修复验证]')})
      return {
        done: window.__d, err: window.__e, before, after: notes.length,
        noteMd: mine ? (await window.api.notes.get(mine.id)).noteMd : null,
        prog: window.__prog.slice(-14)
      }
    })()`)
    const wall = Math.round((Date.now() - t0) / 1000)
    if (r.err) { rec(`${title}: 整理成功`, false, JSON.stringify(r.err).slice(0, 300)); continue }
    const note = r.noteMd || ''
    const regions = rareByRegion(text)
    const hit = regions.filter((toks) => toks.some((tk) => note.toLowerCase().includes(tk))).length
    rec(`${title}: 产出完整笔记（无 ⚠ 警告横幅）`, note.length > 500 && !/⚠/.test(note), `noteChars=${note.length} requests=${r.done?.requests} chunks=${r.done?.chunks} 耗时=${wall}s`)
    rec(`${title}: degraded/incomplete 未触发`, r.done?.degraded !== true && r.done?.incomplete !== true, JSON.stringify({ d: r.done?.degraded, i: r.done?.incomplete, fp: r.done?.failedParts }))
    rec(`${title}: 请求数 < 50`, (r.done?.requests ?? 999) < 50, `${r.done?.requests} 次`)
    rec(`${title}: 每段内容都有痕迹（覆盖 ${hit}/10 段）`, hit >= 7, `覆盖 ${hit}/10`)
    rec(`${title}: 笔记写进笔记库`, r.after === r.before + 1, `${r.before} → ${r.after}`)
    console.log('   时长线:', r.prog.map((p) => `${new Date(p.at).toISOString().slice(11, 19)} ${p.stage} ${p.part ?? ''}/${p.parts ?? ''} ${(p.detail || '').slice(0, 28)}`).join('\n            '))
    // 清理本次验证笔记，避免污染
    await dc.evalJs(`(async () => { const n = (await window.api.notes.list()).find(x => /\\[修复验证\\]/.test(x.title)); if (n) await window.api.notes.remove(n.id); return true })()`)
  }
  rec('无渲染层异常', dc.errs.length === 0, dc.errs.slice(0, 2).join(' | '))
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(700)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  process.exit(0)
}
