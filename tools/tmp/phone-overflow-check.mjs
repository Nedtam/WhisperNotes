// 手机端"按钮出框"审计：把所有页签的可见按钮扫一遍，检查
//  ① 文字有没有被挤出按钮（scrollWidth > clientWidth）
//  ② 按钮有没有超出父容器（rect.right > 父容器 right）
// 顺带断言设置页那对长标签按钮是竖排的（曾经'下载全部内容/清空本机内容'挤一行直接出框）
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const DESK = 9565
const PHONE = 9566
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => {
  results.push({ n, ok })
  console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`)
}

function connect(port) {
  return (async () => {
    for (let i = 0; i < 160; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const page = l.find((t) => t.type === 'page')
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl)
          await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
          let id = 0
          const pend = new Map()
          const errs = []
          ws.addEventListener('message', (ev) => {
            const m = JSON.parse(ev.data)
            if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) }
            else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
          })
          const send = (method, params = {}) => new Promise((r) => { const i2 = ++id; pend.set(i2, r); ws.send(JSON.stringify({ id: i2, method, params })) })
          return {
            errs,
            evalJs: async (e) => {
              const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true })
              if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
              return r.result?.value
            }
          }
        }
      } catch { /* retry */ }
      await sleep(500)
    }
    throw new Error('cdp:' + port)
  })()
}

// 审计脚本：只检查可见元素；btn 的文字溢出与容器溢出都要报
const AUDIT = `(async (tag) => {
  const vis = (el) => !!el && el.offsetParent !== null && el.getClientRects().length > 0
  const bad = []
  for (const b of [...document.querySelectorAll('button')].filter(vis)) {
    const label = (b.textContent || '').trim().slice(0, 28)
    const cs = getComputedStyle(b)
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
    // 文字被挤出按钮（按钮是 nowrap，文字比可用宽度还宽 → 出框）
    const contentOverflow = b.scrollWidth > b.clientWidth + 1
    const textNeeds = b.scrollWidth + padX
    const textClipped = textNeeds > b.clientWidth + padX + 1
    // 按钮超出父容器
    const parent = b.parentElement?.closest('.panel, .card, body') ?? b.parentElement
    const pr = parent?.getBoundingClientRect()
    const br = b.getBoundingClientRect()
    const outOfParent = !!pr && (br.right > pr.right + 1 || br.left < pr.left - 1)
    if (contentOverflow || textClipped || outOfParent) bad.push({ label, contentOverflow, textClipped, outOfParent, w: Math.round(br.width), parentW: pr ? Math.round(pr.width) : null })
  }
  return { tag, bad }
})`

fs.rmSync('/tmp/wn-overflow', { recursive: true, force: true })
const desk = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${DESK}`, '--user-data-dir=/tmp/wn-overflow'], { cwd: ROOT })
desk.stderr.on('data', () => {})
let phone = null
setTimeout(() => { try { desk.kill('SIGKILL'); phone?.kill('SIGKILL') } catch { /* ignore */ } process.exit(1) }, 420000).unref?.()

try {
  const dc = await connect(DESK)
  await sleep(4500)
  const seed = await dc.evalJs(`(async () => {
    await window.api.mobile.setEnabled(true)
    const nb = await window.api.notebooks.create('出框审计-课程')
    await window.api.notes.save({ title: '出框审计笔记', noteMd: '# 标题\\n\\n内容', sourceText: '', templateId: 'study', notebookId: nb.id })
    await window.api.transcriptions.save({ source: 'import', title: '出框审计-转写', sourceName: 'x.m4a', rawText: '内容 '.repeat(80), durationMs: 60000 })
    const q = await window.api.mobile.qr()
    const st = await window.api.mobile.status()
    return { port: st.port, code: q.code }
  })()`)

  phone = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'tools/tmp/mobile-shell.cjs'), `--remote-debugging-port=${PHONE}`, '--user-data-dir=/tmp/wn-phone'], { cwd: ROOT })
  phone.stderr.on('data', () => {})
  const pc = await connect(PHONE)
  await sleep(2500)
  await pc.evalJs(`(async () => { try { localStorage.clear() } catch {} try { indexedDB.deleteDatabase('whispernotes') } catch {} location.reload(); return true })()`)
  await sleep(3000)
  await pc.evalJs(`(async () => {
    const setVal = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    const inputs = document.querySelectorAll('input')
    setVal(inputs[0], 'http://127.0.0.1:${String(seed.port)}'); setVal(inputs[1], ${JSON.stringify(seed.code)})
    await new Promise(r => setTimeout(r, 300))
    ;[...document.querySelectorAll('button')].find(x => /Connect to computer|连接电脑/.test(x.textContent)).click()
    await new Promise(r => setTimeout(r, 6000))
    return true
  })()`)

  // 逐个页签审计
  const tabs = [
    ['notes', '笔记页'],
    ['transcripts', '转写页'],
    ['cards', '闪卡页'],
    ['settings', '设置页']
  ]
  for (const [tab, name] of tabs) {
    const r = await pc.evalJs(`(async () => {
      const nav = [...document.querySelectorAll('button')].find(b => b.getAttribute('data-tab') === ${JSON.stringify(tab)})
      nav?.click()
      await new Promise(r => setTimeout(r, 1500))
      return ${AUDIT}(${JSON.stringify(name)})
    })()`)
    rec(`${name}：没有按钮出框`, (r.bad ?? []).length === 0, JSON.stringify(r.bad ?? []).slice(0, 400))
  }

  // 设置页那对长标签按钮必须是竖排（不是同一行）
  const stacked = await pc.evalJs(`(async () => {
    const nav = [...document.querySelectorAll('button')].find(b => b.getAttribute('data-tab') === 'settings')
    nav?.click()
    await new Promise(r => setTimeout(r, 1200))
    const a = [...document.querySelectorAll('button')].find(b => /下载全部内容|Download everything/.test(b.textContent || ''))
    const c = [...document.querySelectorAll('button')].find(b => /清空本机内容|Clear local content/.test(b.textContent || ''))
    if (!a || !c) return { found: false }
    const ra = a.getBoundingClientRect(), rc = c.getBoundingClientRect()
    return { found: true, sameRow: Math.abs(ra.top - rc.top) < 4, aLabel: a.innerText.trim(), cLabel: c.innerText.trim() }
  })()`)
  rec('「下载全部内容 / 清空本机内容」竖排（不再挤一行出框）', stacked.found === true && stacked.sameRow === false, JSON.stringify(stacked))

  // 中英文都要能撑住：切英文再审计一次设置页
  const en = await pc.evalJs(`(async () => {
    const nav = [...document.querySelectorAll('button')].find(b => b.getAttribute('data-tab') === 'settings')
    nav?.click(); await new Promise(r => setTimeout(r, 800))
    const enBtn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'English')
    enBtn?.click(); await new Promise(r => setTimeout(r, 1200))
    return ${AUDIT}('设置页-英文')
  })()`)
  rec('英文文案下设置页也无按钮出框', (en.bad ?? []).length === 0, JSON.stringify(en.bad ?? []).slice(0, 400))

  rec('无渲染层异常', pc.errs.length === 0, pc.errs.slice(0, 2).join(' | '))
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try { desk.kill('SIGTERM'); phone?.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(800)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  process.exit(0)
}
