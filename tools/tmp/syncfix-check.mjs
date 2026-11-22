// 同步修复验证：
//  ① 电脑端转写"变了"（增强版/状态）→ 手机 resync 必须带过来（旧版只看有没有缓存，永远不更新）
//  ② 电脑端删掉笔记 → 手机本地也跟着删（旧版会一直留着）
//  ③ 电脑 IP 变了 → 手机自动找回：
//     a) 候选地址里还有对的 → 直接切
//     b) 候选全是旧 IP → 扫本地网段找到（用 127.0.0.x 模拟）
import { spawn, execFileSync } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const DESK = 9560
const PHONE = 9561
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => {
  results.push({ n, ok })
  console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`)
}

function connect(port) {
  return (async () => {
    for (let i = 0; i < 160; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const page = l.find((t) => t.type === 'page')
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl)
          await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
          let id = 0
          const pend = new Map()
          const errs = []
          ws.addEventListener('message', (ev) => {
            const m = JSON.parse(ev.data)
            if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) }
            else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
          })
          const send = (method, params = {}) => new Promise((r) => { const i2 = ++id; pend.set(i2, r); ws.send(JSON.stringify({ id: i2, method, params })) })
          return {
            errs,
            evalJs: async (e) => {
              const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true })
              if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
              return r.result?.value
            },
            reload: () => send('Page.reload', { ignoreCache: true })
          }
        }
      } catch { /* retry */ }
      await sleep(500)
    }
    throw new Error('cdp:' + port)
  })()
}

// 手机端：改 localStorage 里的连接（模拟电脑换 IP），再刷新
const patchConn = (pc, patch) => pc.evalJs(`(() => {
  const raw = localStorage.getItem('CapacitorStorage.wn.conn')
  const c = raw ? JSON.parse(raw) : null
  if (!c) return { ok: false, why: 'no-conn' }
  const next = { ...c, ...${'${JSON.stringify(patch)}'} }
  localStorage.setItem('CapacitorStorage.wn.conn', JSON.stringify(next))
  return { ok: true, conn: next }
})()`)

fs.rmSync('/tmp/wn-syncfix', { recursive: true, force: true })
const desk = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${DESK}`, '--user-data-dir=/tmp/wn-syncfix'], { cwd: ROOT })
desk.stderr.on('data', () => {})
let phone = null
setTimeout(() => { try { desk.kill('SIGKILL'); phone?.kill('SIGKILL') } catch { /* ignore */ } process.exit(1) }, 600000).unref?.()

try {
  const dc = await connect(DESK)
  await sleep(4500)

  // 电脑端：造 1 条转写 + 1 条笔记，开服务配好对
  const seed = await dc.evalJs(`(async () => {
    await window.api.mobile.setEnabled(true)
    const tr = await window.api.transcriptions.save({ source: 'import', title: '同步测试-转写', sourceName: 'sync.m4a', rawText: '原始转写文本 '.repeat(40), durationMs: 60000 })
    const note = await window.api.notes.save({ title: '同步测试-笔记', noteMd: '# 笔记\\n\\n内容一', sourceText: 'x', templateId: 'study' })
    const q = await window.api.mobile.qr()
    const st = await window.api.mobile.status()
    return { trId: tr.id, noteId: note.id, port: st.port, code: q.code, urls: st.urls }
  })()`)
  rec('电脑端服务就绪（多地址 + 配对码）', !!seed.code && !!seed.port, JSON.stringify({ port: seed.port, urls: seed.urls }))
  rec('status 暴露本机全部候选地址', Array.isArray(seed.urls) && seed.urls.length >= 1, JSON.stringify(seed.urls))
  const ping = await dc.evalJs(`(async () => { const r = await fetch('http://127.0.0.1:${'${seed.port}'}/api/ping'); return await r.json() })()`.replace('${seed.port}', String(seed.port)))
  rec('/api/ping 带电脑身份 deskId（供局域网找回）', typeof ping.deskId === 'string' && ping.deskId.length > 6, `deskId=${String(ping.deskId).slice(0, 8)}…`)

  // 手机端：配对
  phone = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'tools/tmp/mobile-shell.cjs'), `--remote-debugging-port=${PHONE}`, '--user-data-dir=/tmp/wn-phone'], { cwd: ROOT })
  phone.stderr.on('data', () => {})
  const pc = await connect(PHONE)
  await sleep(2500)
  await pc.evalJs(`(async () => { try { localStorage.clear() } catch {} try { indexedDB.deleteDatabase('whispernotes') } catch {} location.reload(); return true })()`)
  await sleep(3000)
  await pc.evalJs(`(async () => {
    const setVal = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    const inputs = document.querySelectorAll('input')
    setVal(inputs[0], 'http://127.0.0.1:${String(seed.port)}'); setVal(inputs[1], ${JSON.stringify(seed.code)})
    await new Promise(r => setTimeout(r, 300))
    ;[...document.querySelectorAll('button')].find(x => /Connect to computer|连接电脑/.test(x.textContent)).click()
    await new Promise(r => setTimeout(r, 5000))
    return true
  })()`)
  const paired = await pc.evalJs(`(() => { const raw = localStorage.getItem('CapacitorStorage.wn.conn'); const c = raw ? JSON.parse(raw) : null; return c ? { hasDeskId: !!c.deskId, urls: c.urls, baseUrl: c.baseUrl } : null })()`)
  rec('配对后手机存下 deskId + 候选地址', !!paired?.hasDeskId && (paired?.urls ?? []).length >= 1, JSON.stringify(paired))

  // 等首次全量下载完成
  const waitSynced = async (pred, ms = 90000) => {
    const t0 = Date.now()
    for (;;) {
      const ok = await pc.evalJs(pred)
      if (ok) return true
      if (Date.now() - t0 > ms) return false
      await sleep(1000)
    }
  }
  const firstOk = await waitSynced(`(async () => { const open = indexedDB.open('whispernotes', 1); const db = await new Promise((res) => { open.onsuccess = () => res(open.result) }); const lib = await new Promise((res) => { const r = db.transaction('kv','readonly').objectStore('kv').get('library'); r.onsuccess = () => res(r.result) }); return !!lib && (lib.notes || []).length > 0 })()`)
  rec('首次配对后完成全量下载', firstOk === true)

  // ① 电脑端改转写（生成增强版）→ 手机 resync 必须带过来
  const saved = await dc.evalJs(`(async () => {
    await window.api.transcriptions.save({ id: ${JSON.stringify(seed.trId)}, enhancedText: '这是增强版文本 ENHANCED-MARKER', keepEnhanced: false })
    const rec = await window.api.transcriptions.get(${JSON.stringify(seed.trId)})
    const lib = (await window.api.transcriptions.list()).find((t) => t.id === ${JSON.stringify(seed.trId)})
    return { enhanced: rec?.enhancedText ?? null, updatedAt: rec?.updatedAt ?? null, idxUpdatedAt: lib?.updatedAt ?? null }
  })()`)
  rec('电脑端转写确实保存了增强版并更新 updatedAt', /ENHANCED-MARKER/.test(String(saved.enhanced)) && typeof saved.idxUpdatedAt === 'number', JSON.stringify(saved).slice(0, 200))
  await pc.evalJs(`(async () => { window.__wnStore?.getState?.() ; return true })()`)
  // 点「同步内容」
  await pc.evalJs(`(async () => {
    const nav = [...document.querySelectorAll('button')].find(b => b.getAttribute('data-tab') === 'settings'); nav?.click()
    await new Promise(r => setTimeout(r, 800))
    const btn = [...document.querySelectorAll('button')].find(b => /同步内容|Sync now/.test(b.textContent || ''))
    btn?.click()
    return true
  })()`)
  const gotEnhanced = await waitSynced(`(async () => {
    const open = indexedDB.open('whispernotes', 1)
    const db = await new Promise((res) => { open.onsuccess = () => res(open.result) })
    const rec = await new Promise((res) => { const r = db.transaction('kv','readonly').objectStore('kv').get('tr/${'${seed.trId}'}'); r.onsuccess = () => res(r.result) })
    return !!rec && /ENHANCED-MARKER/.test(rec.enhanced || '')
  })()`.replace('${seed.trId}', seed.trId))
  rec('转写更新（增强版）能被 resync 带过来', gotEnhanced === true)
  const diag = await pc.evalJs(`(async () => {
    const open = indexedDB.open('whispernotes', 1)
    const db = await new Promise((res) => { open.onsuccess = () => res(open.result) })
    const kv = (k) => new Promise((res) => { const r = db.transaction('kv','readonly').objectStore('kv').get(k); r.onsuccess = () => res(r.result) })
    const lib = await kv('library')
    const rec = await kv(${JSON.stringify('tr/' + seed.trId)})
    const idx = (lib?.transcripts || []).find((t) => t.id === ${JSON.stringify(seed.trId)})
    return { idxUpdatedAt: idx?.updatedAt, cacheUpdatedAt: rec?.updatedAt, hasEnhanced: !!rec?.enhanced, cacheRawLen: (rec?.raw || '').length, dbg: globalThis.__syncDebug?.transcripts ?? null }
  })()`)
  console.log('   诊断:', JSON.stringify(diag))

  // ② 电脑端删笔记 → 手机本地也要删
  await dc.evalJs(`(async () => { await window.api.notes.remove(${JSON.stringify(seed.noteId)}); return true })()`)
  await pc.evalJs(`(async () => { const btn = [...document.querySelectorAll('button')].find(b => /同步内容|Sync now/.test(b.textContent || '')); btn?.click(); return true })()`)
  const pruned = await waitSynced(`(async () => {
    const open = indexedDB.open('whispernotes', 1)
    const db = await new Promise((res) => { open.onsuccess = () => res(open.result) })
    const rec = await new Promise((res) => { const r = db.transaction('kv','readonly').objectStore('kv').get('note/${'${seed.noteId}'}'); r.onsuccess = () => res(r.result) })
    return rec === undefined || rec === null
  })()`.replace('${seed.noteId}', seed.noteId))
  rec('电脑端删除的笔记在手机本地也被清掉', pruned === true)

  // ③a 候选地址里还有对的：把 baseUrl 改错但 urls 里保留正确地址
  const p1 = await pc.evalJs(`(() => {
    const raw = localStorage.getItem('CapacitorStorage.wn.conn')
    const c = JSON.parse(raw)
    const correct = c.baseUrl
    const next = { ...c, baseUrl: 'http://127.0.0.1:59999', urls: Array.from(new Set(['http://127.0.0.1:59999', correct, ...(c.urls || [])])) }
    localStorage.setItem('CapacitorStorage.wn.conn', JSON.stringify(next))
    location.reload()
    return true
  })()`)
  await sleep(6000)
  const recoveredCandidate = await waitSynced(`(() => { const raw = localStorage.getItem('CapacitorStorage.wn.conn'); const c = raw ? JSON.parse(raw) : null; return !!c && !/59999/.test(c.baseUrl) })()`, 90000)
  rec('IP 变了：靠候选地址自动切回电脑', recoveredCandidate === true)

  // ③b 候选全是旧 IP：必须靠扫网段找回（用 127.0.0.9 模拟"看起来通但没服务"的地址）
  await pc.evalJs(`(() => {
    const raw = localStorage.getItem('CapacitorStorage.wn.conn')
    const c = JSON.parse(raw)
    const next = { ...c, baseUrl: 'http://127.0.0.9:${String(seed.port)}', urls: ['http://127.0.0.9:${String(seed.port)}'] }
    localStorage.setItem('CapacitorStorage.wn.conn', JSON.stringify(next))
    location.reload()
    return true
  })()`)
  await sleep(6000)
  const recoveredScan = await waitSynced(`(() => { const raw = localStorage.getItem('CapacitorStorage.wn.conn'); const c = raw ? JSON.parse(raw) : null; return !!c && !/127\\.0\\.0\\.9:/.test(c.baseUrl) })()`, 120000)
  rec('候选地址全失效：扫本地网段把电脑找回来', recoveredScan === true)

  rec('无渲染层异常', pc.errs.length === 0, pc.errs.slice(0, 2).join(' | '))
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try { desk.kill('SIGTERM'); phone?.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(800)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  process.exit(0)
}
