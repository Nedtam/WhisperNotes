// 笔记库视图（单编辑模式：所见即所得 Markdown）
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, isNoteDeleted, markNoteDeleted, refreshNotes, type PendingNote } from './store'
import type { NoteRecord as SharedNote, Notebook } from '../../shared/types'
import { extractToc } from './md'
import MdEditor, { type PickedImage } from './MdEditor'
import OrganizeDialog from './OrganizeDialog'
import { IconExport, IconSave, IconTrash, Spinner, SplitterV } from './ui'
import { t, tError } from './i18n'

const TEMPLATE_DEFS: Array<{ id: string; key: string }> = [
  { id: 'study', key: 'tpl.study' },
  { id: 'outline', key: 'tpl.outline' },
  { id: 'cornell', key: 'tpl.cornell' },
  { id: 'actions', key: 'tpl.actions' },
  { id: 'custom', key: 'tpl.custom' }
]

const DRAFT_KEY = 'wn-edit-draft'

const DOT_PALETTE = [
  '#f87171', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa', '#f472b6',
  '#2dd4bf', '#fb923c', '#a3e635', '#38bdf8', '#e879f9', '#facc15'
]

/** 笔记本圆点颜色：未归档 → 灰；颜色为空时按 id 稳定取色 */
function notebookColor(notebooks: Notebook[], nbId: string | null | undefined): string {
  if (!nbId) return '#9aa1ac'
  const nb = notebooks.find((x) => x.id === nbId)
  if (nb?.color) return nb.color
  let h = 0
  for (let i = 0; i < nbId.length; i++) h = (h * 31 + nbId.charCodeAt(i)) >>> 0
  return DOT_PALETTE[h % DOT_PALETTE.length]
}

interface DraftData {
  id?: string
  title: string
  noteMd: string
  sourceText: string
  templateId: string
  durationMs: number
  tags: string[]
  ts: number
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function readDraft(): DraftData | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    return raw ? (JSON.parse(raw) as DraftData) : null
  } catch {
    return null
  }
}
function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY)
  } catch {
    /* ignore */
  }
}

export default function NotesView(): React.JSX.Element {
  const pending = useApp((s) => s.pending)
  const settings = useApp((s) => s.settings)
  const saving = useApp((s) => s.saving)
  const organizing = useApp((s) => s.organizing)
  const orgProgress = useApp((s) => s.orgProgress)

  const [showRaw, setShowRaw] = useState(false)
  const [query, setQuery] = useState('')
  const [searchHits, setSearchHits] = useState<Array<{ id: string; title: string; updatedAt: number; durationMs: number; tags: string[]; snippet: string }> | null>(null)
  const [showOrg, setShowOrg] = useState(false)
  // 笔记本导航在左侧全局栏（NotesNav），这里只读 store
  const notebooks = useApp((st) => st.notebooks)
  const nbSel = useApp((st) => st.nbSel)
  const [movingId, setMovingId] = useState<string | null>(null)
  const dragNoteRef = useRef<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)

  // 自定义拖动影像：小胶囊「笔记本色圆点 + 笔记名」，热点在左上角，
  // 影像悬在光标右下方，不会遮住要放去的笔记本行。
  const dragGhost = (e: React.DragEvent, title: string, color: string): void => {
    const el = document.createElement('div')
    Object.assign(el.style, {
      position: 'fixed',
      top: '-1000px',
      left: '0',
      zIndex: '9999',
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      maxWidth: '190px',
      padding: '4px 11px 4px 9px',
      borderRadius: '999px',
      background: 'rgba(24,30,46,0.94)',
      border: '1px solid rgba(120,150,220,0.55)',
      boxShadow: '0 8px 22px rgba(0,0,0,0.45)',
      color: '#e8eeff',
      fontSize: '12px',
      lineHeight: '14px',
      fontWeight: '500',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      pointerEvents: 'none'
    } as Partial<CSSStyleDeclaration>)
    const dot = document.createElement('span')
    Object.assign(dot.style, {
      flex: '0 0 auto',
      width: '9px',
      height: '9px',
      borderRadius: '50%',
      background: color
    } as Partial<CSSStyleDeclaration>)
    const label = document.createElement('span')
    Object.assign(label.style, {
      minWidth: '0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    } as Partial<CSSStyleDeclaration>)
    label.textContent = title || t('notes.untitled')
    el.append(dot, label)
    document.body.appendChild(el)
    e.dataTransfer.setDragImage(el, 14, 12)
    setTimeout(() => el.remove(), 0)
  }

  const nbSubtreeIds = (id: string): string[] => {
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
  const flatNotebooks = (): Array<{ nb: Notebook; depth: number }> => {
    const out: Array<{ nb: Notebook; depth: number }> = []
    const walk = (parentId: string | null, depth: number): void => {
      for (const nb of notebooks
        .filter((n) => (n.parentId ?? null) === parentId)
        .sort((x, y) => (x.ord ?? 0) - (y.ord ?? 0))) {
        out.push({ nb, depth })
        walk(nb.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }


  // 本地编辑缓冲（md）+ 撤销栈
  const [text, setText] = useState<string>('')
  // ── 自动保存 ──
  const lastSavedRef = useRef('')
  const saveRef = useRef<(p: PendingNote | null, md: string, toast: boolean) => Promise<void>>(async () => {})
  const tabNow = useApp((st) => st.tab)
  const prevTabRef = useRef(tabNow)

  const textRef = useRef(text)
  const pastRef = useRef<string[]>([])
  const futureRef = useRef<string[]>([])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  // 主窗 → 子窗实时同步：本地编辑防抖广播（不写库）
  const syncTimerRef = useRef<number | null>(null)
  const syncPayloadRef = useRef('')

  const broadcastLocalEdit = (id: string, title: string, md: string): void => {
    const payload = JSON.stringify({ id, title, noteMd: md })
    if (payload === syncPayloadRef.current) return
    syncPayloadRef.current = payload
    window.api.notes.broadcastEdit({ id, title, noteMd: md })
  }
  const scheduleSync = (): void => {
    const cur = pendingRef.current
    if (!cur?.id) return
    const id = cur.id
    const title = cur.title ?? ''
    const md = textRef.current
    if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current)
    syncTimerRef.current = window.setTimeout(() => broadcastLocalEdit(id, title, md), 450)
  }
  // 切换笔记时清掉待发广播，避免旧内容串到新笔记
  useEffect(() => {
    if (syncTimerRef.current) {
      window.clearTimeout(syncTimerRef.current)
      syncTimerRef.current = null
    }
  }, [pending?.id])

  const patch = (p: Partial<PendingNote>): void => {
    const cur = useApp.getState().pending
    if (cur) useApp.getState().setPending({ ...cur, ...p })
  }

  // 笔记切换/外部生成 → 重置本地缓冲
  useEffect(() => {
    const md = pending?.noteMd ?? ''
    if (md !== textRef.current) {
      textRef.current = md
      setText(md)
      pastRef.current = []
      futureRef.current = []
      setCanUndo(false)
      setCanRedo(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.noteMd])

  const setLocalText = (next: string): void => {
    textRef.current = next
    setText(next)
    if (pendingRef.current) {
      useApp.getState().setPending({ ...pendingRef.current, noteMd: next })
    }
  }

  // WYSIWYG 编辑器输入：记录撤销快照
  const onTextChange = (next: string): void => {
    const prev = textRef.current
    if (prev === next) return
    pastRef.current.push(prev)
    if (pastRef.current.length > 100) pastRef.current.shift()
    futureRef.current = []
    setCanRedo(false)
    setCanUndo(true)
    setLocalText(next)
    scheduleSync()
  }

  const undo = (): void => {
    const cur = textRef.current
    const prev = pastRef.current.pop()
    if (prev === undefined) return
    futureRef.current.push(cur)
    setCanRedo(true)
    setCanUndo(pastRef.current.length > 0)
    setLocalText(prev)
    scheduleSync()
  }
  const redo = (): void => {
    const cur = textRef.current
    const next = futureRef.current.pop()
    if (next === undefined) return
    pastRef.current.push(cur)
    setCanUndo(true)
    setCanRedo(futureRef.current.length > 0)
    setLocalText(next)
    scheduleSync()
  }

  // 自动备份草稿
  useEffect(() => {
    const p = pending
    if (!p) return
    const timer = setTimeout(() => {
      const d: DraftData = {
        id: p.id,
        title: p.title,
        noteMd: text,
        sourceText: p.sourceText,
        templateId: p.templateId,
        durationMs: p.durationMs,
        tags: p.tags,
        ts: Date.now()
      }
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(d))
      } catch {
        /* ignore */
      }
    }, 1200)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, pending?.title, pending?.tags, pending?.sourceText])

  const draft = useMemo(() => (pending ? null : readDraft()), [pending])
  const list = searchHits

  const loadList = async (): Promise<void> => {
    const notes = await window.api.notes.list()
    useApp.getState().setNotes(notes)
  }
  useEffect(() => {
    void loadList()
  }, [])

  const moveNote = async (noteId: string, notebookId: string): Promise<void> => {
    await window.api.notes.setNotebook(noteId, notebookId || null)
    const st = useApp.getState()
    if (st.pending?.id === noteId) st.setPending({ ...st.pending, notebookId: notebookId || null })
    await loadList()
  }

  // 拖拽换位（「全部笔记」「未归档」；笔记本里的顺序由结构+日期自动决定）
  const dropOnNote = (targetId: string) => (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const from = dragNoteRef.current
    dragNoteRef.current = null
    if (!from || from === targetId) return
    if (searchHits || (nbSel !== 'all' && nbSel !== 'none')) return
    const ids = allNotes.map((n) => n.id)
    const fi = ids.indexOf(from)
    const ti = ids.indexOf(targetId)
    if (fi < 0 || ti < 0) return
    ids.splice(fi, 1)
    ids.splice(ti, 0, from)
    void window.api.notes.reorder(ids).then(() => loadList())
  }

  // 独立编辑窗的外部同步
  useEffect(() => {
    return window.api.onNoteSync((p) => {
      const st = useApp.getState()
      const cur = st.pending
      if (cur?.id === p.id) {
        const next = { ...cur, noteMd: p.noteMd, title: p.title || cur.title }
        if (next.noteMd !== cur.noteMd || next.title !== cur.title) st.setPending(next)
      }
    })
  }, [])

  useEffect(() => {
    if (!query.trim()) {
      setSearchHits(null)
      return
    }
    const q = query.trim()
    const timer = setTimeout(async () => {
      try {
        setSearchHits(await window.api.notes.search(q))
      } catch {
        /* ignore */
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  const openNote = (n: SharedNote): void => {
    useApp.getState().setPending({
      id: n.id,
      title: n.title,
      noteMd: n.noteMd,
      sourceText: n.sourceText,
      templateId: n.templateId,
      notebookId: n.notebookId ?? null,
      durationMs: n.durationMs,
      tags: n.tags ?? []
    })
  }

  const newNote = (): void => {
    const cur = useApp.getState().pending
    if (cur) void saveRef.current(cur, textRef.current, false)
    useApp.getState().setPending({
      title: '',
      noteMd: '',
      sourceText: '',
      templateId: settings?.llm.templateId ?? 'study',
      notebookId: nbSel === 'all' || nbSel === 'none' ? null : nbSel,
      durationMs: 0,
      tags: []
    })
  }

  const restoreDraft = (): void => {
    const d = readDraft()
    if (!d) return
    useApp.getState().setPending({
      id: d.id,
      title: d.title,
      noteMd: d.noteMd,
      sourceText: d.sourceText,
      templateId: d.templateId,
      durationMs: d.durationMs,
      tags: d.tags
    })
    useApp.getState().toastMsg({ kind: 'info', msg: t('notes.draftRestored', { ts: fmtDate(d.ts) }) })
  }

  /** 保存当前快照（toast=false 用于自动保存，静默） */
  const saveSnapshot = async (p: PendingNote | null, md: string, toast: boolean): Promise<void> => {
    if (!p) return
    // 已删除的笔记不再写回（否则会把它“复活”）
    if (isNoteDeleted(p.id)) return
    const key = `${p.id ?? 'new'}|${p.title}|${md}`
    if (key === lastSavedRef.current) return
    if (!p.id && !md.trim() && !p.title.trim() && !p.sourceText.trim()) return
    if (toast) useApp.getState().setSaving(true)
    try {
      const saved = await window.api.notes.save({
        id: p.id,
        title: p.title || t('notes.untitled'),
        noteMd: md,
        sourceText: p.sourceText,
        templateId: p.templateId,
        notebookId: p.notebookId ?? null,
        durationMs: p.durationMs,
        tags: p.tags
      })
      lastSavedRef.current = key
      const cur = useApp.getState().pending
      if (cur && (cur.id ?? 'new') === (p.id ?? 'new')) {
        useApp.getState().setPending({ ...cur, id: saved.id })
      }
      clearDraft()
      await loadList()
      if (saved.id) {
        const payload = { id: saved.id, title: saved.title, noteMd: md }
        syncPayloadRef.current = JSON.stringify(payload)
        window.api.notes.broadcastEdit(payload)
      }
      if (toast) useApp.getState().toastMsg({ kind: 'ok', msg: t('notes.saved') })
    } catch (e) {
      if (toast) useApp.getState().toastMsg({ kind: 'err', msg: t('notes.saveFailed') + ((e as Error).message || '') })
    } finally {
      if (toast) useApp.getState().setSaving(false)
    }
  }
  saveRef.current = saveSnapshot

  const save = async (): Promise<void> => {
    await saveSnapshot(pending, textRef.current, true)
  }

  // 自动保存：30 秒 / 失焦 / 切到后台 / 退出前 / 切换标签
  useEffect(() => {
    const t30 = window.setInterval(() => {
      const cur = useApp.getState().pending
      if (cur) void saveRef.current(cur, textRef.current, false)
    }, 30_000)
    const flush = (): void => {
      const cur = useApp.getState().pending
      if (cur) void saveRef.current(cur, textRef.current, false)
    }
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('wn:autosave', flush)
    return () => {
      window.clearInterval(t30)
      window.removeEventListener('blur', flush)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('wn:autosave', flush)
    }
  }, [])

  // 切换笔记前保存上一份
  useEffect(() => {
    const cur = pending
    if (!cur) return
    const snapshot = { ...cur }
    return () => {
      void saveRef.current(snapshot, textRef.current, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id ?? 'new'])

  // 离开笔记标签页前保存
  useEffect(() => {
    if (prevTabRef.current === 'notes' && tabNow !== 'notes') {
      const cur = useApp.getState().pending
      if (cur) void saveRef.current(cur, textRef.current, false)
    }
    prevTabRef.current = tabNow
  }, [tabNow])

  const remove = async (): Promise<void> => {
    const id = pending?.id
    if (!id) return
    if (!window.confirm(t('notes.deleteConfirm', { title: pending.title }))) return
    // 关键顺序：先给这条笔记打“墓碑”并立刻取消选中，再做删除。
    // 否则在途的自动保存/整理写回会用同一 id UPSERT，把刚删掉的笔记复活（表现为“删不掉”）。
    markNoteDeleted(id)
    clearDraft()
    lastSavedRef.current = ''
    useApp.getState().setPending(null)
    try {
      const ok = await window.api.notes.remove(id)
      if (!ok) {
        useApp.getState().toastMsg({ kind: 'err', msg: t('notes.deleteFailed') })
        return
      }
      await loadList()
      await refreshNotes()
      useApp.getState().toastMsg({ kind: 'ok', msg: t('notes.deleted') })
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: t('notes.deleteFailed') + tError((e as Error).message || '') })
    }
  }

  const exportMd = async (): Promise<void> => {
    if (!pending?.id) return
    const p = await window.api.notes.exportMd(pending.id)
    if (p) useApp.getState().toastMsg({ kind: 'ok', msg: t('notes.exported') + p })
  }

  const openOrganize = (): void => setShowOrg(true)

  /** 选择并读取本地图片（供 WYSIWYG 直接插入） */
  const pickImage = async (): Promise<PickedImage | null> => {
    try {
      const img = await window.api.dialog.pickImage()
      if (!img) return null
      if (img.size > 5 * 1024 * 1024) {
        useApp.getState().toastMsg({ kind: 'info', msg: t('notes.imgLarge', { mb: (img.size / 1024 / 1024).toFixed(1) }) })
      }
      return { name: img.name, dataUrl: img.dataUrl }
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: t('notes.imgFailed') + ((e as Error).message || '') })
      return null
    }
  }

  const stats = useMemo(() => {
    const chars = textRef.current.length
    const words = (textRef.current.match(/[\p{L}\p{N}]+/gu) ?? []).length
    const lines = textRef.current ? textRef.current.split('\n').length : 0
    return { chars, words, lines, readMin: Math.max(1, Math.round(words / 200)) }
  }, [text])

  const toc = useMemo(() => extractToc(text), [text])

  const jumpHeading = (id: string): void => {
    const el = document.getElementById(id)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const addTag = (raw: string): void => {
    const v = raw.trim()
    if (!v || !pending) return
    const tags = pending.tags.includes(v) ? pending.tags : [...pending.tags, v]
    patch({ tags })
  }
  const removeTag = (v: string): void => {
    if (!pending) return
    patch({ tags: pending.tags.filter((x) => x !== v) })
  }

  const notes = useApp((s) => s.notes)
  const flashNoteId = useApp((s) => s.flashNoteId)

  type Hit = { id: string; title: string; updatedAt: number; durationMs: number; tags: string[]; snippet: string; full?: SharedNote }
  const allNotes = notes ?? []
  // 笔记本视图的顺序是「自动」的：本层笔记按日期新的在前，然后按子笔记本顺序依次递归；
  // 「全部笔记」「未归档」保持原来的手动顺序（那里的拖动排序照旧可用）。
  const nbOrder = (rootId: string): string[] => {
    const out: string[] = []
    const walk = (id: string): void => {
      out.push(id)
      for (const child of notebooks
        .filter((n) => (n.parentId ?? null) === id)
        .sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0))) {
        walk(child.id)
      }
    }
    walk(rootId)
    return out
  }
  const visibleNotes =
    searchHits || nbSel === 'all'
      ? allNotes
      : nbSel === 'none'
        ? allNotes.filter((n) => !n.notebookId)
        : (() => {
            const order = nbOrder(nbSel)
            const rank = new Map(order.map((id, i) => [id, i]))
            return allNotes
              .filter((n) => !!n.notebookId && rank.has(n.notebookId))
              .sort((a, b) => {
                const ra = rank.get(a.notebookId as string) as number
                const rb = rank.get(b.notebookId as string) as number
                if (ra !== rb) return ra - rb
                return b.updatedAt - a.updatedAt
              })
          })()
  const items: Hit[] = searchHits
    ? searchHits.map((h) => ({ id: h.id, title: h.title, updatedAt: h.updatedAt, durationMs: h.durationMs, tags: h.tags, snippet: h.snippet }))
    : visibleNotes.map((n) => ({ id: n.id, title: n.title, updatedAt: n.updatedAt, durationMs: n.durationMs, tags: n.tags, snippet: '', full: n }))

  // 刚整理出来的笔记：滚动到它的位置并高亮（AI 整理完成后自动定位）
  useEffect(() => {
    if (!flashNoteId) return
    const id = window.setTimeout(() => {
      document.querySelector(`[data-note-id="${flashNoteId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 120)
    return () => window.clearTimeout(id)
  }, [flashNoteId, items.length])
  return (
    <div className="flex h-full gap-4">
      {/* 左栏 */}
      <div
        className="flex shrink-0 flex-col gap-3"
        style={{ width: useApp((s2) => s2.layout.midW) }}
      >
        <div className="panel flex flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-edge/60 px-4 py-2.5">
            <h2 className="text-base font-semibold">{t('notes.title')}</h2>
            <span className="text-xs text-dim">{`${items.length} ${searchHits ? t('notes.resultCount') : t('notes.count')}`}</span>
          </div>
          <div className="px-3 pt-2.5">
            <input
              className="inp"
              placeholder={t('notes.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button className="btn-primary m-3 !mt-2" onClick={newNote}>
            {t('notes.new')}
          </button>
          {!pending && draft && (
            <div className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              <span className="min-w-0 truncate">{t('notes.draftAt', { time: fmtDate(draft.ts) })}</span>
              <span className="flex shrink-0 gap-2">
                <button className="cursor-pointer underline" onClick={restoreDraft}>
                  {t('notes.restore')}
                </button>
                <button
                  className="cursor-pointer text-amber-400/70 underline"
                  onClick={() => {
                    clearDraft()
                    useApp.getState().toastMsg({ kind: 'ok', msg: t('notes.draftDiscarded') })
                  }}
                >
                  {t('notes.discard')}
                </button>
              </span>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {items.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-dim">{searchHits ? t('notes.noHits') : t('notes.none')}</p>
            )}
            {items.map((n) => {
              const active = pending?.id === n.id
              const sub =
                n.snippet || (n.full?.noteMd || '').replace(/#/g, '').trim().split('\n').find((l) => l.trim()) || ''
              const nbId = n.full?.notebookId ?? null
              return (
                <div
                  key={n.id}
                  data-note-id={n.id}
                  draggable={!searchHits}
                  onDragStart={(e) => {
                    dragNoteRef.current = n.id
                    setDragId(n.id)
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', n.id)
                    if (!searchHits) dragGhost(e, n.title, notebookColor(notebooks, nbId))
                  }}
                  onDragEnd={() => {
                    dragNoteRef.current = null
                    setDragId(null)
                  }}
                  onDragOver={(e) => {
                    if (!searchHits && (nbSel === 'all' || nbSel === 'none')) e.preventDefault()
                  }}
                  onDrop={dropOnNote(n.id)}
                  className={`group mb-1 w-full cursor-grab rounded-xl border px-2 py-2 text-left transition active:cursor-grabbing ${
                    active ? 'border-accent/60 bg-accent/[0.07]' : 'border-transparent bg-surface-2 hover:brightness-105'
                  } ${dragId === n.id ? 'opacity-40' : ''} ${
                    flashNoteId === n.id ? 'ring-2 ring-[var(--accent)] ring-offset-1 ring-offset-transparent' : ''
                  }`}
                >
                  <div className="flex items-start">
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        if (n.full) openNote(n.full)
                        else void window.api.notes.get(n.id).then((full) => full && openNote(full))
                      }}
                      onDoubleClick={() => void window.api.notes.openChild(n.id)}
                      title={t('notes.rowHint')}
                      className="min-w-0 flex-1 cursor-pointer"
                    >
                      <div className="truncate text-sm font-medium text-fg">{n.title}</div>
                      <div className="mt-0.5 line-clamp-2 text-xs text-dim">{sub || `（${t('notes.empty')}）`}</div>
                      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-dim">
                        <span>{fmtDate(n.updatedAt)}</span>
                        {n.durationMs ? <span>· {Math.round(n.durationMs / 60000)} min</span> : null}
                        {n.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className="rounded-full bg-surface-3 px-1.5 py-0.5">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </div>
                    {!searchHits && n.full && (
                      <div className="flex shrink-0 items-start pl-1" onClick={(e) => e.stopPropagation()}>
                        {movingId === n.id ? (
                          <select
                            autoFocus
                            className="w-28 rounded-md border border-edge bg-surface-2 px-1 py-0.5 text-[11px] text-fg outline-none"
                            value={nbId ?? ''}
                            onChange={(e) => {
                              const v = e.target.value
                              setMovingId(null)
                              void moveNote(n.id, v)
                            }}
                            onBlur={() => setMovingId(null)}
                          >
                            <option value="">{t('notes.unsorted')}</option>
                            {flatNotebooks().map(({ nb, depth }) => (
                              <option key={nb.id} value={nb.id}>
                                {'　'.repeat(depth) + nb.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <button
                            title={nbId ? notebooks.find((x) => x.id === nbId)?.name || t('notes.moveTo') : t('notes.moveTo')}
                            onClick={() => setMovingId(n.id)}
                            className="mt-1 cursor-pointer rounded-full p-1 transition hover:bg-surface-3"
                          >
                            <span
                              className="inline-block h-2.5 w-2.5 rounded-full"
                              style={{ background: notebookColor(notebooks, nbId) }}
                            />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <SplitterV value={useApp((s2) => s2.layout.midW)} onChange={useApp((s2) => s2.setMidW)} min={150} reserveRight={460} />
      {/* 右栏 */}
      <div className="panel flex min-w-0 flex-1 flex-col overflow-hidden" style={{ minWidth: 460 }}>
        {!pending ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-dim">
            <div className="flex h-12 w-12 items-center justify-center rounded-full" style={{ background: 'var(--surface-3)' }}>
              <span className="h-3 w-3 rounded-full" style={{ background: 'var(--accent)' }} />
            </div>
            <p className="text-sm">{t('notes.placeholder1')}</p>
            <p className="text-xs">{t('notes.placeholder2')}</p>
          </div>
        ) : (
          <>
            {/* 标题栏 */}
            <div className="flex flex-wrap items-center gap-2 border-b border-edge/60 px-4 py-2">
              <input
                className="inp !w-56 min-w-40 flex-1 !py-1.5 text-base font-medium"
                value={pending.title}
                onChange={(e) => {
                  patch({ title: e.target.value })
                  scheduleSync()
                }}
                placeholder={t('notes.titlePh')}
              />
              <select
                className="inp !w-28 !py-1.5 text-xs"
                value={pending.templateId}
                onChange={(e) => patch({ templateId: e.target.value })}
                title={t('notes.tplHint')}
              >
                {TEMPLATE_DEFS.map((tp) => (
                  <option key={tp.id} value={tp.id}>
                    {t(tp.key)}
                  </option>
                ))}
              </select>
              <div className="flex gap-1.5">
                <button className="btn-ghost !px-4 !py-2 text-xs" onClick={() => void save()} disabled={saving || organizing}>
                  {saving ? <Spinner size={13} /> : <IconSave />}
                  {pending.id ? t('common.save') : t('common.saveNew')}
                </button>
                <button className="btn-ghost !px-4 !py-2 text-xs" onClick={openOrganize} disabled={organizing || !pending.sourceText.trim()}>
                  {organizing && <Spinner size={13} />} {t('common.reorganize')}
                </button>
                {pending.id && (
                  <>
                    <button className="btn-ghost !px-4 !py-2 text-xs" onClick={() => void exportMd()} title={t('common.export')}>
                      <IconExport /> {t('common.export')}
                    </button>
                    <button className="btn-danger !px-4 !py-2 text-xs" onClick={() => void remove()} title={t('common.delete')}>
                      <IconTrash />
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* 标签行 */}
            <div className="flex flex-wrap items-center gap-1.5 border-b border-edge/60 px-4 py-1.5">
              {pending.tags.map((tag) => (
                <span key={tag} className="flex items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-xs text-fg">
                  #{tag}
                  <button className="cursor-pointer text-[10px] opacity-60 hover:opacity-100" onClick={() => removeTag(tag)}>
                    ✕
                  </button>
                </span>
              ))}
              <TagInput onAdd={addTag} />
            </div>

            {organizing && orgProgress && (
              <div className="flex items-center gap-2 border-b border-accent/20 bg-accent-soft px-4 py-1.5 text-xs text-accent">
                <Spinner size={12} />
                {orgProgress.detail || t('notes.organizing')}
              </div>
            )}

            {/* WYSIWYG 编辑区（+ 右侧目录） */}
            <div className="flex min-h-0 flex-1">
              <MdEditor
                value={text}
                onChange={onTextChange}
                onUndo={undo}
                onRedo={redo}
                canUndo={canUndo}
                canRedo={canRedo}
                pickImage={pickImage}
              />
              {toc.length > 0 && (
                <div className="hidden w-48 shrink-0 overflow-y-auto border-l border-edge/60 px-3 py-3 lg:block">
                  <div className="mb-2 text-[11px] font-semibold text-dim">{t('notes.toc')}</div>
                  {toc.map((h) => (
                    <button
                      key={h.id}
                      onClick={() => jumpHeading(h.id)}
                      className={`block w-full truncate rounded px-2 py-1 text-left text-xs transition cursor-pointer hover:bg-surface-2 ${
                        h.level === 1 ? 'font-semibold' : h.level === 2 ? 'pl-4' : 'pl-6 text-dim'
                      }`}
                    >
                      {h.text}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 底部：统计 + 原始转写 */}
            <div className="flex items-center justify-between border-t border-edge/60 px-4 py-1.5 text-[11px] text-dim">
              <span className="flex items-center gap-3">
                <span>{stats.chars.toLocaleString()} {t('notes.charUnit')}</span>
                <span>{stats.words} {t('notes.wordUnit')}</span>
                <span>{stats.lines} {t('notes.lineUnit')}</span>
                <span>≈{stats.readMin} {t('notes.readMinUnit')}</span>
              </span>
              <button className="cursor-pointer hover:opacity-80" onClick={() => setShowRaw(!showRaw)}>
                ▸ {t('notes.rawToggle', { n: pending.sourceText.length.toLocaleString() })}
              </button>
            </div>
            {showRaw && (
              <pre className="max-h-40 overflow-auto border-t border-edge/60 bg-surface-2 px-4 py-3 text-[11px] leading-5 whitespace-pre-wrap text-dim">
                {pending.sourceText || `（${t('notes.noSource')}）`}
              </pre>
            )}
          </>
        )}
      </div>

      {showOrg && (
        <OrganizeDialog
          title={pending?.title || 'note'}
          sourceText={pending?.sourceText || ''}
          onClose={() => setShowOrg(false)}
        />
      )}

    </div>
  )
}

function TagInput({ onAdd }: { onAdd: (v: string) => void }): React.JSX.Element {
  const [v, setV] = useState('')
  return (
    <input
      className="w-28 rounded-full border border-dashed border-edge bg-transparent px-2 py-0.5 text-xs outline-none placeholder:text-dim"
      placeholder="+ tag"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault()
          if (v.trim()) {
            onAdd(v.trim())
            setV('')
          }
        }
      }}
      onBlur={() => {
        if (v.trim()) {
          onAdd(v.trim())
          setV('')
        }
      }}
    />
  )
}
