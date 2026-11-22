import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9347
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'),
  [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/wn-devdata'],
  { cwd: ROOT, env: { ...process.env } })
let cdp = null
try {
  for (let i = 0; i < 60 && !cdp; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p) {
        const ws = new WebSocket(p.webSocketDebuggerUrl)
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
        cdp = { ws, id: 0, pending: new Map(), errors: [] }
        ws.addEventListener('message', (ev) => {
          const m = JSON.parse(ev.data)
          if (m.id && cdp.pending.has(m.id)) { const { resolve } = cdp.pending.get(m.id); cdp.pending.delete(m.id); resolve(m.result) }
          else if (m.method === 'Runtime.exceptionThrown') cdp.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
        })
        await cdp.send('Runtime.enable')
      }
    } catch { /* retry */ }
    if (!cdp) await sleep(500)
  }
  cdp.send = (method, params = {}) => new Promise((resolve) => { const id = ++cdp.id; cdp.pending.set(id, { resolve }); cdp.ws.send(JSON.stringify({ id, method, params })) })
  cdp.evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  await sleep(3500)
  const types = await cdp.evalJs(`(async () => { const l = await window.api.notes.list(); return { allString: l.every(n => typeof n.noteMd === 'string' && typeof n.title === 'string'), sample: typeof l[0].noteMd, n: l.length } })()`)
  console.log((types.allString ? '✅' : '❌') + ' BLOB 笔记读出来仍是字符串 — ' + JSON.stringify(types))
  const view = await cdp.evalJs(`(async () => {
    window.__wnStore.getState().setTab('notes')
    await new Promise(r => setTimeout(r, 1200))
    const t = document.body.innerText
    return { rendered: t.includes('笔记') || t.includes('Notes'), crashed: /出错了|Something went wrong|reload/i.test(t) && t.length < 400, len: t.length }
  })()`)
  console.log((view.rendered && !view.crashed ? '✅' : '❌') + ' 笔记视图正常渲染 — ' + JSON.stringify(view))
  console.log((cdp.errors.length === 0 ? '✅' : '❌') + ' 无渲染层异常 ' + JSON.stringify(cdp.errors.slice(0, 2)))
} catch (e) {
  console.log('❌ 脚本失败: ' + e)
} finally {
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(600)
  process.exit(0)
}
