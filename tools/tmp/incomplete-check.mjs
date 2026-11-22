// 验证两件事：
// ① 「不完整的笔记」绝不进笔记库：整理有段落失败 → 不写笔记、转写标记未完成、转写页出现黄框 + 「继续转成笔记」
//    → 上游恢复后点「继续转成笔记」可正常建成笔记（黄框消失、状态回填 ok）
// ② 笔记页顺序稳定：按"转成笔记的顺序"（ord）排，切来切去不变
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as http from 'node:http'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => {
  results.push({ n, ok })
  console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`)
}

// ── 可切换的假上游：fail=true 时对所有请求返回 400（模拟上游拒绝）────────────
let fail = true
const NOTE_MD = '# 测试笔记\n\n## 一、要点\n\n- 这是上游恢复后成功生成的笔记。\n\n## 二、结论\n\n- 内容完整。'
const srv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (fail) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'mock upstream 400', type: 'invalid_request_error' } }))
      return
    }
    const payload = {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: NOTE_MD }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20 }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  })
})
await new Promise((r) => srv.listen(8802, '127.0.0.1', r))

function conn(port) {
  return (async () => {
    for (let i = 0; i < 120; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const p = l.find((t) => t.type === 'page')
        if (p) {
          const ws = new WebSocket(p.webSocketDebuggerUrl)
          await new Promise((r, j) => {
            ws.addEventListener('open', r)
            ws.addEventListener('error', j)
          })
          let id = 0
          const pend = new Map()
          const errs = []
          ws.addEventListener('message', (ev) => {
            const m = JSON.parse(ev.data)
            if (m.id && pend.has(m.id)) {
              pend.get(m.id)(m.result)
              pend.delete(m.id)
            } else if (m.method === 'Runtime.exceptionThrown') {
              errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
            }
          })
          const send = (method, params = {}) =>
            new Promise((r) => {
              const i2 = ++id
              pend.set(i2, r)
              ws.send(JSON.stringify({ id: i2, method, params }))
            })
          return {
            errs,
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
    throw new Error('cdp 连接失败')
  })()
}

const LONG = Array.from({ length: 14 }, (_, i) => `第${i + 1}段：这是课堂上讲的内容，涉及概念、定义与推导过程。`).join('')
// 每轮从干净档案跑：断点缓存会跨轮残留（否则第一轮就全复用，测不出失败场景）
fs.rmSync('/tmp/wn-incomplete', { recursive: true, force: true })
const child = spawn(
  path.join(ROOT, 'node_modules/.bin/electron'),
  [path.join(ROOT, 'out/main/index.js'), '--remote-debugging-port=9522', '--user-data-dir=/tmp/wn-incomplete'],
  { cwd: ROOT }
)
child.stderr.on('data', () => {})
setTimeout(() => {
  try {
    child.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  process.exit(1)
}, 420000).unref?.()

try {
  const dc = await conn(9522)
  await sleep(4000)

  // 准备：把 LLM 指到本地假上游（无备用模型/渠道）
  const setup = await dc.evalJs(`(async () => {
    const s = await window.api.settings.get()
    const next = await window.api.settings.set({ llm: { ...s.llm, baseUrl: 'http://127.0.0.1:8802/v1', apiKey: 'fake-key', modelId: 'mock-model', providers: [{ id: 'default', name: 'Mock', baseUrl: 'http://127.0.0.1:8802/v1', apiKey: 'fake-key', modelId: 'mock-model', fallbackModels: [], enabled: true }], activeProviderId: 'default', fallbackModels: [], autoFallback: false, maxOutputTokens: 8192, maxChunkChars: 24000 } })
    window.__wnStore.getState().setSettings(next)
    const rec = await window.api.transcriptions.save({ source: 'import', title: '不完整测试', sourceName: 'inc-test.txt', rawText: ${JSON.stringify(LONG)}, durationMs: 60000 })
    const before = (await window.api.notes.list()).length
    const st = window.__wnStore.getState(); st.setTab('transcripts'); await new Promise(r => setTimeout(r, 900))
    return { id: rec.id, before }
  })()`)
  const tid = setup.id
  const base = setup.before
  rec('准备完成（转写已建立 / 笔记库基线）', !!tid && typeof base === 'number', `基线 notes=${base}`)

  // ── ① 上游 400：走界面点「整理」────────────────────────────
  const clicked = await dc.evalJs(`(async () => {
    document.querySelector('[data-trans-row="${tid}"]')?.click()
    await new Promise(r => setTimeout(r, 900))
    const btn = document.querySelector('[data-trans-organize="1"]')
    if (!btn) return { ok: false, why: 'no-organize-button' }
    btn.click()
    await new Promise(r => setTimeout(r, 600))
    const run = document.querySelector('[data-org-run="1"]')
    if (!run) return { ok: false, why: 'no-dialog-run' }
    run.click()
    return { ok: true }
  })()`)
  rec('转写页可发起整理（弹窗 → 运行）', clicked.ok === true, JSON.stringify(clicked))

  // 等整理收尾（400 会走完整降级阶梯，最后附原文并标记未完成）
  let status = null
  for (let i = 0; i < 360; i++) {
    await sleep(1000)
    status = await dc.evalJs(`(async () => { const r = await window.api.transcriptions.get('${tid}'); return r ? { s: r.noteStatus, e: r.noteError } : null })()`)
    if (status && status.s === 'incomplete') break
    const st = await dc.evalJs(`window.__wnStore.getState().orgJobs.map(j => j.status).join(',')`)
    if (st && st.includes('done') && (!status || status.s === 'none')) {
      // 出错了但没标记 → 再等一轮，避免误判
    }
  }
  rec('整理失败 → 转写被标记「未完成」（带原因）', status?.s === 'incomplete' && !!status?.e, JSON.stringify(status))

  const after = await dc.evalJs(`(async () => {
    const notes = await window.api.notes.list()
    const st = window.__wnStore.getState()
    return { n: notes.length, titles: notes.map(x => x.title), toastKind: st.toast?.kind || null, hist: st.orgHistory.slice(0,2).map(h => h.status) }
  })()`)
  rec('未完成的笔记没有写进笔记库', after.n === base, `notes=${after.n}（基线 ${base}）`)
  rec('黄色警告提示（warn 而不是 err）', after.toastKind === 'warn', `toast.kind=${after.toastKind}`)
  rec('整理历史记为 incomplete', after.hist.includes('incomplete'), JSON.stringify(after.hist))

  const ui = await dc.evalJs(`(async () => {
    const st = window.__wnStore.getState(); st.setTab('capture'); await new Promise(r=>setTimeout(r,300)); st.setTab('transcripts'); await new Promise(r=>setTimeout(r,800))
    document.querySelector('[data-trans-row="${tid}"]')?.click()
    await new Promise(r => setTimeout(r, 1000))
    const row = document.querySelector('[data-trans-row="${tid}"]')
    const warn = document.querySelector('[data-trans-warn="incomplete"]')
    const cont = document.querySelector('[data-trans-continue="1"]')
    const badge = document.querySelector('[data-trans-badge="incomplete"]')
    return {
      rowAmber: !!row && /amber-500\\/60/.test(row.className),
      rowStatus: row?.getAttribute('data-note-status'),
      hasWarn: !!warn,
      warnText: warn ? warn.innerText.slice(0, 60) : '',
      hasContinue: !!cont,
      contText: cont ? cont.innerText.trim() : '',
      hasBadge: !!badge
    }
  })()`)
  rec('列表行显示黄色框（不是普通边框）', ui.rowAmber === true && ui.rowStatus === 'incomplete', JSON.stringify({ amber: ui.rowAmber, st: ui.rowStatus }))
  rec('列表行有「未完成转笔记」黄色徽标', ui.hasBadge === true)
  rec('详情页有黄色警告条', ui.hasWarn === true, ui.warnText)
  rec('黄色警告条带「继续转成笔记」按钮', ui.hasContinue === true && ui.contText.length > 0, ui.contText)

  // ── ② 上游恢复 → 点「继续转成笔记」→ 正常入库 ────────────────
  fail = false
  const contClicked = await dc.evalJs(`(async () => {
    const b = document.querySelector('[data-trans-continue="1"]')
    if (!b) return false
    b.click()
    await new Promise(r => setTimeout(r, 700))
    const run = document.querySelector('[data-org-run="1"]')
    if (!run) return false
    run.click()
    return true
  })()`)
  rec('可点「继续转成笔记」重新整理', contClicked === true)

  let okStatus = null
  for (let i = 0; i < 300; i++) {
    await sleep(1000)
    okStatus = await dc.evalJs(`(async () => { const r = await window.api.transcriptions.get('${tid}'); return r ? { s: r.noteStatus, id: r.noteId } : null })()`)
    if (okStatus && okStatus.s === 'ok') break
  }
  const done = await dc.evalJs(`(async () => {
    const notes = await window.api.notes.list()
    const st = window.__wnStore.getState(); st.setTab('capture'); await new Promise(r=>setTimeout(r,300)); st.setTab('transcripts'); await new Promise(r=>setTimeout(r,900))
    document.querySelector('[data-trans-row="${tid}"]')?.click()
    await new Promise(r => setTimeout(r, 1000))
    const row = document.querySelector('[data-trans-row="${tid}"]')
    return { n: notes.length, titles: notes.map(x => x.title), warn: !!document.querySelector('[data-trans-warn="incomplete"]'), rowStatus: row?.getAttribute('data-note-status'), rowAmber: !!row && /amber-500\\/60/.test(row.className) }
  })()`)
  rec('重试成功 → 笔记入库（+1 条）', done.n === base + 1, `notes=${done.n}（基线 ${base}）`)
  rec('重试成功 → 转写状态回填 ok + noteId', okStatus?.s === 'ok' && !!okStatus?.id, JSON.stringify(okStatus))
  rec('重试成功 → 黄框与警告条自动消失', done.warn === false && done.rowStatus === 'ok' && done.rowAmber === false, JSON.stringify({ warn: done.warn, st: done.rowStatus }))

  // ── ③ 笔记页顺序稳定（按转笔记顺序，切换不变）─────────────────
  const order = await dc.evalJs(`(async () => {
    const nb = await window.api.notebooks.create('顺序测试本')
    const a = await window.api.notes.save({ title: 'A 第一条', noteMd: '# A', templateId: 'study', notebookId: nb.id })
    await new Promise(r=>setTimeout(r,30))
    const b = await window.api.notes.save({ title: 'B 第二条', noteMd: '# B', templateId: 'study', notebookId: nb.id })
    await new Promise(r=>setTimeout(r,30))
    const c = await window.api.notes.save({ title: 'C 第三条', noteMd: '# C', templateId: 'study', notebookId: nb.id })
    const st = window.__wnStore.getState()
    st.setNotes(await window.api.notes.list())
    st.setNotebooks(await window.api.notebooks.list())
    st.setTab('notes'); await new Promise(r=>setTimeout(r,600))
    // 选中该笔记本
    const rows = Array.from(document.querySelectorAll('[data-nb-row]'))
    const fresh = Array.from(document.querySelectorAll('[data-nb-row]'))
    const target = fresh.find(r => r.innerText.includes('顺序测试本'))
    if (target) { target.click(); target.querySelector('*')?.click?.() }
    await new Promise(r=>setTimeout(r,900))
    const listOrder = () => Array.from(document.querySelectorAll('[data-note-id]')).map(e => e.getAttribute('data-note-id'))
    const o1 = listOrder()
    // 依次打开三条笔记（模拟"从另一个笔记转到另一个笔记"）
    for (const id of o1.slice()) {
      document.querySelector('[data-note-id="' + id + '"]')?.click()
      await new Promise(r=>setTimeout(r,700))
    }
    const o2 = listOrder()
    // 切走再切回来
    st.setTab('transcripts'); await new Promise(r=>setTimeout(r,500)); st.setTab('notes'); await new Promise(r=>setTimeout(r,900))
    const o3 = listOrder()
    return { ids: [a.id, b.id, c.id], o1, o2, o3 }
  })()`)
  const want = [order.ids[2], order.ids[1], order.ids[0]] // 最后转的那条在最上面
  const opened = order.o1.filter((x) => order.ids.includes(x))
  rec('笔记本内顺序 = 转笔记顺序（最新在上）', JSON.stringify(opened) === JSON.stringify(want), `want=${JSON.stringify(want)} got=${JSON.stringify(opened)}`)
  rec('依次打开不同笔记后顺序不变', JSON.stringify(order.o2) === JSON.stringify(order.o1), `${JSON.stringify(order.o1)} → ${JSON.stringify(order.o2)}`)
  rec('切页返回后顺序不变', JSON.stringify(order.o3) === JSON.stringify(order.o1), `${JSON.stringify(order.o3)}`)

  rec('无渲染层异常', dc.errs.length === 0, dc.errs.slice(0, 2).join(' | '))
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  srv.close()
  await sleep(700)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  process.exit(0)
}
