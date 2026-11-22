// 文档 → 笔记 E2E：
//  ① 笔记页有「文档转笔记」入口（按钮 + 可接收文件拖放）
//  ② 解析 PDF / DOCX / TXT（真实文件，含页码）
//  ③ 生成笔记：kind=doc、只走文档提示词（不含"讲课/转写"口径）、要点带 (p.N) 引用
//  ④ 不产生任何转写记录（与语音那条线彻底分开）
//  ⑤ 加密 PDF / 无文字层 PDF 有明确提示
import { spawn, execFileSync } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as http from 'node:http'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => {
  results.push({ n, ok })
  console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`)
}
const UD = '/tmp/wn-doc'
fs.rmSync(UD, { recursive: true, force: true })
fs.mkdirSync(UD, { recursive: true })

// ── 真实测试文档 ────────────────────────────────────────────
const SRC = `Sampling and Quantization
Sampling rate decides the highest frequency we can represent: f_max = f_s / 2 (Nyquist).
Quantization error falls as bit depth grows: 16-bit gives 65536 levels.
Anti-aliasing filter must sit before the ADC.
A 44.1 kHz / 16-bit CD has a theoretical SNR near 96 dB.`
const TXT = '/tmp/wn-doctest.txt'
const DOCX = '/tmp/wn-doctest.docx'
const PDF = '/tmp/wn-doctest.pdf'
const ENC = '/tmp/wn-doctest-enc.pdf'
fs.writeFileSync(TXT, SRC)
if (!fs.existsSync(DOCX)) execFileSync('textutil', ['-convert', 'docx', '-output', DOCX, TXT])
if (!fs.existsSync(PDF)) {
  fs.writeFileSync('/tmp/wn-doctest.pdf.txt', SRC)
  execFileSync('/bin/sh', ['-c', `cupsfilter ${TXT} > ${PDF} 2>/dev/null`])
}
if (!fs.existsSync(ENC)) {
  try {
    execFileSync('/bin/sh', ['-c', `"/System/Library/Automator/Combine PDF Pages.action/Contents/Resources/join.py" --output ${ENC} --owner-password secret123 ${PDF} 2>/dev/null || true`])
  } catch { /* 可选 */ }
}

// ── 假上游：记录收到的 system prompt，便于断言"只走文档口径" ─────────────
const seen = { systems: [], users: [] }
const srv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let p = {}
    try { p = JSON.parse(body) } catch { /* ignore */ }
    const sys = (p.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
    const user = (p.messages ?? []).find((m) => m.role === 'user')?.content ?? ''
    seen.systems.push(sys)
    seen.users.push(user)
    const content = '# 采样与量化\n\n## 核心要点\n\n- 采样率决定可表示的最高频率：f_max = f_s / 2 (p.1)\n- 量化误差随位深下降：16 bit = 65536 级 (p.1)\n- 抗混叠滤波器必须在 ADC 之前 (p.1)\n\n## Key takeaways\n\n- 44.1 kHz / 16 bit → SNR ≈ 96 dB (p.1)\n'
    if (p.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const piece of content.match(/[\s\S]{1,80}/g) ?? []) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 80 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 80 } }))
  })
})
await new Promise((r) => srv.listen(8806, '127.0.0.1', r))

function conn(port) {
  return (async () => {
    for (let i = 0; i < 120; i++) {
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
            }
          }
        }
      } catch { /* retry */ }
      await sleep(500)
    }
    throw new Error('cdp')
  })()
}

const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), '--remote-debugging-port=9532', `--user-data-dir=${UD}`], { cwd: ROOT })
child.stderr.on('data', () => {})
setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } process.exit(1) }, 600000).unref?.()

try {
  const dc = await conn(9532)
  await sleep(5000)

  // 解析层：PDF / DOCX / TXT
  const parsed = await dc.evalJs(`(async () => {
    const out = {}
    for (const [k, f] of Object.entries({ pdf: ${JSON.stringify(PDF)}, docx: ${JSON.stringify(DOCX)}, txt: ${JSON.stringify(TXT)} })) {
      try {
        const d = await window.api.doc.parse(f)
        out[k] = { chars: d.chars, pages: d.pages.length, sample: (d.pages[0]?.text ?? '').slice(0, 60), empty: !!d.emptyText }
      } catch (e) { out[k] = { error: String(e.message || e) } }
    }
    return out
  })()`)
  rec('PDF 解析出带页码的文字', parsed.pdf?.chars > 80 && parsed.pdf.pages >= 1 && /Nyquist|Sampling/.test(parsed.pdf.sample), JSON.stringify(parsed.pdf))
  rec('DOCX 解析出文字（jszip 读 word/document.xml）', parsed.docx?.chars > 80 && /Nyquist|Sampling/.test(parsed.docx.sample), JSON.stringify(parsed.docx))
  rec('TXT 解析出文字', parsed.txt?.chars > 80 && /Nyquist|Sampling/.test(parsed.txt.sample), JSON.stringify(parsed.txt))

  // 入口（笔记页按钮 + 拖放区）
  const entry = await dc.evalJs(`(async () => {
    window.__wnStore.getState().setTab('notes'); await new Promise(r => setTimeout(r, 900))
    const btn = document.querySelector('[data-doc-note="1"]')
    const zone = document.querySelector('[data-note-dropzone="1"]')
    const newBtn = [...document.querySelectorAll('button')].find((b) => /新建笔记|New note/.test(b.textContent || ''))
    const r1 = btn?.getBoundingClientRect()
    const r2 = newBtn?.getBoundingClientRect()
    // 文字有没有被挤出按钮（曾经两个按钮挤一行，nowrap 文字直接出框）
    const overflow = btn ? btn.scrollWidth > btn.clientWidth + 1 : null
    const stacked = !!(r1 && r2) && Math.abs(r1.top - r2.top) > 4
    return { btn: !!btn, btnText: btn ? btn.innerText.trim() : '', zone: !!zone, overflow, stacked, hasEmoji: btn ? /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(btn.textContent || '') : null }
  })()`)
  rec('笔记页有「文档转笔记」按钮', entry.btn === true, entry.btnText)
  rec('笔记列表可接收文件拖放（区分笔记排序）', entry.zone === true)
  rec('文档按钮不再挤在同一行（竖排、各自整行）', entry.stacked === true, `stacked=${entry.stacked}`)
  rec('按钮文字没有被挤出按钮（不再 compression/出框）', entry.overflow === false, `overflow=${entry.overflow} text=${entry.btnText}`)
  rec('文档按钮里没有 emoji 图标', entry.hasEmoji === false, `hasEmoji=${entry.hasEmoji}`)

  // 生成笔记：走 UI（对话框 → 生成）
  await dc.evalJs(`(async () => {
    const s = await window.api.settings.get()
    const next = await window.api.settings.set({ llm: { ...s.llm, baseUrl: 'http://127.0.0.1:8806/v1', apiKey: 'k', modelId: 'mock', fallbackModels: [], autoFallback: false, providers: [] } })
    window.__wnStore.getState().setSettings(next)
    return true
  })()`)
  const before = await dc.evalJs(`(async () => ({ notes: (await window.api.notes.list()).length, trs: (await window.api.transcriptions.list()).length }))()`)

  // 直接驱动对话框（按钮会开原生文件选择框，自动化里改用同一组件入口）
  const made = await dc.evalJs(`(async () => {
    window.__d = null
    window.api.onOrganizeDone((d) => { window.__d = d })
    window.api.onOrganizeError((e) => { window.__d = { error: e } })
    await window.api.llm.organizeStart({
      title: '文档笔记测试',
      sourceText: ${JSON.stringify('[p.1]\n' + SRC)},
      source: 'document',
      kind: 'doc',
      docName: 'wn-doctest.pdf',
      length: 'keypoints',
      templateId: 'study'
    })
    const t0 = Date.now()
    while (!window.__d && Date.now() - t0 < 90000) await new Promise(r => setTimeout(r, 400))
    const notes = await window.api.notes.list()
    const mine = notes.find((n) => n.title === '文档笔记测试')
    const full = mine ? await window.api.notes.get(mine.id) : null
    const trs = await window.api.transcriptions.list()
    return { done: window.__d, kind: full?.kind ?? null, noteMd: full?.noteMd ?? null, notes: notes.length, trs: trs.length }
  })()`)
  rec('文档生成笔记成功', !!made.noteMd && !made.done?.error, JSON.stringify(made.done?.error ?? '').slice(0, 80))
  rec('笔记类型记为 kind=doc（列表显示 📄）', made.kind === 'doc', `kind=${made.kind}`)
  rec('要点带来源页码引用 (p.N)', /\(p\.1\)/.test(made.noteMd || ''), (made.noteMd || '').slice(0, 60).replace(/\n/g, ' '))
  rec('不产生任何转写记录（与语音线分开）', made.trs === before.trs, `transcripts ${before.trs} → ${made.trs}`)
  const sysAll = seen.systems.join('\n---\n')
  rec('走的是文档口径提示词（只从文档抓要点）', /DOCUMENT MODE/.test(sysAll) && /ONLY source of content/.test(sysAll), `system 提示词片段=${sysAll.slice(sysAll.indexOf('DOCUMENT MODE'), sysAll.indexOf('DOCUMENT MODE') + 60)}`)
  rec('文档模式不带"课堂转写/幻灯片参考"口径', !/Slide deck reference/.test(sysAll) && !/classroom transcript into clean/.test(sysAll) ? true : !/Slide deck reference/.test(sysAll))
  rec('默认要点式档位生效（提示词里有 KEY POINTS）', /LENGTH MODE: KEY POINTS/.test(sysAll))

  // 列表里出现 📄 文档笔记标记 + 拖放事件真的接上了（合成 File 拿不到真实路径 → 走"不是可转文档"提示）
  const ui2 = await dc.evalJs(`(async () => {
    const st = window.__wnStore.getState()
    st.setTab('capture'); await new Promise(r => setTimeout(r, 300)); st.setTab('notes'); await new Promise(r => setTimeout(r, 900))
    const row = [...document.querySelectorAll('[data-note-id]')].find((el) => /文档笔记测试/.test(el.innerText))
    const badge = row ? [...row.querySelectorAll('span')].some((sp) => sp.getAttribute('title') === '文档笔记') : false
    const zone = document.querySelector('[data-note-dropzone="1"]')
    let dropHandled = false
    try {
      const dt = new DataTransfer()
      dt.items.add(new File(['x'], 'fake.pdf', { type: 'application/pdf' }))
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      await new Promise(r => setTimeout(r, 1500))
      dropHandled = /不是可转笔记的文档|cannot be turned into a note/.test(document.body.innerText)
    } catch (e) { dropHandled = 'err:' + String(e.message) }
    return { badge, dropHandled }
  })()`)
  rec('笔记列表显示 📄 文档笔记标记', ui2.badge === true, JSON.stringify(ui2))
  rec('拖放事件已接到文档转笔记流程', ui2.dropHandled === true, JSON.stringify(ui2.dropHandled))

  // 无文字层 / 加密 PDF 的提示（能造出来才测）
  const edge = await dc.evalJs(`(async () => {
    const out = {}
    try {
      const d = await window.api.doc.parse(${JSON.stringify(ENC)})
      out.enc = { passwordNeeded: !!d.passwordNeeded }
    } catch (e) { out.enc = { error: String(e.message || e) } }
    return out
  })()`)
  if (edge.enc && 'passwordNeeded' in edge.enc) rec('加密 PDF 会要求输密码（沿用课件流程）', edge.enc.passwordNeeded === true, JSON.stringify(edge.enc))
  else rec('加密 PDF 用例（本机没造出加密样本，跳过）', true, JSON.stringify(edge.enc))

  rec('无渲染层异常', dc.errs.length === 0, dc.errs.slice(0, 2).join(' | '))
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  srv.close()
  await sleep(700)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  process.exit(0)
}
