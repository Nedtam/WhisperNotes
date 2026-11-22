// 阶段 3 验证：手机端界面 ↔ 电脑端局域网服务（真实 HTTP + 真实渲染）
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const DESK_PORT = 9362
const PHONE_PORT = 9363
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => {
  results.push({ n, ok })
  console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`)
}

function connect(port, timeoutMs = 60000) {
  return (async () => {
    for (let i = 0; i < timeoutMs / 500; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
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
              pending.get(m.id)(m.result)
              pending.delete(m.id)
            } else if (m.method === 'Runtime.exceptionThrown') {
              errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
            }
          })
          const send = (method, params = {}) =>
            new Promise((r) => {
              const mid = ++id
              pending.set(mid, r)
              ws.send(JSON.stringify({ id: mid, method, params }))
            })
          return {
            errors,
            evalJs: async (e) => {
              const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true })
              if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
              return r.result?.value
            }
          }
        }
      } catch {
        /* retry */
      }
      await sleep(500)
    }
    throw new Error(`CDP ${port} 超时`)
  })()
}

// 测试用 markdown：在 Node 侧拼好（模板字符串里不能出现反引号）
const TICK = String.fromCharCode(96)
const TEST_MD =
  '## 渲染验证\n\n判断 ' +
  TICK +
  'x == y' +
  TICK +
  '，<mark class="hl-yellow">黄色荧光</mark>\n\n| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |'

const desk = spawn(
  path.join(ROOT, 'node_modules/.bin/electron'),
  [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${DESK_PORT}`, '--user-data-dir=/tmp/wn-devdata'],
  { cwd: ROOT, env: { ...process.env } }
)
desk.stderr.on('data', () => {})
let phone = null
setTimeout(() => {
  console.log('❌ 脚本超时')
  try {
    desk.kill('SIGKILL')
    phone?.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  process.exit(1)
}, 240000).unref?.()

try {
  const dc = await connect(DESK_PORT)
  await sleep(3500)

  // 电脑端：打开服务 + 拿配对码
  const qr = await dc.evalJs(`(async () => {
    await window.api.mobile.setEnabled(true)
    const q = await window.api.mobile.qr()
    const st = await window.api.mobile.status()
    const lib = await window.api.notes.list()
    // 造一条带表格 + 荧光 + 代码的笔记，验证手机端渲染
    const note = await window.api.notes.save({ title: '手机端渲染验证 ' + Date.now(), noteMd: ${JSON.stringify(TEST_MD)}, sourceText: '原始转写内容', templateId: 'study', notebookId: null, durationMs: 0, tags: ['测试'] })
    // 造一条长转写：本套件要验证手机端能列转写 + 打开长正文（测试库可能是空的）
    const trs = await window.api.transcriptions.list()
    if (trs.length === 0) {
      await window.api.transcriptions.save({ source: 'import', title: '手机端转写验证', sourceName: 'phone-check.m4a', rawText: ('这是用于验证手机端转写渲染的长文本，包含各种标点与换行。' + String.fromCharCode(10, 10)).repeat(40), durationMs: 600000 })
    }
    return { url: q.url, code: q.code, port: st.port, notes: lib.length, noteId: note.id }
  })()`)
  rec('电脑端服务已开 + 配对码就绪', !!qr.code && !!qr.port, `port=${qr.port} notes=${qr.notes}`)

  // 手机端：启动 Electron 当浏览器
  phone = spawn(
    path.join(ROOT, 'node_modules/.bin/electron'),
    [path.join(ROOT, 'tools/tmp/mobile-shell.cjs'), `--remote-debugging-port=${PHONE_PORT}`, '--user-data-dir=/tmp/wn-phone'],
    { cwd: ROOT, env: { ...process.env } }
  )
  phone.stderr.on('data', () => {})
  const pc = await connect(PHONE_PORT)
  await sleep(2500)
  // 清掉上次运行留下的连接信息，保证每次都从"连接页"开始（Preferences 在 web 上落 localStorage）
  await pc.evalJs(`(async () => { try { localStorage.clear() } catch {} try { indexedDB.deleteDatabase('whispernotes') } catch {} location.reload(); return true })()`)
  await sleep(3000)

  // 1) 连接页渲染
  const connectUi = await pc.evalJs(`({ text: document.body.innerText.slice(0, 200), inputs: document.querySelectorAll('input').length, buttons: [...document.querySelectorAll('button')].map(b=>b.textContent.trim()) })`)
  rec('手机端显示连接页', connectUi.inputs === 2 && /Connect to computer|连接电脑/.test(connectUi.text), JSON.stringify(connectUi.buttons))

  // 2) 走真实界面完成配对（输入地址 + 配对码 → 点连接）
  const paired = await pc.evalJs(`(async () => {
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const inputs = document.querySelectorAll('input')
    setVal(inputs[0], ${JSON.stringify(`http://127.0.0.1:${qr.port}`)})
    setVal(inputs[1], ${JSON.stringify(qr.code)})
    await new Promise(r => setTimeout(r, 300))
    const btn = [...document.querySelectorAll('button')].find(b => /Connect to computer|连接电脑|Connecting|正在连接/.test(b.textContent))
    btn.click()
    await new Promise(r => setTimeout(r, 4000))
    const text = document.body.innerText
    return { text: text.slice(0, 300), notes: (text.match(/渲染验证|Lecture|Week|欢迎|Welcome/g) || []).length, hasNav: /笔记库|Notes/.test(text) }
  })()`)
  rec('手机端完成配对并拉到文库', paired.hasNav && paired.notes > 0, `匹配条目=${paired.notes} text=${JSON.stringify(paired.text.slice(0, 120))}`)

  // 3) 打开那条验证笔记并检查渲染
  const opened = await pc.evalJs(`(async () => {
    const item = [...document.querySelectorAll('button')].find(b => /手机端渲染验证/.test(b.textContent))
    if (!item) return { error: 'note-not-found' }
    item.click()
    await new Promise(r => setTimeout(r, 2500))
    const body = document.querySelector('.md-body')
    return {
      title: document.body.innerText.split('\\n')[0],
      html: body ? body.innerHTML.slice(0, 400) : null,
      hasTable: !!document.querySelector('.md-body table'),
      cells: document.querySelectorAll('.md-body td').length,
      hasYellow: !!document.querySelector('.md-body mark.hl-yellow'),
      hasCode: !!document.querySelector('.md-body code'),
      cellText: [...document.querySelectorAll('.md-body td')].map(td => td.textContent).join(',')
    }
  })()`)
  rec('手机端渲染笔记（表格/荧光/代码）', opened.hasTable && opened.cells === 3 && opened.hasYellow && opened.hasCode, JSON.stringify({ cells: opened.cells, yellow: opened.hasYellow, code: opened.hasCode, text: opened.cellText }))

  // 4) 返回 + 切到转写页
  const tr = await pc.evalJs(`(async () => {
    const back = [...document.querySelectorAll('button')].find(b => /返回|Back/.test(b.textContent))
    if (back) back.click()
    await new Promise(r => setTimeout(r, 900))
    const nav = [...document.querySelectorAll('button')].find(b => b.getAttribute('data-tab') === 'transcripts')
    if (nav) nav.click()
    await new Promise(r => setTimeout(r, 1200))
    const items = [...document.querySelectorAll('button')].filter(b => /🎙|📂/.test(b.textContent))
    return { count: items.length, first: items[0] ? items[0].textContent.slice(0, 60) : null }
  })()`)
  rec('手机端转写列表可用', tr.count > 0, `条目=${tr.count} 首条=${JSON.stringify(tr.first)}`)

  // 5) 打开一条转写（正文很长，验证渲染不卡）
  const trRead = await pc.evalJs(`(async () => {
    const item = [...document.querySelectorAll('button')].find(b => /🎙|📂/.test(b.textContent))
    if (!item) return { error: 'none' }
    item.click()
    await new Promise(r => setTimeout(r, 3000))
    const body = document.querySelector('.md-body')
    return { chars: body ? body.innerText.length : 0, hasToggle: /原文|润色版|Raw|Polished/.test(document.body.innerText) }
  })()`)
  rec('手机端可读转写正文', trRead.chars > 500 && trRead.hasToggle, `正文字符=${trRead.chars}`)

  // 6) 设置页 + 离线缓存
  const settings = await pc.evalJs(`(async () => {
    const back = [...document.querySelectorAll('button')].find(b => /返回|Back/.test(b.textContent))
    if (back) back.click()
    await new Promise(r => setTimeout(r, 700))
    const nav = [...document.querySelectorAll('button')].find(b => b.getAttribute('data-tab') === 'settings')
    if (nav) nav.click()
    await new Promise(r => setTimeout(r, 900))
    const keys = Object.keys(localStorage)
    return { text: document.body.innerText.slice(0, 160), cached: keys.filter(k => k.includes('wn.')).length }
  })()`)
  rec('设置页显示连接状态与统计', /已连接|Connected/.test(settings.text), JSON.stringify(settings.text.slice(0, 90)))
  rec('内容已缓存到本机（离线可读）', settings.cached >= 2, `缓存键=${settings.cached}`)

  rec('手机端无异常', pc.errors.length === 0, pc.errors.slice(0, 2).join(' | '))

  // 清理验证笔记
  await dc.evalJs(`(async () => { const l = await window.api.notes.list(); for (const n of l) if (/手机端渲染验证/.test(n.title)) await window.api.notes.remove(n.id); return true })()`)
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try {
    desk.kill('SIGTERM')
    phone?.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  await sleep(800)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) process.exit(1)
}
