// 闪卡生成：把"已经整理好的笔记"交给 AI，产出结构化卡片
//
// 设计取舍：
//  · 只吃整理后的 notes（结构清晰、去掉了口语），不碰原始转写 —— 卡片质量差一个量级
//  · 强制 JSON 输出 + 宽松解析（模型常加 ```json 围栏、尾逗号、中文标点）+ 兜底文本行解析
//  · 复用 adaptive.ts 的降级引擎：限流/拒绝自动降预算、自动换备用模型与渠道
//  · 逐篇生成（一篇一个请求），失败只影响那一篇；进度按篇回报
import type { AppSettings, Card, CardGenProgress, CardGenRequest } from '@shared/types'
import { chatWithLadder, buildFallbackTargets } from './adaptive'
import { tm } from '../i18n'
import { languageDirective } from '../../shared/notation'

export interface CardDraft {
  front: string
  back: string
  hint?: string
  tags?: string[]
  /** 1-5 重要度（缺省按 3 处理） */
  importance?: number
  kind?: string
  quote?: string
}

export interface NoteForCards {
  id: string
  title: string
  noteMd: string
  notebookId: string | null
  tags?: string[]
}

const MAX_NOTE_CHARS = 60_000

/** 预设：考试冲刺（最严）· 日常理解（默认）· 全面覆盖 */
export const CARD_PRESETS = {
  exam: { per1000: 3, maxPerNote: 12, minImportance: 4, style: 'balanced' as const, blockAdmin: true },
  study: { per1000: 5, maxPerNote: 20, minImportance: 3, style: 'balanced' as const, blockAdmin: true },
  broad: { per1000: 8, maxPerNote: 30, minImportance: 2, style: 'balanced' as const, blockAdmin: true }
}

/** 默认尺度：每 1000 字约 5 张，单篇最多 20 张，重要度 ≥3 */
export const CARD_DEFAULTS = { per1000: 5, maxPerNote: 20, minPerNote: 3, minImportance: 3 }

/** 行政/无关内容的特征词（模型偶尔仍会出这类卡，这里做确定性兜底过滤） */
const ADMIN_PATTERNS = [
  /作业|功课|截止|提交|上交|deadline|due\s*date|submit/i,
  /考试时间|考试安排|考试地点|quiz\s*date|midterm\s*date|final\s*date|签到|attendance/i,
  /分数占比|占总分|评核|评分标准|grading|weighting|百分比.*成绩/i,
  /office\s*hour|答疑时间|助教|tutor|instructor\s*email|联系方式/i,
  /放假|假期|holiday|no\s*class|取消课堂|cancell?ed/i,
  /下周|下星期|next\s*week.*(安排|announce)|本周安排/i,
  /课程简介|课程目标|learning\s*outcome|assessment\s*weight/i,
  // 地点/联系方式这类后勤信息
  /办公室|上课地点|教室|课室|lecture\s*(room|hall)|venue|room\s*[A-Z]?\d/i,
  // 工具安装/界面操作（不可考）
  /安装|下载安装|install|setup\s*step|快捷键|shortcut|点击.*按钮|click\s+the/i,
  // 讲师个人信息
  /讲师|教授叫什么|老师叫什么|instructor\s*name|教授简介|自我介绍/i
]

export function looksAdministrative(text: string): boolean {
  return ADMIN_PATTERNS.some((re) => re.test(text))
}

export function planCardCount(md: string, req?: CardGenRequest): number {
  const per1000 = Math.max(1, Math.min(30, req?.per1000 ?? CARD_DEFAULTS.per1000))
  const maxPerNote = Math.max(1, Math.min(100, req?.maxPerNote ?? CARD_DEFAULTS.maxPerNote))
  const chars = md.replace(/\s+/g, '').length
  const want = Math.round((chars / 1000) * per1000)
  return Math.max(CARD_DEFAULTS.minPerNote, Math.min(maxPerNote, want))
}

function styleRule(style: CardGenRequest['style']): string {
  switch (style) {
    case 'definition':
      return 'Focus on definitions and terminology: term on the front, precise definition on the back.'
    case 'application':
      return 'Focus on application and problem solving: a scenario/question on the front, the reasoning and answer on the back.'
    case 'formula':
      return 'Focus on formulas and rules: the formula or concept name on the front, the exact formula plus when to use it on the back.'
    default:
      return 'Mix card types: definitions, concrete examples, formulas/rules, and application questions.'
  }
}

function langRule(lang: CardGenRequest['language'], md: string): string {
  if (lang === 'zh') return 'Write every card in Simplified Chinese.'
  if (lang === 'en') return 'Write every card in English.'
  return languageDirective(md)
}

export function buildCardPrompt(
  note: NoteForCards,
  count: number,
  req: CardGenRequest | undefined,
  existingFronts: string[]
): Array<{ role: 'system' | 'user'; content: string }> {
  const minImp = req?.minImportance ?? CARD_DEFAULTS.minImportance
  const kinds = req?.includeKinds?.length
    ? req.includeKinds
    : ['definition', 'formula', 'example', 'application', 'comparison', 'procedure', 'fact']
  const system = [
    'You are a ruthless exam-focused tutor building high-yield spaced-repetition flashcards from lecture notes.',
    'Your job is NOT to summarise the notes. Your job is to predict what will actually be tested or must be mastered, and turn only that into cards.',
    '',
    'CARD-WORTHY (include):',
    '- Definitions and terminology a student must be able to state precisely.',
    '- Formulas, rules, conditions and when each applies; units and sign conventions.',
    '- Distinctions and frequently confused pairs (A vs B), common mistakes and why they are wrong.',
    '- Step-by-step procedures / worked methods (one step or one decision per card).',
    '- Applied exam-style questions (given X, decide/derive Y) and the reasoning that gets the mark.',
    '- Key numbers, thresholds, constants, classifications that are likely to be asked.',
    '',
    'DO NOT CREATE CARDS FOR (exclude, even if present in the notes):',
    '- Course logistics: announcements, deadlines, submission rules, attendance, grading weights, instructor/TA contact, holidays, room changes.',
    '- Meta talk: "today we will talk about…", "in this lecture…", course outlines, learning outcomes.',
    '- Tool/software setup steps, installation, keyboard shortcuts, UI clicks that are not examinable.',
    '- Trivia, off-topic asides, filler examples with no transferable concept, repeated content.',
    '- Anything you cannot ground in the notes below. Never invent numbers, names or examples.',
    '',
    `Rules for every card you do produce:`,
    `1. Produce at most ${count} cards. Quality over quantity — if only a few concepts deserve cards, return fewer.`,
    '2. One fact per card. The front must be a self-contained question or prompt (never "what does this section say?").',
    '3. The back must be short and precise: 1–3 sentences, or a formula/list when that is the natural answer.',
    `4. Rate each card "importance" 1-5 for exam/mastery value. Only cards with importance ≥ ${minImp} are worth keeping; do not pad with weak cards.`,
    `5. Set "kind" to exactly one of: ${kinds.join(' | ')}.`,
    '6. Add "quote": the exact short phrase (≤ 80 characters) from the notes this card is based on.',
    '7. No duplicate or near-duplicate cards. Skip anything overlapping the "already-existing cards" list.',
    '8. Put math in plain Unicode (→, ≤, ×, √) or inline code, never LaTeX commands like \\frac.',
    '',
    styleRule(req?.style),
    langRule(req?.language, note.noteMd),
    '',
    'Output format: a single JSON array, nothing else — no prose, no markdown fence.',
    '[{"front":"…","back":"…","importance":4,"kind":"definition","quote":"…","hint":"…","tags":["topic"]}]',
    'hint is optional (omit when not useful). tags: 1–3 short topic tags.',
    'Escape newlines inside strings as \\n. Do not add commentary before or after the JSON.'
  ].join('\n')

  const trimmed = note.noteMd.length > MAX_NOTE_CHARS ? `${note.noteMd.slice(0, MAX_NOTE_CHARS)}\n\n[...notes truncated...]` : note.noteMd
  const user = [
    `Note title: ${note.title}`,
    existingFronts.length
      ? `Already-existing cards for this note (do NOT repeat these):\n${existingFronts.slice(0, 60).map((f, i) => `${i + 1}. ${f}`).join('\n')}`
      : 'No existing cards for this note.',
    '',
    '--- NOTES START ---',
    trimmed,
    '--- NOTES END ---',
    '',
    `Now output the JSON array with ${count} cards.`
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

/** 从模型回复里抽出 JSON 数组（容忍围栏、前后废话、尾逗号） */
export function parseCards(raw: string): CardDraft[] {
  if (!raw) return []
  let text = raw.trim()
  // 去掉 ```json … ``` 围栏
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  const candidates: string[] = []
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1)
    candidates.push(slice)
    // 中文标点/引号先归一，再处理尾逗号（否则 `，}` 这种全角逗号漏网）
    candidates.push(
      slice
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/：/g, ':')
        .replace(/，/g, ',')
        .replace(/,\s*([\]}])/g, '$1')
    )
  }
  for (const c of candidates) {
    try {
      const arr = JSON.parse(c) as unknown
      if (Array.isArray(arr)) return normalizeDrafts(arr)
    } catch {
      /* 试下一个 */
    }
  }
  // 兜底：一行一卡的纯文本格式 "Q: … / A: …"
  const out: CardDraft[] = []
  let front = ''
  for (const line of text.split('\n')) {
    const q = /^\s*(?:Q|问|front)\s*[:：]\s*(.+)$/i.exec(line)
    const a = /^\s*(?:A|答|back)\s*[:：]\s*(.+)$/i.exec(line)
    if (q) front = q[1].trim()
    else if (a && front) {
      out.push({ front, back: a[1].trim() })
      front = ''
    }
  }
  return out
}

function normalizeDrafts(arr: unknown[]): CardDraft[] {
  const out: CardDraft[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const front = String(o.front ?? o.question ?? o.q ?? '').trim()
    const back = String(o.back ?? o.answer ?? o.a ?? '').trim()
    if (!front || !back) continue
    if (front.length > 400 || back.length > 1200) continue
    const hintRaw = o.hint ?? o.tip
    const hint = typeof hintRaw === 'string' && hintRaw.trim() ? hintRaw.trim().slice(0, 300) : undefined
    const impRaw = Number(o.importance ?? o.priority ?? o.score ?? 3)
    const importance = Number.isFinite(impRaw) ? Math.max(1, Math.min(5, Math.round(impRaw))) : 3
    const kindRaw = String(o.kind ?? o.type ?? '').trim().toLowerCase()
    const kind = /^(definition|formula|example|application|comparison|procedure|fact)$/.test(kindRaw) ? kindRaw : undefined
    const quoteRaw = o.quote ?? o.source ?? o.evidence
    const quote = typeof quoteRaw === 'string' && quoteRaw.trim() ? quoteRaw.trim().slice(0, 160) : undefined
    const tagsRaw = o.tags ?? o.tag ?? o.topic
    const tags = Array.isArray(tagsRaw)
      ? tagsRaw.map((t) => String(t).trim()).filter(Boolean).slice(0, 4)
      : typeof tagsRaw === 'string' && tagsRaw.trim()
        ? tagsRaw.split(/[,，;；]/).map((t) => t.trim()).filter(Boolean).slice(0, 4)
        : undefined
    out.push({ front, back, hint, tags, importance, kind, quote })
  }
  // 去重（按 front 归一化）
  const seen = new Set<string>()
  return out.filter((c) => {
    const k = c.front.toLowerCase().replace(/\s+/g, ' ').replace(/[?？。.]+$/, '')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export interface GenerateForNoteResult {
  cards: CardDraft[]
  requests: number
  skipped: boolean
}

/** 为单篇笔记生成卡片（不落库，由调用方决定是否保存） */
export async function generateCardsForNote(
  settings: AppSettings,
  note: NoteForCards,
  req: CardGenRequest | undefined,
  existingFronts: string[],
  signal?: AbortSignal,
  onActivity?: (phase: 'start' | 'end' | 'tick') => void,
  onRetry?: (detail: string) => void
): Promise<GenerateForNoteResult> {
  if (!note.noteMd.trim()) return { cards: [], requests: 0, skipped: true }
  const preset = req?.preset ? CARD_PRESETS[req.preset] : undefined
  const effReq: CardGenRequest = {
    ...req,
    per1000: req?.per1000 ?? preset?.per1000,
    maxPerNote: req?.maxPerNote ?? preset?.maxPerNote,
    minImportance: req?.minImportance ?? preset?.minImportance ?? CARD_DEFAULTS.minImportance,
    blockAdmin: req?.blockAdmin ?? preset?.blockAdmin ?? true
  }
  const count = planCardCount(note.noteMd, effReq)
  const msgs = buildCardPrompt(note, count, effReq, existingFronts)
  const budget = Math.max(2048, Math.min(16384, settings.llm.maxOutputTokens ?? 16384))
  const r = await chatWithLadder(settings, msgs, {
    firstBudget: budget,
    maxContinuations: 1,
    signal,
    onActivity,
    targets: buildFallbackTargets(settings),
    onRetry: onRetry ?? (() => {}),
    labels: {
      same: () => tm('cards.retrySame'),
      smaller: (t) => tm('cards.retrySmaller', { t }),
      noLimit: () => tm('cards.retryNoLimit'),
      model: (m) => tm('cards.retryModel', { m })
    }
  })
  const minImp = effReq.minImportance ?? CARD_DEFAULTS.minImportance
  const allowed = effReq.includeKinds?.length ? new Set(effReq.includeKinds) : null
  const drafts = parseCards(r.content)
    .filter((d) => (d.importance ?? 3) >= minImp) // 重要度不到门槛的直接不要
    .filter((d) => (allowed ? !!d.kind && allowed.has(d.kind) : true))
    .filter((d) => (effReq.blockAdmin === false ? true : !looksAdministrative(`${d.front} ${d.back}`))) // 行政内容兜底
    .slice(0, count)
  // 过滤后可能不足 count，属于正常（模型偏保守）
  return { cards: drafts, requests: 1 + r.continuations, skipped: false }
}

export function draftToCard(draft: CardDraft, note: NoteForCards, source = 'ai'): Partial<Card> & { front: string; back: string } {
  return {
    noteId: note.id,
    notebookId: note.notebookId,
    front: draft.front,
    back: draft.back,
    hint: draft.hint,
    tags: draft.tags ?? note.tags ?? [],
    importance: draft.importance,
    kind: draft.kind,
    quote: draft.quote,
    source,
    dueAt: Date.now()
  }
}
