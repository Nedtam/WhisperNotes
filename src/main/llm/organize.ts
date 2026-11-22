// 笔记整理：模板 + 长度档 + 课件参考 → 分块 map / 合并 reduce
import type { AppSettings, LlmProgress, NoteLength, OrganizeResult } from '@shared/types'
import { LlmError } from './openrouter'
import { buildOutageTargets, chatWithLadder, buildFallbackTargets, isOutage, isRetryable, type LlmTarget } from './adaptive'
import { shortError } from './openrouter'
import { documentRule, getEffectiveTemplate, lengthRule, slidesRule } from './templates'
import { i18nCode, tm } from '../i18n'
import { languageDirective } from '../../shared/notation'
import { assembleNotes } from './assemble'
import { coverageOk } from './coverage'
import { createHash } from 'node:crypto'

/** 段文本 → 缓存键（同一段文本在任何分块方式下都是同一个键） */
export function partHashOf(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 20)
}

/** 组织参数指纹：模型/模板/长度/语言/课件任一变化都不复用旧结果 */
export function organizeFingerprint(info: {
  modelId: string
  templateId?: string
  length?: NoteLength
  sourceText: string
  slidesText?: string
}): string {
  const h = createHash('sha1')
  h.update(info.modelId)
  h.update('|' + (info.templateId ?? ''))
  h.update('|' + (info.length ?? 'standard'))
  h.update('|' + languageDirective(info.sourceText))
  h.update('|slides:' + partHashOf(info.slidesText ?? ''))
  return h.digest('hex').slice(0, 20)
}

/** 整篇转写的缓存命名空间 */
export function docHashOf(sourceText: string): string {
  return partHashOf(sourceText.replace(/\r/g, '').trim())
}

import { MAX_ORGANIZE_CHARS } from '../../shared/limits'

/** 单次整理的安全上限（超长讲座需分批，避免请求过大/空回复）—— 与渲染层共用同一个常量 */
export { MAX_ORGANIZE_CHARS }
/**
 * 每块输入字符数上限。实测（dots-3 free，流式）：
 *  · 12k 字输入 + 课件 → 30s、输出约 4000 字，稳；
 *  · 再大就会拖到几分钟，且更容易被上游截断或超时。
 * 所以按"稳定可完成"定尺寸，而不是按块数硬压 —— 块多没关系，请求数由 50 次预算兜底。
 */
const CHUNK_CHARS_MAX = 13_000
const CHUNK_CHARS_MIN = 2_500
/** 单次请求的输出预算上限（含推理 token；推理模型先花 1.5~2k 想） */
const REQUEST_BUDGET_MAX = 12_000
/** 统一成一篇时的输入上限：超过就先分段完整拼接（保证完整），不再冒险统一 */
const UNIFY_INPUT_MAX = 60_000
/** 统一结果至少要有拼接版的这个比例，否则视为"合并把内容吃掉了"→回退完整拼接版 */
const UNIFY_MIN_RATIO = 0.5
/**
 * 单次整理任务的请求上限（额度保护）。实测上游会出现成片的瞬时拒绝，
 * 一个失败的段落如果无限重试+无限拆分，能烧掉 50 次以上额度。
 * 到达上限后：剩余段落先保留原文、整篇标"未完成"，用户点「继续」时只补这些段落（很省）。
 */
const MAX_JOB_REQUESTS = 45

/**
 * 断点续做：每段整理成功后立刻交给调用方落盘；再次整理同一篇转写时，
 * 已经成功的段落直接复用（0 请求），只重做上次失败的段 —— 这就是「继续」而不是「重新」。
 */
export interface OrganizeCheckpoint {
  /** 命中则返回该段上次的结果（ok=整理好了 · raw=保留原文 · fail=上次彻底失败） */
  load(partHash: string): { md: string; status: 'ok' | 'raw' | 'fail' } | undefined
  /** 一段成功/兜底后立刻落盘（中途取消也不丢进度）；fail 用于"下次换个策略" */
  save(partHash: string, md: string, status: 'ok' | 'raw' | 'fail'): void
}

export interface OrganizePayload {
  title: string
  sourceText: string
  templateId?: string
  length?: NoteLength
  slidesText?: string
  /** transcript=语音转写（默认）· document=文档（只从文档抓要点） */
  source?: 'transcript' | 'document'
}

export async function organizeText(
  settings: AppSettings,
  payload: OrganizePayload,
  onProgress: (p: LlmProgress) => void,
  signal?: AbortSignal,
  onActivity?: (phase: 'start' | 'end' | 'tick') => void,
  checkpoint?: OrganizeCheckpoint
): Promise<OrganizeResult> {
  const llmSettings = { ...settings.llm, templateId: payload.templateId ?? settings.llm.templateId }
  const eff: AppSettings = { ...settings, llm: llmSettings }
  const tpl = getEffectiveTemplate(eff)
  const text = payload.sourceText.trim()
  if (!text) throw new Error(i18nCode('org.noText'))
  if (text.length > MAX_ORGANIZE_CHARS) {
    throw new Error(
      i18nCode('org.tooLong', { len: text.length.toLocaleString(), max: MAX_ORGANIZE_CHARS.toLocaleString() })
    )
  }

  const title = payload.title.trim() || tm('org.defaultTitle')
  const slides = (payload.slidesText ?? '').trim()
  // 系统提示按课件长度可重建：输入被拒时逐级收敛课件上下文（自适应）
  // 语言硬约束跟着"转写主体语言"走：英文课里混进中文是模型最常见的跑偏
  const langRule = `\n\n${languageDirective(text)}`
  // 文档模式：走"只从文档抓要点"的规则，且不再注入课件参考（文档本身就是唯一来源）
  const isDoc = payload.source === 'document'
  const makeSystem = (slideText: string): string =>
    tpl.systemPrompt.replaceAll('{title}', title) +
    langRule +
    (isDoc ? documentRule() : '') +
    lengthRule(payload.length) +
    (isDoc ? '' : slidesRule(slideText || undefined))
  const baseSystem = makeSystem(slides)

  // 块大小：取用户设置（默认 14000）与"实测稳定上限"的较小值；太小则合并，避免碎片化请求
  const userChunk = Math.max(2000, eff.llm.maxChunkChars || 24000)
  const chunkChars = Math.min(CHUNK_CHARS_MAX, Math.max(CHUNK_CHARS_MIN, userChunk))
  const parts = splitParts(text, chunkChars)
  const requests: string[] = []
  // 输出预算：用户设置是"整篇总量"，单次请求必须按"能在超时内跑完"封顶，
  // 不够的部分靠续写（每次续写同样是 1 次请求，仍远低于 50 次预算）
  const userBudget = Math.max(2048, settings.llm.maxOutputTokens ?? 16384)
  const outBudget = Math.min(userBudget, REQUEST_BUDGET_MAX)
  // 首块用小一点探路：上游/渠道的真实上限往往比设置小
  const maxCont = 2
  let continuations = 0
  let truncated = false
  // 上游一旦拒绝，就把本任务后续块的预算降下来，避免每块都撞同一堵墙
  let budgetCeiling = outBudget
  // 一旦发现"小预算会被推理吃光"，后续请求直接不设上限（省掉重复撞墙的请求）
  let preferNoCap = false
  let spentRequests = 0 // 本任务已发出的请求数（额度保护）
  let budgetOut = false // 是否已到请求上限
  // 上游不稳时的"就地止血"：某个模型一旦证明可用就钉住它；
  // 若连备用都全军覆没，就认定上游整体不可用，后续分块只试一次（不再反复退避烧额度）
  let pinnedTarget: LlmTarget | undefined
  let upstreamDown = false

  onProgress({ stage: 'chunk', part: 0, parts: parts.length, detail: tm('org.parts', { n: parts.length }) })

  // ============ 自适应引擎（输入 + 输出全自动，失败自动换模型/渠道）============
  // 输出侧：预算阶梯（首预算 → 半预算 → 4096 → 不带 max_tokens）
  // 输入侧：同类失败后拆块（最多 2 级），并把“已知上限”沉淀给后续块，越用越省
  // 渠道侧：同渠道备用模型 → 其它已配置渠道（autoFallback）
  // 降级引擎在 ./adaptive（与出闪卡共用同一套阶梯），这里只保留文案与拆输入策略
  const retryable = isRetryable
  const targets = buildFallbackTargets(eff)
  // 上游成片 502 时的兜底通道（换一条真能用的免费模型），只在退避重试全部用尽后才动
  const outageTargets = buildOutageTargets(eff)
  let sizeCeiling = Number.POSITIVE_INFINITY // 已知被拒的输入尺寸上限（沉淀给后续块，越用越省）
  let openedParts = 0 // 因自动拆输入而多出来的段数
  let failedParts = 0 // 彻底整理失败、退化为原文的段数
  let reusedParts = 0 // 命中断点缓存、直接复用（0 请求）的段数
  const noteBuf: string[] = []
  // 记住每段的下标 → 便于失败后只重跑失败段
  const partResults: Array<{ i: number; n: number; ok: boolean }> = []
  // 失败段在 noteBuf 里的位置 → 收尾时只重做这些段（上游抖动多半重试就好）
  const failedAt: Array<{ pos: number; text: string; i: number; n: number }> = []

  /** 单次调用 + 全部降级重试；全失败则抛出，由上层决定是否拆输入 */
  const attempt = async (
    msgs: Array<{ role: 'system' | 'user'; content: string }>,
    firstBudget: number | null,
    i2: number,
    n: number,
    kind: 'chunk' | 'merge' = 'chunk',
    /** 已经是"拆出来的小段"时不再走完整阶梯（额度保护） */
    noRetryDepth = false,
    /** 上游已被判定不可用 → 只试一次，别再把额度烧在必败的重试上 */
    fastFail = false
  ): Promise<{ content: string; finishReason: string; continuations: number; noCapNeeded: boolean }> => {
    const r = await chatWithLadder(eff, msgs, {
      firstBudget,
      maxContinuations: maxCont,
      signal,
      onActivity,
      targets,
      outageTargets: fastFail ? [] : outageTargets,
      preferTarget: fastFail ? undefined : pinnedTarget,
      onRetry: (detail) => onProgress({ stage: kind === 'merge' ? 'merge' : 'chunk', part: i2 + 1, parts: n, detail }),
      // 失败原因直接写进进度 → 落到 organize.log，下次出问题一眼看得出是谁拒的
      onAttemptError: (e) => onProgress({ stage: kind === 'merge' ? 'merge' : 'chunk', part: i2 + 1, parts: n, detail: tm('org.attemptFailed', { why: shortError(e) }) }),
      onAttempt: () => {
        spentRequests += 1
        if (spentRequests >= MAX_JOB_REQUESTS) budgetOut = true
      },
      maxTries: fastFail ? 1 : noRetryDepth ? 2 : 3,
      labels: {
        same: () => (kind === 'merge' ? tm('org.mRetrySame') : tm('org.retrySame', { i: i2 + 1, n })),
        smaller: (t) => (kind === 'merge' ? tm('org.mRetrySmaller', { t }) : tm('org.retrySmaller', { i: i2 + 1, n, t })),
        bigger: (t) => (kind === 'merge' ? tm('org.mRetryBigger', { t }) : tm('org.retryBigger', { i: i2 + 1, n, t })),
        outage: (k, sec) => (kind === 'merge' ? tm('org.mOutage', { k, sec }) : tm('org.outageWait', { i: i2 + 1, n, k, sec })),
        noLimit: () => (kind === 'merge' ? tm('org.mRetryNoLimit') : tm('org.retryNoLimit', { i: i2 + 1, n })),
        model: (m) => (kind === 'merge' ? tm('org.mRetryModel', { m }) : tm('org.retryModel', { i: i2 + 1, n, m }))
      }
    })
    if (r.usedBudget !== null && r.usedBudget < budgetCeiling) budgetCeiling = r.usedBudget
    if (r.grewBudget) preferNoCap = true
    // 用备用模型成功过 → 后续分块直接走它（坏掉的那条别再撞）
    if (r.usedTarget) {
      pinnedTarget = r.usedTarget
      onProgress({
        stage: kind === 'merge' ? 'merge' : 'chunk',
        part: i2 + 1,
        parts: n,
        detail: tm('org.switchedModel', { m: r.usedTarget.label ?? r.usedTarget.modelId })
      })
    }
    return { content: r.content, finishReason: r.finishReason, continuations: r.continuations, noCapNeeded: r.grewBudget }
  }

  /**
   * 精简兜底：当这段怎么都整理不出来时，用"最小请求"再试一次 ——
   * 只要 8~12 条短要点、输出预算压到 2500，几乎不会被截断/过滤，
   * 命中就仍然是**真笔记**（而不是把原文塞进笔记里）。
   * 这一招专门对付：上游抖动、预算被推理吃光、内容被安全过滤、模型绕圈子。
   */
  const organizeCompact = async (text: string, i: number, n: number): Promise<boolean> => {
    const sys =
      tpl.systemPrompt.replaceAll('{title}', title) +
      langRule +
      (isDoc ? documentRule() : '') +
      `
LENGTH MODE: KEY POINTS (fallback).
- Output at most 12 short bullets. One line each. No headings deeper than level 2.
- Keep only definitions, numbers, formulas and conclusions that appear in the text.
- Hard limit: under 400 words. Do not add commentary, do not repeat the input.` +
      `\n\nNote: This is part ${i + 1} of ${n}. Cover this part only.`
    const msgs = [
      { role: 'system' as const, content: sys },
      {
        role: 'user' as const,
        content: isDoc ? `Document: ${title} (part ${i + 1}/${n})\n\n${text}` : `Class title: ${title}\n\nTranscript (part ${i + 1}/${n}):\n\n${text}`
      }
    ]
    try {
      const r = await attempt(msgs, 2500, i, n, 'chunk', true, upstreamDown)
      if (!r.content.trim()) return false
      noteBuf.push(r.content)
      partResults.push({ i, n, ok: true })
      if (checkpoint) checkpoint.save(partHashOf(text), r.content, 'ok')
      continuations += r.continuations
      onProgress({ stage: 'chunk', part: i + 1, parts: n, detail: tm('org.compactOk', { i: i + 1, n }) })
      return true
    } catch {
      return false
    }
  }

  /** 整理一段文本；过大/被拒则递归二分（≤2 级），结果按顺序进 noteBuf */
  const organizePiece = async (
    text: string,
    slideText: string,
    i: number,
    n: number,
    depth: number
  ): Promise<void> => {
    const sys = makeSystem(slideText) + (n > 1 ? `\n\nNote: This is part ${i + 1} of ${n}. Produce notes for this part only; do not summarize the whole lecture.` : '')
    const msgs = [
      { role: 'system' as const, content: sys },
      {
        role: 'user' as const,
        content: isDoc
          ? `Document: ${title} (part ${i + 1}/${n})\n\n${text}`
          : `Class title: ${title}\n\nTranscript (part ${i + 1}/${n}):\n\n${text}`
      }
    ]
    // 额度保护：已经到本次任务上限 → 不再发请求，先保留原文（点「继续」时会只补这一段）
    if (budgetOut) {
      failedParts += 1
      partResults.push({ i, n, ok: false })
      const pos = noteBuf.push(`${tm('org.partFallbackHead', { i: i + 1 })}\n\n${text}`) - 1
      if (failedAt.length < 8) failedAt.push({ pos, text, i, n })
      onProgress({ stage: 'chunk', part: i + 1, parts: n, detail: tm('org.budgetOut', { n: MAX_JOB_REQUESTS }) })
      return
    }
    // 断点续做：这一段上次已经整理成功过 → 直接用，不再消耗额度
    const hash = checkpoint ? partHashOf(text) : ''
    let failedBefore = false
    if (checkpoint && hash) {
      const hit = checkpoint.load(hash)
      if (hit && hit.status === 'fail') {
        // 上次就是这段失败 → 换个策略：先试"精简兜底"（同样的打法只会同样的失败）
        failedBefore = true
      }
      if (hit && hit.status === 'ok' && hit.md.trim()) {
        reusedParts += 1
        noteBuf.push(hit.md)
        partResults.push({ i, n, ok: true })
        onProgress({ stage: 'chunk', part: i + 1, parts: n, detail: tm('org.partReused', { i: i + 1, n }) })
        return
      }
    }
    // 已知上限更小 → 不再撞墙，直接拆
    if (depth < 2 && text.length > sizeCeiling && text.length > 2000) {
      await splitPiece(text, slideText, i, n, depth)
      return
    }
    try {
      const r = await attempt(
        msgs,
        preferNoCap ? null : Math.min(outBudget, budgetCeiling),
        i,
        n,
        'chunk',
        depth > 0,
        upstreamDown
      )
      noteBuf.push(r.content)
      partResults.push({ i, n, ok: true })
      if (checkpoint && hash) checkpoint.save(hash, r.content, 'ok')
      continuations += r.continuations
      if (r.finishReason === 'length') {
        truncated = true
        onProgress({ stage: 'chunk', part: i + 1, parts: n, detail: tm('org.truncatedChunk', { i: i + 1, n }) })
      }
    } catch (e) {
      if (!retryable(e)) throw e
      const outage = isOutage(e)
      // 连备用通道都全军覆没 → 认定上游整体不可用：后续分块只试一次，不再反复退避
      if (outage && !pinnedTarget) {
        upstreamDown = true
        onProgress({ stage: 'chunk', part: i + 1, parts: n, detail: tm('org.upstreamDown') })
      }
      // ① 上游整片故障：拆输入毫无意义（拆了还是 502），先换"精简请求"试一次
      if (outage || failedBefore) {
        const done = await organizeCompact(text, i, n)
        if (done) return
      }
      // ② 输入侧自适应：这次请求本身太大/被内容过滤 → 二分后再来（故障时不做）
      if (!outage && depth < 2 && text.length > 2000) {
        sizeCeiling = Math.min(sizeCeiling, Math.max(2000, Math.floor(text.length * 0.6)))
        await splitPiece(text, slideText, i, n, depth)
        return
      }
      // ③ 还没有试过精简 → 再给它一次机会（真笔记 > 原文兜底）
      if (!outage && !failedBefore && depth === 0) {
        const done = await organizeCompact(text, i, n)
        if (done) return
      }
      // ④ 终极兜底：附上原文片段，至少不丢内容、整单不失败
      // 注意：这种情况**写一条 failed 缓存**，下次「继续」时这段会直接走精简策略
      if (checkpoint && hash) checkpoint.save(hash, '', 'fail')
      failedParts += 1
      partResults.push({ i, n, ok: false })
      onProgress({ stage: 'chunk', part: i + 1, parts: n, detail: tm('org.partFallback', { i: i + 1, n }) })
      const pos = noteBuf.push(`${tm('org.partFallbackHead', { i: i + 1 })}\n\n${text}`) - 1
      if (failedAt.length < 8) failedAt.push({ pos, text, i, n })
    }
  }

  const splitPiece = async (text: string, slideText: string, i: number, n: number, depth: number): Promise<void> => {
    const halves = splitParts(text, Math.max(1500, Math.ceil(text.length / 2)))
    openedParts += halves.length - 1
    onProgress({
      stage: 'chunk',
      part: i + 1,
      parts: n,
      detail: tm('org.splitPart', { i: i + 1, n, k: halves.length })
    })
    // 课件同步收敛（半量），避免课件本身就是拒绝原因
    const smallerSlides = slideText.length > 3000 ? slideText.slice(0, Math.floor(slideText.length / 2)) : slideText
    for (const h of halves) await organizePiece(h, smallerSlides, i, n, depth + 1)
  }

  for (let i = 0; i < parts.length; i++) {
    onProgress({
      stage: 'chunk',
      part: i + 1,
      parts: parts.length,
      chars: parts[i].length,
      detail: slides ? tm('org.partOfSlides', { i: i + 1, n: parts.length }) : tm('org.partOf', { i: i + 1, n: parts.length })
    })
    await organizePiece(parts[i], slides, i, parts.length, 0)
  }
  // ============ 收尾：只重做失败的段落（一次）============
  // 实测上游会出现成片的瞬时 400 / content_filter；等几秒重试同一段，成功率明显回升。
  // 这里只补失败段（不是整篇重来），且最多一轮，避免把额度耗在重试上。
  if (failedAt.length > 0 && !budgetOut && !upstreamDown) {
    onProgress({ stage: 'chunk', parts: parts.length, detail: tm('org.retryFailedParts', { n: failedAt.length }) })
    for (const f of failedAt) {
      if (signal?.aborted) break
      await new Promise((r) => setTimeout(r, 2500))
      const sys =
        makeSystem(slides) +
        (f.n > 1
          ? isDoc
            ? `\n\nNote: This is part ${f.i + 1} of ${f.n} of the document. Extract key points from this part only.`
            : `\n\nNote: This is part ${f.i + 1} of ${f.n}. Produce notes for this part only; do not summarize the whole lecture.`
          : '')
      const msgs = [
        { role: 'system' as const, content: sys },
        {
          role: 'user' as const,
          content: isDoc
            ? `Document: ${title} (part ${f.i + 1}/${f.n})\n\n${f.text}`
            : `Class title: ${title}\n\nTranscript (part ${f.i + 1}/${f.n}):\n\n${f.text}`
        }
      ]
      try {
        const r = await attempt(msgs, preferNoCap ? null : Math.min(outBudget, budgetCeiling), f.i, f.n, 'chunk', true, upstreamDown)
        if (r.content.trim()) {
          noteBuf[f.pos] = r.content
          failedParts = Math.max(0, failedParts - 1)
          continuations += r.continuations
          if (checkpoint) checkpoint.save(partHashOf(f.text), r.content, 'ok')
          onProgress({ stage: 'chunk', part: f.i + 1, parts: f.n, detail: tm('org.partRecovered', { i: f.i + 1, n: f.n }) })
        }
      } catch {
        /* 仍然失败 → 保留原文兜底 */
      }
    }
  }

  requests.push(...noteBuf)
  const totalParts = parts.length + openedParts
  if (openedParts > 0) onProgress({ stage: 'chunk', parts: totalParts, detail: tm('org.splitDone', { n: totalParts }) })
  if (reusedParts > 0) {
    onProgress({
      stage: 'chunk',
      parts: totalParts,
      detail: tm('org.reusedParts', { n: reusedParts, total: partResults.length || parts.length })
    })
  }

  const detailed = payload.length === 'detailed'

  // ============ 归并：先"零请求"拼成一篇完整文档，再用 1 次请求统一润色 ============
  // 为什么不再让模型直接合并所有分段：模型被要求把整篇笔记重新输出一遍，
  // 输入+输出越大越慢（实测 20k 字输入要 30s，50k 字就要好几分钟），
  // 一旦超时/被拒就整篇降级成"本地拼接"。现在改成：
  //   ① 本地结构化拼接（0 请求，一定能成功，内容一字不丢）
  //   ② 有把握时才用 1 次请求把它统一成连贯的一篇
  //   ③ 统一结果不满意的判据是"变短了"→直接回退到①的完整版
  const assembled = assembleNotes(requests)
  let finalMd = assembled
  let unifyTried = false
  let unifyFellBack = false
  if (requests.length > 1) {
    if (assembled.length > UNIFY_INPUT_MAX) {
      // 太长：统一请求本身会变成"几分钟的大请求"，风险不值得，直接给完整拼接版
      onProgress({ stage: 'merge', parts: totalParts, detail: tm('org.assembledBig', { n: requests.length }) })
      unifyFellBack = true
    } else {
      unifyTried = true
      onProgress({ stage: 'merge', parts: totalParts, detail: tm('org.unifying') })
      const keepAll =
        'IMPORTANT: preserve EVERY fact, definition, number, name, example and assignment detail from the partial notes. ' +
        'Merge headings and remove only literal duplicates. Do NOT shorten, summarise or drop content. ' +
        'Do NOT pad, repeat or invent content either: the result should be at most about 1.2x the length of the input notes.'
      const system =
        `${baseSystem}\n\n` +
        'You are given partial notes for ONE lecture, already concatenated in reading order. ' +
        'Produce the FINAL single coherent note: merge duplicated headings, keep one structure in the requested length mode, ' +
        'smooth transitions and keep the requested language.' +
        (detailed ? ` ${keepAll}` : ' Keep every fact; only remove literal duplication.') +
        ' Output the complete final Markdown notes only (no commentary).'
      const msgs = [
        { role: 'system' as const, content: system },
        { role: 'user' as const, content: `Class title: ${title}\n\nPartial notes:\n\n${assembled}` }
      ]
      // 统一请求的输出预算按输入规模给（输入字数的 1/2 约等于输出 token），并封顶
      const unifyBudget = Math.min(userBudget, Math.max(4096, Math.ceil(assembled.length / 2) + 2500))
      const budget = Math.min(unifyBudget, budgetCeiling)
      try {
        const r = await attempt(msgs, preferNoCap ? null : budget, 0, 1, 'merge', false, upstreamDown)
        continuations += r.continuations
        if (r.finishReason === 'length') truncated = true
        const polished = (r.content || '').trim()
        // 完整性地板：① 不能明显变短 ② 每个分块都还得留下痕迹（真正防"整段被吃掉"）
        const longEnough = polished.length >= Math.max(240, Math.floor(assembled.length * UNIFY_MIN_RATIO))
        const cov = coverageOk(requests, polished)
        if (longEnough && cov.ok && /[#\-*\d]/.test(polished)) {
          finalMd = polished
        } else {
          unifyFellBack = true
          onProgress({
            stage: 'merge',
            parts: totalParts,
            detail: cov.ok ? tm('org.unifyKeptFull') : tm('org.unifyLostParts', { parts: cov.missing.slice(0, 6).join(', ') })
          })
        }
      } catch (e) {
        if (!retryable(e)) throw e
        unifyFellBack = true
        onProgress({ stage: 'merge', parts: totalParts, detail: tm('org.unifyKeptFull') })
      }
    }
  }
  if (requests.length > 1 && !unifyTried) unifyFellBack = true

  if (!finalMd || !finalMd.trim()) {
    throw new Error(i18nCode('llm.emptyNote'))
  }

  if (failedParts > 0) {
    finalMd = `> ⚠️ ${tm('org.partFallbackBanner', { n: failedParts })}${truncated ? ' ' + tm('org.truncatedNote') : ''}\n\n${finalMd}`
  } else if (truncated) {
    finalMd = `> ⚠️ ${tm('org.truncatedNote')}\n\n${finalMd}`
    onProgress({ stage: 'done', parts: totalParts, detail: tm('org.doneTruncated') })
  } else {
    onProgress({
      stage: 'done',
      parts: totalParts,
      detail: unifyFellBack ? tm('org.doneCompleteAssembled') : tm('org.done')
    })
  }
  return {
    noteMd: finalMd.trim(),
    // 只有"有段落彻底整理不出来、只能附原文"才算未完成；
    // 本地结构化拼接是设计内的完整结果（不是降级），统一润色失败也不影响完整性
    degraded: failedParts > 0,
    failedParts,
    requests: requests.length + (unifyTried ? 1 : 0) + continuations,
    chunks: requests.length,
    truncated,
    continuations
  }
}

/** 按字符数分块，优先在换行/句号边界切 */
function splitParts(text: string, maxChars: number): string[] {
  const clean = text.replace(/\r/g, '').trim()
  if (clean.length <= maxChars) return [clean]
  const parts: string[] = []
  let rest = clean
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    const cutAt = lastBoundary(window, Math.floor(maxChars * 0.6))
    parts.push(rest.slice(0, cutAt).trim())
    rest = rest.slice(cutAt).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

function lastBoundary(s: string, from: number): number {
  for (let i = s.length - 1; i >= from; i--) {
    const ch = s[i]
    if (ch === '\n' || ch === '.' || ch === '?' || ch === '!') return i + 1
  }
  return s.length
}
