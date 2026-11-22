// 插桩定位：拖动表格尺寸时，谁把 scroller.scrollTop 变成 0
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9353
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const child = spawn(
  path.join(ROOT, 'node_modules/.bin/electron'),
  [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/wn-devdata'],
  { cwd: ROOT, env: { ...process.env } }
)
let cdp = null
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p) {
        const ws = new WebSocket(p.webSocketDebuggerUrl)
        await new Promise((res, rej) => {
          ws.addEventListener('open', res)
          ws.addEventListener('error', rej)
        })
        let id = 0
        const pending = new Map()
        ws.addEventListener('message', (ev) => {
          const m = JSON.parse(ev.data)
          if (m.id && pending.has(m.id)) {
            const { resolve } = pending.get(m.id)
            pending.delete(m.id)
            resolve(m.result)
          }
        })
        const send = (method, params = {}) =>
          new Promise((resolve) => {
            const mid = ++id
            pending.set(mid, { resolve })
            ws.send(JSON.stringify({ id: mid, method, params }))
          })
        const evalJs = async (expression) => {
          const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
          return r.result?.value
        }
        return { send, evalJs }
      }
    } catch {
      /* retry */
    }
    await sleep(500)
  }
  throw new Error('CDP 超时')
}

try {
  cdp = await connect()
  await sleep(3500)
  const info = await cdp.evalJs(`(async () => {
    const filler = Array.from({length: 40}, (_, i) => '这是第 ' + (i+1) + ' 段普通正文，用来把表格推到页面中下部。').join('\\n\\n')
    const table = '| 列A | 列B | 列C |\\n| --- | --- | --- |\\n| a1 | b1 | c1 |\\n| a2 | b2 | c2 |\\n| a3 | b3 | c3 |'
    const note = await window.api.notes.save({ title: '插桩 ' + Date.now(), noteMd: filler + '\\n\\n' + table + '\\n\\n' + filler, sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
    const st = window.__wnStore.getState()
    st.setTab('notes')
    await new Promise(r => setTimeout(r, 400))
    st.setPending({ id: note.id, title: note.title, noteMd: note.noteMd, sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
    await new Promise(r => setTimeout(r, 1200))
    const ed = document.querySelector('[contenteditable="true"]')
    const scroller = ed.closest('.overflow-y-auto')
    window.__wn = { noteId: note.id, ed, scroller, events: [] }
    // 1) 监听 scroller 的 scroll：记录每次 scrollTop 变化
    scroller.addEventListener('scroll', () => {
      window.__wn.events.push({ t: Date.now() % 1e6, what: 'scroll', top: Math.round(scroller.scrollTop), h: scroller.scrollHeight })
    }, true)
    // 2) 拦截 editable 的 innerHTML 赋值（是否为整树重写）
    const proto = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')
    Object.defineProperty(ed, 'innerHTML', {
      get() { return proto.get.call(ed) },
      set(v) { window.__wn.events.push({ t: Date.now() % 1e6, what: 'innerHTML-write', top: Math.round(scroller.scrollTop), len: String(v).length }); proto.set.call(ed, v) },
      configurable: true
    })
    // 3) 记录 focus 调用
    const origFocus = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (o) {
      window.__wn.events.push({ t: Date.now() % 1e6, what: 'focus', tag: this.tagName, top: Math.round(scroller.scrollTop), active: document.activeElement === this })
      return origFocus.call(this, o)
    }
    return { noteId: note.id, scrollHeight: scroller.scrollHeight }
  })()`)
  console.log('笔记:', JSON.stringify(info))

  // 场景 A：编辑器未聚焦时，直接拖表格（第一次动表格的典型情形）
  const geom = await cdp.evalJs(`(() => {
    const { ed, scroller } = window.__wn
    scroller.scrollTop = Math.round(scroller.scrollHeight * 0.5)
    window.__wn.events.length = 0
    const cell = ed.querySelector('table tbody tr:nth-child(2) td:nth-child(2)')
    const r = cell.getBoundingClientRect()
    return { top: Math.round(scroller.scrollTop), x: Math.round(r.right - 2), y: Math.round(r.top + r.height/2), focused: document.activeElement === ed, hasColgroup: !!ed.querySelector('table > colgroup') }
  })()`)
  console.log('A 拖动前:', JSON.stringify(geom))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geom.x, y: geom.y, button: 'left', clickCount: 1, buttons: 1 })
  await sleep(150)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geom.x + 60, y: geom.y, button: 'left', buttons: 1 })
  await sleep(150)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geom.x + 60, y: geom.y, button: 'left', buttons: 0 })
  await sleep(600)
  console.log('A 事件序列:', JSON.stringify(await cdp.evalJs(`window.__wn.events`)))
  console.log('A 拖动后 scrollTop =', await cdp.evalJs(`window.__wn.scroller.scrollTop`))

  // 场景 B：先点进正文再滚动，然后拖（模拟“正在编辑时顺手改表格”）
  const geom2 = await cdp.evalJs(`(() => {
    const { ed, scroller } = window.__wn
    scroller.scrollTop = Math.round(scroller.scrollHeight * 0.5)
    ed.focus()
    window.__wn.events.length = 0
    const cell = ed.querySelector('table tbody tr:nth-child(2) td:nth-child(2)')
    const r = cell.getBoundingClientRect()
    return { top: Math.round(scroller.scrollTop), x: Math.round(r.right - 2), y: Math.round(r.top + r.height/2) }
  })()`)
  console.log('B 拖动前:', JSON.stringify(geom2))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geom2.x, y: geom2.y, button: 'left', clickCount: 1, buttons: 1 })
  await sleep(150)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geom2.x - 50, y: geom2.y, button: 'left', buttons: 1 })
  await sleep(150)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geom2.x - 50, y: geom2.y, button: 'left', buttons: 0 })
  await sleep(600)
  console.log('B 事件序列:', JSON.stringify(await cdp.evalJs(`window.__wn.events`)))
  console.log('B 拖动后 scrollTop =', await cdp.evalJs(`window.__wn.scroller.scrollTop`))

  await cdp.evalJs(`(async () => { await window.api.notes.remove(window.__wn.noteId); return true })()`)
} catch (e) {
  console.log('脚本失败:', e)
} finally {
  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  await sleep(600)
}
