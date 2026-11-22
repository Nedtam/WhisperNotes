import React, { useMemo, useState } from 'react'
import { t } from '../i18n'
import { Empty, fmtDuration, relTime } from '../ui'
import type { Library } from '../api'

export default function TranscriptsList({
  lib,
  onOpen
}: {
  lib: Library
  onOpen: (id: string) => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const list = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const arr = lib.transcripts.slice().sort((a, b) => b.createdAt - a.createdAt)
    return kw ? arr.filter((x) => x.title.toLowerCase().includes(kw) || x.preview.toLowerCase().includes(kw)) : arr
  }, [lib, q])

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className="sticky top-0 z-10 bg-bg/95 px-3 pb-2 pt-3 backdrop-blur">
        <input
          className="inp"
          placeholder={t('mobile.searchTranscr')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {list.length === 0 ? (
        <Empty text={t('mobile.trEmpty')} />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-3 pb-24">
          {list.map((x) => (
            <li key={x.id}>
              <button
                onClick={() => onOpen(x.id)}
                className="panel mb-2 w-full px-4 py-3 text-left transition active:scale-[0.99]"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{x.title}</span>
                  <span className="shrink-0 text-[11px] text-dim">{relTime(x.createdAt)}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-dim">
                  <span>{x.source === 'import' ? '📂' : '🎙'}</span>
                  <span className="truncate">{x.sourceName}</span>
                  <span>·</span>
                  <span>{fmtDuration(x.durationMs)}</span>
                  {x.hasEnhanced && <span className="rounded-full bg-accent-soft px-1.5 text-accent">{t('mobile.enhanced')}</span>}
                </div>
                {x.preview && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-dim">{x.preview}</p>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
