// 验证：草稿已彻底移除、状态栏数据在录音时实时更新
import { spawn, execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra='') => { results.push({n, ok}); console.log(`${ok?'✅':'❌'} ${n}${extra?' — '+extra:''}`) }
function conn(port){ return (async()=>{ for(let i=0;i<120;i++){ try{ const l=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p=l.find(t=>t.type==='page'); if(p){ const ws=new WebSocket(p.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j)}); let id=0; const pend=new Map(); const errs=[]; ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id)} else if(m.method==='Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text)}); const send=(m,pp={})=>new Promise(r=>{const i2=++id;pend.set(i2,r);ws.send(JSON.stringify({id:i2,method:m,params:pp}))}); return { errs, evalJs: async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true,userGesture:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text); return r.result?.value} } } }catch{} await sleep(500)} throw new Error('cdp') })() }
const child = spawn(path.join(ROOT,'node_modules/.bin/electron'), [path.join(ROOT,'out/main/index.js'),'--remote-debugging-port=9520','--user-data-dir=/tmp/wn-devdata'], {cwd: ROOT})
child.stderr.on('data',()=>{})
setTimeout(()=>{ try{child.kill('SIGKILL')}catch{} process.exit(1) }, 300000).unref?.()
try {
  const dc = await conn(9520); await sleep(4000)
  // 设置页不应再出现草稿设置
  const settings = await dc.evalJs(`(async () => {
    const st = window.__wnStore.getState(); st.setTab('settings'); await new Promise(r=>setTimeout(r,1500))
    const txt = document.body.innerText
    return { hasDraftRows: /草稿专用模型|草稿频率|草稿最短语音|Draft frequency|Draft-only model/.test(txt), hasDraftToggle: /边说边出草稿|draft preview/i.test(txt) }
  })()`)
  rec('设置页已无草稿相关项', settings.hasDraftRows === false && settings.hasDraftToggle === false, JSON.stringify(settings))
  // 录音 → 状态栏应有数据
  const st = await dc.evalJs(`(async () => {
    const s = await window.api.settings.get()
    await window.api.settings.set({ whisper: { ...s.whisper, modelFile: 'ggml-small.en-q5_1.bin', maxSpeechSec: 6, minSilenceMs: 350, sensitivity: 70 } })
    const st0 = window.__wnStore.getState(); st0.setTab('capture'); await new Promise(r=>setTimeout(r,800))
    return await window.api.rec.start({})
  })()`)
  rec('录音已启动', st?.ok !== false, JSON.stringify(st))
  // 喂 20 秒合成语音，其间观察状态栏
  await dc.evalJs(`(async () => {
    const sr=16000, n=1600
    for (let t=0;t<200;t++){ const a=new Float32Array(n); for(let i=0;i<n;i++) a[i]=0.3*Math.sin(2*Math.PI*220*(t*n+i)/sr); window.api.rec.pushPcm(a,sr); if(t%20===0) await new Promise(r=>setTimeout(r,80)) }
    return true
  })()`)
  await sleep(3000)
  const live = await dc.evalJs(`(async () => {
    const st = window.__wnStore.getState()
    const txt = document.body.innerText
    return { status: st.asrStatus, bar: /正在转写|聆听中|已转写|排队|Transcribing|Listening|queued/.test(txt), draftField: 'draftText' in st }
  })()`)
  rec('状态栏显示转写状态（忙闲/句数/用时/模型）', !!live.status && typeof live.status.finals === 'number' && !!live.status.model, JSON.stringify(live.status))
  rec('状态栏已渲染到界面', live.bar === true, `匹配=${live.bar}`)
  rec('草稿字段已从状态里移除', live.draftField === false, `draftText 仍存在=${live.draftField}`)
  // 等队列跑完，确认句数增长 + busy 回落
  let grew = false
  for (let i = 0; i < 20; i++) { await sleep(1000); const s2 = await dc.evalJs(`window.__wnStore.getState().asrStatus`); if (s2 && s2.finals > 0) { grew = true; break } }
  rec('定稿句数随录音增长（说明转写仍在实时进行）', grew === true)
  await dc.evalJs(`(async () => { await window.api.rec.stop(); return true })()`)
  rec('无渲染层异常', dc.errs.length === 0, dc.errs.slice(0,2).join(' | '))
} catch(e){ rec('脚本', false, String(e)) } finally {
  try{child.kill('SIGTERM')}catch{}
  await sleep(700)
  const bad = results.filter(r=>!r.ok)
  console.log(`\n结果: ${results.length-bad.length}/${results.length} 通过`)
  process.exit(0)
}
