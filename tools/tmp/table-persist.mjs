// 表格尺寸持久化：写入带 wn:cols/rows 的笔记 → 重新打开 → 渲染尺寸应还原
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9356
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'),
  [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/wn-devdata'],
  { cwd: ROOT, env: { ...process.env } })
child.stderr.on('data', (d) => process.stderr.write('[el] ' + d))
setTimeout(() => { console.log('❌ 超时'); try { child.kill('SIGKILL') } catch {} process.exit(1) }, 140000).unref?.()
let cdp = null
for (let i = 0; i < 60 && !cdp; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const p = list.find((t) => t.type === 'page')
    if (p) {
      const ws = new WebSocket(p.webSocketDebuggerUrl)
      await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
      let id = 0; const pending = new Map(); const errors = []
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
        else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      })
      const send = (method, params = {}) => new Promise((r) => { const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })) })
      cdp = { errors, evalJs: async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value } }
    }
  } catch { /* retry */ }
  if (!cdp) await sleep(500)
}
await sleep(3500)
const out = await cdp.evalJs(`(async () => {
  const md = '<!--wn:cols=300,120,90 rows=60,44,44-->\\n| 列A | 列B | 列C |\\n| --- | --- | --- |\\n| a1 | b1 | c1 |\\n| a2 | b2 | c2 |'
  const note = await window.api.notes.save({ title: '尺寸持久化 ' + Date.now(), noteMd: md, sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
  const st = window.__wnStore.getState(); st.setTab('notes'); await new Promise(r => setTimeout(r, 400))
  st.setPending({ id: note.id, title: note.title, noteMd: note.noteMd, sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
  await new Promise(r => setTimeout(r, 1200))
  const ed = document.querySelector('[contenteditable="true"]')
  const table = ed.querySelector('table')
  const cols = Array.from(table.querySelectorAll(':scope > colgroup > col')).map(c => Math.round(parseFloat((c.getAttribute('style')||'0').replace(/[^\\d.]/g, ''))))
  const rowH = Array.from(table.rows).map(tr => Math.round(tr.cells[0].getBoundingClientRect().height))
  const cellW = Array.from(table.rows[0].cells).map(td => Math.round(td.getBoundingClientRect().width))
  const saved = (await window.api.notes.list()).find(n => n.id === note.id)?.noteMd ?? ''
  const keep = md === saved || saved.includes('wn:cols=300,120,90')
  await window.api.notes.remove(note.id)
  return { cols, cellW, rowH, keep, tableW: Math.round(table.getBoundingClientRect().width) }
})()`)
const ok1 = JSON.stringify(out.cols) === '[300,120,90]'
const ok2 = out.cellW.every((w, i) => Math.abs(w - [300,120,90][i]) <= 2)
const ok3 = out.rowH.every((h, i) => Math.abs(h - [60,44,44][i]) <= 2)
console.log((ok1 ? '✅' : '❌') + ' 重新打开后列宽还原 — ' + JSON.stringify(out.cols))
console.log((ok2 ? '✅' : '❌') + ' 实际渲染列宽一致 — ' + JSON.stringify(out.cellW))
console.log((ok3 ? '✅' : '❌') + ' 行高还原 — ' + JSON.stringify(out.rowH))
console.log((out.keep ? '✅' : '❌') + ' 元数据在保存往返中保留')
console.log((cdp.errors.length === 0 ? '✅' : '❌') + ' 无渲染层异常')
child.kill('SIGTERM'); await sleep(500)
