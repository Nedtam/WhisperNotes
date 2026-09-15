// 整理对话框：长度三档 + 课件附件（可带入本次录音已添加的 PDF/PPT，也可再选，支持加密 PDF 密码，仅本次使用）+ 运行
import React, { useRef, useState } from 'react'
import { useApp, runOrganize } from './store'
import type { DeckDescriptor, NoteLength } from '../../shared/types'
import { Spinner } from './ui'
import { t } from './i18n'

const LENGTHS: Array<{ id: NoteLength; nameKey: string; descKey: string; icon: string }> = [
  { id: 'concise', nameKey: 'org.len.concise', descKey: 'org.len.conciseDesc', icon: '⚡' },
  { id: 'standard', nameKey: 'org.len.standard', descKey: 'org.len.standardDesc', icon: '◆' },
  { id: 'detailed', nameKey: 'org.len.detailed', descKey: 'org.len.detailedDesc', icon: '📖' }
]

/** 录音页已添加的课件（含密码，仅本次内存使用） */
export interface DeckSeed {
  path: string
  fileName: string
  kind: 'pdf' | 'pptx'
  pageCount: number
  chars: number
  password: string
}

export default function OrganizeDialog({
  title,
  sourceText,
  initialDecks,
  onClose
}: {
  title: string
  sourceText: string
  initialDecks?: DeckSeed[]
  onClose: () => void
}): React.JSX.Element {
  const organizing = useApp((s) => s.organizing)
  const orgProgress = useApp((s) => s.orgProgress)
  const lastLength = useApp((s) => s.lastLength)
  const [length, setLength] = useState<NoteLength>(lastLength)
  const [decks, setDecks] = useState<DeckSeed[]>(() => (initialDecks ?? []).map((d) => ({ ...d })))
  const decksRef = useRef<DeckSeed[]>(decks)
  decksRef.current = decks
  const [dragOver, setDragOver] = useState(false)
  // 刚选、待输入密码的课件
  const [pending, setPending] = useState<DeckDescriptor | null>(null)
  const [picking, setPicking] = useState(false)
  const [pwd, setPwd] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  const [customTitle, setCustomTitle] = useState(title)

  const appendDeck = (d: DeckDescriptor, password: string): void => {
    if (decksRef.current.some((x) => x.path === d.path)) {
      useApp.getState().toastMsg({ kind: 'info', msg: t('org.deckDup') })
      return
    }
    const seed: DeckSeed = { path: d.path, fileName: d.fileName, kind: d.kind, pageCount: d.pageCount, chars: d.chars, password }
    decksRef.current = [...decksRef.current, seed]
    setDecks(decksRef.current)
  }

  /** 拖入 PDF/PPTX：与「选择文件」同流程（含加密解锁） */
  const addDroppedFiles = async (files: FileList | File[]): Promise<void> => {
    for (const f of Array.from(files).slice(0, 6)) {
      try {
        const p = await window.api.slides.fromFile(f)
        if (!p || !/\.(pdf|pptx)$/i.test(p)) continue
        const desc = await window.api.slides.parse(p)
        if (desc.passwordNeeded) {
          setPending(desc)
          setPwd('')
          continue
        }
        appendDeck(desc, '')
      } catch (e) {
        useApp.getState().toastMsg({ kind: 'err', msg: t('org.deckReadFail') + ((e as Error).message || '') })
      }
    }
  }

  const pickDeck = async (): Promise<void> => {
    setPicking(true)
    try {
      const d = await window.api.slides.pick()
      if (!d) return
      if (decks.some((x) => x.path === d.path)) {
        useApp.getState().toastMsg({ kind: 'info', msg: t('org.deckDup') })
        return
      }
      if (d.passwordNeeded) {
        setPending(d)
        setPwd('')
      } else {
        appendDeck(d, '')
      }
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: t('org.deckReadFail') + ((e as Error).message || '') })
    } finally {
      setPicking(false)
    }
  }

  const unlockPending = async (): Promise<void> => {
    if (!pending || !pwd.trim()) return
    setUnlocking(true)
    try {
      const d = await window.api.slides.unlock(pending.path, pwd.trim())
      appendDeck(d, pwd.trim())
      setPending(null)
      setPwd('')
      useApp.getState().toastMsg({ kind: 'ok', msg: t('org.unlocked', { pages: d.pageCount, chars: (d.chars / 1000).toFixed(1) }) })
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: t('org.unlockFail') + ((e as Error).message || '') })
    } finally {
      setUnlocking(false)
    }
  }

  const removeDeck = (path: string): void => {
    setDecks((prev) => prev.filter((d) => d.path !== path))
  }

  const start = async (): Promise<void> => {
    if (organizing || pending?.passwordNeeded) return
    useApp.getState().setLastLength(length)
    const paths = decks.map((d) => d.path)
    const passwords = decks.map((d) => d.password)
    const r = await runOrganize(
      {
        title: customTitle.trim() || title,
        sourceText,
        slidesPaths: paths.length ? paths : undefined,
        slidesPasswords: paths.length ? passwords : undefined,
        length
      },
      { auto: false }
    )
    if (r.ok) useApp.getState().toastMsg({ kind: 'ok', msg: t('org.done') })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(0,0,0,0.4)] backdrop-blur-sm"
      onClick={organizing ? undefined : onClose}
      onDragOver={(e) => {
        if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer?.files?.length) void addDroppedFiles(e.dataTransfer.files)
      }}
    >
      <div className="panel w-[560px] max-w-[92vw] rounded-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold">{t('org.title')}</h3>
        <p className="mt-1 text-xs text-[color:var(--dim)]">{t('org.source', { n: sourceText.length.toLocaleString() })}</p>
        {dragOver && (
          <div className="mt-3 rounded-xl border-2 border-dashed border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-2 text-center text-xs text-[var(--accent)]">
            {t('org.dropHere')}
          </div>
        )}

        <div className="mt-4">
          <span className="lbl">{t('org.titleLabel')}</span>
          <input className="inp" value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} />
        </div>

        <div className="mt-4">
          <span className="lbl">{t('org.length')}</span>
          <div className="grid grid-cols-3 gap-2">
            {LENGTHS.map((l) => (
              <button
                key={l.id}
                onClick={() => setLength(l.id)}
                className={`rounded-xl border p-3 text-left transition cursor-pointer ${
                  length === l.id
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-edge bg-[var(--surface-2)] hover:brightness-105'
                }`}
              >
                <div className="text-sm font-medium">
                  <span className="mr-1">{l.icon}</span>
                  {t(l.nameKey)}
                </div>
                <div className="mt-1 text-[11px] leading-snug text-[color:var(--dim)]">{t(l.descKey)}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between">
            <span className="lbl !mb-0">{t('org.deckLabel')}</span>
            <button className="btn-ghost !px-4 !py-2 text-xs" onClick={() => void pickDeck()} disabled={picking || organizing}>
              {picking ? <Spinner size={13} /> : t('org.pickDeck')}
            </button>
          </div>

          {decks.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {decks.map((d) => (
                <div
                  key={d.path}
                  className="flex items-center justify-between rounded-xl border border-edge bg-[var(--surface-2)] px-3 py-2 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="text-[color:var(--dim)]">📎</span>
                    <span className="truncate">{d.fileName}</span>
                    <span className="shrink-0 text-xs text-[color:var(--dim)]">
                      {d.kind.toUpperCase()} · {t('org.deckMeta', { pages: d.pageCount, chars: (d.chars / 1000).toFixed(1) })}
                    </span>
                  </span>
                  <button className="ml-2 shrink-0 text-xs text-red-400 hover:text-red-300 cursor-pointer" onClick={() => removeDeck(d.path)} disabled={organizing}>
                    {t('org.remove')}
                  </button>
                </div>
              ))}
            </div>
          )}

          {pending?.passwordNeeded && (
            <div className="mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
              <p className="text-xs text-amber-600 dark:text-amber-300">{t('org.pwdHint')}</p>
              <div className="mt-2 flex gap-2">
                <input
                  className="inp flex-1"
                  type="password"
                  value={pwd}
                  placeholder={t('common.passwordPh')}
                  onChange={(e) => setPwd(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void unlockPending()
                  }}
                />
                <button className="btn-primary shrink-0 !py-1.5 text-xs" onClick={() => void unlockPending()} disabled={unlocking || !pwd.trim()}>
                  {unlocking ? <Spinner size={13} /> : t('org.unlockRead')}
                </button>
              </div>
            </div>
          )}

          {decks.length === 0 && !pending?.passwordNeeded && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-[color:var(--dim)]">
              {t('org.deckHelp')}
            </p>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          {organizing && (
            <span className="mr-auto flex items-center gap-2 text-xs text-[color:var(--accent)]">
              <Spinner size={13} /> {orgProgress?.detail || t('rec.organizing')}
            </span>
          )}
          <button className="btn-ghost" onClick={onClose} disabled={organizing}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" onClick={() => void start()} disabled={organizing || !sourceText.trim() || !!pending?.passwordNeeded}>
            {organizing && <Spinner size={14} />}
            {organizing ? t('rec.organizing') : t('org.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
