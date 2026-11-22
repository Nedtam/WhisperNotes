// 子窗口改名 → 主窗口/数据库同步验证（隔离环境）
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9346
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const record = (n, ok, extra = '') => {
  results.push({ n, ok, extra })
  console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.errors = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) reject(new Error(m.error.message))
        else resolve(m.result)
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result?.value
  }
}

async function pages() {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  } catch {
    return []
  }
}
async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  return cdp
}

const child = spawn(
  path.join(ROOT, 'node_modules/.bin/electron'),
  [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/wn-devdata'],
  { cwd: ROOT, env: { ...process.env } }
)
child.stderr.on('data', (d) => process.stderr.write('[el] ' + d))

try {
  let main = null
  for (let i = 0; i < 60 && !main; i++) {
    const list = await pages()
    const p = list.find((t) => t.type === 'page')
    if (p) main = await attach(p)
    else await sleep(500)
  }
  if (!main) throw new Error('主窗口 CDP 未就绪')
  await sleep(3000)

  // 选一篇笔记并在子窗口打开
  const info = await main.evalJs(`(async () => {
    const notes = await window.api.notes.list()
    const n = notes.find(x => /渲染测试|改名测试/.test(x.title)) || notes[0]
    const ok = await window.api.notes.openChild(n.id)
    return { id: n.id, title: n.title, ok, total: notes.length }
  })()`)
  record('子窗口打开', info.ok === true, JSON.stringify(info))
  await sleep(2500)

  // 连到子窗口（第二个 page）
  const list = await pages()
  const childPage = list.filter((t) => t.type === 'page').find((t) => t.url.includes('child'))
  record('找到子窗口页面', !!childPage, list.map((t) => t.url).join(' , '))
  const cdp2 = await attach(childPage)
  await sleep(1500)

  const renamed = await cdp2.evalJs(`(async () => {
    const input = [...document.querySelectorAll('input')].find(i => /^改名|^渲染|^Lecture/.test(i.value)) || document.querySelector('input')
    if (!input) return { error: 'no input', inputs: [...document.querySelectorAll('input')].map(i=>i.value) }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    const t = '子窗改名 ' + Date.now().toString().slice(-6)
    setter.call(input, t)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return { newTitle: t }
  })()`)
  record('子窗口写入新标题', !!renamed.newTitle, JSON.stringify(renamed))
  await sleep(2200)

  const after = await main.evalJs(`(async () => { const l = await window.api.notes.list(); const n = l.find(x => x.id === ${JSON.stringify(info.id)}); return { title: n?.title, listed: l.slice(0,3).map(x=>x.title) } })()`)
  record('数据库已持久化子窗口改名', after.title === renamed.newTitle, JSON.stringify(after))

  // 主窗口切到该笔记时标题应同步
  const mainSync = await main.evalJs(`(async () => {
    const st = window.__wnStore.getState()
    const l = await window.api.notes.list()
    const n = l.find(x => x.id === ${JSON.stringify(info.id)})
    st.setTab('notes')
    await new Promise(r=>setTimeout(r,300))
    st.setPending({ id: n.id, title: n.title, noteMd: n.noteMd, sourceText: n.sourceText, templateId: n.templateId, notebookId: n.notebookId ?? null, durationMs: n.durationMs, tags: n.tags ?? [] })
    await new Promise(r=>setTimeout(r,600))
    return { titleInEditor: [...document.querySelectorAll('input')].map(i=>i.value).find(v=>/子窗改名/.test(v)) || null }
  })()`)
  record('主窗口编辑器显示新标题', !!mainSync.titleInEditor, JSON.stringify(mainSync))

  // 清理
  await main.evalJs(`(async () => { const l = await window.api.notes.list(); for (const n of l) if (/渲染测试|改名测试|子窗改名/.test(n.title)) await window.api.notes.remove(n.id); return true })()`)
  record('渲染层异常', main.errors.length === 0 && cdp2.errors.length === 0, [...main.errors, ...cdp2.errors].slice(0, 2).join(' | '))
} catch (e) {
  record('脚本', false, String(e))
} finally {
  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  await sleep(700)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) process.exit(1)
}
