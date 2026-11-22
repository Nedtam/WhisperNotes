import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function conn(port){ return (async()=>{ for(let i=0;i<120;i++){ try{ const l=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p=l.find(t=>t.type==='page'); if(p){ const ws=new WebSocket(p.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j)}); let id=0; const pend=new Map(); ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id)}}); const send=(m,pp={})=>new Promise(r=>{const i2=++id;pend.set(i2,r);ws.send(JSON.stringify({id:i2,method:m,params:pp}))}); return { evalJs: async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true,userGesture:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text); return r.result?.value} } } }catch{} await sleep(500)} throw new Error('cdp '+port) })() }
const desk = spawn(path.join(ROOT,'node_modules/.bin/electron'), [path.join(ROOT,'out/main/index.js'),'--remote-debugging-port=9480','--user-data-dir=/tmp/wn-devdata'], {cwd: ROOT})
desk.stderr.on('data',()=>{})
const phone = spawn(path.join(ROOT,'node_modules/.bin/electron'), [path.join(ROOT,'tools/tmp/mobile-shell.cjs'),'--remote-debugging-port=9481','--user-data-dir=/tmp/wn-phone-probe2'], {cwd: ROOT})
phone.stderr.on('data',()=>{})
setTimeout(()=>{ console.log('timeout'); try{desk.kill('SIGKILL');phone.kill('SIGKILL')}catch{} process.exit(1) }, 240000).unref?.()
try {
  const dc = await conn(9480); await sleep(3500)
  const seed = await dc.evalJs(`(async () => {
    for (const n of await window.api.notes.list()) if (/探针2/.test(n.title)) await window.api.notes.remove(n.id)
    for (const nb of await window.api.notebooks.list()) if (/探针2/.test(nb.name)) await window.api.notebooks.remove(nb.id)
    const nb = await window.api.notebooks.create('探针2-课程', null)
    const mk = async (t) => window.api.notes.save({ title: t, noteMd: '## x\\n\\n内容。', sourceText: '', templateId: 'study', notebookId: nb.id, durationMs: 0, tags: [] })
    const a = await mk('探针2 Week1'); await mk('探针2 Week2')
    const libCheck = await window.api.notes.list()
    await window.api.mobile.setEnabled(true)
    const st = await window.api.mobile.status(); const q = await window.api.mobile.qr()
    return { nb: nb.id, notes: libCheck.filter(n=>/探针2/.test(n.title)).map(n=>n.title+':'+String(n.notebookId).slice(0,6)), port: st.port, code: q.code }
  })()`)
  console.log('桌面侧笔记:', JSON.stringify(seed.notes), 'port', seed.port)
  // 直接看服务端 /api/library 返回什么
  const pair = await (await fetch(`http://127.0.0.1:${seed.port}/api/pair`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:seed.code,device:'probe'})})).json()
  const lib = await (await fetch(`http://127.0.0.1:${seed.port}/api/library`, {headers:{Authorization:'Bearer '+pair.token}})).json()
  console.log('服务端 library:', JSON.stringify({ notes: (lib.notes||[]).filter(n=>/探针2/.test(n.title)).map(n=>n.title+':'+String(n.notebookId).slice(0,6)), nbs: (lib.notebooks||[]).filter(b=>/探针2/.test(b.name)).map(b=>b.name) }))
  // 注意：上面用 HTTP 配对消耗了一次性码 → 给手机重新生成一个
  const fresh = await dc.evalJs(`(async () => { const q = await window.api.mobile.qr(); return { code: q.code } })()`)
  seed.code = fresh.code
  console.log('给手机的新配对码:', fresh.code)
  const pc = await conn(9481); await sleep(2500)
  await pc.evalJs(`(async()=>{ try{localStorage.clear()}catch{}; try{indexedDB.deleteDatabase('whispernotes')}catch{}; location.reload(); return true })()`)
  await sleep(3000)
  await pc.evalJs(`(async () => {
    const setVal=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))}
    const ins=document.querySelectorAll('input'); setVal(ins[0], 'http://127.0.0.1:${seed.port}'); setVal(ins[1], ${JSON.stringify(seed.code)})
    await new Promise(r=>setTimeout(r,300)); [...document.querySelectorAll('button')].find(x=>/Connect to computer|连接电脑/.test(x.textContent)).click()
    await new Promise(r=>setTimeout(r,9000)); return true
  })()`)
  const dump = await pc.evalJs(`(async () => {
    const open = indexedDB.open('whispernotes', 1)
    const db = await new Promise((res,rej)=>{open.onsuccess=()=>res(open.result);open.onerror=()=>rej(open.error)})
    const keys = await new Promise((res,rej)=>{const r=db.transaction('kv','readonly').objectStore('kv').getAllKeys();r.onsuccess=()=>res(r.result.map(String));r.onerror=()=>rej(r.error)})
    const lib = await new Promise((res,rej)=>{const r=db.transaction('kv','readonly').objectStore('kv').get('library');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})
    const nbTab=[...document.querySelectorAll('button')].find(b=>b.getAttribute('data-tab')==='cards'); nbTab.click(); await new Promise(r=>setTimeout(r,1500))
    const sb=[...document.querySelectorAll('button')].find(b=>/Scope|分类范围/.test(b.textContent||'')); if(sb){sb.click(); await new Promise(r=>setTimeout(r,900))}
    const rows=[...document.querySelectorAll('button')].map(b=>(b.textContent||'').trim()).filter(x=>/探针2/.test(x))
    const checks=document.querySelectorAll('input[type=checkbox]').length
    return {
      origin: location.origin,
      idbKeys: keys.slice(0, 8),
      libNotes: (lib?.notes||[]).length,
      libNbs: (lib?.notebooks||[]).length,
      libSample: (lib?.notes||[]).filter(n=>/探针2/.test(n.title)).map(n=>n.title+':'+String(n.notebookId).slice(0,6)),
      rows, checks
    }
  })()`)
  console.log(JSON.stringify(dump, null, 1))
  await dc.evalJs(`(async()=>{ for(const n of await window.api.notes.list()) if(/探针2/.test(n.title)) await window.api.notes.remove(n.id); for(const nb of await window.api.notebooks.list()) if(/探针2/.test(nb.name)) await window.api.notebooks.remove(nb.id); await window.api.mobile.setEnabled(false); return true })()`)
} catch(e){ console.log('probe error', String(e).slice(0,300)) } finally { try{desk.kill('SIGTERM');phone.kill('SIGTERM')}catch{} await sleep(500); process.exit(0) }
