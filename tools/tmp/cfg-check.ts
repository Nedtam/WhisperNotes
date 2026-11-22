// 渠道配置：旧配置迁移 → 保存 → 重新加载（含加密/解析）闭环
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { initPaths, loadConfig, saveConfig } from '../../src/main/config'

const dir = '/tmp/wn-cfgtest'
mkdirSync(dir, { recursive: true })
writeFileSync(
  `${dir}/config.json`,
  JSON.stringify({
    llm: { baseUrl: 'https://openrouter.ai/api/v1', modelId: 'old-model', apiKey: 'sk-old', maxChunkChars: 24000, templateId: 'study', customTemplate: '', maxOutputTokens: 16384 },
    ui: { language: 'zh' }
  }),
  'utf-8'
)
initPaths(dir)
const a = loadConfig()
console.log('① 旧配置迁移:', JSON.stringify({ active: a.llm.activeProviderId, model: a.llm.modelId, key: a.llm.apiKey, n: a.llm.providers?.length, name: a.llm.providers?.[0]?.name }))

const b = saveConfig({
  llm: {
    ...a.llm,
    providers: [
      { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or', modelId: 'or-model', enabled: true },
      { id: 'deepseek', name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ds', modelId: 'deepseek-chat', fallbackModels: ['deepseek-reasoner'], enabled: true }
    ],
    activeProviderId: 'deepseek',
    autoFallback: true
  }
})
console.log('② 切到 DeepSeek:', JSON.stringify({ active: b.llm.activeProviderId, model: b.llm.modelId, baseUrl: b.llm.baseUrl, key: b.llm.apiKey, fallbacks: b.llm.fallbackModels }))
const raw = JSON.parse(readFileSync(`${dir}/config.json`, 'utf-8'))
console.log('③ 落盘加密:', JSON.stringify(raw.llm.providers.map((p: { id: string; apiKey: string }) => ({ id: p.id, key: p.apiKey }))))
const c = loadConfig()
console.log('④ 重新加载:', JSON.stringify({ active: c.llm.activeProviderId, model: c.llm.modelId, key: c.llm.apiKey, n: c.llm.providers?.length, dsKey: c.llm.providers?.find((p) => p.id === 'deepseek')?.apiKey }))

// ⑤ 旧 UI 只改 baseUrl/modelId（不传 providers）→ 不应破坏渠道列表，并镜像到当前渠道
const d = saveConfig({ llm: { ...c.llm, modelId: 'or-model-2' } } as never)
console.log('⑤ 只改 modelId:', JSON.stringify({ n: d.llm.providers?.length, active: d.llm.activeProviderId, model: d.llm.modelId, activeModel: d.llm.providers?.find((p) => p.id === d.llm.activeProviderId)?.modelId }))
