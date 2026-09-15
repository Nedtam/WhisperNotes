// 复查：逐值打印 polish→organize→save 各步
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 9342
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DECKS = [
  path.join(ROOT, '00+SYE2066+Syllabus+and+Main+Assignments.pdf'),
  path.join(ROOT, 'SN+-+Lecture+1+Student+Notes.pdf'),
  path.join(ROOT, 'SN+-+Lecture+1+Supplemental+Student+Notes.pdf')
]

async function main() {
  const fullText = fs.readFileSync(path.join(ROOT, 'SYE2066-1-输出/SYE2066-1.transcript.txt'), 'utf-8')
  const fullB64 = Buffer.from(fullText, 'utf-8').toString('base64')
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
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pend = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((res) => { pend.set(++id, res); ws.send(JSON.stringify({ id, method, params })) })
  const evl = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r?.exceptionDetails) return { evalError: (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300) }
    return r?.result?.value
  }
  await send('Runtime.enable')
  await sleep(1500)

  const decksJs = JSON.stringify(DECKS)
  const out = await evl(`(async () => {
    const full = new TextDecoder().decode(Uint8Array.from(atob('${fullB64}'), c => c.charCodeAt(0)));
    const paths = ${decksJs};
    const pws = ['opw323','opw323','opw323'];
    let polishRes;
    try {
      polishRes = await window.api.llm.polish({ sourceText: full, slidesPaths: paths, slidesPasswords: pws });
    } catch (e) { polishRes = { error: e.message }; }
    if (polishRes && !polishRes.error) {
      try {
        const org = await window.api.llm.organize({
          title: 'SYE2066-1 · 转写精修 + 3课件增强（复测）', sourceText: polishRes.text,
          length: 'standard', slidesPaths: paths, slidesPasswords: pws
        });
        try {
          const saved = await window.api.notes.save({
            title: 'SYE2066-1 · 转写精修 + 3课件增强（复测）', noteMd: org.noteMd,
            sourceText: polishRes.text, templateId: 'study', durationMs: 9714944,
            tags: ['SYE2066','Lecture1','复测']
          });
          return { polish: { ok: true, len: polishRes.text.length, chunks: polishRes.chunks }, organize: { ok: true, len: org.noteMd.length, requests: org.requests }, savedId: saved.id };
        } catch (e) { return { polish: { ok: true }, organize: { ok: true }, saveError: e.message }; }
      } catch (e) {
        return { polish: { ok: true, len: polishRes.text.length }, organizeError: e.message };
      }
    }
    return { polishError: polishRes?.error ?? 'polish failed silently', polishRes };
  })()`)
  console.log(JSON.stringify(out, null, 1))
  ws.close()
  child.kill('SIGTERM')
  await sleep(400)
  try { child.kill('SIGKILL') } catch {}
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
