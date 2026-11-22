// 闪卡范围侧栏：与笔记库同一套分类（全部 / 未归档 / 笔记本 / 子笔记本），
// 选中笔记本后可以在「这篇笔记本里的哪几篇笔记」上多选（例如 MGT2324 的 Week 2–4）
import React, { useMemo, useState } from 'react'
import type { Card, NoteRecord, Notebook } from '../../shared/types'
import { t } from './i18n'
import { inScope, notesInScope, noteOfCard, subtreeIds, type CardScope } from '@shared/cardScope'

export { inScope, notesInScope, noteOfCard, subtreeIds, type CardScope }

export interface ScopeCounts {
  total: number
  due: number
  /** 该范围内还没有任何卡片的笔记数 */
  uncarded: number
}


export default function FlashcardsNav({
  notebooks,
  notes,
  cards,
  scope,
  onScope
}: {
  notebooks: Notebook[]
  notes: NoteRecord[]
  cards: Card[]
  scope: CardScope
  onScope: (s: CardScope) => void
}): React.JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [showHidden, setShowHidden] = useState(false)

  const isDue = (c: Card): boolean => !c.suspended && (!c.dueAt || c.dueAt <= Date.now())

  const cardCountOf = (noteId: string): number => cards.filter((c) => c.noteId === noteId).length
  const countsFor = (fn: (c: Card) => boolean, uncarded: number): ScopeCounts => {
    const list = cards.filter(fn)
    return { total: list.length, due: list.filter(isDue).length, uncarded }
  }

  const all = countsFor(() => true, notes.filter((n) => cardCountOf(n.id) === 0).length)
  const unsorted = countsFor(
    (c) => !noteOfCard(c, notes)?.notebookId,
    notes.filter((n) => !n.notebookId && cardCountOf(n.id) === 0).length
  )

  /** 笔记本 → 它子树内所有笔记的卡片统计 */
  const nbCounts = useMemo(() => {
    const map = new Map<string, ScopeCounts>()
    for (const nb of notebooks) {
      const ids = subtreeIds(notebooks, nb.id)
      map.set(
        nb.id,
        countsFor(
          (c) => {
            const n = noteOfCard(c, notes)
            return !!n?.notebookId && ids.has(n.notebookId)
          },
          notes.filter((n) => !!n.notebookId && ids.has(n.notebookId) && cardCountOf(n.id) === 0).length
        )
      )
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebooks, notes, cards])

  /** 当前选中笔记本下的笔记（用于多选） */
  const scopedNotes = useMemo(() => {
    if (scope.kind !== 'nb') return []
    const ids = subtreeIds(notebooks, scope.id)
    return notes
      .filter((n) => n.notebookId && ids.has(n.notebookId))
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title, 'zh'))
  }, [scope, notebooks, notes])

  const children = (parentId: string | null): Notebook[] =>
    notebooks
      .filter((n) => (n.parentId ?? null) === parentId && (showHidden || !n.hidden))
      .slice()
      .sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0) || a.name.localeCompare(b.name, 'zh'))

  const row = (
    key: string,
    label: string,
    depth: number,
    active: boolean,
    c: ScopeCounts,
    onClick: () => void
  ): React.JSX.Element => (
    <button
      key={key}
      onClick={onClick}
      style={{ paddingLeft: 8 + depth * 10 }}
      className={`mb-0.5 flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-xs transition ${
        active ? 'bg-accent/15 text-accent' : 'text-fg hover:bg-surface-2'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="flex shrink-0 items-center gap-1 font-mono text-[10px]">
        {c.uncarded > 0 && (
          <span className="rounded bg-[var(--warn)]/15 px-1 text-[var(--warn)]" title={t('cards.scope.uncardedHint')}>
            {c.uncarded}
            <span className="ml-0.5 font-sans">{t('cards.scope.uncardedShort')}</span>
          </span>
        )}
        <span className={c.due > 0 ? 'text-accent' : 'text-dim'}>
          {c.due > 0 ? `${c.due}/` : ''}
          {c.total}
        </span>
      </span>
    </button>
  )

  const renderTree = (parentId: string | null, depth: number): React.JSX.Element[] =>
    children(parentId).map((nb) => {
      const kids = children(nb.id)
      const isOpen = open[nb.id] !== false // 默认展开
      const active = scope.kind === 'nb' && subtreeIds(notebooks, scope.id).has(nb.id) && scope.id === nb.id
      const c = nbCounts.get(nb.id) ?? { total: 0, due: 0, uncarded: 0 }
      return (
        <div key={nb.id}>
          <div className="flex items-center">
            {kids.length > 0 ? (
              <button
                className="shrink-0 px-1 text-[10px] text-dim"
                onClick={() => setOpen({ ...open, [nb.id]: !isOpen })}
                style={{ marginLeft: depth * 10 }}
              >
                {isOpen ? '▾' : '▸'}
              </button>
            ) : (
              <span style={{ marginLeft: depth * 10, width: 14 }} className="shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              {row(
                nb.id,
                `${nb.color ? '' : ''}${nb.name}`,
                kids.length > 0 ? 0 : 1,
                active,
                c,
                () => onScope({ kind: 'nb', id: nb.id, notes: new Set() })
              )}
            </div>
          </div>
          {isOpen && renderTree(nb.id, depth + 1)}
        </div>
      )
    })

  return (
    <div data-fc-nav className="flex h-full w-52 shrink-0 flex-col border-r border-edge/60 px-2 py-3">
      <div className="mb-1 flex items-center justify-between px-2">
        <span className="text-[11px] font-semibold text-dim">{t('cards.scope.title')}</span>
        <button className="text-[10px] text-dim underline" onClick={() => setShowHidden((v) => !v)} title={t('cards.scope.toggleHidden')}>
          {showHidden ? '👁' : '👁‍🗨'}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {row('all', t('notes.all'), 0, scope.kind === 'all', all, () => onScope({ kind: 'all' }))}
        {row('none', t('notes.unsorted'), 0, scope.kind === 'none', unsorted, () => onScope({ kind: 'none' }))}
        <div className="my-1.5 border-t border-edge/50" />
        {renderTree(null, 0)}
      </div>

      {scope.kind === 'nb' && scopedNotes.length > 0 && (
        <div className="mt-2 shrink-0 rounded-xl bg-surface-2/60 p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-semibold text-dim">{t('cards.scope.notes')}</span>
            <span className="flex gap-1.5 text-[10px]">
              <button
                className="text-accent underline"
                onClick={() => onScope({ ...scope, notes: new Set(scopedNotes.map((n) => n.id)) })}
              >
                {t('cards.scope.allNotes')}
              </button>
              <button
                className="text-[var(--warn)] underline"
                onClick={() =>
                  onScope({ ...scope, notes: new Set(scopedNotes.filter((n) => cardCountOf(n.id) === 0).map((n) => n.id)) })
                }
                title={t('cards.scope.uncardedHint')}
              >
                {t('cards.scope.onlyUncarded')}
              </button>
              <button className="text-dim underline" onClick={() => onScope({ ...scope, notes: new Set() })}>
                {t('cards.scope.clearNotes')}
              </button>
            </span>
          </div>
          <div data-fc-notes className="max-h-40 space-y-0.5 overflow-y-auto">
            {scopedNotes.map((n) => {
              const checked = scope.notes.has(n.id)
              return (
                <label key={n.id} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-1 text-[11px] hover:bg-surface-3">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = new Set(scope.notes)
                      if (e.target.checked) next.add(n.id)
                      else next.delete(n.id)
                      onScope({ ...scope, notes: next })
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate" title={n.title}>
                    {n.title}
                  </span>
                  <span
                    className={`shrink-0 font-mono text-[10px] ${
                      cardCountOf(n.id) === 0 ? 'text-[var(--warn)]' : 'text-dim'
                    }`}
                  >
                    {cardCountOf(n.id) === 0 ? t('cards.scope.uncardedShort') : `${cardCountOf(n.id)}`}
                  </span>
                </label>
              )
            })}
          </div>
          <p className="mt-1 text-[10px] leading-snug text-dim">{t('cards.scope.hint')}</p>
        </div>
      )}
    </div>
  )
}
