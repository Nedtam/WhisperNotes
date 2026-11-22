// Markdown → HTML（笔记 App 风格预览：表格/图片/高亮/任务清单/锚点标题；支持嵌套列表）
export interface TocItem {
  level: number
  text: string
  id: string
}

import { normalizeNotation, normalizeBreaks } from './notation'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function inlinePlain(s: string): string {
  // 白名单内联 HTML（mark/u/span 等，编辑器写入）先藏起来，避免被 esc 转义后无法还原
  const keep: string[] = []
  const guarded = s.replace(/<\/?(?:mark|u|span|strong|em|b|i|br|hr)(?:\s[^>]*)?\/?>/gi, (m) => {
    keep.push(m)
    return `\uE000K${keep.length - 1}\uE000`
  })
  let out = esc(guarded)
    .replace(/\uE000K(\d+)\uE000/g, (_m, i: string) => keep[Number(i)] ?? '')
  // 先把代码片段摘出来，再处理内联语法，最后还原：
  // 之前 == 在 code 之前处理，代码里的 == / ** / * 会被当成 Markdown 语法，
  // 与荧光标记互相污染（就是笔记里 ==…== 冲突、叠加的来源）。
  const codes: string[] = []
  out = out.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c)
    return `\uE001C${codes.length - 1}\uE001`
  })
  // 还原后再做标准转换；占位符保证不会被 esc 破坏
  out = out
    // 荧光：内容不能以空白/= 开头结尾，且必须含字母/数字/汉字 —— 挡住代码式 `a == b`
    .replace(/==([^\s=](?:[^=\n]{0,400}?[^\s=])?)==/g, (m, c: string) =>
      /[\p{L}\p{N}]/u.test(c) ? `<mark class="hl-yellow">${c}</mark>` : m
    )
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\uE001C(\d+)\uE001/g, (_m, i: string) =>
      `<code class="rounded bg-black/10 dark:bg-white/10 px-1 py-0.5 text-[12px]">${codes[Number(i)] ?? ''}</code>`
    )
    .replace(
      /!\[([^\]]*)\]\((data:image\/[a-zA-Z+]+;base64,[^)\s]+)\)/g,
      '<img class="my-2 max-w-full rounded-lg" alt="$1" src="$2" />'
    )
    .replace(
      /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
      '<img class="my-2 max-w-full rounded-lg" alt="$1" src="$2" />'
    )
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a class="underline" href="$2" target="_blank" rel="noreferrer">$1</a>'
    )
  return out
}

function inline(s: string): string {
  // 兼容旧的原始 HTML 荧光笔（hl-green / hl-pink 直接写在 md 里）
  const MARK_TOKEN = /(<mark class="hl-(?:yellow|green|pink|blue|orange)">|<\/mark>)/g
  const parts = s.split(MARK_TOKEN)
  if (parts.length === 1) return inlinePlain(s)
  let out = ''
  let open = false
  for (const part of parts) {
    const openM = part.match(/^<mark class="hl-(yellow|green|pink|blue|orange)">$/)
    if (openM) {
      out += `<mark class="hl-${openM[1]}">`
      open = true
      continue
    }
    if (part === '</mark>' && open) {
      out += '</mark>'
      open = false
      continue
    }
    out += inlinePlain(part)
  }
  return out
}

/** 提取大纲标题（预览跳转用） */
export function extractToc(mdRaw: string): TocItem[] {
  const md = normalizeBreaks(normalizeNotation(mdRaw))
  const out: TocItem[] = []
  let n = 0
  for (const line of md.replace(/\r/g, '').split('\n')) {
    const m = line.match(/^\s*(#{1,4})\s+(.*)$/)
    if (m) {
      out.push({ level: m[1].length, text: m[2].trim(), id: `h-${n++}` })
    }
  }
  return out
}

/** md → html；为标题生成 id（预览时点击目录跳转） */
export function mdToHtml(mdRaw: string): { html: string; headings: TocItem[] } {
  const md = normalizeNotation(mdRaw)
  const headings: TocItem[] = []
  let hid = 0
  const lines = md.replace(/\r/g, '').split('\n')
  const out: string[] = []
  let inCode = false
  let inTable = false
  let tableRows: string[][] = []
  // 表格自定义尺寸（由编辑器写入的 <!--wn:cols=.. rows=..--> 提供，随 Markdown 保存）
  let wnMeta: string | null = null
  let wnAlign: string | null = null

  // 嵌套列表状态栈：indent 单位 = 前导空格数
  const stack: Array<{ indent: number; tag: 'ul' | 'ol'; liOpen: boolean; task?: boolean }> = []

  const closeTable = (): void => {
    const meta = wnMeta
    wnMeta = null
    if (!inTable) return
    inTable = false
    const all = tableRows
    tableRows = []
    if (!all.length) return
    let body = all.slice(1)
    // 跳过经典的 | --- | --- | 分隔行
    if (body.length && body[0].every((c) => /^:?-{2,}:?$/.test(c.trim()))) body = body.slice(1)
    // 列数对齐：以最宽行为准补齐空缺，列数不一致时不再错位（AI 生成的表格常见）
    const cols = Math.max(1, ...[...all].map((r) => r.length))
    const pad = (r: string[]): string[] => [...r, ...Array(Math.max(0, cols - r.length)).fill('')].slice(0, cols)
    const head = pad(all[0] ?? [])
    body = body.map(pad)
    // 可选尺寸元数据：<!--wn:cols=120,180 rows=28,40,40-->
    let colW: number[] = []
    let rowH: number[] = []
    if (meta) {
      const cm = meta.match(/cols=([\d.,\s]+)/)
      const rm = meta.match(/rows=([\d.,\s]+)/)
      if (cm) colW = cm[1].split(',').map((s) => parseFloat(s) || 0).filter((n) => n > 0)
      if (rm) rowH = rm[1].split(',').map((s) => parseFloat(s) || 0).filter((n) => n > 0)
    }
    const fixed = colW.length > 0 || rowH.length > 0
    const colgroup = colW.length
      ? `<colgroup>${colW.map((w) => `<col style="width:${w}px">`).join('')}</colgroup>`
      : ''
    const styleOf = (rowIdx: number): string => (rowH[rowIdx] ? ` style="height:${rowH[rowIdx]}px"` : '')
    const ths = head
      .map((c) => `<th${styleOf(0)} class="border border-edge px-2 py-1 text-left">${inline(c.trim())}</th>`)
      .join('')
    const trs = body
      .map((r, i) => `<tr>${r.map((c) => `<td${styleOf(i + 1)} class="border border-edge px-2 py-1">${inline(c.trim())}</td>`).join('')}</tr>`)
      .join('')
    // 自定义列宽：总宽 = 各列之和（可整体拖大/拖小），不再强制 100%
    const sumW = colW.reduce((a, b) => a + b, 0)
    const widthStyle = sumW > 0 ? ` style="width:${Math.round(sumW)}px"` : ''
    const sizeCls = fixed ? ' wn-fixed' : ' w-full'
    out.push(
      `<table class="my-2 border-collapse text-[13px]${sizeCls}"${widthStyle}>${colgroup}<thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`
    )
  }
  /** 切表格行：忽略 `code` 里的竖线和转义 \| （否则代码里的 | 会把列切错） */
  const splitRow = (line: string): string[] => {
    const body = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
    const cells: string[] = []
    let cur = ''
    let inCode = false
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]
      if (ch === '\\' && body[i + 1] === '|') {
        cur += '|'
        i++
        continue
      }
      if (ch === '`') {
        inCode = !inCode
        cur += ch
        continue
      }
      if (ch === '|' && !inCode) {
        cells.push(cur)
        cur = ''
        continue
      }
      cur += ch
    }
    cells.push(cur)
    return cells.map((c) => c.trim())
  }
  const flushTableRow = (line: string): void => {
    tableRows.push(splitRow(line))
  }

  const closeCtx = (): void => {
    const c = stack.pop()
    if (!c) return
    if (c.liOpen) {
      if (c.task) out.push('</span>')
      out.push('</li>')
    }
    out.push(`</${c.tag}>`)
  }
  const closeAllLists = (): void => {
    while (stack.length) closeCtx()
  }

  /** 打开一个列表项：不立即闭合，直到遇到同级下一项或列表结束（这样嵌套列表才能正确放进 <li> 内） */
  const openLi = (contentHtml: string, taskDone: boolean | null): void => {
    const ctx = stack[stack.length - 1]
    if (!ctx) return
    ctx.liOpen = true
    if (taskDone !== null) {
      ctx.task = true
      const done = taskDone
      out.push(
        `<li data-task="${done ? 'x' : ' '}" class="flex items-start gap-2"><span data-taskbox class="mt-0.5 inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded border text-[10px] ${done ? 'bg-emerald-500/80 border-emerald-500/60 text-white' : 'border-edge'}">${done ? '✓' : ''}</span><span class="${done ? 'line-through opacity-60' : ''}">` +
          contentHtml
      )
    } else {
      out.push(`<li>${contentHtml}`)
    }
  }

  /** 处理一行列表。indent=前导空格数；kind: 'ul' | 'ol'；taskDone: null 普通项 */
  const listLine = (indent: number, kind: 'ul' | 'ol', contentHtml: string, taskDone: boolean | null): void => {
    // 关闭更深层的已打开列表（回到本行所在层级）
    while (stack.length && stack[stack.length - 1].indent > indent) closeCtx()
    const top = stack[stack.length - 1]
    if (top && top.indent === indent && top.tag !== kind) closeCtx()
    const t2 = stack[stack.length - 1]
    if (!t2 || t2.indent < indent) {
      // 同一层里换了列表种类（如 1. 之后出现 - ）→ 先闭合再开新列表
      stack.push({ indent, tag: kind, liOpen: false })
      out.push(
        kind === 'ul'
          ? '<ul class="my-1 space-y-1 pl-5 list-disc">'
          : '<ol class="my-1 space-y-1 pl-5 list-decimal">'
      )
    }
    const ctx = stack[stack.length - 1]
    // 同级已有打开的上一项 → 先闭合它，再开新项
    if (ctx.liOpen) {
      if (ctx.task) out.push('</span>')
      out.push('</li>')
      ctx.task = false
    }
    ctx.liOpen = false
    openLi(contentHtml, taskDone)
  }

  const isSepRow = (l: string): boolean => {
    if (!l.includes('-') || !l.includes('|')) return false
    const cells = l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
    return cells.length > 0 && cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(c))
  }
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li]
    const line = raw.trimEnd()
    const nextLine = (lines[li + 1] ?? '').trimEnd()
    // 表格行：① 以 | 开头（标准） ② 已在表格中且含 | ③ 含 | 且下一行是 |---| 分隔行
    //   （AI 生成的表格经常省掉行首竖线，旧逻辑会把整张表当普通段落渲染 → 看起来"表格坏了"）
    const isTableRow =
      /^\s*\|/.test(line) ||
      (inTable && line.includes('|')) ||
      (line.includes('|') && isSepRow(nextLine))

    // 表格自定义尺寸注释（编辑器写入，随 md 保存）
    if (/^\s*<!--wn:/.test(line)) {
      wnMeta = line
      continue
    }
    // 段落对齐注释（编辑器写入）
    const am = line.match(/^\s*<!--wn-p:(left|center|right|justify)-->\s*$/)
    if (am) {
      wnAlign = am[1]
      continue
    }

    if (/^\s*```/.test(line)) {
      closeAllLists()
      closeTable()
      if (inCode) {
        out.push('</pre>')
        inCode = false
      } else {
        out.push('<pre class="overflow-x-auto rounded-lg bg-surface-2 dark:bg-black/60 p-3 text-[12px] leading-5">')
        inCode = true
      }
      continue
    }
    if (inCode) {
      out.push(esc(line))
      continue
    }

    // 表格
    if (isTableRow) {
      closeAllLists()
      if (!inTable) {
        inTable = true
        tableRows = []
      }
      flushTableRow(line)
      continue
    }
    if (inTable) {
      closeTable()
    }

    // 标题 / 分隔线
    const h = line.match(/^\s*(#{1,4})\s+(.*)$/)
    if (h) {
      closeAllLists()
      const lv = h[1].length
      const id = `h-${hid}`
      hid++
      if (lv <= 4) headings.push({ level: lv, text: h[2].trim(), id })
      const cls = lv <= 2 ? 'mt-5 mb-1.5 font-semibold' : 'mt-3 mb-1 font-medium'
      const tag = lv === 1 ? 'h1' : lv === 2 ? 'h2' : lv === 3 ? 'h3' : 'h4'
      const lead = line.length - line.trimStart().length
      const indLvl = Math.floor(lead / 2)
      const indAttr = indLvl > 0 ? ` data-indent="${indLvl}" style="margin-left:${indLvl * 14}px"` : ''
      out.push(`<${tag} id="${id}"${indAttr} class="scroll-mt-6 ${cls}">${inline(h[2])}</${tag}>`)
      continue
    }
    if (/^\s*-{3,}\s*$/.test(line)) {
      closeAllLists()
      closeTable()
      out.push('<hr class="my-3 border-edge" />')
      continue
    }

    // 列表（可缩进嵌套）：- [x] 任务 / - 无序 / 1. 有序
    const lm = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?(.*)$/)
    if (lm) {
      const indent = lm[1].length
      const marker = lm[2]
      const task = lm[3]
      const rest = lm[4]
      if (task) {
        const done = task.trim().toLowerCase() === '[x]'
        listLine(indent, 'ul', inline(rest.trim()), done)
      } else if (/^[-*+]$/.test(marker)) {
        listLine(indent, 'ul', inline(rest), null)
      } else {
        listLine(indent, 'ol', inline(rest), null)
      }
      continue
    }
    if (/^>\s?/.test(line)) {
      closeAllLists()
      closeTable()
      out.push(`<blockquote class="my-2 border-l-2 pl-3 text-[color:var(--dim)]">${inline(line.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }
    if (line.trim() === '') {
      closeAllLists()
      continue
    }
    closeAllLists()
    closeTable()
    const lead = line.length - line.trimStart().length
    const indLvl = Math.floor(lead / 2)
    const indAttr = indLvl > 0 ? ` data-indent="${indLvl}" style="margin-left:${indLvl * 14}px"` : ''
    const alAttr = wnAlign ? ` style="text-align:${wnAlign}${indLvl > 0 ? ';margin-left:' + indLvl * 14 + 'px' : ''}"` : indAttr
    out.push(`<p class="my-1.5 leading-relaxed"${alAttr}>${inline(line.replace(/^\s+/, ''))}</p>`)
    wnAlign = null
  }
  closeAllLists()
  closeTable()
  if (inCode) out.push('</pre>')
  return { html: out.join('\n'), headings }
}

/**
 * 把表格与图片各自包进一个横向滚动容器：
 * 手机上宽表格/大图只让自己横向拖动，不会把整篇笔记压扁。
 */
export function wrapScrollables(html: string): string {
  if (!html) return html
  return html
    .replace(/<table\b[\s\S]*?<\/table>/gi, (m) => `<div class="md-xscroll">${m}</div>`)
    .replace(/<img\b[^>]*?>/gi, (m) => `<span class="md-xscroll-img">${m}</span>`)
}
