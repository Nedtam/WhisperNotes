// 闪卡分类范围（电脑端与手机端共用同一份逻辑）
//  范围语义与笔记库一致：全部 / 未归档 / 笔记本（含子笔记本）/ 笔记本内多选笔记
//  卡片通过 noteId 关联笔记：所以笔记换笔记本后，卡片归属自动跟随，不会留下过期分类
import type { Notebook } from './types'

/** 只要求最小字段，桌面端 Card 与手机端精简卡片结构都能直接传进来 */
export interface CardLike {
  noteId?: string | null
}
export interface NoteLike {
  id: string
  title?: string
  notebookId?: string | null
}

export type CardScope =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'nb'; id: string; /** 选中的笔记 id（空集合 = 该笔记本全部笔记） */ notes: Set<string> }

export interface ScopeCounts {
  total: number
  due: number
  /** 该范围内还没有任何卡片的笔记数 */
  uncarded: number
}

/** 把卡片关联到它的笔记（笔记本以笔记为准，这样移动笔记后分类自动跟上） */
export function noteOfCard(card: CardLike, notes: NoteLike[]): NoteLike | undefined {
  return card.noteId ? notes.find((n) => n.id === card.noteId) : undefined
}

/** 笔记本子树 id（含自身） */
export function subtreeIds(notebooks: Notebook[], id: string): Set<string> {
  const ids = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const b of notebooks) {
      if (b.parentId && ids.has(b.parentId) && !ids.has(b.id)) {
        ids.add(b.id)
        grew = true
      }
    }
  }
  return ids
}

/** 范围 → 笔记集合（出卡范围、统计都用它） */
export function notesInScope(
  notes: NoteLike[],
  scope: CardScope,
  notebooks: Notebook[],
  cardCountOf: (noteId: string) => number
): Array<{ note: NoteLike; cards: number }> {
  const withCount = (n: NoteLike): { note: NoteLike; cards: number } => ({ note: n, cards: cardCountOf(n.id) })
  if (scope.kind === 'all') return notes.map(withCount)
  if (scope.kind === 'none') return notes.filter((n) => !n.notebookId).map(withCount)
  const ids = subtreeIds(notebooks, scope.id)
  const inNb = notes.filter((n) => n.notebookId && ids.has(n.notebookId))
  const picked = scope.notes.size > 0 ? inNb.filter((n) => scope.notes.has(n.id)) : inNb
  return picked.map(withCount)
}

export function inScope(card: CardLike, scope: CardScope, notes: NoteLike[], notebooks: Notebook[]): boolean {
  if (scope.kind === 'all') return true
  const note = noteOfCard(card, notes)
  if (scope.kind === 'none') return !note?.notebookId
  if (!note?.notebookId) return false
  if (!subtreeIds(notebooks, scope.id).has(note.notebookId)) return false
  if (scope.notes.size > 0 && !scope.notes.has(note.id)) return false
  return true
}

