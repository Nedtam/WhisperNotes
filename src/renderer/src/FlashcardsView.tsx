// 闪卡：AI 从整理好的笔记出卡 → 预览/编辑 → 间隔重复复习 → 统计
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Card, CardGenProgress, CardGenRequest, CardStats } from '../../shared/types'
import { useApp } from './store'
import { Spinner } from './ui'
import { t, tError } from './i18n'
import FlashcardsNav, { inScope, notesInScope, type CardScope } from './FlashcardsNav'

type Filter = 'due' | 'all' | 'suspended'
type GenScope = 'missing' | 'note' | 'notebook' | 'current'

interface GenState {
  jobId: string
  detail: string
  i: number
  n: number
  cards: number
  done: boolean
  error?: string
}

const GRADES: Array<{ g: number; key: string; cls: string }> = [
  { g: 0, key: 'cards.review.again', cls: 'bg-[var(--err)] text-white' },
  { g: 1, key: 'cards.review.hard', cls: 'bg-[var(--warn)] text-white' },
  { g: 2, key: 'cards.review.good', cls: 'bg-[var(--ok)] text-white' },
  { g: 3, key: 'cards.review.easy', cls: 'bg-accent text-white' }
]

export default function FlashcardsView(): React.JSX.Element {
  const s = useApp((st) => st.settings)
  const pending = useApp((st) => st.pending)
  const nbSel = useApp((st) => st.nbSel)
  const notes = useApp((st) => st.notes)
  const notebooks = useApp((st) => st.notebooks)

  // 分类范围：与笔记库同构（全部 / 未归档 / 笔记本 / 子笔记本 + 笔记本内多选笔记）
  const [catScope, setCatScope] = useState<CardScope>(() => {
    const cur = useApp.getState().nbSel
    return cur === 'all' || cur === 'none' ? { kind: cur } : { kind: 'nb', id: cur, notes: new Set() }
  })

  const [cards, setCards] = useState<Card[]>([])
  const [stats, setStats] = useState<CardStats | null>(null)
  const [filter, setFilter] = useState<Filter>('due')
  const [q, setQ] = useState('')
  const [showGen, setShowGen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [genScope, setGenScope] = useState<GenScope>('missing')
  const [preset, setPreset] = useState<'exam' | 'study' | 'broad'>('study')
  const [minImportance, setMinImportance] = useState(3)
  const [rebuild, setRebuild] = useState(false)
  const [per1000, setPer1000] = useState(5)
  const [maxPerNote, setMaxPerNote] = useState(20)
  const [style, setStyle] = useState<'balanced' | 'definition' | 'application' | 'formula'>('balanced')
  const [language, setLanguage] = useState<'auto' | 'zh' | 'en'>('auto')
  const [job, setJob] = useState<GenState | null>(null)
  const [editing, setEditing] = useState<{ id: string; front: string; back: string; hint: string } | null>(null)
  const [review, setReview] = useState<{ queue: string[]; idx: number; flipped: boolean; startedAt: number; done: number } | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const flash = (msg: string): void => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2600)
  }

  useEffect(() => {
    // 笔记本/笔记列表由笔记页维护；如果用户直接进闪卡页，这里补一次
    void (async () => {
      try {
        if (!useApp.getState().notebooks.length) useApp.getState().setNotebooks(await window.api.notebooks.list())
        if (!useApp.getState().notes) useApp.getState().setNotes(await window.api.notes.list())
      } catch {
        /* ignore */
      }
    })()
  }, [])

  const load = async (): Promise<void> => {
    try {
      const [list, st] = await Promise.all([
        window.api.cards.list(filter === 'suspended' ? { includeSuspended: true } : filter === 'due' ? { due: true, includeSuspended: false } : {}),
        window.api.cards.stats()
      ])
      setCards(filter === 'suspended' ? list.filter((c) => c.suspended) : list)
      setStats(st)
    } catch (e) {
      flash(tError((e as Error).message))
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  useEffect(() => {
    const offP = window.api.cards.onProgress((p: CardGenProgress & { jobId: string }) => {
      setJob((cur) =>
        cur && cur.jobId === p.jobId
          ? { ...cur, detail: p.detail ?? cur.detail, i: p.i ?? cur.i, n: p.n ?? cur.n, cards: p.cards ?? cur.cards }
          : cur
      )
    })
    const offD = window.api.cards.onDone((d) => {
      setJob((cur) => (cur && cur.jobId === d.jobId ? { ...cur, done: true, cards: d.cards, error: d.error } : cur))
      flash(
        d.error
          ? tError(d.error)
          : d.failed
            ? t('cards.doneFailed', { n: d.cards, f: d.failed })
            : d.canceled
              ? t('cards.canceled')
              : t('cards.done', { n: d.cards })
      )
      void load()
    })
    return () => {
      offP()
      offD()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startGen = async (): Promise<void> => {
    setBusy(true)
    try {
      // 分类范围 → 要出卡的笔记集合（含每篇现有卡片数，便于"只出未出卡的"）
      const inScopeNotes = notesInScope(notes ?? [], catScope, notebooks, (id) => cards.filter((c) => c.noteId === id).length)
      const base = { per1000, maxPerNote, style, language, preset, minImportance, blockAdmin: true, skipExisting: !rebuild }
      const req: CardGenRequest =
        genScope === 'note'
          ? { ...base, noteId: pending?.id }
          : genScope === 'notebook'
            ? { ...base, notebookId: catScope.kind === 'nb' ? catScope.id : nbSel !== 'all' && nbSel !== 'none' ? nbSel : undefined }
            : genScope === 'current'
              ? { ...base, noteIds: inScopeNotes.map((x) => x.note.id) }
              : base
      // 重建：先把选中范围内笔记的旧卡删掉（含手动改过的）
      if (rebuild) {
        if (!window.confirm(t('cards.gen.rebuildWarn'))) return
        for (const x of inScopeNotes) await window.api.cards.removeForNote(x.note.id)
        if (genScope === 'note' && pending?.id) await window.api.cards.removeForNote(pending.id)
        void load()
      }
      if (genScope === 'note' && !pending?.id) {
        flash(t('cards.gen.needNote'))
        return
      }
      if (genScope === 'current' && !req.noteIds?.length) {
        flash(t('cards.gen.needScope'))
        return
      }
      const r = await window.api.cards.generate(req)
      if (!r.ok) {
        flash(r.error ? tError(r.error) : t('cards.noNotes'))
        return
      }
      setJob({ jobId: r.jobId as string, detail: t('cards.plan', { n: 0 }), i: 0, n: 0, cards: 0, done: false })
    } finally {
      setBusy(false)
    }
  }

  const noteTitle = (id: string | null): string => (notes ?? []).find((n) => n.id === id)?.title ?? ''

  const scopedCards = useMemo(
    () => cards.filter((c) => inScope(c, catScope, notes ?? [], notebooks)),
    [cards, catScope, notes, notebooks]
  )
  const scopeLabel = useMemo(() => {
    if (catScope.kind === 'all') return t('notes.all')
    if (catScope.kind === 'none') return t('notes.unsorted')
    const nb = notebooks.find((n) => n.id === catScope.id)
    const picked = catScope.notes.size
    return `${nb?.name ?? ''}${picked > 0 ? ` · ${t('cards.scope.picked', { n: picked })}` : ''}`
  }, [catScope, notebooks])

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return kw
      ? scopedCards.filter((c) => c.front.toLowerCase().includes(kw) || c.back.toLowerCase().includes(kw))
      : scopedCards
  }, [scopedCards, q])

  const startReview = (): void => {
    const due = scopedCards.filter((c) => !c.suspended)
    if (!due.length) {
      flash(t('cards.review.allDone'))
      return
    }
    setReview({ queue: due.map((c) => c.id), idx: 0, flipped: false, startedAt: Date.now(), done: 0 })
  }

  const grade = async (g: number): Promise<void> => {
    if (!review) return
    const cardId = review.queue[review.idx]
    try {
      await window.api.cards.review(cardId, g, Date.now() - review.startedAt)
    } catch {
      /* 忽略单张失败 */
    }
    const next = { ...review, idx: review.idx + 1, flipped: false, startedAt: Date.now(), done: review.done + 1 }
    setReview(next)
    if (next.idx >= next.queue.length) {
      flash(t('cards.review.done', { n: next.done }))
      setReview(null)
      void load()
    }
  }

  const doEdit = async (): Promise<void> => {
    if (!editing) return
    await window.api.cards.update(editing.id, { front: editing.front, back: editing.back, hint: editing.hint })
    setEditing(null)
    void load()
  }

  const currentCard: Card | undefined = review ? cards.find((c) => c.id === review.queue[review.idx]) : undefined

  return (
    <div className="flex h-full">
      {/* 分类范围（与笔记库同构） */}
      <FlashcardsNav
        notebooks={notebooks}
        notes={notes ?? []}
        cards={cards}
        scope={catScope}
        onScope={setCatScope}
      />

      <div className="flex min-w-0 flex-1 flex-col">
      {/* 头部：统计 + 生成入口 */}
      <div className="shrink-0 border-b border-edge/60 px-5 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">
              {t('cards.title')}
              <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-normal text-dim">{scopeLabel}</span>
            </h2>
            <p className="text-xs text-dim">{t('cards.subtitle')}</p>
          </div>
          <button className="btn-ghost" onClick={() => setShowGen((v) => !v)}>
            {t('cards.gen.title')} {showGen ? '▴' : '▾'}
          </button>
          <button className="btn-primary" onClick={startReview} disabled={!cards.length}>
            {t('cards.review.start')}
          </button>
        </div>

        {stats && (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: t('cards.stats.due'), value: String(stats.due), cls: 'text-accent' },
              { label: t('cards.stats.total'), value: String(stats.total), cls: '' },
              { label: t('cards.stats.today'), value: String(stats.reviewedToday), cls: '' },
              { label: t('cards.stats.accuracy'), value: `${Math.round(stats.accuracy * 100)}%`, cls: '' }
            ].map((k) => (
              <div key={k.label} className="rounded-xl bg-surface-2/70 px-3 py-2">
                <div className="text-[11px] text-dim">{k.label}</div>
                <div className={`text-lg font-semibold ${k.cls}`}>{k.value}</div>
              </div>
            ))}
          </div>
        )}
        {stats && stats.total > 0 && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-dim">
            <span>{t('cards.stats.ai', { ai: stats.aiCount, manual: stats.manualCount })}</span>
            {stats.streak > 0 && <span>· {t('cards.stats.streak', { n: stats.streak })}</span>}
            <span className="ml-auto flex items-end gap-[2px]" title={t('cards.stats.trend')}>
              {stats.daily.slice(-30).map((d) => (
                <span
                  key={d.day}
                  className="inline-block w-[3px] rounded-sm bg-accent/70"
                  style={{ height: `${Math.min(16, 2 + d.n * 2)}px` }}
                  title={`${d.day}: ${d.n}`}
                />
              ))}
            </span>
          </div>
        )}
      </div>

      {/* 生成面板 */}
      {showGen && (
        <div className="shrink-0 border-b border-edge/60 bg-surface-2/40 px-5 py-3">
          <div className="flex flex-wrap items-end gap-3 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-dim">{t('cards.gen.scope')}</span>
              <select className="inp !w-56 !py-1.5" value={genScope} onChange={(e) => setGenScope(e.target.value as GenScope)}>
                <option value="missing">{t('cards.gen.scopeMissing')}</option>
                <option value="note">{t('cards.gen.scopeNote')}</option>
                <option value="notebook">{t('cards.gen.scopeNotebook')}</option>
                <option value="current">{t('cards.gen.scopeCurrent', { name: '' })}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-dim">{t('cards.gen.per1000', { n: per1000 })}</span>
              <input
                className="w-32 accent-[var(--accent)]"
                type="range"
                min={1}
                max={15}
                value={per1000}
                onChange={(e) => setPer1000(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-dim">{t('cards.gen.max', { n: maxPerNote })}</span>
              <input
                className="w-32 accent-[var(--accent)]"
                type="range"
                min={5}
                max={60}
                step={5}
                value={maxPerNote}
                onChange={(e) => setMaxPerNote(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-dim">{t('cards.gen.style')}</span>
              <select className="inp !w-56 !py-1.5" value={style} onChange={(e) => setStyle(e.target.value as typeof style)}>
                <option value="balanced">{t('cards.style.balanced')}</option>
                <option value="definition">{t('cards.style.definition')}</option>
                <option value="application">{t('cards.style.application')}</option>
                <option value="formula">{t('cards.style.formula')}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-dim">{t('cards.gen.preset')}</span>
              <select
                className="inp !w-64 !py-1.5"
                value={preset}
                onChange={(e) => {
                  const p = e.target.value as 'exam' | 'study' | 'broad'
                  setPreset(p)
                  const m = { exam: { per1000: 3, max: 12, min: 4 }, study: { per1000: 5, max: 20, min: 3 }, broad: { per1000: 8, max: 30, min: 2 } }[p]
                  setPer1000(m.per1000)
                  setMaxPerNote(m.max)
                  setMinImportance(m.min)
                }}
              >
                <option value="exam">{t('cards.preset.exam')}</option>
                <option value="study">{t('cards.preset.study')}</option>
                <option value="broad">{t('cards.preset.broad')}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-dim">{t('cards.gen.minImportance', { n: minImportance })}</span>
              <input
                className="w-32 accent-[var(--accent)]"
                type="range"
                min={1}
                max={5}
                value={minImportance}
                onChange={(e) => setMinImportance(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-dim">{t('cards.gen.language')}</span>
              <select className="inp !w-32 !py-1.5" value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}>
                <option value="auto">{t('cards.lang.auto')}</option>
                <option value="zh">{t('cards.lang.zh')}</option>
                <option value="en">{t('cards.lang.en')}</option>
              </select>
            </label>
            <button className="btn-primary" onClick={() => void startGen()} disabled={busy || !!job && !job.done}>
              {busy ? <Spinner size={13} /> : t('cards.gen.start')}
            </button>
            {job && !job.done && (
              <button className="btn-ghost" onClick={() => void window.api.cards.cancel(job.jobId)}>
                {t('cards.gen.cancel')}
              </button>
            )}
          </div>
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-dim">
            <input type="checkbox" checked={rebuild} onChange={(e) => setRebuild(e.target.checked)} />
            <span className={rebuild ? 'text-warn' : ''}>{t('cards.gen.rebuild')}</span>
          </label>
          <p className="mt-1 text-[11px] leading-relaxed text-dim">{t('cards.gen.sysHint')}</p>
          {!s?.llm.apiKey && <p className="mt-2 text-[11px] text-warn">{t('app.llmNoKey')}</p>}
        </div>
      )}

      {/* 进度 */}
      {job && (
        <div className="shrink-0 border-b border-accent/20 bg-accent-soft px-5 py-2 text-xs text-accent">
          <div className="flex items-center gap-2">
            {!job.done && <Spinner size={12} />}
            <span className="min-w-0 flex-1 truncate">{job.detail}</span>
            {job.n > 0 && <span className="font-mono">{t('cards.review.progress', { i: Math.min(job.i, job.n), n: job.n })}</span>}
            {job.done && (
              <button className="text-dim underline" onClick={() => setJob(null)}>
                {t('common.cancel')}
              </button>
            )}
          </div>
          {job.n > 0 && (
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round((Math.min(job.i, job.n) / job.n) * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {/* 过滤 + 搜索 */}
      <div className="flex shrink-0 items-center gap-2 px-5 py-2">
        {(
          [
            { id: 'due' as Filter, label: t('cards.filter.due', { n: stats?.due ?? 0 }) },
            { id: 'all' as Filter, label: t('cards.filter.all', { n: stats?.total ?? 0 }) },
            { id: 'suspended' as Filter, label: t('cards.filter.suspended', { n: stats?.suspended ?? 0 }) }
          ] as const
        ).map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-full px-3 py-1 text-xs transition ${filter === f.id ? 'bg-accent text-white' : 'bg-surface-2 text-dim'}`}
          >
            {f.label}
          </button>
        ))}
        <input
          className="inp ml-auto !w-56 !py-1.5 text-xs"
          placeholder={t('cards.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {filtered.length === 0 ? (
          <p className="py-16 text-center text-sm text-dim">
            {scopedCards.length === 0
              ? t('cards.emptyScope', { name: scopeLabel })
              : filter === 'due' && cards.length === 0
                ? t('cards.emptyDue')
                : t('cards.empty')}
          </p>
        ) : (
          <ul data-fc-list className="space-y-2">
            {filtered.map((c) => (
              <li key={c.id} className="rounded-2xl border border-edge bg-surface px-4 py-3">
                {editing?.id === c.id ? (
                  <div className="space-y-2">
                    <div>
                      <span className="lbl">{t('cards.front')}</span>
                      <textarea
                        className="inp min-h-16"
                        value={editing.front}
                        onChange={(e) => setEditing({ ...editing, front: e.target.value })}
                      />
                    </div>
                    <div>
                      <span className="lbl">{t('cards.back')}</span>
                      <textarea
                        className="inp min-h-20"
                        value={editing.back}
                        onChange={(e) => setEditing({ ...editing, back: e.target.value })}
                      />
                    </div>
                    <div>
                      <span className="lbl">{t('cards.hint')}</span>
                      <input className="inp" value={editing.hint} onChange={(e) => setEditing({ ...editing, hint: e.target.value })} />
                    </div>
                    <div className="flex gap-2">
                      <button className="btn-primary" onClick={() => void doEdit()}>
                        {t('cards.save')}
                      </button>
                      <button className="btn-ghost" onClick={() => setEditing(null)}>
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="whitespace-pre-wrap text-sm font-medium">{c.front}</div>
                        <div className="mt-1 whitespace-pre-wrap text-xs text-dim">{c.back}</div>
                        {c.hint && <div className="mt-1 text-[11px] text-dim">💡 {c.hint}</div>}
                        {(c.importance || c.kind || c.quote) && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                            {c.importance ? (
                              <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent" title={t('cards.imp', { n: c.importance })}>
                                {'★'.repeat(c.importance)}
                              </span>
                            ) : null}
                            {c.kind ? <span className="rounded bg-surface-3 px-1.5 py-0.5 text-dim">{t(`cards.kind.${c.kind}`)}</span> : null}
                            {c.quote ? (
                              <span className="min-w-0 max-w-full truncate text-dim" title={c.quote}>
                                {t('cards.quote', { q: c.quote })}
                              </span>
                            ) : null}
                          </div>
                        )}
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-dim">
                          {c.noteId && noteTitle(c.noteId) && <span>{t('cards.fromNote', { title: noteTitle(c.noteId) })}</span>}
                          {c.tags?.slice(0, 3).map((tag) => (
                            <span key={tag} className="rounded-full bg-surface-3 px-1.5 py-0.5">
                              {tag}
                            </span>
                          ))}
                          {c.reps ? <span>×{c.reps}</span> : null}
                          {c.dueAt && c.dueAt > Date.now() ? (
                            <span>⏳ {Math.ceil((c.dueAt - Date.now()) / 86400000)}d</span>
                          ) : (
                            <span className="text-accent">●</span>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col gap-1 text-[11px]">
                        <button className="text-dim underline" onClick={() => setEditing({ id: c.id, front: c.front, back: c.back, hint: c.hint ?? '' })}>
                          {t('cards.edit')}
                        </button>
                        <button
                          className="text-dim underline"
                          onClick={async () => {
                            await window.api.cards.update(c.id, { suspended: !c.suspended })
                            void load()
                          }}
                        >
                          {c.suspended ? t('cards.resume') : t('cards.suspend')}
                        </button>
                        <button
                          className="text-err underline"
                          onClick={async () => {
                            if (!window.confirm(t('cards.deleteConfirm'))) return
                            await window.api.cards.remove(c.id)
                            void load()
                          }}
                        >
                          {t('cards.delete')}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 复习模式（覆盖层） */}
      {review && currentCard && (
        <div data-fc-review className="absolute inset-0 z-30 flex flex-col bg-bg/98 backdrop-blur">
          <div className="flex items-center gap-3 border-b border-edge px-5 py-3">
            <span data-fc-progress className="text-xs text-dim">
              {t('cards.review.progress', { i: review.idx + 1, n: review.queue.length })}
            </span>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round((review.idx / review.queue.length) * 100)}%` }} />
            </div>
            <button className="btn-ghost" onClick={() => setReview(null)}>
              {t('cards.review.exit')}
            </button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="w-full max-w-2xl">
              <div className="rounded-2xl border border-edge bg-surface p-6">
                <div className="text-[11px] uppercase tracking-wide text-dim">{t('cards.front')}</div>
                <div className="mt-2 whitespace-pre-wrap text-lg font-medium leading-relaxed">{currentCard.front}</div>
                {currentCard.hint && !review.flipped && <div className="mt-3 text-xs text-dim">💡 {currentCard.hint}</div>}
                {review.flipped && (
                  <>
                    <div className="mt-5 border-t border-edge pt-4 text-[11px] uppercase tracking-wide text-dim">{t('cards.back')}</div>
                    <div className="mt-2 whitespace-pre-wrap text-base leading-relaxed">{currentCard.back}</div>
                  </>
                )}
              </div>
              <div className="mt-4">
                {!review.flipped ? (
                  <button className="btn-primary w-full" onClick={() => setReview({ ...review, flipped: true })}>
                    {t('cards.review.show')}
                  </button>
                ) : (
                  <div className="grid grid-cols-4 gap-2">
                    {GRADES.map((g) => (
                      <button key={g.g} className={`rounded-xl px-3 py-3 text-sm font-medium ${g.cls}`} onClick={() => void grade(g.g)}>
                        {t(g.key)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {currentCard.noteId && noteTitle(currentCard.noteId) && (
                <p className="mt-3 text-center text-[11px] text-dim">{t('cards.fromNote', { title: noteTitle(currentCard.noteId) })}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="absolute bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-xl bg-surface-3 px-4 py-2 text-xs shadow-lg">{toast}</div>
      )}
      </div>
    </div>
  )
}
