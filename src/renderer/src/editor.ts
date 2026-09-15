import { t } from './i18n'

// 增强 Markdown 编辑：Enter 续列表、Tab/Shift+Tab 缩进、代码块自动闭合、== 高亮包裹等
export type MarkdownAction = 'bold' | 'italic' | 'hl-yellow' | 'hl-green' | 'hl-pink' | 'code' | 'link' | 'task' | 'ul' | 'ol' | 'quote' | 'hr' | 'h1' | 'h2' | 'h3'

/** 光标/选区工具（操作真实 textarea） */
export function wrapSelection(ta: HTMLTextAreaElement, before: string, after = before, placeholder = ''): { text: string; sel: [number, number] } | null {
  const { selectionStart: s, selectionEnd: e, value } = ta
  const sel = value.slice(s, e) || placeholder
  const next = value.slice(0, s) + before + sel + after + value.slice(e)
  return { text: next, sel: [s + before.length, s + before.length + sel.length] }
}

export function insertAt(ta: HTMLTextAreaElement, insert: string): { text: string; sel: [number, number] } {
  const { selectionStart: s, selectionEnd: e, value } = ta
  const next = value.slice(0, s) + insert + value.slice(e)
  return { text: next, sel: [s + insert.length, s + insert.length] }
}

export function insertBlock(ta: HTMLTextAreaElement, block: string): { text: string; sel: [number, number] } {
  const { selectionStart: s, selectionEnd: e, value } = ta
  const lineStart = value.lastIndexOf('\n', s - 1) + 1
  const before = value.slice(0, lineStart)
  const after = value.slice(e)
  const nlBefore = lineStart > 0 && before[before.length - 1] !== '\n' ? '\n' : ''
  const next = before + nlBefore + block + '\n' + after
  return { text: next, sel: [lineStart + nlBefore.length + block.length + 1, lineStart + nlBefore.length + block.length + 1] }
}

export function currentLine(value: string, pos: number): { line: string; start: number; end: number } {
  const start = value.lastIndexOf('\n', pos - 1) + 1
  let end = value.indexOf('\n', pos)
  if (end === -1) end = value.length
  return { line: value.slice(start, end), start, end }
}

const LIST_MARKER = /^(\s*)((?:[-*+]|\d+[.)])\s+)(\[[ xX]\]\s+)?(.*)$/

/** 处理 Enter：列表续行 / 空列表项退出 / 代码块自动闭合。返回 null 表示走默认 */
export function handleEnter(value: string, ta: HTMLTextAreaElement): { text: string; sel: [number, number] } | null {
  const pos = ta.selectionStart
  const { line, start, end } = currentLine(value, pos)
  const codeOpen = /^```/.test(line.trim())
  if (codeOpen && pos >= end - 1) {
    // 打开代码块后 Enter → 插入闭合围栏
    const next = value.slice(0, end) + '\n```' + value.slice(end)
    return { text: next, sel: [end + 1, end + 1] }
  }
  const m = line.match(LIST_MARKER)
  if (m) {
    const [, indent, marker, task, content] = m
    const atEnd = pos >= end - 1
    if (atEnd) {
      if (!content.trim()) {
        // 空列表项 → 退出列表
        const next = value.slice(0, start) + value.slice(end).replace(/^\n/, '')
        return { text: next, sel: [start, start] }
      }
      const cont = task ? `${indent}${marker}${task}` : `${indent}${marker}`
      const next = value.slice(0, end) + '\n' + cont + value.slice(end)
      return { text: next, sel: [end + 1 + cont.length, end + 1 + cont.length] }
    }
  }
  return null
}

/** 处理 Tab/Shift+Tab：有选区按行缩进；列表行整体加/去两级缩进；否则插入 4 空格 */
export function handleTab(value: string, ta: HTMLTextAreaElement, shift = false): { text: string; sel: [number, number] } {
  const { selectionStart: s, selectionEnd: e } = ta
  if (s !== e) {
    const startLine = value.lastIndexOf('\n', s - 1) + 1
    let endLine = value.indexOf('\n', e - 1)
    if (endLine === -1) endLine = value.length
    const block = value.slice(startLine, endLine)
    const lines = block.split('\n')
    const out = lines
      .map((l) => {
        if (shift) return l.replace(/^(\s{1,4}|\t)/, '')
        return '  ' + l
      })
      .join('\n')
    const next = value.slice(0, startLine) + out + value.slice(endLine)
    return { text: next, sel: [startLine, startLine + out.length] }
  }
  // 单光标
  const pos = s
  const { line, start } = currentLine(value, pos)
  const cursorCol = pos - start
  if (shift) {
    if (cursorCol > 0) return { text: value, sel: [s, e] }
    const removed = line.match(/^ {1,4}|\t/)?.[0] ?? ''
    if (!removed) return { text: value, sel: [s, e] }
    const next = value.slice(0, start) + value.slice(start + removed.length)
    return { text: next, sel: [start, start] }
  }
  const isList = /^(\s*)([-*+]|\d+[.)])\s/.test(line)
  if (cursorCol === 0 || isList) {
    const next = value.slice(0, start) + '  ' + line + value.slice(start + line.length)
    return { text: next, sel: [start + 2 + cursorCol, start + 2 + cursorCol] }
  }
  const next = value.slice(0, s) + '    ' + value.slice(e)
  return { text: next, sel: [s + 4, s + 4] }
}

export function applyToolbarAction(ta: HTMLTextAreaElement, action: MarkdownAction): { text: string; sel: [number, number] } {
  const block = (s: string): ReturnType<typeof insertBlock> => insertBlock(ta, s)
  switch (action) {
    case 'bold':
      return wrapSelection(ta, '**', '**', t('ed.bold'))!
    case 'italic':
      return wrapSelection(ta, '*', '*', t('ed.italic'))!
    case 'code':
      return wrapSelection(ta, '`', '`', 'code')!
    case 'link':
      return wrapSelection(ta, '[', '](https://)', t('ed.link'))!
    case 'hl-yellow':
      return wrapSelection(ta, '==', '==', t('ed.highlight'))!
    case 'hl-green':
      return wrapSelection(ta, '<mark class="hl-green">', '</mark>', t('ed.highlight'))!
    case 'hl-pink':
      return wrapSelection(ta, '<mark class="hl-pink">', '</mark>', '高亮')!
    case 'task':
      return block('- [ ] ')
    case 'ul':
      return block('- ')
    case 'ol':
      return block('1. ')
    case 'quote':
      return block('> ')
    case 'hr':
      return block('---')
    case 'h1':
      return block('# ')
    case 'h2':
      return block('## ')
    case 'h3':
      return block('### ')
    default:
      return insertAt(ta, '')
  }
}

export const TABLE_TEMPLATE = `| 标题 | 内容 |
| --- | --- |
|  |  |`

/** 生成表格占位并在首个单元格内放置光标 */
export function insertTable(ta: HTMLTextAreaElement): { text: string; sel: [number, number] } {
  const r = insertBlock(ta, TABLE_TEMPLATE)
  // 光标移到首行首单元格
  const start = r.sel[0] - (TABLE_TEMPLATE.length - 2)
  return { text: r.text, sel: [start, start] }
}

export function blockPrefixAt(value: string, pos: number): string {
  const { line } = currentLine(value, pos)
  const m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/)
  return m ? m[1] + m[2] + ' ' + (m[3] ?? '') : ''
}
