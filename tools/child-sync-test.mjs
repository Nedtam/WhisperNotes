// 子编辑窗同步冒烟：开子窗→改文字→验证 DB 自动保存
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 9345
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`], { cwd: ROOT })
  const getPages = async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      return list.filter((t) => t.type === 'page')
    } catch {
      return []
    }
  }
  for (let i = 0; i < 120; i++) {
    if ((await getPages()).length) break
    await sleep(300)
  }
  async function conn(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let id = 0
    const pend = new Map()
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) } }
    const send = (method, params = {}) => new Promise((res) => { pend.set(++id, res); ws.send(JSON.stringify({ id, method, params })) })
    const evl = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
      if (r?.exceptionDetails) return { evalError: (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 200) }
      return r?.result?.value
    }
    await send('Runtime.enable')
    return { evl, close: () => ws.close() }
  }

  const main = (await getPages()).find((p) => !p.url.includes('child='))
  const mc = await conn(main.webSocketDebuggerUrl)
  await sleep(1200)
  const id = await mc.evl(`(async () => {
    const list = await window.api.notes.list();
    return list.length ? list[list.length - 1].id : null;
  })()`)
  if (!id) { console.log('no notes'); process.exit(0) }
  console.log('last note id:', id)

  // 记录修改前内容
  const before = await mc.evl(`window.api.notes.get('${id}').then(n => n.noteMd.length)`)
  console.log('before len:', before)

  await mc.evl(`window.api.notes.openChild('${id}'); true`)
  await sleep(2500)
  const pages = await getPages()
  const cp = pages.find((p) => p.url.includes('child='))
  if (!cp) { console.log('CHILD NOT OPENED'); process.exit(1) }
  const cc = await conn(cp.webSocketDebuggerUrl)
  await sleep(1500)
  const ready = await cc.evl(`(() => { const t=document.querySelector('textarea'); return { hasText: !!t, len: t?.value.length ?? 0, title: document.querySelector('input')?.value ?? '' } })()`)
  console.log('child ready:', JSON.stringify(ready))

  // 输入一段唯一标记并等待自动同步保存
  await cc.evl(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, (ta.value || '') + '\\n[SYNC-TEST-MARKER]');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value.length;
  })()`)
  await sleep(2600)
  const after = await mc.evl(`window.api.notes.get('${id}').then(n => ({ len: n.noteMd.length, has: n.noteMd.includes('SYNC-TEST-MARKER') }))`)
  console.log('after:', JSON.stringify(after))
  // 清理标记还原
  await mc.evl(`window.api.notes.get('${id}').then(n => window.api.notes.save({ id: n.id, title: n.title, noteMd: n.noteMd.split('\\n[SYNC-TEST-MARKER]').join(''), sourceText: n.sourceText, templateId: n.templateId, durationMs: n.durationMs, tags: n.tags })).then(()=>true)`)
  console.log('cleaned marker')
  mc.close(); cc.close()
  child.kill('SIGTERM'); await sleep(500); try { child.kill('SIGKILL') } catch {}
  process.exit(after?.has ? 0 : 1)
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
