// 课件增强整理演示：真实 PDF(带密码) + SYE2066-1 转写 → 标准档笔记写入 App 库
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 9336
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`], { cwd: ROOT })
  let page
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p) { page = p; break }
    } catch {}
    await sleep(300)
  }
  if (!page) throw new Error('page not found')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pend = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) }
  }
  const send = (method, params = {}) => new Promise((res) => { pend.set(++id, res); ws.send(JSON.stringify({ id, method, params })) })
  const evl = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r?.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r?.result?.value
  }
  await send('Runtime.enable')
  await sleep(1600)

  const out = await evl(`(async () => {
    const list = await window.api.notes.list();
    const src = list.find(n => n.title.startsWith('SYE2066-1'));
    if (!src) return { ok: false, error: '找不到 SYE2066-1 笔记' };
    const r = await window.api.llm.organize({
      title: 'SYE2066-1 · Lecture 1 课件增强版',
      sourceText: src.sourceText,
      length: 'standard',
      slidesPath: '${ROOT.replace(/\\/g, '\\\\')}/SN+-+Lecture+1+Student+Notes.pdf',
      slidesPassword: 'opw323'
    });
    const saved = await window.api.notes.save({
      title: 'SYE2066-1 · Lecture 1 课件增强版',
      noteMd: r.noteMd, sourceText: src.sourceText,
      templateId: 'study', durationMs: 9714944, tags: ['SYE2066', 'Lecture1']
    });
    return { ok: true, len: r.noteMd.length, requests: r.requests, savedId: saved.id };
  })().catch(e => ({ ok: false, error: e.message }))`)

  console.log(JSON.stringify(out, null, 1))
  ws.close()
  child.kill('SIGTERM')
  await sleep(500)
  try { child.kill('SIGKILL') } catch {}
  process.exit(out?.ok ? 0 : 1)
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
