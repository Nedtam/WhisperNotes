// WhisperNotes E2E debug driver（用 CDP 驱动真实 UI，注入合成语音，验证全链路）
// 用法: node tools/debug-e2e.mjs [clip.wav]
// 依赖: 已 npm run build；electron 可启动；模型 ggml-base.en.bin 在 models 目录
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLIP = process.argv[2] || '/tmp/wn-sample.wav'
const PORT = 9333
const RESULTS = { steps: [], errors: [] }

function log(msg) {
  console.log('[e2e] ' + msg)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - start > timeoutMs) {
      RESULTS.errors.push(`timeout: ${label}`)
      return false
    }
    await sleep(300)
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.console = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
        this.console.push(`[console:${msg.params.type}] ${text}`)
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        RESULTS.errors.push('renderer-exception: ' + (d.exception?.description || d.text || 'unknown'))
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
  async evalJs(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error('eval error: ' + (d.exception?.description || d.text))
    }
    return r.result?.value
  }
}

async function connectCdp() {
  // 等待调试端口出现页面
  await waitFor(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      return list.some((t) => t.type === 'page')
    } catch {
      return false
    }
  }, 30000, 'CDP page 出现')
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  log('连接页面: ' + page.url)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  return cdp
}

async function main() {
  // 1. 确保已构建
  log('build…')
  spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' })

  // 2. 读入语音并转 base64（页内解码成 Float32）
  const wav = fs.readFileSync(CLIP)
  const b64 = wav.toString('base64')
  log(`clip: ${CLIP} (${(wav.length / 1024).toFixed(0)} KB)`)

  // 3. 启动 Electron（带 CDP）
  const child = spawn(
    path.join(ROOT, 'node_modules/.bin/electron'),
    [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`],
    { cwd: ROOT, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } }
  )
  child.stdout.on('data', (d) => process.stdout.write('[el] ' + d))
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/load_backend|ggml_|Metal|core video|CoreText|IMKClient/.test(s)) process.stderr.write('[el-err] ' + s)
  })

  const cdp = await connectCdp()
  const step = async (label, fn) => {
    try {
      const v = await fn()
      RESULTS.steps.push(`${label} => ${typeof v === 'string' ? v : JSON.stringify(v) ?? ''}`)
      log(`✓ ${label}: ${typeof v === 'string' ? v.slice(0, 120) : JSON.stringify(v).slice(0, 120)}`)
    } catch (e) {
      RESULTS.errors.push(`${label} failed: ${e.message}`)
      log(`✗ ${label}: ${e.message}`)
    }
  }

  await step('preload 桥接存在', () =>
    cdp.evalJs(`(() => ({ api: typeof window.api, hasSettings: !!(window.api && window.api.settings) }))()`)
  )

  await step('设置加载并选用 base.en', () =>
    cdp.evalJs(`(async () => {
      const s = await window.api.settings.get();
      const prev = s.whisper.modelFile;
      await window.api.settings.set({ whisper: { ...s.whisper, modelFile: 'ggml-base.en.bin' } });
      const m = await window.api.models.status();
      const base = m.find(x => x.info.file === 'ggml-base.en.bin');
      return { prev, basePresent: base?.present ?? false, probe: (await window.api.sys.probeWhisper()).found };
    })()`)
  )

  await step('注入语音 + 订阅事件', () =>
    cdp.evalJs(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
      // 解析 wav → float32（16k mono）
      const sr = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16) | (bytes[27] << 24)) >>> 0;
      let off = 12;
      while (off < bytes.length) {
        const id = String.fromCharCode(bytes[off], bytes[off+1], bytes[off+2], bytes[off+3]);
        const sz = (bytes[off+4] | (bytes[off+5]<<8) | (bytes[off+6]<<16) | (bytes[off+7]<<24)) >>> 0;
        if (id === 'data') break;
        off += 8 + sz;
      }
      const dataStart = off + 8;
      const n = (bytes.length - dataStart) / 2;
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = bytes[dataStart + i*2] | (bytes[dataStart + i*2 + 1] << 8);
        f[i] = (v >= 32768 ? v - 65536 : v) / 32768;
      }
      window.__clip = { f, sr };
      window.__dbg = { state: [], segs: [], drafts: [] };
      window.api.onAsrState(m => window.__dbg.state.push(m.state));
      window.api.onAsrSegment(s => window.__dbg.segs.push(s));
      window.api.onAsrDraft(d => window.__dbg.drafts.push(d.text));
      return { samples: f.length, seconds: (f.length / sr).toFixed(1), sr };
    })()`)
  )

  await step('点击「开始录音」（假麦克风模式）', () =>
    cdp.evalJs(`(async () => {
      await window.api.settings.set({ autoOrganizeOnStop: false }); // 测试期禁止自动整理
      window.__fakeMic = true;
      const btn = document.querySelector('button[title="开始录音"]');
      if (!btn) throw new Error('找不到开始按钮');
      btn.click();
      return 'clicked';
    })()`)
  )

  const reached = await waitFor(async () => {
    const st = await cdp.evalJs(`window.__dbg?.state ?? []`)
    return Array.isArray(st) && st.includes('recording')
  }, 40000, '进入 recording 状态')
  if (!reached) {
    const st = await cdp.evalJs(`window.__dbg?.state ?? []`)
    RESULTS.errors.push(`未进入 recording，状态序列: ${JSON.stringify(st)}`)
  } else {
    await step('引擎进入 recording', () => cdp.evalJs(`JSON.stringify(window.__dbg.state)`))

    // 推送语音：clip + 1s 静音 + clip + 1.5s 尾静音（验证录音中即定稿、可多句）
    await cdp.evalJs(`(() => {
      const { f, sr } = window.__clip;
      const push = (arr) => {
        for (let i = 0; i < arr.length; i += 1600) {
          window.api.rec.pushPcm(arr.subarray(i, Math.min(i + 1600, arr.length)), sr);
        }
      };
      push(f);
      push(new Float32Array(sr));            // 1s 静音分句
      push(f);
      push(new Float32Array(Math.floor(sr * 1.5))); // 1.5s 尾静音
      return 'pushed ~' + Math.ceil((f.length * 2 + sr * 2.5) / 1600) + ' chunks';
    })()`)

    await waitFor(async () => {
      const n = await cdp.evalJs(`window.__dbg.segs.length`)
      return n >= 2
    }, 40000, '录音中出现 ≥2 句定稿')

    // 无 Key 时点「整理成笔记」→ 应弹提示并跳到设置页
    await step('点「整理成笔记」→ 打开整理对话框', () =>
      cdp.evalJs(`(async () => {
        // 防止自动整理烧真实额度
        await window.api.settings.set({ autoOrganizeOnStop: false });
        const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('整理成笔记'));
        if (!btn) throw new Error('找不到整理按钮');
        btn.click();
        await new Promise(r => setTimeout(r, 500));
        const bodyText = document.body.innerText;
        const opened = bodyText.includes('整理成笔记') && bodyText.includes('笔记长度') && bodyText.includes('简洁');
        // 关闭对话框
        const cancel = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '取消');
        cancel?.click();
        await new Promise(r => setTimeout(r, 200));
        return { opened, closed: !!cancel };
      })()`)
    )
    await step('回到录音页', () =>
      cdp.evalJs(`(() => {
        const nav = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim().startsWith('录音转写'));
        if (nav) nav.click();
        return !!nav;
      })()`)
    )

    await sleep(1500) // 等最后的句子定稿

    await step('点击「停止录音」', () =>
      cdp.evalJs(`(() => {
        const btn = document.querySelector('button[title="停止录音"]');
        if (btn) btn.click();
        return 'clicked stop';
      })()`)
    )

    await waitFor(async () => {
      const st = await cdp.evalJs(`window.__dbg?.state ?? []`)
      return Array.isArray(st) && st[st.length - 1] === 'idle'
    }, 30000, '回到 idle')

    await sleep(2500) // 等自动整理提示/收尾

    const summary = await cdp.evalJs(`(() => {
      const ta = document.querySelector('textarea');
      const text = ta ? ta.value : '';
      const states = (window.__dbg?.state ?? []).join('>');
      const segs = (window.__dbg?.segs ?? []).map(s => s.text);
      return { states, segCount: segs.length, draftCount: (window.__dbg?.drafts ?? []).length, firstLine: (text.split('\\n')[0] || '').slice(0, 140), textLen: text.length };
    })()`)
    RESULTS.steps.push('最终状态 => ' + JSON.stringify(summary))
    log('最终: ' + JSON.stringify(summary, null, 1))
    log('句子:')
    for (const t of (await cdp.evalJs(`window.__dbg?.segs?.map(s => s.text) ?? []`)) || []) log('  · ' + t.slice(0, 160))

    // 课件注入 + 简洁档 端到端（用转写文本的一段 + 合成 PPTX）
    await step('课件+简洁档整理（真实调用 1 次）', () =>
      cdp.evalJs(`(async () => {
        const src = window.__clip ? 'Today we talked about processes and customers. The output spectrum ranges from products to services, for example Starbucks is a hybrid.' : '';
        const r = await window.api.llm.organize({
          title: 'Slides E2E', sourceText: src,
          length: 'concise', slidesPath: '/tmp/syn.pptx'
        });
        return { ok: true, len: r.noteMd.length, head: r.noteMd.slice(0, 90) };
      })().catch(e => ({ ok: false, error: e.message }))`)
    )

    // 精修通道 + 加密真实课件（真实调用 1 次）
    await step('加密课件精修（真实调用 1 次）', () =>
      cdp.evalJs(`(async () => {
        const src = 'Today we continue with SYE 2066. Sherman Ngan introduced the equipment rental case: the site manager sends a request to the equipment clerk, and this is the procure to pay process.';
        const r = await window.api.llm.polish({
          sourceText: src,
          slidesPaths: ['${ROOT.replace(/\\/g, '\\\\')}/SN+-+Lecture+1+Student+Notes.pdf'],
          slidesPasswords: ['opw323']
        });
        const okOut = r && r.text && r.text.length > 30;
        return { ok: !!okOut, len: r?.text?.length ?? 0, head: (r?.text || '').slice(0, 140) };
      })().catch(e => ({ ok: false, error: e.message }))`)
    )
  }

  // 附：渲染进程控制台输出里的错误线索
  const badConsole = cdp.console.filter((c) => /error|fail|exception|uncaught/i.test(c))
  if (badConsole.length) {
    RESULTS.errors.push('console errors: ' + badConsole.join(' | '))
  }

  console.log('\n========== 结果 ==========')
  console.log(RESULTS.steps.join('\n'))
  if (RESULTS.errors.length) {
    console.log('\n---- 问题 ----')
    for (const e of RESULTS.errors) console.log('! ' + e)
  } else {
    console.log('\n✔ 未发现错误')
  }

  cdp.ws.close()
  child.kill('SIGTERM')
  await sleep(600)
  try {
    child.kill('SIGKILL')
  } catch {}
  process.exit(RESULTS.errors.length ? 1 : 0)
}

main().catch((e) => {
  console.error('[e2e fatal]', e)
  process.exit(1)
})
