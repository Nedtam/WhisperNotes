// 验证：① 按钮/输入与桌面同一套样式 ② 搜索占位文案存在且可见 ③ 长按不会选中 UI 文字（只有正文可选）
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9410
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }

const desk = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), '--remote-debugging-port=9411', '--user-data-dir=/tmp/wn-devdata'], { cwd: ROOT, env: { ...process.env } })
desk.stderr.on('data', () => {})
const phone = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'tools/tmp/mobile-shell.cjs'), `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/wn-phone'], { cwd: ROOT, env: { ...process.env } })
phone.stderr.on('data', () => {})
setTimeout(() => { console.log('❌ 超时'); try { desk.kill('SIGKILL'); phone.kill('SIGKILL') } catch {} process.exit(1) }, 200000).unref?.()

function connect(port) {
  return (async () => {
    for (let i = 0; i < 120; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const p = list.find((t) => t.type === 'page')
        if (p) {
          const ws = new WebSocket(p.webSocketDebuggerUrl)
          await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
          let id = 0; const pending = new Map(); const errors = []
          ws.addEventListener('message', (ev) => {
            const m = JSON.parse(ev.data)
            if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
            else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
          })
          const send = (method, params = {}) => new Promise((r) => { const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })) })
          return { errors, evalJs: async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value } }
        }
      } catch { /* retry */ }
      await sleep(500)
    }
    throw new Error('CDP 超时')
  })()
}

try {
  const dc = await connect(9411)
  await sleep(3500)
  // 需要至少一条笔记，才能看正文选中策略
  const seed = await dc.evalJs(`(async () => {
    const old = await window.api.cards.list({ includeSuspended: true }); for (const c of old) await window.api.cards.remove(c.id)
    for (const n of await window.api.notes.list()) if (/手机UI验证/.test(n.title)) await window.api.notes.remove(n.id)
    const note = await window.api.notes.save({ title: '手机UI验证 ' + Date.now(), noteMd: '## 标题\\n\\n正文一段，用来验证长按只能选正文。', sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
    await window.api.mobile.setEnabled(true)
    const q = await window.api.mobile.qr(); const st = await window.api.mobile.status()
    return { id: note.id, port: st.port, code: q.code }
  })()`)
  await sleep(600)

  const pc = await connect(PORT)
  await sleep(2500)
  await pc.evalJs(`(async () => { try { localStorage.clear() } catch {} location.reload(); return true })()`)
  await sleep(3000)
  await pc.evalJs(`(async () => {
    const setVal = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    const inputs = document.querySelectorAll('input')
    setVal(inputs[0], ${JSON.stringify('http://127.0.0.1:' + seed.port)})
    setVal(inputs[1], ${JSON.stringify(seed.code)})
    await new Promise(r => setTimeout(r, 300))
    const b = [...document.querySelectorAll('button')].find(x => /Connect to computer|连接电脑/.test(x.textContent)); b.click()
    await new Promise(r => setTimeout(r, 4500))
    return true
  })()`)

  // ① 控件样式与桌面一致
  const style = await pc.evalJs(`(() => {
    const cs = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el) : null }
    const btn = cs('nav button')
    const inp = cs('input.inp')
    const hasNavSvg = !!document.querySelector('nav button svg')
    const hasEmoji = /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/u.test(document.querySelector('nav')?.textContent || '')
    return { navRadius: btn?.borderRadius, navUserSelect: btn?.userSelect, inpRadius: inp?.borderRadius, hasNavSvg, hasEmoji }
  })()`)
  rec('底部导航用桌面同款 SVG 图标（无 emoji）', style.hasNavSvg && !style.hasEmoji, JSON.stringify({ hasNavSvg: style.hasNavSvg, hasEmoji: style.hasEmoji }))
  rec('输入框使用桌面 .inp 样式', style.inpRadius === '11.2px' || parseFloat(style.inpRadius) >= 10, `圆角=${style.inpRadius}`)

  // ② 搜索占位文案
  const search = await pc.evalJs(`(() => {
    const inp = [...document.querySelectorAll('input.inp')].find(i => (i.getAttribute('placeholder')||'').length > 0)
    const all = [...document.querySelectorAll('input')].map(i => ({ ph: i.getAttribute('placeholder'), cls: i.className }))
    return { found: !!inp, placeholder: inp?.getAttribute('placeholder'), color: inp ? getComputedStyle(inp).color : null, all: all.slice(0, 3) }
  })()`)
  rec('搜索框有占位文案', !!search.found && /搜索|Search/.test(search.placeholder || ''), JSON.stringify(search.placeholder))

  // ③ 长按选中：UI 不可选，正文可选
  // 先在列表页量 UI（导航/按钮），再打开笔记量正文
  const uiSel = await pc.evalJs(`(() => {
    const nav = document.querySelector('nav')
    const navBtn = nav ? getComputedStyle(nav).userSelect : null
    const anyBtn = document.querySelector('button')
    const lab = document.querySelector('.lbl')
    const panel = document.querySelector('.panel')
    return {
      navSel: navBtn,
      navBtnSel: nav?.querySelector('button') ? getComputedStyle(nav.querySelector('button')).userSelect : null,
      btnSel: anyBtn ? getComputedStyle(anyBtn).userSelect : null,
      panelRadius: panel ? getComputedStyle(panel).borderRadius : null
    }
  })()`)
  const sel = await pc.evalJs(`(async () => {
    // 打开一条笔记（正文）
    const item = [...document.querySelectorAll('li button')].find(b => /手机UI验证/.test(b.textContent || ''))
    if (item) { item.click(); await new Promise(r => setTimeout(r, 2500)) }
    const body = document.querySelector('.md-body')
    const nav = document.querySelector('nav button')
    const btn = [...document.querySelectorAll('button')].find(b => b.className.includes('btn-'))
    const cs = (el) => el ? getComputedStyle(el).userSelect : null
    return { bodySelect: cs(body), navSelect: cs(nav), btnSelect: cs(btn), hasBody: !!body, bodyText: body ? body.innerText.slice(0, 30) : null }
  })()`)
  rec('正文可选中（user-select: text）', sel.bodySelect === 'text' && sel.hasBody, JSON.stringify({ body: sel.bodySelect, text: sel.bodyText }))
  rec(
    'UI 文字不可选中（底部导航/按钮 user-select: none）',
    uiSel.navSel === 'none' && uiSel.navBtnSel === 'none' && uiSel.btnSel === 'none',
    JSON.stringify(uiSel)
  )

  rec('手机端无异常', pc.errors.length === 0, pc.errors.slice(0, 2).join(' | '))

  await dc.evalJs(`(async () => { for (const n of await window.api.notes.list()) if (/手机UI验证/.test(n.title)) await window.api.notes.remove(n.id); await window.api.mobile.setEnabled(false); return true })()`)
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try { desk.kill('SIGTERM'); phone.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(600)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) process.exit(1)
}
