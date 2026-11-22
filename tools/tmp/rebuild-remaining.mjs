// 用现在的 dots api 继续换卡：跳过已按新规则重建的笔记；一旦出现 400 立即停止并记录断点
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9490
const LOG = '/tmp/rebuild2.log'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => { const l = `[${new Date().toISOString().slice(11,19)}] ${s}`; console.log(l); fs.appendFileSync(LOG, l + '\n') }
const UD = '/tmp/wn-rebuild2'
fs.mkdirSync(UD, { recursive: true })
fs.writeFileSync(path.join(UD,'config.json'), JSON.stringify({ storage: { dataParent: process.env.HOME + '/Downloads' }, ui: { language: 'zh' } }, null, 2))
const child = spawn(path.join(ROOT,'node_modules/.bin/electron'), [path.join(ROOT,'out/main/index.js'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], {cwd: ROOT, env:{...process.env}})
child.stderr.on('data', (d) => fs.appendFileSync(LOG, '[el] ' + String(d)))
setTimeout(()=>{ log('❌ 总超时'); try{child.kill('SIGKILL')}catch{} process.exit(1) }, 60*60_000).unref?.()
let cdp = null
for (let i=0;i<120&&!cdp;i++){ try{ const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p=l.find(t=>t.type==='page'); if(p){ const ws=new WebSocket(p.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j)}); let id=0; const pend=new Map(); ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id)}}); const send=(m,pp={})=>new Promise(r=>{const i2=++id;pend.set(i2,r);ws.send(JSON.stringify({id:i2,method:m,params:pp}))}); cdp={ evalJs: async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true,userGesture:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text); return r.result?.value} } } }catch{} if(!cdp) await sleep(500) }
try {
  await sleep(4000)
  // 监听出卡任务的结束事件（拿到失败原因）
  await cdp.evalJs(`(() => {
    window.__done = []
    window.api.cards.onDone((d) => window.__done.push(d))
    return true
  })()`)
  const notes = await cdp.evalJs(`(async () => (await window.api.notes.list()).map((n) => ({ id: n.id, title: n.title })))()`)
  // 跳过已有"新规则卡片"的笔记（importance 非空）
  const done = await cdp.evalJs(`(async () => { const l = await window.api.cards.list({}); const ids = new Set(l.filter(c => c.importance != null).map(c => c.noteId)); return Array.from(ids) })()`)
  const todo = notes.filter((n) => !done.includes(n.id))
  log(`共 ${notes.length} 篇；已按新规则重建 ${done.length} 篇；本次要处理 ${todo.length} 篇（遇 400 立即停止）`)
  let ok = 0, created = 0, stopped = null
  for (let i = 0; i < todo.length; i++) {
    const n = todo[i]
    await cdp.evalJs(`(async () => { const l = await window.api.cards.list({ noteId: ${JSON.stringify(n.id)}, includeSuspended: true }); for (const c of l) await window.api.cards.remove(c.id); return true })()`)
    await cdp.evalJs(`(async () => { window.__done.length = 0; return await window.api.cards.generate({ noteId: ${JSON.stringify(n.id)}, preset: 'exam', per1000: 3, maxPerNote: 12, minImportance: 4, blockAdmin: true, skipExisting: false }) })()`)
    let res = null
    for (let t = 0; t < 100; t++) {
      await sleep(1500)
      const events = await cdp.evalJs(`window.__done.slice()`)
      if (events.length) { res = events[events.length - 1]; break }
    }
    const got = await cdp.evalJs(`(async () => (await window.api.cards.list({ noteId: ${JSON.stringify(n.id)} })).length)()`)
    const errText = res?.error ? String(res.error) : ''
    const is400 = /provider400|status=400|bad request/i.test(errText) || (res?.failed > 0 && got === 0 && /400/.test(errText))
    if (got > 0) { ok += 1; created += got; log(`  [${i+1}/${todo.length}] ✅ ${n.title} → ${got} 张`) }
    else log(`  [${i+1}/${todo.length}] ⚠️ ${n.title} → 0 张 ${errText ? '（' + errText.slice(0, 160) + '）' : ''}`)
    if (got === 0 && is400) {
      stopped = { title: n.title, id: n.id, error: errText }
      log(`🛑 出现 400（上游拒绝）→ 按你的要求立即停止。停在：${n.title}`)
      break
    }
  }
  const stats = await cdp.evalJs(`(async () => await window.api.cards.stats())()`)
  log(`本次完成：成功 ${ok} 篇 / 新增 ${created} 张（库内共 ${stats.total} 张）`)
  if (stopped) log(`断点：${stopped.title}（${stopped.id}）—— 你说继续时我从这里接着跑`)
  const dist = await cdp.evalJs(`(async () => { const l = await window.api.cards.list({}); const byImp={}; for (const c of l) byImp[c.importance ?? 0]=(byImp[c.importance ?? 0]||0)+1; return byImp })()`)
  log('重要度分布: ' + JSON.stringify(dist))
} catch(e) { log('❌ 脚本异常: ' + String(e)) } finally { try{child.kill('SIGTERM')}catch{} await sleep(600); process.exit(0) }
