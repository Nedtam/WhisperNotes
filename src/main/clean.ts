// 本地轻量清洗规则 —— 只作用于引擎吐出的新文字，绝不改写用户已编辑内容
import type { CleanRules } from '@shared/types'

const FILLERS = /\b(?:uh|um|er|erm|hmm|mm|uh-huh|mm-hmm|eh|ah)\b/gi

export interface CleanOutcome {
  text: string
  changed: boolean
}

export function cleanSegment(raw: string, rules: CleanRules): CleanOutcome {
  let t = raw.replace(/\s+/g, ' ').trim()
  if (!t) return { text: '', changed: raw !== '' }

  let changed = t !== raw

  if (rules.repeats) {
    // "the the the" → "the"，"yes yes" → "yes"
    const before = t
    t = t.replace(/(\b\w+\b)(\s+\1\b)+/gi, '$1')
    if (t !== before) changed = true
  }

  if (rules.fillers) {
    const before = t
    t = t.replace(FILLERS, ' ').replace(/\s{2,}/g, ' ').trim()
    if (t !== before) changed = true
  }

  if (rules.punctuation) {
    const before = t
    t = t
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/([?!]){2,}/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim()
    if (t !== before) changed = true
  }

  // 去掉常见的空转写占位
  if (/^\[(?:BLANK_AUDIO|inaudible|silence|.*?no.?speech.*?)\]$/i.test(t)) {
    return { text: '', changed: true }
  }

  return { text: t, changed }
}
