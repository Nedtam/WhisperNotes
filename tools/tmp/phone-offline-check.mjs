// 手机端离线可用性 + 选择保留 + 语言 + 颜色点 验证
// 关键场景：配对下载完成后【关掉电脑端服务】，手机仍能看笔记/转写/卡片
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const DESK = 9430
const PHONE = 9431
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => {
  results.push({ n, ok })
  console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`)
}

function connect(port) {
  return (async () => {
    for (let i = 0; i < 120; i++) {
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
            send,
            evalJs: async (e) => {
              const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true })
              if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
              return r.result?.value
            },
            reload: async () => {
              await send('Page.enable')
              await send('Page.reload', { ignoreCache: false })
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

const desk = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${DESK}`, '--user-data-dir=/tmp/wn-devdata'], { cwd: ROOT, env: { ...process.env } })
desk.stderr.on('data', () => {})
let phone = null
setTimeout(() => {
  console.log('❌ 超时')
  try {
    desk.kill('SIGKILL')
    phone?.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  process.exit(1)
}, 420000).unref?.()

try {
  const dc = await connect(DESK)
  await sleep(3500)

  // 造数据：一个笔记本 + 2 篇笔记，1 篇出卡（验证离线也能看卡片）
  const seed = await dc.evalJs(`(async () => {
    await window.api.settings.set({ llm: { ...(await window.api.settings.get()).llm, baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'fake-key', modelId: 'fake-model', autoFallback: false,
      providers: [{ id: 'fake', name: 'Fake', baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'fake-key', modelId: 'fake-model', enabled: true }], activeProviderId: 'fake' } })
    const old = await window.api.cards.list({ includeSuspended: true })
    for (const c of old) await window.api.cards.remove(c.id)
    for (const n of await window.api.notes.list()) if (/离线验证/.test(n.title)) await window.api.notes.remove(n.id)
    for (const nb of await window.api.notebooks.list()) if (/离线验证/.test(nb.name)) await window.api.notebooks.remove(nb.id)
    const nb = await window.api.notebooks.create('离线验证-课程', null)
    const mk = async (t, body) => window.api.notes.save({ title: t, noteMd: body, sourceText: '', templateId: 'study', notebookId: nb.id, durationMs: 0, tags: [] })
    const n1 = await mk('离线验证 笔记一', '## 一\\n\\n' + '这是笔记一的正文内容。'.repeat(20))
    const n2 = await mk('离线验证 笔记二', '## 二\\n\\n' + '这是笔记二的正文内容。'.repeat(20))
    await window.api.cards.generate({ noteIds: [n1.id], per1000: 20, maxPerNote: 3 })
    await window.api.mobile.setEnabled(true)
    const q = await window.api.mobile.qr()
    const st = await window.api.mobile.status()
    await new Promise(r => setTimeout(r, 3000))
    const cs = await window.api.cards.list({})
    return { nb: nb.id, n1: n1.id, n2: n2.id, port: st.port, code: q.code, cards: cs.length }
  })()`)
  rec('准备：笔记 + 卡片 + 手机服务', seed.cards >= 2, `卡片=${seed.cards}`)

  // 手机：配对并等待全量下载
  phone = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'tools/tmp/mobile-shell.cjs'), `--remote-debugging-port=${PHONE}`], { cwd: ROOT, env: { ...process.env } })
  phone.stderr.on('data', () => {})
  const pc = await connect(PHONE)
  await sleep(2500)
  await pc.evalJs(`(async () => { try { localStorage.clear() } catch {} try { indexedDB.deleteDatabase('whispernotes') } catch {} location.reload(); return true })()`)
  await sleep(3000)
  const pairUrl = `http://127.0.0.1:${seed.port}`
  await pc.evalJs(`(async () => {
    const setVal = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    const inputs = document.querySelectorAll('input')
    setVal(inputs[0], ${JSON.stringify(pairUrl)}); setVal(inputs[1], ${JSON.stringify(seed.code)})
    await new Promise(r => setTimeout(r, 300))
    const b = [...document.querySelectorAll('button')].find(x => /Connect to computer|连接电脑/.test(x.textContent)); b.click()
    return true
  })()`)

  // 等全量下载完成（本地已存笔记正文数 == 笔记总数）
  let downloaded = null
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    downloaded = await pc.evalJs(`(async () => {
      const open = indexedDB.open('whispernotes', 1)
      const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error) })
      const keys = await new Promise((res, rej) => { const r = db.transaction('kv','readonly').objectStore('kv').getAllKeys(); r.onsuccess = () => res(r.result.map(String)); r.onerror = () => rej(r.error) })
      const st = await new Promise((res, rej) => { const r = db.transaction('kv','readonly').objectStore('kv').get('syncState'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      return { notes: keys.filter(k => k.startsWith('note/')).length, trs: keys.filter(k => k.startsWith('tr/')).length, cards: keys.includes('cards'), state: st }
    })()`)
    if (downloaded.state && downloaded.notes >= downloaded.state.notes) break
  }
  rec('配对后自动整份下载', !!downloaded?.state && downloaded.notes >= (downloaded.state?.notes ?? 0) && downloaded.notes > 0, JSON.stringify(downloaded))

  // 关键：关掉电脑端服务，模拟"电脑没开/没 Wi-Fi"
  await dc.evalJs(`(async () => await window.api.mobile.setEnabled(false))()`)
  await sleep(1000)
  await pc.reload()
  await sleep(4000)

  const offline = await pc.evalJs(`(async () => {
    const txt = document.body.innerText
    const items = [...document.querySelectorAll('li button')].filter(b => /离线验证/.test(b.textContent||'')).length
    // 打开一篇笔记（应从本地库秒开）
    const first = [...document.querySelectorAll('li button')].find(b => /离线验证 笔记一/.test(b.textContent||''))
    let bodyLen = 0
    if (first) { first.click(); await new Promise(r => setTimeout(r, 1500)); bodyLen = (document.querySelector('.md-body')?.innerText || '').length }
    const back = [...document.querySelectorAll('button')].find(b => /返回|Back/.test(b.textContent))
    if (back) { back.click(); await new Promise(r => setTimeout(r, 800)) }
    // 转写页
    const trTab = [...document.querySelectorAll('button')].find(b => b.getAttribute('data-tab') === 'transcripts')
    if (trTab) { trTab.click(); await new Promise(r => setTimeout(r, 1200)) }
    const trItems = [...document.querySelectorAll('li button')].length
    // 闪卡页
    const cTab = [...document.querySelectorAll('button')].find(b => b.getAttribute('data-tab') === 'cards')
    if (cTab) { cTab.click(); await new Promise(r => setTimeout(r, 1500)) }
    const cardItems = [...document.querySelectorAll('li')].length
    return { items, bodyLen, trItems, cardItems, offlineBadge: /离线|Offline/.test(txt) }
  })()`)
  rec('离线仍能看到笔记列表', offline.items > 0, `条目=${offline.items}`)
  rec('离线能打开笔记正文', offline.bodyLen > 100, `正文字符=${offline.bodyLen}`)
  rec('离线能看到转写与卡片', offline.trItems > 0 && offline.cardItems > 0, `转写=${offline.trItems} 卡片区=${offline.cardItems}`)

  // 选择保留：在笔记页选一个笔记本 → 进详情 → 返回 → 选择还在；切页签回来也在
  const keep = await pc.evalJs(`(async () => {
    const nTab = [...document.querySelectorAll('button')].find(b => b.getAttribute('data-tab') === 'notes')
    nTab.click(); await new Promise(r => setTimeout(r, 900))
    const chip = [...document.querySelectorAll('button')].find(b => /离线验证-课程/.test(b.textContent || ''))
    if (chip) { chip.click(); await new Promise(r => setTimeout(r, 700)) }
    const activeAfterPick = [...document.querySelectorAll('button')].some(b => /离线验证-课程/.test(b.textContent||'') && b.className.includes('bg-accent'))
    const first = [...document.querySelectorAll('li button')].find(b => /离线验证/.test(b.textContent||''))
    if (first) { first.click(); await new Promise(r => setTimeout(r, 1200)) }
    const back = [...document.querySelectorAll('button')].find(b => /返回|Back/.test(b.textContent))
    if (back) { back.click(); await new Promise(r => setTimeout(r, 900)) }
    const stillActive = [...document.querySelectorAll('button')].some(b => /离线验证-课程/.test(b.textContent||'') && b.className.includes('bg-accent'))
    // 切到闪卡再切回笔记
    const cTab = [...document.querySelectorAll('button')].find(b => b.getAttribute('data-tab') === 'cards'); cTab.click(); await new Promise(r => setTimeout(r, 900))
    const nTab2 = [...document.querySelectorAll('button')].find(b => b.getAttribute('data-tab') === 'notes'); nTab2.click(); await new Promise(r => setTimeout(r, 900))
    const afterTabSwitch = [...document.querySelectorAll('button')].some(b => /离线验证-课程/.test(b.textContent||'') && b.className.includes('bg-accent'))
    const listCount = [...document.querySelectorAll('li button')].filter(b => /离线验证/.test(b.textContent||'')).length
    return { activeAfterPick, stillActive, afterTabSwitch, listCount }
  })()`)
  rec('选中笔记本后列表按它过滤', keep.listCount === 2, `条目=${keep.listCount}`)
  rec('进详情返回后选择仍在', keep.activeAfterPick && keep.stillActive, JSON.stringify({ pick: keep.activeAfterPick, back: keep.stillActive }))
  rec('切换页签返回后选择仍在', keep.afterTabSwitch === true)

  // 语言设置：切到 English → 界面变英文；重载后仍生效
  const lang = await pc.evalJs(`(async () => {
    const sTab = [...document.querySelectorAll('button')].find(b => b.getAttribute('data-tab') === 'settings'); sTab.click(); await new Promise(r => setTimeout(r, 1000))
    const zh = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '中文')
    if (zh) { zh.click(); await new Promise(r => setTimeout(r, 1000)) }
    const txt = document.body.innerText
    return { switched: !!zh, chinese: /界面语言|离线可用|下载全部内容/.test(txt) }
  })()`)
  await pc.reload()
  await sleep(4500)
  const langAfter = await pc.evalJs(`(() => {
    const t = document.body.innerText
    const stored = localStorage.getItem('CapacitorStorage.wn.lang')
    return { chinese: /全部|未归档|笔记库/.test(t), stored, sample: t.slice(0, 40) }
  })()`)
  rec('语言设置生效（切成中文）', lang.switched && lang.chinese === true, JSON.stringify(lang))
  rec('语言选择重载后保留', langAfter.stored === '"zh"' || langAfter.stored === 'zh' || langAfter.chinese === true, JSON.stringify(langAfter))

  // 颜色点：笔记列表/笔记本 chip/闪卡范围都要有
  const dots = await pc.evalJs(`(async () => {
    const nTab = [...document.querySelectorAll('button')].find(b => b.getAttribute('data-tab') === 'notes'); nTab.click(); await new Promise(r => setTimeout(r, 1000))
    const isDot = (s) => {
      const st = getComputedStyle(s)
      const w = parseFloat(st.width)
      return w >= 5 && w <= 14 && parseFloat(st.height) >= 5 && parseFloat(st.height) <= 14 && st.backgroundColor !== 'rgba(0, 0, 0, 0)'
    }
    const dotEls = [...document.querySelectorAll('span')].filter(isDot)
    const colors = dotEls.map(s => getComputedStyle(s).backgroundColor).slice(0, 3)
    const cTab = [...document.querySelectorAll('button')].find(b => b.getAttribute('data-tab') === 'cards'); cTab.click(); await new Promise(r => setTimeout(r, 1200))
    const scopeBtn = [...document.querySelectorAll('button')].find(b => /Scope|分类范围/.test(b.textContent||''))
    if (scopeBtn) { scopeBtn.click(); await new Promise(r => setTimeout(r, 900)) }
    const dotEls2 = [...document.querySelectorAll('span')].filter(isDot)
    return { notesDots: colors, cardsDots: dotEls2.length }
  })()`)
  rec('笔记/笔记本有颜色点', dots.notesDots.length > 0, JSON.stringify(dots.notesDots))
  rec('闪卡分类里也有颜色点', dots.cardsDots > 0, `点数=${dots.cardsDots}`)

  rec('手机端无异常', pc.errors.length === 0, pc.errors.slice(0, 2).join(' | '))

  // 清理
  await dc.evalJs(`(async () => {
    const l = await window.api.cards.list({ includeSuspended: true }); for (const c of l) await window.api.cards.remove(c.id)
    for (const n of await window.api.notes.list()) if (/离线验证/.test(n.title)) await window.api.notes.remove(n.id)
    for (const nb of await window.api.notebooks.list()) if (/离线验证/.test(nb.name)) await window.api.notebooks.remove(nb.id)
    return true
  })()`)
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try {
    desk.kill('SIGTERM')
    phone?.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  await sleep(700)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) process.exit(1)
}
