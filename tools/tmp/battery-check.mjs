// 压力电池：造各种"奇怪但真实可能遇到"的转写文本，用真实模型跑完整整理流程，
// 看是不是都能成功产出完整笔记（入库 / 无 ⚠ 横幅 / failedParts=0 / 请求数 < 50）
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => {
  results.push({ n, ok })
  console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`)
}
const KEY = fs.readFileSync('/tmp/wn-key.txt', 'utf8').trim()

// ── 造 6 种形态的"假转写" ────────────────────────────────────
const en = (i) => `Sentence ${i}: the lecturer explains sampling rate, quantization error, and anti-aliasing filters.`
const zh = (i) => `第${i}句：老师讲了采样率、量化误差和抗混叠滤波器，还提到 44.1 kHz 与 16 bit。`
const CASES = [
  {
    id: 'short',
    name: '① 很短（单块，约 900 字）',
    text: Array.from({ length: 12 }, (_, i) => en(i)).join(' ')
  },
  {
    id: 'mixed',
    name: '② 中英混排（中文讲课夹英文术语，约 6k 字）',
    text: Array.from({ length: 80 }, (_, i) => (i % 2 ? zh(i) : en(i))).join(' ')
  },
  {
    id: 'repeat',
    name: '③ 满屏重复（whisper 幻觉式复读，约 8k 字）',
    text: Array.from({ length: 200 }, () => 'Thank you. Thank you. Thank you for watching.').join('\n') + '\n' + Array.from({ length: 30 }, (_, i) => en(i)).join(' ')
  },
  {
    id: 'code',
    name: '④ 公式/代码密集（约 7k 字）',
    text: Array.from({ length: 40 }, (_, i) => `Step ${i}: f_s >= 2 f_max, SNR = 6.02N + 1.76 dB.\n\`\`\`python\nx = np.arange(${i})\ny = x ** 2\n\`\`\`\nLaTeX: $E = mc^2$, $\\int_0^1 x^2 dx = 1/3$`).join('\n\n')
  },
  {
    id: 'weird',
    name: '⑤ 特殊字符/emoji/超长无空格串（约 5k 字）',
    text: Array.from({ length: 60 }, (_, i) => `第${i}句：⚠️ <b>标签</b> &amp; 符号 ~!@#$%^&*()_+ 与 emoji 😀🎯🔊\n` + 'A'.repeat(180)).join('\n')
  },
  {
    id: 'long',
    name: '⑥ 超长（约 130k 字，会分 10 块）',
    text: Array.from({ length: 1400 }, (_, i) => `第${i}段：这一段讲了概念${i}的定义、推导、例子与考试重点，也提到关键数字 ${i * 7}。`).join('')
  }
]

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

const UD = '/tmp/wn-battery'
fs.rmSync(UD, { recursive: true, force: true })
fs.mkdirSync(UD, { recursive: true })
fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ storage: { dataParent: '/tmp/wn-batterybase' }, ui: { language: 'zh' } }, null, 2))
const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), '--remote-debugging-port=9545', `--user-data-dir=${UD}`], { cwd: ROOT })
child.stderr.on('data', () => {})
setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } process.exit(1) }, 90 * 60_000).unref?.()

let dc = null
try {
  dc = await conn(9545)
  await sleep(4500)
  const real = JSON.parse(fs.readFileSync(process.env.HOME + '/Downloads/whisper-notes/config.json', 'utf8')).llm
  await dc.evalJs(`(async () => {
    const s = await window.api.settings.get()
    const next = await window.api.settings.set({ llm: { ...s.llm, ...${JSON.stringify(real)}, apiKey: ${JSON.stringify(KEY)}, autoFallback: true, fallbackModels: [] }, autoOrganizeOnStop: false })
    window.__wnStore.getState().setSettings(next)
    return true
  })()`)
  console.log('真实模型:', real.modelId, '| 模板:', real.templateId, '\n')

  const only = process.argv[2] ? process.argv[2].split(',') : null
  for (const c of CASES.filter((x) => !only || only.includes(x.id))) {
    const t0 = Date.now()
    const r = await dc.evalJs(`(async () => {
      window.__prog = []; window.__d = null
      window.api.onOrganizeJob((p) => window.__prog.push((p.detail || '').slice(0, 70)))
      window.api.onOrganizeDone((d) => { window.__d = d })
      window.api.onOrganizeError((e) => { window.__d = { error: e } })
      await window.api.llm.organizeStart({ title: ${JSON.stringify('电池 ' + c.name)}, sourceText: window.__T })
      const t = Date.now()
      while (!window.__d && Date.now() - t < 1500000) await new Promise(r2 => setTimeout(r2, 1000))
      const notes = await window.api.notes.list()
      const mine = notes.find((n) => n.title === ${JSON.stringify('电池 ' + c.name)})
      const full = mine ? await window.api.notes.get(mine.id) : null
      return { done: window.__d, noteMd: full?.noteMd ?? null, prog: window.__prog }
    })()`.replace('window.__T', JSON.stringify(c.text)))
    const wall = Math.round((Date.now() - t0) / 1000)
    const note = r.noteMd || ''
    if (r.done?.error) { rec(`${c.name}: 任务本身不能报错`, false, JSON.stringify(r.done.error).slice(0, 160)); continue }
    // 我们的"未完成"横幅永远在笔记第一行；正文里引用原文的 ⚠️ 不算（那正是忠实转写）
    const ourBanner = /^\s*>\s*⚠/m.test(note.split('\n').slice(0, 3).join('\n')) || /未能自动整理|本地拼接/i.test(note.slice(0, 200))
    const ok = !!note && note.length > 120 && !ourBanner && (r.done?.failedParts ?? -1) === 0 && (r.done?.requests ?? 999) < 50
    rec(
      `${c.name}: 完整成功`,
      ok,
      `noteChars=${note.length} requests=${r.done?.requests} chunks=${r.done?.chunks} failedParts=${r.done?.failedParts} ${wall}s`
    )
    const interesting = (r.prog || []).filter((x) => /精简|不稳定|备用模型|兜底|失败|统一/.test(x))
    if (interesting.length) console.log('   👉', [...new Set(interesting)].slice(0, 4).join(' | ').slice(0, 260))
    fs.writeFileSync(`/tmp/wn-battery-${c.id}.md`, note)
  }
  rec('无渲染层异常', dc.errs.length === 0, dc.errs.slice(0, 2).join(' | '))
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(700)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  process.exit(0)
}
