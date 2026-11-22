import React, { useEffect, useMemo, useRef, useState } from 'react'
import { mdToHtml, wrapScrollables } from '@shared/md'
import { t } from '../i18n'
import { Spinner } from '../ui'

/** 通用阅读页：Markdown → HTML（与桌面端同一份渲染代码） */
export default function Reader({
  title,
  md,
  loading,
  error,
  onBack,
  onToggleSource,
  sourceText,
  sourceLabel
}: {
  title: string
  md: string
  loading?: boolean
  error?: string | null
  onBack: () => void
  onToggleSource?: () => void
  sourceText?: string
  sourceLabel?: string
}): React.JSX.Element {
  const { html } = useMemo(() => {
    const r = md ? mdToHtml(md) : { html: '', headings: [] }
    // 只有表格/图片自己横向滚动，正文不再被压扁
    return { ...r, html: wrapScrollables(r.html) }
  }, [md])
  const scroller = useRef<HTMLDivElement | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = (): void => {
      const max = el.scrollHeight - el.clientHeight
      setProgress(max > 4 ? Math.min(1, el.scrollTop / max) : 1)
    }
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [html])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-edge bg-bg/95 px-2 py-2 backdrop-blur">
        <button onClick={onBack} className="btn-ghost !px-3 !py-1.5 text-accent">
          ‹ {t('common.cancel') === 'Cancel' ? 'Back' : '返回'}
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {onToggleSource && (
          <button
            onClick={() => {
              setShowSource((v) => !v)
              onToggleSource()
            }}
            className="btn-ghost !px-2.5 !py-1.5 !text-[11px] text-dim"
          >
            {sourceLabel ?? t('notes.rawToggle')}
          </button>
        )}
      </div>
      <div className="h-0.5 w-full bg-transparent">
        <div className="h-0.5 bg-accent transition-[width] duration-150" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-3">
        {loading && (
          <p className="flex items-center gap-2 py-8 text-sm text-dim">
            <Spinner size={14} /> {t('mobile.loading')}
          </p>
        )}
        {error && <p className="py-6 text-sm text-err">{error}</p>}
        {!loading && !error && showSource && sourceText !== undefined ? (
          <pre className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-dim">{sourceText || '—'}</pre>
        ) : (
          <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </div>
  )
}
