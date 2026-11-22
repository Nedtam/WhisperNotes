// 手机端分类验证：笔记本/子笔记本/未归档筛选 + 未出卡标记 + 笔记本内挑笔记
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const DESK = 9400
const PHONE = 9401
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => {
  results.push({ n, ok })
  console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`)
}

function connect(port) {
  return (async () => {
    for (let i = 0; i < 120; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const p = list.find((t) => t.type === 'page')
        if (p) {
          const ws = new WebSocket(p.webSocketDebuggerUrl)
          await new Promise((res, rej) => {
            ws.addEventListener('open', res)
            ws.addEventListener('error', rej)
          })
          let id = 0
          const pending = new Map()
          const errors = []
          ws.addEventListener('message', (ev) => {
            const m = JSON.parse(ev.data)
            if (m.id && pending.has(m.id)) {
              pending.get(m.id)(m.result)
              pending.delete(m.id)
            } else if (m.method === 'Runtime.exceptionThrown') {
              errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
            }
          })
          const send = (method, params = {}) =>
            new Promise((r) => {
              const mid = ++id
              pending.set(mid, r)
              ws.send(JSON.stringify({ id: mid, method, params }))
            })
          return {
            errors,
            evalJs: async (e) => {
              const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true })
              if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
              return r.result?.value
            }
          }
        }
      } catch {
        /* retry */
      }
      await sleep(500)
    }
    throw new Error(`CDP ${port} 超时`)
  })()
}

const desk = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${DESK}`, '--user-data-dir=/tmp/wn-devdata'], { cwd: ROOT, env: { ...process.env } })
desk.stderr.on('data', () => {})
let phone = null
setTimeout(() => {
  console.log('❌ 超时')
  try {
    desk.kill('SIGKILL')
    phone?.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  process.exit(1)
}, 300000).unref?.()

try {
  const dc = await connect(DESK)
  await sleep(3500)

  // 造数据：笔记本 + 子笔记本 + 3 篇笔记，只给其中 1 篇出卡（另 2 篇=未出卡）
  const seed = await dc.evalJs(`(async () => {
    await window.api.settings.set({ llm: { ...(await window.api.settings.get()).llm, baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'fake-key', modelId: 'fake-model', autoFallback: false,
      providers: [{ id: 'fake', name: 'Fake', baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'fake-key', modelId: 'fake-model', enabled: true }], activeProviderId: 'fake' } })
    const old = await window.api.cards.list({ includeSuspended: true })
    for (const c of old) await window.api.cards.remove(c.id)
    for (const n of await window.api.notes.list()) if (/手机范围/.test(n.title)) await window.api.notes.remove(n.id)
    for (const nb of await window.api.notebooks.list()) if (/手机范围/.test(nb.name)) await window.api.notebooks.remove(nb.id)
    const p = await window.api.notebooks.create('手机范围-CS1315', null)
    const c = await window.api.notebooks.create('手机范围-CS1315-实验', p.id)
    const mk = async (t, nb) => window.api.notes.save({ title: t, noteMd: '## 内容\\n\\n' + t + ' 的要点说明。', sourceText: '', templateId: 'study', notebookId: nb, durationMs: 0, tags: [] })
    const w1 = await mk('手机范围 Week1', p.id)
    const w2 = await mk('手机范围 Week2', p.id)
    const lab = await mk('手机范围 实验', c.id)
    const free = await mk('手机范围 未归档', null)
    await window.api.cards.generate({ noteIds: [w1.id], per1000: 20, maxPerNote: 3 })
    await window.api.mobile.setEnabled(true)
    const q = await window.api.mobile.qr()
    const st = await window.api.mobile.status()
    await new Promise(r => setTimeout(r, 2500))
    return { port: st.port, code: q.code }
  })()`)
  const seeded = await dc.evalJs(`(async () => { const cs = await window.api.cards.list({}); return { cards: cs.length, notes: cs.map(c => c.noteId) } })()`)
  rec('造数据：1 篇出卡 / 3 篇未出卡', seeded.cards >= 2, `卡片=${seeded.cards}`)

  // 手机端
  phone = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'tools/tmp/mobile-shell.cjs'), `--remote-debugging-port=${PHONE}`], { cwd: ROOT, env: { ...process.env } })
  phone.stderr.on('data', () => {})
  const pc = await connect(PHONE)
  await sleep(2500)
  await pc.evalJs(`(async () => { try { localStorage.clear() } catch {} try { indexedDB.deleteDatabase('whispernotes') } catch {} location.reload(); return true })()`)
  await sleep(3000)
  const pairUrl = `http://127.0.0.1:${seed.port}`
  await pc.evalJs(`(async () => {
    const setVal = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    const inputs = document.querySelectorAll('input')
    setVal(inputs[0], ${JSON.stringify(pairUrl)}); setVal(inputs[1], ${JSON.stringify(seed.code)})
    await new Promise(r => setTimeout(r, 300))
    const b = [...document.querySelectorAll('button')].find(x => /Connect to computer|连接电脑/.test(x.textContent)); b.click()
    await new Promise(r => setTimeout(r, 4000))
    const nav = [...document.querySelectorAll('button')].find(x => x.getAttribute('data-tab') === 'cards')
    nav.click(); await new Promise(r => setTimeout(r, 2500))
    return true
  })()`)

  // 等本地库真正同步完（27 篇笔记 + 23 篇转写，4 秒远远不够 → 之前会误判为"手机端没数据"）
  const synced = await pc.evalJs(`(async () => {
    const readLib = async () => {
      const open = indexedDB.open('whispernotes', 1)
      const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error) })
      return await new Promise((res, rej) => { const r = db.transaction('kv','readonly').objectStore('kv').get('library'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    }
    const t0 = Date.now()
    while (Date.now() - t0 < 90000) {
      try {
        const lib = await readLib()
        const hit = (lib?.notes || []).some((n) => /手机范围 Week1/.test(n.title || ''))
        if (hit) return { ok: true, notes: (lib?.notes || []).length, nbs: (lib?.notebooks || []).length, ms: Date.now() - t0 }
      } catch { /* 还没建好 */ }
      await new Promise(r => setTimeout(r, 1000))
    }
    return { ok: false }
  })()`)
  rec('手机端本地库已同步完成（含刚建的笔记本笔记）', synced.ok === true, JSON.stringify(synced))

  const scopeUi = await pc.evalJs(`(async () => {
    // 注意：手机端所有页签都是常驻挂载的，必须只看"可见"元素，否则会点到笔记页的同名行
    window.__vis = (el) => !!el && el.offsetParent !== null && el.getClientRects().length > 0
    const visBtns = () => [...document.querySelectorAll('button')].filter(window.__vis)
    const bar = () => visBtns().find(b => /^(Scope|分类范围)/.test((b.textContent||'').trim()))
    const nbRowEl = () => visBtns().find(x => /手机范围-CS1315(?!-)/.test(x.textContent||''))
    let guard = 0
    while (!nbRowEl() && guard++ < 5) { const b = bar(); if (!b) break; b.click(); await new Promise(r => setTimeout(r, 700)) }
    const rows = visBtns().map(b => (b.textContent||'').trim())
    const nbRow = rows.find(x => /手机范围-CS1315(?!-)/.test(x))
    const subRow = rows.find(x => /手机范围-CS1315-实验/.test(x))
    return { nbRow, subRow, hasAll: rows.some(x => /^(全部|All)/.test(x)), hasUnsorted: rows.some(x => /未归档|Unsorted/.test(x)) }
  })()`)
  rec('手机端有分类选择（全部/未归档/笔记本/子笔记本）', scopeUi.hasAll && scopeUi.hasUnsorted && !!scopeUi.nbRow && !!scopeUi.subRow, JSON.stringify(scopeUi))
  rec('笔记本行显示“未出卡”数量', /未转|new/.test(scopeUi.nbRow || ''), `行内容: ${scopeUi.nbRow}`)

  const filtered = await pc.evalJs(`(async () => {
    const vis = window.__vis || ((el) => !!el && el.offsetParent !== null && el.getClientRects().length > 0)
    const visBtns = () => [...document.querySelectorAll('button')].filter(vis)
    const nb = visBtns().find(x => /手机范围-CS1315(?!-)/.test(x.textContent||''))
    if (nb) nb.click(); await new Promise(r => setTimeout(r, 900))
    // 面板可能被上一步关掉 → 只在"看不到笔记多选"时再展开一次（点两次会又收起来）
    const hasChecks = () => [...document.querySelectorAll('input[type=checkbox]')].filter(vis).length > 0
    let guard = 0
    while (!hasChecks() && guard++ < 5) {
      const b = visBtns().find(x => /^(Scope|分类范围)/.test((x.textContent||'').trim()))
      if (!b) break
      b.click(); await new Promise(r => setTimeout(r, 700))
    }
    const checks = [...document.querySelectorAll('input[type=checkbox]')].filter(vis)
    const labels = checks.map(c => (c.closest('label')?.textContent||'').trim())
    // 只数"可见的卡片行"，不依赖卡片文案（假模型的卡片文案会变）
    const listAfterNb = [...document.querySelectorAll('li')].filter((li) => vis(li)).length
    // 只勾选未出卡的 Week2
    const w2 = checks[labels.findIndex(x => /手机范围 Week2/.test(x))]
    const clear = visBtns().find(b => /清空|Clear/.test(b.textContent))
    if (clear) { clear.click(); await new Promise(r => setTimeout(r, 600)) }
    if (w2) { w2.click(); await new Promise(r => setTimeout(r, 900)) }
    const afterPick = [...document.querySelectorAll('li')].filter((li) => vis(li)).length
    // 诊断：看看手机端拿到的 library 里这些笔记的 notebookId 到底是什么
    let diag = null
    try {
      const open = indexedDB.open('whispernotes', 1)
      const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error) })
      const lib = await new Promise((res, rej) => { const r = db.transaction('kv','readonly').objectStore('kv').get('library'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      diag = {
        notes: (lib?.notes || []).filter((n) => /手机范围/.test(n.title)).map((n) => n.title + '→' + String(n.notebookId)),
        nbs: (lib?.notebooks || []).map((b) => b.name + '(' + String(b.id).slice(0, 6) + ')')
      }
    } catch (e) { diag = String(e) }
    return { labels: labels.slice(0, 5), listAfterNb, afterPick, diag }
  })()`)
  rec('手机端按笔记本过滤卡片', filtered.listAfterNb >= 1, `条目=${filtered.listAfterNb}`)
  rec('手机端列出笔记本内每篇笔记并可勾选', filtered.labels.some((x) => /手机范围 Week1/.test(x)) && filtered.labels.some((x) => /手机范围 Week2/.test(x)), JSON.stringify(filtered.labels) + ' 诊断=' + JSON.stringify(filtered.diag))
  rec('只勾未出卡笔记 → 列表为空（该篇没有卡片）', filtered.afterPick === 0, `勾选后条目=${filtered.afterPick}`)

  rec('手机端无异常', pc.errors.length === 0, pc.errors.slice(0, 2).join(' | '))

  await dc.evalJs(`(async () => {
    const l = await window.api.cards.list({ includeSuspended: true }); for (const c of l) await window.api.cards.remove(c.id)
    for (const n of await window.api.notes.list()) if (/手机范围/.test(n.title)) await window.api.notes.remove(n.id)
    for (const nb of await window.api.notebooks.list()) if (/手机范围/.test(nb.name)) await window.api.notebooks.remove(nb.id)
    await window.api.mobile.setEnabled(false)
    return true
  })()`)
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try {
    desk.kill('SIGTERM')
    phone?.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  await sleep(700)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) process.exit(1)
}
