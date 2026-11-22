// 阶段 5 验证：手机端闪卡复习（在线 + 离线队列补传）+ 与电脑端 SM-2 一致
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const DESK_PORT = 9372
const PHONE_PORT = 9373
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
            send,
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

const desk = spawn(
  path.join(ROOT, 'node_modules/.bin/electron'),
  [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${DESK_PORT}`, '--user-data-dir=/tmp/wn-devdata'],
  { cwd: ROOT, env: { ...process.env } }
)
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
}, 300000).unref?.()

try {
  const dc = await connect(DESK_PORT)
  await sleep(3500)

  // 0) 准备：清空卡片，造笔记并出 3 张卡（假模型）
  const prep = await dc.evalJs(`(async () => {
    // 确保出卡走本地假模型（其它套件可能改过渠道，这里显式设置，保证顺序无关）
    await window.api.settings.set({ llm: { ...(await window.api.settings.get()).llm, baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'fake-key', modelId: 'fake-model', autoFallback: false,
      providers: [{ id: 'fake', name: 'Fake', baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'fake-key', modelId: 'fake-model', enabled: true }], activeProviderId: 'fake' } })
    const old = await window.api.cards.list({ includeSuspended: true })
    for (const c of old) await window.api.cards.remove(c.id)
    const note = await window.api.notes.save({ title: '手机闪卡验证 ' + Date.now(), noteMd: '## 采样\\n\\n采样率决定频率上限。\\n\\nVAD 用于切分语音与静音。', sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: ['闪卡'] })
    const g = await window.api.cards.generate({ noteId: note.id, per1000: 20, maxPerNote: 3 })
    await window.api.mobile.setEnabled(true)
    const q = await window.api.mobile.qr()
    const st = await window.api.mobile.status()
    return { noteId: note.id, jobId: g.jobId, port: st.port, code: q.code }
  })()`)
  // 等卡片生成
  let total = 0
  for (let i = 0; i < 30; i++) {
    await sleep(600)
    total = await dc.evalJs(`(async () => (await window.api.cards.stats()).total)()`)
    if (total >= 2) break
  }
  rec('准备：出卡完成 + 手机服务已开', total >= 2 && !!prep.port, `卡片=${total} port=${prep.port}`)

  // 1) 手机端连接
  phone = spawn(
    path.join(ROOT, 'node_modules/.bin/electron'),
    [path.join(ROOT, 'tools/tmp/mobile-shell.cjs'), `--remote-debugging-port=${PHONE_PORT}`, '--user-data-dir=/tmp/wn-phone'],
    { cwd: ROOT, env: { ...process.env } }
  )
  phone.stderr.on('data', () => {})
  const pc = await connect(PHONE_PORT)
  await sleep(2500)
  await pc.evalJs(`(async () => { try { localStorage.clear() } catch {} try { indexedDB.deleteDatabase('whispernotes') } catch {} location.reload(); return true })()`)
  await sleep(3000)
  const pairUrl = `http://127.0.0.1:${prep.port}`
  const paired = await pc.evalJs(`(async () => {
    const setVal = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    const inputs = document.querySelectorAll('input')
    setVal(inputs[0], ${JSON.stringify(pairUrl)})
    setVal(inputs[1], ${JSON.stringify(prep.code)})
    await new Promise(r => setTimeout(r, 300))
    const btn = [...document.querySelectorAll('button')].find(b => /Connect to computer|连接电脑/.test(b.textContent))
    btn.click()
    await new Promise(r => setTimeout(r, 4000))
    return { ok: /Transcriptions|Notes|转写记录/.test(document.body.innerText) }
  })()`)
  rec('手机端配对成功', paired.ok === true, JSON.stringify(paired))

  // 2) 切到闪卡页
  const fc = await pc.evalJs(`(async () => {
    const nav = [...document.querySelectorAll('button')].find(b => b.getAttribute('data-tab') === 'cards')
    if (!nav) return { error: 'no-cards-tab', text: document.body.innerText.slice(0, 120) }
    nav.click()
    await new Promise(r => setTimeout(r, 2500))
    const txt = document.body.innerText
    return { due: /Due today|今日待复习/.test(txt), start: /Start review|开始复习/.test(txt), items: document.querySelectorAll('li').length }
  })()`)
  rec('手机端闪卡页渲染', fc.due && fc.start && fc.items > 0, JSON.stringify(fc))

  // 3) 在线复习 2 张
  const reviewOnline = await pc.evalJs(`(async () => {
    const start = [...document.querySelectorAll('button')].find(b => /Start review|开始复习/.test(b.textContent))
    start.click()
    await new Promise(r => setTimeout(r, 900))
    const done = []
    for (let i = 0; i < 2; i++) {
      const show = [...document.querySelectorAll('button')].find(b => /Show answer|显示答案/.test(b.textContent))
      if (!show) break
      show.click()
      await new Promise(r => setTimeout(r, 500))
      const good = [...document.querySelectorAll('button')].find(b => /^(Good|记得)$/.test((b.textContent||'').trim()))
      good.click()
      await new Promise(r => setTimeout(r, 900))
      done.push(1)
    }
    const exit = [...document.querySelectorAll('button')].find(b => /End review|结束复习/.test(b.textContent))
    if (exit) { exit.click(); await new Promise(r => setTimeout(r, 800)) }
    return { reviewed: done.length, text: document.body.innerText.slice(0, 120) }
  })()`)
  rec('手机端在线复习 2 张', reviewOnline.reviewed === 2, JSON.stringify(reviewOnline.reviewed))
  await sleep(1500)
  const st1 = await dc.evalJs(`(async () => await window.api.cards.stats())()`)
  rec('电脑端统计已收到在线复习', st1.reviewedToday >= 2, `今日已复习=${st1.reviewedToday}`)
  const sch = await dc.evalJs(`(async () => { const l = await window.api.cards.list({}); const c = l.find(x => (x.reps||0) > 0); return c ? { reps: c.reps, interval: c.intervalDays } : null })()`)
  rec('SM-2 已写回（good 首次 = 1 天）', !!sch && sch.reps === 1 && sch.interval === 1, JSON.stringify(sch))

  // 4) 离线复习：关掉电脑端服务 → 手机再复习 1 张 → 应进队列且电脑端不变
  await dc.evalJs(`(async () => await window.api.mobile.setEnabled(false))()`)
  await sleep(800)
  const offline = await pc.evalJs(`(async () => {
    const start = [...document.querySelectorAll('button')].find(b => /Start review|开始复习/.test(b.textContent))
    start.click()
    await new Promise(r => setTimeout(r, 900))
    const show = [...document.querySelectorAll('button')].find(b => /Show answer|显示答案/.test(b.textContent))
    show.click(); await new Promise(r => setTimeout(r, 400))
    const hard = [...document.querySelectorAll('button')].find(b => /^(Hard|有点难)$/.test((b.textContent||'').trim()))
    hard.click(); await new Promise(r => setTimeout(r, 1200))
    const exit = [...document.querySelectorAll('button')].find(b => /End review|结束复习/.test(b.textContent))
    if (exit) { exit.click(); await new Promise(r => setTimeout(r, 700)) }
    const txt = document.body.innerText
    const q = JSON.parse(localStorage.getItem('CapacitorStorage.wn.reviews') || localStorage.getItem('wn.reviews') || '[]')
    return { queued: q.length, showsPending: /waiting to sync|待同步/.test(txt) }
  })()`)
  rec('离线复习进入本地队列', offline.queued >= 1, JSON.stringify(offline))
  const st2 = await dc.evalJs(`(async () => await window.api.cards.stats())()`)
  rec('离线期间电脑端未变', st2.reviewedToday === st1.reviewedToday, `电脑端今日=${st2.reviewedToday}（离线前 ${st1.reviewedToday}）`)

  // 5) 恢复联网 → 手机自动补传
  await dc.evalJs(`(async () => await window.api.mobile.setEnabled(true))()`)
  await pc.evalJs(`location.reload()`)
  await sleep(5000)
  let st3 = st1
  for (let i = 0; i < 12; i++) {
    await sleep(800)
    st3 = await dc.evalJs(`(async () => await window.api.cards.stats())()`)
    if (st3.reviewedToday > st2.reviewedToday) break
  }
  rec('恢复联网后自动补传', st3.reviewedToday > st2.reviewedToday, `电脑端今日=${st2.reviewedToday} → ${st3.reviewedToday}`)
  const queueLeft = await pc.evalJs(`(() => { const k = Object.keys(localStorage).find(x => x.includes('wn.reviews')); return k ? JSON.parse(localStorage.getItem(k) || '[]').length : 0 })()`)
  rec('队列已清空', queueLeft === 0, `剩余=${queueLeft}`)

  rec('手机端无异常', pc.errors.length === 0, pc.errors.slice(0, 2).join(' | '))

  // 清理
  await dc.evalJs(`(async () => {
    const l = await window.api.cards.list({ includeSuspended: true })
    for (const c of l) await window.api.cards.remove(c.id)
    await window.api.notes.remove(${JSON.stringify(prep.noteId)})
    await window.api.mobile.setEnabled(false)
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
  await sleep(800)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) process.exit(1)
}
