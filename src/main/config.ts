// 设置与每日用量（JSON，userData/config.json）
import * as fs from 'node:fs'
import * as path from 'node:path'
import { safeStorage } from 'electron'
import type { AppSettings, DailyUsage } from '@shared/types'

let dir = ''

export function initPaths(d: string): void {
  dir = d
  for (const sub of ['models', 'logs', 'recordings']) {
    fs.mkdirSync(path.join(d, sub), { recursive: true })
  }
}

/** API Key 本地加密（macOS Keychain）。已加密（enc: 前缀）的保持不变 */
function encryptSecret(s: string): string {
  if (!s || s.startsWith('enc:')) return s
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(s).toString('base64')
    }
  } catch {
    /* 回退明文存储（系统不支持加密时） */
  }
  return s
}

function decryptSecret(s: string): string {
  if (typeof s !== 'string' || !s.startsWith('enc:')) return s
  try {
    return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'))
  } catch {
    return ''
  }
}

function file(): string {
  return path.join(dir, 'config.json')
}

export function defaultSettings(): AppSettings {
  return {
    whisper: {
      modelFile: 'ggml-large-v3-turbo-q5_0.bin',
      binaryPath: '',
      language: 'en',
      threads: 6,
      sensitivity: 55,
      minSilenceMs: 550,
      maxSpeechSec: 25,
      partialPreview: true,
      partialIntervalMs: 15000,
      partialMinMs: 5000,
      partialModelFile: '',
      maxFinalQueue: 6,
      useGpu: true
    },
    clean: { fillers: true, repeats: true, punctuation: true },
    llm: {
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'dots-studio/dots-3-note-preview:free',
      apiKey: '',
      maxChunkChars: 24000,
      maxOutputTokens: 16384,
      templateId: 'study',
      customTemplate: '',
      // 渠道列表：用旧字段迁移生成；默认只有一个 OpenRouter 渠道
      providers: [],
      activeProviderId: '',
      fallbackModels: [],
      autoFallback: true
    },
    ui: { language: 'zh' },
    mic: { preferredDeviceId: '' },
    // 手机连接默认关闭；开启后仅局域网可访问，需要配对码
    mobile: { enabled: false, port: 0, devices: [], serveApk: true },
    saveWav: false,
    autoOrganizeOnStop: true,
    storage: { recordingsParent: '', dataParent: '' },
    models: {}
  }
}

function mergeDeep<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return (patch as T) ?? base
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const k of Object.keys(patch as Record<string, unknown>)) {
    const pv = (patch as Record<string, unknown>)[k]
    const bv = (out as Record<string, unknown>)[k]
    if (pv !== undefined) {
      out[k] = typeof bv === 'object' && bv !== null && !Array.isArray(bv) ? mergeDeep(bv, pv) : pv
    }
  }
  return out as T
}

/** 让 providers[] 成为渠道的唯一真相，并把当前渠道镜像到 baseUrl/modelId/apiKey */
export function reconcileProviders(s: AppSettings, rawHadProviders: boolean): AppSettings {
  const llm = s.llm
  const list = Array.isArray(llm.providers) ? llm.providers.filter((p) => p && typeof p === 'object') : []
  llm.providers = list
  if (!rawHadProviders || list.length === 0) {
    // 旧配置（只有 baseUrl/modelId/apiKey）→ 迁移成一个渠道
    llm.providers = [
      {
        id: 'default',
        name: 'OpenRouter',
        baseUrl: llm.baseUrl,
        apiKey: llm.apiKey,
        modelId: llm.modelId,
        fallbackModels: llm.fallbackModels ?? [],
        enabled: true
      }
    ]
    llm.activeProviderId = 'default'
    return s
  }
  const seen = new Set<string>()
  for (let i = 0; i < llm.providers.length; i++) {
    const p = llm.providers[i]
    let id = (p.id || '').trim() || `p${i + 1}`
    while (seen.has(id)) id = `${id}-${i + 1}`
    p.id = id
    seen.add(id)
    if (p.enabled === undefined) p.enabled = true
    if (!Array.isArray(p.fallbackModels)) p.fallbackModels = []
  }
  const active =
    llm.providers.find((p) => p.id === llm.activeProviderId && p.enabled !== false) ??
    llm.providers.find((p) => p.enabled !== false) ??
    llm.providers[0]
  llm.activeProviderId = active.id
  if (active.baseUrl) llm.baseUrl = active.baseUrl
  if (active.modelId) llm.modelId = active.modelId
  llm.apiKey = active.apiKey ?? ''
  llm.fallbackModels = active.fallbackModels ?? []
  return s
}

export function loadConfig(): AppSettings {
  try {
    if (!fs.existsSync(file())) return defaultSettings()
    const raw = JSON.parse(fs.readFileSync(file(), 'utf-8')) as Partial<AppSettings>
    const next = mergeDeep(defaultSettings(), raw)
    // 读出时解密 API Key（含每个渠道），供本机各模块使用
    next.llm.apiKey = decryptSecret(next.llm.apiKey)
    const rawProviders = (raw.llm as { providers?: unknown } | undefined)?.providers
    const hadProviders = Array.isArray(rawProviders) && rawProviders.length > 0
    next.llm.providers = (next.llm.providers ?? []).map((p) => ({ ...p, apiKey: decryptSecret(p.apiKey) }))
    return reconcileProviders(next, hadProviders)
  } catch {
    return defaultSettings()
  }
}

export function saveConfig(patch: Partial<AppSettings>): AppSettings {
  const cur = loadConfig()
  const next = mergeDeep(cur, patch)
  const hadProviders = Array.isArray((patch.llm as { providers?: unknown } | undefined)?.providers)
  reconcileProviders(next, hadProviders || (next.llm.providers?.length ?? 0) > 0)
  // 落盘前加密 API Key（已有 enc: 前缀则保持不变）
  next.llm.apiKey = encryptSecret(next.llm.apiKey)
  next.llm.providers = (next.llm.providers ?? []).map((p) => ({ ...p, apiKey: encryptSecret(p.apiKey) }))
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(next, null, 2), 'utf-8')
  return {
    ...next,
    llm: {
      ...next.llm,
      apiKey: decryptSecret(next.llm.apiKey),
      providers: (next.llm.providers ?? []).map((p) => ({ ...p, apiKey: decryptSecret(p.apiKey) }))
    }
  }
}

function usageFile(): string {
  return path.join(dir, 'usage.json')
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function getDailyUsage(): DailyUsage {
  try {
    const u = JSON.parse(fs.readFileSync(usageFile(), 'utf-8')) as DailyUsage
    if (u.date !== today()) return { date: today(), used: 0 }
    return u
  } catch {
    return { date: today(), used: 0 }
  }
}

export function bumpUsage(n = 1): DailyUsage {
  const u = getDailyUsage()
  u.used += n
  fs.writeFileSync(usageFile(), JSON.stringify(u), 'utf-8')
  return u
}

export function resetDailyUsage(): void {
  fs.writeFileSync(usageFile(), JSON.stringify({ date: today(), used: 0 }), 'utf-8')
}

/** 本地免费额度保护上限（OpenRouter 免费档现已放宽到 1000 次/天）；可在设置里改 */
export const DAILY_FREE_LIMIT = 1000

/** 迁移旧配置：若 API Key 仍是明文，就地加密保存（保持 enc: 前缀不变） */
export function ensureSecretsEncrypted(): void {
  try {
    if (!fs.existsSync(file())) return
    const raw = JSON.parse(fs.readFileSync(file(), 'utf-8')) as {
      llm?: { apiKey?: unknown; providers?: Array<{ apiKey?: unknown }> }
    }
    let dirty = false
    const k = raw.llm?.apiKey
    if (typeof k === 'string' && k && !k.startsWith('enc:')) {
      if (raw.llm) raw.llm.apiKey = encryptSecret(k)
      dirty = true
    }
    for (const p of raw.llm?.providers ?? []) {
      if (typeof p?.apiKey === 'string' && p.apiKey && !p.apiKey.startsWith('enc:')) {
        p.apiKey = encryptSecret(p.apiKey)
        dirty = true
      }
    }
    if (dirty) fs.writeFileSync(file(), JSON.stringify(raw, null, 2), 'utf-8')
  } catch {
    /* ignore */
  }
}
