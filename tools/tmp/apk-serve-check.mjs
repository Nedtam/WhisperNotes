// 验证：桌面 App 局域网"下载 Android App"给出的确实是新版 APK（0.1.2）
import { spawn, execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const UD = '/tmp/wn-apk'
fs.rmSync(UD, { recursive: true, force: true }); fs.mkdirSync(UD, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), '--remote-debugging-port=9566', `--user-data-dir=${UD}`], { cwd: ROOT })
child.stderr.on('data', () => {})
const conn = async () => { for (let i = 0; i < 120; i++) { try { const l = await (await fetch('http://127.0.0.1:9566/json/list')).json(); const p = l.find((t) => t.type === 'page'); if (p) { const ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) }); let n = 0; const pend = new Map(); ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) } }); const send = (method, params = {}) => new Promise((r) => { const i2 = ++n; pend.set(i2, r); ws.send(JSON.stringify({ id: i2, method, params })) }); return { evalJs: async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value } } } } catch {} await sleep(500) } throw new Error('cdp') }
try {
  const dc = await conn()
  await sleep(4500)
  const st = await dc.evalJs(`(async () => { await window.api.mobile.setEnabled(true); const q = await window.api.mobile.qr(); const s = await window.api.mobile.status(); return { port: s.port, code: q.code, url: q.url } })()`)
  const base = `http://127.0.0.1:${st.port}`
  const head = await fetch(`${base}/apk`, { method: 'GET' })
  const buf = Buffer.from(await head.arrayBuffer())
  const hash = crypto.createHash('sha256').update(buf).digest('hex')
  const file = '/tmp/served.apk'
  fs.writeFileSync(file, buf)
  const aapt = `${process.env.HOME}/Library/Android/sdk/build-tools/36.0.0/aapt`
  const badging = execFileSync(aapt, ['dump', 'badging', file], { encoding: 'utf8' }).split('\n')[0]
  const local = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'release/WhisperNotes-android.apk'))).digest('hex')
  console.log('状态:', head.status, '| 字节:', buf.length, '| served sha:', hash.slice(0, 12), '| local sha:', local.slice(0, 12))
  console.log('served APK:', badging)
  const results = []
  const rec = (n, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }
  rec('局域网能下载到安装包', head.status === 200 && buf.length > 1_000_000, `HTTP ${head.status} · ${buf.length} 字节`)
  rec('下载到的就是 release 里那份新包', hash === local, `served=${hash.slice(0, 12)} local=${local.slice(0, 12)}`)
  rec('安装包版本与 mobile 一致（不是旧的 0.1.0）', /versionName='0\.1\.2'/.test(badging), badging.slice(0, 80))
  const bad = results.filter((x) => !x).length
  console.log(`\n结果: ${results.length - bad}/${results.length} 通过`)
} catch (e) { console.log('ERR', e.message) } finally { try { child.kill('SIGTERM') } catch {} await sleep(500); process.exit(0) }
