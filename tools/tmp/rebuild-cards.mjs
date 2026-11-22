// 用新规则（考试冲刺）重建全部卡片：逐篇删除旧卡 → 重新生成
// 目标数据目录 = 你的真实库（~/Downloads/whisper-notes），通过 --user-data-dir 引导指过去
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9460
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LOG = '/tmp/rebuild-cards.log'
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`
  console.log(line)
  fs.appendFileSync(LOG, line + '\n')
}

// 引导配置：让实例用你的真实数据目录
const UD = '/tmp/wn-rebuild'
fs.mkdirSync(UD, { recursive: true })
fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ storage: { dataParent: process.env.HOME + '/Downloads' }, ui: { language: 'zh' } }, null, 2))

const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env: { ...process.env } })
child.stderr.on('data', (d) => fs.appendFileSync(LOG, '[el] ' + String(d)))
setTimeout(() => {
  log('❌ 总超时')
  try {
    child.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  process.exit(1)
}, 45 * 60_000).unref?.()

let cdp = null
for (let i = 0; i < 120 && !cdp; i++) {
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
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)(m.result)
          pending.delete(m.id)
        }
      })
      const send = (method, params = {}) =>
        new Promise((r) => {
          const mid = ++id
          pending.set(mid, r)
          ws.send(JSON.stringify({ id: mid, method, params }))
        })
      cdp = {
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
  await sleep(4000)
  // 确认连的是真实库
  const info = await cdp.evalJs(`(async () => {
    const notes = await window.api.notes.list()
    const stats = await window.api.cards.stats()
    const cfg = await window.api.settings.get()
    return { notes: notes.length, cards: stats.total, model: cfg.llm.modelId, base: cfg.llm.baseUrl }
  })()`)
  log(`库已连接：${info.notes} 篇笔记 / ${info.cards} 张卡片 · 模型 ${info.model}`)
  if (info.notes < 5) {
    log('❌ 笔记数量异常，终止以免误操作')
    process.exit(1)
  }

  const notes = await cdp.evalJs(`(async () => (await window.api.notes.list()).map((n) => ({ id: n.id, title: n.title })))()`)
  log(`开始重建 ${notes.length} 篇（考试冲刺：每1000字3张 / 上限12 / 重要度≥4 / 过滤行政内容）`)

  let ok = 0
  let failed = 0
  let created = 0
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]
    const before = await cdp.evalJs(`(async () => (await window.api.cards.list({ noteId: ${JSON.stringify(n.id)}, includeSuspended: true })).length)()`)
    // ① 删掉旧卡（含暂停的）
    await cdp.evalJs(`(async () => { const l = await window.api.cards.list({ noteId: ${JSON.stringify(n.id)}, includeSuspended: true }); for (const c of l) await window.api.cards.remove(c.id); return true })()`)
    // ② 按新规则重新生成
    const gen = await cdp.evalJs(
      `(async () => await window.api.cards.generate({ noteId: ${JSON.stringify(n.id)}, preset: 'exam', per1000: 3, maxPerNote: 12, minImportance: 4, blockAdmin: true, skipExisting: false }))()`
    )
    if (!gen?.ok) {
      failed += 1
      log(`  [${i + 1}/${notes.length}] ❌ 任务未启动：${n.title}（${gen?.error ?? '未知'}）`)
      continue
    }
    // ③ 等这批卡片落地
    let got = 0
    for (let t = 0; t < 90; t++) {
      await sleep(1500)
      got = await cdp.evalJs(`(async () => (await window.api.cards.list({ noteId: ${JSON.stringify(n.id)} })).length)()`)
      if (got > 0) break
    }
    if (got > 0) {
      ok += 1
      created += got
      log(`  [${i + 1}/${notes.length}] ✅ ${n.title}：${before} → ${got} 张`)
    } else {
      failed += 1
      log(`  [${i + 1}/${notes.length}] ⚠️ ${n.title}：0 张（原有 ${before} 张已删除）`)
    }
  }
  const stats = await cdp.evalJs(`(async () => await window.api.cards.stats())()`)
  log(`重建完成：成功 ${ok} 篇 / 失败 ${failed} 篇 / 新卡片 ${created} 张（库内共 ${stats.total} 张）`)
  const dist = await cdp.evalJs(`(async () => {
    const l = await window.api.cards.list({})
    const byImp = {}; const byKind = {}
    for (const c of l) { byImp[c.importance ?? 0] = (byImp[c.importance ?? 0] || 0) + 1; byKind[c.kind || '未知'] = (byKind[c.kind || '未知'] || 0) + 1 }
    return { byImp, byKind, sample: l.slice(0, 3).map((c) => c.front) }
  })()`)
  log('重要度分布: ' + JSON.stringify(dist.byImp))
  log('类型分布: ' + JSON.stringify(dist.byKind))
  log('样例: ' + dist.sample.map((s) => s.slice(0, 40)).join(' | '))
} catch (e) {
  log('❌ 重建脚本出错: ' + String(e))
} finally {
  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  await sleep(800)
  const bad = results => results
  void bad
  process.exit(0)
}
