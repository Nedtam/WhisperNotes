// 数学/符号写法还原：把 AI（和粘贴内容）里常见的 LaTeX 源码、HTML 实体、转义写法
// 还原成真正的 Unicode 符号，让笔记里出现 \rightarrow 时显示为 →、\neq 显示为 ≠。
//
// 设计要点：
//  · 只处理「数学跨度」内的上下标（$s_i$ → sᵢ），避免误伤普通文本/代码里的 snake_case；
//  · 命令表在跨度内外都生效（$\rightarrow$ 和裸写的 \rightarrow 都能还原）；
//  · 先保护代码块与行内代码，避免把 `$HOME` 这类 shell 变量当成数学；
//  · 未知命令原样保留（宁可不动，也不要破坏作者意图）。
import { LATEX_COMMANDS, SUPERSCRIPTS, SUBSCRIPTS } from './latexTables'

const INVISIBLE: Array<[RegExp, string]> = [
  [/\u00a0/g, ' '], // 不换行空格 → 普通空格
  [/[\u200b\u200c\u200d\ufeff]/g, ''], // 零宽字符 → 删除
  [/\u00ad/g, ''], // 软连字符 → 删除
  [/[\u2028\u2029]/g, '\n'] // 行分隔符 → 换行
]

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  divide: '÷',
  deg: '°',
  plusmn: '±',
  ne: '≠',
  le: '≤',
  ge: '≥',
  rarr: '→',
  larr: '←',
  harr: '↔',
  rArr: '⇒',
  lArr: '⇐',
  hArr: '⇔',
  infin: '∞',
  sum: '∑',
  prod: '∏',
  radic: '√',
  part: '∂',
  nabla: '∇',
  isin: '∈',
  notin: '∉',
  sub: '⊂',
  sup: '⊃',
  cup: '∪',
  cap: '∩',
  empty: '∅',
  forall: '∀',
  exist: '∃',
  micro: 'µ',
  copy: '©',
  reg: '®',
  trade: '™',
  trade2: '™',
  bull: '•',
  middot: '·',
  check: '✓',
  cross: '✗',
  star: '★',
  heart: '♥'
}

/** 结构类命令：{参数} 里的内容要保留（文本风格命令） */
const UNWRAP_KEEP = new Set([
  'text',
  'textrm',
  'textnormal',
  'textup',
  'textmd',
  'textsf',
  'texttt',
  'mathrm',
  'mathbf',
  'mathit',
  'mathsf',
  'mathtt',
  'mathcal',
  'mathbb',
  'mathfrak',
  'boldsymbol',
  'pmb',
  'operatorname',
  'mbox',
  'hbox',
  'textsuperscript',
  'textsubscript',
  'ensuremath',
  'emph',
  'underline',
  'sout',
  'hl',
  'colorbox',
  'fbox',
  'framebox',
  'overline',
  'bar',
  'hat',
  'tilde',
  'vec',
  'dot',
  'ddot',
  'mathring',
  'check',
  'breve',
  'acute',
  'grave',
  'phantom',
  'hphantom'
])

/** 纯装饰/排版命令：直接删掉 */
const DROP = new Set([
  'left',
  'right',
  'displaystyle',
  'textstyle',
  'scriptstyle',
  'scriptscriptstyle',
  'limits',
  'nolimits',
  '!',
  ',',
  ';',
  ':',
  ' ',
  'quad',
  'qquad',
  'thinspace',
  'negthinspace',
  'enspace',
  'hfill',
  'hspace',
  'vspace',
  'smallskip',
  'medskip',
  'bigskip',
  'noindent',
  'centering',
  'label',
  'tag',
  'nonumber',
  'notag',
  'rm',
  'bf',
  'it',
  'tt',
  'sf',
  'sc',
  'sl',
  'em',
  'normalsize',
  'small',
  'footnotesize',
  'scriptsize',
  'tiny',
  'large',
  'Large',
  'LARGE',
  'huge',
  'Huge'
])

function protect(text: string): { text: string; store: string[] } {
  const store: string[] = []
  const put = (s: string): string => {
    store.push(s)
    return `\u0000${store.length - 1}\u0000`
  }
  let out = text
  // 围栏代码块
  out = out.replace(/```[\s\S]*?```/g, put)
  // 行内代码
  out = out.replace(/`[^`\n]*`/g, put)
  return { text: out, store }
}

function restore(text: string, store: string[]): string {
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => store[Number(i)] ?? '')
}

/** 把 {...} 里的内容原样返回（支持一层嵌套） */
function readGroup(s: string, i: number): { body: string; next: number } | null {
  if (s[i] !== '{') return null
  let depth = 0
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') depth++
    else if (s[j] === '}') {
      depth--
      if (depth === 0) return { body: s.slice(i + 1, j), next: j + 1 }
    }
  }
  return null
}

function toScript(src: string, table: Record<string, string>): string {
  let out = ''
  for (const ch of src) {
    if (table[ch] !== undefined) out += table[ch]
    else if (ch === ' ') out += ' '
    else return '' // 有无法映射的字符 → 整段放弃（保持原样更安全）
  }
  return out
}

/**
 * 判断 $...$ 里的内容是否真的是数学。
 * 关键：金额写法 `$200 HKD / $25` 里也有一对 $，绝不能当成公式处理。
 */
function looksLikeMath(inner: string): boolean {
  const s = inner.trim()
  if (!s) return false
  if (/\*\*|__/.test(s)) return false // 含 Markdown 强调 → 是正文
  if (/\\[A-Za-z]+/.test(s)) return true // LaTeX 命令
  if (/[_^]/.test(s)) return true // 上下标
  if (/[=<>±≤≥≠≈∞∑∏∫√∂∈∉⊂⊆∪∩→←↔⇒⇔·×÷]/.test(s)) return true // 数学符号
  if (/^[A-Za-z0-9]{1,3}$/.test(s)) return true // 单个变量 $i$ / $T$
  if (/^[A-Za-z0-9.]+\s*[+\-*/]\s*[A-Za-z0-9.]+$/.test(s)) return true // $a+b$
  return false
}

/** 处理数学跨度内部：上下标、分数、根号、命令 */
function normalizeMath(src: string): string {
  return convertScripts(sqrtPass(fracPass(src)), true)
}

/** \frac{a}{b} → a/b */
function fracPass(src: string): string {
  let s = src
  for (let k = 0; k < 4; k++) {
    const next = s.replace(/\\(?:dfrac|tfrac|frac)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_m, a: string, b: string) => {
      const aa = a.trim()
      const bb = b.trim()
      return /^[A-Za-z0-9.]$/.test(aa) && /^[A-Za-z0-9.]$/.test(bb) ? `${aa}/${bb}` : `(${aa})/(${bb})`
    })
    if (next === s) break
    s = next
  }
  return s
}

/** \sqrt{x} → √(x)；\sqrt[n]{x} → ⁿ√(x) */
function sqrtPass(src: string): string {
  return src.replace(/\\sqrt\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}/g, (_m, n: string | undefined, body: string) => {
    const idx = n ? toScript(n.trim(), SUPERSCRIPTS) : ''
    return `${idx}√(${body.trim()})`
  })
}

/**
 * 上下标还原。math=true 时按公式处理（连单字符 x_i 也还原）；math=false 时保守，
 * 只处理大括号写法与「字母基名 + 数字」——这样 snake_case、user_id、q5_0、v3_0 都不会被误改。
 */
function convertScripts(s: string, math: boolean): string {
  // 星号/角度这类上标：只去掉 ^ 本身（s_i^* → sᵢ*、30^\circ → 30°）
  s = s.replace(/\^\s*\{\s*\*\s*\}/g, '*')
  s = s.replace(/\^\s*\*/g, '*')
  s = s.replace(/\^\s*\{\s*\\circ\s*\}/g, '°')
  s = s.replace(/\^\s*\\circ\b/g, '°')

  // 大括号写法：能整体映射成上下标就映射，否则用括号保留内容（\lim_{n \to \infty} → lim(n → ∞)）
  s = s.replace(/\^\s*\{([^{}]*)\}/g, (_m, body: string) => toScript(body, SUPERSCRIPTS) || (body.trim() ? `(${body.trim()})` : ''))
  s = s.replace(/_\s*\{([^{}]*)\}/g, (_m, body: string) => toScript(body, SUBSCRIPTS) || (body.trim() ? `(${body.trim()})` : ''))

  // 字母基名 + 数字：x_2、CO_2、H_2O（q5_0 / v3_0 这类数字基名不动）
  const BASE = '([A-Z]{1,2}|[A-Za-z])'
  s = s.replace(new RegExp(`(^|[^A-Za-z0-9])${BASE}\\^(\\d+)`, 'g'), (_m, pre: string, base: string, d: string) => `${pre}${base}${toScript(d, SUPERSCRIPTS) || `^${d}`}`)
  s = s.replace(new RegExp(`(^|[^A-Za-z0-9])${BASE}_(\\d+)`, 'g'), (_m, pre: string, base: string, d: string) => `${pre}${base}${toScript(d, SUBSCRIPTS) || `_${d}`}`)

  if (math) {
    // 单字符上下标：基名是单个字母/数字，且前面不是标识符字符
    s = s.replace(/(^|[^A-Za-z0-9])([A-Za-z0-9])\^([A-Za-z0-9])/g, (_m, pre: string, base: string, ch: string) => `${pre}${base}${toScript(ch, SUPERSCRIPTS) || `^${ch}`}`)
    s = s.replace(/(^|[^A-Za-z0-9])([A-Za-z0-9])_([A-Za-z0-9])/g, (_m, pre: string, base: string, ch: string) => `${pre}${base}${toScript(ch, SUBSCRIPTS) || `_${ch}`}`)
  }
  return s
}

/**
 * 数学跨度「之外」：只做无歧义还原（\frac、\sqrt、^{...}、_{...}、字母基名+数字）。
 */
function structureOutsideMath(src: string): string {
  return convertScripts(sqrtPass(fracPass(src)), false)
}

/** \text{…} \mathrm{…} \mathbf{…} 等：保留括号内容，去掉命令本身（线性扫描，避免内容重复） */
function unwrapTextCommands(src: string): string {
  const re = /\\([A-Za-z]+)\s*\{/g
  let out = ''
  let last = 0
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (!UNWRAP_KEEP.has(m[1])) continue
    const braceStart = m.index + m[0].length - 1
    const g = readGroup(src, braceStart)
    if (!g) continue
    out += src.slice(last, m.index) + g.body
    last = g.next
    re.lastIndex = g.next
  }
  return out + src.slice(last)
}

/** 处理命令表与结构命令（跨度内外都调用） */
function applyCommands(src: string): string {
  let s = src

  // 文本风格命令：保留大括号内容（\text{a > b} → a > b）
  // 线性扫描：匹配到 \cmd{ 后完整吞掉配对的 {...}，避免内容重复
  s = unwrapTextCommands(s)

  // \href{url}{text} → [text](url)；\url{x} → x
  s = s.replace(/\\href\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_m, url: string, txt: string) => `[${txt}](${url})`)
  s = s.replace(/\\url\s*\{([^{}]*)\}/g, (_m, url: string) => url)

  // 环境：\begin{...} / \end{...} 去掉；\item → 列表项
  s = s.replace(/\\(?:begin|end)\s*\{[^{}]*\}/g, '')
  s = s.replace(/\\item\b\s*/g, '\n- ')

  // 换行与间距
  s = s.replace(/\\\\\s*/g, '\n')
  s = s.replace(/\\(?:newline|par|linebreak)\b\s*/g, '\n')
  s = s.replace(/\\(?:quad|qquad|,|;|:|!|\s)/g, ' ')

  // 命令表（长命令优先，避免 \le 吃掉 \left）
  s = s.replace(/\\([A-Za-z]+)/g, (m, name: string) => {
    if (DROP.has(name)) return ''
    const hit = LATEX_COMMANDS[name]
    return hit !== undefined ? hit : m
  })

  // 转义字面量（必须在命令表之后，避免 \% 被当成 %）
  s = s.replace(/\\([%&_#$@{}])/g, '$1')
  s = s.replace(/\\textbackslash\b/g, '\\')
  s = s.replace(/\\ldots\b|\\dots\b/g, '…')

  // 清理空花括号（注意：绝不能折叠连续空格，否则会破坏 Markdown 代码块缩进）
  s = s.replace(/\{\s*\}/g, '')
  return s
}

/** 数学定界符内的内容：先还原结构，再还原命令 */
function normalizeMathSpan(inner: string): string {
  return applyCommands(normalizeMath(inner)).trim()
}

/**
 * 还原 LaTeX / HTML 实体 / 转义写法 / 不可见字符。
 * 幂等：已经是纯文本时原样返回（快速路径）。
 */
export function normalizeNotation(input: string): string {
  if (!input) return input
  // 快速路径：没有任何可疑标记就直接返回
  if (!/[\\$&#^_\u00a0\u200b-\u200d\ufeff]/.test(input)) return input

  const { text: guarded, store } = protect(input)
  let s = guarded

  for (const [re, to] of INVISIBLE) s = s.replace(re, to)

  // 字面量转义：\uXXXX \u{XXXXX} \xXX
  s = s.replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_m, h: string) => safeFromCodePoint(parseInt(h, 16)))
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => safeFromCodePoint(parseInt(h, 16)))
  s = s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => safeFromCodePoint(parseInt(h, 16)))

  // HTML 实体
  s = s.replace(/&#x([0-9a-fA-F]+);?/g, (_m, h: string) => safeFromCodePoint(parseInt(h, 16)))
  s = s.replace(/&#(\d+);?/g, (_m, d: string) => safeFromCodePoint(parseInt(d, 10)))
  s = s.replace(/&([A-Za-z][A-Za-z0-9]{1,7});/g, (m, name: string) => HTML_ENTITIES[name] ?? m)

  // 数学跨度：$$...$$ → $...$ → \[...\] → \(...\)
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (m, inner: string) => (looksLikeMath(inner) ? normalizeMathSpan(inner) : m))
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner: string) => normalizeMathSpan(inner))
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner: string) => normalizeMathSpan(inner))
  s = s.replace(/\$([^$\n]+)\$/g, (m, inner: string) => (looksLikeMath(inner) ? normalizeMathSpan(inner) : m))

  // 跨度外：结构（\frac/\sqrt/^{...}）→ 命令表；单字符上下标不动，避免误伤 snake_case
  // 文本里出现 LaTeX 命令（\sum、\neq …）说明整段就是公式化写法 → 跨度外也按数学处理（单字符 _i 也还原）；
  // 否则保守处理（只动 ^{...}/_{...}/^数字/_数字），避免误伤 snake_case、user_id 这类标识符
  const latexish = /\\[A-Za-z]{2,}/.test(guarded)
  s = applyCommands(latexish ? normalizeMath(s) : structureOutsideMath(s))

  return restore(s, store)
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return ''
  try {
    return String.fromCodePoint(cp)
  } catch {
    return ''
  }
}

/** 是否需要还原（迁移时用来跳过无关笔记） */
export function needsNormalization(text: string): boolean {
  if (!text) return false
  return normalizeNotation(text) !== text
}
