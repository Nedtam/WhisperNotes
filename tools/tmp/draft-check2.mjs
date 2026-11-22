import { spawn, execFileSync } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LOGDIR = '/tmp/wn-devbase/whisper-notes/logs'
function engines() {
  try {
    const out = execFileSync('bash', ['-c', `ps -eo args= | grep whisper-server | grep -v grep`], { encoding: 'utf-8' })
    return out.split('\n').filter(Boolean).map((l) => ((/--model\s+(\S+)/.exec(l) || [])[1] || '').split('/').pop())
  } catch { return [] }
}
function newestLogs(n = 3) {
  const files = fs.readdirSync(LOGDIR).filter((f) => f.startsWith('whisper-server-')).map((f) => ({ f, t: fs.statSync(path.join(LOGDIR, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, n)
  return files.map(({ f }) => {
    const txt = fs.readFileSync(path.join(LOGDIR, f), 'utf-8')
    const m = /loading model from '([^']+)'/.exec(txt)
    return `${f.slice(16, 29)} → ${m ? m[1].split('/').pop() : '?'}`
  })
}
function conn(port){ return (async()=>{ for(let i=0;i<120;i++){ try{ const l=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p=l.find(t=>t.type==='page'); if(p){ const ws=new WebSocket(p.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j)}); let id=0; const pend=new Map(); ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id)}}); const send=(m,pp={})=>new Promise(r=>{const i2=++id;pend.set(i2,r);ws.send(JSON.stringify({id:i2,method:m,params:pp}))}); return { evalJs: async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true,userGesture:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text); return r.result?.value} } } }catch{} await sleep(500)} throw new Error('cdp') })() }
const child = spawn(path.join(ROOT,'node_modules/.bin/electron'), [path.join(ROOT,'out/main/index.js'),'--remote-debugging-port=9510','--user-data-dir=/tmp/wn-devdata'], {cwd: ROOT})
child.stderr.on('data',()=>{})
setTimeout(()=>{ try{child.kill('SIGKILL')}catch{} process.exit(1) }, 300000).unref?.()
try {
  const dc = await conn(9510); await sleep(4000)
  await dc.evalJs(`(async () => {
    const s = await window.api.settings.get()
    await window.api.settings.set({ whisper: { ...s.whisper, modelFile: 'ggml-large-v3-turbo-q5_0.bin', partialPreview: true, partialModelFile: 'ggml-small.en-q5_1.bin', partialIntervalMs: 15000, partialMinMs: 5000 } })
    return true
  })()`)
  const st = await dc.evalJs(`(async () => await window.api.rec.start({}))()`)
  console.log('rec.start:', JSON.stringify(st), '| 立即进程:', JSON.stringify(engines()))
  await sleep(8000)
  console.log('8 秒后:', JSON.stringify(engines()))
  const fed = await dc.evalJs(`(async () => {
    const sr=16000, n=1600
    for (let t=0;t<400;t++){ const a=new Float32Array(n); for(let i=0;i<n;i++) a[i]=0.3*Math.sin(2*Math.PI*220*(t*n+i)/sr); window.api.rec.pushPcm(a,sr); if(t%50===0) await new Promise(r=>setTimeout(r,120)) }
    return 400
  })()`)
  await sleep(9000)
  console.log('喂入', fed, '块后:', JSON.stringify(engines()))
  console.log('最新引擎日志:', JSON.stringify(newestLogs(3)))
  await dc.evalJs(`(async () => { await window.api.rec.stop(); return true })()`)
  await sleep(2500)
  console.log('停止后:', JSON.stringify(engines()))
} catch(e){ console.log('error', String(e).slice(0,200)) } finally { try{child.kill('SIGTERM')}catch{} await sleep(700); process.exit(0) }
