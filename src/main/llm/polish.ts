// 转写精修：用课件校准听写（dots LLM），输出更准的转写文本
//
// 注意：精修以前是"一次 chatCompletionLong 直发"，上游一抖（400/502 成片）整篇就废，
// 长转写（9 个分块）几乎必然失败 —— 这就是"生成增强版失效"的原因。
// 现在走和整理同一套健壮性栈：分块 + 阶梯（退避重发 / 放大预算 / 备用渠道）+ 续写。
import type { AppSettings, LlmProgress } from '@shared/types'
import { buildFallbackTargets, buildOutageTargets, chatWithLadder } from './adaptive'
import { shortError } from './openrouter'
import { i18nCode, tm } from '../i18n'

const POLISH_SYSTEM = `You are a transcription proofreader. Fix ASR errors in the lecture transcript below using the lecturer's slide deck as the authority for spelling of names, course terms, acronyms and hyphenated terms.
Rules:
- Fix misheard names/terms to match the slide wording; normalize punctuation, spacing and obvious ASR artifacts (repeated loops, "thank you" fillers, broken words).
- Remove repeated hallucination loops and non-speech noise lines.
- Keep the lecturer's content, order, numbers and meaning intact. Never add new factual content that is not in the transcript; slide-only facts should not be inserted as spoken words.
- Keep the same language as the transcript.
Output ONLY the corrected transcript text, no headings, no commentary.`

function splitParts(text: string, maxChars: number): string[] {
  const clean = text.replace(/\r/g, '').trim()
  if (clean.length <= maxChars) return [clean]
  const parts: string[] = []
  let rest = clean
  while (rest.length > maxChars) {
    let at = maxChars
    for (let i = maxChars; i >= maxChars * 0.6; i--) {
      if (rest[i] === '\n' || rest[i] === '.' || rest[i] === '?' || rest[i] === '!') {
        at = i + 1
        break
      }
    }
    parts.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

export async function polishText(
  settings: AppSettings,
  payload: { sourceText: string; slidesContext?: string },
  onProgress: (p: LlmProgress) => void,
  signal?: AbortSignal
): Promise<{ text: string; requests: number; chunks: number }> {
  const text = payload.sourceText.trim()
  if (!text) throw new Error(i18nCode('pol.noText'))
  const slides = (payload.slidesContext ?? '').trim()
  const slidesBlock = slides
    ? `\n\n=== Lecturer slide deck (reference for spellings) ===\n${slides}`
    : ''
  const system = POLISH_SYSTEM + slidesBlock

  // 分块比整理更小一点：精修要"逐字返回原文"，分块越小越不容易中断/超时
  const parts = splitParts(text, Math.min(Math.max(4000, settings.llm.maxChunkChars || 14000), 12000))
  onProgress({ stage: 'polish', part: 0, parts: parts.length, detail: tm('pol.parts', { n: parts.length }) })
  const outs: string[] = new Array(parts.length).fill('')
  let doneCount = 0
  // 并发数：精修每块都要"把原文再吐一遍"，纯串行 10 块要 20~30 分钟（用户会以为坏了）。
  // 3 路并发在免费档的限速范围内，墙钟时间直接降到 1/3；每块仍各自带退避/备用通道。
  const CONCURRENCY = Math.min(3, Math.max(1, parts.length))
  let nextIdx = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) throw new Error(i18nCode('org.jobCanceled'))
      const i = nextIdx++
      if (i >= parts.length) return
    onProgress({
      stage: 'polish',
      part: i + 1,
      parts: parts.length,
      chars: parts[i].length,
      detail: tm('pol.partOf', { i: i + 1, n: parts.length })
    })
    // 和整理共用同一套降级：上游不稳就退避重发、必要时换内置免费备用通道
    const msgs = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: `Transcript part ${i + 1}/${parts.length}:\n\n${parts[i]}` }
    ]
    let res: { content: string }
    try {
      res = await chatWithLadder(settings, msgs, {
        firstBudget: Math.min(Math.max(2048, settings.llm.maxOutputTokens ?? 8192), 12_000),
        maxContinuations: 2,
        signal,
        targets: buildFallbackTargets(settings),
        outageTargets: buildOutageTargets(settings),
        labels: {
          same: () => tm('org.retrySame', { i: i + 1, n: parts.length }),
          smaller: (t) => tm('org.retrySmaller', { i: i + 1, n: parts.length, t }),
          bigger: (t) => tm('org.retryBigger', { i: i + 1, n: parts.length, t }),
          noLimit: () => tm('org.retryNoLimit', { i: i + 1, n: parts.length }),
          model: (m) => tm('org.retryModel', { i: i + 1, n: parts.length, m }),
          outage: (k, sec) => tm('org.outageWait', { i: i + 1, n: parts.length, k, sec })
        },
        onRetry: (detail) => onProgress({ stage: 'polish', part: i + 1, parts: parts.length, detail }),
        onAttemptError: (e) =>
          onProgress({
            stage: 'polish',
            part: i + 1,
            parts: parts.length,
            detail: tm('org.attemptFailed', { why: shortError(e) })
          })
      })
    } catch (e) {
      // 精修失败不该让用户看到"什么都没发生"：把原因写清楚（第几块、为什么）
      throw new Error(`${tm('pol.partFailed', { i: i + 1, n: parts.length })} ${shortError(e)}`)
    }
      outs[i] = res.content.trim()
      doneCount += 1
      onProgress({ stage: 'polish', part: doneCount, parts: parts.length, detail: tm('pol.progress', { done: doneCount, n: parts.length }) })
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  onProgress({ stage: 'done', parts: parts.length, detail: tm('pol.done') })
  return { text: outs.join('\n\n'), requests: outs.length, chunks: outs.length }
}
