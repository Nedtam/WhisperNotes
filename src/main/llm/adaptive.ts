// 共享的"上游失败自动降级"引擎：输出预算阶梯 → 换模型/换渠道
//
// 整理（organize）与出闪卡（cards）共用这一份，避免两套行为各自漂移：
//   ① 同参数重试一次（空回复/网络抖动）
//   ② 逐级缩小 max_tokens，最后干脆不带（上游对 max_tokens 敏感时有效）
//   ③ 备用模型 → 其它已启用渠道
// 输入侧的拆分（把过大的文本切两半）由调用方负责，因为两者切法不同。
import type { AppSettings } from '@shared/types'
import { chatCompletionLong, lastUsage, LlmError } from './openrouter'

export interface LlmTarget {
  modelId: string
  baseUrl?: string
  apiKey?: string
  label?: string
}

/** 可重试/可降级的上游错误（DAILY_LIMIT 是本地免费额度，不该靠换模型绕开） */
export const RETRYABLE_CODES = ['CONTEXT', 'PROVIDER', 'HTTP', 'EMPTY', 'TIMEOUT', 'NETWORK', 'RATE_LIMITED', 'FILTERED']

export function isRetryable(e: unknown): boolean {
  return RETRYABLE_CODES.includes((e as LlmError).code)
}

/**
 * 上游整片故障时才会用到的备用模型（免费档，实测可用）。
 * 为什么要有它：dots 免费模型只有 AtlasCloud 一个上游，一旦它成片 502，
 * 单渠道再怎么退避重试也只是白烧额度 —— 这时换一条真能用的免费通道才有意义。
 * 只在"退避重试全部用尽"后才启用，且会自动跳过用户当前正在用的那个模型。
 */
export const BUILTIN_OUTAGE_FALLBACKS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-31b-it:free'
]

/** 组装故障备用目标（同一渠道，仅换模型；用户关掉 autoFallback 就不启用） */
export function buildOutageTargets(settings: AppSettings): LlmTarget[] {
  if (settings.llm.autoFallback === false) return []
  const out: LlmTarget[] = []
  const primary = settings.llm.modelId
  // 付费模型自己就有多上游，不需要这套
  if (!primary.endsWith(':free')) return []
  for (const m of BUILTIN_OUTAGE_FALLBACKS) {
    if (m === primary) continue
    out.push({ modelId: m, label: m.replace(':free', ' (免费备用)') })
  }
  return out
}

/** 自动换模型/换渠道的候选顺序：同渠道备用模型 → 其它已启用渠道 */
export function buildFallbackTargets(settings: AppSettings): LlmTarget[] {
  if (settings.llm.autoFallback === false) return []
  const out: LlmTarget[] = []
  const seen = new Set<string>([`${settings.llm.baseUrl}|${settings.llm.modelId}`])
  const push = (t: LlmTarget): void => {
    const key = `${t.baseUrl ?? settings.llm.baseUrl}|${t.modelId}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ ...t, label: t.label ?? t.modelId })
  }
  for (const m of settings.llm.fallbackModels ?? []) if (m && m.trim()) push({ modelId: m.trim() })
  for (const p of settings.llm.providers ?? []) {
    if (p.enabled === false) continue
    if (!p.baseUrl || !p.apiKey || !p.modelId) continue
    if (p.id === settings.llm.activeProviderId) continue
    push({ modelId: p.modelId, baseUrl: p.baseUrl, apiKey: p.apiKey, label: `${p.name || p.modelId}` })
    for (const m of p.fallbackModels ?? []) {
      if (m && m.trim()) push({ modelId: m.trim(), baseUrl: p.baseUrl, apiKey: p.apiKey, label: `${p.name || ''} / ${m}`.trim() })
    }
  }
  return out
}

/**
 * 上游整片故障（5xx / 超时 / 网络中断）：跟"这次的请求太大/被内容过滤"完全不是一类问题。
 *  · 拆小输入没用（拆了照样 502），缩预算也没用；
 *  · 唯一有效的是**等一会儿再发同样的请求**（实测 502 是成片出现的窗口，几十秒到几分钟就恢复）。
 */
export function isOutage(e: unknown): boolean {
  const err = e as LlmError
  if (!err || typeof err.code !== 'string') return false
  // · 5xx / 超时 / 网络：上游整片抖动的典型形态
  // · PROVIDER：上游（如 AtlasCloud）用它回"我这边拒绝了"，实测成片出现，重发/换模型才有效，
  //   而"拆小输入""缩小预算"对它毫无帮助 —— 所以归到这一类，由退避 + 备用通道处理
  // · RATE_LIMITED：限速，等待即可
  // 注意不含 CONTEXT（输入超长 → 该拆）、FILTERED（内容被过滤 → 该拆/该精简）、
  // EMPTY（预算被推理吃光 → 该放大预算）、DAILY_LIMIT（本地额度用尽 → 必须停）。
  if (err.code === 'TIMEOUT' || err.code === 'NETWORK' || err.code === 'RATE_LIMITED' || err.code === 'PROVIDER') return true
  if (err.code === 'HTTP') {
    const m = /HTTP (\d{3})/.exec(err.raw ?? '')
    return !m || Number(m[1]) >= 500
  }
  return false
}

/** 故障退避表（毫秒）：同一请求按这个节奏重发，给上游留恢复时间 */
export const OUTAGE_BACKOFF_MS = [0, 4_000, 12_000, 30_000]

export interface LadderLabels {
  /** 同参数重试 */
  same: () => string
  /** 缩小输出预算 */
  smaller: (tokens: number) => string
  /** 换更大的输出预算（推理模型把预算"想"完了时必须变大而不是变小） */
  bigger?: (tokens: number) => string
  /** 上游整片故障 → 等待后重发（第 n 次） */
  outage?: (n: number, waitSec: number) => string
  /** 不限制输出长度 */
  noLimit: () => string
  /** 换模型/渠道 */
  model: (name: string) => string
}

export interface ChatWithLadderOptions {
  /** 首次尝试的输出预算；null = 不传 max_tokens（推理模型把预算吃光后的正确起点） */
  firstBudget: number | null
  /** 允许的续写次数（首轮用；降级重试一律 0，避免越试越慢） */
  maxContinuations?: number
  signal?: AbortSignal
  onActivity?: (phase: 'start' | 'end' | 'tick') => void
  /** 每次降级前回报一句人话（由调用方组装进自己的进度事件） */
  onRetry?: (detail: string) => void
  labels: LadderLabels
  /** 备用目标（默认按 settings 自动计算） */
  targets?: LlmTarget[]
  /** 上游整片故障、退避用尽后才启用的备用模型（换一条真能用的免费通道） */
  outageTargets?: LlmTarget[]
  /** 直接指定首次尝试用的模型/渠道（上一个分块已经证明它可用 → 后续都走它，别再撞坏的那条） */
  preferTarget?: LlmTarget
  /** 每次尝试前的钩子：可用于记录日志/限制次数 */
  onAttempt?: (info: { budget: number | null; target?: LlmTarget; retry: boolean }) => void
  /** 最多尝试几次（默认走完整阶梯）。用于"额度保护"：失败段落不要无限重试 */
  maxTries?: number
  /** 某次尝试失败：把真实错误（含上游名/状态码）回报给调用方，便于日志与界面显示 */
  onAttemptError?: (e: unknown, info: { budget: number | null; target?: LlmTarget }) => void
}

export interface LadderResult {
  content: string
  finishReason: string
  continuations: number
  /** 实际生效的输出预算（上游拒绝过就变小，调用方可以沉淀复用） */
  usedBudget: number | null
  /** 是否是"预算被推理吃光后放大预算"才成功的（调用方据此对后续请求直接不设上限） */
  grewBudget: boolean
  /** 本次成功实际用的是哪个目标（用了备用模型/渠道时非空） */
  usedTarget?: LlmTarget
}

/**
 * 依次尝试：首预算 → 同参数 → 半预算/4096 → 无上限 → 备用模型/渠道。
 * 全部失败时抛出最后一次的错误（上层可据此决定拆输入或放弃）。
 */
export async function chatWithLadder(
  settings: AppSettings,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: ChatWithLadderOptions
): Promise<LadderResult> {
  const maxCont = opts.maxContinuations ?? 0
  const firstBudget = opts.firstBudget
  const targets = opts.targets ?? buildFallbackTargets(settings)

  // firstBudget=null：直接"不设输出上限"起步 —— 已经知道小预算会被推理吃光，不再重复撞墙
  const tries: Array<{ budget: number | null; cont: number; target?: LlmTarget; retry: boolean }> = [
    { budget: firstBudget, cont: maxCont, retry: false, target: opts.preferTarget },
    { budget: firstBudget, cont: maxCont, retry: true, target: opts.preferTarget }
  ]
  if (firstBudget !== null) {
    for (const cap of [Math.min(8192, Math.max(4096, Math.floor(firstBudget / 2))), 4096]) {
      if (cap < firstBudget) tries.push({ budget: cap, cont: 0, retry: true })
    }
  }
  tries.push({ budget: null, cont: 0, retry: true })
  for (const tg of targets) tries.push({ budget: null, cont: 0, target: tg, retry: true })

  // 额度保护：只保留最有用的前几次尝试，并始终以"不设上限"收尾
  // （实测：同一个请求的瞬时 400 重试一次常常就好了；缩小预算对推理模型反而更糟）
  if (opts.maxTries !== undefined && opts.maxTries < tries.length) {
    const n = Math.max(1, opts.maxTries)
    const kept = tries.slice(0, Math.max(0, n - 1))
    const last = tries.find((x) => x.budget === null && !x.target) ?? tries[tries.length - 1]
    kept.push({ ...last, retry: kept.length > 0 })
    tries.length = 0
    tries.push(...kept)
  }

  let lastErr: unknown
  let usedBudget: number | null = null
  // content_filter 只给一次同样的机会：过滤多半是随机的，第二次不过就直接让上层拆小块
  let filteredRetried = false
  // 推理模型：预算被"思考"吃光时，唯一有效的对策是给更多预算（只加一次，避免无限膨胀）
  let grewBudget = false
  // 上游整片故障（5xx/超时/网络）：不推进阶梯，原地退避重发（拆输入/缩预算对 502 毫无用处）
  let outageTries = 0
  let outageUsed = 0 // 已经切换到第几个内置故障备用模型
  for (let ti = 0; ti < tries.length; ti++) {
    const t = tries[ti]
    if (t.retry && outageTries === 0) {
      const detail = t.target
        ? opts.labels.model(t.target.label ?? t.target.modelId)
        : t.budget === null
          ? opts.labels.noLimit()
          : t.budget !== firstBudget
            ? opts.labels.smaller(t.budget)
            : opts.labels.same()
      opts.onRetry?.(detail)
    }
    opts.onAttempt?.({ budget: t.budget, target: t.target, retry: t.retry })
    try {
      const r = await chatCompletionLong(
        settings,
        messages as Array<{ role: 'system' | 'user'; content: string }>,
        {
          ...(t.budget === null ? { omitMaxTokens: true } : { maxTokens: t.budget }),
          ...(t.target
            ? { modelOverride: t.target.modelId, baseUrlOverride: t.target.baseUrl, apiKeyOverride: t.target.apiKey }
            : {}),
          signal: opts.signal,
          onActivity: opts.onActivity,
          maxContinuations: t.cont
        }
      )
      usedBudget = t.budget
      return {
        content: r.content,
        finishReason: r.finishReason,
        continuations: r.continuations,
        usedBudget,
        grewBudget,
        usedTarget: t.target
      }
    } catch (e) {
      lastErr = e
      opts.onAttemptError?.(e, { budget: t.budget, target: t.target })
      if (!isRetryable(e)) throw e
      // ── 上游整片故障：原地退避重发同一请求（不推进阶梯、不拆输入、不缩预算）──
      if (isOutage(e)) {
        if (outageTries < OUTAGE_BACKOFF_MS.length - 1) {
          outageTries += 1
          const wait = OUTAGE_BACKOFF_MS[outageTries]
          opts.onRetry?.(opts.labels.outage?.(outageTries, Math.round(wait / 1000)) ?? opts.labels.same())
          if (opts.signal?.aborted) throw e
          await new Promise((r) => setTimeout(r, wait))
          if (opts.signal?.aborted) throw e
          ti -= 1 // 同一档位再试
          continue
        }
        // 退避用尽：换内置的免费备用通道（只换模型、同渠道），每个也给一次退避机会
        const outage = opts.outageTargets ?? []
        const next = outage[outageUsed]
        if (next) {
          outageUsed += 1
          outageTries = 0
          opts.onRetry?.(opts.labels.model(next.label ?? next.modelId))
          tries.splice(ti + 1, 0, { budget: t.budget, cont: 0, target: next, retry: false })
          continue
        }
        throw e // 备用也用尽 → 交给上层（上层决定是否换策略/降级保留原文）
      }
      // CONTEXT = 输入本身超长：调输出预算没用，直接交给上层（拆输入）
      if ((e as LlmError).code === 'CONTEXT') throw e
      // 被安全过滤：同样的文本再试一次（过滤带随机性）；再被过滤就交给上层拆小块
      if ((e as LlmError).code === 'FILTERED') {
        if (filteredRetried) throw e
        filteredRetried = true
      }
      // 空回复且几乎全部额度都进了 reasoning_tokens → 是预算太小（不是内容问题），必须放大预算
      const cap = t.budget
      const u = lastUsage()
      const starved =
        (e as LlmError).code === 'EMPTY' && cap !== null && cap > 0 && u.reasoning >= Math.floor(cap * 0.8)
      if (starved && !grewBudget) {
        grewBudget = true
        const doubled = cap * 2
        const biggerBudget: number | null = doubled > 16384 ? null : doubled
        opts.onRetry?.(
          biggerBudget === null
            ? opts.labels.noLimit()
            : (opts.labels.bigger ?? opts.labels.smaller)(biggerBudget)
        )
        // retry:false —— 这条的提示上面已经发过，避免同一句提示刷两遍
        tries.splice(ti + 1, 0, { budget: biggerBudget, cont: 0, retry: false })
        continue
      }
    }
  }
  throw lastErr
}
