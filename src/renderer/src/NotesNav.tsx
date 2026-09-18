// 左侧全局导航栏里的「笔记导航」：全部/未归档 + 笔记本树（子笔记本、拖拽、隐藏、菜单）
// 只在进入 Notes 标签时展开；笔记列表因此能在 Notes 视图里占用更大空间。
import React, { useEffect, useRef, useState } from 'react'
import { useApp, refreshNotes } from './store'
import type { Notebook } from '../../shared/types'
import { t } from './i18n'

const PALETTE_FALLBACK = '#60a5fa'
function nbColor(list: Notebook[], id: string): string {
  const nb = list.find((x) => x.id === id)
  return nb?.color || PALETTE_FALLBACK
}

type NbModalState =
  | { kind: 'create'; parentId?: string | null }
  | { kind: 'rename'; nb: Notebook }
  | { kind: 'delete'; nb: Notebook }
  | null

export default function NotesNav(): React.JSX.Element {
  const notebooks = useApp((s) => s.notebooks)
  const nbSel = useApp((s) => s.nbSel)
  const notes = useApp((s) => s.notes) ?? []
  const settings = useApp((s) => s.settings)

  const [areaOpen, setAreaOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('wn-nb-area') !== '0'
    } catch {
      return true
    }
  })
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('wn-nb-expanded') || '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })
  const [showHidden, setShowHidden] = useState(false)
  const [menu, setMenu] = useState<string | null>(null)
  const [dropMark, setDropMark] = useState<string | null>(null)
  const [lineY, setLineY] = useState<number | null>(null)
  const dragNbRef = useRef<string | null>(null)
  const treeRef = useRef<HTMLDivElement | null>(null)
  const [modal, setModal] = useState<NbModalState>(null)
  const [name, setName] = useState('')

  const load = async (): Promise<void> => {
    try {
      useApp.getState().setNotebooks(await window.api.notebooks.list())
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const children = (parentId: string | null): Notebook[] =>
    notebooks
      .filter((n) => (n.parentId ?? null) === parentId && (showHidden || !n.hidden))
      .sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0))
  const subtreeIds = (id: string): string[] => {
    const out = [id]
    let changed = true
    while (changed) {
      changed = false
      for (const n of notebooks) {
        if (n.parentId && out.includes(n.parentId) && !out.includes(n.id)) {
          out.push(n.id)
          changed = true
        }
      }
    }
    return out
  }
  const deepCount = (id: string): number => {
    const ids = new Set(subtreeIds(id))
    return notes.filter((n) => n.notebookId && ids.has(n.notebookId)).length
  }
  const hiddenCount = notebooks.filter((n) => n.hidden).length
  const flat = (): Array<{ nb: Notebook; depth: number }> => {
    const out: Array<{ nb: Notebook; depth: number }> = []
    const walk = (parentId: string | null, depth: number): void => {
      for (const nb of children(parentId)) {
        out.push({ nb, depth })
        walk(nb.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }

  const setSel = (id: string): void => {
    useApp.getState().setNbSel(id)
    setMenu(null)
  }

  const openCreate = (parentId?: string | null): void => {
    setName('')
    setModal({ kind: 'create', parentId: parentId ?? null })
  }

  const submitModal = async (): Promise<void> => {
    const m = modal
    if (!m) return
    try {
      if (m.kind === 'create') {
        const nb = await window.api.notebooks.create(name, m.parentId ?? null)
        await load()
        if (m.parentId) {
          setExpanded((prev) => {
            const next = { ...prev, [m.parentId as string]: true }
            try {
              localStorage.setItem('wn-nb-expanded', JSON.stringify(next))
            } catch {
              /* ignore */
            }
            return next
          })
        }
        setSel(nb.id)
      } else if (m.kind === 'rename') {
        await window.api.notebooks.rename(m.nb.id, name)
        await load()
      } else {
        await window.api.notebooks.remove(m.nb.id)
        if (subtreeIds(m.nb.id).includes(nbSel)) setSel('all')
        await load()
        await refreshNotes()
      }
      setModal(null)
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: t('notes.nbCreateFail') + ((e as Error).message || '') })
    }
  }

  const menuAction = async (action: string, nb: Notebook): Promise<void> => {
    setMenu(null)
    try {
      if (action === 'edit') {
        setName(nb.name)
        setModal({ kind: 'rename', nb })
      } else if (action === 'delete') {
        setModal({ kind: 'delete', nb })
      } else if (action === 'hide') {
        await window.api.notebooks.setHidden(nb.id, true)
        if (subtreeIds(nb.id).includes(nbSel)) setSel('all')
        await load()
      } else if (action === 'unhide') {
        await window.api.notebooks.setHidden(nb.id, false)
        await load()
      } else if (action === 'sub') {
        openCreate(nb.id)
      } else if (action === 'note') {
        useApp.getState().setPending({
          title: '',
          noteMd: '',
          sourceText: '',
          templateId: settings?.llm.templateId ?? 'study',
          notebookId: nb.id,
          durationMs: 0,
          tags: []
        })
        setSel(nb.id)
      }
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: (e as Error).message || '' })
    }
  }

  const toggleExpanded = (id: string): void => {
    setExpanded((prev) => {
      const next = { ...prev, [id]: !prev[id] }
      try {
        localStorage.setItem('wn-nb-expanded', JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }
  const setArea = (v: boolean): void => {
    setAreaOpen(v)
    try {
      localStorage.setItem('wn-nb-area', v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  // 把笔记拖到笔记本（笔记行在 Notes 视图里，draggable 并写入 text/plain）
  const dropNoteOn = (nbId: string | null) => async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    setDropMark(null)
    const noteId = e.dataTransfer.getData('text/plain')
    if (!noteId) return
    await window.api.notes.setNotebook(noteId, nbId)
    const st = useApp.getState()
    if (st.pending?.id === noteId) st.setPending({ ...st.pending, notebookId: nbId })
    await refreshNotes()
  }

  // ── 笔记本拖拽（文档式）─────────────────────────────
  // 落点由光标相对「行」的位置决定：上缘=插到它前面（同级）、下缘=插到它整棵子树后面（同级）、
  // 中间=成为它的子笔记本。落在行间空隙/列表底部时按最近一行判定，绝不擅自改变层级。
  const zoneAt = (e: React.DragEvent): { pos: 'before' | 'inside' | 'after'; id: string; y: number } | null => {
    const from = dragNbRef.current
    const cont = treeRef.current
    if (!from || !cont) return null
    const rows = Array.from(cont.querySelectorAll<HTMLElement>('[data-nb-row]'))
    if (!rows.length) return null
    const y = e.clientY
    let target: HTMLElement | null = null
    let pos: 'before' | 'inside' | 'after' = 'inside'
    for (const r of rows) {
      const rect = r.getBoundingClientRect()
      if (y < rect.top) {
        target = r
        pos = 'before'
        break
      }
      if (y <= rect.bottom) {
        const rel = (y - rect.top) / Math.max(1, rect.height)
        target = r
        pos = rel < 0.3 ? 'before' : rel > 0.7 ? 'after' : 'inside'
        break
      }
    }
    if (!target) {
      target = rows[rows.length - 1]
      pos = 'after'
    }
    const id = target.dataset['nbRow'] || ''
    if (!id) return null
    // 不能落到自己或自己的子树里（否则等于把笔记本挪进自身）
    if (id === from || subtreeIds(from).includes(id)) return null
    // 插入线用「绝对定位的浮层」画，不占布局 -> 行不会位移，落点判定不会左右横跳
    let yPx = 0
    const contRect = cont.getBoundingClientRect()
    if (pos === 'before') {
      yPx = target.getBoundingClientRect().top - contRect.top + cont.scrollTop
    } else {
      const d = Number(target.dataset['nbDepth'] ?? '0')
      const idx = rows.indexOf(target)
      let last: HTMLElement = target
      for (let i = idx + 1; i < rows.length; i++) {
        if (Number(rows[i].dataset['nbDepth'] ?? '0') <= d) break
        last = rows[i]
      }
      yPx = last.getBoundingClientRect().bottom - contRect.top + cont.scrollTop
    }
    return { pos, id, y: yPx }
  }

  /** 把 from 放到 target 的前/后（同级）或成为它的子笔记本，再对涉及的父级重排 ord */
  const applyNbMove = async (from: string, targetId: string, pos: 'before' | 'inside' | 'after'): Promise<void> => {
    const target = notebooks.find((n) => n.id === targetId)
    if (!target) return
    const oldParent = notebooks.find((n) => n.id === from)?.parentId ?? null
    const newParent = pos === 'inside' ? target.id : (target.parentId ?? null)
    const sibs = children(newParent).filter((n) => n.id !== from)
    let idx = sibs.length
    if (pos !== 'inside') {
      const ti = sibs.findIndex((n) => n.id === target.id)
      idx = pos === 'before' ? Math.max(0, ti) : ti + 1
    }
    const orderedIds = [...sibs.slice(0, idx).map((n) => n.id), from, ...sibs.slice(idx).map((n) => n.id)]
    const updates: Array<{ id: string; parentId: string | null; ord: number }> = orderedIds.map((id, i) => ({
      id,
      parentId: newParent,
      ord: i
    }))
    if (oldParent !== newParent) {
      children(oldParent)
        .filter((n) => n.id !== from)
        .forEach((n, i) => updates.push({ id: n.id, parentId: oldParent, ord: i }))
    }
    await window.api.notebooks.reorder(updates)
    await load()
    const openId = pos === 'inside' ? target.id : newParent
    if (openId) setExpanded((prev) => ({ ...prev, [openId]: true }))
  }

  const onNbDragStart = (nb: Notebook) => (e: React.DragEvent): void => {
    dragNbRef.current = nb.id
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-wn-notebook', nb.id)
    e.stopPropagation()
  }
  const onTreeDragOver = (e: React.DragEvent): void => {
    if (!dragNbRef.current) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const z = zoneAt(e)
    setDropMark(z ? `nb:${z.id}:${z.pos}` : null)
    setLineY(z && z.pos !== 'inside' ? z.y : null)
  }
  const onTreeDrop = (e: React.DragEvent): void => {
    if (!dragNbRef.current) return
    e.preventDefault()
    e.stopPropagation()
    const from = dragNbRef.current
    const z = zoneAt(e)
    dragNbRef.current = null
    setDropMark(null)
    setLineY(null)
    if (!from || !z) return
    void applyNbMove(from, z.id, z.pos)
  }
  // 行内：只处理「从 Notes 视图拖来的笔记」，笔记本拖动交给容器统一判定
  const onNbRowDragOver = (nb: Notebook) => (e: React.DragEvent): void => {
    if (dragNbRef.current) return
    if (!e.dataTransfer.types.includes('text/plain')) return
    e.preventDefault()
    e.stopPropagation()
    setDropMark(`nb:${nb.id}:inside`)
  }
  const onNbRowDrop = (nb: Notebook) => (e: React.DragEvent): void => {
    if (dragNbRef.current) return
    if (!e.dataTransfer.getData('text/plain')) return
    void dropNoteOn(nb.id)(e)
  }

  const renderNode = (parentId: string | null, depth: number): React.JSX.Element[] =>
    children(parentId).map((nb) => {
      const kids = notebooks.filter((n) => (n.parentId ?? null) === nb.id && (showHidden || !n.hidden))
      const isOpen = !!expanded[nb.id]
      const active = nbSel === nb.id
      const mark = dropMark
      const hl =
        mark === `nb:${nb.id}:before`
          ? 'before'
          : mark === `nb:${nb.id}:after`
            ? 'after'
            : mark === `nb:${nb.id}:inside`
              ? 'inside'
              : ''
      return (
        <div key={nb.id}>
          <div
            data-nb-row={nb.id}
            data-nb-depth={depth}
            className={`group relative flex items-center rounded-md ${
              hl === 'inside' ? 'bg-accent/15 outline outline-2 outline-accent/70' : ''
            }`}
            style={{ paddingLeft: depth * 9 }}
            draggable
            onDragStart={onNbDragStart(nb)}
            onDragEnd={() => {
              dragNbRef.current = null
              setDropMark(null)
              setLineY(null)
            }}
            onDragOver={onNbRowDragOver(nb)}
            onDrop={onNbRowDrop(nb)}
          >
            <button
              className="w-3 shrink-0 text-[9px] text-dim cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                toggleExpanded(nb.id)
              }}
            >
              {kids.length ? (isOpen ? '▾' : '▸') : ''}
            </button>
            <button
              onClick={() => setSel(nb.id)}
              title={nb.name}
              className={`flex min-w-0 flex-1 items-center justify-between rounded-md px-1 py-0.5 text-left text-[11px] transition cursor-pointer ${
                active ? 'bg-accent/15 font-medium text-accent' : 'text-fg hover:bg-surface-2'
              } ${nb.hidden ? 'opacity-45' : ''}`}
            >
              <span className="flex min-w-0 items-center gap-1">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ background: nb.color || nbColor(notebooks, nb.id) }}
                />
                <span className="min-w-0 truncate">{nb.name}</span>
              </span>
              <span className="ml-1 shrink-0 text-[9px] opacity-70">{deepCount(nb.id)}</span>
            </button>
            <button
              title={t('notes.nbMenuTip')}
              onClick={(e) => {
                e.stopPropagation()
                setMenu(menu === nb.id ? null : nb.id)
              }}
              className="shrink-0 px-1 text-[11px] text-dim opacity-0 transition group-hover:opacity-100 cursor-pointer"
            >
              …
            </button>
            {menu === nb.id && (
              <div className="absolute right-0 top-6 z-30 w-36 rounded-xl border border-edge bg-[var(--surface)] py-1 text-[11px] shadow-xl">
                {[
                  { a: 'edit', label: t('notes.nbRename') },
                  { a: 'delete', label: t('notes.nbDelete') },
                  { a: 'sub', label: t('notes.nbSubCreate') },
                  { a: 'note', label: t('notes.nbCreateNote') },
                  nb.hidden
                    ? { a: 'unhide', label: t('notes.nbUnhide') }
                    : { a: 'hide', label: t('notes.nbHide') }
                ].map((it) => (
                  <button
                    key={it.a}
                    onClick={() => void menuAction(it.a, nb)}
                    className={`block w-full px-2.5 py-1.5 text-left hover:bg-surface-2 cursor-pointer ${
                      it.a === 'delete' ? 'text-err' : ''
                    }`}
                  >
                    {it.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {isOpen && kids.length > 0 && renderNode(nb.id, depth + 1)}
        </div>
      )
    })

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col border-t border-edge/60 pt-2" onClick={() => menu && setMenu(null)}>
      {/* 全部 / 未归档 */}
      <button
        onClick={() => setSel('all')}
        className={`flex items-center justify-between rounded-md px-2 py-1 text-left text-[11px] transition cursor-pointer ${
          nbSel === 'all' ? 'bg-accent/15 font-medium text-accent' : 'text-dim hover:bg-surface-2'
        }`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--accent)' }} />
          <span className="truncate">{t('notes.all')}</span>
        </span>
        <span className="text-[9px] opacity-70">{notes.length}</span>
      </button>
      <button
        onClick={() => setSel('none')}
        onDragOver={(e) => {
          if (dragNbRef.current) return
          e.preventDefault()
          setDropMark('')
        }}
        onDragLeave={() => setDropMark((v) => (v === '' ? null : v))}
        onDrop={(e) => void dropNoteOn(null)(e)}
        className={`flex items-center justify-between rounded-md px-2 py-1 text-left text-[11px] transition cursor-pointer ${
          nbSel === 'none' ? 'bg-accent/15 font-medium text-accent' : 'text-dim hover:bg-surface-2'
        } ${dropMark === '' ? 'bg-accent/15 outline outline-2 outline-accent/70' : ''}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: '#9aa1ac' }} />
          <span className="truncate">{t('notes.unsorted')}</span>
        </span>
        <span className="text-[9px] opacity-70">{notes.filter((n) => !n.notebookId).length}</span>
      </button>

      {/* 笔记本区（可折叠） */}
      <div className="mt-1.5 flex items-center justify-between px-1">
        <button
          className="flex cursor-pointer items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-dim"
          onClick={() => setArea(!areaOpen)}
          title={t('notes.nbAreaTip')}
        >
          <span>{areaOpen ? '▾' : '▸'}</span>
          <span>{t('notes.nbTitle')}</span>
          <span className="normal-case opacity-70">{notebooks.filter((n) => !n.hidden).length}</span>
        </button>
        <button
          className="cursor-pointer rounded px-1 text-[10px] leading-none text-accent transition hover:bg-accent/15 hover:brightness-125"
          title={t('notes.nbNewTitle')}
          onClick={() => openCreate(null)}
        >
          ＋
        </button>
      </div>
      {areaOpen && (
        <div
          ref={treeRef}
          className="relative min-h-0 flex-1 overflow-y-auto pr-0.5"
          onDragOver={onTreeDragOver}
          onDrop={onTreeDrop}
        >
          {lineY !== null && (
            <div
              className="pointer-events-none absolute right-0 left-0 z-10 h-0.5 rounded-full bg-[var(--accent)]"
              style={{ top: lineY }}
            />
          )}
          <div className="mt-0.5 flex flex-col gap-0.5">
            {renderNode(null, 0)}
            {notebooks.filter((n) => !n.hidden).length === 0 && (
              <p className="px-1 py-1 text-[10px] text-dim">{t('notes.nbEmpty')}</p>
            )}
            {hiddenCount > 0 && (
              <button
                className="mt-1 cursor-pointer self-start rounded px-1 py-0.5 text-[10px] text-dim transition hover:bg-surface-2 hover:text-fg"
                onClick={() => setShowHidden((v) => !v)}
              >
                {showHidden ? t('notes.nbHideHidden', { n: hiddenCount }) : t('notes.nbShowHidden', { n: hiddenCount })}
              </button>
            )}
          </div>
        </div>
      )}

      {/* 弹窗：新建（含子笔记本）/ 重命名 / 删除（含子树警告） */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.35)] backdrop-blur-sm" onClick={() => setModal(null)}>
          <div className="panel w-80 rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold">
              {modal.kind === 'create' ? t('notes.nbNewTitle') : modal.kind === 'rename' ? t('notes.nbRenameTitle') : t('notes.nbDeleteTitle')}
            </h3>
            {modal.kind === 'delete' ? (
              <>
                <p className="mt-2 text-xs leading-relaxed text-dim">{t('notes.nbDelConfirm', { name: modal.nb.name })}</p>
                {subtreeIds(modal.nb.id).length > 1 && (
                  <p className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-xs text-err">
                    {t('notes.nbDelSubWarn', { n: subtreeIds(modal.nb.id).length - 1 })}
                  </p>
                )}
              </>
            ) : (
              <input
                autoFocus
                className="inp mt-3"
                value={name}
                placeholder={t('notes.nbNamePh')}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitModal()
                }}
              />
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-ghost !px-4 !py-1.5 text-xs" onClick={() => setModal(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary !px-4 !py-1.5 text-xs" onClick={() => void submitModal()} disabled={modal.kind !== 'delete' && !name.trim()}>
                {modal.kind === 'delete' ? t('common.delete') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
