// 把隔离环境（/tmp/wn-devbase）的 AI 渠道固定到本地假模型，供各套件使用
import * as fs from 'node:fs'
const p = '/tmp/wn-devbase/whisper-notes/config.json'
const c = JSON.parse(fs.readFileSync(p, 'utf-8'))
c.llm = {
  ...c.llm,
  baseUrl: 'http://127.0.0.1:8799/v1',
  apiKey: 'fake-key',
  modelId: 'fake-model',
  autoFallback: false,
  providers: [{ id: 'fake', name: 'Fake', baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'fake-key', modelId: 'fake-model', enabled: true }],
  activeProviderId: 'fake'
}
fs.writeFileSync(p, JSON.stringify(c, null, 2))
console.log('隔离渠道 → 假模型')
