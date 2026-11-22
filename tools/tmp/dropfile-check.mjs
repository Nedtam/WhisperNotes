// E2E：录音中拖入的文件排队 → 录音结束自动转写 → 一键转成笔记
//  ① 引擎"忙"时入队，不会偷偷开跑
//  ② 引擎空闲后自动出队转写（真实走 importFile：解码 + whisper 转写）
//  ③ 转写完出现「转成笔记」按钮，点一下进笔记库
import { spawn, execFileSync } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as http from 'node:http'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => {
  results.push({ n, ok })
  console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`)
}

// 真实语音样本（macOS say 生成，进测试不碰用户数据）
const WAV = '/tmp/wn-drop-sample.aiff'
if (!fs.existsSync(WAV)) execFileSync('say', ['-o', WAV, 'This is a short lecture sample about sampling rate and quantization error. The sampling rate decides the highest frequency we can represent.'])
const WAV2 = '/tmp/wn-drop-sample2.aiff'
if (!fs.existsSync(WAV2)) execFileSync('say', ['-o', WAV2, 'Second file: aliasing happens when the sampling rate is too low, so we need an anti aliasing filter.'])

// 假 LLM（笔记内容无所谓，只要流程跑通）
const srv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let p = {}
    try { p = JSON.parse(body) } catch { /* ignore */ }
    const content = '# 笔记\n\n## 要点\n\n- 采样率与量化误差。\n\n## Key takeaways\n\n- 采样率决定最高频率\n'
    if (p.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 20 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 20 } }))
  })
})
await new Promise((r) => srv.listen(8805, '127.0.0.1', r))

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

// 复用本机已有模型目录（软链），否则每次跑都要重新下载几百 MB
const UD = '/tmp/wn-drop'
fs.mkdirSync(UD, { recursive: true })
const realModels = path.join(process.env.HOME, 'Library/Application Support/WhisperNotes/models')
try {
  if (fs.existsSync(realModels) && !fs.existsSync(path.join(UD, 'models'))) fs.symlinkSync(realModels, path.join(UD, 'models'))
} catch { /* ignore */ }
const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), '--remote-debugging-port=9530', `--user-data-dir=${UD}`], { cwd: ROOT })
child.stderr.on('data', () => {})
setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } process.exit(1) }, 600000).unref?.()

try {
  const dc = await conn(9530)
  await sleep(5000)
  await dc.evalJs(`(async () => {
    const s = await window.api.settings.get()
    const next = await window.api.settings.set({ llm: { ...s.llm, baseUrl: 'http://127.0.0.1:8805/v1', apiKey: 'k', modelId: 'mock', fallbackModels: [], autoFallback: false, providers: [] }, autoOrganizeOnStop: false, whisper: { ...s.whisper, modelFile: 'ggml-small.en-q5_1.bin', language: 'en', useGpu: true } })
    window.__wnStore.getState().setSettings(next)
    window.__wnStore.getState().setTab('capture')
    await new Promise(r => setTimeout(r, 800))
    return true
  })()`)

  // ① 引擎忙（模拟录音中）时入队
  const queued = await dc.evalJs(`(async () => {
    const st = window.__wnStore.getState()
    st.setEngine({ state: 'recording' })
    await new Promise(r => setTimeout(r, 300))
    st.enqueueImport({ path: ${JSON.stringify(WAV)}, name: 'lecture-sample.aiff' })
    await new Promise(r => setTimeout(r, 2500))
    const st2 = window.__wnStore.getState()
    const bar = document.querySelector('[data-import-queue="1"]')
    return { queue: st2.importQueue.length, bar: !!bar, barText: bar ? bar.innerText.replace(/\\s+/g, ' ').slice(0, 60) : '' }
  })()`)
  rec('录音中：文件进队列且不立即转写', queued.queue === 1 && queued.bar === true, JSON.stringify(queued))

  // ② 录音结束（引擎空闲）→ 自动出队转写
  const drained = await dc.evalJs(`(async () => {
    window.__wnStore.getState().setEngine({ state: 'idle' })
    const t0 = Date.now()
    while (Date.now() - t0 < 240000) {
      const st = window.__wnStore.getState()
      if (st.importQueue.length === 0 && st.pendingNoteSources.length > 0) break
      await new Promise(r => setTimeout(r, 1000))
    }
    const st = window.__wnStore.getState()
    const trs = await window.api.transcriptions.list()
    const bar = document.querySelector('[data-note-ready="1"]')
    const btn = document.querySelector('[data-note-convert="1"]')
    return {
      queue: st.importQueue.length,
      pending: st.pendingNoteSources.map((x) => x.title),
      transcripts: trs.length,
      lastText: trs[0]?.preview?.slice(0, 60) ?? '',
      bar: !!bar,
      convertBtn: !!btn,
      btnText: btn ? btn.innerText.trim() : ''
    }
  })()`)
  rec('录音结束后：队列自动出队并转写完成', drained.queue === 0 && drained.pending.length === 1, JSON.stringify({ queue: drained.queue, pending: drained.pending }))
  rec('转写内容落库（真实 ASR 出文本）', drained.transcripts >= 1 && /sampl|quantiz|lecture|frequency/i.test(drained.lastText), drained.lastText)
  rec('出现「转成笔记」按钮（不是偷偷自动烧额度）', drained.bar === true && drained.convertBtn === true, drained.btnText)

  // ③ 点「转成笔记」→ 进笔记库
  const notes = await dc.evalJs(`(async () => {
    const before = (await window.api.notes.list()).length
    document.querySelector('[data-note-convert="1"]').click()
    const t0 = Date.now()
    while (Date.now() - t0 < 120000) {
      const n = (await window.api.notes.list()).length
      if (n > before) break
      await new Promise(r => setTimeout(r, 800))
    }
    const list = await window.api.notes.list()
    const st = window.__wnStore.getState()
    const trs = await window.api.transcriptions.list()
    return { before, after: list.length, titles: list.map((n) => n.title).slice(0, 4), pending: st.pendingNoteSources.length, noteStatus: trs[0]?.noteStatus }
  })()`)
  rec('点一下「转成笔记」→ 笔记入库', notes.after === notes.before + 1, `${notes.before} → ${notes.after} ${JSON.stringify(notes.titles)}`)
  rec('转写被标记为"已转成笔记"（转写页不再显示黄框）', notes.noteStatus === 'ok', `noteStatus=${notes.noteStatus}`)
  rec('待转列表清空', notes.pending === 0)

  // ④ 两个文件排队 → 依次处理
  const multi = await dc.evalJs(`(async () => {
    const st = window.__wnStore.getState()
    st.setEngine({ state: 'recording' })
    await new Promise(r => setTimeout(r, 200))
    st.enqueueImport({ path: ${JSON.stringify(WAV)}, name: 'one.aiff' })
    st.enqueueImport({ path: ${JSON.stringify(WAV2)}, name: 'two.aiff' })
    const q1 = window.__wnStore.getState().importQueue.length
    window.__wnStore.getState().setEngine({ state: 'idle' })
    const t0 = Date.now()
    while (Date.now() - t0 < 300000) {
      const s = window.__wnStore.getState()
      if (s.importQueue.length === 0 && s.pendingNoteSources.length >= 2) break
      await new Promise(r => setTimeout(r, 1000))
    }
    const s = window.__wnStore.getState()
    return { q1, left: s.importQueue.length, pending: s.pendingNoteSources.map((x) => x.title) }
  })()`)
  rec('多个文件排队后依次自动转写', multi.q1 === 2 && multi.left === 0 && multi.pending.length === 2, JSON.stringify(multi))

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
