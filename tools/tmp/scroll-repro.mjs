// 复现「调整表格尺寸时页面跳回顶部」
// 步骤：造一条长笔记（表格靠下）→ 滚到中间 → 在表格右缘按下并拖动 → 记录 scrollTop 变化
// 再验证假设：把 focus 强制成 preventScroll 后重跑同一步骤
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9352
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
        const errors = []
        ws.addEventListener('message', (ev) => {
          const m = JSON.parse(ev.data)
          if (m.id && pending.has(m.id)) {
            const { resolve } = pending.get(m.id)
            pending.delete(m.id)
            resolve(m.result)
          } else if (m.method === 'Runtime.exceptionThrown') {
            errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
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
        return { send, evalJs, errors }
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

  // 造一条长笔记：很多段落 + 一个表格（让表格处于页面中下部）
  const info = await cdp.evalJs(`(async () => {
    const filler = Array.from({length: 40}, (_, i) => '这是第 ' + (i+1) + ' 段普通正文，用来把表格推到页面中下部，便于观察滚动位置。').join('\\n\\n')
    const table = '| 列A | 列B | 列C |\\n| --- | --- | --- |\\n| a1 | b1 | c1 |\\n| a2 | b2 | c2 |\\n| a3 | b3 | c3 |'
    const md = filler + '\\n\\n' + table + '\\n\\n' + filler
    const note = await window.api.notes.save({ title: '滚动复现 ' + Date.now(), noteMd: md, sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
    const st = window.__wnStore.getState()
    st.setTab('notes')
    await new Promise(r => setTimeout(r, 400))
    st.setPending({ id: note.id, title: note.title, noteMd: note.noteMd, sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
    await new Promise(r => setTimeout(r, 1200))
    const ed = document.querySelector('[contenteditable="true"]')
    const scroller = ed.closest('.overflow-y-auto')
    window.__wn = { noteId: note.id, ed, scroller }
    return { noteId: note.id, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight }
  })()`)
  console.log('笔记已建：', JSON.stringify(info))

  // 滚动到中下部，拿到表格右缘某单元格的坐标
  const geom = await cdp.evalJs(`(() => {
    const { ed, scroller } = window.__wn
    scroller.scrollTop = Math.round(scroller.scrollHeight * 0.55)
    const cell = ed.querySelector('table tbody tr:nth-child(2) td:nth-child(2)')
    const r = cell.getBoundingClientRect()
    const before = scroller.scrollTop
    return { before, x: Math.round(r.right - 2), y: Math.round(r.top + r.height/2), tableTop: Math.round(ed.querySelector('table').getBoundingClientRect().top) }
  })()`)
  console.log('拖动前 scrollTop =', geom.before, ' 目标坐标 =', geom.x, geom.y)

  // 真鼠标：按下 → 拖动 → 松开（中间各测一次 scrollTop）
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geom.x, y: geom.y, button: 'left', clickCount: 1, buttons: 1 })
  await sleep(120)
  const afterDown = await cdp.evalJs(`window.__wn.scroller.scrollTop`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geom.x + 40, y: geom.y, button: 'left', buttons: 1 })
  await sleep(120)
  const afterMove = await cdp.evalJs(`window.__wn.scroller.scrollTop`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geom.x + 40, y: geom.y, button: 'left', buttons: 0 })
  await sleep(400)
  const afterUp = await cdp.evalJs(`window.__wn.scroller.scrollTop`)
  console.log(`scrollTop: 拖动前=${geom.before} → 按下后=${afterDown} → 拖动中=${afterMove} → 松开后=${afterUp}`)
  console.log(afterDown === 0 && geom.before > 0 ? '❗ 按下瞬间跳回顶部（复现成功）' : '按下未跳顶')
  console.log(afterUp === 0 && geom.before > 0 ? '❗ 松开后停在顶部' : '松开后位置保留')

  // 验证假设：强制 focus({preventScroll:true}) 后重跑
  const geom2 = await cdp.evalJs(`(() => {
    const { ed, scroller } = window.__wn
    scroller.scrollTop = Math.round(scroller.scrollHeight * 0.55)
    const orig = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (o) { return orig.call(this, { preventScroll: true, ...(o || {}) }) }
    window.__wnOrigFocus = orig
    const cell = ed.querySelector('table tbody tr:nth-child(2) td:nth-child(2)')
    const r = cell.getBoundingClientRect()
    return { before: scroller.scrollTop, x: Math.round(r.right - 2), y: Math.round(r.top + r.height/2) }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geom2.x, y: geom2.y, button: 'left', clickCount: 1, buttons: 1 })
  await sleep(120)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geom2.x + 30, y: geom2.y, button: 'left', buttons: 1 })
  await sleep(120)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geom2.x + 30, y: geom2.y, button: 'left', buttons: 0 })
  await sleep(400)
  const patched = await cdp.evalJs(`(() => { HTMLElement.prototype.focus = window.__wnOrigFocus; return window.__wn.scroller.scrollTop })()`)
  console.log(`假设验证：preventScroll 后 拖动前=${geom2.before} → 松开后=${patched}`, patched === geom2.before ? '✅ 位置保持不变' : '❌ 仍有跳动')

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
