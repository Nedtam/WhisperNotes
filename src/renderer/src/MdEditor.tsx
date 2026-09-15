// WYSIWYG Markdown 编辑器：内容 = mdToHtml 渲染的可编辑文档；输入时把 DOM 序列化回 md 供保存/同步。
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { mdToHtml } from './md'
import { domToMd } from './domToMd'
import { t } from './i18n'

export interface PickedImage {
  name: string
  dataUrl: string
}

export interface MdEditorProps {
  value: string
  onChange(md: string): void
  onUndo?(): void
  onRedo?(): void
  canUndo?: boolean
  canRedo?: boolean
  /** 返回 null 表示取消插入 */
  pickImage?(): Promise<PickedImage | null>
}

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'DIV', 'HR'])

function topBlock(node: Node | null, root: HTMLElement): HTMLElement | null {
  // 返回光标所在的最内层块（P / 标题 / LI…），列表内返回 <li> 而不是 <ol>
  let cur: Node | null = node
  while (cur && cur !== root) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const tag = (cur as HTMLElement).tagName
      if (BLOCK_TAGS.has(tag) && tag !== 'DIV' && tag !== 'HR') return cur as HTMLElement
    }
    cur = cur.parentNode
  }
  return null
}

function placeCaret(container: Node, atStart = false): void {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.selectNodeContents(container)
  range.collapse(atStart)
  sel.removeAllRanges()
  sel.addRange(range)
}

interface FlatSeg {
  node: Text
  start: number
  len: number
}

const LINE_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE'])

/** 荧光笔色板：5 种颜色，选中后保持为该“当前高亮色”，直到换色 */
const HL_COLORS: Array<{ cls: string; swatch: string; label: string }> = [
  { cls: 'hl-yellow', swatch: '#f5c211', label: 'Yellow' },
  { cls: 'hl-green', swatch: '#34d399', label: 'Green' },
  { cls: 'hl-pink', swatch: '#f472b6', label: 'Pink' },
  { cls: 'hl-blue', swatch: '#60a5fa', label: 'Blue' },
  { cls: 'hl-orange', swatch: '#fb923c', label: 'Orange' }
]

const FONT_FAMILIES: Array<{ key: string; label: string; css: string }> = [
  { key: 'ed.defaultFont', label: '', css: '' },
  { key: '', label: 'PingFang SC', css: 'PingFang SC, sans-serif' },
  { key: '', label: 'Helvetica', css: 'Helvetica, Arial, sans-serif' },
  { key: '', label: 'Georgia', css: 'Georgia, serif' },
  { key: '', label: 'Courier New', css: 'Courier New, monospace' }
]
const FONT_SIZES = [13, 14, 15, 16, 18, 20, 24, 28, 32]

/**
 * 把编辑区压成“视觉行”纯文本（每段/每列表项一行，行间 \n），并记录每个文本节点
 * 对应的位置。行数/列表标记的变化不会影响这里的分割 —— 所以撤销/重做结构变化时，
 * 光标偏移依然能稳定对齐（这正是原来“块序号映射”会在列表/标题重做时跳错的原因）。
 */
function flattenEditor(root: HTMLElement): { text: string; segs: FlatSeg[] } {
  let text = ''
  const segs: FlatSeg[] = []
  const pushText = (t: Text): void => {
    const v = t.nodeValue ?? ''
    if (!v.length) return
    segs.push({ node: t, start: text.length, len: v.length })
    text += v
  }
  const ensureNl = (): void => {
    if (text.length && text[text.length - 1] !== '\n') text += '\n'
  }
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text
      if ((t.nodeValue ?? '').trim() !== '') pushText(t)
      return
    }
    const tag = (node as Element).tagName
    if (LINE_TAGS.has(tag)) {
      ensureNl()
      for (const ch of Array.from(node.childNodes)) walk(ch)
      return
    }
    for (const ch of Array.from(node.childNodes)) walk(ch)
  }
  for (const ch of Array.from(root.childNodes)) walk(ch)
  return { text, segs }
}

/** 取 range 覆盖文本的扁平文本（用于计算光标所在全局偏移） */
function rangeFlatText(root: HTMLElement, range: Range): string {
  const frag = range.cloneContents()
  const wrap = document.createElement('div')
  wrap.appendChild(frag)
  return flattenEditor(wrap).text
}

/**
 * 按“变更区域相对光标在哪一侧”计算新偏移：
 * 变更整体在光标左/上方 → 贴住右侧未变内容（保持到文末距离）；
 * 变更整体在右/下方 → 贴住左侧未变内容（保持到文首距离）；
 * 光标恰在变更起点 → 删除类回到起点、插入类停在被插内容之后。
 */
function caretOffsetAfterChange(textA: string, offsetA: number, textB: string): number {
  const nA = textA.length
  const nB = textB.length
  if (nA === 0) return Math.min(offsetA, nB)
  if (textA === textB) return Math.max(0, Math.min(offsetA, nB))
  let p = 0
  while (p < nA && p < nB && textA[p] === textB[p]) p++
  let s = 0
  while (s < nA - p && s < nB - p && textA[nA - 1 - s] === textB[nB - 1 - s]) s++
  const lo = p
  const hiA = nA - s
  const hiB = nB - s
  if (offsetA <= lo) {
    // 光标在变更起点：删除 → 停起点；插入 → 停在被插内容之后
    return hiA > hiB ? lo : Math.min(nB, lo + (hiB - hiA))
  }
  if (offsetA >= hiA) {
    // 变更在光标左/上方 → 贴右侧内容（相对文末距离不变）
    return Math.max(0, Math.min(nB, nB - (nA - offsetA)))
  }
  // 光标落在变更区内：优先用右侧文本作锚点，找不到再用左侧文本
  const right = textA.slice(offsetA, Math.min(nA, offsetA + 240))
  if (right.length) {
    const at = textB.indexOf(right)
    if (at >= 0) return at
  }
  const left = textA.slice(Math.max(0, offsetA - 240), offsetA)
  if (left.length) {
    const at = textB.lastIndexOf(left)
    if (at >= 0) return at + left.length
  }
  return Math.max(0, Math.min(offsetA, nB))
}

/** 按扁平文本偏移把光标放回编辑区 */
function setCaretByFlatOffset(root: HTMLElement, offset: number): void {
  const sel = window.getSelection()
  if (!sel) return
  const { segs } = flattenEditor(root)
  const place = (node: Text, off: number): void => {
    const r = document.createRange()
    r.setStart(node, Math.max(0, Math.min((node.nodeValue ?? '').length, off)))
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  }
  let last: FlatSeg | null = null
  for (const seg of segs) {
    if (offset >= seg.start && offset <= seg.start + seg.len) {
      place(seg.node, offset - seg.start)
      return
    }
    last = seg
  }
  if (last) place(last.node, last.len)
  else {
    const r = document.createRange()
    r.selectNodeContents(root)
    r.collapse(false)
    sel.removeAllRanges()
    sel.addRange(r)
  }
}

function normalizeTop(root: HTMLElement): void {
  const pending: Node[] = []
  const flush = (): void => {
    if (!pending.length) return
    if (pending.every((n) => n.nodeType === Node.TEXT_NODE && !(n.nodeValue ?? '').trim())) {
      pending.forEach((n) => n.parentNode?.removeChild(n))
      pending.length = 0
      return
    }
    const anchor = pending[0]
    const p = document.createElement('p')
    root.insertBefore(p, anchor)
    for (const n of pending) p.appendChild(n)
    pending.length = 0
  }
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) pending.push(child)
    else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = (child as HTMLElement).tagName
      if (tag === 'BR' || tag === 'IMG') pending.push(child)
      else flush()
    }
  }
  flush()
  if (!root.childNodes.length) {
    const p = document.createElement('p')
    p.innerHTML = '<br>'
    root.appendChild(p)
  }
}

export default function MdEditor({
  value,
  onChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  pickImage
}: MdEditorProps): React.JSX.Element {
  const editableRef = useRef<HTMLDivElement | null>(null)
  const lastMdRef = useRef(value)
  const [focused, setFocused] = useState(false)
  // 插入表格：等待用户选择行/列
  const [tableDlg, setTableDlg] = useState<{ rows: number; cols: number } | null>(null)
  // 当前荧光笔颜色：选中后保持（再次高亮/⌘⇧H 都使用它），共 5 色可选
  const [activeHl, setActiveHl] = useState<string>('hl-yellow')
  // 粘性行内格式（B/I/U）：按钮凹下 = 之后输入自带该效果
  const [fmt, setFmt] = useState<{ b: boolean; i: boolean; u: boolean }>({ b: false, i: false, u: false })
  // 撤销/重做前记录：变更前文本 + 光标在文本流中的偏移（扁平“视觉行”文本）
  const caretRestoreRef = useRef<{ textA: string; offsetA: number } | null>(null)
  const pendingRestoreRef = useRef(false)

  /** 当前光标在扁平文本流中的全局偏移（无光标/不在编辑区时为 null） */
  const caretFlatOffset = (): number | null => {
    const el = editableRef.current
    const sel = window.getSelection()
    if (!el || !sel || !sel.rangeCount) return null
    const r = sel.getRangeAt(0)
    if (!el.contains(r.startContainer)) return null
    const pre = document.createRange()
    pre.selectNodeContents(el)
    pre.setEnd(r.startContainer, r.startOffset)
    return rangeFlatText(el, pre).length
  }

  // 外部 value 变化（切笔记 / 撤销 / 子窗同步）→ 重建 DOM
  useEffect(() => {
    const el = editableRef.current
    if (!el) return
    if (domToMd(el) === value) return
    el.innerHTML = value ? mdToHtml(value).html : ''
    lastMdRef.current = value
    // 撤销/重做导致的重建：按“变更区域相对光标在哪一侧”恢复位置（不再跳文首/跳错行）
    if (pendingRestoreRef.current && caretRestoreRef.current) {
      pendingRestoreRef.current = false
      const { textA, offsetA } = caretRestoreRef.current
      const textB = flattenEditor(el).text
      const target = caretOffsetAfterChange(textA, offsetA, textB)
      setCaretByFlatOffset(el, target)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const handleUndoRedo = (redo: boolean): void => {
    if (redo ? !canRedo : !canUndo) return
    const el = editableRef.current
    const offsetA = caretFlatOffset()
    if (offsetA !== null && el) {
      caretRestoreRef.current = { textA: flattenEditor(el).text, offsetA }
      pendingRestoreRef.current = true
    } else {
      // 光标不在编辑区（如点了工具栏）：不强制还原位置
      pendingRestoreRef.current = false
    }
    if (redo) onRedo?.()
    else onUndo?.()
  }

  const sync = useCallback((): void => {
    const el = editableRef.current
    if (!el) return
    normalizeTop(el)
    const md = domToMd(el)
    if (md !== lastMdRef.current) {
      lastMdRef.current = md
      onChange(md)
    }
  }, [onChange])

  const wrapSelection = (tag: string, cls?: string): void => {
    const el = editableRef.current
    if (!el) return
    el.focus()
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    const content = range.extractContents()
    const wrap = document.createElement(tag)
    if (cls) wrap.className = cls
    wrap.appendChild(content)
    range.insertNode(wrap)
    sel.removeAllRanges()
    const r = document.createRange()
    r.selectNodeContents(wrap)
    r.collapse(false)
    sel.addRange(r)
    sync()
  }

  const applyActiveHighlight = (): void => {
    wrapSelection('mark', activeHl)
  }
  const pickHighlight = (cls: string): void => {
    setActiveHl(cls)
    // 若当前有选中文字则立即用所选颜色高亮；无选中则只是“选定颜色”，保持待用
    wrapSelection('mark', cls)
  }

  const refreshFmt = (): void => {
    try {
      const el = editableRef.current
      const sel = window.getSelection()
      if (!el || !sel || !sel.anchorNode || !el.contains(sel.anchorNode)) return
      setFmt({
        b: !!document.queryCommandState('bold'),
        i: !!document.queryCommandState('italic'),
        u: !!document.queryCommandState('underline')
      })
    } catch {
      /* ignore */
    }
  }
  const toggleInline = (kind: 'b' | 'i' | 'u'): void => {
    const el = editableRef.current
    if (!el) return
    el.focus()
    const cmd = kind === 'b' ? 'bold' : kind === 'i' ? 'italic' : 'underline'
    try {
      document.execCommand(cmd, false)
    } catch {
      /* ignore */
    }
    refreshFmt()
  }
  /** 字号/字体：有选区套选区；无选区则应用到整段并让后续输入延续 */
  const applyInlineStyle = (css: string): void => {
    const el = editableRef.current
    if (!el || !css) return
    el.focus()
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const r = sel.getRangeAt(0)
      const frag = r.extractContents()
      const sp = document.createElement('span')
      sp.setAttribute('style', css)
      sp.appendChild(frag)
      r.insertNode(sp)
      const rr = document.createRange()
      rr.selectNodeContents(sp)
      rr.collapse(false)
      sel.removeAllRanges()
      sel.addRange(rr)
      sync()
      return
    }
    const block = sel ? topBlock(sel.anchorNode ?? null, el) : null
    if (!block || block.tagName !== 'P') return
    const sp = document.createElement('span')
    sp.setAttribute('style', css)
    const kids = Array.from(block.childNodes)
    for (const k of kids) {
      if (k.nodeType === Node.ELEMENT_NODE && (k as Element).tagName === 'BR' && kids.length === 1) continue
      sp.appendChild(k)
    }
    block.appendChild(sp)
    const rr = document.createRange()
    rr.selectNodeContents(sp)
    rr.collapse(false)
    sel?.removeAllRanges()
    sel?.addRange(rr)
    sync()
  }
  /** 段落对齐（左/中/右），仅普通段落 */
  const setBlockAlign = (v: string): void => {
    const el = editableRef.current
    if (!el) return
    el.focus()
    const sel = window.getSelection()
    const block = sel ? topBlock(sel.anchorNode ?? null, el) : null
    if (!block || block.tagName !== 'P') return
    ;(block as HTMLElement).style.textAlign = v
    sync()
  }

  // ── 表格尺寸调整 ──────────────────────────────────────────────
  // 拖动「内部分隔线」只改变紧邻的两列/两行（一边增、另一边等量减），其余列/行保持不动；
  // 外框（最左、最上，以及最右、最下）不可拖；未拖动时尺寸固定并随 Markdown 保存。
  const tblResizeRef = useRef<{
    table: HTMLTableElement
    mode: 'col' | 'row'
    left: number
    baseL: number
    right: number
    baseR: number
    startX: number
    startY: number
    values: number[] // 全部列宽(px) 或全部行高(px)
    rows: HTMLElement[]
    mins: number[]
    maxW: number
  } | null>(null)

  // 隐形边缘（整篇笔记统一的右边界）：编辑列可容纳宽度
  const noteMaxWidth = (): number => {
    const el = editableRef.current
    if (!el) return 720
    return Math.max(320, Math.round(el.clientWidth) - 64)
  }
  // 测量单元格“不可再压缩”的宽度：最长不可断词 + 内边距
  const cellMinWidth = (cell: Element): number => {
    const cs = getComputedStyle(cell)
    const font = `${cs.fontSize} ${cs.fontFamily}`
    const pad =
      (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + 2
    const words = (cell.textContent || '').split(/\s+/).filter(Boolean)
    if (!words.length) return Math.max(18, pad + 12)
    const cv = document.createElement('canvas')
    const ctx = cv.getContext('2d')
    if (!ctx) return 40
    ctx.font = font
    let m = 0
    for (const w of words) m = Math.max(m, ctx.measureText(w).width)
    return Math.max(18, m + pad)
  }
  const colMins = (table: HTMLTableElement, count: number): number[] => {
    const out = Array(count).fill(18)
    for (const tr of Array.from(table.rows)) {
      for (let c = 0; c < tr.cells.length && c < count; c++) {
        out[c] = Math.max(out[c], cellMinWidth(tr.cells[c]))
      }
    }
    return out
  }

  const readColWidths = (table: HTMLTableElement, count: number): number[] => {
    const cols = table.querySelectorAll(':scope > colgroup > col')
    if (cols.length === count) {
      return Array.from(cols).map((c) => {
        const m = (c.getAttribute('style') || '').match(/width:\s*(\d+(?:\.\d+)?)px/)
        return m ? parseFloat(m[1]) : 80
      })
    }
    const heads = table.rows[0]?.cells
    const widths: number[] = []
    if (heads && heads.length === count) {
      for (let i = 0; i < count; i++) widths.push(Math.max(30, heads[i].getBoundingClientRect().width || 80))
    } else {
      for (let i = 0; i < count; i++) widths.push(80)
    }
    let cg = table.querySelector(':scope > colgroup')
    if (!cg) {
      cg = document.createElement('colgroup')
      table.insertBefore(cg, table.firstChild)
    }
    cg.innerHTML = widths.map((w) => `<col style="width:${w}px">`).join('')
    return widths
  }
  const writeColWidths = (table: HTMLTableElement, widths: number[]): void => {
    let cg = table.querySelector(':scope > colgroup')
    if (!cg) {
      cg = document.createElement('colgroup')
      table.insertBefore(cg, table.firstChild)
    }
    Array.from(cg.children).forEach((c, i) => {
      if (i < widths.length) (c as HTMLElement).style.width = `${Math.max(24, widths[i])}px`
    })
    // 表格总宽随列宽变化（内部分隔只平移；拖最右缘则总宽加大）
    const sum = widths.reduce((a, b) => a + b, 0)
    if (sum > 0) table.style.width = `${Math.round(sum)}px`
  }

  const allTableRows = (table: HTMLTableElement): HTMLElement[] => {
    const out: HTMLElement[] = []
    const th = table.querySelector(':scope > thead tr')
    const tb = table.querySelector(':scope > tbody')
    if (th) out.push(th as HTMLElement)
    if (tb) for (const tr of Array.from(tb.children)) out.push(tr as HTMLElement)
    return out
  }
  const readRowHeights = (rows: HTMLElement[]): number[] =>
    rows.map((tr) => {
      const c = tr.querySelector(':scope > th, :scope > td') as HTMLElement | null
      return c ? Math.max(18, c.getBoundingClientRect().height) : 24
    })
  const writeRowHeights = (rows: HTMLElement[], heights: number[]): void => {
    rows.forEach((tr, i) => {
      const h = heights[i] ?? 0
      if (h <= 0) return
      for (const cellEl of Array.from((tr as HTMLTableRowElement).cells)) {
        ;(cellEl as HTMLElement).style.height = `${Math.round(Math.max(18, h))}px`
      }
    })
  }

  const tablePointerDown = (e: React.PointerEvent): void => {
    const el = editableRef.current
    if (!el) return
    const cell = (e.target as HTMLElement).closest('td,th') as HTMLTableCellElement | null
    const table = (e.target as HTMLElement).closest('table') as HTMLTableElement | null
    if (!cell || !table || e.button !== 0) return
    const r = cell.getBoundingClientRect()
    const count = table.rows[0]?.cells.length ?? 1
    const cIdx = cell.cellIndex
    const rows = allTableRows(table)
    const rIdx = rows.indexOf(cell.closest('tr') as HTMLElement)
    const nearRight = e.clientX >= r.right - 6 && e.clientX <= r.right + 6
    const nearBottom = e.clientY >= r.bottom - 6 && e.clientY <= r.bottom + 6
    // 内部分隔线（列 c 与 c+1 / 行 r 与 r+1）以及最右列、最后一行都可拖；
    // 只有表格外框的左缘、上缘不可拖。
    const colMode = nearRight && cIdx >= 0 && cIdx <= count - 1
    const rowMode = nearBottom && rIdx >= 0 && rIdx <= rows.length - 1
    if (!colMode && !rowMode) return
    e.preventDefault()
    if (colMode) {
      const widths = readColWidths(table, count)
      const isLast = cIdx >= count - 1
      tblResizeRef.current = {
        table,
        mode: 'col',
        left: cIdx,
        baseL: widths[cIdx],
        right: isLast ? cIdx : cIdx + 1,
        baseR: isLast ? widths[cIdx] : widths[cIdx + 1],
        startX: e.clientX,
        startY: e.clientY,
        values: widths,
        rows,
        mins: colMins(table, count),
        maxW: noteMaxWidth()
      }
    } else {
      const heights = readRowHeights(rows)
      const isLast = rIdx >= rows.length - 1
      tblResizeRef.current = {
        table,
        mode: 'row',
        left: rIdx,
        baseL: heights[rIdx],
        right: isLast ? rIdx : rIdx + 1,
        baseR: isLast ? heights[rIdx] : heights[rIdx + 1],
        startX: e.clientX,
        startY: e.clientY,
        values: heights,
        rows,
        mins: [],
        maxW: noteMaxWidth()
      }
    }
    el.focus()
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    document.body.classList.add(colMode ? 'cursor-col-resize' : 'cursor-row-resize')
  }
  const tablePointerMove = (e: React.PointerEvent): void => {
    const el = editableRef.current
    const rs = tblResizeRef.current
    if (!el || !rs) return
    if (rs.mode === 'col') {
      const sum0 = rs.values.reduce((a, b) => a + b, 0)
      let newL = Math.max(30, rs.baseL + (e.clientX - rs.startX))
      const delta = newL - rs.baseL
      const next = [...rs.values]
      if (rs.right === rs.left) {
        // 最右缘：只加宽最后一列，且整表不越过“隐形边缘”
        const maxL = rs.maxW - (sum0 - rs.baseL)
        newL = Math.min(newL, maxL)
        next[rs.left] = Math.max(30, newL)
      } else {
        const minR = rs.mins[rs.right] ?? 30
        const maxShrink = rs.baseR - minR
        const effDelta = Math.min(delta, maxShrink)
        next[rs.left] = Math.max(30, rs.baseL + effDelta)
        next[rs.right] = rs.baseR - effDelta
      }
      writeColWidths(rs.table, next)
    } else {
      const newT = Math.max(18, rs.baseL + (e.clientY - rs.startY))
      const delta = newT - rs.baseL
      const next = [...rs.values]
      if (rs.right === rs.left) {
        // 下缘：只加高最后一行（整表随之加高）
        next[rs.left] = newT
      } else {
        next[rs.left] = newT
        next[rs.right] = Math.max(18, rs.baseR - delta)
      }
      writeRowHeights(rs.rows, next)
    }
  }
  const tablePointerUp = (): void => {
    if (!tblResizeRef.current) return
    tblResizeRef.current = null
    document.body.classList.remove('cursor-col-resize', 'cursor-row-resize')
    sync()
  }
  const tableHoverCursor = (e: React.PointerEvent): void => {
    const el = editableRef.current
    if (!el || tblResizeRef.current) return
    if (e.buttons !== 0) return
    const cell = (e.target as HTMLElement).closest('td,th') as HTMLTableCellElement | null
    if (!cell) {
      el.style.cursor = ''
      return
    }
    const table = cell.closest('table') as HTMLTableElement | null
    if (!table) {
      el.style.cursor = ''
      return
    }
    const rows = allTableRows(table)
    const rIdx = rows.indexOf(cell.closest('tr') as HTMLElement)
    const r = cell.getBoundingClientRect()
    const innerCol = e.clientX >= r.right - 6 && e.clientX <= r.right + 6 && cell.cellIndex >= 0
    const innerRow = e.clientY >= r.bottom - 6 && e.clientY <= r.bottom + 6 && rIdx >= 0
    el.style.cursor = innerCol ? 'col-resize' : innerRow ? 'row-resize' : ''
  }

  const setHeading = (level: 1 | 2 | 3): void => {
    const el = editableRef.current
    if (!el) return
    el.focus()
    const sel = window.getSelection()
    const block = topBlock(sel?.anchorNode ?? null, el)
    if (!block) return
    const want = `H${level}`

    // 列表项上点标题：把该项移出列表变成标题
    if (block.tagName === 'LI') {
      const parentList = block.parentElement
      const h = document.createElement(want)
      const clone = block.cloneNode(true) as HTMLElement
      clone.querySelectorAll('[data-taskbox],ul,ol').forEach((n) => n.remove())
      while (clone.firstChild) h.appendChild(clone.firstChild)
      if (parentList) parentList.insertAdjacentElement('afterend', h)
      block.remove()
      if (parentList && parentList.children.length === 0) parentList.remove()
      placeCaret(h)
      sync()
      return
    }

    if (block.tagName === want) {
      // 再按一次回到正文
      const p = document.createElement('p')
      while (block.firstChild) p.appendChild(block.firstChild)
      block.replaceWith(p)
      placeCaret(p)
    } else {
      const h = document.createElement(want)
      while (block.firstChild) h.appendChild(block.firstChild)
      block.replaceWith(h)
      placeCaret(h)
    }
    sync()
  }

  const makeTaskLi = (done: boolean): HTMLLIElement => {
    const li = document.createElement('li')
    li.setAttribute('data-task', done ? 'x' : ' ')
    li.innerHTML =
      '<span data-taskbox class="mt-0.5 inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded border text-[10px] border-edge"></span>' +
      '<span></span>'
    return li
  }

  const toggleTask = (): void => {
    const el = editableRef.current
    if (!el) return
    el.focus()
    const sel = window.getSelection()
    const block = topBlock(sel?.anchorNode ?? null, el)
    if (!block) return

    const focusText = (li: HTMLLIElement): void => {
      const span = li.querySelector('span:last-child')
      if (span) placeCaret(span)
    }

    if (block.tagName === 'LI' && block.hasAttribute('data-task')) {
      // 任务项 → 还原为普通列表项
      const box = block.querySelector('[data-taskbox]')
      box?.remove()
      const li = block as HTMLLIElement
      li.removeAttribute('data-task')
      li.className = ''
      // 展开文本 span 直接进 li
      const inner = li.querySelector('span')
      while (inner && inner.firstChild) li.insertBefore(inner.firstChild, inner)
      inner?.remove()
      const parent = li.parentElement
      if (parent && li.textContent?.trim() === '' && parent.querySelectorAll(':scope > li').length > 1) li.remove()
      sync()
      return
    }
    if (block.tagName === 'LI') {
      // 普通列表项 → 任务项
      const li = makeTaskLi(false)
      const textSpan = li.querySelector('span:last-child') as HTMLSpanElement
      while (block.firstChild) textSpan.appendChild(block.firstChild)
      block.replaceWith(li)
      focusText(li)
      sync()
      return
    }
    if (block.tagName === 'P') {
      const li = makeTaskLi(false)
      const textSpan = li.querySelector('span:last-child') as HTMLSpanElement
      while (block.firstChild) textSpan.appendChild(block.firstChild)
      const prev = block.previousElementSibling
      if (prev && prev.tagName === 'UL' && !prev.querySelector('[data-taskbox]')) {
        // 承接前面的任务列表
        prev.appendChild(li)
        block.remove()
      } else {
        const ul = document.createElement('ul')
        ul.className = 'my-1 space-y-1 pl-1.5'
        ul.appendChild(li)
        block.replaceWith(ul)
      }
      focusText(li)
      sync()
      return
    }
  }

  // 记录打开表格对话框时的光标块，避免弹窗期间光标漂移导致表格插错位置
  const tableAnchorRef = useRef<HTMLElement | null>(null)

  const insertTable = (rows: number, cols: number, anchorBlock?: HTMLElement | null): void => {
    const el = editableRef.current
    if (!el) return
    el.focus()
    const sel = window.getSelection()
    let block = anchorBlock && el.contains(anchorBlock) ? anchorBlock : topBlock(sel?.anchorNode ?? null, el)
    if (!block || block === el) block = null
    const r = Math.max(2, Math.min(20, Math.round(rows)))
    const c = Math.max(1, Math.min(20, Math.round(cols)))
    const cell = (tag: 'th' | 'td'): string =>
      `<${tag} class="border border-edge px-2 py-1${tag === 'th' ? ' text-left' : ''}"></${tag}>`
    const headerRow = `<tr>${Array(c).fill(cell('th')).join('')}</tr>`
    const bodyRows = Array(Math.max(1, r - 1))
      .fill(null)
      .map(() => `<tr>${Array(c).fill(cell('td')).join('')}</tr>`)
      .join('')
    const table = document.createElement('table')
    table.className = 'my-2 border-collapse text-[13px] wn-fixed'
    table.style.width = '100%'
    table.innerHTML = `<colgroup>${Array(c).fill('<col>').join('')}</colgroup><thead>${headerRow}</thead><tbody>${bodyRows}</tbody>`
    if (block) block.insertAdjacentElement('afterend', table)
    else el.appendChild(table)
    const p = document.createElement('p')
    p.innerHTML = '<br>'
    table.insertAdjacentElement('afterend', p)
    // 新表至少保证有一行高度的可视区
    for (const rowEl of Array.from(table.querySelectorAll('tbody tr'))) {
      for (const cellEl of Array.from((rowEl as HTMLTableRowElement).cells)) {
        ;(cellEl as HTMLElement).style.height = '34px'
      }
    }
    const first = table.querySelector('tbody td')
    if (first) placeCaret(first)
    sync()
  }

  const openTableDialog = (): void => {
    const el = editableRef.current
    const sel = window.getSelection()
    tableAnchorRef.current = sel && el ? topBlock(sel.anchorNode ?? null, el) : null
    setTableDlg({ rows: 3, cols: 3 })
  }
  const confirmTable = (): void => {
    if (!tableDlg) return
    const { rows, cols } = tableDlg
    setTableDlg(null)
    const anchor = tableAnchorRef.current
    tableAnchorRef.current = null
    insertTable(rows, cols, anchor)
  }

  const insertImage = async (): Promise<void> => {
    if (!pickImage) return
    const img = await pickImage()
    if (!img) return
    const el = editableRef.current
    if (!el) return
    el.focus()
    const node = document.createElement('img')
    node.className = 'my-2 max-w-full rounded-lg'
    node.alt = img.name
    node.src = img.dataUrl
    const sel = window.getSelection()
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      sel.deleteFromDocument()
    }
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : document.createRange()
    range.collapse(true)
    const block = topBlock(range.startContainer, el)
    if (block && block !== el) {
      // 在当前块末尾插入
      range.setStart(block, block.childNodes.length)
      range.collapse(true)
    }
    range.insertNode(node)
    const after = document.createTextNode('\u00a0')
    range.setStartAfter(node)
    range.insertNode(after)
    range.setStartAfter(after)
    sel?.removeAllRanges()
    sel?.addRange(range)
    sync()
  }

  // 该 li 所属的整棵列表（顶层 UL/OL）
  const topListOf = (node: HTMLElement): HTMLElement | null => {
    const el = editableRef.current
    if (!el) return null
    let top: HTMLElement | null = node
    while (top && top.parentElement && top.parentElement !== el) {
      const ptag = top.parentElement.tagName
      if (ptag !== 'UL' && ptag !== 'OL' && ptag !== 'LI') break
      top = top.parentElement
    }
    return top && (top.tagName === 'UL' || top.tagName === 'OL') ? top : null
  }

  /** 把当前列表项所在的列表在 - 与 1. 之间互转；已是目标类型则不动作 */
  const convertListKind = (li: HTMLElement, kind: 'ul' | 'ol'): boolean => {
    const el = editableRef.current
    if (!el) return false
    const cur = topListOf(li)
    if (!cur) return false
    if (cur.tagName.toLowerCase() === kind) return false
    const nw = document.createElement(kind === 'ul' ? 'ul' : 'ol')
    nw.className =
      kind === 'ul' ? 'my-1 space-y-1 pl-5 list-disc' : 'my-1 space-y-1 pl-5 list-decimal'
    while (cur.firstChild) nw.appendChild(cur.firstChild)
    cur.replaceWith(nw)
    sync()
    return true
  }

  const toggleList = (cmd: 'insertUnorderedList' | 'insertOrderedList'): void => {
    const el = editableRef.current
    if (!el) return
    el.focus()
    const sel = window.getSelection()
    const block = sel ? topBlock(sel.anchorNode ?? null, el) : null
    const li = block && block.tagName === 'LI' ? (block as HTMLElement) : caretLi()
    const kind = cmd === 'insertUnorderedList' ? 'ul' : 'ol'
    if (li && convertListKind(li, kind)) return
    // 段落等：沿用浏览器原生转换（新建 - / 1.）
    document.execCommand(cmd, false)
    sync()
  }
  const toggleQuote = (): void => {
    const el = editableRef.current
    if (!el) return
    el.focus()
    document.execCommand('formatBlock', false, 'blockquote')
    sync()
  }
  const insertHr = (): void => {
    const el = editableRef.current
    if (!el) return
    el.focus()
    document.execCommand('insertHorizontalRule', false)
    sync()
  }

  // ── 行首标记自动转换：在段首输入 "- " / "1. " / "- [ ] " / "# " 变成对应元素 ──
  const adoptList = (p: HTMLElement, kind: 'ul' | 'ol', li: HTMLLIElement): void => {
    const list = document.createElement(kind === 'ul' ? 'ul' : 'ol')
    list.className = kind === 'ul' ? 'my-1 space-y-1 pl-5 list-disc' : 'my-1 space-y-1 pl-5 list-decimal'
    // 保留该行已有的缩进深度
    const lvl = Number(p.getAttribute('data-indent') ?? '0') || 0
    list.appendChild(li)
    p.replaceWith(list)
    if (lvl > 0) {
      li.setAttribute('data-indent', String(lvl))
      li.style.marginLeft = `${lvl * 14}px`
    }
    placeCaret(li)
  }
  const convertMarkers = (): void => {
    const el = editableRef.current
    const sel = window.getSelection()
    if (!el || !sel || !sel.rangeCount) return
    const node = sel.anchorNode
    if (!node || node.nodeType !== Node.TEXT_NODE) return
    // 光标所在顶层块
    let block = node.parentElement
    while (block && block.parentNode && block.parentNode !== el) block = block.parentNode as HTMLElement
    if (!block || block.tagName !== 'P') return
    const txt = block.textContent ?? ''
    const task = txt.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/)
    if (task) {
      const li = makeTaskLi(task[1].toLowerCase() === 'x')
      const span = li.querySelector('span:last-child') as HTMLElement
      span.textContent = task[2]
      adoptList(block, 'ul', li)
      placeCaret(span)
      return
    }
    const bullet = txt.match(/^[-*+]\s+(.*)$/)
    if (bullet) {
      const li = document.createElement('li')
      li.textContent = bullet[1]
      adoptList(block, 'ul', li)
      return
    }
    const ord = txt.match(/^(\d{1,3})[.)]\s+(.*)$/)
    if (ord) {
      const li = document.createElement('li')
      li.textContent = ord[2]
      adoptList(block, 'ol', li)
      return
    }
    const hd = txt.match(/^(#{1,6})\s+(.*)$/)
    if (hd && hd[2].trim().length > 0) {
      const h = document.createElement('H' + Math.min(hd[1].length, 6))
      h.textContent = hd[2]
      block.replaceWith(h)
      placeCaret(h)
    }
  }

  // ── Tab：列表项缩进嵌套；段落/标题等通用缩进（Shift+Tab 反向）──
  // 统一缩进工具：行（词/标题/列表项）都可以有“深度”
  const applyIndent = (block: HTMLElement, lvl: number): void => {
    if (lvl <= 0) {
      block.removeAttribute('data-indent')
      block.style.marginLeft = ''
    } else {
      block.setAttribute('data-indent', String(lvl))
      block.style.marginLeft = `${lvl * 14}px`
    }
  }
  const caretLi = (): HTMLElement | null => {
    const el = editableRef.current
    if (!el) return null
    const sel = window.getSelection()
    const blk = topBlock(sel?.anchorNode ?? null, el)
    if (blk && blk.tagName === 'LI') return blk
    if (sel) {
      const ae = (sel.anchorNode?.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode?.parentElement) as Element | null
      if (ae && ae !== el && el.contains(ae)) {
        const c = ae.closest('li')
        if (c) return c as HTMLElement
      }
    }
    return null
  }

  const handleTabKey = (shift: boolean): void => {
    const el = editableRef.current
    if (!el) return
    el.focus()
    const sel = window.getSelection()
    const block = topBlock(sel?.anchorNode ?? null, el)
    const li = caretLi()
    // 目标：光标所在行 = 列表项，或段落 / 标题
    const target: HTMLElement | null = li || (block && (block.tagName === 'P' || /^H[1-6]$/.test(block.tagName)) ? block : null)
    if (!target) return
    let lvl = Number(target.getAttribute('data-indent') ?? '0') || 0
    lvl = shift ? Math.max(0, lvl - 1) : lvl + 1
    applyIndent(target, lvl)
    sync()
  }

  // 光标是否位于所在行（块）的最开头
  const caretAtLineStart = (block: HTMLElement): boolean => {
    const sel = window.getSelection()
    if (!sel || !sel.anchorNode || !block.contains(sel.anchorNode)) return false
    if (sel.anchorNode === block) {
      // 元素边界处的光标（点击在行首常以 block,offset=0 表示）
      return sel.anchorOffset === 0
    }
    const range = document.createRange()
    range.setStart(block, 0)
    range.setEnd(sel.anchorNode, sel.anchorOffset)
    const before = range.toString()
    return before.trim() === ''
  }

  // Backspace（macOS delete）在行首：先去 header，再去缩进；不合并行
  const handleLineStartBackspace = (): boolean => {
    const el = editableRef.current
    if (!el) return false
    const sel = window.getSelection()
    if (!sel || !sel.isCollapsed) return false
    const li = caretLi()
    const block = li || topBlock(sel.anchorNode ?? null, el)
    if (!block || (block.tagName !== 'LI' && block.tagName !== 'P' && !/^H[1-6]$/.test(block.tagName))) return false
    if (!caretAtLineStart(block)) return false

    // 1) 标题行行首退格：去掉标题 → 原处变普通段落（不并入上/下行，缩进保留）
    if (!li && /^H[1-6]$/.test(block.tagName)) {
      const lvl = Number(block.getAttribute('data-indent') ?? '0') || 0
      const p = document.createElement('p')
      if (lvl > 0) {
        p.setAttribute('data-indent', String(lvl))
        p.style.marginLeft = `${lvl * 14}px`
      }
      while (block.firstChild) p.appendChild(block.firstChild)
      if (!p.childNodes.length) p.appendChild(document.createElement('br'))
      block.replaceWith(p)
      placeCaret(p, true)
      sync()
      return true
    }

    if (li) {
      // 2) 去掉列表标记（列表项 → 普通段落，行不动），缩进保留
      const ancestors: HTMLElement[] = []
      let cur: HTMLElement | null = li
      while (cur && cur !== el) {
        ancestors.push(cur)
        cur = cur.parentElement
      }
      // 记录这串列表原本在正文里的位置：若整串被删空，段落要落回原位而不是文档末尾
      const top = ancestors[ancestors.length - 1] as HTMLElement | undefined
      const topParent = (top?.parentElement ?? el) as HTMLElement
      const topNext = top ? (top.nextSibling as Node | null) : null

      const lvl = Number(li.getAttribute('data-indent') ?? '0') || 0
      // 先把 li 下挂的直接子列表（如嵌套子项）摘出来，转段后接回段落后，避免整棵被删/挪到文档末尾
      const subLists = Array.from(li.children).filter(
        (c): c is HTMLElement => c.tagName === 'UL' || c.tagName === 'OL'
      )
      for (const s of subLists) s.remove()
      const clone = li.cloneNode(true) as HTMLElement
      clone.removeAttribute('data-task')
      clone.querySelectorAll('[data-taskbox],ul,ol').forEach((n) => n.remove())
      const p = document.createElement('p')
      while (clone.firstChild) p.appendChild(clone.firstChild)
      if (lvl > 0) {
        p.setAttribute('data-indent', String(lvl))
        p.style.marginLeft = `${lvl * 14}px`
      }

      // 若该项的直接父级是列表，则在原地拆分列表：前段保留、该项变段落、后段续为列表
      const directList = li.parentElement
      if (directList && (directList.tagName === 'UL' || directList.tagName === 'OL')) {
        const items = Array.from(directList.children).filter((c) => c.tagName === 'LI')
        const idx = items.indexOf(li)
        const after = items.slice(idx + 1)
        li.remove()
        let cont: HTMLElement | null = null
        if (after.length) {
          cont = directList.cloneNode(false) as HTMLElement
          for (const s of after) cont.appendChild(s)
          directList.insertAdjacentElement('afterend', cont)
        }
        if (directList.children.length === 0) {
          // li 是唯一项：用段落替换空列表（位置不变），续接列表跟在段落后
          directList.insertAdjacentElement('afterend', p)
          directList.remove()
        } else {
          // 前段仍在列表里：段落插在列表与续接列表之间（即被删项的原位）
          directList.insertAdjacentElement('afterend', p)
        }
        // 顺序：段落 → 原 li 的子列表 → 续接列表（保证内容不挪位、不丢子项）
        let cursor: HTMLElement = p
        for (const s of subLists) {
          if (!s.isConnected) cursor.insertAdjacentElement('afterend', s)
          cursor = s
        }
        if (cont && cont.isConnected && cursor.nextSibling !== cont) {
          cursor.insertAdjacentElement('afterend', cont)
        }
      } else {
        // 无直接列表父级（罕见兜底）：沿用旧的删空+回插逻辑
        li.remove()
        for (const a of ancestors.slice(1)) {
          if ((a.tagName === 'LI' || a.tagName === 'UL' || a.tagName === 'OL') && a.children.length === 0) a.remove()
          else break
        }
        const anchor = ancestors.find((a) => a.isConnected)
        if (anchor) anchor.insertAdjacentElement('afterend', p)
        else if (topNext && topNext.isConnected && topNext.parentNode === topParent) topParent.insertBefore(p, topNext)
        else topParent.appendChild(p)
        // 兜底同样把子列表接回段落后
        let cursor: HTMLElement = p
        for (const s of subLists) {
          if (!s.isConnected) cursor.insertAdjacentElement('afterend', s)
          cursor = s
        }
      }
      placeCaret(p, true)
      sync()
      return true
    }

    // 3) 普通段落/无列表无标题：只剩缩进 → 一次去掉全部缩进
    const lvl = Number(block.getAttribute('data-indent') ?? '0') || 0
    if (lvl <= 0) return false
    applyIndent(block, 0)
    placeCaret(block, true)
    sync()
    return true
  }

  // ── Enter：空列表项退出列表；非空列表项由浏览器原生续行并继承缩进 ──
  // 标题内回车：把标题从光标处拆开，光标后半段变为普通段落（避免浏览器插 <div>）
  const handleEnterInHeading = (h: HTMLElement): void => {
    const el = editableRef.current
    if (!el) return
    const sel = window.getSelection()
    if (!sel || !sel.isCollapsed || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    const before = document.createRange()
    before.setStart(h, 0)
    before.setEnd(range.startContainer, range.startOffset)
    const tail = document.createRange()
    tail.setStart(range.startContainer, range.startOffset)
    tail.setEnd(h, h.childNodes.length)
    const beforeEmpty = !(before.toString() ?? '').trim()
    if (beforeEmpty) {
      // 光标在标题最前：在标题上方插一个空段落，标题内容保持不动（不抽取）
      const p = document.createElement('p')
      p.appendChild(document.createElement('br'))
      h.insertAdjacentElement('beforebegin', p)
      placeCaret(p)
      sync()
      return
    }
    // 中/后部：光标后半段移入新段落，标题保留前半
    const frag = tail.extractContents()
    // extractContents 可能在末尾留下空文本节点：清掉，避免“看似有内容”而不补 <br>
    frag.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE && !(n.nodeValue ?? '').trim()) n.parentNode?.removeChild(n)
    })
    const p = document.createElement('p')
    if (frag.childNodes.length) p.appendChild(frag)
    if (!p.childNodes.length) p.appendChild(document.createElement('br'))
    h.insertAdjacentElement('afterend', p)
    placeCaret(p, true)
    sync()
  }

  // Shift+Enter 于列表项：光标处把列表切开 —— 前半列表保留、光标后半段成为
  // 中间的无格式普通行、该项之后的所有项续成一条「新列表」（编号/符号重新开始）
  const handleShiftEnterExitList = (li: HTMLElement): void => {
    const el = editableRef.current
    if (!el) return
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    if (!li.contains(range.startContainer)) return
    // 该 li 自身的内联文本段（跳过其下的嵌套列表）
    const segs: Text[] = []
    const walk = (node: Node): void => {
      for (const ch of Array.from(node.childNodes)) {
        if (ch.nodeType === Node.TEXT_NODE) {
          if ((ch.nodeValue ?? '').length) segs.push(ch as Text)
        } else if (ch.nodeType === Node.ELEMENT_NODE) {
          const tag = (ch as Element).tagName
          if (tag === 'UL' || tag === 'OL') continue
          walk(ch)
        }
      }
    }
    walk(li)
    let cursorText: Text | null = null
    for (const t of segs) {
      if (range.startContainer === t) {
        cursorText = t
        break
      }
    }
    if (!cursorText) return
    const curIdx = segs.indexOf(cursorText)
    const splitOff = range.startOffset
    const tailParts: string[] = []
    const curLen = cursorText.nodeValue?.length ?? 0
    if (splitOff < curLen) tailParts.push((cursorText.nodeValue ?? '').slice(splitOff))
    const toRemove: Text[] = []
    if (splitOff < curLen) {
      cursorText.nodeValue = (cursorText.nodeValue ?? '').slice(0, splitOff)
    } else {
      toRemove.push(cursorText)
    }
    for (let i = curIdx + 1; i < segs.length; i++) {
      tailParts.push(segs[i].nodeValue ?? '')
      toRemove.push(segs[i])
    }
    for (const t of toRemove) t.remove()
    // 清掉因此变空的 b/i/u/span 等父级
    let changed = true
    while (changed) {
      changed = false
      for (const n of Array.from(li.querySelectorAll('b,i,em,strong,u,span,mark,a'))) {
        if (!(n.textContent ?? '').trim() && !n.querySelector('img') && n.childNodes.length === 0) {
          n.remove()
          changed = true
        }
      }
    }
    // 找该项所属整棵列表，并取出「当前项之后」的所有兄弟项 → 移到新列表
    const top = topListOf(li)
    if (top) {
      const siblings = Array.from(top.children).filter((c) => c.tagName === 'LI')
      const idx = siblings.indexOf(li)
      const afterItems = siblings.slice(idx + 1)
      let cont: HTMLElement | null = null
      if (afterItems.length) {
        cont = top.cloneNode(false) as HTMLElement
        for (const s of afterItems) cont.appendChild(s)
      }
      const p = document.createElement('p')
      p.textContent = tailParts.join('')
      if (!p.textContent) p.appendChild(document.createElement('br'))
      top.insertAdjacentElement('afterend', p)
      if (cont) p.insertAdjacentElement('afterend', cont)
      placeCaret(p)
      sync()
      return
    }
    // 兜底：直接在当前 li 后加普通行
    const p = document.createElement('p')
    p.textContent = tailParts.join('')
    if (!p.textContent) p.appendChild(document.createElement('br'))
    li.insertAdjacentElement('afterend', p)
    placeCaret(p)
    sync()
  }

  const handleEnterExit = (): boolean => {
    const el = editableRef.current
    if (!el) return false
    const sel = window.getSelection()
    const blk = topBlock(sel?.anchorNode ?? null, el)
    let li: HTMLElement | null = blk && blk.tagName === 'LI' ? blk : null
    if (!li && sel) {
      const ae = (sel.anchorNode?.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode?.parentElement) as Element | null
      if (ae && el.contains(ae)) {
        const c = ae.closest('li')
        if (c) li = c as HTMLElement
      }
    }
    if (!li) return false
    if ((li.textContent ?? '').trim() !== '') return false
    const ancestors: HTMLElement[] = []
    let cur: HTMLElement | null = li
    while (cur && cur !== el) {
      ancestors.push(cur)
      cur = cur.parentElement
    }
    // 记录这串列表原本在正文里的位置：若整串被删空，新段落要落回原位而不是文档末尾
    const top = ancestors[ancestors.length - 1] as HTMLElement | undefined
    const topParent = (top?.parentElement ?? el) as HTMLElement
    const topNext = top ? (top.nextSibling as Node | null) : null
    li.remove()
    for (const a of ancestors.slice(1)) {
      const tag = a.tagName
      if (tag === 'LI' || tag === 'UL' || tag === 'OL') {
        if (a.children.length === 0) a.remove()
        else break
      } else break
    }
    const focusLi = ancestors.find((a) => a.tagName === 'LI' && a.isConnected)
    if (focusLi) {
      placeCaret(focusLi)
      sync()
      return true
    }
    const p = document.createElement('p')
    p.innerHTML = '<br>'
    // 整串列表都删空了：把空段落放回列表原来的位置
    if (topNext && topNext.isConnected && topNext.parentNode === topParent) topParent.insertBefore(p, topNext)
    else topParent.appendChild(p)
    placeCaret(p)
    sync()
    return true
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const meta = e.metaKey || e.ctrlKey
    if (e.key === 'Tab' && !meta) {
      e.preventDefault()
      handleTabKey(e.shiftKey)
      return
    }
    if (e.key === 'Enter' && !meta) {
      if (e.shiftKey) {
        // Shift+Enter：在列表/标题里 → 拆出一个“完全无格式”的普通行
        const sel3 = window.getSelection()
        const shBlk = sel3 ? topBlock(sel3.anchorNode ?? null, editableRef.current!) : null
        if (shBlk && shBlk.tagName === 'LI') {
          e.preventDefault()
          handleShiftEnterExitList(shBlk as HTMLLIElement)
          return
        }
        if (shBlk && /^H[1-6]$/.test(shBlk.tagName)) {
          e.preventDefault()
          handleEnterInHeading(shBlk)
          return
        }
        // 普通段落：保留浏览器默认的软换行（<br>）
        return
      }
      if (handleEnterExit()) {
        // 已退出空列表项：阻止浏览器默认的“再插一行”
        e.preventDefault()
        return
      }
      // 标题内回车：手动拆成「标题 + 段落」，避免浏览器默认插入 <div>（会令后续 - / 1. 无法转列表）
      const sel2 = window.getSelection()
      const hblk = sel2 ? topBlock(sel2.anchorNode ?? null, editableRef.current!) : null
      if (hblk && /^H[1-6]$/.test(hblk.tagName)) {
        e.preventDefault()
        handleEnterInHeading(hblk)
        return
      }
      // 非空列表项：让浏览器原生续行（1. → 2. / - → -），再给新行继承缩进深度
      const li = caretLi()
      if (li && (li.textContent ?? '').trim() !== '') {
        const src = li
        setTimeout(() => {
          const next = src.nextElementSibling as HTMLElement | null
          if (next && next.tagName === 'LI' && !(next.textContent ?? '').trim()) {
            const lvl = Number(src.getAttribute('data-indent') ?? '0') || 0
            applyIndent(next, lvl)
          }
        }, 0)
      }
    }
    if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      if (handleLineStartBackspace()) {
        e.preventDefault()
        return
      }
    }
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      handleUndoRedo(e.shiftKey)
      return
    }
    if (meta && e.key.toLowerCase() === 'b') {
      e.preventDefault()
      toggleInline('b')
      return
    }
    if (meta && e.key.toLowerCase() === 'i') {
      e.preventDefault()
      toggleInline('i')
      return
    }
    if (meta && e.shiftKey && e.key.toLowerCase() === 'h') {
      e.preventDefault()
      applyActiveHighlight()
      return
    }
  }

  const onClick = (e: React.MouseEvent): void => {
    const t = e.target as HTMLElement
    const box = t.closest('[data-taskbox]')
    if (box) {
      e.preventDefault()
      const li = box.closest('li[data-task]')
      if (!li) return
      const done = li.getAttribute('data-task') === 'x'
      li.setAttribute('data-task', done ? ' ' : 'x')
      const textSpan = li.querySelector('span:last-child') as HTMLElement | null
      const boxSpan = li.querySelector('[data-taskbox]') as HTMLElement
      if (done) {
        boxSpan.innerHTML = ''
        boxSpan.className = 'mt-0.5 inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded border text-[10px] border-edge'
        textSpan?.classList.remove('line-through', 'opacity-60')
      } else {
        boxSpan.innerHTML = '✓'
        boxSpan.className = 'mt-0.5 inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded border text-[10px] bg-emerald-500/80 border-emerald-500/60 text-white'
        textSpan?.classList.add('line-through', 'opacity-60')
      }
      sync()
    }
  }

  const showPlaceholder = !value && !focused

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-1 border-b border-edge/60 px-3 py-1.5">
        <TBtn label="Undo" title="⌘Z" disabled={!canUndo} onClick={() => handleUndoRedo(false)} />
        <TBtn label="Redo" title="⌘⇧Z" disabled={!canRedo} onClick={() => handleUndoRedo(true)} />
        <TDiv />
        <TBtn label="H1" onClick={() => setHeading(1)} />
        <TBtn label="H2" onClick={() => setHeading(2)} />
        <TBtn label="H3" onClick={() => setHeading(3)} />
        <TDiv />
        <TBtn label="B" strong pressed={fmt.b} onClick={() => toggleInline('b')} title="Bold — ⌘B (click to keep typing bold)" />
        <TBtn label="I" italic pressed={fmt.i} onClick={() => toggleInline('i')} title="Italic — ⌘I (click to keep typing italic)" />
        <TBtn label="U" pressed={fmt.u} onClick={() => toggleInline('u')} title="Underline (click to keep typing underlined)" />
        <TDiv />
        <select
          className="inp !w-[118px] !py-1 text-xs"
          defaultValue=""
          title={t('ed.fontFamilyTip')}
          onChange={(e) => {
            if (e.target.value) applyInlineStyle(`font-family:${e.target.value}`)
          }}
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f.css || 'default'} value={f.css}>
              {f.key ? t(f.key) : f.label}
            </option>
          ))}
        </select>
        <select
          className="inp !w-[64px] !py-1 text-xs"
          defaultValue=""
          title={t('ed.fontSizeTip')}
          onChange={(e) => {
            if (e.target.value) applyInlineStyle(`font-size:${e.target.value}px`)
          }}
        >
          <option value="">{t('ed.fontSize')}</option>
          {FONT_SIZES.map((n) => (
            <option key={n} value={String(n)}>
              {n}
            </option>
          ))}
        </select>
        <TDiv />
        {[
          { v: 'left', t: 'Align left' },
          { v: 'center', t: 'Align center' },
          { v: 'right', t: 'Align right' }
        ].map((a) => (
          <button
            key={a.v}
            type="button"
            title={a.t}
            onClick={() => setBlockAlign(a.v)}
            className="inline-flex h-6 w-8 cursor-pointer items-center justify-center rounded-md bg-[var(--surface-2)] text-[10px] text-[var(--dim)] transition hover:brightness-110"
          >
            {a.v === 'center' ? 'C' : a.v === 'left' ? 'L' : 'R'}
          </button>
        ))}
        <TBtn label="`code`" mono onClick={() => wrapSelection('code', 'rounded bg-black/10 dark:bg-white/10 px-1 py-0.5 text-[12px]')} />
        <TDiv />
        <TBtn label="• List" onClick={() => toggleList('insertUnorderedList')} />
        <TBtn label="1. List" onClick={() => toggleList('insertOrderedList')} />
        <TBtn label="☑ Task" onClick={toggleTask} />
        <TBtn label="❝ Quote" onClick={toggleQuote} />
        <TBtn label="— HR" onClick={insertHr} />
        <TDiv />
        <TBtn label="⊞ Table" onClick={openTableDialog} title="Insert table" />
        {pickImage && <TBtn label="🖼 Image" onClick={() => void insertImage()} />}
        <TDiv />
        <div className="flex items-center gap-0.5 rounded-md bg-[var(--surface-2)] p-0.5" title="Highlight (⌘⇧H) — pick a colour, it stays active for the next highlights">
          {HL_COLORS.map((c) => (
            <button
              key={c.cls}
              type="button"
              title={`Highlight ${c.label}`}
              onClick={() => pickHighlight(c.cls)}
              className={`inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded transition ${
                activeHl === c.cls ? 'bg-black/5 ring-2 ring-[var(--accent)] dark:bg-white/10' : 'hover:brightness-110'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-[4px] ring-1 ring-black/15 ${activeHl === c.cls ? '' : ''}`}
                style={{ backgroundColor: c.swatch }}
              />
            </button>
          ))}
        </div>
      </div>

      {/* 编辑区（滚动容器内居中列） */}
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {showPlaceholder && (
          <div className="pointer-events-none absolute left-0 top-0 w-full select-none px-7 py-5 text-sm text-[color:var(--dim)]">
            Start typing — Markdown renders live (## headings, **bold**, - lists, ==highlight==).
          </div>
        )}
        <div
          ref={editableRef}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          className="mx-auto min-h-full max-w-3xl px-7 py-5 text-sm leading-relaxed outline-none"
          onInput={() => {
            convertMarkers()
            sync()
          }}
          onKeyDown={onKeyDown}
          onKeyUp={() => refreshFmt()}
          onClick={(e) => {
            onClick(e)
            refreshFmt()
          }}
          onPointerDown={tablePointerDown}
          onPointerMove={(e) => {
            tableHoverCursor(e)
            tablePointerMove(e)
          }}
          onPointerUp={tablePointerUp}
          onPointerCancel={tablePointerUp}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </div>

      {/* 插入表格：选择行/列数 */}
      {tableDlg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[2px]"
          onClick={() => setTableDlg(null)}
        >
          <div className="panel w-80 rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold">Insert table</h3>
            <p className="mt-0.5 text-[11px] text-dim">Choose rows (incl. header) and columns.</p>
            <div className="mt-4 space-y-3">
              <TableSizeRow
                label="Rows (incl. header)"
                value={tableDlg.rows}
                min={2}
                onChange={(v) => setTableDlg((d) => (d ? { ...d, rows: v } : d))}
              />
              <TableSizeRow
                label="Columns"
                value={tableDlg.cols}
                min={1}
                onChange={(v) => setTableDlg((d) => (d ? { ...d, cols: v } : d))}
              />
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button className="btn-ghost !px-4 !py-1.5 text-xs" onClick={() => setTableDlg(null)}>
                Cancel
              </button>
              <button className="btn-primary !px-4 !py-1.5 text-xs" onClick={confirmTable}>
                Insert
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TableSizeRow({
  label,
  value,
  min,
  onChange
}: {
  label: string
  value: number
  min: number
  onChange: (v: number) => void
}): React.JSX.Element {
  const step = (d: number): void => {
    onChange(Math.max(min, Math.min(20, value + d)))
  }
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-fg">{label}</span>
      <div className="flex items-center gap-1">
        <button className="btn-ghost !h-7 !w-7 !px-0 !py-0 text-sm" onClick={() => step(-1)} title="Decrease">
          −
        </button>
        <input
          className="inp !w-14 !px-1 text-center font-mono text-sm"
          type="number"
          min={min}
          max={20}
          value={value}
          onChange={(e) => onChange(Math.max(min, Math.min(20, Number(e.target.value) || min)))}
        />
        <button className="btn-ghost !h-7 !w-7 !px-0 !py-0 text-sm" onClick={() => step(1)} title="Increase">
          +
        </button>
      </div>
    </div>
  )
}

function TDiv(): React.JSX.Element {
  return <span className="mx-1 h-4 w-px bg-[var(--border)]" />
}

// 无自定义 title 时给每个按钮一个“全名 + 效果演示”的提示（按当前界面语言）
const BTN_HINT_KEY: Record<string, string> = {
  H1: 'ed.sampleH1',
  H2: 'ed.sampleH2',
  H3: 'ed.sampleH3',
  '`code`': 'ed.sampleCode',
  '☑ Task': 'ed.sampleTask',
  '❝ Quote': 'ed.sampleQuote',
  '— HR': 'ed.sampleHr',
  '⊞ Table': 'ed.sampleTable',
  '🖼 Image': 'app.insertImage'
}
const btnHint = (label: string): string => (BTN_HINT_KEY[label] ? t(BTN_HINT_KEY[label]) : label)

function TBtn({
  label,
  onClick,
  disabled,
  title,
  strong,
  italic,
  mono,
  hl,
  swatch,
  pressed
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
  title?: string
  strong?: boolean
  italic?: boolean
  mono?: boolean
  hl?: 'yellow' | 'green' | 'pink'
  /** 颜色方块（荧光笔）：替代图标，用小方块展示该颜色 */
  swatch?: string
  /** 粘性格式按下状态 */
  pressed?: boolean
}): React.JSX.Element {
  const hint = title ?? btnHint(label)
  const bg =
    hl === 'yellow'
      ? 'bg-[#fff3bf] text-black/80 dark:bg-[#f5c211]/90'
      : hl === 'green'
        ? 'bg-[#b9f6ca] text-black/70 dark:bg-[#34d399]/80'
        : hl === 'pink'
          ? 'bg-[#f8bbd0] text-black/70 dark:bg-[#f472b6]/80'
          : 'bg-[var(--surface-2)]'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition hover:brightness-110 disabled:opacity-35 ${bg} ${
        strong ? 'font-bold' : ''
      } ${italic ? 'italic' : ''} ${mono ? 'font-mono' : ''} ${
        pressed ? 'ring-2 ring-[var(--accent)] brightness-95' : ''
      }`}
    >
      {swatch && (
        <span
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px] ring-1 ring-black/15"
          style={{ backgroundColor: swatch }}
        />
      )}
      {label}
    </button>
  )
}
