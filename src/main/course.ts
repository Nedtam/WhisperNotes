// 课程档案（会话级）→ 转写提示词与术语词典
import { parseDeckCached } from './slides'

export interface SessionDeck {
  path: string
  name?: string
  kind?: 'pdf' | 'pptx'
  password?: string
}

const STOP = new Set(
  'a an and are as at be by for from has have in is it of on or that the this to was were with you your our their its not so but can will do does did what when how why which'.split(' ')
)

async function deckPages(decks: SessionDeck[]): Promise<Array<{ text: string }>> {
  const out: Array<{ text: string }> = []
  for (const d of decks) {
    try {
      const deck = await parseDeckCached(d.path, d.password)
      for (const p of deck.pages) out.push({ text: p.text })
    } catch {
      /* 单个课件失败不阻塞整体 */
    }
  }
  return out
}

/** 组装 whisper 初始提示词（档案术语 + 手动补充），≤800 字符 */
export async function buildAsrPrompt(decks: SessionDeck[], manual: string): Promise<string> {
  const auto: string[] = []
  try {
    const pages = await deckPages(decks)
    auto.push(...collectPromptTerms(pages))
  } catch {
    /* ignore */
  }
  const seen = new Set<string>()
  const merged: string[] = []
  for (const src of [manual, auto.join(', ')]) {
    for (const raw of src.split(/[,，;\n]+/)) {
      const t = raw.trim()
      if (!t || t.length < 2) continue
      const key = t.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(t)
    }
  }
  let out = merged.join(', ')
  if (out.length > 800) out = out.slice(0, 800).replace(/,\s*[^,]*$/, '')
  return out
}

function collectPromptTerms(pages: Array<{ text: string }>): string[] {
  const freq = new Map<string, number>()
  const phrases = new Map<string, number>()
  const count = (w: string, n = 1): void => {
    if (w.length < 3 || w.length > 30 || /^\d+$/.test(w)) return
    if (STOP.has(w.toLowerCase())) return
    freq.set(w, (freq.get(w) ?? 0) + n)
  }
  for (const { text } of pages) {
    const words = text.split(/[^A-Za-z0-9'’&-]+/).filter(Boolean)
    // 连字符复合词整体（procure-to-pay）
    const hyphens = text.match(/[A-Za-z]+(?:-[A-Za-z]+)+/g) ?? []
    for (const h of hyphens) if (h.length >= 6) count(h, 2)
    // 大写短语（Sherman Ngan / Lewis Liu / YEUNG Y-6616 相关）
    const ph = text.match(/(?:[A-Z][a-z]{1,20}[ &'-]){1,3}[A-Z][a-z]{1,20}/g) ?? []
    for (const p of ph) {
      if (p.length >= 6 && p.split(' ').length <= 4) {
        phrases.set(p, (phrases.get(p) ?? 0) + 1)
      }
    }
    const acronyms = text.match(/\b(?:[A-Z]{2,}|[A-Za-z]{2,}\d{2,})\b/g) ?? []
    for (const a of acronyms) if (a.length <= 12) count(a, 1)
    for (const w of words) count(w, 1)
  }
  const terms = new Set<string>()
  for (const [p] of [...phrases.entries()].sort((a, b) => b[1] - a[1])) {
    if (terms.size >= 120) break
    terms.add(p)
  }
  for (const [w, c] of [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)) {
    if (terms.size >= 160) break
    if (/^[A-Z]/.test(w) || w.length >= 6 || c >= 3) terms.add(w)
  }
  return [...terms]
}

/** 保守校正词典：短语/专名/连字符复合（≥6 字符），用于句子定稿时纠正大小写与连字符拼写 */
export async function buildDictTerms(decks: SessionDeck[]): Promise<string[]> {
  const set = new Set<string>()
  const pages = await deckPages(decks)
  for (const { text } of pages) {
    const ph = text.match(/(?:[A-Z][a-z]{1,20}[ &'-]){1,3}[A-Z][a-z]{1,20}/g) ?? []
    for (const p of ph) if (p.length >= 6 && p.split(' ').length <= 4) set.add(p)
    const hyphens = text.match(/[A-Za-z]+(?:-[A-Za-z]+)+/g) ?? []
    for (const h of hyphens) if (h.length >= 6 && h.length <= 40) set.add(h)
  }
  return [...set]
}

/** 只做高置信替换：连续 token 忽略大小写/空格/连字符完全一致才改写成档案拼写 */
export function applyTermCorrection(text: string, phrases: string[]): { text: string; changed: boolean } {
  if (!phrases.length) return { text, changed: false }
  let out = text
  let changed = false
  const sorted = [...phrases].sort((a, b) => b.length - a.length)
  for (const phrase of sorted) {
    const tokens = phrase.split(/[\s&-]+/).filter(Boolean)
    if (tokens.length < 2 && phrase.length < 8) continue
    const esc = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s&-]+')
    const re = new RegExp(`(^|[^A-Za-z])(${esc})(?=$|[^A-Za-z])`, 'gi')
    out = out.replace(re, (m, pre: string, _inner: string) => {
      changed = true
      return `${pre}${phrase}`
    })
  }
  return { text: out, changed }
}
