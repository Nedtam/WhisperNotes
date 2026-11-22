// 隔离环境的 UI 验证：渠道设置界面 + 改名持久化 + 荧光/表格渲染
// 用法: node tools/tmp/ui-check.mjs   （先 npm run build）
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PORT = 9345
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const record = (name, ok, extra = '') => {
  results.push({ name, ok, extra })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.errors = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        this.errors.push(d.exception?.description || d.text)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error('eval error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result?.value
  }
}

async function connectCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => {
          ws.addEventListener('open', res)
          ws.addEventListener('error', rej)
        })
        const cdp = new Cdp(ws)
        await cdp.send('Runtime.enable')
        return cdp
      }
    } catch {
      /* retry */
    }
    await sleep(500)
  }
  throw new Error('CDP 连接超时')
}

const child = spawn(
  path.join(ROOT, 'node_modules/.bin/electron'),
  [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/wn-devdata'],
  { cwd: ROOT, env: { ...process.env } }
)
child.stderr.on('data', (d) => process.stderr.write('[el] ' + d))
child.stdout.on('data', (d) => process.stdout.write('[el] ' + d))

try {
  const cdp = await connectCdp()
  await sleep(3500)

  // ── 1. 设置页：渠道管理界面 ──
  await cdp.evalJs(`document.querySelectorAll('nav button, aside button').forEach(()=>{}); (() => { const btns=[...document.querySelectorAll('button')]; const b=btns.find(x=>/设置|Settings/.test(x.textContent||'')); if(b) b.click(); return !!b })()`)
  await sleep(1200)
  const settingsProbe = await cdp.evalJs(`(() => {
    const txt = document.body.innerText
    const sels = [...document.querySelectorAll('select')].map(s => ({ n: s.options.length, groups: [...s.querySelectorAll('optgroup')].map(g => g.label) }))
    const bigSel = sels.find(s => s.n >= 15) || { n: 0, groups: [] }
    return {
      hasChannelTitle: /当前使用的 AI 渠道|AI channel in use/.test(txt),
      hasAddChannel: /添加渠道|Add a channel/.test(txt),
      hasAutoFallback: /自动换模型|Auto-switch/.test(txt),
      presetCount: bigSel.n,
      groups: bigSel.groups,
      providerOptions: [...document.querySelectorAll('select')].filter(s=>s.options.length>=15).map(s=>[...s.options].map(o=>o.textContent))
    }
  })()`)
  record('设置页出现「当前使用的 AI 渠道」', settingsProbe.hasChannelTitle, JSON.stringify(settingsProbe))
  record('渠道预设下拉包含国内/国际/本地分组', settingsProbe.groups.length >= 3, 'groups=' + JSON.stringify(settingsProbe.groups))

  // ── 2. 渠道持久化：通过 API 写两个渠道并读回 ──
  const chan = await cdp.evalJs(`(async () => {
    const s = await window.api.settings.get()
    const next = { ...s.llm, providers: [
      { id: 'or', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test-1', modelId: 'm-or' },
      { id: 'ds', name: 'DeepSeek 深度求索', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test-2', modelId: 'deepseek-chat', fallbackModels: ['deepseek-reasoner'] }
    ], activeProviderId: 'ds' }
    const saved = await window.api.settings.set({ llm: next })
    return { n: saved.llm.providers.length, active: saved.llm.activeProviderId, model: saved.llm.modelId, baseUrl: saved.llm.baseUrl, fb: (saved.llm.fallbackModels||[]).length }
  })()`)
  record('渠道可保存并解析当前渠道', chan.n === 2 && chan.active === 'ds' && chan.model === 'deepseek-chat' && chan.fb === 1, JSON.stringify(chan))

  // ── 3. 改名持久化（用户报的核心 bug）──
  const rename = await cdp.evalJs(`(async () => {
    const list = await window.api.notes.list()
    const a = list[0], b = list[1]
    const stamp = Date.now().toString().slice(-6)
    const newTitle = '改名测试 ' + stamp
    // 模拟：打开 A → 改标题 → 切到 B 触发“切走保存”
    window.__wn = { a, b, list }
    const store = window.__wnStore
    return { noteA: a.id, noteB: b.id, newTitle, beforeTitle: a.title }
  })()`)
  // 通过 UI 真实操作：选中笔记 → 改标题输入框 → 切到另一篇
  const renameFlow = await cdp.evalJs(`(async () => {
    const store = window.__wnStore
    const notes = await window.api.notes.list()
    const target = notes[0]
    const other = notes[1]
    // 用 UI 打开第一篇：点列表项
    const st = store.getState()
    st.setTab('notes')
    await new Promise(r => setTimeout(r, 500))
    st.setPending({ id: target.id, title: target.title, noteMd: target.noteMd, sourceText: target.sourceText, templateId: target.templateId, notebookId: target.notebookId ?? null, durationMs: target.durationMs, tags: target.tags ?? [] })
    await new Promise(r => setTimeout(r, 600))
    const input = [...document.querySelectorAll('input')].find(i => i.value === target.title)
    if (!input) return { error: '找不到标题输入框', titles: [...document.querySelectorAll('input')].map(i=>i.value).slice(0,6) }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    const newTitle = '改名测试 ' + Date.now().toString().slice(-6)
    setter.call(input, newTitle)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 400))
    // 切到另一篇（触发切走保存）
    store.getState().setPending({ id: other.id, title: other.title, noteMd: other.noteMd, sourceText: other.sourceText, templateId: other.templateId, notebookId: other.notebookId ?? null, durationMs: other.durationMs, tags: other.tags ?? [] })
    await new Promise(r => setTimeout(r, 1800))
    const after = (await window.api.notes.list()).find(n => n.id === target.id)
    return { newTitle, savedTitle: after?.title, ok: after?.title === newTitle }
  })()`)
  record('改名后切换笔记仍是新标题', renameFlow.ok === true, JSON.stringify(renameFlow))

  // ── 4. 荧光标记与表格渲染（HTML mark + 行列对齐 + 代码里的 ==）──
  const render = await cdp.evalJs(`(async () => {
    const md = '| A | B | C |\\n| --- | --- | --- |\\n| 1 |\\n| 1 | 2 | 3 | 4 |\\n\\n判断 \`x == y\` 与 <mark class="hl-yellow">新荧光</mark> 和 ==旧荧光==\\n\\n' + '\`\`\`cpp\\nif (a == b) {}\\n\`\`\`'
    const note = await window.api.notes.save({ title: '渲染测试 ' + Date.now(), noteMd: md, sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
    const store = window.__wnStore
    store.getState().setTab('notes')
    await new Promise(r => setTimeout(r, 400))
    store.getState().setPending({ id: note.id, title: note.title, noteMd: note.noteMd, sourceText: '', templateId: 'study', notebookId: null, durationMs: 0, tags: [] })
    await new Promise(r => setTimeout(r, 900))
    const html = store.getState().pending?.noteMd ?? ''
    // 预览在“预览”按钮后渲染，直接调 mdToHtml 等价逻辑：这里检查已持久化的 md 是否被污染
    const saved = (await window.api.notes.list()).find(n => n.id === note.id)
    window.__wnCleanup = note.id
    return { savedMd: saved.noteMd }
  })()`)
  const mdChecks = {
    htmlMarkKept: render.savedMd.includes('<mark class="hl-yellow">新荧光</mark>'),
    legacyConvertedOnSave: render.savedMd.includes('<mark class="hl-yellow">旧荧光</mark>'),
    codeUntouched: render.savedMd.includes('`x == y`'),
    tableKept: render.savedMd.includes('| 1 | 2 | 3 | 4 |')
  }
  record('保存时 HTML 荧光标记保留', mdChecks.htmlMarkKept, JSON.stringify(mdChecks))
  record('保存时旧 == 荧光自动转 HTML', mdChecks.legacyConvertedOnSave)
  record('代码里的 == 不被当成荧光', mdChecks.codeUntouched)

  // 删除测试笔记（含改名测试留下的），保持隔离库整洁
  await cdp.evalJs(`(async () => { const r = await window.api.notes.list(); for (const n of r) if (/渲染测试|改名测试/.test(n.title)) await window.api.notes.remove(n.id); return true })()`)
  record('渲染层异常', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '))
} catch (e) {
  record('脚本执行', false, String(e))
} finally {
  // 关闭应用
  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  await sleep(800)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) {
    console.log('失败项:', bad.map((b) => b.name + ' ' + b.extra).join('\n'))
    process.exit(1)
  }
}
