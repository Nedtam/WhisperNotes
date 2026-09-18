// 转写精修：用课件校准听写（dots LLM 单遍），输出更准的转写文本
import type { AppSettings, LlmProgress } from '@shared/types'
import { chatCompletionLong } from './openrouter'
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
  onProgress: (p: LlmProgress) => void
): Promise<{ text: string; requests: number; chunks: number }> {
  const text = payload.sourceText.trim()
  if (!text) throw new Error(i18nCode('pol.noText'))
  const slides = (payload.slidesContext ?? '').trim()
  const slidesBlock = slides
    ? `\n\n=== Lecturer slide deck (reference for spellings) ===\n${slides}`
    : ''
  const system = POLISH_SYSTEM + slidesBlock

  const parts = splitParts(text, settings.llm.maxChunkChars || 24000)
  onProgress({ stage: 'polish', part: 0, parts: parts.length, detail: tm('pol.parts', { n: parts.length }) })
  const outs: string[] = []
  for (let i = 0; i < parts.length; i++) {
    onProgress({
      stage: 'polish',
      part: i + 1,
      parts: parts.length,
      chars: parts[i].length,
      detail: tm('pol.partOf', { i: i + 1, n: parts.length })
    })
    // 精修同样按预算放开上限，触顶自动续写（避免长转写被砍半截）
    const r = await chatCompletionLong(
      settings,
      [
        { role: 'system', content: system },
        { role: 'user', content: `Transcript part ${i + 1}/${parts.length}:\n\n${parts[i]}` }
      ],
      {
        maxTokens: Math.max(2048, settings.llm.maxOutputTokens ?? 16384),
        temperature: 0.1,
        maxContinuations: 2
      }
    )
    outs.push(r.content.trim())
  }
  onProgress({ stage: 'done', parts: parts.length, detail: tm('pol.done') })
  return { text: outs.join('\n\n'), requests: outs.length, chunks: outs.length }
}
