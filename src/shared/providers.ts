// AI 渠道预设：都是 OpenAI 兼容的 /chat/completions 接口，换渠道只需换 baseUrl + Key + 模型
export interface ProviderPreset {
  id: string
  /** 显示名（中文界面直接用中文名） */
  name: string
  baseUrl: string
  /** 建议模型（可改；有的平台模型名常更新） */
  modelId: string
  /** 本地模型：不需要 API Key，也不占免费额度 */
  local?: boolean
  /** 申请 Key 的页面 */
  keyUrl?: string
  /** 分组：cn 国内 / intl 国际 / local 本地 / custom 自定义 */
  group: 'cn' | 'intl' | 'local' | 'custom'
  /** 界面上的一句话说明 */
  note?: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ── 国际 ──
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelId: 'deepseek/deepseek-chat-v3.1:free',
    keyUrl: 'https://openrouter.ai/settings/keys',
    group: 'intl',
    note: '一个 Key 用几百个模型，含免费模型（模型名带 :free）'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    modelId: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    group: 'intl'
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelId: 'gemini-2.0-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    group: 'intl',
    note: '用 Gemini 的 OpenAI 兼容端点（有免费额度）'
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    modelId: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    group: 'intl',
    note: '速度极快，适合长转写整理'
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    modelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    group: 'intl'
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    modelId: 'grok-2-latest',
    keyUrl: 'https://console.x.ai/',
    group: 'intl'
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    modelId: 'mistral-large-latest',
    keyUrl: 'https://console.mistral.ai/api-keys/',
    group: 'intl'
  },

  // ── 国内 ──
  {
    id: 'deepseek',
    name: 'DeepSeek 深度求索',
    baseUrl: 'https://api.deepseek.com/v1',
    modelId: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    group: 'cn',
    note: '便宜、中文强；deepseek-reasoner 更慢但更细'
  },
  {
    id: 'moonshot',
    name: 'Moonshot 月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    modelId: 'kimi-k2-0905-preview',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    group: 'cn',
    note: '长上下文友好；也可填 moonshot-v1-32k'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelId: 'glm-4-flash',
    keyUrl: 'https://bigmodel.cn/usercenter/apikeys',
    group: 'cn',
    note: 'glm-4-flash 有免费额度'
  },
  {
    id: 'dashscope',
    name: '通义千问（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelId: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/',
    group: 'cn',
    note: 'qwen-plus / qwen-max / qwen-long'
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow 硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    modelId: 'Qwen/Qwen2.5-7B-Instruct',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    group: 'cn',
    note: '聚合国产开源模型，部分免费'
  },
  {
    id: 'ark',
    name: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelId: 'doubao-1-5-pro-32k-250115',
    keyUrl: 'https://console.volcengine.com/ark',
    group: 'cn',
    note: '模型名需填方舟里的推理接入点或模型 ID'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    modelId: 'MiniMax-Text-01',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    group: 'cn'
  },

  // ── 本地 ──
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelId: 'qwen2.5:7b',
    local: true,
    group: 'local',
    note: '先 ollama pull qwen2.5:7b；不需要 Key，完全离线'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本地）',
    baseUrl: 'http://127.0.0.1:1234/v1',
    modelId: 'local-model',
    local: true,
    group: 'local',
    note: '在 LM Studio 里启动本地服务器后填其模型名'
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    baseUrl: 'https://example.com/v1',
    modelId: '',
    group: 'custom',
    note: '任何 OpenAI 兼容接口：填 Base URL、Key、模型名即可'
  }
]

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}
