// 直接验证：organize 发出的 system prompt 里带上了语言硬约束
import { initPaths } from '../../src/main/config'
import { organizeText } from '../../src/main/llm/organize'
import type { AppSettings } from '../../src/shared/types'

initPaths('/tmp/wn-test')
let sys = ''
globalThis.fetch = (async (_u: string, init: RequestInit) => {
  const b = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> }
  const s = b.messages.find((m) => m.role === 'system')?.content ?? ''
  if (s && !sys) sys = s
  return new Response(
    JSON.stringify({ choices: [{ message: { content: '## Note\n\n- point' }, finish_reason: 'stop' }] }),
    { status: 200 }
  )
}) as typeof fetch

const settings = {
  llm: { baseUrl: 'http://fake/v1', modelId: 'm', apiKey: 'k', maxChunkChars: 20000, maxOutputTokens: 4096, templateId: 'study', customTemplate: '', autoFallback: false },
  ui: { language: 'zh' }
} as unknown as AppSettings

const enText = 'The efficient market hypothesis states that asset prices reflect all available information. ' + 'This lecture explains its implications. '.repeat(20)
const zhText = '有效市场假说认为资产价格已经反映所有可得信息。' + '这节课解释它的含义。'.repeat(20)

for (const [name, text, want] of [
  ['英文转写', enText, /LANGUAGE — STRICT: the transcript is ENGLISH/],
  ['中文转写', zhText, /LANGUAGE — STRICT: the transcript is CHINESE/]
] as Array<[string, string, RegExp]>) {
  sys = ''
  await organizeText(settings, { title: 'T', sourceText: text, length: 'standard' }, () => {})
  const ok = want.test(sys)
  console.log(`${ok ? '✅' : '❌'} ${name} → system prompt ${ok ? '含' : '不含'}对应语言硬约束`)
  if (!ok) console.log('   实际片段:', sys.slice(0, 300))
}
