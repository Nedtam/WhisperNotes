// 转写记录库：集中查看历史转写（原文 / AI 增强版），可直接整理成笔记（无需重新转写）
import React, { useEffect, useRef, useState } from 'react'
import { useApp } from './store'
import OrganizeDialog from './OrganizeDialog'
import { IconSparkle, IconTrash, Spinner } from './ui'
import { t } from './i18n'
import type { TranscriptionRecord, TranscriptionSummary } from '../../shared/types'

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  const y = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}-`
  return `${y}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

type ViewMode = 'raw' | 'enhanced'

/** “12,345 字符 / chars”中的单位部分 */
function charUnit(): string {
  return t('trans.chars', { n: '0' }).replace('0', '').trim()
}

export default function TranscriptionView(): React.JSX.Element {
  const tab = useApp((s) => s.tab)
  const organizing = useApp((s) => s.organizing)
  const settings = useApp((s) => s.settings)
  const [list, setList] = useState<TranscriptionSummary[] | null>(null)
  const [q, setQ] = useState('')
  const [range, setRange] = useState<'today' | '7d' | '30d' | 'all'>('all')
  const [selId, setSelId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TranscriptionRecord | null>(null)
  const [mode, setMode] = useState<ViewMode>('raw')
  const [enhancing, setEnhancing] = useState(false)
  const [showOrg, setShowOrg] = useState(false)
  const prevTabRef = useRef(tab)
  const listLoadedRef = useRef(false)

  const reload = async (keepSel = true): Promise<void> => {
    try {
      const items = await window.api.transcriptions.list()
      setList(items)
      if (keepSel && selId) {
        if (!items.some((i) => i.id === selId)) {
          setSelId(null)
          setDetail(null)
        }
      } else if (!keepSel) {
        setSelId(null)
        setDetail(null)
      }
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: t('trans.loadFail') + ((e as Error).message || '') })
    }
  }

  // 首次加载 + 每次切到本页刷新（保证刚归档的记录可见）
  useEffect(() => {
    if (!listLoadedRef.current) {
      listLoadedRef.current = true
      void reload()
    } else if (prevTabRef.current !== tab && tab === 'transcripts') {
      void reload(true)
    }
    prevTabRef.current = tab
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const openDetail = async (id: string): Promise<void> => {
    setSelId(id)
    setDetail(null) // 先清空，立即感
    try {
      const rec = await window.api.transcriptions.get(id)
      if (!rec) return
      setDetail(rec)
      // 有增强版时默认展示增强版
      setMode(rec.enhancedText && rec.enhancedText.length > 0 ? 'enhanced' : 'raw')
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: t('trans.loadFail') + ((e as Error).message || '') })
    }
  }

  const ensureKey = (): boolean => {
    if (settings?.llm.apiKey) return true
    useApp.getState().toastMsg({ kind: 'info', msg: t('cap.needKey') })
    useApp.getState().setTab('settings')
    return false
  }

  const generateEnhanced = async (): Promise<void> => {
    if (!detail || enhancing || organizing) return
    if (!ensureKey()) return
    const raw = detail.rawText.trim()
    if (!raw) return
    setEnhancing(true)
    try {
      const res = await window.api.llm.polish({ sourceText: raw })
      await window.api.transcriptions.save({ id: detail.id, enhancedText: res.text, keepEnhanced: false })
      const rec = await window.api.transcriptions.get(detail.id)
      if (rec) setDetail(rec)
      setMode('enhanced')
      useApp.getState().toastMsg({ kind: 'ok', msg: t('trans.genOk') })
      await reload(true)
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: t('trans.genFail') + ((e as Error).message || '') })
    } finally {
      setEnhancing(false)
    }
  }

  const removeRecord = async (): Promise<void> => {
    if (!detail) return
    if (!window.confirm(t('trans.deleteConfirm'))) return
    try {
      await window.api.transcriptions.remove(detail.id)
      useApp.getState().toastMsg({ kind: 'ok', msg: t('trans.deleted') })
      await reload(false)
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: (e as Error).message || 'delete failed' })
    }
  }

  const currentText = (): string => {
    if (!detail) return ''
    return mode === 'enhanced' && detail.enhancedText ? detail.enhancedText : detail.rawText
  }

  const startOrganize = (): void => {
    if (!detail || organizing) return
    if (!currentText().trim()) return
    if (!ensureKey()) return
    setShowOrg(true)
  }

  const inRange = (ts: number): boolean => {
    if (range === 'all') return true
    const now = new Date()
    if (range === 'today') {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      return ts >= start
    }
    const days = range === '7d' ? 7 : 30
    return ts >= Date.now() - days * 24 * 60 * 60 * 1000
  }
  const filtered = list?.filter(
    (i) =>
      inRange(i.createdAt) &&
      (!q.trim() ||
        i.title.toLowerCase().includes(q.toLowerCase()) ||
        i.sourceName.toLowerCase().includes(q.toLowerCase()) ||
        i.preview.toLowerCase().includes(q.toLowerCase()))
  )

  const showEmpty = list !== null && list.length === 0
  const hasEnhanced = !!detail?.enhancedText && detail.enhancedText.length > 0

  return (
    <div className="flex h-full gap-4">
      {/* 左：记录列表 */}
      <div className="panel flex w-[320px] shrink-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-edge/60 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold">{t('trans.title')}</h2>
            <p className="truncate text-[11px] text-[color:var(--dim)]">
              {list ? `${list.length} · ${t('trans.subtitle').split('。')[0]}` : '…'}
            </p>
          </div>
          <button className="btn-ghost shrink-0 !px-3 !py-1.5 text-xs" onClick={() => void reload(true)} title={t('trans.refresh')}>
            ↻ {t('trans.refresh')}
          </button>
        </div>

        <div className="border-b border-edge/60 px-3 py-2">
          <input className="inp !py-1.5 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('trans.searchPh')} />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {([
              ['today', t('trans.rangeToday')],
              ['7d', t('trans.range7d')],
              ['30d', t('trans.range30d')],
              ['all', t('trans.rangeAll')]
            ] as Array<['today' | '7d' | '30d' | 'all', string]>).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setRange(v)}
                className={`rounded-full px-2 py-0.5 text-[10px] transition cursor-pointer ${
                  range === v ? 'bg-accent/15 font-medium text-accent' : 'bg-[var(--surface-2)] text-dim hover:brightness-105'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {showEmpty && (
            <div className="px-3 py-8 text-center">
              <p className="text-sm text-[color:var(--dim)]">{t('trans.emptyTitle')}</p>
              <p className="mt-2 text-xs leading-relaxed text-[color:var(--dim)]/80">{t('trans.emptyHint')}</p>
              <button className="btn-primary mt-4 !py-2 text-xs" onClick={() => useApp.getState().setTab('capture')}>
                {t('trans.goCapture')}
              </button>
            </div>
          )}
          {list !== null && list.length > 0 && filtered && filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-[color:var(--dim)]">{t('trans.emptyList')}</p>
          )}
          {list === null && (
            <div className="flex justify-center py-8">
              <Spinner size={20} />
            </div>
          )}
          <div className="space-y-1.5">
            {filtered?.map((i) => {
              const active = i.id === selId
              return (
                <button
                  key={i.id}
                  onClick={() => void openDetail(i.id)}
                  className={`block w-full cursor-pointer rounded-xl border px-3 py-2.5 text-left transition ${
                    active
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-transparent bg-[var(--surface-2)] hover:brightness-105'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{i.title || i.sourceName}</span>
                    {i.hasEnhanced && (
                      <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-300">
                        ✨{t('trans.enhancedBadge')}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10.5px] text-[color:var(--dim)]">
                    <span className="shrink-0 rounded bg-surface-3 px-1 py-px">
                      {i.source === 'import' ? '📁' : '🎙'} {i.source === 'import' ? t('trans.sourceImport') : t('trans.sourceMic')}
                    </span>
                    <span className="truncate">{fmtDate(i.createdAt)}</span>
                    <span className="shrink-0">{i.rawLen.toLocaleString()} {charUnit()}</span>
                  </div>
                  {i.preview && <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-[color:var(--dim)]/90">{i.preview}</p>}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* 右：详情 */}
      <div className="panel flex min-w-0 flex-1 flex-col overflow-hidden" style={{ minWidth: 420 }}>
        {!detail ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[color:var(--dim)]">
            <div className="flex h-12 w-12 items-center justify-center rounded-full" style={{ background: 'var(--surface-3)' }}>
              <IconSparkle />
            </div>
            <p className="text-sm">{list && list.length > 0 ? t('trans.pickHint') : t('trans.emptyTitle')}</p>
            {showEmpty && <p className="max-w-md text-center text-xs leading-relaxed">{t('trans.emptyHint')}</p>}
          </div>
        ) : (
          <>
            {/* 头部 */}
            <div className="flex items-start justify-between gap-3 border-b border-edge/60 px-5 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-base font-semibold">{detail.title || detail.sourceName}</h3>
                  <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[10px] text-[color:var(--dim)]">
                    {detail.source === 'import' ? `📁 ${t('trans.sourceImport')}` : `🎙 ${t('trans.sourceMic')}`}
                  </span>
                  {hasEnhanced && (
                    <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-300">
                      ✨{t('trans.enhancedBadge')}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-[color:var(--dim)]">
                  {fmtDate(detail.createdAt)}
                  {detail.sourceName ? ` · ${detail.sourceName}` : ''} · {detail.rawText.length.toLocaleString()} {charUnit()} ·{' '}
                  {t('trans.duration', { dur: fmtDur(detail.durationMs) })}
                </p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button className="btn-ghost !px-3 !py-2 text-xs" onClick={() => void generateEnhanced()} disabled={enhancing || organizing}>
                  {enhancing ? <Spinner size={13} /> : <IconSparkle />}
                  {hasEnhanced ? t('trans.regenerate') : t('trans.genEnhanced')}
                </button>
                <button className="btn-danger !px-3 !py-2 text-xs" onClick={() => void removeRecord()} disabled={enhancing || organizing} title={t('trans.delete')}>
                  <IconTrash />
                </button>
              </div>
            </div>

            {/* 版本切换 */}
            <div className="flex items-center gap-2 border-b border-edge/60 px-5 py-2">
              <button
                onClick={() => setMode('raw')}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${
                  mode === 'raw' ? 'bg-accent/15 text-accent' : 'text-dim hover:bg-surface-2'
                }`}
              >
                {t('trans.viewRaw')} · {detail.rawText.length.toLocaleString()}
              </button>
              <button
                onClick={() => hasEnhanced && setMode('enhanced')}
                disabled={!hasEnhanced}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
                  mode === 'enhanced' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300' : 'text-dim hover:bg-surface-2'
                }`}
              >
                ✨ {t('trans.viewEnhanced')}
                {hasEnhanced ? ` · ${(detail.enhancedText || '').length.toLocaleString()}` : ''}
              </button>
              {!hasEnhanced && <span className="ml-1 text-[10.5px] text-[color:var(--dim)]">{t('trans.noEnhanced')}</span>}
            </div>

            {/* 正文 */}
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-5 py-3 font-mono text-[12.5px] leading-6 text-[var(--fg)]">
              {currentText() || '—'}
            </pre>

            {/* 底部动作 */}
            <div className="flex items-center justify-between gap-3 border-t border-edge/60 px-5 py-3">
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[color:var(--dim)]">
                <IconSparkle />
                <span className="truncate">{t('trans.organizeHint')}</span>
                <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px]">
                  {mode === 'enhanced' ? `✨ ${t('trans.viewEnhanced')}` : t('trans.viewRaw')}
                </span>
              </span>
              <button
                className="btn-primary shrink-0"
                onClick={startOrganize}
                disabled={organizing || !currentText().trim() || enhancing}
              >
                {organizing && <Spinner size={14} />}
                {organizing ? t('trans.organizing') : t('trans.organize')}
              </button>
            </div>
          </>
        )}
      </div>

      {showOrg && detail && (
        <OrganizeDialog
          title={detail.title || detail.sourceName || t('trans.title')}
          sourceText={currentText()}
          onClose={() => setShowOrg(false)}
        />
      )}
    </div>
  )
}
