// UI 截图 QA：启动应用 → 抓取各页面在 浅色/深色 下的渲染
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 9335
const OUT = '/tmp/wn-shots'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
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
  const send = (method, params = {}) =>
    new Promise((res) => { pend.set(++id, res); ws.send(JSON.stringify({ id, method, params })) })
  const evl = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r?.result?.value
  }
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
    console.log('saved', name)
  }
  const theme = async (mode) => {
    await send('Emulation.setEmulatedMedia', {
      media: '',
      features: [{ name: 'prefers-color-scheme', value: mode }]
    })
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await sleep(1800)

  await theme('light')
  await sleep(400)
  await shot('1-capture-light')

  await theme('dark')
  await sleep(400)
  await shot('2-capture-dark')

  // 打开笔记页（选 SYE2066 那条）
  await evl(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim().startsWith('笔记库')); b?.click(); return !!b })()`)
  await sleep(600)
  await evl(`(() => { const el=[...document.querySelectorAll('[role=button]')].find(x=>(x.textContent||'').includes('SYE2066')); el?.click(); return !!el })()`)
  await sleep(1000)
  await theme('light')
  await sleep(400)
  await shot('3-notes-light')
  await theme('dark')
  await sleep(400)
  await shot('4-notes-dark')

  // 编辑模式
  await evl(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='编辑'); b?.click(); return !!b })()`)
  await sleep(500)
  await theme('light')
  await sleep(300)
  await shot('5-editor-light')

  ws.close()
  child.kill('SIGTERM')
  await sleep(600)
  try { child.kill('SIGKILL') } catch {}
}
main().catch((e) => { console.error(e); process.exit(1) })
