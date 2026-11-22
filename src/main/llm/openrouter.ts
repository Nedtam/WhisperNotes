// OpenRouter 客户端（OpenAI 兼容 Chat Completions，非流式）
import type { AppSettings } from '@shared/types'
import { bumpUsage, getDailyUsage, DAILY_FREE_LIMIT } from '../config'
import { i18nCode } from '../i18n'

/** 错误体截断：provider 有时会把整段请求回显在错误里，避免把兆级文本塞进界面/日志 */
export function clip(s: string, max = 800): string {
  const t = (s || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

export class LlmError extends Error {
  code: string
  /** 上游原始响应（截断），写进 organize.log 用于诊断 */
  raw?: string
  constructor(code: string, message: string, raw?: string) {
    super(message)
    this.code = code
    this.raw = raw
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  maxTokens?: number
  temperature?: number
  /** 外部中止（用户取消 / 看门狗超时） */
  signal?: AbortSignal
  /** 请求生命周期心跳：看门狗据此区分“真有请求在跑”与“卡死”（tick = 流式收到数据） */
  onActivity?: (phase: 'start' | 'end' | 'tick') => void
  /** 默认流式；显式 false 时用一次性 JSON 响应（少量内部调用/兼容不支持流式的上游） */
  stream?: boolean
  /** 完全不传 max_tokens，让上游使用自己的默认值（部分上游拒绝过大的 max_tokens） */
  omitMaxTokens?: boolean
  /** 覆盖本次请求使用的模型（换模型/换渠道重试时用） */
  modelOverride?: string
  /** 覆盖本次请求的 baseUrl（换渠道重试时用） */
  baseUrlOverride?: string
  /** 覆盖本次请求的 API Key（换渠道时用） */
  apiKeyOverride?: string
}

/**
 * 单次请求 max_tokens 的硬上限。实测（dots-3-note-preview:free / AtlasCloud）：
 *  · 32768 / 294912 / 327680 都接受；
 *  · 393216 / 460800（模型卡片标称值）→ 秒回 HTTP 400「Provider returned error / bad request」。
 * 卡片写的 460800 上游并不认，所以这里无论如何都不让单次请求越过安全线，
 * 用户设置再大也只会体现在"多次请求的总和"上，绝不会把整个任务打成 400。
 */
export const SAFE_MAX_TOKENS = 32_768

/** 空闲超时：这么久一个字节都没收到才算卡死（推理模型可能先"想"十几秒到一分钟） */
const IDLE_TIMEOUT_MS = 90_000
/** 兜底硬上限：单次请求最长允许多久（流式下慢模型也能跑完，但不允许无限挂） */
const HARD_TIMEOUT_MS = 15 * 60_000

/** 最近一次请求的用量（判断"预算被推理吃光"用） */
let lastUsageInfo: { completion: number; reasoning: number; prompt: number } = { completion: 0, reasoning: 0, prompt: 0 }
export function lastUsage(): { completion: number; reasoning: number; prompt: number } {
  return lastUsageInfo
}

export async function chatCompletion(
  settings: AppSettings,
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<string> {
  const { llm } = settings
  // 渠道能力：本地模型（Ollama/LM Studio）不需要 Key、也不占免费额度；
  // 免费额度只用于免费模型（OpenRouter 的 :free），付费 Key 不设每日上限。
  const active = llm.providers?.find((p) => p.id === llm.activeProviderId)
  const baseUrl = opts.baseUrlOverride ?? llm.baseUrl
  const key = opts.apiKeyOverride ?? llm.apiKey
  const local = active?.local === true || /^https?:\/\/(127\.0\.0\.1|localhost)/.test(baseUrl)
  const freeTier = !local && (llm.modelId.endsWith(':free') || active?.free === true)
  if (!key && !local) {
    throw new LlmError('NO_KEY', i18nCode('llm.noApiKey'))
  }
  if (freeTier) {
    const usage = getDailyUsage()
    const limit = Math.max(1, llm.dailyFreeLimit ?? DAILY_FREE_LIMIT)
    if (usage.used >= limit) {
      throw new LlmError('DAILY_LIMIT', i18nCode('llm.dailyLimit', { n: limit }))
    }
  }

  const base = (opts.baseUrlOverride ?? llm.baseUrl).replace(/\/+$/, '')
  const useStream = opts.stream !== false
  // 单次请求上限：夹到安全线内（见 SAFE_MAX_TOKENS 注释）
  const wantTokens = opts.omitMaxTokens ? null : (opts.maxTokens ?? 8192)
  const sendTokens = wantTokens === null ? null : Math.min(wantTokens, SAFE_MAX_TOKENS)
  const ctrl = new AbortController()
  // 超时口径：只要还在收数据就不算超时（推理模型先想 20~60s 很正常，一刀切 120s 会把正常请求杀掉）
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let abortKind: 'idle' | 'hard' | 'external' = 'idle'
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      abortKind = 'idle'
      ctrl.abort()
    }, IDLE_TIMEOUT_MS)
  }
  const hardTimer = setTimeout(() => {
    abortKind = 'hard'
    ctrl.abort()
  }, HARD_TIMEOUT_MS)
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort()
    else opts.signal.addEventListener('abort', () => { abortKind = 'external'; ctrl.abort() }, { once: true })
  }
  armIdle()
  opts.onActivity?.('start')
  try {
    let res: Response
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://localhost/whisper-notes',
          'X-Title': 'WhisperNotes'
        },
        body: JSON.stringify({
          model: opts.modelOverride ?? llm.modelId,
          messages,
          ...(sendTokens === null ? {} : { max_tokens: sendTokens }),
          temperature: opts.temperature ?? 0.3,
          stream: useStream,
          ...(useStream ? { stream_options: { include_usage: true } } : {})
        }),
        signal: ctrl.signal
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw abortError(opts, abortKind)
      throw new LlmError('NETWORK', i18nCode('llm.network', { msg: (err as Error).message }))
    }
    const ctype = res.headers.get('content-type') ?? ''
    if (useStream && res.ok && ctype.includes('text/event-stream') && res.body) {
      return await readStream(res, opts, armIdle, () => abortKind)
    }
    // 上游忽略 stream / 出错 / 非流式：按一次性 JSON 处理
    return await readCompletion(res, opts, () => abortError(opts, abortKind), sendTokens)
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    clearTimeout(hardTimer)
    opts.onActivity?.('end')
  }
}

/** 统一把 abort 归类：用户取消 / 空闲超时 / 硬超时 */
function abortError(opts: ChatOptions, kind: 'idle' | 'hard' | 'external'): LlmError {
  if (kind === 'external' && opts.signal?.aborted) return new LlmError('CANCELED', i18nCode('org.jobCanceled'))
  if (kind === 'hard') return new LlmError('TIMEOUT', i18nCode('llm.timeout', { sec: Math.round(HARD_TIMEOUT_MS / 1000) }))
  return new LlmError('TIMEOUT', i18nCode('llm.timeout', { sec: Math.round(IDLE_TIMEOUT_MS / 1000) }))
}

/** 流式读取（SSE）：收到任何数据都续命；推理增量也算"有动静"，避免慢模型被误杀 */
async function readStream(
  res: Response,
  opts: ChatOptions,
  armIdle: () => void,
  kind: () => 'idle' | 'hard' | 'external'
): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) throw new LlmError('NETWORK', i18nCode('llm.network', { msg: 'no-body' }))
  const dec = new TextDecoder()
  let buf = ''
  let out = ''
  let reason = ''
  let sawUsage = false
  for (;;) {
    let chunk: { done: boolean; value?: Uint8Array }
    try {
      chunk = await reader.read()
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw abortError(opts, kind())
      throw new LlmError('NETWORK', i18nCode('llm.network', { msg: (err as Error).message }))
    }
    if (chunk.done) break
    armIdle()
    opts.onActivity?.('tick')
    buf += dec.decode(chunk.value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let j: {
        error?: { message?: string }
        usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } }
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
      }
      try {
        j = JSON.parse(payload)
      } catch {
        continue
      }
      if (j.error) throw new LlmError('PROVIDER', i18nCode('llm.serverError', { status: 200, detail: clip(j.error.message ?? '') }), clip(payload, 800))
      if (j.usage) {
        sawUsage = true
        lastUsageInfo = {
          completion: j.usage.completion_tokens ?? 0,
          reasoning: j.usage.completion_tokens_details?.reasoning_tokens ?? 0,
          prompt: j.usage.prompt_tokens ?? 0
        }
      }
      const ch = j.choices?.[0]
      if (ch?.delta?.content) out += ch.delta.content
      if (ch?.finish_reason) reason = ch.finish_reason
    }
  }
  if (!sawUsage) {
    // 有些上游不回 usage：至少记录下有没有"只推理没正文"
    lastUsageInfo = { completion: 0, reasoning: 0, prompt: 0 }
  }
  // 请求已经打到上游（额度已消耗）→ 先记账，再判断内容是否为空
  bumpUsage(1)
  if (!out.trim()) {
    // 模型自己的安全过滤会返回 content_filter + 空正文：重试同样的文本通常还是被过滤，
    // 所以交给上层"拆小块再试"，而不是在这里反复重试同一份输入。
    if (reason === 'content_filter') throw new LlmError('FILTERED', i18nCode('llm.filtered'), 'finish=content_filter')
    throw new LlmError('EMPTY', i18nCode('llm.empty'), `reasoning_only? finish=${reason || '?'} usage=${JSON.stringify(lastUsageInfo)}`)
  }
  finishReason = reason || 'stop'
  return out
}

/** 读取并解析响应体（在同一段超时保护内） */
async function readCompletion(
  res: Response,
  opts: ChatOptions,
  onAbort: () => LlmError,
  sentMaxTokens: number | null = null
): Promise<string> {
  try {

  if (!res.ok) {
    let detail = ''
    let raw = ''
    try {
      raw = await res.text()
      try {
        const j = JSON.parse(raw) as {
          error?: { message?: string; metadata?: { raw?: string; provider_name?: string } }
        }
        detail = j.error?.message ?? ''
        // OpenRouter 常把上游细节放在 metadata.raw
        if (j.error?.metadata?.raw && !detail.includes(j.error.metadata.raw)) {
          detail = `${detail} — ${j.error.metadata.raw}`
        }
        // 带上具体上游名（免费模型会在多个上游之间轮换，便于判断是谁拒的）
        const prov = j.error?.metadata?.provider_name
        if (prov) detail = `${detail} [upstream: ${prov}]`
      } catch {
        detail = raw.slice(0, 600)
      }
    } catch {
      /* ignore */
    }
    detail = clip(detail, 600)
    raw = clip(raw, 2000)
    if (
      /maximum allowed input length|context length|context_length|too many tokens|input length|exceeds.*token|max_tokens.*(too large|exceed)|reduce the length|prompt is too long/i.test(
        detail
      )
    ) {
      throw new LlmError('CONTEXT', i18nCode('llm.context', { detail }), raw)
    }
    if (res.status === 400 && /provider returned error|invalid|unsupported|bad request/i.test(detail)) {
      // 预算明显过大时，直接把可操作建议一并带出（渲染层会翻译 @llm.budgetHint）
      const budget = sentMaxTokens ?? 8192
      const hint = ` @llm.budgetHint|n=${budget}`
      throw new LlmError('PROVIDER', i18nCode('llm.provider400', { detail: `${detail || 'HTTP 400'}${hint}` }), raw)
    }
    if (res.status >= 500) {
      throw new LlmError('PROVIDER', i18nCode('llm.serverError', { status: res.status, detail }), raw)
    }
    if (res.status === 429 || res.status === 402) {
      throw new LlmError(
        'RATE_LIMITED',
        i18nCode('llm.rateLimited', { status: res.status, detail: detail || i18nCode('llm.providerHint') }),
        raw
      )
    }
    throw new LlmError('HTTP', i18nCode('llm.http', { status: res.status, detail }), raw)
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } }
  }
  if (data.usage) {
    lastUsageInfo = {
      completion: data.usage.completion_tokens ?? 0,
      reasoning: data.usage.completion_tokens_details?.reasoning_tokens ?? 0,
      prompt: data.usage.prompt_tokens ?? 0
    }
  }
  const content = data.choices?.[0]?.message?.content ?? ''
  bumpUsage(1)
  if (!content.trim()) {
    if (data.choices?.[0]?.finish_reason === 'content_filter') {
      throw new LlmError('FILTERED', i18nCode('llm.filtered'), 'finish=content_filter')
    }
    throw new LlmError('EMPTY', i18nCode('llm.empty'), `reasoning_only? usage=${JSON.stringify(lastUsageInfo)}`)
  }
  finishReason = data.choices?.[0]?.finish_reason ?? ''
  return content
  } catch (err) {
    // 读 body 期间被超时/取消中断
    if ((err as Error).name === 'AbortError') throw onAbort()
    if (err instanceof LlmError) throw err
    throw new LlmError('NETWORK', i18nCode('llm.network', { msg: (err as Error).message }))
  }
}

/** 上一次请求的结束原因：'length' = 触顶被截断（供续写与提示用） */
let finishReason = ''
export function lastFinishReason(): string {
  return finishReason
}

/** 把错误压缩成一行人话（进度/日志用）：HTTP 400 · AtlasCloud 之类 */
export function shortError(e: unknown): string {
  if (!(e instanceof LlmError)) return String((e as Error)?.message ?? e).slice(0, 80)
  const raw = e.raw ?? ''
  // 从上游原始响应里抠出 provider 名与状态码（OpenRouter 会把上游细节放在 metadata.raw）
  let prov = ''
  try {
    const j = JSON.parse(raw) as { error?: { metadata?: { provider_name?: string } } }
    prov = j.error?.metadata?.provider_name ?? ''
  } catch {
    /* ignore */
  }
  const m = /HTTP (\d{3})/.exec(raw) ?? /"code":(\d{3})/.exec(raw)
  const bits = [e.code]
  if (m) bits.push(`HTTP ${m[1]}`)
  if (prov) bits.push(prov)
  if (e.code === 'FILTERED') bits.push('content_filter')
  return bits.join(' · ')
}

/** 续写提示：模型触顶后从断点继续，不重复已写内容 */
export const CONTINUE_PROMPT =
  'Your previous message was cut off because it hit the output length limit. Continue EXACTLY where it stopped. ' +
  'Do not repeat anything already written, do not add any preamble or closing remarks, and keep the same formatting. ' +
  'Output only the continuation.'

export interface ChatResult {
  content: string
  finishReason: string
  /** 本次实际发出的请求数（含续写） */
  requests: number
  /** 续写次数 */
  continuations: number
}

/**
 * 生成可能很长的内容：触顶（finish_reason=length）时自动续写，
 * 用更多请求换完整长文（每次续写算 1 次请求）。
 */
export async function chatCompletionLong(
  settings: AppSettings,
  messages: ChatMessage[],
  opts: ChatOptions & { maxContinuations?: number; onNote?: (s: string) => void } = {}
): Promise<ChatResult> {
  const maxCont = Math.max(0, opts.maxContinuations ?? 0)
  let content = ''
  let requests = 0
  let continuations = 0
  let reason = ''
  for (let i = 0; i <= maxCont; i++) {
    // 只带最近一段（约 1500 字符）作为“已写内容”的锚点：整段回传会让请求体迅速膨胀并触发 400/超限
    const tail = content.length > 1500 ? content.slice(-1500) : content
    const msgs: ChatMessage[] =
      i === 0 ? messages : [...messages, { role: 'assistant', content: tail }, { role: 'user', content: CONTINUE_PROMPT }]
    const part = await chatCompletion(settings, msgs, opts)
    requests += 1
    reason = lastFinishReason()
    content += part
    if (reason !== 'length') break
    // 只有真的要续写时才通知（否则会误报“触顶正在续写”）
    if (i < maxCont) {
      continuations += 1
      opts.onNote?.(part)
    }
  }
  return { content, finishReason: reason, requests, continuations }
}

export async function validateKey(settings: AppSettings): Promise<{ ok: boolean; error?: string }> {
  try {
    const out = await chatCompletion(settings, [
      { role: 'user', content: 'ping, reply with pong only' }
    ])
    return { ok: true, error: out }
  } catch (e) {
    const err = e as LlmError
    return { ok: false, error: err.message }
  }
}

/** 用指定渠道（可未保存）做一次连通性测试 */
export async function testChannel(
  settings: AppSettings,
  ch: { baseUrl: string; apiKey: string; modelId: string; local?: boolean }
): Promise<{ ok: boolean; error?: string; reply?: string }> {
  try {
    const out = await chatCompletion(settings, [{ role: 'user', content: 'ping, reply with pong only' }], {
      baseUrlOverride: ch.baseUrl,
      apiKeyOverride: ch.apiKey,
      modelOverride: ch.modelId,
      maxTokens: 16
    })
    return { ok: true, reply: out.slice(0, 80) }
  } catch (e) {
    const err = e as LlmError
    return { ok: false, error: err.message }
  }
}

/** 拉取渠道的模型列表（GET {baseUrl}/models，OpenAI 兼容） */
export async function listChannelModels(ch: {
  baseUrl: string
  apiKey: string
}): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const base = ch.baseUrl.replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await fetch(`${base}/models`, {
      headers: ch.apiKey ? { Authorization: `Bearer ${ch.apiKey}` } : {},
      signal: ctrl.signal
    })
    const raw = await res.text()
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status} ${raw.slice(0, 200)}` }
    const data = JSON.parse(raw) as { data?: Array<{ id?: string }> }
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .sort((a, b) => a.localeCompare(b))
    return { ok: true, models }
  } catch (e) {
    return { ok: false, models: [], error: (e as Error).message }
  } finally {
    clearTimeout(timer)
  }
}
