// 诊断：手机闪卡页"笔记本内挑笔记"在配对后到底多久可用（轮询而非固定 sleep）
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const DESK = 9410
const PHONE = 9411
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function connect(port) {
  return (async () => {
    for (let i = 0; i < 120; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const p = l.find((t) => t.type === 'page')
        if (p) {
          const ws = new WebSocket(p.webSocketDebuggerUrl)
          await new Promise((r, j) => {
            ws.addEventListener('open', r)
            ws.addEventListener('error', j)
          })
          let id = 0
          const pend = new Map()
          ws.addEventListener('message', (ev) => {
            const m = JSON.parse(ev.data)
            if (m.id && pend.has(m.id)) {
              pend.get(m.id)(m.result)
              pend.delete(m.id)
            }
          })
          const send = (method, params = {}) =>
            new Promise((r) => {
              const i2 = ++id
              pend.set(i2, r)
              ws.send(JSON.stringify({ id: i2, method, params }))
            })
          return {
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
    throw new Error('cdp')
  })()
}
const desk = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${DESK}`, '--user-data-dir=/tmp/wn-devdata'], { cwd: ROOT })
desk.stderr.on('data', () => {})
let phone = null
try {
  const dc = await connect(DESK)
  await sleep(3500)
  const seed = await dc.evalJs(`(async () => {
    await window.api.settings.set({ llm: { ...(await window.api.settings.get()).llm, baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'fake-key', modelId: 'fake-model', autoFallback: false,
      providers: [{ id: 'fake', name: 'Fake', baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'fake-key', modelId: 'fake-model', enabled: true }], activeProviderId: 'fake' } })
    for (const n of await window.api.notes.list()) if (/探针范围/.test(n.title)) await window.api.notes.remove(n.id)
    for (const nb of await window.api.notebooks.list()) if (/探针范围/.test(nb.name)) await window.api.notebooks.remove(nb.id)
    const p = await window.api.notebooks.create('探针范围-CS', null)
    const c = await window.api.notebooks.create('探针范围-CS-子', p.id)
    const mk = async (t, nb) => window.api.notes.save({ title: t, noteMd: '## 内容\\n\\n' + t, sourceText: '', templateId: 'study', notebookId: nb, durationMs: 0, tags: [] })
    const w1 = await mk('探针范围 Week1', p.id)
    await mk('探针范围 Week2', p.id)
    await mk('探针范围 子实验', c.id)
    await window.api.cards.generate({ noteIds: [w1.id], per1000: 20, maxPerNote: 3 })
    await window.api.mobile.setEnabled(true)
    const q = await window.api.mobile.qr()
    await new Promise(r => setTimeout(r, 2000))
    return { port: (await window.api.mobile.status()).port, code: q.code }
  })()`)
  phone = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'tools/tmp/mobile-shell.cjs'), `--remote-debugging-port=${PHONE}`], { cwd: ROOT })
  phone.stderr.on('data', () => {})
  const pc = await connect(PHONE)
  await sleep(2500)
  await pc.evalJs(`(async () => { try { localStorage.clear() } catch {} try { indexedDB.deleteDatabase('whispernotes') } catch {} location.reload(); return true })()`)
  await sleep(3000)
  await pc.evalJs(`(async () => {
    const setVal = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    const inputs = document.querySelectorAll('input')
    setVal(inputs[0], 'http://127.0.0.1:${seed.port}'); setVal(inputs[1], ${JSON.stringify(seed.code)})
    await new Promise(r => setTimeout(r, 300))
    const b = [...document.querySelectorAll('button')].find(x => /Connect to computer|连接电脑/.test(x.textContent)); b.click()
    return true
  })()`)
  // 先看笔记页（同一个 library prop）能不能列到探针笔记
  const notesTab = await pc.evalJs(`(async () => {
    window.__probeLog = []
    const nav = [...document.querySelectorAll('button')].find(x => x.getAttribute('data-tab') === 'notes')
    if (nav) nav.click()
    await new Promise(r => setTimeout(r, 2500))
    const txt = document.body.innerText
    const hits = (txt.match(/探针范围/g) || []).length
    window.__probeLog.push('notesTab hits=' + hits)
    return { hits, head: txt.slice(0, 160) }
  })()`)
  console.log('笔记页:', JSON.stringify(notesTab))

  // 点进笔记本行（先确保范围面板是展开的）
  const pick = await pc.evalJs(`(async () => {
    const vis = (el) => !!el && el.offsetParent !== null && el.getClientRects().length > 0
    const nbBtn = () => [...document.querySelectorAll('button')].filter(vis).find(x => /探针范围-CS(?!-)/.test(x.textContent || ''))
    const bar = () => [...document.querySelectorAll('button')].filter(vis).find(b => /^(Scope|分类范围)/.test((b.textContent||'').trim()))
    const nav = [...document.querySelectorAll('button')].find(x => x.getAttribute('data-tab') === 'cards')
    if (nav) nav.click()
    await new Promise(r => setTimeout(r, 1200))
    let guard = 0
    while (!nbBtn() && guard++ < 5) { const b = bar(); if (!b) break; b.click(); await new Promise(r => setTimeout(r, 700)) }
    const nb = nbBtn()
    if (nb) nb.click()
    await new Promise(r => setTimeout(r, 1200))
    const scopeLabel = (() => { const el = document.querySelector('[data-scope-label]'); return el ? el.textContent.trim() : null })()
    const labels = [...document.querySelectorAll('input[type=checkbox]')].filter(vis).map(c => (c.closest('label')?.textContent||'').trim())
    return {
      nbRow: nb ? (nb.textContent||'').trim() : null,
      scopeBarText: bar() ? bar().textContent.trim().slice(0, 40) : null,
      scopeLabel,
      labels: labels.filter(x => /探针范围/.test(x)),
      bodyHead: document.body.innerText.slice(0, 120)
    }
  })()`)
  console.log('点进笔记本后:', JSON.stringify(pick))

  // 每秒观察闪卡页"笔记本内笔记"是否出现
  for (let i = 1; i <= 6; i++) {
    await sleep(1000)
    const s = await pc.evalJs(`(async () => {
      const nav = [...document.querySelectorAll('button')].find(x => x.getAttribute('data-tab') === 'cards')
      if (nav && !nav.dataset.on) { nav.dataset.on = '1'; nav.click() }
      await new Promise(r => setTimeout(r, 300))
      const openBtn = [...document.querySelectorAll('button')].find(b => /分类范围|Scope/.test(b.textContent))
      if (openBtn && !openBtn.dataset.on) { openBtn.dataset.on = '1'; openBtn.click(); await new Promise(r => setTimeout(r, 400)) }
      const btns = [...document.querySelectorAll('button')]
      const nbRow = btns.find(x => /探针范围-CS(?!-)/.test(x.textContent || ''))
      const labels = [...document.querySelectorAll('input[type=checkbox]')].map(c => (c.closest('label')?.textContent || '').trim())
      const idx = await (async () => {
        const open = indexedDB.open('whispernotes', 1)
        const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error) })
        const lib = await new Promise((res, rej) => { const r = db.transaction('kv','readonly').objectStore('kv').get('library'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
        const probeNotes = (lib?.notes||[]).filter(n => /探针范围/.test(n.title||''))
        return { idxNotes: (lib?.notes||[]).length, hit: probeNotes.length, ids: probeNotes.map(n => n.title + '→nb=' + String(n.notebookId)), nbIds: (lib?.notebooks||[]).map(b => b.name + '|parent=' + String(b.parentId)) }
      })().catch(() => ({}))
      return { nbRow: nbRow ? (nbRow.textContent||'').trim() : null, labels: labels.filter(x => /探针范围/.test(x)), ...idx }
    })()`)
    console.log(`t=${i}s`, JSON.stringify(s))
    if (s.labels && s.labels.length >= 2) break
  }
} catch (e) {
  console.log('probe error', String(e))
} finally {
  try { desk.kill('SIGTERM'); phone?.kill('SIGTERM') } catch {}
  await sleep(500)
  process.exit(0)
}
