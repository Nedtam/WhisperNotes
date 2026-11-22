// 扩展实测：每一项改动单独测，给出相对 small.en 基准的下降幅度
// 指标：墙钟(s)、服务器进程 CPU 时间(s)（发热/耗电代理）、峰值 CPU%、以及按长度扫描推出的每请求固定开销
import { spawn, execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const BIN = path.join(ROOT, 'native/mac/bin/whisper-server')
const MODELS = path.join(os.homedir(), 'Library/Application Support/WhisperNotes/models')
const FULL = '/tmp/bench2.wav'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sliceWav(src, dst, seconds) {
  const buf = fs.readFileSync(src)
  const header = buf.subarray(0, 44)
  const dataBytes = Math.min(buf.length - 44, Math.floor(seconds * 16000) * 2)
  fs.writeFileSync(dst, Buffer.concat([header, buf.subarray(44, 44 + dataBytes)]))
}
function audioSec(file) {
  const out = execFileSync('afinfo', [file], { encoding: 'utf-8' })
  const m = /estimated duration:\s*([\d.]+)/.exec(out)
  return m ? parseFloat(m[1]) : 0
}
function cpuSec(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf-8' }).trim()
    const p = out.split(':').map((x) => parseFloat(x) || 0)
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2]
    if (p.length === 2) return p[0] * 60 + p[1]
    return p[0] || 0
  } catch {
    return 0
  }
}
const pcpu = (pid) => {
  try {
    return parseFloat(execFileSync('ps', ['-o', 'pcpu=', '-p', String(pid)], { encoding: 'utf-8' }).trim()) || 0
  } catch {
    return 0
  }
}
async function waitPort(port) {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
      if (r.status < 500) return true
    } catch {
      /* retry */
    }
    await sleep(300)
  }
  return false
}
async function ask(port, file) {
  const fd = new FormData()
  fd.append('file', new Blob([fs.readFileSync(file)]), 'a.wav')
  fd.append('response_format', 'json')
  const t0 = Date.now()
  const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: fd })
  const wall = (Date.now() - t0) / 1000
  const d = await res.json().catch(() => ({}))
  return { wall, text: String(d.text ?? '').trim() }
}
async function run({ label, model, gpu, threads = 6, lang = 'en', file = FULL }) {
  const mp = path.join(MODELS, model)
  if (!fs.existsSync(mp)) return { label, error: 'no model' }
  const port = 8950 + Math.floor(Math.random() * 40)
  const args = ['--model', mp, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads)]
  if (lang) args.push('-l', lang)
  if (!gpu) args.push('-ng')
  const child = spawn(BIN, args, { stdio: 'ignore' })
  const pid = child.pid
  try {
    if (!(await waitPort(port))) return { label, error: 'server not ready' }
    await ask(port, file) // 预热
    await sleep(200)
    const c0 = cpuSec(pid)
    let peak = 0
    const s = setInterval(() => (peak = Math.max(peak, pcpu(pid))), 150)
    const r = await ask(port, file)
    clearInterval(s)
    const cpu = cpuSec(pid) - c0
    return { label, wall: r.wall, cpu, peak, lang, text: r.text.slice(0, 50), audio: audioSec(file) }
  } finally {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    await sleep(500)
  }
}

const TURBO = 'ggml-large-v3-turbo-q5_0.bin'
const SMALL = 'ggml-small.en-q5_1.bin'
console.log('=== A. 逐项改动实测（115 秒语音）===')
const rows = []
for (const c of [
  { label: '① 现在：turbo + CPU(6线程) + 草稿开', model: TURBO, gpu: false, threads: 6 },
  { label: '② 只换 small.en + 仍 CPU(6线程)', model: SMALL, gpu: false, threads: 6 },
  { label: '③ small.en + 开 Metal', model: SMALL, gpu: true, threads: 6 },
  { label: '④ turbo + 开 Metal', model: TURBO, gpu: true, threads: 6 },
  { label: '⑤ turbo + CPU 但只用 4 线程', model: TURBO, gpu: false, threads: 4 },
  { label: '⑥ turbo + CPU 只用 2 线程', model: TURBO, gpu: false, threads: 2 },
  { label: '⑦ small.en + Metal，但语言自动检测', model: SMALL, gpu: true, lang: '', threads: 6 }
]) {
  const r = await run(c)
  rows.push({ ...r, short: c.label })
  console.log(r.error ? `❌ ${c.label}: ${r.error}` : `✅ ${c.label}\n   墙钟 ${r.wall.toFixed(1)}s · CPU时间 ${r.cpu.toFixed(1)}s · 峰值CPU ${r.peak.toFixed(0)}% · RTF ${(r.audio / r.wall).toFixed(1)}x`)
}
const base = rows.find((r) => r.short && r.short.startsWith('③'))
console.log('\n=== B. 以「③ small.en + Metal」为基准的下降幅度 ===')
console.log('配置'.padEnd(42) + '墙钟倍数  CPU时间倍数')
for (const r of rows) {
  if (r.error || !base) continue
  console.log(r.short.padEnd(42) + (r.wall / base.wall).toFixed(2).padStart(8) + '×' + (r.cpu / Math.max(base.cpu, 0.1)).toFixed(0).padStart(11) + '×')
}
// C. 按长度扫描：算每请求固定开销 + 每秒成本 → 用来量化"草稿预览"的额外开销
console.log('\n=== C. 单次请求成本 vs 音频长度（turbo+CPU，与你的现状一致）===')
const lens = [2, 5, 10, 25]
const sweep = []
for (const L of lens) {
  const f = `/tmp/slice-${L}.wav`
  sliceWav(FULL, f, L)
  const r = await run({ label: `${L}s`, model: TURBO, gpu: false, file: f })
  if (!r.error) {
    sweep.push({ L, cpu: r.cpu, wall: r.wall })
    console.log(`  ${String(L).padStart(2)}s 音频 → CPU时间 ${r.cpu.toFixed(2)}s · 墙钟 ${r.wall.toFixed(2)}s`)
  }
}
if (sweep.length >= 2) {
  const a = sweep[0]
  const b = sweep[sweep.length - 1]
  const perSec = (b.cpu - a.cpu) / (b.L - a.L)
  const fixed = a.cpu - perSec * a.L
  console.log(`  → 每次请求固定开销 ≈ ${fixed.toFixed(2)}s CPU，每秒音频 ≈ ${perSec.toFixed(2)}s CPU`)
  console.log('  → 草稿预览的代价：一段 12 秒话，草稿按 ≥0.65s 节流几乎连续跑，处理音频量 ≈ 1+2+…+12 ≈ 78s')
  console.log(`     即约 ${(78 * perSec).toFixed(0)}s CPU（对比定稿一句 12s ≈ ${(12 * perSec + fixed).toFixed(0)}s）→ 草稿把 CPU 工作放大约 ${(78 * perSec / (12 * perSec + fixed)).toFixed(1)} 倍`)
}
