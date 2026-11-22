// 离线验证“自适应整理”：输入过大 → 自动拆块；空回复 → 自动重试；模型持续被拒 → 自动换模型/渠道
import { initPaths } from '../../src/main/config'
import { organizeText } from '../../src/main/llm/organize'
import type { AppSettings, LlmProgress } from '../../src/shared/types'

initPaths('/tmp/wn-test')
const log: string[] = []
let calls = 0
const body = (n: number): string => Array.from({ length: n }, (_, i) => `句子${i}：这是讲座内容。`).join('') 
const transcript = body(3000) // ~3000*12 ≈ 36k 字符

// 假上游：>18k 字符输入一律 400；primary 模型第 3 次后 429；backup 模型正常；偶发空回复
const seenModel = new Map<string, number>()
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  calls++
  const payload = JSON.parse(String(init.body)) as { model: string; messages: Array<{ content: string }>; max_tokens?: number }
  const sysMsg = (payload.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
  if (sysMsg && !capturedSystem) capturedSystem = sysMsg
  const size = payload.messages.reduce((a, m) => a + m.content.length, 0)
  const n = (seenModel.get(payload.model) ?? 0) + 1
  seenModel.set(payload.model, n)
  log.push(`call#${calls} model=${payload.model} size=${size} max_tokens=${payload.max_tokens ?? '-'} (第${n}次)`)
  if (size > 18000) {
    return new Response(JSON.stringify({ error: { message: 'bad request: input too large' } }), { status: 400 })
  }
  if (payload.model.includes('primary') && n > 2) {
    return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })
  }
  if (n === 1 && payload.model.includes('primary')) {
    return new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }), { status: 200 })
  }
  return new Response(
    JSON.stringify({ choices: [{ message: { content: `## 笔记（${payload.model}）\n\n- 要点` }, finish_reason: 'stop' }] }),
    { status: 200 }
  )
}) as typeof fetch

let capturedSystem = ''
const settings = {
  llm: {
    baseUrl: 'http://fake.local/v1',
    modelId: 'primary-model',
    apiKey: 'k',
    maxChunkChars: 20000,
    maxOutputTokens: 16384,
    templateId: 'study',
    customTemplate: '',
    autoFallback: true,
    activeProviderId: 'p1',
    fallbackModels: ['primary-backup'],
    providers: [
      { id: 'p1', name: 'OpenRouter', baseUrl: 'http://fake.local/v1', apiKey: 'k', modelId: 'primary-model', enabled: true },
      { id: 'p2', name: 'DeepSeek', baseUrl: 'http://fake2.local/v1', apiKey: 'k2', modelId: 'ds-chat', enabled: true }
    ]
  },
  ui: { language: 'zh' }
} as unknown as AppSettings

const progress: LlmProgress[] = []
const r = await organizeText(settings, { title: '测试讲座', sourceText: transcript, length: 'standard' }, (p) => {
  progress.push(p)
})
console.log('调用序列：')
for (const l of log) console.log('  ' + l)
console.log('\n进度里的自适应动作：')
for (const p of progress) if (/拆|重试|备用|拒绝/.test(p.detail ?? '')) console.log('  ' + p.detail)
console.log('\n结果：chunks=%d requests=%d 长度=%d', r.chunks, r.requests, r.noteMd.length)
console.log('首行:', r.noteMd.split('\n')[0])
console.log((/LANGUAGE — STRICT/.test(capturedSystem) ? '✅' : '❌') + ' system prompt 含语言硬约束')
console.log('  约束片段:', (capturedSystem.match(/LANGUAGE[^\n]{0,120}/) ?? ['(未找到)'])[0])
