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
}

export async function chatCompletion(
  settings: AppSettings,
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<string> {
  const { llm } = settings
  if (!llm.apiKey) {
    throw new LlmError('NO_KEY', i18nCode('llm.noApiKey'))
  }
  const usage = getDailyUsage()
  if (usage.used >= DAILY_FREE_LIMIT) {
    throw new LlmError('DAILY_LIMIT', i18nCode('llm.dailyLimit', { n: DAILY_FREE_LIMIT }))
  }

  const base = llm.baseUrl.replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 120_000)
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort()
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true })
  }
  let res: Response
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${llm.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://localhost/whisper-notes',
        'X-Title': 'WhisperNotes'
      },
      body: JSON.stringify({
        model: llm.modelId,
        messages,
        max_tokens: opts.maxTokens ?? 8192,
        temperature: opts.temperature ?? 0.3,
        stream: false
      }),
      signal: ctrl.signal
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      // 外部取消 → 交给上层判定；否则视为 120s 超时
      if (opts.signal?.aborted) throw new LlmError('CANCELED', i18nCode('org.jobCanceled'))
      throw new LlmError('TIMEOUT', i18nCode('llm.timeout', { sec: 120 }))
    }
    throw new LlmError('NETWORK', i18nCode('llm.network', { msg: (err as Error).message }))
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    let detail = ''
    let raw = ''
    try {
      raw = await res.text()
      try {
        const j = JSON.parse(raw) as { error?: { message?: string; metadata?: { raw?: string } } }
        detail = j.error?.message ?? ''
        // OpenRouter 常把上游细节放在 metadata.raw
        if (j.error?.metadata?.raw && !detail.includes(j.error.metadata.raw)) {
          detail = `${detail} — ${j.error.metadata.raw}`
        }
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
      throw new LlmError('PROVIDER', i18nCode('llm.provider400', { detail: detail || 'HTTP 400' }), raw)
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
  }
  const content = data.choices?.[0]?.message?.content ?? ''
  if (!content) throw new LlmError('EMPTY', i18nCode('llm.empty'))
  bumpUsage(1)
  finishReason = data.choices?.[0]?.finish_reason ?? ''
  return content
}

/** 上一次请求的结束原因：'length' = 触顶被截断（供续写与提示用） */
let finishReason = ''
export function lastFinishReason(): string {
  return finishReason
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
    opts.onNote?.(part)
    if (reason !== 'length') break
    if (i < maxCont) continuations += 1
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
