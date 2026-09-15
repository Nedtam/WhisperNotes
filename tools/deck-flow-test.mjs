// 2066 全流程复测：档案配置→引擎术语启动→真语音句子→dots 精修(3份加密课件)→整理→落库
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 9341
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 课件（绝对路径）
const DECKS = [
  { path: path.join(ROOT, '00+SYE2066+Syllabus+and+Main+Assignments.pdf'), name: 'Syllabus', pw: 'opw323' },
  { path: path.join(ROOT, 'SN+-+Lecture+1+Student+Notes.pdf'), name: 'L1 Student Notes', pw: 'opw323' },
  { path: path.join(ROOT, 'SN+-+Lecture+1+Supplemental+Student+Notes.pdf'), name: 'L1 Supplemental', pw: 'opw323' }
]
const CLIP = '/tmp/wn-sample.wav'
const TRANSCRIPT = path.join(ROOT, 'SYE2066-1-输出/SYE2066-1.transcript.txt')

async function main() {
  // 预读：语音片段 base64、全文转写 base64
  const clipB64 = fs.readFileSync(CLIP).toString('base64')
  const fullText = fs.readFileSync(TRANSCRIPT, 'utf-8')
  const fullB64 = Buffer.from(fullText, 'utf-8').toString('base64')

  const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`], { cwd: ROOT })
  let page
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p) { page = p; break }
    } catch {}
    await sleep(300)
  }
  if (!page) throw new Error('page not found')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pend = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) }
  }
  const send = (method, params = {}) => new Promise((res) => { pend.set(++id, res); ws.send(JSON.stringify({ id, method, params })) })
  const evl = async (expr, label) => {
    console.log('[step]', label)
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r?.exceptionDetails) throw new Error(label + ' eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r?.result?.value
  }
  const step = (label, expr) => evl(expr, label)

  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(1800)

  const decksJson = JSON.stringify(DECKS)
  await step('① 配置课程档案(3份) + 关自动整理', `(async () => {
    await window.api.settings.set({ autoOrganizeOnStop: false });
    const cur = await window.api.settings.get();
    await window.api.settings.set({ course: {
      decks: ${decksJson}.map(d => ({ path: d.path, name: d.name, kind: d.path.toLowerCase().endsWith('.pdf') ? 'pdf' : 'pptx', password: d.pw })),
      autoPrompt: true, segmentCorrection: true
    }, whisper: { ...cur.whisper, modelFile: 'ggml-large-v3-turbo-q5_0.bin' } });
    return 'ok';
  })()`)

  await step('② 真语音句子上引擎（档案术语自动并入提示词）', `(async () => {
    window.__fakeMic = true;
    window.__dbg = { segs: [] };
    window.api.onAsrSegment(s => window.__dbg.segs.push(s));
    const btn = document.querySelector('button[title="开始录音"]');
    btn?.click();
    let ok = false;
    for (let i = 0; i < 200; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (window.__dbg.segs.length >= 1) { ok = true; break; }
    }
    if (!ok) return { ok: false, state: 'no segment' };
    const st = document.querySelector('textarea')?.value || '';
    return { ok: true, segCount: window.__dbg.segs.length, sample: st.slice(0, 120) };
  })()`)

  await step('③ 停止录音', `window.api.rec.stop().then(r => ({ ok: r.ok, segments: r.result?.segmentCount }))`)
  await sleep(800)

  await step('④ 载入整篇 2066 转写文本（精修源）', `(() => {
    const bytes = Uint8Array.from(atob('${fullB64}'), c => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    window.__full = text;
    // 放进转写区（模拟审阅源）
    const ta = document.querySelector('textarea');
    return { len: text.length, taOk: !!ta };
  })()`)

  await step('⑤ dots 精修（3 份加密课件，真实调用）', `(async () => {
    const r = await window.api.llm.polish({
      sourceText: window.__full,
      slidesPaths: ${decksJson}.map(d => d.path),
      slidesPasswords: ${decksJson}.map(d => d.pw)
    });
    window.__pol = r.text;
    return { ok: !!r.text, chunks: r.chunks, len: r.text?.length ?? 0 };
  })().catch(e => ({ ok: false, error: e.message }))`)

  await step('⑥ 用精修文本+3课件 整理标准笔记（真实调用）', `(async () => {
    const r = await window.api.llm.organize({
      title: 'SYE2066-1 · 转写精修 + 3课件增强（复测）',
      sourceText: window.__pol,
      length: 'standard',
      slidesPaths: ${decksJson}.map(d => d.path),
      slidesPasswords: ${decksJson}.map(d => d.pw)
    });
    const saved = await window.api.notes.save({
      title: 'SYE2066-1 · 转写精修 + 3课件增强（复测）',
      noteMd: r.noteMd, sourceText: window.__pol,
      templateId: 'study', durationMs: 9714944, tags: ['SYE2066','Lecture1','复测']
    });
    return { ok: true, chunks: r.chunks, requests: r.requests, len: r.noteMd.length, id: saved.id };
  })().catch(e => ({ ok: false, error: e.message }))`)

  const usage = await step('⑦ 额度', `window.api.meta.dailyUsage().then(u => ({ used: u.used, date: u.date }))`)

  // 精修前后抽样对比（找专名纠正线索）
  await step('⑧ 精修差异抽查', `(() => {
    const before = window.__full;
    const after = window.__pol || '';
    const pairs = ['Sherman Ngan','City University','procure','YEUNG','Professional Engineering Practice'];
    const out = {};
    for (const p of pairs) {
      out[p] = { before: (before.match(new RegExp(p.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&'),'gi'))||[]).length,
                 after: (after.match(new RegExp(p.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&'),'gi'))||[]).length };
    }
    return out;
  })()`)

  console.log('\n==== 结果 ====')
  console.log(JSON.stringify({ usage }, null, 1))
  ws.close()
  child.kill('SIGTERM')
  await sleep(600)
  try { child.kill('SIGKILL') } catch {}
  console.log('steps printed above')
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
