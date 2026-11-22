import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9359
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
      cdp = { evalJs: async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value } }
    }
  } catch { /* retry */ }
  if (!cdp) await sleep(500)
}
await sleep(3500)
const out = await cdp.evalJs(`(async () => {
  await window.api.mobile.setEnabled(true)
  window.__wnStore.getState().setTab('settings')
  await new Promise(r => setTimeout(r, 1600))
  const btns = [...document.querySelectorAll('button')].map(b => (b.textContent||'').trim()).filter(Boolean)
  const texts = btns.filter(x => /配对|pair|二维码|QR/i.test(x))
  const svgs = [...document.querySelectorAll('svg')].map(s => Math.round(s.getBoundingClientRect().width) + 'x' + Math.round(s.getBoundingClientRect().height))
  // 面板容器：找含“手机连接”的 section
  const sec = [...document.querySelectorAll('section')].find(s => /手机连接|Phone connection/.test(s.textContent||''))
  return { pairButtons: texts, allButtons: btns.slice(0, 14), svgs, panelText: (sec?.textContent||'').slice(0, 400) }
})()`)
console.log(JSON.stringify(out, null, 1))
child.kill('SIGTERM'); await sleep(400)
