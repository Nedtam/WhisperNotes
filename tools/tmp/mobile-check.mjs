// 阶段 2 验证：局域网服务 + 配对 + 只读接口 + 鉴权 + 设置面板二维码
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9358
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
child.stderr.on('data', (d) => process.stderr.write('[el] ' + d))
setTimeout(() => {
  console.log('❌ 脚本超时')
  try {
    child.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  process.exit(1)
}, 180000).unref?.()

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

  // 1) 通过真实 IPC 打开服务
  const st0 = await cdp.evalJs(`(async () => await window.api.mobile.setEnabled(true))()`)
  rec('开启手机连接（IPC）', st0.running === true, `port=${st0.port} urls=${JSON.stringify(st0.urls)}`)
  const port = st0.port
  const base = `http://127.0.0.1:${port}`

  // 2) 探活（免鉴权）
  const ping = await (await fetch(`${base}/api/ping`)).json()
  rec('GET /api/ping 免鉴权可用', ping.ok === true && ping.app === 'WhisperNotes', JSON.stringify(ping))

  // 3) 未配对访问数据接口必须 401
  const unauth = await fetch(`${base}/api/library`)
  rec('未带令牌访问 /api/library 被拒 (401)', unauth.status === 401, `status=${unauth.status}`)

  // 3b) CORS 预检（手机 WebView 跨源必需）
  const pre = await fetch(`${base}/api/pair`, { method: 'OPTIONS' })
  const preOrigin = pre.headers.get('access-control-allow-origin')
  rec('配对接口支持 CORS 预检', pre.status === 204 && preOrigin === '*', `status=${pre.status} allow-origin=${preOrigin}`)

  // 4) 取配对码（含二维码 SVG）
  const qr = await cdp.evalJs(`(async () => await window.api.mobile.qr())()`)
  rec('生成配对二维码', qr.ok === true && qr.svg.includes('<svg') && !!qr.code, `code=${qr.code} svg=${qr.svg?.length}B url=${qr.url}`)

  // 5) 错误配对码被拒
  const bad = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'deadbeef', device: 'Test Phone' })
  })
  rec('错误配对码被拒 (401)', bad.status === 401, `status=${bad.status}`)

  // 6) 正确配对码换取设备令牌
  const pair = await (
    await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: qr.code, device: 'Test Phone' })
    })
  ).json()
  rec('正确配对码换取令牌', pair.ok === true && typeof pair.token === 'string' && pair.token.length >= 32, `deviceId=${pair.deviceId}`)
  const token = pair.token

  // 7) 配对码一次性
  const reuse = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: qr.code, device: 'Second Phone' })
  })
  rec('配对码一次性（复用被拒）', reuse.status === 401, `status=${reuse.status}`)

  // 8) 带令牌读取文库
  const lib = await (await fetch(`${base}/api/library`, { headers: { Authorization: `Bearer ${token}` } })).json()
  const dbCount = await cdp.evalJs(`(async () => (await window.api.notes.list()).length)()`)
  rec('带令牌读取文库', lib.ok === true && lib.notes.length === dbCount, `notes=${lib.notes?.length} notebooks=${lib.notebooks?.length} transcripts=${lib.transcripts?.length} (DB=${dbCount})`)
  rec('文库元数据不含正文（只给摘要）', lib.notes.every((n) => !('noteMd' in n) && typeof n.excerpt === 'string'))

  // 9) 取单篇笔记 / 单条转写
  const noteId = lib.notes[0].id
  const note = await (await fetch(`${base}/api/note/${noteId}`, { headers: { Authorization: `Bearer ${token}` } })).json()
  rec('读取单篇笔记正文', note.ok === true && note.noteMd.length > 0, `title=${note.title} md=${note.noteMd.length}字`)
  let trOk = 'skipped'
  if (lib.transcripts.length) {
    const tr = await (await fetch(`${base}/api/transcript/${lib.transcripts[0].id}`, { headers: { Authorization: `Bearer ${token}` } })).json()
    trOk = tr.ok === true && tr.raw.length > 0
    rec('读取单条转写', trOk === true, `title=${tr.title} raw=${tr.raw?.length} 增强=${tr.enhanced ? tr.enhanced.length : '无'}`)
  } else rec('读取单条转写', true, '（隔离库无转写，跳过）')

  // 9b) 局域网 IP 也能访问（真机扫码走的就是这个地址）
  const st0b = await cdp.evalJs(`(async () => await window.api.mobile.status())()`)
  const lanUrl = st0b.urls[0]
  let lanOk = false
  try {
    const r = await fetch(`${lanUrl}/api/ping`, { signal: AbortSignal.timeout(4000) })
    lanOk = (await r.json()).ok === true
  } catch {
    lanOk = false
  }
  rec('局域网地址可访问（手机走的就是它）', lanOk, lanUrl)

  // 9c) 局域网直传 APK
  const apkRes = await fetch(`${base}/apk`)
  const apkLen = Number(apkRes.headers.get('content-length') || 0)
  rec('局域网直传 APK 可下载', apkRes.ok && apkLen > 1_000_000, `status=${apkRes.status} ${(apkLen / 1048576).toFixed(1)}MB type=${apkRes.headers.get('content-type')}`)

  // 10) 二维码落地页
  const page = await (await fetch(`${base}/p?t=${qr.code}`)).text()
  rec('扫码落地页可用（含直传下载与深链）', page.includes('WhisperNotes') && page.includes('whispernotes://pair') && page.includes('/apk'), `${page.length}B`)

  // 11) 状态里能看到已配对设备
  const st1 = await cdp.evalJs(`(async () => await window.api.mobile.status())()`)
  const paired = st1.devices.find((d) => d.id === pair.deviceId)
  rec('状态显示本次配对的设备', !!paired && paired.name === 'Test Phone', `共 ${st1.devices.length} 台：${st1.devices.map((d) => d.name).join(', ')}`)

  // 12) 设置页 UI：面板 + 二维码 svg
  const ui = await cdp.evalJs(`(async () => {
    const st = window.__wnStore.getState()
    st.setTab('settings')
    await new Promise(r => setTimeout(r, 1500))
    const txt = document.body.innerText
    const btns = [...document.querySelectorAll('button')]
    return { tab: window.__wnStore.getState().tab, panel: /手机连接|Phone connection/.test(txt), hasToggle: /打开手机连接|Enable phone connection/.test(txt), svgBefore: !!document.querySelector('svg'), buttons: btns.length, head: txt.slice(0, 80) }
  })()`)
  const ui2 = await cdp.evalJs(`(async () => {
    const sec = [...document.querySelectorAll('section')].find(s => /手机连接|Phone connection/.test(s.textContent||''))
    if (!sec) return { error: 'no-section' }
    const sw = sec.querySelector('[role="switch"]')
    if (sw && sw.getAttribute('aria-checked') !== 'true') { sw.click(); await new Promise(r => setTimeout(r, 1800)) }
    const btns = [...sec.querySelectorAll('button')]
    const b = btns.find(x => /配对二维码|pairing QR|换一个配对码|New pairing code/i.test(x.textContent || ''))
    if (b) { b.click(); await new Promise(r => setTimeout(r, 1500)) }
    const svgs = [...document.querySelectorAll('svg')]
    return {
      checked: !!sw && sw.getAttribute('aria-checked'),
      clicked: !!b,
      buttonText: b ? (b.textContent||'').trim() : null,
      svgCount: svgs.length,
      bigSvg: svgs.some(s => (s.getBoundingClientRect().height || 0) > 120),
      panelHead: (sec.textContent||'').slice(0, 160)
    }
  })()`)
  rec('设置页出现手机连接面板', ui.panel && ui.hasToggle, JSON.stringify(ui))
  rec('面板内二维码渲染出来', ui2.clicked && ui2.bigSvg, JSON.stringify(ui2))
  rec('设置页出现手机连接面板', ui.panel && ui.hasToggle, JSON.stringify(ui))

  // 13) 撤销设备后令牌失效
  await cdp.evalJs(`(async () => { const st = await window.api.mobile.status(); for (const d of st.devices) await window.api.mobile.revoke(d.id); return true })()`)
  const afterRevoke = await fetch(`${base}/api/library`, { headers: { Authorization: `Bearer ${token}` } })
  rec('撤销设备后令牌立即失效', afterRevoke.status === 401, `status=${afterRevoke.status}`)

  // 14) 关闭服务后端口不再监听
  const st2 = await cdp.evalJs(`(async () => await window.api.mobile.setEnabled(false))()`)
  let closed = false
  try {
    await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(1500) })
  } catch {
    closed = true
  }
  rec('关闭后不再响应', st2.running === false && closed, `running=${st2.running} closed=${closed}`)

  rec('无渲染层异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | '))
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  await sleep(600)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) process.exit(1)
}
