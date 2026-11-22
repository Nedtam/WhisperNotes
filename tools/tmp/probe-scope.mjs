import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const desk = spawn(path.join(ROOT,'node_modules/.bin/electron'), [path.join(ROOT,'out/main/index.js'),'--remote-debugging-port=9450','--user-data-dir=/tmp/wn-devdata'], {cwd: ROOT})
desk.stderr.on('data',()=>{})
const phone = spawn(path.join(ROOT,'node_modules/.bin/electron'), [path.join(ROOT,'tools/tmp/mobile-shell.cjs'),'--remote-debugging-port=9451','--user-data-dir=/tmp/wn-phone-probe'], {cwd: ROOT})
phone.stderr.on('data',()=>{})
function conn(port){ return (async()=>{ for(let i=0;i<120;i++){ try{ const l=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p=l.find(t=>t.type==='page'); if(p){ const ws=new WebSocket(p.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j)}); let id=0; const pend=new Map(); ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id)}}); const send=(m,pp={})=>new Promise(r=>{const i2=++id;pend.set(i2,r);ws.send(JSON.stringify({id:i2,method:m,params:pp}))}); return {evalJs:async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true,userGesture:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result?.value}} } }catch{} await sleep(500)} throw new Error('cdp '+port) })() }
try {
  const dc = await conn(9450); await sleep(3500)
  const seed = await dc.evalJs(`(async () => {
    for (const n of await window.api.notes.list()) if (/探针范围/.test(n.title)) await window.api.notes.remove(n.id)
    for (const nb of await window.api.notebooks.list()) if (/探针范围/.test(nb.name)) await window.api.notebooks.remove(nb.id)
    const nb = await window.api.notebooks.create('探针范围-课程', null)
    const mk = async (t) => window.api.notes.save({ title: t, noteMd: '## x\\n\\n内容。', sourceText: '', templateId: 'study', notebookId: nb.id, durationMs: 0, tags: [] })
    const a = await mk('探针范围 Week1'); const b = await mk('探针范围 Week2')
    const lib = await (await fetch('http://127.0.0.1:' + (await window.api.mobile.status()).port + '/api/library')).catch(()=>null)
    await window.api.mobile.setEnabled(true)
    const st = await window.api.mobile.status(); const q = await window.api.mobile.qr()
    return { nb: nb.id, port: st.port, code: q.code }
  })()`)
  const pc = await conn(9451); await sleep(2500)
  await pc.evalJs(`(async()=>{ try{localStorage.clear()}catch{}; try{indexedDB.deleteDatabase('whispernotes')}catch{}; location.reload(); return true })()`)
  await sleep(3000)
  await pc.evalJs(`(async () => {
    const setVal=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))}
    const ins=document.querySelectorAll('input'); setVal(ins[0], 'http://127.0.0.1:${seed.port}'); setVal(ins[1], ${JSON.stringify(seed.code)})
    await new Promise(r=>setTimeout(r,300)); [...document.querySelectorAll('button')].find(x=>/Connect to computer|连接电脑/.test(x.textContent)).click()
    await new Promise(r=>setTimeout(r,5000)); return true
  })()`)
  const info = await pc.evalJs(`(async () => {
    const open = indexedDB.open('whispernotes', 1)
    const db = await new Promise((res,rej)=>{open.onsuccess=()=>res(open.result);open.onerror=()=>rej(open.error)})
    const lib = await new Promise((res,rej)=>{const r=db.transaction('kv','readonly').objectStore('kv').get('library');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})
    const nbTab = [...document.querySelectorAll('button')].find(b=>b.getAttribute('data-tab')==='cards'); nbTab.click(); await new Promise(r=>setTimeout(r,1500))
    const sb = [...document.querySelectorAll('button')].find(b=>/Scope|分类范围/.test(b.textContent||'')); if (sb) { sb.click(); await new Promise(r=>setTimeout(r,900)) }
    const rows = [...document.querySelectorAll('button')].map(b=>(b.textContent||'').trim()).filter(x=>/探针范围/.test(x))
    const notesInLib = (lib?.notes||[]).filter(n=>/探针范围/.test(n.title)).map(n=>({t:n.title, nb:n.notebookId}))
    const nbs = (lib?.notebooks||[]).filter(b=>/探针范围/.test(b.name)).map(b=>({n:b.name, id:b.id}))
    return { rows, notesInLib, nbs, totalNotes: (lib?.notes||[]).length }
  })()`)
  console.log(JSON.stringify(info, null, 1))
  await dc.evalJs(`(async()=>{ for(const n of await window.api.notes.list()) if(/探针范围/.test(n.title)) await window.api.notes.remove(n.id); for(const nb of await window.api.notebooks.list()) if(/探针范围/.test(nb.name)) await window.api.notebooks.remove(nb.id); await window.api.mobile.setEnabled(false); return true })()`)
} catch(e){ console.log('probe error', String(e)) } finally { try{desk.kill('SIGTERM');phone.kill('SIGTERM')}catch{} await sleep(500); process.exit(0) }
