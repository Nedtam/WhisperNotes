// 笔记本颜色：手动设置优先，没有就用统一的 fallback（与桌面 NotesNav 一致）
import type { Notebook } from './types'

export const NB_COLOR_FALLBACK = '#60a5fa'

export function notebookColor(list: Notebook[], id: string | null | undefined): string {
  if (!id) return ''
  const nb = list.find((x) => x.id === id)
  return nb?.color || NB_COLOR_FALLBACK
}
