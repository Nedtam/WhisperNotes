// 文档 → 笔记对话框（笔记页用）：选文件 → 解析 → 只从文档抓要点生成笔记
// 与语音那条线的区别：这里没有转写、没有课件参考、不需要 whisper；
// 文档就是唯一内容来源，输出默认「要点式」，要点后可带 (p.12) 页码回查。
import React, { useEffect, useRef, useState } from 'react'
import { useApp, runOrganize } from './store'
import type { NoteLength } from '../../shared/types'
import { Spinner } from './ui'
import { t, tError } from './i18n'
import { MAX_ORGANIZE_CHARS } from '../../shared/limits'

const LENGTHS: Array<{ id: NoteLength; nameKey: string; descKey: string; icon: string }> = [
  { id: 'keypoints', nameKey: 'org.len.keypoints', descKey: 'org.len.keypointsDesc', icon: '🎯' },
  { id: 'concise', nameKey: 'org.len.concise', descKey: 'org.len.conciseDesc', icon: '⚡' },
  { id: 'standard', nameKey: 'org.len.standard', descKey: 'org.len.standardDesc', icon: '◆' },
  { id: 'detailed', nameKey: 'org.len.detailed', descKey: 'org.len.detailedDesc', icon: '📖' }
]

interface Parsed {
  fileName: string
  filePath: string
  kind: string
  pages: Array<{ n: number; text: string }>
  chars: number
  passwordNeeded?: boolean
  emptyText?: boolean
}

export default function DocNoteDialog({
  filePath,
  onClose
}: {
  /** 已经选好的文件（拖进来的或对话框选的） */
  filePath: string
  onClose: () => void
}): React.JSX.Element {
  const organizing = useApp((s) => s.organizing)
  const [doc, setDoc] = useState<Parsed | null>(null)
  const [error, setError] = useState('')
  const [pwd, setPwd] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  const [title, setTitle] = useState('')
  const [length, setLength] = useState<NoteLength>('keypoints')
  const [cite, setCite] = useState(true)
  const startedRef = useRef(false)

  const load = async (password = ''): Promise<void> => {
    setError('')
    try {
      const d = (await window.api.doc.parse(filePath, password)) as Parsed
      setDoc(d)
      if (d.passwordNeeded) return
      setTitle((cur) => cur || d.fileName.replace(/\.[a-z0-9]{2,5}$/i, ''))
    } catch (e) {
      setError(tError((e as Error).message || ''))
    }
  }

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const unlock = async (): Promise<void> => {
    if (!pwd.trim()) return
    setUnlocking(true)
    try {
      await load(pwd.trim())
    } finally {
      setUnlocking(false)
    }
  }

  const start = async (): Promise<void> => {
    if (!doc || organizing) return
    // 生成给模型的正文：每页带 [p.N] 标记；不要页码时把标记去掉
    let text = doc.pages
      .map((p) => (cite ? `[p.${p.n}]\n${p.text}` : p.text))
      .join('\n\n')
      .trim()
    if (!text) return
    // 超长文档：主进程有 30 万字上限，这里按页边界截断并明确告诉用户（而不是让它直接报错）
    if (text.length > MAX_ORGANIZE_CHARS) {
      text = text.slice(0, MAX_ORGANIZE_CHARS)
      const cut = text.lastIndexOf('[p.')
      if (cut > MAX_ORGANIZE_CHARS * 0.8) text = text.slice(0, cut)
      useApp.getState().toastMsg({ kind: 'warn', msg: t('doc.trimmed', { max: Math.round(MAX_ORGANIZE_CHARS / 10000) }) })
    }
    const r = await runOrganize(
      {
        title: title.trim() || doc.fileName,
        sourceText: text,
        source: 'document',
        kind: 'doc',
        docName: doc.fileName,
        length,
        templateId: 'study'
      },
      { auto: false }
    )
    if (r.ok) useApp.getState().toastMsg({ kind: 'ok', msg: t('doc.started', { file: doc.fileName }) })
    onClose()
  }

  const charUnit = (): string => t('notes.charUnit')

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(0,0,0,0.4)] backdrop-blur-sm"
      onClick={organizing ? undefined : onClose}
    >
      <div className="panel w-[560px] max-w-[92vw] rounded-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold">{t('doc.title')}</h3>
        <p className="mt-1 text-xs text-[color:var(--dim)]">{t('doc.hint')}</p>

        <div className="mt-3 rounded-xl border border-edge bg-[var(--surface-2)] px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{doc?.fileName ?? filePath.split('/').pop()}</span>
            {doc && !doc.passwordNeeded && (
              <span className="shrink-0 text-xs text-[color:var(--dim)]">
                {doc.kind.toUpperCase()} · {doc.pages.length} {t('doc.units')} · {doc.chars.toLocaleString()} {charUnit()}
              </span>
            )}
          </div>
        </div>

        {!doc && !error && (
          <div className="mt-4 flex justify-center py-6">
            <Spinner size={20} />
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>
        )}

        {doc?.passwordNeeded && (
          <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
            <p className="text-xs text-amber-600 dark:text-amber-300">{t('doc.pwdHint')}</p>
            <div className="mt-2 flex gap-2">
              <input
                className="inp flex-1"
                type="password"
                value={pwd}
                placeholder={t('common.passwordPh')}
                onChange={(e) => setPwd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void unlock()
                }}
              />
              <button className="btn-primary shrink-0 !py-1.5 text-xs" onClick={() => void unlock()} disabled={unlocking || !pwd.trim()}>
                {unlocking ? <Spinner size={13} /> : t('doc.unlock')}
              </button>
            </div>
          </div>
        )}

        {doc?.emptyText && !doc.passwordNeeded && (
          <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300">
            {t('doc.noText')}
          </div>
        )}

        {doc && !doc.passwordNeeded && !doc.emptyText && (
          <>
            <div className="mt-4">
              <span className="lbl">{t('org.titleLabel')}</span>
              <input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>

            <div className="mt-4">
              <span className="lbl">{t('doc.lengthLabel')}</span>
              <div className="grid grid-cols-4 gap-2">
                {LENGTHS.map((l) => (
                  <button
                    key={l.id}
                    data-doc-length={l.id}
                    onClick={() => setLength(l.id)}
                    className={`cursor-pointer rounded-xl border p-2.5 text-left transition ${
                      length === l.id ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-edge bg-[var(--surface-2)] hover:brightness-105'
                    }`}
                  >
                    <div className="text-xs font-medium">
                      <span className="mr-1">{l.icon}</span>
                      {t(l.nameKey)}
                    </div>
                    <div className="mt-0.5 text-[10px] leading-snug text-[color:var(--dim)]">{t(l.descKey)}</div>
                  </button>
                ))}
              </div>
            </div>

            <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-[color:var(--fg)]">
              <input type="checkbox" checked={cite} onChange={(e) => setCite(e.target.checked)} />
              {t('doc.cite')}
            </label>
          </>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button className="btn-ghost" onClick={onClose} disabled={organizing}>
            {t('common.cancel')}
          </button>
          <button
            data-doc-run="1"
            className="btn-primary"
            onClick={() => void start()}
            disabled={organizing || !doc || !!doc.passwordNeeded || !!doc.emptyText || doc.chars < 40}
          >
            {organizing && <Spinner size={14} />}
            {organizing ? t('rec.organizing') : t('doc.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
