// AI 整理进度：右下角可点击的卡片 + 详情面板（分阶段进度 / 实时日志 / 失败原因 / 历史记录）
import React, { useEffect, useRef, useState } from 'react'
import { t } from './i18n'
import { useApp, retryOrgJob, type OrgJob, type OrgJobHistory } from './store'
import { copyText } from './clipboard'

function statusText(s: OrgJob['status'] | OrgJobHistory['status']): string {
  switch (s) {
    case 'queued':
      return t('org.statusQueued')
    case 'running':
      return t('org.statusRunning')
    case 'error':
      return t('org.statusError')
    case 'canceled':
      return t('org.statusCanceled')
    default:
      return t('org.statusDone')
  }
}

function statusColor(s: OrgJob['status'] | OrgJobHistory['status']): string {
  switch (s) {
    case 'error':
      return 'text-err border-red-500/40'
    case 'canceled':
      return 'text-dim border-edge'
    case 'done':
      return 'text-emerald-300 border-emerald-500/40'
    default:
      return 'text-accent border-accent/40'
  }
}

function barColor(s: OrgJob['status']): string {
  return s === 'error' ? 'bg-red-500' : s === 'done' ? 'bg-emerald-500' : s === 'canceled' ? 'bg-surface-3' : 'bg-[var(--accent)]'
}

/** 阶段进度条：把当前 stage/part/parts 画成一个小进度 */
function stageLine(j: OrgJob): string {
  const stage = t(`org.stage.${j.stage}`)
  if (j.parts > 0) return `${stage} · ${j.part}/${j.parts}`
  return stage
}

function fmtElapsed(start: number, end: number): string {
  return t('org.elapsed', { s: Math.max(0, Math.round((end - start) / 1000)) })
}

/** 右下角卡片（点击打开详情面板） */
export function OrgJobCards(): React.JSX.Element | null {
  const jobs = useApp((s) => s.orgJobs)
  const setPanel = useApp((s) => s.setOrgPanelOpen)
  const removeJob = useApp((s) => s.removeOrgJob)
  const [, force] = useState(0)
  // 每秒刷新“已用时”
  useEffect(() => {
    if (!jobs.some((j) => j.status === 'running' || j.status === 'queued')) return
    const id = window.setInterval(() => force((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [jobs])
  if (!jobs.length) return null
  return (
    <div className="fixed right-6 bottom-6 z-40 w-80 space-y-2">
      <button
        className="cursor-pointer text-[11px] font-medium text-dim underline decoration-dotted hover:text-fg"
        onClick={() => setPanel(true)}
      >
        {t('app.orgJobsTitle')}
      </button>
      {jobs.map((j) => {
        const pct = j.parts > 0 ? Math.round((Math.min(j.part, j.parts) / j.parts) * 100) : j.status === 'done' ? 100 : 8
        return (
          <div
            key={j.jobId}
            role="button"
            tabIndex={0}
            onClick={() => setPanel(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setPanel(true)
            }}
            className={`panel cursor-pointer rounded-xl border p-3 transition hover:brightness-110 ${statusColor(j.status)}`}
            title={t('org.detail')}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs font-medium text-fg">{j.title || '…'}</span>
              <span className="shrink-0 text-[10px] opacity-90">
                {j.status === 'running' || j.status === 'queued' ? (j.parts ? `${j.part}/${j.parts}` : '…') : statusText(j.status)}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div className={`h-full rounded-full ${barColor(j.status)} transition-all`} style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px]">
              <span className="min-w-0 truncate opacity-90">{j.detail || (j.status === 'running' ? t('org.working') : statusText(j.status))}</span>
              <span className="shrink-0 opacity-70">{fmtElapsed(j.startedAt, j.status === 'running' ? Date.now() : j.updatedAt)}</span>
            </div>
            {j.error && <div className="mt-1.5 line-clamp-3 text-[10px] break-words text-red-300">{j.error}</div>}
            <div className="mt-2 flex items-center gap-3 text-[10px]">
              <span className="text-accent">{t('org.detail')}</span>
              {j.status === 'error' && (
                <button
                  className="cursor-pointer text-accent underline"
                  onClick={(e) => {
                    e.stopPropagation()
                    retryOrgJob(j.jobId)
                  }}
                >
                  {t('org.retry')}
                </button>
              )}
              <button
                className="ml-auto cursor-pointer text-dim hover:text-fg"
                onClick={(e) => {
                  e.stopPropagation()
                  removeJob(j.jobId)
                }}
              >
                ✕
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 详情面板 */
export function OrgJobPanel(): React.JSX.Element | null {
  const open = useApp((s) => s.orgPanelOpen)
  const jobs = useApp((s) => s.orgJobs)
  const history = useApp((s) => s.orgHistory)
  const setPanel = useApp((s) => s.setOrgPanelOpen)
  const removeJob = useApp((s) => s.removeOrgJob)
  const clearHistory = useApp((s) => s.clearOrgHistory)
  const logRef = useRef<HTMLDivElement | null>(null)
  const [tab, setTab] = useState<'running' | 'history'>('running')

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [jobs])

  if (!open) return null

  const copy = (text: string): void => {
    void copyText(text)
  }

  const jobLog = (j: OrgJob): string =>
    [
      `# ${j.title} (${j.mode})`,
      `status=${j.status} stage=${j.stage} part=${j.part}/${j.parts}`,
      j.error ? `error=${j.error}` : '',
      ...j.logs
    ]
      .filter(Boolean)
      .join('\n')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.45)] p-6 backdrop-blur-sm" onClick={() => setPanel(false)}>
      <div
        className="panel flex h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-edge/60 px-4 py-3">
          <h3 className="text-base font-semibold">{t('app.orgJobsTitle')}</h3>
          <div className="ml-2 flex gap-1 text-xs">
            <button
              className={`cursor-pointer rounded-md px-2 py-1 ${tab === 'running' ? 'bg-accent/15 text-accent' : 'text-dim hover:bg-surface-2'}`}
              onClick={() => setTab('running')}
            >
              {t('org.statusRunning')} {jobs.length ? `(${jobs.length})` : ''}
            </button>
            <button
              className={`cursor-pointer rounded-md px-2 py-1 ${tab === 'history' ? 'bg-accent/15 text-accent' : 'text-dim hover:bg-surface-2'}`}
              onClick={() => setTab('history')}
            >
              {t('org.history')} {history.length ? `(${history.length})` : ''}
            </button>
          </div>
          <button className="ml-auto cursor-pointer text-sm text-dim hover:text-fg" onClick={() => setPanel(false)}>
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" ref={logRef}>
          {tab === 'running' &&
            (jobs.length === 0 ? (
              <p className="py-6 text-center text-xs text-dim">{t('org.noHistory')}</p>
            ) : (
              <div className="space-y-3">
                {jobs.map((j) => (
                  <div key={j.jobId} className={`rounded-xl border p-3 ${statusColor(j.status)}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium text-fg">{j.title}</span>
                      <span className="shrink-0 text-[11px]">{statusText(j.status)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-dim">
                      <span>{stageLine(j)}</span>
                      <span>{fmtElapsed(j.startedAt, j.status === 'running' ? Date.now() : j.updatedAt)}</span>
                      {typeof j.requests === 'number' && <span>{t('org.requests', { n: j.requests })}</span>}
                      {!!j.chars && <span>{t('org.chunkChars', { n: j.chars.toLocaleString() })}</span>}
                      {!!j.continuations && <span>{t('org.continuations', { n: j.continuations })}</span>}
                      {j.truncated && <span className="text-amber-300">{t('org.truncatedTag')}</span>}
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
                      <div
                        className={`h-full rounded-full ${barColor(j.status)}`}
                        style={{ width: `${j.parts > 0 ? Math.round((Math.min(j.part, j.parts) / j.parts) * 100) : j.status === 'done' ? 100 : 6}%` }}
                      />
                    </div>
                    {j.error && <p className="mt-2 text-[11px] break-words text-red-300">{j.error}</p>}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] text-dim">{t('org.logTitle')}</summary>
                      <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-surface-2 p-2 text-[10px] leading-4 whitespace-pre-wrap text-dim">
                        {j.logs.join('\n')}
                      </pre>
                    </details>
                    <div className="mt-2 flex items-center gap-3 text-[11px]">
                      {(j.status === 'running' || j.status === 'queued') && (
                        <button
                          className="cursor-pointer text-red-300 underline"
                          onClick={() => {
                            void window.api.llm.organizeCancel(j.jobId).then((ok) => {
                              if (!ok) useApp.getState().toastMsg({ kind: 'info', msg: t('org.cancelTooLate') })
                            })
                          }}
                        >
                          {t('org.cancel')}
                        </button>
                      )}
                      {j.status === 'error' && (
                        <button className="cursor-pointer text-accent underline" onClick={() => retryOrgJob(j.jobId)}>
                          {t('org.retry')}
                        </button>
                      )}
                      {j.noteId && (
                        <button
                          className="cursor-pointer text-accent underline"
                          onClick={() => {
                            useApp.getState().setTab('notes')
                            useApp.getState().setNbSel('all')
                            useApp.getState().setFlashNoteId(j.noteId ?? null)
                            setPanel(false)
                          }}
                        >
                          {t('org.viewNote')}
                        </button>
                      )}
                      <button className="cursor-pointer text-dim underline" onClick={() => copy(jobLog(j))}>
                        {t('org.copyLog')}
                      </button>
                      <button className="ml-auto cursor-pointer text-dim underline" onClick={() => removeJob(j.jobId)}>
                        {t('org.close')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))}

          {tab === 'history' &&
            (history.length === 0 ? (
              <p className="py-6 text-center text-xs text-dim">{t('org.noHistory')}</p>
            ) : (
              <div className="space-y-2">
                {history.map((h) => (
                  <div key={`${h.jobId}-${h.at}`} className={`rounded-xl border p-3 ${statusColor(h.status)}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium text-fg">{h.title}</span>
                      <span className="shrink-0 text-[11px]">{statusText(h.status)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-dim">
                      <span>{new Date(h.at).toLocaleString()}</span>
                      {h.detail && <span>{h.detail}</span>}
                      {typeof h.requests === 'number' && <span>{t('org.requests', { n: h.requests })}</span>}
                      {typeof h.chunks === 'number' && h.chunks > 0 && <span>{`${h.chunks}×`}</span>}
                    </div>
                    {h.error && <p className="mt-1.5 text-[11px] break-words text-red-300">{h.error}</p>}
                    {h.truncated && <p className="mt-1.5 text-[11px] text-amber-300">{t('org.truncatedTag')}</p>}
                    {h.noteId && (
                      <button
                        className="mt-2 cursor-pointer text-[11px] text-accent underline"
                        onClick={() => {
                          useApp.getState().setTab('notes')
                          useApp.getState().setNbSel('all')
                          useApp.getState().setFlashNoteId(h.noteId ?? null)
                          setPanel(false)
                        }}
                      >
                        {t('org.viewNote')}
                      </button>
                    )}
                  </div>
                ))}
                <button className="cursor-pointer text-[11px] text-dim underline" onClick={clearHistory}>
                  {t('org.clearHistory')}
                </button>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
