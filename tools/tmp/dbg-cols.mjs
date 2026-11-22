import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9355
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'),
  [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/wn-devdata'],
  { cwd: ROOT, env: { ...process.env } })
let cdp = null
for (let i = 0; i < 60 && !cdp; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const p = list.find((t) => t.type === 'page')
    if (p) {
      const ws = new WebSocket(p.webSocketDebuggerUrl)
      await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
      let id = 0; const pending = new Map()
      ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } })
      const send = (method, params = {}) => new Promise((r) => { const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })) })
      cdp = { send, evalJs: async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value } }
    }
  } catch { /* retry */ }
  if (!cdp) await sleep(500)
}
await sleep(3500)
await cdp.evalJs(`(async () => {
  const filler = Array.from({length: 30}, (_, i) => '第 ' + (i+1) + ' 段正文。').join('\\n\\n')
  const table = '| 列A | 列B | 列C |\\n| --- | --- | --- |\\n| a1 | b1 | c1 |'
  const note = await window.api.notes.save({ title: 'cols调试 ' + Date.now(), noteMd: filler + '\\n\\n' + table, sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
  const st = window.__wnStore.getState(); st.setTab('notes'); await new Promise(r=>setTimeout(r,400))
  st.setPending({ id: note.id, title: note.title, noteMd: note.noteMd, sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
  await new Promise(r=>setTimeout(r,1200))
  const ed = document.querySelector('[contenteditable="true"]')
  window.__t = { noteId: note.id, ed, scroller: ed.closest('.overflow-y-auto') }
  return true
})()`)
const g = await cdp.evalJs(`(() => { const {ed, scroller} = window.__t; scroller.scrollTop = Math.round(scroller.scrollHeight * 0.5); const c = ed.querySelector('table tbody tr td:nth-child(1)'); const r = c.getBoundingClientRect(); return { x: Math.round(r.right-2), y: Math.round(r.top + r.height/2), cg0: ed.querySelector('table > colgroup')?.outerHTML ?? 'none', top: Math.round(scroller.scrollTop) } })()`)
console.log('拖动前 colgroup:', g.cg0)
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', clickCount: 1, buttons: 1 })
await sleep(120)
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.x + 60, y: g.y, button: 'left', buttons: 1 })
await sleep(200)
console.log('拖动中 colgroup:', await cdp.evalJs(`window.__t.ed.querySelector('table > colgroup')?.outerHTML ?? 'none'`))
console.log('拖动中 col styles:', await cdp.evalJs(`JSON.stringify(Array.from(window.__t.ed.querySelectorAll('table > colgroup > col')).map(c => c.getAttribute('style')))`))
console.log('拖动中 table style:', await cdp.evalJs(`window.__t.ed.querySelector('table').getAttribute('style')`))
console.log('拖动中 :scope 查询:', await cdp.evalJs(`(() => { const t = window.__t.ed.querySelector('table'); return t.querySelectorAll(':scope > colgroup > col').length })()`))
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x + 60, y: g.y, button: 'left', buttons: 0 })
await sleep(700)
console.log('拖动后 colgroup:', await cdp.evalJs(`window.__t.ed.querySelector('table > colgroup')?.outerHTML ?? 'none'`))
console.log('store md 含 wn:cols ?', await cdp.evalJs(`/wn:cols=/.test(window.__wnStore.getState().pending.noteMd)`))
console.log('DOM 序列化含 wn:cols ?', await cdp.evalJs(`(() => { const ed = window.__t.ed; return document.title && (window.__t.ed.innerHTML.includes('colgroup')) })()`))
// 手动触发一次 sync（输入一个空格）后再看
await cdp.evalJs(`(() => { const ed = window.__t.ed; ed.focus(); document.execCommand('insertText', false, ' '); return true })()`)
await sleep(600)
console.log('插入空格后 store md 含 wn:cols ?', await cdp.evalJs(`/wn:cols=/.test(window.__wnStore.getState().pending.noteMd)`))
console.log('store md 表格片段:', JSON.stringify((await cdp.evalJs(`window.__wnStore.getState().pending.noteMd`)).slice(-160)))
await cdp.evalJs(`(async () => { await window.api.notes.remove(window.__t.noteId); return true })()`)
child.kill('SIGTERM'); await sleep(500)
