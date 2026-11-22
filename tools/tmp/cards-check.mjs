// 阶段 4 验证：闪卡生成（假模型）→ 预览/编辑 → 复习（SM-2）→ 统计 → 手机端接口
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9370
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => {
  results.push({ n, ok })
  console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`)
}

const child = spawn(
  path.join(ROOT, 'node_modules/.bin/electron'),
  [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/wn-devdata'],
  { cwd: ROOT, env: { ...process.env } }
)
child.stderr.on('data', () => {})
setTimeout(() => {
  console.log('❌ 超时')
  try {
    child.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  process.exit(1)
}, 240000).unref?.()

let cdp = null
for (let i = 0; i < 60 && !cdp; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
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
      cdp = {
        errors,
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
  if (!cdp) await sleep(500)
}

try {
  await sleep(3500)

  // 0) 准备：清空卡片 + 造一条测试笔记
  const prep = await cdp.evalJs(`(async () => {
    // 确保出卡走本地假模型（其它套件可能改过渠道，这里显式设置，保证顺序无关）
    await window.api.settings.set({ llm: { ...(await window.api.settings.get()).llm, baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'fake-key', modelId: 'fake-model', autoFallback: false,
      providers: [{ id: 'fake', name: 'Fake', baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'fake-key', modelId: 'fake-model', enabled: true }], activeProviderId: 'fake' } })
    const old = await window.api.cards.list({ includeSuspended: true })
    for (const c of old) await window.api.cards.remove(c.id)
    const md = '## 音频基础\\n\\n采样率决定可表示的频率上限（奈奎斯特频率 = 采样率/2）。\\n\\n**VAD** 是语音活动检测，用来切分静音与语音段。\\n\\n$$ f = \\\\frac{1}{T} $$'
    const note = await window.api.notes.save({ title: '闪卡测试笔记 ' + Date.now(), noteMd: md, sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: ['闪卡'] })
    return { noteId: note.id, cardsBefore: old.length }
  })()`)
  rec('准备：清空旧卡片 + 建测试笔记', !!prep.noteId, `noteId=${prep.noteId.slice(0, 8)} 原有卡片=${prep.cardsBefore}`)

  // 1) 通过 IPC 触发生成（范围：当前笔记）
  const gen = await cdp.evalJs(`(async () => {
    const r = await window.api.cards.generate({ noteId: ${JSON.stringify(prep.noteId)}, per1000: 15, maxPerNote: 10, style: 'balanced', language: 'auto' })
    return r
  })()`)
  rec('触发出卡任务', gen.ok === true && !!gen.jobId, JSON.stringify(gen))

  // 等生成完成
  let done = null
  for (let i = 0; i < 40; i++) {
    await sleep(700)
    done = await cdp.evalJs(`(async () => { const st = await window.api.cards.stats(); return { total: st.total, due: st.due, ai: st.aiCount } })()`)
    if (done.total > 0) break
  }
  rec('卡片已生成并入库', done.total > 0, `总数=${done.total} 待复习=${done.due} AI=${done.ai}`)

  const list = await cdp.evalJs(`(async () => (await window.api.cards.list({})).slice(0,3))()`)
  rec('卡片内容可用（正反面非空）', list.length > 0 && list.every((c) => c.front && c.back), JSON.stringify(list[0]?.front?.slice(0, 40)))
  rec('卡片带来源笔记与标签', list[0]?.noteId === prep.noteId && Array.isArray(list[0]?.tags), `tags=${JSON.stringify(list[0]?.tags)}`)

  // 2) 编辑卡片
  const edited = await cdp.evalJs(`(async () => {
    const l = await window.api.cards.list({})
    const c = l[0]
    const u = await window.api.cards.update(c.id, { front: '被编辑过的问题', back: '被编辑过的答案' })
    const after = (await window.api.cards.list({})).find(x => x.id === c.id)
    return { front: after.front, back: after.back }
  })()`)
  rec('卡片可编辑', edited.front === '被编辑过的问题' && edited.back === '被编辑过的答案', JSON.stringify(edited))

  // 3) SM-2：评分 good 后间隔变长、due 推后；again 后当天再来
  const sm2 = await cdp.evalJs(`(async () => {
    const l = await window.api.cards.list({})
    const a = l[0], b = l[1]
    const t0 = Date.now()
    const r1 = await window.api.cards.review(a.id, 2)   // good
    const r2 = await window.api.cards.review(a.id, 2)   // good 第二次 → 6 天
    const r3 = await window.api.cards.review(b.id, 0)   // again → 重置
    return {
      good1: { interval: r1.intervalDays, ease: Number((r1.ease ?? 0).toFixed(2)), dueInDays: Math.round(((r1.dueAt ?? 0) - t0) / 86400000) },
      good2: { interval: r2.intervalDays, reps: r2.reps, dueInDays: Math.round(((r2.dueAt ?? 0) - t0) / 86400000) },
      again: { interval: r3.intervalDays, lapses: r3.lapses, dueInMin: Math.round(((r3.dueAt ?? 0) - t0) / 60000) }
    }
  })()`)
  rec('SM-2：good 两次后间隔 6 天', sm2.good2.interval === 6 && sm2.good2.reps === 2, JSON.stringify(sm2.good2))
  rec('SM-2：again 重置间隔并计入 lapses', sm2.again.interval === 0 && sm2.again.lapses === 1 && sm2.again.dueInMin <= 11, JSON.stringify(sm2.again))

  // 4) 统计
  const stats = await cdp.evalJs(`(async () => await window.api.cards.stats())()`)
  rec('统计：今日复习数 / 正确率 / 趋势', stats.reviewedToday >= 3 && stats.accuracy > 0.5 && stats.daily.length === 30, JSON.stringify({ today: stats.reviewedToday, acc: Number(stats.accuracy.toFixed(2)), streak: stats.streak }))

  // 5) 界面上能看到闪卡页（导航 + 统计 + 复习入口）
  const ui = await cdp.evalJs(`(async () => {
    const st = window.__wnStore.getState()
    st.setTab('cards')
    await new Promise(r => setTimeout(r, 1200))
    const txt = document.body.innerText
    return {
      tab: window.__wnStore.getState().tab,
      hasTitle: /闪卡复习|Flashcards/.test(txt),
      hasDue: /今日待复习|Due today/.test(txt),
      hasStart: /开始复习|Start review/.test(txt),
      cardCount: document.querySelectorAll('[data-fc-list] > li').length
    }
  })()`)
  rec('闪卡页渲染（标题/统计/复习入口/卡片列表）', ui.hasTitle && ui.hasDue && ui.hasStart && ui.cardCount > 0, JSON.stringify(ui))

  // 6) 手机端接口：拉卡片 + 回传复习
  const mob = await cdp.evalJs(`(async () => {
    await window.api.mobile.setEnabled(true)
    const q = await window.api.mobile.qr()
    const st = await window.api.mobile.status()
    return { port: st.port, code: q.code }
  })()`)
  const base = `http://127.0.0.1:${mob.port}`
  const pair = await (
    await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: mob.code, device: 'Card Test' }) })
  ).json()
  const cards = await (await fetch(`${base}/api/cards?all=1`, { headers: { Authorization: `Bearer ${pair.token}` } })).json()
  rec('手机端可拉取卡片列表', cards.ok === true && cards.cards.length > 0 && !!cards.stats, `卡片=${cards.cards.length} 待复习=${cards.stats.due}`)
  const before = cards.stats.reviewedToday
  const rev = await (
    await fetch(`${base}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pair.token}` },
      body: JSON.stringify({ items: [{ cardId: cards.cards[0].id, grade: 3, ms: 4200 }] })
    })
  ).json()
  rec('手机端回传复习结果', rev.ok === true && rev.imported === 1 && rev.stats.reviewedToday === before + 1, `imported=${rev.imported} today=${before}→${rev.stats.reviewedToday}`)

  // 明确比较：手机回传也走同一套 SM-2（间隔变成天数）
  const after = await (await fetch(`${base}/api/cards?noteId=${prep.noteId}`, { headers: { Authorization: `Bearer ${pair.token}` } })).json()
  const card = after.cards.find((c) => c.id === cards.cards[0].id)
  rec('手机端评分同样写回排程', !!card && (card.reps ?? 0) > 0 && (card.dueAt ?? 0) > Date.now(), JSON.stringify({ reps: card?.reps, interval: card?.intervalDays }))

  rec('无渲染层异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | '))

  // 清理
  await cdp.evalJs(`(async () => {
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
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  await sleep(700)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) process.exit(1)
}
