import React, { useMemo, useState } from 'react'
import { t } from '../i18n'
import { Empty, relTime } from '../ui'
import type { Library } from '../api'
import { notebookColor } from '@shared/notebookColor'

interface NbNode {
  id: string
  name: string
  depth: number
  count: number
}

export default function NotesList({
  lib,
  onOpen,
  nb,
  onNb
}: {
  lib: Library
  onOpen: (id: string) => void
  /** 当前笔记分类（由 App 持有，切换页面/重启后都保留） */
  nb: string
  onNb: (id: string) => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const dotOf = (id: string | null): string => notebookColor(lib.notebooks, id)

  // 笔记本（含子笔记本缩进）与各自笔记数
  const notebooks = useMemo<NbNode[]>(() => {
    const byParent = new Map<string | null, typeof lib.notebooks>()
    for (const b of lib.notebooks) {
      const k = b.parentId ?? null
      byParent.set(k, [...(byParent.get(k) ?? []), b])
    }
    const out: NbNode[] = []
    const walk = (parent: string | null, depth: number): void => {
      const list = (byParent.get(parent) ?? []).slice().sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0) || a.name.localeCompare(b.name))
      for (const b of list) {
        if (b.hidden) continue
        const ids = new Set<string>()
        const collect = (pid: string): void => {
          ids.add(pid)
          for (const c of byParent.get(pid) ?? []) collect(c.id)
        }
        collect(b.id)
        const count = lib.notes.filter((n) => n.notebookId && ids.has(n.notebookId)).length
        out.push({ id: b.id, name: b.name, depth, count })
        walk(b.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [lib])

  const notes = useMemo(() => {
    const kw = q.trim().toLowerCase()
    let list = lib.notes
    if (nb === 'none') list = list.filter((n) => !n.notebookId)
    else if (nb !== 'all') {
      const ids = new Set<string>([nb])
      // 含子笔记本
      let grew = true
      while (grew) {
        grew = false
        for (const b of lib.notebooks) {
          if (b.parentId && ids.has(b.parentId) && !ids.has(b.id)) {
            ids.add(b.id)
            grew = true
          }
        }
      }
      list = list.filter((n) => n.notebookId && ids.has(n.notebookId))
    }
    if (kw) list = list.filter((n) => n.title.toLowerCase().includes(kw) || n.excerpt.toLowerCase().includes(kw))
    return list.slice().sort((a, b) => b.updatedAt - a.updatedAt)
  }, [lib, nb, q])

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 space-y-2 bg-bg/95 px-3 pb-2 pt-3 backdrop-blur">
        <input
          className="inp"
          placeholder={t('mobile.searchNotes')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="flex gap-2 overflow-x-auto pb-1">
          {[
            { id: 'all', label: t('mobile.all'), count: lib.notes.length, dot: '' },
            { id: 'none', label: t('mobile.unsorted'), count: lib.notes.filter((n) => !n.notebookId).length, dot: '' },
            ...notebooks.map((n) => ({ id: n.id, label: `${'· '.repeat(n.depth)}${n.name}`, count: n.count, dot: dotOf(n.id) }))
          ].map((c) => (
            <button
              key={c.id}
              onClick={() => onNb(c.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition ${
                nb === c.id ? 'bg-accent text-white' : 'bg-surface-2 text-dim'
              }`}
            >
              {c.dot && <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: c.dot }} />}
              {c.label} {c.count}
            </button>
          ))}
        </div>
      </div>

      {notes.length === 0 ? (
        <Empty text={t('mobile.notesEmpty')} />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-3 pb-24">
          {notes.map((n) => (
            <li key={n.id}>
              <button
                onClick={() => onOpen(n.id)}
                className="panel mb-2 w-full px-4 py-3 text-left transition active:scale-[0.99]"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    {dotOf(n.notebookId) && (
                      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: dotOf(n.notebookId) as string }} />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{n.title}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-dim">{relTime(n.updatedAt)}</span>
                </div>
                {n.excerpt && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-dim">{n.excerpt}</p>}
                {n.tags?.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {n.tags.slice(0, 4).map((tag) => (
                      <span key={tag} className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] text-dim">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
