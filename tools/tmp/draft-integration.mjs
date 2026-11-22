// 运行时验证：草稿用小模型 → 应该起第二个 whisper-server（小模型），且主引擎仍是大模型
import { spawn, execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra='') => { results.push({n, ok}); console.log(`${ok?'✅':'❌'} ${n}${extra?' — '+extra:''}`) }
function conn(port){ return (async()=>{ for(let i=0;i<120;i++){ try{ const l=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p=l.find(t=>t.type==='page'); if(p){ const ws=new WebSocket(p.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j)}); let id=0; const pend=new Map(); ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id)}}); const send=(m,pp={})=>new Promise(r=>{const i2=++id;pend.set(i2,r);ws.send(JSON.stringify({id:i2,method:m,params:pp}))}); return { evalJs: async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true,userGesture:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text); return r.result?.value} } } }catch{} await sleep(500)} throw new Error('cdp') })() }
const child = spawn(path.join(ROOT,'node_modules/.bin/electron'), [path.join(ROOT,'out/main/index.js'),'--remote-debugging-port=9500','--user-data-dir=/tmp/wn-devdata'], {cwd: ROOT})
child.stderr.on('data',()=>{})
setTimeout(()=>{ try{child.kill('SIGKILL')}catch{} process.exit(1) }, 240000).unref?.()
const servers = () => {
  try {
    return execFileSync('bash', ['-c', `ps -eo args= | grep -F 'whisper-server' | grep -v grep`], { encoding: 'utf-8' })
      .split('\n').filter((l) => l.includes('--model'))
  } catch { return [] }
}
try {
  const dc = await conn(9500); await sleep(4000)
  // 配置：主模型 turbo、草稿模型 small.en、间隔 15 秒、最短 5 秒
  await dc.evalJs(`(async () => {
    const s = await window.api.settings.get()
    await window.api.settings.set({ whisper: { ...s.whisper, modelFile: 'ggml-large-v3-turbo-q5_0.bin', partialPreview: true, partialModelFile: 'ggml-small.en-q5_1.bin', partialIntervalMs: 15000, partialMinMs: 5000, maxSpeechSec: 25, sensitivity: 65 } })
    return true
  })()`)
  // 开始录音（不选麦克风的话用 pushPcm 喂合成语音）
  const started = await dc.evalJs(`(async () => await window.api.rec.start({}))()`)
  rec('录音已启动', started?.ok !== false, JSON.stringify(started))
  // 喂 60 秒合成语音（0.3 幅度正弦 → VAD 视为说话）
  await dc.evalJs(`(() => { window.__feed = true; return true })()`)
  const fed = await dc.evalJs(`(async () => {
    const sr = 16000
    const chunkMs = 100
    const n = (sr * chunkMs) / 1000
    let fed = 0
    for (let t = 0; t < 600; t++) {  // 60 秒
      const a = new Float32Array(n)
      for (let i = 0; i < n; i++) a[i] = 0.3 * Math.sin((2 * Math.PI * 220 * (t * n + i)) / sr)
      window.api.rec.pushPcm(a, sr)
      fed++
      if (fed % 50 === 0) await new Promise((r) => setTimeout(r, 120))
    }
    return fed
  })()`)
  rec('已喂入合成语音', fed >= 500, `${fed} 块 × 100ms`)
  await sleep(4000)
  const list = servers()
  const models = list.map((l) => (/--model\s+(\S+)/.exec(l)?.[1] || '').split('/').pop())
  rec('起了一个草稿引擎（小模型）', models.some((m) => m.includes('small')), `运行中的 whisper-server: ${JSON.stringify(models)}`)
  rec('主引擎仍是大模型', models.some((m) => m.includes('turbo')), `同上`)
  await dc.evalJs(`(async () => { await window.api.rec.stop(); return true })()`)
  await sleep(1500)
  const after = servers().map((l) => ((/--model\s+(\S+)/.exec(l) || [])[1] || '').split('/').pop())
  rec('停止后：草稿引擎已释放、主引擎常驻（下次秒开）', !after.some((m) => m.includes('small')) && after.some((m) => m.includes('turbo')), `剩余: ${JSON.stringify(after)}`)
} catch (e) { rec('脚本', false, String(e)) } finally {
  try { child.kill('SIGTERM') } catch {}
  await sleep(600)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  process.exit(0)
}
