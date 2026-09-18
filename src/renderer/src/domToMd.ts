// DOM → Markdown：把 WYSIWYG 编辑区（由 md.ts 生成的受控结构）序列化回 md
// 只覆盖 md.ts 会生成的元素 + 用户在 contentEditable 中常见的编辑结果。
// 列表支持嵌套（每层两个空格缩进）。

function inlineChildren(el: Element): string {
  let out = ''
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.nodeValue ?? ''
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const c = child as Element
    const tag = c.tagName
    if (tag === 'BR') {
      out += '\n'
      continue
    }
    if (tag === 'STRONG' || tag === 'B') {
      out += '**' + inlineChildren(c) + '**'
      continue
    }
    if (tag === 'EM' || tag === 'I') {
      out += '*' + inlineChildren(c) + '*'
      continue
    }
    if (tag === 'CODE') {
      out += '`' + inlineChildren(c) + '`'
      continue
    }
    if (tag === 'U' || tag === 'INS') {
      out += '<u>' + inlineChildren(c) + '</u>'
      continue
    }
    if (tag === 'MARK') {
      const cls = c.getAttribute('class') ?? ''
      if (cls.includes('hl-yellow')) out += '==' + inlineChildren(c) + '=='
      else if (cls.includes('hl-green')) out += '<mark class="hl-green">' + inlineChildren(c) + '</mark>'
      else if (cls.includes('hl-pink')) out += '<mark class="hl-pink">' + inlineChildren(c) + '</mark>'
      else if (cls.includes('hl-blue')) out += '<mark class="hl-blue">' + inlineChildren(c) + '</mark>'
      else if (cls.includes('hl-orange')) out += '<mark class="hl-orange">' + inlineChildren(c) + '</mark>'
      else out += inlineChildren(c)
      continue
    }
    if (tag === 'A') {
      const href = c.getAttribute('href') ?? ''
      out += '[' + inlineChildren(c) + '](' + href + ')'
      continue
    }
    if (tag === 'IMG') {
      const alt = c.getAttribute('alt') ?? ''
      const src = c.getAttribute('src') ?? ''
      out += '![' + alt + '](' + src + ')'
      continue
    }
    if (tag === 'UL' || tag === 'OL') continue // 嵌套列表由列表序列化单独处理
    if (tag === 'SPAN' || tag === 'FONT' || tag === 'LABEL') {
      const st = c.getAttribute('style')
      if (st && (tag === 'SPAN' || tag === 'FONT')) {
        out += `<${tag.toLowerCase()} style="${st}">` + inlineChildren(c) + `</${tag.toLowerCase()}>`
      } else {
        out += inlineChildren(c)
      }
      continue
    }
    // 其它元素意外出现在行内：取其文本
    out += c.textContent ?? ''
  }
  return out
}

function splitLines(s: string): string[] {
  return s.split('\n')
}

const INDENT = '  '

function serializeLi(li: HTMLElement, ordered: boolean, depth: number): string[] {
  const lines: string[] = []
  const liLvl = Number(li.getAttribute('data-indent') ?? '0') || 0
  const indent = INDENT.repeat(depth + liLvl)
  const box = li.querySelector('[data-taskbox]')
  let content: string
  if (box) {
    const clone = li.cloneNode(true) as HTMLElement
    clone.querySelector('[data-taskbox]')?.remove()
    clone.querySelectorAll('ul,ol').forEach((u) => u.remove())
    content = inlineChildren(clone).trim()
    const done = li.getAttribute('data-task') === 'x'
    lines.push(`${indent}- [${done ? 'x' : ' '}] ${content}`)
  } else {
    const clone = li.cloneNode(true) as HTMLElement
    clone.querySelectorAll('ul,ol').forEach((u) => u.remove())
    content = inlineChildren(clone).trim()
    lines.push(`${indent}${ordered ? '1. ' : '- '}${content}`)
  }
  for (const ch of Array.from(li.children)) {
    if (ch.tagName === 'UL' || ch.tagName === 'OL') {
      lines.push(...blockLines(ch as Element, depth + 1))
    }
  }
  return lines
}

function blockLines(el: Element, depth = 0): string[] {
  const tag = el.tagName
  const indentAttr = (el as HTMLElement).getAttribute('data-indent')
  const pad = INDENT.repeat(depth) + (indentAttr ? INDENT.repeat(Number(indentAttr) || 0) : '')
  if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') {
    const n = Number(tag[1])
    return [pad + '#'.repeat(n) + ' ' + inlineChildren(el)]
  }
  if (tag === 'P') {
    const al = ((el as HTMLElement).style.textAlign || '').trim()
    const lines = splitLines(inlineChildren(el))
      .filter((l) => l.length > 0)
      .map((l) => pad + l)
    if (al && al !== 'left') lines.unshift(pad + `<!--wn-p:${al}-->`)
    return lines
  }
  if (tag === 'HR') return ['---']
  if (tag === 'PRE') {
    const code = (el.textContent ?? '').replace(/\n$/, '')
    return ['```', ...code.split('\n'), '```']
  }
  if (tag === 'BLOCKQUOTE') {
    const lines: string[] = []
    for (const ch of Array.from(el.childNodes)) {
      if (ch.nodeType === Node.TEXT_NODE) {
        for (const l of splitLines(ch.nodeValue ?? '')) if (l.trim()) lines.push(INDENT.repeat(depth) + '> ' + l)
      } else if (ch.nodeType === Node.ELEMENT_NODE) {
        const sub = blockLines(ch as Element, depth)
        if (sub.length) lines.push(...sub.map((l) => (l.startsWith(INDENT.repeat(depth) + '>') ? l : INDENT.repeat(depth) + '> ' + l)))
      }
    }
    return lines
  }
  if (tag === 'UL' || tag === 'OL') {
    const ordered = tag === 'OL'
    const lines: string[] = []
    for (const li of Array.from(el.children)) {
      if (li.tagName !== 'LI') continue
      lines.push(...serializeLi(li as HTMLElement, ordered, depth))
    }
    return lines
  }
  if (tag === 'TABLE') {
    const lines: string[] = []
    const rows: string[][] = []
    const thead = el.querySelector(':scope > thead')
    const tbody = el.querySelector(':scope > tbody')
    const pushRow = (cells: NodeListOf<Element>): void => {
      rows.push(Array.from(cells).map((c) => inlineChildren(c).trim()))
    }
    if (thead?.querySelector('tr')) pushRow(thead.querySelectorAll('tr')[0].querySelectorAll(':scope > th, :scope > td'))
    tbody?.querySelectorAll(':scope > tr').forEach((tr) => pushRow(tr.querySelectorAll(':scope > th, :scope > td')))
    if (!rows.length) return []
    const ncol = Math.max(...rows.map((r) => r.length))
    const pad = (r: string[]): string[] => [...r, ...Array(Math.max(0, ncol - r.length)).fill('')]
    // 读回列宽 / 行高（编辑器拖拽产生）→ 写进 <!--wn:...-->，下次打开仍保持
    const colEls = Array.from(el.querySelectorAll(':scope > colgroup > col'))
    const widths = colEls
      .map((c) => parseInt((c.getAttribute('style') || '').replace(/.*width:\s*(\d+)px.*/, '$1'), 10))
      .filter((n) => !Number.isNaN(n) && n > 0)
    const allTrs: HTMLElement[] = []
    if (thead?.querySelector('tr')) allTrs.push(thead.querySelector('tr') as HTMLElement)
    tbody?.querySelectorAll(':scope > tr').forEach((tr) => allTrs.push(tr as HTMLElement))
    const heights = allTrs
      .map((tr) => {
        const first = tr.querySelector(':scope > th, :scope > td') as HTMLElement | null
        if (!first) return 0
        const m = (first.getAttribute('style') || '').match(/height:\s*(\d+)px/)
        return m ? parseInt(m[1], 10) : 0
      })
      .filter((n) => n > 0)
    const meta = widths.length || heights.length
      ? `<!--wn:cols=${widths.join(',')} rows=${heights.join(',')}-->`
      : ''
    if (meta) lines.push(meta)
    lines.push('| ' + pad(rows[0]).join(' | ') + ' |')
    lines.push('| ' + Array(ncol).fill('---').join(' | ') + ' |')
    for (let i = 1; i < rows.length; i++) lines.push('| ' + pad(rows[i]).join(' | ') + ' |')
    return lines
  }
  if (tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'BODY') {
    // 通用容器：递归展平
    const lines: string[] = []
    for (const ch of Array.from(el.childNodes)) {
      if (ch.nodeType === Node.TEXT_NODE) {
        const t = (ch.nodeValue ?? '').trim()
        if (t) lines.push(t)
      } else if (ch.nodeType === Node.ELEMENT_NODE) {
        lines.push(...blockLines(ch as Element, depth))
      }
    }
    return lines
  }
  if (tag === 'LI') {
    return serializeLi(el as HTMLElement, false, depth)
  }
  // 其它块级未知元素按文本段处理
  const t = (el.textContent ?? '').trim()
  return t ? [t] : []
}

/** 根容器 → 完整 markdown 文本 */
export function domToMd(root: HTMLElement): string {
  const lines: string[] = []
  for (const ch of Array.from(root.childNodes)) {
    if (ch.nodeType === Node.TEXT_NODE) {
      const t = (ch.nodeValue ?? '').trim()
      if (t) lines.push(t)
    } else if (ch.nodeType === Node.ELEMENT_NODE) {
      lines.push(...blockLines(ch as Element))
    }
  }
  // 相邻普通行之间不需要空行（md.ts 逐行渲染）；但列表/表格与正文之间留空更稳
  const out: string[] = []
  let prevBlock = ''
  for (const l of lines) {
    const curBlock = /^\s*(#|\||>|[-*+] |\d+[.)] |---|```)/.test(l) ? 'special' : 'text'
    if (curBlock !== prevBlock && out.length && curBlock === 'text') out.push('')
    out.push(l)
    prevBlock = curBlock
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
