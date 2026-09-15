// 笔记整理：模板 + 长度档 + 课件参考 → 分块 map / 合并 reduce
import type { AppSettings, LlmProgress, NoteLength, OrganizeResult } from '@shared/types'
import { chatCompletionLong, LlmError } from './openrouter'
import { getEffectiveTemplate, lengthRule, slidesRule } from './templates'
import { i18nCode, tm } from '../i18n'

/** 单次整理的安全上限（超长讲座需分批，避免请求过大/空回复） */
export const MAX_ORGANIZE_CHARS = 300_000
export const MAX_ORGANIZE_PARTS = 12
/** 分块超过此数量时先分层合并，避免最终合并 prompt 过大 */
const HIERARCHICAL_THRESHOLD = 6
const MERGE_GROUP = 4

export interface OrganizePayload {
  title: string
  sourceText: string
  templateId?: string
  length?: NoteLength
  slidesText?: string
}

export async function organizeText(
  settings: AppSettings,
  payload: OrganizePayload,
  onProgress: (p: LlmProgress) => void,
  signal?: AbortSignal
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
  const baseSystem =
    tpl.systemPrompt.replaceAll('{title}', title) +
    lengthRule(payload.length) +
    slidesRule(slides || undefined)

  // 有课件时把单块收紧，给上下文留空间
  const baseChunk = slides ? Math.min(eff.llm.maxChunkChars || 24000, 15000) : eff.llm.maxChunkChars || 24000
  // 自适应放大分块，保证块数不超过上限
  const chunkChars = Math.max(baseChunk, Math.ceil(text.length / MAX_ORGANIZE_PARTS))
  const parts = splitParts(text, chunkChars)
  const requests: string[] = []
  // 输出预算与续写：越大/越多 = 笔记越长，代价是每次更慢、续写多花请求
  const outBudget = Math.max(2048, settings.llm.maxOutputTokens ?? 16384)
  const maxCont = 2
  let continuations = 0
  let truncated = false

  onProgress({ stage: 'chunk', part: 0, parts: parts.length, detail: tm('org.parts', { n: parts.length }) })

  for (let i = 0; i < parts.length; i++) {
    onProgress({
      stage: 'chunk',
      part: i + 1,
      parts: parts.length,
      chars: parts[i].length,
      detail: slides
        ? tm('org.partOfSlides', { i: i + 1, n: parts.length })
        : tm('org.partOf', { i: i + 1, n: parts.length })
    })
    const sys =
      parts.length > 1
        ? `${baseSystem}\n\nNote: This is part ${i + 1} of ${parts.length}. Produce notes for this part only; do not summarize the whole lecture.`
        : baseSystem
    const chunkMsgs = [
      { role: 'system' as const, content: sys },
      { role: 'user' as const, content: `Class title: ${title}\n\nTranscript (part ${i + 1}/${parts.length}):\n\n${parts[i]}` }
    ]
    const runChunk = (budget: number, cont: number): Promise<Awaited<ReturnType<typeof chatCompletionLong>>> =>
      chatCompletionLong(eff, chunkMsgs, {
        maxTokens: budget,
        signal,
        maxContinuations: cont,
        onNote: () =>
          onProgress({
            stage: 'chunk',
            part: i + 1,
            parts: parts.length,
            chars: parts[i].length,
            detail: tm('org.continuing', { i: i + 1, n: parts.length })
          })
      })
    let r: Awaited<ReturnType<typeof chatCompletionLong>>
    try {
      r = await runChunk(outBudget, maxCont)
    } catch (e) {
      // 上游拒绝（400/超限/服务端错误）时自动降级：减半预算 + 不续写，再试一次
      const code = (e as LlmError).code
      if ((code === 'CONTEXT' || code === 'PROVIDER' || code === 'HTTP') && outBudget > 4096) {
        const fallback = Math.max(4096, Math.floor(outBudget / 2))
        onProgress({
          stage: 'chunk',
          part: i + 1,
          parts: parts.length,
          detail: tm('org.retrySmaller', { i: i + 1, n: parts.length, t: fallback })
        })
        r = await runChunk(fallback, 0)
      } else {
        throw e
      }
    }
    requests.push(r.content)
    continuations += r.continuations
    if (r.finishReason === 'length') {
      truncated = true
      onProgress({
        stage: 'chunk',
        part: i + 1,
        parts: parts.length,
        detail: tm('org.truncatedChunk', { i: i + 1, n: parts.length })
      })
    }
  }

  const detailed = payload.length === 'detailed'
  const mergeNotes = async (items: string[], final: boolean): Promise<string> => {
    const joined = items.map((m, i) => `=== Part ${i + 1} notes ===\n${m}`).join('\n\n')
    // 详细档：只做结构衔接，明确禁止删减/压缩（避免“合并”把内容吃掉）
    const keepAll =
      'IMPORTANT: preserve EVERY fact, definition, number, name, example and assignment detail from the partial notes. ' +
      'Merge headings and remove only literal duplicates. Do NOT shorten, summarise or drop content. ' +
      'Do NOT pad, repeat or invent content either: the result should be at most about 1.5x the length of the partial notes.'
    const system =
      `${baseSystem}\n\n` +
      (final
        ? 'You are now merging partial notes from the same lecture into the FINAL note. Keep a single cohesive structure and the requested length mode.' +
          (detailed ? ` ${keepAll}` : ' Remove overlap and duplication and smooth transitions. Output the final complete Markdown notes only.')
        : 'Merge these partial notes into one intermediate note. Remove duplication, keep all facts, output Markdown notes only.' +
          (detailed ? ` ${keepAll}` : ''))
    const r = await chatCompletionLong(
      eff,
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Class title: ${title}\n\nMerge these notes from consecutive transcript chunks:\n\n${joined}`
        }
      ],
      { maxTokens: outBudget, signal, maxContinuations: maxCont }
    )
    continuations += r.continuations
    if (r.finishReason === 'length') truncated = true
    return r.content
  }
  const mergeAll = async (items: string[], label: string): Promise<string> => {
    if (items.length === 1) return items[0]
    if (items.length <= HIERARCHICAL_THRESHOLD) {
      onProgress({ stage: 'merge', detail: label })
      return mergeNotes(items, true)
    }
    // 分层：先小组合并，再合并小组结果
    const groups: string[] = []
    for (let i = 0; i < items.length; i += MERGE_GROUP) {
      const slice = items.slice(i, i + MERGE_GROUP)
      onProgress({
        stage: 'merge',
        detail: tm('org.mergeGroups', { i: Math.floor(i / MERGE_GROUP) + 1, n: Math.ceil(items.length / MERGE_GROUP) })
      })
      groups.push(slice.length === 1 ? slice[0] : await mergeNotes(slice, false))
    }
    onProgress({ stage: 'merge', detail: label })
    return groups.length === 1 ? groups[0] : mergeNotes(groups, true)
  }

  let finalMd = ''
  if (parts.length === 1) {
    finalMd = requests[0]
  } else {
    finalMd = await mergeAll(requests, tm('org.merging'))
  }
  if (!finalMd || !finalMd.trim()) {
    throw new Error(i18nCode('llm.emptyNote'))
  }

  if (truncated) {
    finalMd = `> ⚠️ ${tm('org.truncatedNote')}\n\n${finalMd}`
    onProgress({ stage: 'done', parts: parts.length, detail: tm('org.doneTruncated') })
  } else {
    onProgress({ stage: 'done', parts: parts.length, detail: tm('org.done') })
  }
  return {
    noteMd: finalMd.trim(),
    requests: parts.length + (parts.length > 1 ? 1 : 0) + continuations,
    chunks: parts.length,
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
