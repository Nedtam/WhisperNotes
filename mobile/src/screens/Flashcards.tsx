// 手机端闪卡：今日待复习 → 翻卡 → 四档评分（SM-2 本地计算，离线可用）→ 联网回传电脑端
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { schedule, SRS_DEFAULT } from '@shared/srs'
import { inScope, noteOfCard, subtreeIds, type CardScope } from '@shared/cardScope'
import { notebookColor } from '@shared/notebookColor'
import type { NoteRecord, Notebook } from '@shared/types'
import { t } from '../i18n'
import { Empty, Spinner } from '../ui'
import {
  fetchCards,
  cachedCards,
  saveCachedCards,
  loadQueue,
  saveQueue,
  type CardRow,
  type CardStatsLite,
  type Conn,
  type QueuedReview
} from '../api'

const GRADES: Array<{ g: number; key: string; cls: string }> = [
  { g: 0, key: 'cards.review.again', cls: 'bg-[var(--err)] text-white' },
  { g: 1, key: 'cards.review.hard', cls: 'bg-[var(--warn)] text-white' },
  { g: 2, key: 'cards.review.good', cls: 'bg-[var(--ok)] text-white' },
  { g: 3, key: 'cards.review.easy', cls: 'bg-accent text-white' }
]

export default function Flashcards({
  conn,
  online,
  pending,
  library,
  scope,
  onScope,
  onToast,
  onQueued,
  onNeedLibrary
}: {
  conn: Conn
  online: boolean
  /** 待回传的复习条数（由 App 统一补传，这里只展示） */
  pending: number
  /** 分类选择（由 App 持有并持久化） */
  scope: CardScope
  onScope: (s: CardScope) => void
  /** 文库（笔记本 + 笔记），用于与电脑端一致地按笔记本筛选 */
  library: { notebooks: Notebook[]; notes: Array<{ id: string; title: string; notebookId: string | null }> } | null
  onToast: (kind: 'ok' | 'err', text: string) => void
  /** 刚写入一条待同步记录 → 让 App 立刻尝试回传（在线时即时同步） */
  onQueued: () => void
  /** 本地笔记库为空/落后时，请 App 重新拉一次文库（自愈） */
  onNeedLibrary: () => void
}): React.JSX.Element {
  const [cards, setCards] = useState<CardRow[]>([])
  const [stats, setStats] = useState<CardStatsLite | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'due' | 'all'>('due')
  const [review, setReview] = useState<{ queue: string[]; idx: number; flipped: boolean; startedAt: number; done: number } | null>(null)
  const catScope = scope
  const setCatScope = onScope
  const [scopeOpen, setScopeOpen] = useState(false)

  const notebooks = library?.notebooks ?? []
  const noteList = (library?.notes ?? []) as NoteRecord[]
  // 自愈：有卡片却没有笔记目录（本地库残留/落后）→ 让 App 重新拉文库
  useEffect(() => {
    if (cards.length > 0 && noteList.length === 0) onNeedLibrary()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.length, noteList.length])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const cached = await cachedCards()
      if (cached) {
        setCards(cached.cards)
        setStats(cached.stats)
      }
      if (navigator.onLine !== false) {
        try {
          const fresh = await fetchCards(conn)
          setCards(fresh.cards)
          setStats(fresh.stats)
        } catch {
          /* 离线：用缓存 */
        }
      }
    } finally {
      setLoading(false)
    }
  }, [conn])

  useEffect(() => {
    void load()
  }, [load])

  // 手机端以卡片自带的 notebookId 为准（笔记库可能落后一代），笔记信息缺失时也能正确分类
  const scopedCards = useMemo(() => {
    const noteById = new Map(noteList.map((n) => [n.id, n]))
    return cards.filter((c) => {
      const nbId = c.notebookId ?? (c.noteId ? noteById.get(c.noteId)?.notebookId : null)
      if (catScope.kind === 'all') return true
      if (catScope.kind === 'none') return !nbId
      if (!nbId) return false
      if (!subtreeIds(notebooks, catScope.id).has(nbId)) return false
      if (catScope.notes.size > 0 && !(c.noteId && catScope.notes.has(c.noteId))) return false
      return true
    })
  }, [cards, catScope, noteList, notebooks])
  const cardCountOf = (noteId: string): number => cards.filter((c) => c.noteId === noteId).length
  const scopeName = useMemo(() => {
    if (catScope.kind === 'all') return t('mobile.all')
    if (catScope.kind === 'none') return t('mobile.unsorted')
    const nb = notebooks.find((x) => x.id === catScope.id)
    return `${nb?.name ?? ''}${catScope.notes.size ? ` · ${t('cards.scope.picked', { n: catScope.notes.size })}` : ''}`
  }, [catScope, notebooks])
  const scopedNotes = useMemo(() => {
    if (catScope.kind !== 'nb') return []
    const ids = subtreeIds(notebooks, catScope.id)
    return noteList
      .filter((n) => n.notebookId && ids.has(n.notebookId))
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title, 'zh'))
  }, [catScope, notebooks, noteList])

  const dueCards = useMemo(
    () => scopedCards.filter((c) => !c.suspended && (!c.dueAt || c.dueAt <= Date.now())),
    [scopedCards, review?.done]
  )

  const persist = async (next: CardRow[], st?: CardStatsLite): Promise<void> => {
    setCards(next)
    const stats2 = st ?? stats ?? { total: next.length, due: next.filter((c) => !c.suspended && (!c.dueAt || c.dueAt <= Date.now())).length, suspended: next.filter((c) => c.suspended).length, reviewedToday: 0, accuracy: 0, streak: 0, aiCount: 0, manualCount: 0 }
    setStats(stats2)
    await saveCachedCards({ cards: next, stats: stats2 })
  }

  const startReview = (): void => {
    const list = tab === 'due' ? dueCards : scopedCards.filter((c) => !c.suspended)
    if (!list.length) {
      onToast('ok', t('cards.review.allDone'))
      return
    }
    setReview({ queue: list.map((c) => c.id), idx: 0, flipped: false, startedAt: Date.now(), done: 0 })
  }

  const grade = async (g: number): Promise<void> => {
    if (!review) return
    const id = review.queue[review.idx]
    const card = cards.find((c) => c.id === id)
    if (!card) {
      setReview({ ...review, idx: review.idx + 1, flipped: false })
      return
    }
    // 本地先算 SM-2（与电脑端同一份 src/shared/srs.ts）→ 离线也能复习
    const next = schedule(
      { ease: card.ease ?? SRS_DEFAULT.ease, intervalDays: card.intervalDays ?? 0, reps: card.reps ?? 0, lapses: card.lapses ?? 0 },
      g,
      Date.now()
    )
    const updated: CardRow = {
      ...card,
      dueAt: next.dueAt,
      intervalDays: next.intervalDays,
      ease: next.ease,
      reps: next.reps,
      lapses: next.lapses
    }
    const nextCards = cards.map((c) => (c.id === id ? updated : c))
    await persist(nextCards)

    const q = await loadQueue()
    const item: QueuedReview = { cardId: id, grade: g, at: Date.now(), ms: Date.now() - review.startedAt }
    const withItem = [...q, item]
    await saveQueue(withItem)
    // 回传交给 App（不管当前页签都会补）；在线时它会立刻同步
    onQueued()

    const after = { ...review, idx: review.idx + 1, flipped: false, startedAt: Date.now(), done: review.done + 1 }
    if (after.idx >= after.queue.length) {
      onToast('ok', t('cards.review.done', { n: after.done }))
      setReview(null)
      void load()
    } else {
      setReview(after)
    }
  }

  const current = review ? cards.find((c) => c.id === review.queue[review.idx]) : undefined

  if (review && current) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-edge px-4 py-3">
          <span className="text-xs text-dim">{t('cards.review.progress', { i: review.idx + 1, n: review.queue.length })}</span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round((review.idx / review.queue.length) * 100)}%` }} />
          </div>
          <button className="text-xs text-dim underline" onClick={() => setReview(null)}>
            {t('cards.review.exit')}
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">
          <div className="w-full">
            <div className="panel p-5">
              <div className="text-[11px] uppercase tracking-wide text-dim">{t('cards.front')}</div>
              <div className="mt-2 whitespace-pre-wrap text-lg font-medium leading-relaxed">{current.front}</div>
              {(current.importance || current.kind) && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                  {current.importance ? <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent">{'★'.repeat(current.importance)}</span> : null}
                  {current.kind ? <span className="rounded bg-surface-3 px-1.5 py-0.5 text-dim">{t(`cards.kind.${current.kind}`)}</span> : null}
                </div>
              )}
              {current.hint && !review.flipped && <div className="mt-3 text-xs text-dim">💡 {current.hint}</div>}
              {review.flipped && (
                <>
                  <div className="mt-5 border-t border-edge pt-4 text-[11px] uppercase tracking-wide text-dim">{t('cards.back')}</div>
                  <div className="mt-2 whitespace-pre-wrap text-base leading-relaxed">{current.back}</div>
                </>
              )}
            </div>
            <div className="mt-4">
              {!review.flipped ? (
                <button className="btn-primary w-full" onClick={() => setReview({ ...review, flipped: true })}>
                  {t('cards.review.show')}
                </button>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {GRADES.map((x) => (
                    <button key={x.g} className={`rounded-xl px-3 py-3.5 text-sm font-medium ${x.cls}`} onClick={() => void grade(x.g)}>
                      {t(x.key)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-2 px-4 pt-4">
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: t('cards.stats.due'), value: dueCards.length },
            { label: t('cards.stats.total'), value: scopedCards.length },
            { label: t('cards.stats.today'), value: stats?.reviewedToday ?? 0 },
            { label: t('cards.stats.accuracy'), value: `${Math.round((stats?.accuracy ?? 0) * 100)}%` }
          ].map((k) => (
            <div key={k.label} className="rounded-xl bg-surface-2 px-2 py-2 text-center">
              <div className="text-[10px] leading-tight text-dim">{k.label}</div>
              <div className="text-base font-semibold">{k.value}</div>
            </div>
          ))}
        </div>
        {pending > 0 && <p className="text-center text-[11px] text-warn">{t('mobile.reviewsPending', { n: pending })}</p>}

        {/* 分类范围：与电脑端一致（笔记本 → 子笔记本 → 选具体笔记） */}
        <div className="rounded-xl bg-surface-2/70 px-2 py-2">
          <button className="flex w-full items-center gap-2 text-left text-xs" onClick={() => setScopeOpen((v) => !v)}>
            <span className="text-dim">{t('cards.scope.title')}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{scopeName}</span>
            <span className="text-dim">{scopeOpen ? '▴' : '▾'}</span>
          </button>
          {scopeOpen && (
            <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
              {(
                [
                  { id: 'all', label: t('mobile.all') },
                  { id: 'none', label: t('mobile.unsorted') }
                ] as const
              ).map((x) => (
                <button
                  key={x.id}
                  onClick={() => {
                    setCatScope({ kind: x.id })
                    setScopeOpen(false)
                  }}
                  className={`block w-full rounded-lg px-2 py-1.5 text-left text-xs ${
                    catScope.kind === x.id ? 'bg-accent/15 text-accent' : 'text-fg'
                  }`}
                >
                  {x.label}
                  <span className="ml-1 font-mono text-[10px] text-dim">
                    {cards.filter((c) => inScope(c, { kind: x.id } as CardScope, noteList, notebooks)).length}
                  </span>
                </button>
              ))}
              {notebooks
                .filter((b) => !b.hidden)
                .map((b) => {
                  const depth = ((): number => {
                    let d = 0
                    let cur: Notebook | undefined = b
                    while (cur?.parentId) {
                      cur = notebooks.find((x) => x.id === cur?.parentId)
                      d += 1
                      if (d > 8) break
                    }
                    return d
                  })()
                  const ids = subtreeIds(notebooks, b.id)
                  const cnt = cards.filter((c) => {
                    const nbId = c.notebookId ?? (c.noteId ? noteList.find((n) => n.id === c.noteId)?.notebookId : null)
                    return !!nbId && ids.has(nbId)
                  }).length
                  const uncarded = noteList.filter((n) => n.notebookId && ids.has(n.notebookId) && cardCountOf(n.id) === 0).length
                  return (
                    <button
                      key={b.id}
                      onClick={() => {
                        setCatScope({ kind: 'nb', id: b.id, notes: new Set() })
                      }}
                      style={{ paddingLeft: 8 + depth * 10 }}
                      className={`flex w-full items-center gap-1 rounded-lg py-1.5 pr-2 text-left text-xs ${
                        catScope.kind === 'nb' && catScope.id === b.id ? 'bg-accent/15 text-accent' : 'text-fg'
                      }`}
                    >
                      <span
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ background: notebookColor(notebooks, b.id) }}
                      />
                      <span className="min-w-0 flex-1 truncate">{b.name}</span>
                      {uncarded > 0 && (
                        <span className="shrink-0 rounded bg-[var(--warn)]/15 px-1 font-mono text-[10px] text-[var(--warn)]">
                          {uncarded} {t('cards.scope.uncardedShort')}
                        </span>
                      )}
                      <span className="shrink-0 font-mono text-[10px] text-dim">{cnt}</span>
                    </button>
                  )
                })}
            </div>
          )}
          {/* 选中笔记本后：挑要温习的笔记（例如 MGT2324 的 Week 2–4） */}
          {catScope.kind === 'nb' && scopedNotes.length > 0 && (
            <div className="mt-2 border-t border-edge/50 pt-2">
              <div className="mb-1 flex items-center justify-between text-[10px] text-dim">
                <span>{t('cards.scope.notes')}</span>
                <span className="flex flex-wrap gap-2">
                  <button className="text-accent underline" onClick={() => setCatScope({ ...catScope, notes: new Set(scopedNotes.map((n) => n.id)) })}>
                    {t('cards.scope.allNotes')}
                  </button>
                  <button
                    className="text-[var(--warn)] underline"
                    onClick={() => setCatScope({ ...catScope, notes: new Set(scopedNotes.filter((n) => cardCountOf(n.id) === 0).map((n) => n.id)) })}
                  >
                    {t('cards.scope.onlyUncarded')}
                  </button>
                  <button className="underline" onClick={() => setCatScope({ ...catScope, notes: new Set() })}>
                    {t('cards.scope.clearNotes')}
                  </button>
                </span>
              </div>
              <div className="max-h-40 space-y-0.5 overflow-y-auto">
                {scopedNotes.map((n) => (
                  <label key={n.id} className="flex items-center gap-2 rounded px-1 py-1 text-[11px]">
                    <input
                      type="checkbox"
                      checked={catScope.notes.has(n.id)}
                      onChange={(e) => {
                        const next = new Set(catScope.notes)
                        if (e.target.checked) next.add(n.id)
                        else next.delete(n.id)
                        setCatScope({ ...catScope, notes: next })
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate">{n.title}</span>
                    <span className={`shrink-0 font-mono text-[10px] ${cardCountOf(n.id) === 0 ? 'text-[var(--warn)]' : 'text-dim'}`}>
                      {cardCountOf(n.id) === 0 ? t('cards.scope.uncardedShort') : cardCountOf(n.id)}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {(
            [
              { id: 'due' as const, label: t('cards.filter.due', { n: dueCards.length }) },
              { id: 'all' as const, label: t('cards.filter.all', { n: scopedCards.length }) }
            ] as const
          ).map((x) => (
            <button
              key={x.id}
              onClick={() => setTab(x.id)}
              className={`rounded-full px-3 py-1.5 text-xs ${tab === x.id ? 'bg-accent text-white' : 'bg-surface-2 text-dim'}`}
            >
              {x.label}
            </button>
          ))}
          <button
            className="btn-ghost ml-auto !px-3"
            onClick={() => void load()}
            title={t('mobile.refresh')}
          >
            ↻
          </button>
          <button className="btn-primary" onClick={startReview}>
            {t('cards.review.start')}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-3">
        {loading && !cards.length ? (
          <p className="flex items-center justify-center gap-2 py-10 text-sm text-dim">
            <Spinner size={14} /> {t('mobile.loading')}
          </p>
        ) : (tab === 'due' ? dueCards : scopedCards).length === 0 ? (
          <Empty text={tab === 'due' ? t('cards.emptyDue') : t('cards.empty')} />
        ) : (
          <ul className="space-y-2">
            {(tab === 'due' ? dueCards : scopedCards).map((c) => (
              <li key={c.id} className="panel px-4 py-3">
                <div className="whitespace-pre-wrap text-sm font-medium">{c.front}</div>
                <div className="mt-1 whitespace-pre-wrap text-xs text-dim">{c.back}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-dim">
                  {c.importance ? <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent">{'★'.repeat(c.importance)}</span> : null}
                  {c.kind ? <span className="rounded bg-surface-3 px-1.5 py-0.5">{t(`cards.kind.${c.kind}`)}</span> : null}
                  {c.reps > 0 && <span>×{c.reps}</span>}
                  {c.dueAt && c.dueAt > Date.now() ? <span>⏳ {Math.ceil((c.dueAt - Date.now()) / 86400000)}d</span> : <span className="text-accent">●</span>}
                  {c.tags?.slice(0, 3).map((tg) => (
                    <span key={tg} className="rounded-full bg-surface-3 px-1.5 py-0.5">
                      {tg}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
