// 回归验证：① 拖列宽真的生效 ② 外部重建 DOM 时滚动位置保住 ③ 工具栏操作不跳顶
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9354
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => {
  results.push({ n, ok })
  console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`)
}
const child = spawn(
  path.join(ROOT, 'node_modules/.bin/electron'),
  [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/wn-devdata'],
  { cwd: ROOT, env: { ...process.env } }
)
child.stderr.on('data', (d) => process.stderr.write('[el] ' + d))
// 硬超时：避免端口/单实例锁被占时无限等待
setTimeout(() => {
  console.log('❌ 脚本整体超时（可能端口或 userData 锁被上一个进程占用）')
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  process.exit(1)
}, 150000).unref?.()
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
  await cdp.evalJs(`(async () => {
    const filler = Array.from({length: 40}, (_, i) => '第 ' + (i+1) + ' 段正文，用于把表格推到中下部。').join('\\n\\n')
    const table = '| 列A | 列B | 列C |\\n| --- | --- | --- |\\n| a1 | b1 | c1 |\\n| a2 | b2 | c2 |'
    const note = await window.api.notes.save({ title: '回归 ' + Date.now(), noteMd: filler + '\\n\\n' + table + '\\n\\n' + filler, sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
    const st = window.__wnStore.getState()
    st.setTab('notes')
    await new Promise(r => setTimeout(r, 400))
    st.setPending({ id: note.id, title: note.title, noteMd: note.noteMd, sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
    await new Promise(r => setTimeout(r, 1200))
    const ed = document.querySelector('[contenteditable="true"]')
    window.__t = { noteId: note.id, ed, scroller: ed.closest('.overflow-y-auto') }
    return true
  })()`)

  // ① 拖列宽生效 + 位置不变（未聚焦的“第一次”场景）
  const g1 = await cdp.evalJs(`(() => {
    const { ed, scroller } = window.__t
    scroller.scrollTop = Math.round(scroller.scrollHeight * 0.5)
    const cell = ed.querySelector('table tbody tr:nth-child(1) td:nth-child(1)')
    const r = cell.getBoundingClientRect()
    const w0 = Math.round(cell.getBoundingClientRect().width)
    return { top: Math.round(scroller.scrollTop), x: Math.round(r.right - 2), y: Math.round(r.top + r.height/2), w0, focused: document.activeElement === ed }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g1.x, y: g1.y, button: 'left', clickCount: 1, buttons: 1 })
  await sleep(100)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g1.x + 70, y: g1.y, button: 'left', buttons: 1 })
  await sleep(120)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g1.x + 70, y: g1.y, button: 'left', buttons: 0 })
  await sleep(700)
  const r1 = await cdp.evalJs(`(() => {
    const { ed, scroller } = window.__t
    const cell = ed.querySelector('table tbody tr:nth-child(1) td:nth-child(1)')
    return { top: Math.round(scroller.scrollTop), w1: Math.round(cell.getBoundingClientRect().width), md: scroller ? null : null }
  })()`)
  rec('拖动改变列宽', r1.w1 > g1.w0 + 20, `列宽 ${g1.w0} → ${r1.w1}`)
  rec('拖动过程滚动位置不变（未聚焦场景）', r1.top === g1.top, `scrollTop ${g1.top} → ${r1.top}`)

  // 元数据是否写进 markdown（wn:cols）
  const md = await cdp.evalJs(`window.__wnStore.getState().pending.noteMd`)
  rec('列宽元数据写入笔记', /wn:cols=/.test(md), md.match(/<!--wn:cols=[^>]*-->/) ? md.match(/<!--wn:cols=[^>]*-->/)[0] : '未找到')

  // ② 外部 value 重建（模拟撤销/子窗同步）时保住滚动位置
  const r2 = await cdp.evalJs(`(async () => {
    const { scroller } = window.__t
    scroller.scrollTop = Math.round(scroller.scrollHeight * 0.6)
    const before = scroller.scrollTop
    const st = window.__wnStore.getState()
    const cur = st.pending
    // 外部改内容 → 触发 value 效应整树重建
    st.setPending({ ...cur, noteMd: cur.noteMd + '\\n\\n外部追加的一段。' })
    await new Promise(r => setTimeout(r, 800))
    return { before, after: Math.round(scroller.scrollTop) }
  })()`)
  rec('DOM 整树重建后滚动位置保留', Math.abs(r2.after - r2.before) <= 2, `scrollTop ${r2.before} → ${r2.after}`)

  // ③ 工具栏按钮（高亮）后位置不变
  const r3 = await cdp.evalJs(`(async () => {
    const { ed, scroller } = window.__t
    scroller.scrollTop = Math.round(scroller.scrollHeight * 0.5)
    const before = Math.round(scroller.scrollTop)
    // 选中一段文字再点黄色高亮按钮
    const p = ed.querySelectorAll('p')[20]
    const range = document.createRange()
    range.selectNodeContents(p)
    const sel = window.getSelection()
    sel.removeAllRanges(); sel.addRange(range)
    const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('title')||'').includes('高亮') || (b.textContent||'').trim() === '')
    const hlBtn = [...document.querySelectorAll('button')].find(b => b.className.includes('rounded-[4px]'))
    ;(hlBtn || btn)?.click()
    await new Promise(r => setTimeout(r, 600))
    return { before, after: Math.round(scroller.scrollTop), clicked: !!(hlBtn || btn) }
  })()`)
  rec('工具栏操作后滚动位置不变', r3.clicked && Math.abs(r3.after - r3.before) <= 2, `scrollTop ${r3.before} → ${r3.after}`)
  rec('无渲染层异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | '))

  await cdp.evalJs(`(async () => { await window.api.notes.remove(window.__t.noteId); return true })()`)
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  await sleep(600)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) process.exit(1)
}
