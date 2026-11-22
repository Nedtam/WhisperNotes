// 复现并验证「合并失败 / 不完整笔记」的修复：
//  ① 假上游流式返回（带 reasoning 增量），并按 max_tokens 模拟"预算被思考吃光 → 空回复 + finish=length"
//  ② 统一润色请求故意返回"内容被砍掉一半"的短结果 → 必须回退到完整拼接版（内容不得丢失）
//  ③ 统一润色请求直接失败 → 采保证不整篇失败
// 关键断言：任何情况下都产出一篇完整笔记、内容齐全、没有 ⚠ 警告横幅、请求数 < 50
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

// ── 假上游 ───────────────────────────────────────────────
let mode = 'reasoning-starved' // reasoning-starved | unify-fails | normal
// 模拟"这个模型每次要先用掉 20k token 思考"：预算 ≤ 20k 时正文为空、finish=length
const REASONING_NEED = 20000
let calls = [] // 每次请求的记录
let partNo = 0 // 成功产出正文的分块计数（失败重试不占号）
const SYSTEM_RE = /FINAL single coherent note|Merge these notes/i
const srv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    let payload = {}
    try { payload = JSON.parse(body) } catch { /* ignore */ }
    const maxTokens = payload.max_tokens ?? null
    const isUnify = (payload.messages ?? []).some((m) => m.role === 'system' && SYSTEM_RE.test(m.content || ''))
    const userChars = (payload.messages ?? []).reduce((n, m) => n + (m.content || '').length, 0)
    calls.push({ isUnify, maxTokens, userChars })
    const stream = payload.stream === true

    // 模拟推理模型：固定"思考"预算；预算不够 → 正文为空 + finish_reason=length
    const reasoning = REASONING_NEED
    const wantEmpty = mode === 'reasoning-starved' && maxTokens !== null && maxTokens <= reasoning
    if (mode === 'unify-fails' && isUnify) {
      calls[calls.length - 1].failed = true
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'mock 400 (unify)' } }))
      return
    }
    let content = ''
    if (!wantEmpty) {
      if (isUnify) {
        // 统一润色：故意只回一半（模拟"合并把内容吃了"）+ 稍微改写
        content = `# 合并后的笔记\n\n- 这是被压缩过的版本。\n- 只有少量内容。\n`
      } else {
        partNo += 1
        const n = partNo
        content = `# 第 ${n} 段\n\n## 概念\n\n- 第 ${n} 段的核心概念与定义说明。\n- 第 ${n} 段的关键数字：${n * 100}。\n\n## Key takeaways\n\n- 第 ${n} 段要点甲\n- 第 ${n} 段要点乙\n`
      }
    }
    if (!stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content }, finish_reason: wantEmpty ? 'length' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: reasoning + 200, completion_tokens_details: { reasoning_tokens: reasoning } }
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
    // 先送几段 reasoning 增量（模拟慢思考：每段间隔一小会儿）
    for (let i = 0; i < 3; i++) {
      send({ choices: [{ delta: { reasoning: '想' } }] })
      await sleep(60)
    }
    if (content) {
      for (const piece of content.match(/[\s\S]{1,40}/g) ?? []) {
        send({ choices: [{ delta: { content: piece } }] })
        await sleep(4)
      }
    }
    send({ choices: [{ delta: {}, finish_reason: wantEmpty ? 'length' : 'stop' }] })
    send({ usage: { prompt_tokens: 100, completion_tokens: reasoning + 200, completion_tokens_details: { reasoning_tokens: reasoning } } })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((r) => srv.listen(8803, '127.0.0.1', r))

function conn(port) {
  return (async () => {
    for (let i = 0; i < 120; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const p = l.find((t) => t.type === 'page')
        if (p) {
          const ws = new WebSocket(p.webSocketDebuggerUrl)
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

// 造一段 20k 字转写（约 2 块，够触发拼接 + 统一）
const TEXT = Array.from({ length: 420 }, (_, i) => `第${i}句：课堂上讲了概念${i}的定义、推导与例子，老师说这个很重要。`).join('')

// 每轮从干净档案跑：断点缓存会跨轮残留（否则第一轮就全复用，测不出失败场景）
fs.rmSync('/tmp/wn-orgfix', { recursive: true, force: true })
const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), '--remote-debugging-port=9524', '--user-data-dir=/tmp/wn-orgfix'], { cwd: ROOT })
child.stderr.on('data', () => {})
setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } process.exit(1) }, 420000).unref?.()

try {
  const dc = await conn(9524)
  await sleep(4000)
  const setup = await dc.evalJs(`(async () => {
    const s = await window.api.settings.get()
    const next = await window.api.settings.set({ llm: { ...s.llm, baseUrl: 'http://127.0.0.1:8803/v1', apiKey: 'fake-key', modelId: 'fake-model', maxChunkChars: 13000, maxOutputTokens: 32768, fallbackModels: [], autoFallback: false,
      providers: [{ id: 'f', name: 'Fake', baseUrl: 'http://127.0.0.1:8803/v1', apiKey: 'fake-key', modelId: 'fake-model', enabled: true }], activeProviderId: 'f' } })
    window.__wnStore.getState().setSettings(next)
    const before = (await window.api.notes.list()).length
    return { before }
  })()`)
  rec('准备：假上游（流式 + 推理预算）已接上', typeof setup.before === 'number', `基线 notes=${setup.before}`)

  // ── 场景 A：预算会被思考吃光 → 阶梯必须"放大预算"重试而不是缩小 ──
  mode = 'reasoning-starved'
  calls = []
  partNo = 0
  const doneA = await dc.evalJs(`(async () => {
    window.__d = null
    window.api.onOrganizeDone((d) => { window.__d = d })
    const r = await window.api.llm.organizeStart({ title: '预算被吃光测试', sourceText: ${JSON.stringify(TEXT)}, transcriptId: undefined })
    const t0 = Date.now()
    while (!window.__d && Date.now() - t0 < 240000) await new Promise(r2 => setTimeout(r2, 500))
    const notes = await window.api.notes.list()
    const mine = notes.filter(n => n.title === '预算被吃光测试')
    return { jobId: r.jobId, degraded: window.__d?.degraded, failedParts: window.__d?.failedParts, incomplete: window.__d?.incomplete, note: mine[0]?.noteMd || null, requests: window.__d?.requests, chunks: window.__d?.chunks }
  })()`)
  const jobs = calls.length
  rec(
    '统一润色把内容写少了 → 自动回退到完整拼接版（无 ⚠ 横幅、没采用被压缩版）',
    !!doneA.note && !/⚠/.test(doneA.note) && !/被压缩过的版本/.test(doneA.note),
    `noteChars=${doneA.note?.length ?? 0}`
  )
  rec(
    '拼接版内容零丢失（每段的概念/数字都在）',
    !!doneA.note && [1, 2].every((i) => doneA.note.includes(`第 ${i} 段的核心概念`) && doneA.note.includes(`第 ${i} 段的关键数字`)),
    `段落数=${doneA.chunks}`
  )
  rec('未完成标记未被误触发（failedParts=0 / incomplete=false）', doneA.failedParts === 0 && doneA.incomplete !== true, JSON.stringify({ fp: doneA.failedParts, inc: doneA.incomplete }))
  const grew = calls.some((c) => c.maxTokens === null || c.maxTokens > 12000)
  const shrankOnly = calls.every((c) => c.maxTokens === null || c.maxTokens <= 12000)
  rec('预算被推理吃光时改用"更大/不限"预算重试（而不是越试越小）', grew === true, `请求预算=${JSON.stringify(calls.map((c) => c.maxTokens))}`)
  rec('没有出现"只缩小预算"的死循环', !shrankOnly || grew === true, '')
  rec('总请求数远低于 50', jobs < 50, `本次 ${jobs} 次请求`)

  // ── 场景 B：统一润色请求直接失败（模拟上游 400/超时）→ 仍必须出完整笔记 ──
  mode = 'unify-fails'
  calls = []
  partNo = 0
  await dc.evalJs(`(async () => { await window.api.notes.remove((await window.api.notes.list()).find(n => n.title === '预算被吃光测试').id); return true })()`)
  const doneB = await dc.evalJs(`(async () => {
    window.__d2 = null
    window.api.onOrganizeDone((d) => { window.__d2 = d })
    await window.api.llm.organizeStart({ title: '统一失败测试', sourceText: ${JSON.stringify(TEXT)} })
    const t0 = Date.now()
    while (!window.__d2 && Date.now() - t0 < 240000) await new Promise(r2 => setTimeout(r2, 500))
    const notes = await window.api.notes.list()
    const mine = notes.find(n => n.title === '统一失败测试')
    return { note: mine?.noteMd || null, incomplete: window.__d2?.incomplete, failedParts: window.__d2?.failedParts, jobs: window.__d2?.requests }
  })()`)
  rec('统一润色彻底失败时整篇不失败（仍有完整笔记）', !!doneB.note && doneB.note.length > 100, `noteChars=${doneB.note?.length ?? 0}`)
  rec('内容仍然齐全（每段都在）', !!doneB.note && [1, 2].every((i) => doneB.note.includes(`第 ${i} 段的核心概念`)), '')
  rec('没写成"未完成"（用户不该看到黄框）', doneB.incomplete !== true && doneB.failedParts === 0, JSON.stringify({ inc: doneB.incomplete, fp: doneB.failedParts }))
  rec('统一失败时没有把整单标成未完成（拼接版就是完整笔记）', doneB.incomplete !== true, JSON.stringify({ inc: doneB.incomplete, fp: doneB.failedParts, jobs: calls.length }))
  rec('统一请求失败时总请求数依然 < 50', calls.length < 50, `${calls.length} 次`)

  rec('无渲染层异常', dc.errs.length === 0, dc.errs.slice(0, 2).join(' | '))
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  try { srv.close() } catch { /* ignore */ }
  await sleep(700)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  process.exit(0)
}
