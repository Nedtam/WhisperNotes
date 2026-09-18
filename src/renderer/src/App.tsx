// 应用外壳：导航 + 事件订阅 + 全局通知
import React, { useEffect } from 'react'
import { useApp, handleOrganizeJob, handleOrganizeDone, handleOrganizeError, type TabId } from './store'
import CaptureView from './CaptureView'
import TranscriptionView from './TranscriptionView'
import NotesView from './NotesView'
import NotesNav from './NotesNav'
import { OrgJobCards, OrgJobPanel } from './OrgProgress'
import SettingsView from './SettingsView'
import { IconBook, IconGear, IconMic, IconWave, SplitterV } from './ui'
import { t, setLang } from './i18n'

function NavButton({
  id,
  icon,
  label,
  active,
  dot
}: {
  id: TabId
  icon: React.ReactNode
  label: string
  active: boolean
  dot?: 'rec' | 'busy'
}): React.JSX.Element {
  const navW = useApp((s) => s.layout.navW)
  const orgJobs = useApp((s) => s.orgJobs)
  // 文字随侧栏宽度收缩，窄到没空间时只剩图标（hover 仍显示完整名称）
  const showLabel = navW >= 84
  const labelFs = Math.max(9, Math.min(13.5, 9 + ((navW - 84) / (220 - 84)) * 4.5))
  const iconGap = Math.max(2, Math.round((navW - 64) / 24))
  return (
    <button
      onClick={() => useApp.getState().setTab(id)}
      title={showLabel ? undefined : label}
      className={`flex w-full items-center overflow-hidden rounded-xl px-3 py-2.5 transition cursor-pointer ${
        active ? 'bg-accent/15 text-accent' : 'text-dim hover:bg-surface-2 hover:text-fg'
      }`}
      style={{ gap: iconGap }}
    >
      <span className="shrink-0">{icon}</span>
      {showLabel && (
        <span className="min-w-0 flex-1 truncate text-left" style={{ fontSize: labelFs }}>
          {label}
        </span>
      )}
      {dot === 'rec' && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />}
      {dot === 'busy' && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />}
    </button>
  )
}

export default function App(): React.JSX.Element {
  const tab = useApp((s) => s.tab)
  const engine = useApp((s) => s.engine)
  const settings = useApp((s) => s.settings)
  const usage = useApp((s) => s.usage)
  const toast = useApp((s) => s.toast)
  const navW = useApp((s) => s.layout.navW)
  const orgJobs = useApp((s) => s.orgJobs)
  useApp((s) => s.langVer) // 语言版本订阅：切换时重渲

  // 与 NavButton 一致的侧栏缩放参数（底部用量/引擎信息也随宽度收缩）
  const navFs = Math.max(9, Math.min(13.5, 9 + ((navW - 84) / (220 - 84)) * 4.5))
  const navLabelShown = navW >= 84

  // 订阅主进程事件
  useEffect(() => {
    const offSeg = window.api.onAsrSegment((seg) => useApp.getState().addSegment(seg))
    const offDraft = window.api.onAsrDraft((d) => useApp.getState().setDraft(d.text))
    const offState = window.api.onAsrState((m) => {
      const st = useApp.getState()
      st.setEngine(m)
      if (m.state === 'idle' || m.state === 'paused') st.setDraft('')
      if (m.state === 'error' && m.detail) {
        st.toastMsg({ kind: 'err', msg: t('app.engineErr') + m.detail })
      }
    })
    const offOrg = window.api.onLlamaProgress((p) => useApp.getState().setOrgProgress(p))
    const offJob = window.api.onOrganizeJob((p) => handleOrganizeJob(p))
    const offJobDone = window.api.onOrganizeDone((p) => void handleOrganizeDone(p))
    const offJobErr = window.api.onOrganizeError((p) => handleOrganizeError(p))
    const offModelErr = window.api.onModelError((e) =>
      useApp.getState().toastMsg({ kind: 'err', msg: t('app.modelDownloadFail') + e.error })
    )
    let autoDlToasted = false
    const offModelDl = window.api.onModelProgress((mp) => {
      if (!autoDlToasted && mp.pct === 0 && mp.received === 0) {
        autoDlToasted = true
        useApp.getState().toastMsg({ kind: 'info', msg: t('app.autoModelDownload') })
      }
      useApp.getState().setModelProgress(mp.pct >= 100 ? null : mp)
    })
    let closePrompting = false
    const offClose = window.api.onCloseRequest(() => {
      if (closePrompting) return
      const st = useApp.getState()
      const busy =
        st.engine === 'recording' ||
        st.engine === 'starting' ||
        st.engine === 'paused' ||
        st.importing ||
        st.orgJobs.some((j) => j.status === 'running' || j.status === 'queued')
      if (busy) {
        closePrompting = true
        const ok = window.confirm(t('app.quitPrompt'))
        closePrompting = false
        if (!ok) return
      } else {
        // 自动保存未落库的笔记，再退出
        window.dispatchEvent(new Event('wn:autosave'))
        window.setTimeout(() => void window.api.quitConfirmed(), 450)
        return
      }
      void window.api.quitConfirmed()
    })
    return () => {
      offSeg()
      offDraft()
      offState()
      offOrg()
      offJob()
      offJobDone()
      offJobErr()
      offModelDl()
      offModelErr()
      offClose()
    }
  }, [])

  // 初始化
  useEffect(() => {
    void (async () => {
      try {
        const [cfg, u] = await Promise.all([window.api.settings.get(), window.api.meta.dailyUsage()])
        setLang(cfg.ui.language)
        useApp.getState().setSettings(cfg)
        useApp.getState().setUsage(u)
      } catch (e) {
        useApp.getState().toastMsg({ kind: 'err', msg: t('app.initFail') + ((e as Error).message || '') })
      }
      // 枚举音频输入设备（无权限时列表为空，设置页可再请求）
      try {
        const { micPermission, listAudioInputs } = await import('./mic')
        const perm = await micPermission()
        if (perm.granted) useApp.getState().setAudioInputs(await listAudioInputs())
      } catch {
        /* ignore */
      }
    })()
  }, [])

  // Toast 自动消失
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => useApp.getState().toastMsg(null), 4600)
    return () => clearTimeout(t)
  }, [toast])

  return (
    <div className="flex h-screen gap-4 overflow-hidden p-4">
      {/* 左侧导航 */}
      <aside className="panel flex shrink-0 flex-col overflow-hidden p-3" style={{ width: navW }}>
        <div className="flex items-center px-1.5 py-3" style={{ gap: Math.max(0, Math.min(10, (navW - 96) / 12)) }}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent)] text-white">
            <IconMic />
          </div>
          {navW >= 108 && (
            <div className="min-w-0">
              <div
                className="truncate font-bold tracking-wide"
                style={{ fontSize: Math.min(14, 10 + ((navW - 108) / (220 - 108)) * 4) }}
              >
                WhisperNotes
              </div>
              {navW >= 150 && <div className="truncate text-[10px] text-dim">{t('app.tagline')}</div>}
            </div>
          )}
        </div>

        <div className="mt-4 space-y-1">
          <NavButton id="capture" icon={<IconMic />} label={t('nav.record')} active={tab === 'capture'} dot={engine === 'recording' ? 'rec' : engine === 'starting' ? 'busy' : undefined} />
          <NavButton id="transcripts" icon={<IconWave />} label={t('nav.transcripts')} active={tab === 'transcripts'} />
          <NavButton id="notes" icon={<IconBook />} label={t('nav.notes')} active={tab === 'notes'} />
        </div>

        {/* 笔记导航（全部/未归档 + 笔记本树）：只在笔记页展开，把 Notes 视图的左栏让给笔记列表 */}
        {tab === 'notes' && <NotesNav />}

        {/* 设置固定在左下角：不与笔记本树挤在一起，也不会误点 */}
        <div className="mt-auto shrink-0 border-t border-edge/60 pt-2">
          <NavButton id="settings" icon={<IconGear />} label={t('nav.settings')} active={tab === 'settings'} />
        </div>

        <div className={`shrink-0 space-y-3 overflow-hidden px-2 ${usage && navW >= 88 ? 'pt-3' : ''} ${navW >= 150 ? 'pb-1' : ''}`}>
          {usage && navW >= 88 && (
            <div>
              <div className="flex items-center justify-between text-dim" style={{ fontSize: navFs }}>
                {navLabelShown && <span className="min-w-0 truncate">{t('nav.quota')}</span>}
                <span className={usage.used >= 45 ? 'text-amber-400' : ''}>{usage.used}/50</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
                <div
                  className={`h-full rounded-full ${usage.used >= 45 ? 'bg-amber-400' : 'bg-accent'}`}
                  style={{ width: `${Math.min(100, (usage.used / 50) * 100)}%` }}
                />
              </div>
            </div>
          )}
          {navW >= 150 && (
            <p className="leading-relaxed text-dim" style={{ fontSize: 10 }}>
              {settings?.llm.apiKey ? t('app.llmConfigured') : t('app.llmNoKey')}
              {settings?.llm.apiKey ? ` · ${settings.llm.modelId.split('/').pop()}` : ''}
              <br />
              {t('app.engineLine', {
                name: settings?.whisper.modelFile.split('ggml-').pop()?.split('.bin')[0] ?? ''
              })}
            </p>
          )}
        </div>
      </aside>
      <SplitterV value={navW} onChange={useApp((st) => st.setNavW)} min={64} reserveRight={300} />

      {/* 主内容（各视图常驻挂载，保证录音不中断） */}
      <main className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="h-full" style={{ display: tab === 'capture' ? 'block' : 'none' }}>
          <CaptureView />
        </div>
        <div className="h-full" style={{ display: tab === 'transcripts' ? 'block' : 'none' }}>
          <TranscriptionView />
        </div>
        <div className="h-full" style={{ display: tab === 'notes' ? 'block' : 'none' }}>
          <NotesView />
        </div>
        <div className="h-full" style={{ display: tab === 'settings' ? 'block' : 'none' }}>
          <SettingsView />
        </div>
      </main>

      {/* AI 整理进度：卡片（可点开详情）+ 详情/历史面板 */}
      <OrgJobCards />
      <OrgJobPanel />

      {/* Toast */}
      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
          <div
            className={`pointer-events-auto max-w-xl rounded-xl border px-4 py-2.5 text-sm shadow-2xl backdrop-blur ${
              toast.kind === 'ok'
                ? 'border-emerald-500/40 bg-emerald-950/90 text-emerald-200'
                : toast.kind === 'err'
                  ? 'border-red-500/40 bg-red-950/90 text-red-200'
                  : 'border-sky-500/40 bg-sky-950/90 text-sky-200'
            }`}
          >
            {toast.msg}
          </div>
        </div>
      )}
    </div>
  )
}
