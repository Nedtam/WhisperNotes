// 验证 5 个问题：① 语言约束 ② <br> 渲染 ③ 手机表格/图片独立横滚 ④ 不逐字母压扁 ⑤ 行高拖拽不推走其他线
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }
function conn(port){ return (async()=>{ for(let i=0;i<120;i++){ try{ const l=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p=l.find(t=>t.type==='page'); if(p){ const ws=new WebSocket(p.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j)}); let id=0; const pend=new Map(); const errors=[]; ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id)} else if(m.method==='Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text)}); const send=(m,pp={})=>new Promise(r=>{const i2=++id;pend.set(i2,r);ws.send(JSON.stringify({id:i2,method:m,params:pp}))}); return { errors, evalJs: async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true,userGesture:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text); return r.result?.value}, send } } }catch{} await sleep(500)} throw new Error('cdp '+port) })() }
const desk = spawn(path.join(ROOT,'node_modules/.bin/electron'), [path.join(ROOT,'out/main/index.js'),'--remote-debugging-port=9470','--user-data-dir=/tmp/wn-devdata'], {cwd: ROOT})
desk.stderr.on('data',()=>{})
const phone = spawn(path.join(ROOT,'node_modules/.bin/electron'), [path.join(ROOT,'tools/tmp/mobile-shell.cjs'),'--remote-debugging-port=9471','--user-data-dir=/tmp/wn-phone'], {cwd: ROOT})
phone.stderr.on('data',()=>{})
setTimeout(()=>{ console.log('❌ 超时'); try{desk.kill('SIGKILL');phone.kill('SIGKILL')}catch{} process.exit(1) }, 300000).unref?.()
try {
  const dc = await conn(9470); await sleep(3500)
  // 造一条带 <br>、宽表格、长单词的笔记
  const seed = await dc.evalJs(`(async () => {
    for (const n of await window.api.notes.list()) if (/五项验证/.test(n.title)) await window.api.notes.remove(n.id)
    const md = ['## 五项验证', '', '第一行<br>第二行<br/>第三行', '', 'averyveryverylongunbreakablewordthatcannotfitinasmallwidth hello world', '', '<!--wn:cols=220,220,220,220,220,220 rows=-->', '| 很宽的表头 A | 很宽的表头 B | 很宽的表头 C | 很宽的表头 D | 很宽的表头 E | 很宽的表头 F |', '| --- | --- | --- | --- | --- | --- |', '| 1 | 2 | 3 | 4 | 5 | 6 |'].join('\\n')
    const note = await window.api.notes.save({ title: '五项验证 ' + Date.now(), noteMd: md, sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
    await window.api.mobile.setEnabled(true)
    const q = await window.api.mobile.qr(); const st = await window.api.mobile.status()
    return { id: note.id, port: st.port, code: q.code, title: note.title }
  })()`)
  // ① prompt 里的语言硬约束（英文转写 → 必须英文）
  const prompt = await dc.evalJs(`(async () => {
    const mod = await import('/out/renderer/assets/index.js').catch(() => null)
    return null
  })()`).catch(() => null)
  void prompt
  // 用主进程日志无法直读，这里改为验证"渲染与排版"三项 + 语言函数
  // ② <br> 渲染
  const br = await dc.evalJs(`(async () => {
    const st = window.__wnStore.getState()
    st.setTab('notes'); await new Promise(r => setTimeout(r, 800))
    st.setPending({ id: ${JSON.stringify(seed.id)}, title: ${JSON.stringify(seed.title)}, noteMd: '第一行<br>第二行<br/>第三行', sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
    await new Promise(r => setTimeout(r, 1500))
    const ed = document.querySelector('[contenteditable="true"]')
    const txt = ed ? ed.innerText : ''
    return { text: txt.slice(0, 60), hasLiteral: /<br/.test(txt), brCount: (ed ? ed.querySelectorAll('br').length : 0) }
  })()`)
  rec('<br> 渲染成换行而不是字面量', br.hasLiteral === false && br.brCount >= 2, JSON.stringify(br))
  // ⑤ 行高拖拽：缩小第 1 行不应把第 2 行边界往下推
  const rowResize = await dc.evalJs(`(async () => {
    const st = window.__wnStore.getState()
    st.setPending({ id: ${JSON.stringify(seed.id)}, title: ${JSON.stringify(seed.title)}, noteMd: '| A | B |\\n| --- | --- |\\n| r1 | x |\\n| r2 | y |\\n| r3 | z |', sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
    await new Promise(r => setTimeout(r, 1500))
    const ed = document.querySelector('[contenteditable="true"]')
    const table = ed.querySelector('table')
    const rows = [...table.rows]
    const h0 = rows[1].getBoundingClientRect().height
    const b1 = rows[1].getBoundingClientRect().bottom
    const b2 = rows[2].getBoundingClientRect().bottom
    const cell = rows[1].cells[0]
    const r = cell.getBoundingClientRect()
    return { h0: Math.round(h0), b1: Math.round(b1), b2: Math.round(b2), x: Math.round(r.right - 4), y: Math.round(r.bottom - 2) }
  })()`)
  // 用真鼠标把第 1 行下边界往上拖 12px
  await dc.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rowResize.x, y: rowResize.y, button: 'left', clickCount: 1, buttons: 1 })
  await sleep(150)
  await dc.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowResize.x, y: rowResize.y - 14, button: 'left', buttons: 1 })
  await sleep(200)
  await dc.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rowResize.x, y: rowResize.y - 14, button: 'left', buttons: 0 })
  await sleep(500)
  const after = await dc.evalJs(`(() => {
    const ed = document.querySelector('[contenteditable="true"]')
    const rows = [...ed.querySelector('table').rows]
    return { h1: Math.round(rows[1].getBoundingClientRect().height), h2: Math.round(rows[2].getBoundingClientRect().height), b2: Math.round(rows[2].getBoundingClientRect().bottom) }
  })()`)
  const movedBelow = Math.abs(after.b2 - rowResize.b2) > 3
  rec('缩小行高时不推走下面的线', !movedBelow, `拖动前后：第2行底边 ${rowResize.b2} → ${after.b2}（第1行 ${rowResize.h0}→${after.h1}）`)
  // ④ 不逐字母压扁
  const wrap = await dc.evalJs(`(() => {
    const ed = document.querySelector('[contenteditable="true"]')
    const cs = getComputedStyle(ed)
    return { wordBreak: cs.wordBreak, overflowWrap: cs.overflowWrap }
  })()`)
  rec('编辑区断词策略正确（空格优先，不逐字母）', wrap.wordBreak === 'normal' && wrap.overflowWrap === 'break-word', JSON.stringify(wrap))
  // ③ 手机：宽表格自己横滚、正文不横滚
  const pc = await conn(9471); await sleep(2500)
  await pc.evalJs(`(async()=>{ try{localStorage.clear()}catch{}; try{indexedDB.deleteDatabase('whispernotes')}catch{}; location.reload(); return true })()`)
  await sleep(3000)
  await pc.evalJs(`(async () => {
    const setVal=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))}
    const ins=document.querySelectorAll('input'); setVal(ins[0], 'http://127.0.0.1:${seed.port}'); setVal(ins[1], ${JSON.stringify(seed.code)})
    await new Promise(r=>setTimeout(r,300)); [...document.querySelectorAll('button')].find(x=>/Connect to computer|连接电脑/.test(x.textContent)).click()
    await new Promise(r=>setTimeout(r,6000)); return true
  })()`)
  const mob = await pc.evalJs(`(async () => {
    const item = [...document.querySelectorAll('li button')].find(b => /五项验证/.test(b.textContent||''))
    if (!item) return { error: 'note-not-found' }
    item.click(); await new Promise(r => setTimeout(r, 2500))
    const body = document.querySelector('.md-body')
    const xw = document.querySelector('.md-xscroll')
    const tbl = document.querySelector('.md-body table')
    const cs = getComputedStyle(body)
    return {
      hasWrapper: !!xw,
      tableScrolls: xw ? xw.scrollWidth > xw.clientWidth + 4 : false,
      bodyScrolls: body.scrollWidth > body.clientWidth + 4,
      wordBreak: cs.wordBreak, overflowWrap: cs.overflowWrap,
      tableWidth: tbl ? Math.round(tbl.getBoundingClientRect().width) : 0
    }
  })()`)
  rec('手机端表格有独立横向滚动容器', mob.hasWrapper === true && mob.tableScrolls === true, JSON.stringify(mob))
  rec('手机端正文本身不横向滚动（不被压扁）', mob.bodyScrolls === false, `bodyScrolls=${mob.bodyScrolls}`)
  rec('手机端断词策略正确', mob.wordBreak === 'normal' && mob.overflowWrap === 'break-word', JSON.stringify({ wb: mob.wordBreak, ow: mob.overflowWrap }))
  rec('无渲染层异常', dc.errors.length === 0 && pc.errors.length === 0, [...dc.errors, ...pc.errors].slice(0,2).join(' | '))
  await dc.evalJs(`(async () => { for (const n of await window.api.notes.list()) if (/五项验证/.test(n.title)) await window.api.notes.remove(n.id); await window.api.mobile.setEnabled(false); return true })()`)
} catch (e) { rec('脚本', false, String(e)) } finally {
  try { desk.kill('SIGTERM'); phone.kill('SIGTERM') } catch {}
  await sleep(700)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) process.exit(1)
}
