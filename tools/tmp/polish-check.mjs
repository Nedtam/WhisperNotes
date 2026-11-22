// 「生成增强版」修复验证：
//  ① 上游先抖（每块第一次 400）→ 自动退避重试后仍能成功（以前直接整篇失败）
//  ② 运行中有可见进度 + 可以取消
//  ③ 成功后写进转写记录、界面切到"增强版"
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as http from 'node:http'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => {
  results.push({ n, ok })
  console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`)
}

// ── 假上游：每块第一次必定 400，之后正常；流式慢慢吐（方便验证进度/取消）──
const seen = new Map()
let requests = 0
const srv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    requests += 1
    let p = {}
    try { p = JSON.parse(body) } catch { /* ignore */ }
    const user = (p.messages ?? []).find((m) => m.role === 'user')?.content ?? ''
    const part = /Transcript part (\d+)\/(\d+)/.exec(user)
    const key = part ? part[1] : 'single'
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    if (n === 1) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Provider returned error', metadata: { raw: '{"code":400,"msg":"bad request"}', provider_name: 'MockCloud' } } }))
      return
    }
    // 返回"润色后的文本"：把原文原样回吐，足够验证链路
    const text = user.replace(/^Transcript part \d+\/\d+:\s*\n*/, '')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const piece of text.match(/[\s\S]{1,200}/g) ?? []) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
      await sleep(120)
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 50 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((r) => srv.listen(8807, '127.0.0.1', r))

function conn(port) {
  return (async () => {
    for (let i = 0; i < 120; i++) {
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
    throw new Error('cdp')
  })()
}

const RAW = Array.from({ length: 160 }, (_, i) => `Sentence ${i}: the lecturer explains sampling rate and quantization error with 44.1 kHz examples.`).join(' ')
const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), '--remote-debugging-port=9555', '--user-data-dir=/tmp/wn-polishui'], { cwd: ROOT })
child.stderr.on('data', () => {})
setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } process.exit(1) }, 420000).unref?.()

try {
  const dc = await conn(9555)
  await sleep(4500)
  const tid = await dc.evalJs(`(async () => {
    const s = await window.api.settings.get()
    const next = await window.api.settings.set({ llm: { ...s.llm, baseUrl: 'http://127.0.0.1:8807/v1', apiKey: 'k', modelId: 'mock', maxChunkChars: 4000, maxOutputTokens: 8192, fallbackModels: [], autoFallback: false, providers: [] } })
    window.__wnStore.getState().setSettings(next)
    const trs = await window.api.transcriptions.list()
    const existing = trs.find((x) => /精修测试/.test(x.title))
    const rec = existing ?? await window.api.transcriptions.save({ source: 'import', title: '精修测试', sourceName: 'polish.mp4', rawText: window.__RAW, durationMs: 60000 })
    return rec.id
  })()`.replace('window.__RAW', JSON.stringify(RAW)))
  rec('准备：转写记录就绪', typeof tid === 'string' && tid.length > 8, tid.slice(0, 8))
  const diag = await dc.evalJs(`(async () => {
    const st = window.__wnStore.getState(); st.setTab('transcripts'); await new Promise(r => setTimeout(r, 1000))
    const rows = [...document.querySelectorAll('[data-trans-row]')].map((e) => e.getAttribute('data-trans-row'))
    const row = document.querySelector('[data-trans-row="${tid}"]')
    if (row) row.click()
    await new Promise(r => setTimeout(r, 2500))
    const labels = [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 24)
    return { rows: rows.length, hasRow: !!row, labels }
  })()`)
  rec('转写列表可见且已打开详情', diag.rows > 0 && diag.hasRow === true, JSON.stringify(diag).slice(0, 400))

  // 打开转写页并选中这条
  await dc.evalJs(`(async () => {
    const st = window.__wnStore.getState(); st.setTab('transcripts'); await new Promise(r => setTimeout(r, 900))
    const row = document.querySelector('[data-trans-row="${tid}"]')
    if (row) row.click()
    await new Promise(r => setTimeout(r, 1200))
    return true
  })()`)

  // ① 运行中应能看到进度文案
  const running = await dc.evalJs(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => /增强版|enhanced version/i.test(b.textContent || ''))
    if (!btn) return { error: 'no-polish-button' }
    btn.click()
    await new Promise(r => setTimeout(r, 2500))
    const note = document.querySelector('[data-polish-note="1"]')
    const cancel = document.querySelector('[data-polish-cancel="1"]')
    return { note: note ? note.innerText.trim() : null, cancel: !!cancel }
  })()`)
  rec('点「生成增强版」后出现进度提示', !!running.note, JSON.stringify(running))
  rec('运行中提供「取消」按钮', running.cancel === true)

  // ② 取消：应该停下（不写增强版）
  const canceled = await dc.evalJs(`(async () => {
    const c = document.querySelector('[data-polish-cancel="1"]')
    if (c) c.click()
    let enabled = false
    const t0 = Date.now()
    while (Date.now() - t0 < 25000) {
      const btn = [...document.querySelectorAll('button')].find(b => /增强版|enhanced version/i.test(b.textContent || ''))
      if (btn && !btn.disabled) { enabled = true; break }
      await new Promise(r => setTimeout(r, 500))
    }
    const rec = await window.api.transcriptions.get('${tid}')
    return { enabled, enhanced: !!rec?.enhancedText, waitedMs: Date.now() - t0 }
  })()`)
  rec('取消后按钮恢复可用（收尾完成）', canceled.enabled === true, JSON.stringify(canceled))
  rec('取消后没有写入半截增强版', canceled.enhanced === false, `enhanced=${canceled.enhanced}`)

  // ③ 正常跑完：上游每块第一次 400 → 自动重试后成功
  const before = requests
  const done = await dc.evalJs(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => /增强版|enhanced version/i.test(b.textContent || ''))
    btn.click()
    const t0 = Date.now()
    while (Date.now() - t0 < 240000) {
      const rec = await window.api.transcriptions.get('${tid}')
      if (rec?.enhancedText) return { ok: true, len: rec.enhancedText.length, ms: Date.now() - t0 }
      await new Promise(r => setTimeout(r, 1000))
    }
    return { ok: false }
  })()`)
  rec('上游抖动（每块首次 400）也能成功生成增强版', done.ok === true, JSON.stringify(done))
  rec('增强版长度接近原文（没被截断）', done.ok && done.len > RAW.length * 0.8, `${done.len ?? 0} vs 原文 ${RAW.length}`)
  rec('确认发生过重试（说明 400 被兜住了）', requests - before > 3, `本轮请求 ${requests - before} 次`)
  const uiMode = await dc.evalJs(`(async () => {
    const txt = document.body.innerText
    const rec = await window.api.transcriptions.get('${tid}')
    return { hasEnhanced: !!rec?.enhancedText, tab: /增强版|Enhanced/.test(txt) }
  })()`)
  rec('界面显示增强版（可切换）', uiMode.hasEnhanced === true && uiMode.tab === true, JSON.stringify(uiMode))
  rec('无渲染层异常', dc.errs.length === 0, dc.errs.slice(0, 2).join(' | '))
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  srv.close()
  await sleep(700)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  process.exit(0)
}
