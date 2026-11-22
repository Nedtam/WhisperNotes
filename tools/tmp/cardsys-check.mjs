// 端到端：考试冲刺预设下，只有"值得考"的卡会被采纳，行政/工具/琐事被过滤
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9440
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }
const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/wn-devdata'], { cwd: ROOT, env: { ...process.env } })
child.stderr.on('data', () => {})
setTimeout(() => { console.log('❌ 超时'); try { child.kill('SIGKILL') } catch {} process.exit(1) }, 240000).unref?.()
let cdp = null
for (let i = 0; i < 120 && !cdp; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
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
      cdp = { errors, evalJs: async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value } }
    }
  } catch { /* retry */ }
  if (!cdp) await sleep(500)
}
try {
  await sleep(3500)
  const prep = await cdp.evalJs(`(async () => {
    await window.api.settings.set({ llm: { ...(await window.api.settings.get()).llm, baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'fake-key', modelId: 'fake-model', autoFallback: false,
      providers: [{ id: 'fake', name: 'Fake', baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'fake-key', modelId: 'fake-model', enabled: true }], activeProviderId: 'fake' } })
    const old = await window.api.cards.list({ includeSuspended: true }); for (const c of old) await window.api.cards.remove(c.id)
    for (const n of await window.api.notes.list()) if (/出卡系统验证/.test(n.title)) await window.api.notes.remove(n.id)
    const note = await window.api.notes.save({ title: '出卡系统验证 ' + Date.now(), noteMd: '## 音频\\n\\n采样率与奈奎斯特频率：最高可表示频率 = 采样率/2。\\n\\nVAD 是语音活动检测，与静音检测不同。\\n\\n量化误差可通过提高位深或抖动降低。\\n\\n作业下周五交，办公室在 B302。', sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
    return { id: note.id }
  })()`)
  // 考试冲刺 + 门槛 4
  const gen = await cdp.evalJs(`(async () => await window.api.cards.generate({ noteId: ${JSON.stringify(prep.id)}, preset: 'exam', minImportance: 4, style: 'balanced' }))()`)
  let cards = []
  for (let i = 0; i < 30; i++) { await sleep(700); cards = await cdp.evalJs(`(async () => await window.api.cards.list({ noteId: ${JSON.stringify(prep.id)} }))()`); if (cards.length) break }
  const fronts = cards.map((c) => c.front)
  const kinds = cards.map((c) => c.kind)
  const imps = cards.map((c) => c.importance)
  rec('出卡任务已执行', gen.ok === true, JSON.stringify(gen))
  rec('低重要度卡片被剔除（≥4）', imps.length > 0 && imps.every((x) => (x ?? 3) >= 4), `重要度=${JSON.stringify(imps)}`)
  rec('行政内容被过滤（作业/办公室/Audacity 不在卡里）', !fronts.some((f) => /作业|办公室|Audacity|颜色/.test(f)), JSON.stringify(fronts))
  rec('保留的是可考内容（采样率/奈奎斯特/VAD/量化）', fronts.some((f) => /采样率|奈奎斯特/.test(f)) && fronts.some((f) => /VAD/.test(f)), JSON.stringify(fronts.slice(0, 3)))
  rec('卡片带类型与原文依据', kinds.every((k) => !!k) && cards.every((c) => !!c.quote), `类型=${JSON.stringify(kinds)} 依据示例=${cards[0]?.quote}`)
  // 界面：质量标记可见
  const ui = await cdp.evalJs(`(async () => {
    const st = window.__wnStore.getState(); st.setTab('cards'); await new Promise(r => setTimeout(r, 1500))
    const txt = document.body.innerText
    const stars = [...document.querySelectorAll('[data-fc-list] span')].filter(s => /★/.test(s.textContent||'')).length
    return { stars, hasKind: /定义|公式|辨析|应用|步骤|事实/.test(txt), hasQuote: /原文：/.test(txt) }
  })()`)
  rec('界面显示重要度/类型/原文依据', ui.stars > 0 && ui.hasKind && ui.hasQuote, JSON.stringify(ui))
  rec('无渲染层异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | '))
  await cdp.evalJs(`(async () => { const l = await window.api.cards.list({ includeSuspended: true }); for (const c of l) await window.api.cards.remove(c.id); await window.api.notes.remove(${JSON.stringify(prep.id)}); return true })()`)
} catch (e) { rec('脚本', false, String(e)) } finally {
  try { child.kill('SIGTERM') } catch {}
  await sleep(700)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) process.exit(1)
}
