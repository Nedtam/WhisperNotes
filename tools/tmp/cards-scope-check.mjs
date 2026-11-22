// 验证闪卡分类：笔记本/子笔记本/未归档筛选、未出卡统计、笔记多选出卡、复习队列随范围
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9392
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

  // 0) 造数据：父笔记本 + 子笔记本 + 若干笔记（模拟 MGT2324 / Week 1-3）
  const seed = await cdp.evalJs(`(async () => {
    // 清掉旧卡片与旧测试笔记
    const oldCards = await window.api.cards.list({ includeSuspended: true })
    for (const c of oldCards) await window.api.cards.remove(c.id)
    const allNotes = await window.api.notes.list()
    for (const n of allNotes) if (/范围测试/.test(n.title)) await window.api.notes.remove(n.id)
    for (const nb of await window.api.notebooks.list()) if (/范围测试/.test(nb.name)) await window.api.notebooks.remove(nb.id)

    const parent = await window.api.notebooks.create('范围测试-MGT2324', null)
    const childNb = await window.api.notebooks.create('范围测试-MGT2324-子', parent.id)
    const mk = async (title, notebookId) => window.api.notes.save({ title, noteMd: '## 内容\\n\\n' + title + ' 的核心概念说明。', sourceText: '', templateId: 'study', notebookId, durationMs: 0, tags: [] })
    const w1 = await mk('范围测试 Week1', parent.id)
    const w2 = await mk('范围测试 Week2', parent.id)
    const w3 = await mk('范围测试 Week3', parent.id)
    const s1 = await mk('范围测试 子笔记', childNb.id)
    const free = await mk('范围测试 未归档', null)
    // 只给 Week1 / Week2 出卡（多选笔记）
    const g = await window.api.cards.generate({ noteIds: [w1.id, w2.id], per1000: 20, maxPerNote: 3 })
    return { parent: parent.id, childNb: childNb.id, w1: w1.id, w2: w2.id, w3: w3.id, s1: s1.id, free: free.id, jobId: g.jobId, ok: g.ok }
  })()`)
  let total = 0
  for (let i = 0; i < 30; i++) {
    await sleep(600)
    total = await cdp.evalJs(`(async () => (await window.api.cards.stats()).total)()`)
    if (total >= 2) break
  }
  rec('按多选笔记出卡（只给 Week1/Week2）', seed.ok && total >= 2, `卡片=${total}`)
  const byNote = await cdp.evalJs(`(async () => { const l = await window.api.cards.list({}); const m = {}; for (const c of l) m[c.noteId] = (m[c.noteId]||0)+1; return m })()`)
  rec('卡片只挂在被选中的两篇上', byNote[seed.w1] > 0 && byNote[seed.w2] > 0 && !byNote[seed.w3] && !byNote[seed.free], JSON.stringify(byNote))

  // 1) 界面：进入闪卡页，检查分类侧栏
  const nav = await cdp.evalJs(`(async () => {
    const st = window.__wnStore.getState()
    st.setNotebooks(await window.api.notebooks.list())
    st.setNotes(await window.api.notes.list())
    st.setTab('cards')
    await new Promise(r => setTimeout(r, 1600))
    const txt = document.body.innerText
    const rows = [...document.querySelectorAll('[data-fc-nav] button')].map(b => (b.textContent||'').trim())
    const nbRow = rows.find(x => /范围测试-MGT2324(?!-)/.test(x))
    const childRow = rows.find(x => /范围测试-MGT2324-子/.test(x))
    return {
      hasScopeTitle: /分类范围|Scope/.test(txt),
      hasAll: /全部|All/.test(txt),
      hasUnsorted: /未归档|Unsorted/.test(txt),
      nbRow, childRow,
      uncardedBadges: (txt.match(/未转|new/g) || []).length
    }
  })()`)
  rec('闪卡页出现分类侧栏（全部/未归档/笔记本/子笔记本）', nav.hasScopeTitle && nav.hasAll && nav.hasUnsorted && !!nav.nbRow && !!nav.childRow, JSON.stringify({ nbRow: nav.nbRow, childRow: nav.childRow }))
  rec('侧栏显示“未出卡”标记', nav.uncardedBadges > 0, `标记数=${nav.uncardedBadges}`)

  // 2) 点父笔记本 → 只显示该笔记本（含子笔记本）的卡片；再勾选笔记 → 只剩勾选的
  const scopeTest = await cdp.evalJs(`(async () => {
    const btns = [...document.querySelectorAll('[data-fc-nav] button')]
    const nb = btns.find(b => /范围测试-MGT2324(?!-)/.test((b.textContent||'')))
    nb.click()
    await new Promise(r => setTimeout(r, 900))
    const afterNb = document.querySelectorAll('[data-fc-list] > li').length
    const title = (document.body.innerText.match(/范围测试-MGT2324/) || [])[0]
    // 找笔记多选区里的复选框（Week3 未出卡 → 勾选它，列表应变空，因为它的卡片为 0）
    const checks = [...document.querySelectorAll('[data-fc-notes] input[type=checkbox]')]
    const labels = checks.map(c => (c.closest('label')?.textContent || '').trim())
    const week3 = checks[labels.findIndex(x => /范围测试 Week3/.test(x))]
    // 先清空选择，再只勾 Week3
    const clear = [...document.querySelectorAll('[data-fc-nav] button')].find(b => /清空|Clear/.test(b.textContent))
    if (clear) clear.click()
    await new Promise(r => setTimeout(r, 500))
    if (week3) { week3.click(); await new Promise(r => setTimeout(r, 800)) }
    const afterPick = document.querySelectorAll('[data-fc-list] > li').length
    return { afterNb, afterPick, labels: labels.slice(0, 6) }
  })()`)
  rec('选中笔记本后列表按笔记本过滤', scopeTest.afterNb >= 2, `列表条目=${scopeTest.afterNb}`)
  rec('笔记本内逐篇勾选后列表随之变化', scopeTest.afterPick === 0, `勾选未出卡的 Week3 后条目=${scopeTest.afterPick}（该篇没卡片）`)
  rec('多选区列出该笔记本下的每篇笔记', scopeTest.labels.some((x) => /范围测试 Week1/.test(x)) && scopeTest.labels.some((x) => /范围测试 Week3/.test(x)), JSON.stringify(scopeTest.labels))

  // 3) 复习队列随范围：先选父笔记本 → 复习队列长度应等于该范围待复习数
  const queue = await cdp.evalJs(`(async () => {
    const btns = [...document.querySelectorAll('[data-fc-nav] button')]
    btns.find(b => /范围测试-MGT2324(?!-)/.test(b.textContent)).click()
    await new Promise(r => setTimeout(r, 800))
    const clear = [...document.querySelectorAll('button')].find(b => /清空|Clear/.test(b.textContent))
    if (clear) clear.click()
    await new Promise(r => setTimeout(r, 600))
    const start = [...document.querySelectorAll('button')].find(b => /开始复习|Start review/.test(b.textContent))
    start.click()
    await new Promise(r => setTimeout(r, 900))
    const listCount = document.querySelectorAll('[data-fc-list] > li').length
    const progress = document.querySelector('[data-fc-progress]')?.textContent?.trim() ?? ''
    const queueLen = Number(progress.split('/')[1] || 0)
    const exit = [...document.querySelectorAll('[data-fc-review] button')].find(b => /结束复习|End review/.test(b.textContent))
    if (exit) exit.click()
    return { progress, listCount, queueLen }
  })()`)
  rec('复习队列 = 当前范围列表', queue.queueLen > 0 && queue.queueLen === queue.listCount, `列表=${queue.listCount} 队列=${queue.queueLen}（${queue.progress}）`)

  rec('无渲染层异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | '))

  // 清理
  await cdp.evalJs(`(async () => {
    const l = await window.api.cards.list({ includeSuspended: true })
    for (const c of l) await window.api.cards.remove(c.id)
    const ns = await window.api.notes.list()
    for (const n of ns) if (/范围测试/.test(n.title)) await window.api.notes.remove(n.id)
    for (const nb of await window.api.notebooks.list()) if (/范围测试/.test(nb.name)) await window.api.notebooks.remove(nb.id)
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
