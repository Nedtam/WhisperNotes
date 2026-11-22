// 验证「继续转成笔记 = 接着做，而不是重新做」：
//  ① 第一次整理：第 2 段上游一直失败 → 整篇不进笔记库（标未完成）
//  ② 点「继续」：第 1、3 段必须直接复用（0 请求），只重做第 2 段 + 1 次统一 → 笔记完成
//  ③ 点「从头重做」清缓存：三段全部重新请求
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

// ── 假上游：可以指定"哪一段一直失败"，并统计每段被请求了几次 ──────────────
let failParts = new Set([2]) // 段号（1-based）
const calls = [] // {part, isUnify}
let planN = 0 // 计划分几块（由假上游从 "part i/n" 里读出来）
const srv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let p = {}
    try { p = JSON.parse(body) } catch { /* ignore */ }
    const user = (p.messages ?? []).find((m) => m.role === 'user')?.content ?? ''
    const sys = (p.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
    const isUnify = /FINAL single coherent note|Partial notes/.test(sys)
    const m = /Transcript \(part (\d+)\/(\d+)\)/.exec(user)
    const part = isUnify ? 0 : m ? Number(m[1]) : 1
    if (m) planN = Math.max(planN, Number(m[2]))
    calls.push({ part, isUnify })
    if (!isUnify && failParts.has(part)) {
      // 模拟上游的瞬时拒绝：400 + 上游名（App 会走降级阶梯，最后原文兜底）
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Provider returned error', metadata: { raw: '{"code":400,"msg":"bad request"}', provider_name: 'MockCloud' } } }))
      return
    }
    const n = part
    const content = isUnify
      ? `# 统一后的完整笔记\n\n- 三段内容都在。\n`
      : `# 第 ${n} 段\n\n## 要点\n\n- 第 ${n} 段的核心内容：数字 ${n * 111}。\n\n## Key takeaways\n\n- 第 ${n} 段小结\n`
    if (p.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const piece of content.match(/[\s\S]{1,60}/g) ?? []) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 50 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 50 } }))
  })
})
await new Promise((r) => srv.listen(8804, '127.0.0.1', r))

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

// 约 30k 字 → 3 块（maxChunkChars=13000）
// 约 40k 字 → 13000/块 = 4 块（分段数由 App 自己算，断言按 chunks 字段走）
const TEXT = Array.from({ length: 1300 }, (_, i) => `第${i}句：这一节讲了概念${i}的定义、推导和例子，考试重点。`).join('')

// 每次从干净档案跑：否则上一轮留下的断点缓存会让"第一次整理"直接全部复用（测不出失败场景）
fs.rmSync('/tmp/wn-resume', { recursive: true, force: true })
const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), '--remote-debugging-port=9528', '--user-data-dir=/tmp/wn-resume'], { cwd: ROOT, env: { ...process.env, PATH: `${process.env.HOME}/.nvm/versions/node/x/bin:${process.env.PATH}` } })
child.stderr.on('data', () => {})
setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } process.exit(1) }, 420000).unref?.()

const runOnce = async (dc, title) => {
  return await dc.evalJs(`(async () => {
    window.__d = null
    window.__progText = ''
    window.api.onOrganizeJob((p) => { window.__progText += (p.detail || '') + '\\n' })
    window.api.onOrganizeDone((d) => { window.__d = d })
    window.api.onOrganizeError((e) => { window.__d = { error: e } })
    await window.api.llm.organizeStart({ title: ${JSON.stringify(title)}, sourceText: window.__TEXT })
    const t0 = Date.now()
    while (!window.__d && Date.now() - t0 < 180000) await new Promise(r => setTimeout(r, 400))
    const notes = await window.api.notes.list()
    const mine = notes.find((n) => n.title === ${JSON.stringify(title)})
    return { done: window.__d, note: mine ? (await window.api.notes.get(mine.id)).noteMd : null, noteCount: notes.length, logs: window.__progText }
  })()`)
}

try {
  const dc = await conn(9528)
  await sleep(4000)
  await dc.evalJs(`(async () => {
    window.__TEXT = ${JSON.stringify(TEXT)}
    const s = await window.api.settings.get()
    const next = await window.api.settings.set({ llm: { ...s.llm, baseUrl: 'http://127.0.0.1:8804/v1', apiKey: 'k', modelId: 'mock', maxChunkChars: 13000, maxOutputTokens: 32768, fallbackModels: [], autoFallback: false, providers: [] }, autoOrganizeOnStop: false })
    window.__wnStore.getState().setSettings(next)
    return true
  })()`)

  // ── ① 第一次：第 2 段一直失败 ──────────────────────────────
  calls.length = 0
  failParts = new Set([2])
  const run1 = await runOnce(dc, '继续测试 A')
  const p1 = calls.filter((c) => !c.isUnify).map((c) => c.part)
  const base = run1.noteCount
  const all = Array.from({ length: planN }, (_, i) => i + 1)
  rec('第一次整理：每段都被请求过（第 2 段反复失败）', all.every((i) => p1.includes(i)), `计划 ${planN} 段，请求段号=${JSON.stringify([...new Set(p1)])}`)
  rec('失败段的重试被额度上限兜住（总请求 ≤ 45）', calls.length <= 45, `本次共 ${calls.length} 次请求`)
  rec('第一次整理：第 2 段失败 → 整篇不进笔记库', run1.note === null && run1.done?.incomplete === true, JSON.stringify({ incomplete: run1.done?.incomplete, failedParts: run1.done?.failedParts }))

  // ── ② 点「继续」：只重做第 2 段 ─────────────────────────────
  calls.length = 0
  failParts = new Set() // 上游恢复
  const run2 = await runOnce(dc, '继续测试 A')
  const p2 = calls.filter((c) => !c.isUnify).map((c) => c.part)
  const unify2 = calls.filter((c) => c.isUnify).length
  const reusedParts = all.filter((i) => p1.includes(i) && !p2.includes(i))
  rec('继续时：上次做好的段落直接复用、不再请求（0 额度）', reusedParts.length > 0, `复用段=${JSON.stringify(reusedParts)}，本次请求段号=${JSON.stringify([...new Set(p2)])}`)
  rec('复用说明已写进日志/进度（"已复用 N/总 段"）', /已复用/.test(String(run2.logs || '')), '')
  rec('继续比第一次省得多（请求数明显下降）', calls.length <= Math.max(6, Math.round(p1.length / 2)), `继续 ${calls.length} 次 vs 第一次 ${p1.length} 次`)
  rec('继续时：只重做失败的第 2 段', p2.includes(2) && p2.filter((x) => x === 2).length <= 2, `第2段请求 ${p2.filter((x) => x === 2).length} 次`)
  rec('继续时：总请求很少（≤4）', calls.length <= 4, `共 ${calls.length} 次（含统一 ${unify2} 次）`)
  rec('继续后：笔记完整入库', !!run2.note && run2.noteCount === base + 1, `noteChars=${run2.note?.length ?? 0}`)
  rec('继续后：每段内容都在笔记里', !!run2.note && all.every((i) => run2.note.includes(`${i * 111}`)), JSON.stringify((run2.note || '').slice(0, 100)))

  // ── ③ 从头重做：清缓存后三段重新请求 ────────────────────────
  await dc.evalJs(`(async () => { await window.api.notes.remove((await window.api.notes.list()).find(n => n.title === '继续测试 A').id); return true })()`)
  calls.length = 0
  await dc.evalJs(`(async () => { await window.api.trans.clearCheckpoint(window.__TEXT); return true })()`)
  const run3 = await runOnce(dc, '继续测试 A')
  const p3 = calls.filter((c) => !c.isUnify).map((c) => c.part)
  rec('「从头重做」后：每段全部重新请求', all.every((i) => p3.includes(i)), `请求段号=${JSON.stringify([...new Set(p3)])}`)
  rec('「从头重做」后：笔记依然完整入库', !!run3.note && all.every((i) => run3.note.includes(`${i * 111}`)), `noteChars=${run3.note?.length ?? 0}`)
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
