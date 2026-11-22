// 极端场景：所有模型对所有请求都 400 → 整单必须“仍然成功”（退化为原文/本地拼接）
import { initPaths } from '../../src/main/config'
import { organizeText } from '../../src/main/llm/organize'
import type { AppSettings, LlmProgress } from '../../src/shared/types'

initPaths('/tmp/wn-test')
let calls = 0
globalThis.fetch = (async () => {
  calls++
  return new Response(JSON.stringify({ code: 400, msg: 'bad request' }), { status: 400 })
}) as typeof fetch

const text = Array.from({ length: 900 }, (_, i) => `第${i}句：这是讲座原文。`).join('')
const settings = {
  llm: {
    baseUrl: 'http://fake.local/v1', modelId: 'm1', apiKey: 'k', maxChunkChars: 8000,
    maxOutputTokens: 16384, templateId: 'study', customTemplate: '', autoFallback: true,
    activeProviderId: 'p1', fallbackModels: ['m2'],
    providers: [{ id: 'p1', name: 'A', baseUrl: 'http://a/v1', apiKey: 'k', modelId: 'm1', enabled: true }]
  },
  ui: { language: 'zh' }
} as unknown as AppSettings

const t0 = Date.now()
const r = await organizeText(settings, { title: '全拒场景', sourceText: text, length: 'standard' }, (_p: LlmProgress) => {})
console.log('调用次数=%d 耗时=%dms', calls, Date.now() - t0)
console.log('chunks=%d requests=%d 长度=%d', r.chunks, r.requests, r.noteMd.length)
console.log('前缀:', JSON.stringify(r.noteMd.slice(0, 160)))
console.log('包含原文片段:', r.noteMd.includes('这是讲座原文'))
