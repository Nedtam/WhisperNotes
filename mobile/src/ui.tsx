import React from 'react'
import { t } from './i18n'

export function Spinner({ size = 16 }: { size?: number }): React.JSX.Element {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]"
      style={{ width: size, height: size }}
    />
  )
}

// ── 与电脑端同一套图标（直接照搬桌面 ui.tsx / App.tsx 的 SVG）──
export function IconBook(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  )
}

export function IconWave(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 12h2.5M8 16h5" opacity="0.55" />
      <path d="M17 14.5v3" />
    </svg>
  )
}

export function IconCards(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="13" height="14" rx="2" />
      <path d="M8 3h11a2 2 0 0 1 2 2v12" />
    </svg>
  )
}

export function IconGear(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

export function Btn({
  children,
  onClick,
  kind = 'primary',
  disabled,
  full
}: {
  children: React.ReactNode
  onClick?: () => void
  kind?: 'primary' | 'ghost'
  disabled?: boolean
  full?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${kind === 'primary' ? 'btn-primary' : 'btn-ghost'} ${full ? 'w-full' : ''}`}
    >
      {children}
    </button>
  )
}

export function Empty({ text }: { text: string }): React.JSX.Element {
  return <p className="px-6 py-16 text-center text-sm text-dim">{text}</p>
}

export function Toast({ msg }: { msg: { kind: 'ok' | 'err'; text: string } | null }): React.JSX.Element | null {
  if (!msg) return null
  return (
    <div
      className={`fixed inset-x-4 bottom-24 z-50 rounded-xl px-4 py-3 text-center text-sm text-white shadow-lg ${
        msg.kind === 'ok' ? 'bg-[var(--ok)]' : 'bg-[var(--err)]'
      }`}
    >
      {msg.text}
    </div>
  )
}

/** 相对时间：刚刚 / n 分钟 / n 小时 / n 天 / 月-日 */
export function relTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('mobile.justNow')
  if (min < 60) return t('mobile.minAgo', { n: min })
  const h = Math.floor(min / 60)
  if (h < 24) return t('mobile.hourAgo', { n: h })
  const d = Math.floor(h / 24)
  if (d < 30) return t('mobile.dayAgo', { n: d })
  const dt = new Date(ts)
  return `${dt.getMonth() + 1}-${dt.getDate()}`
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`
}
