import React, { useState } from 'react'
import { t } from '../i18n'
import { Btn } from '../ui'
import type { Conn } from '../api'

export default function SettingsScreen({
  conn,
  online,
  counts,
  sync,
  lang,
  onLang,
  onSyncAll,
  onWipe,
  onSync,
  onDisconnect,
  onRecover,
  recoverNote,
  recovering,
  busy
}: {
  conn: Conn
  online: boolean
  counts: { notes: number; transcripts: number }
  /** 本地离线数据状态 */
  sync: { at: number; notes: number; transcripts: number; cards: number; localNotes: number; localTranscripts: number } | null
  lang: 'system' | 'zh' | 'en'
  onLang: (l: 'system' | 'zh' | 'en') => void
  onSyncAll: () => void
  onWipe: () => void
  onSync: () => void
  onDisconnect: () => void
  /** 连不上时手动触发"找回电脑"（自动换 IP 后仍找不到的兜底） */
  onRecover: () => void
  recoverNote: string
  recovering: boolean
  busy: boolean
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="h-full overflow-y-auto px-4 pb-28 pt-4">
      <div className="panel p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t('mobile.connected')}</span>
          <span className={`text-xs ${online ? 'text-ok' : 'text-warn'}`}>{online ? '●' : t('mobile.offline')}</span>
        </div>
        <p className="mt-2 break-all font-mono text-[11px] text-dim">{conn.baseUrl}</p>
        {conn.urls && conn.urls.length > 1 && (
          <p className="mt-1 break-all font-mono text-[10px] text-dim/70">{t('mobile.candidates', { n: conn.urls.length })}</p>
        )}
        {recoverNote && <p className="mt-1 text-[11px] text-accent">{recoverNote}</p>}
        {!online && (
          <div className="mt-2">
            <Btn full disabled={recovering} onClick={onRecover}>
              {recovering ? t('mobile.findingDesk') : t('mobile.findDesk')}
            </Btn>
          </div>
        )}
        <p className="mt-1 text-[11px] text-dim">{conn.deviceName}</p>
        <p className="mt-2 text-[11px] text-dim">{t('mobile.synced', { notes: counts.notes, transcripts: counts.transcripts })}</p>
        <div className="mt-3 space-y-2">
          <Btn full disabled={busy} onClick={onSync}>
            {t('mobile.refresh')}
          </Btn>
          {confirming ? (
            <div className="space-y-2">
              <p className="text-center text-[11px] text-dim">{t('mobile.disconnectConfirm')}</p>
              <div className="flex gap-2">
                <Btn kind="ghost" full onClick={() => setConfirming(false)}>
                  {t('common.cancel')}
                </Btn>
                <Btn full onClick={onDisconnect}>
                  {t('mobile.disconnect')}
                </Btn>
              </div>
            </div>
          ) : (
            <Btn kind="ghost" full onClick={() => setConfirming(true)}>
              {t('mobile.disconnect')}
            </Btn>
          )}
        </div>
      </div>

      {/* 语言设置（用户反馈：手机端没有改语言的地方） */}
      <div className="panel mt-4 p-4">
        <p className="text-sm font-medium">{t('mobile.lang')}</p>
        <div className="mt-2 flex gap-2">
          {(
            [
              { id: 'system' as const, label: t('mobile.langSystem') },
              { id: 'zh' as const, label: '中文' },
              { id: 'en' as const, label: 'English' }
            ] as const
          ).map((x) => (
            <button
              key={x.id}
              onClick={() => onLang(x.id)}
              className={`rounded-lg px-3 py-1.5 text-xs ${lang === x.id ? 'bg-accent text-white' : 'bg-surface-2 text-dim'}`}
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>

      {/* 离线数据：默认整份下载，没电脑也能用 */}
      <div className="panel mt-4 p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t('mobile.offlineReady', { notes: sync?.localNotes ?? 0, totalNotes: sync?.notes ?? counts.notes })}</p>
          <span className={`text-xs ${online ? 'text-ok' : 'text-warn'}`}>{online ? '●' : t('mobile.offline')}</span>
        </div>
        <p className="mt-1 text-[11px] text-dim">
          {sync ? t('mobile.syncedAt', { ts: new Date(sync.at).toLocaleString() }) : t('mobile.neverSynced')}
          {sync ? ` · ${t('mobile.syncDone', { notes: sync.notes, transcripts: sync.transcripts, cards: sync.cards })}` : ''}
        </p>
        {sync && sync.localNotes < sync.notes && (
          <p className="mt-1 text-[11px] text-warn">{t('mobile.offlinePartial', { n: sync.notes - sync.localNotes })}</p>
        )}
        {/* 竖排：手机窄屏 + 按钮是 nowrap，两个长标签挤一行会直接出框 */}
        <div className="mt-3 flex flex-col gap-2">
          <Btn full onClick={onSyncAll} disabled={busy || !online}>
            {t('mobile.syncAll')}
          </Btn>
          <Btn full kind="ghost" onClick={onWipe}>
            {t('mobile.wipe')}
          </Btn>
        </div>
      </div>

      <div className="panel mt-4 p-4">
        <p className="text-sm font-medium">{t('mobile.reviewSoon')}</p>
        <p className="mt-2 text-[11px] leading-relaxed text-dim">{t('mobile.localOnly')}</p>
      </div>

      <div className="panel mt-4 p-4">
        <p className="text-sm font-medium">{t('mobile.about')}</p>
        <p className="mt-2 text-[11px] text-dim">{t('mobile.version', { v: '0.1.0' })}</p>
      </div>
    </div>
  )
}
