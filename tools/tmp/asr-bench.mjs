// ASR 实测：同一段音频、同一模型，对比 CPU(-ng) / Metal，以及大模型 / 小模型
// 指标：墙钟时间、服务器进程 CPU 时间（user+sys，作为"发热/耗电"代理）、峰值 CPU%、RTF
import { spawn, execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const BIN = path.join(ROOT, 'native/mac/bin/whisper-server')
const MODELS_DIR = path.join(os.homedir(), 'Library/Application Support/WhisperNotes/models')
const WAV = process.env.BENCH_WAV || '/tmp/bench.wav'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function audioSeconds() {
  const out = execFileSync('afinfo', [WAV], { encoding: 'utf-8' })
  const m = /estimated duration:\s*([\d.]+)/.exec(out)
  return m ? parseFloat(m[1]) : 28.3
}

function cpuTimeOf(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf-8' }).trim()
    const parts = out.split(':').map((x) => parseFloat(x) || 0)
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if (parts.length === 2) return parts[0] * 60 + parts[1]
    return parts[0] || 0
  } catch {
    return 0
  }
}
function pcpuOf(pid) {
  try {
    return parseFloat(execFileSync('ps', ['-o', 'pcpu=', '-p', String(pid)], { encoding: 'utf-8' }).trim()) || 0
  } catch {
    return 0
  }
}

async function waitPort(port, timeoutMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
      if (res.status < 500) return true
    } catch {
      /* retry */
    }
    await sleep(400)
  }
  return false
}

async function run({ model, gpu, threads = 6, label }) {
  const modelPath = path.join(MODELS_DIR, model)
  if (!fs.existsSync(modelPath)) return { label, error: '模型不存在' }
  const port = 8900 + Math.floor(Math.random() * 90)
  const args = ['--model', modelPath, '--host', '127.0.0.1', '--port', String(port), '-l', 'en', '-t', String(threads)]
  if (!gpu) args.push('-ng')
  const child = spawn(BIN, args, { stdio: 'ignore' })
  const pid = child.pid
  try {
    const ready = await waitPort(port)
    if (!ready) return { label, error: '服务未就绪' }
    const loadCpu = cpuTimeOf(pid)
    // 预热一次（让 Metal shader / 模型解码路径都热起来）
    const warm = new FormData()
    warm.append('file', new Blob([fs.readFileSync(WAV)]), 'a.wav')
    warm.append('response_format', 'json')
    await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: warm })
    await sleep(300)

    const cpu0 = cpuTimeOf(pid)
    let peak = 0
    const sampler = setInterval(() => {
      peak = Math.max(peak, pcpuOf(pid))
    }, 200)
    const t0 = Date.now()
    const fd = new FormData()
    fd.append('file', new Blob([fs.readFileSync(WAV)]), 'a.wav')
    fd.append('response_format', 'json')
    const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: fd })
    const wall = (Date.now() - t0) / 1000
    const data = await res.json().catch(() => ({}))
    clearInterval(sampler)
    const cpuDelta = cpuTimeOf(pid) - cpu0
    return { label, wall, cpuDelta, peak, loadCpu, text: String(data.text ?? '').trim().slice(0, 60), audio: audioSeconds() }
  } finally {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    await sleep(600)
  }
}

const audio = audioSeconds()
console.log(`测试音频: ${audio.toFixed(1)} 秒\n`)
const configs = [
  { label: 'large-v3-turbo-q5 · CPU(-ng) 6线程', model: 'ggml-large-v3-turbo-q5_0.bin', gpu: false },
  { label: 'large-v3-turbo-q5 · Metal GPU', model: 'ggml-large-v3-turbo-q5_0.bin', gpu: true },
  { label: 'small.en-q5 · CPU(-ng) 6线程', model: 'ggml-small.en-q5_1.bin', gpu: false },
  { label: 'small.en-q5 · Metal GPU', model: 'ggml-small.en-q5_1.bin', gpu: true }
]
const rows = []
for (const c of configs) {
  const r = await run(c)
  rows.push(r)
  if (r.error) console.log(`❌ ${r.label}: ${r.error}`)
  else
    console.log(
      `✅ ${r.label}\n   墙钟 ${r.wall.toFixed(1)}s · CPU时间 ${r.cpuDelta.toFixed(1)}s · 峰值CPU ${r.peak.toFixed(0)}% · RTF ${(r.audio / r.wall).toFixed(2)}x · 模型加载CPU ${r.loadCpu.toFixed(1)}s\n   识别: "${r.text}"`
    )
}
console.log('\n配置'.padEnd(34) + '墙钟(s)  CPU时间(s)  峰值CPU%  RTF(倍实时)')
for (const r of rows) {
  if (r.error) continue
  console.log(
    r.label.padEnd(34) +
      String(r.wall.toFixed(1)).padStart(6) +
      String(r.cpuDelta.toFixed(1)).padStart(11) +
      String(r.peak.toFixed(0)).padStart(10) +
      String((r.audio / r.wall).toFixed(2)).padStart(12)
  )
}
console.log('\n推算 90 分钟讲座：')
for (const r of rows) {
  if (r.error) continue
  const mins = (90 * 60) / (r.audio / r.wall) / 60
  console.log(`  ${r.label.padEnd(34)} ≈ ${mins.toFixed(1)} 分钟计算（CPU 时间 ≈ ${(r.cpuDelta * ((90 * 60) / r.audio)).toFixed(0)}s）`)
}
