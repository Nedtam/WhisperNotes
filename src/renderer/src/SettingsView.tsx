// 设置视图
import React, { useEffect, useState } from 'react'
import { useApp } from './store'
import type { AppSettings, LlmProvider, MobileStatus } from '../../shared/types'
import { PROVIDER_PRESETS, presetById } from '../../shared/providers'
import { ProgressBar, Spinner, Toggle } from './ui'
import { micPermission, requestMicPermission, listAudioInputs, resolveActiveMic } from './mic'
import { t, tError } from './i18n'

const TEMPLATE_DEFS: Array<{ id: string; key: string }> = [
  { id: 'study', key: 'tpl.study' },
  { id: 'outline', key: 'tpl.outline' },
  { id: 'cornell', key: 'tpl.cornell' },
  { id: 'actions', key: 'tpl.actions' },
  { id: 'custom', key: 'tpl.custom' }
]

function Section({ title, children, hint }: { title: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="panel p-5">
      <h3 className="mb-1 text-base font-semibold">{title}</h3>
      {hint && <p className="mb-4 text-xs text-dim">{hint}</p>}
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="min-w-0 flex-1 text-sm leading-snug text-fg">{label}</span>
      <div className="flex w-72 shrink-0 items-center justify-end gap-2">{children}</div>
    </div>
  )
}

export default function SettingsView(): React.JSX.Element {
  const s = useApp((st) => st.settings)
  const probe = useApp((st) => st.probe)
  const models = useApp((st) => st.models)
  const modelProgress = useApp((st) => st.modelProgress)
  const usage = useApp((st) => st.usage)
  const audioInputs = useApp((st) => st.audioInputs)
  const [showKey, setShowKey] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [micState, setMicState] = useState<'unknown' | 'granted' | 'denied' | 'working'>('unknown')
  // ── AI 渠道管理 ──
  const [selChId, setSelChId] = useState<string>('')
  const [addPresetId, setAddPresetId] = useState<string>(PROVIDER_PRESETS[0].id)
  const [chBusy, setChBusy] = useState<'test' | 'models' | null>(null)
  const [chModels, setChModels] = useState<string[]>([])
  const [chMsg, setChMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  // 手机连接状态（局域网只读客户端）
  const [mobileStatus, setMobileStatus] = useState<MobileStatus | null>(null)
  const [mobileQr, setMobileQr] = useState<{ svg: string; url: string; code: string } | null>(null)
  const [mobileBusy, setMobileBusy] = useState(false)

  const patch = async (p: Partial<AppSettings>): Promise<void> => {
    await useApp.getState().patchSettings(p)
  }

  const refreshMics = async (forcePrompt = false): Promise<void> => {
    setMicState('working')
    try {
      const perm = await micPermission()
      let granted = perm.granted
      if (forcePrompt && !granted) granted = await requestMicPermission()
      if (granted) {
        useApp.getState().setAudioInputs(await listAudioInputs())
        setMicState('granted')
      } else {
        setMicState('denied')
      }
    } catch {
      setMicState('denied')
    }
  }

  useEffect(() => {
    void refreshMics(false)
    const onDev = (): void => {
      void refreshMics(false)
    }
    navigator.mediaDevices?.addEventListener?.('devicechange', onDev)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onDev)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void (async () => {
      const [u, p, m] = await Promise.all([
        window.api.meta.dailyUsage(),
        window.api.sys.probeWhisper(),
        window.api.models.status()
      ])
      useApp.getState().setUsage(u)
      useApp.getState().setProbe(p)
      useApp.getState().setModels(m)
    })()
    const off = window.api.onModelProgress((mp) => {
      useApp.getState().setModelProgress(mp)
      if (mp.pct >= 100) {
        setTimeout(() => useApp.getState().setModelProgress(null), 1500)
      }
    })
    return off
  }, [])

  const refreshModels = async (): Promise<void> => {
    useApp.getState().setModels(await window.api.models.status())
  }

  // 首屏 + 每次进入设置页都拉一次手机连接状态（服务可能在开机时自动启动，
  // 也可能被其它窗口改动）。注意：这里不能调用下面才声明的 refreshMobile ——
  // settings 尚未加载时组件会提前 return，该 const 仍处于 TDZ，effect 触发时会直接抛错。
  const tabNow = useApp((st) => st.tab)
  useEffect(() => {
    if (tabNow !== 'settings') return
    void (async () => {
      try {
        setMobileStatus(await window.api.mobile.status())
      } catch {
        /* 主进程未就绪时忽略 */
      }
    })()
  }, [tabNow])

  const download = async (id: string): Promise<void> => {
    setDownloading(id)
    try {
      await window.api.models.download(id)
      await refreshModels()
      useApp.getState().toastMsg({ kind: 'ok', msg: t('set.model.downloadDone') })    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: t('set.model.downloadFail') + ((e as Error).message || '') })
    } finally {
      setDownloading(null)
      useApp.getState().setModelProgress(null)
    }
  }

  const choose = async (file: string): Promise<void> => {
    await patch({ whisper: { ...s!.whisper, modelFile: file } })
    useApp.getState().toastMsg({ kind: 'ok', msg: t('set.model.chosen') })
  }

  const chooseStorage = async (kind: 'recordingsParent' | 'dataParent'): Promise<void> => {
    const p = await window.api.dialog.pickFolder()
    if (!p) return
    await patch({ storage: { ...s!.storage, [kind]: p } })
    useApp.getState().toastMsg({
      kind: 'ok',
      msg: kind === 'dataParent' ? t('set.storage.dataChosen') : t('set.storage.recChosen')
    })
  }
  const resetStorage = async (kind: 'recordingsParent' | 'dataParent'): Promise<void> => {
    await patch({ storage: { ...s!.storage, [kind]: '' } })
  }

  const w = s?.whisper
  const llm = s?.llm
  const quotaLimit = Math.max(1, llm?.dailyFreeLimit ?? 1000)
  const installedCount = models?.filter((m) => m.present).length ?? 0

  const cancelModel = async (file: string): Promise<void> => {
    await window.api.models.cancel(file)
    setDownloading(null)
    useApp.getState().setModelProgress(null)
    await refreshModels()
  }
  const removeModel = async (file: string): Promise<void> => {
    if (installedCount <= 1) {
      useApp.getState().toastMsg({ kind: 'info', msg: t('set.model.keepOne') })
      return
    }
    if (!window.confirm(t('set.model.removeConfirm', { name: file }))) return
    const r = await window.api.models.remove(file)
    if (!r.ok) {
      useApp.getState().toastMsg({ kind: 'err', msg: r.error || t('set.model.removeFail') })
      return
    }
    await refreshModels()
    const cfg = useApp.getState().settings
    if (cfg && cfg.whisper.modelFile === file) {
      const next = (await window.api.models.status()).filter((m) => m.present)
      if (next.length) {
        await patch({ whisper: { ...cfg.whisper, modelFile: next[0].info.file } })
      }
    }
    useApp.getState().toastMsg({ kind: 'ok', msg: t('set.model.removed') })
  }

  if (!s || !w || !llm) {
    return (
      <div className="flex h-full items-center justify-center text-dim">
        <Spinner /> {t('set.loading')}
      </div>
    )
  }

  // ── 手机连接（局域网只读） ──
  const refreshMobile = async (): Promise<void> => {
    try {
      setMobileStatus(await window.api.mobile.status())
    } catch {
      /* 主进程未就绪时忽略 */
    }
  }
  const showQr = async (): Promise<void> => {
    setMobileBusy(true)
    try {
      const r = await window.api.mobile.qr()
      if (r.ok && r.svg) setMobileQr({ svg: r.svg, url: r.url ?? '', code: r.code ?? '' })
      else useApp.getState().toastMsg({ kind: 'err', msg: r.error || t('set.mobile.qrFail') })
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: t('set.mobile.qrFail') + ((e as Error).message || '') })
    } finally {
      setMobileBusy(false)
    }
  }
  const toggleMobile = async (on: boolean): Promise<void> => {
    setMobileBusy(true)
    try {
      const st = await window.api.mobile.setEnabled(on)
      setMobileStatus(st)
      if (on) await showQr()
      else setMobileQr(null)
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: tError((e as Error).message) })
      await refreshMobile()
    } finally {
      setMobileBusy(false)
    }
  }
  const revokeDevice = async (id: string): Promise<void> => {
    setMobileStatus(await window.api.mobile.revoke(id))
  }

  // ── 渠道操作 ──
  const providers = llm.providers ?? []
  const activeCh = providers.find((p) => p.id === llm.activeProviderId) ?? providers[0]
  const selCh = providers.find((p) => p.id === selChId) ?? activeCh

  const saveChannels = async (next: LlmProvider[], activeId?: string): Promise<void> => {
    await patch({ llm: { ...llm, providers: next, activeProviderId: activeId ?? llm.activeProviderId } })
  }
  const updateCh = async (p: Partial<LlmProvider>): Promise<void> => {
    if (!selCh) return
    await saveChannels(providers.map((x) => (x.id === selCh.id ? { ...x, ...p } : x)))
  }
  const addChannel = async (presetId: string): Promise<void> => {
    const preset = presetById(presetId)
    if (!preset) return
    const base = preset.id
    let id = base
    let n = 2
    while (providers.some((p) => p.id === id)) id = `${base}-${n++}`
    const ch: LlmProvider = {
      id,
      name: providers.some((p) => p.name === preset.name) ? `${preset.name} ${n}` : preset.name,
      baseUrl: preset.baseUrl,
      apiKey: '',
      modelId: preset.modelId,
      fallbackModels: [],
      enabled: true,
      ...(preset.local ? { local: true } : {})
    }
    const empty = providers.length === 0 || !activeCh
    await saveChannels([...providers, ch], empty ? id : llm.activeProviderId)
    setSelChId(id)
    setChModels([])
    setChMsg(null)
    useApp.getState().toastMsg({ kind: 'ok', msg: t('set.llm.chAdded', { name: ch.name }) })
  }
  const removeChannel = async (): Promise<void> => {
    if (!selCh) return
    if (providers.length <= 1) {
      setChMsg({ kind: 'err', text: t('set.llm.chKeepOne') })
      return
    }
    const rest = providers.filter((p) => p.id !== selCh.id)
    const nextActive = llm.activeProviderId === selCh.id ? rest[0].id : llm.activeProviderId
    await saveChannels(rest, nextActive)
    setSelChId(nextActive ?? '')
    setChModels([])
    setChMsg(null)
  }
  const useChannel = async (): Promise<void> => {
    if (!selCh) return
    await saveChannels(providers, selCh.id)
    useApp.getState().toastMsg({ kind: 'ok', msg: t('set.llm.chNow', { name: selCh.name }) })
  }
  const testChannel = async (): Promise<void> => {
    if (!selCh) return
    setChBusy('test')
    setChMsg(null)
    try {
      const r = await window.api.llm.testChannel({
        baseUrl: selCh.baseUrl,
        apiKey: selCh.apiKey,
        modelId: selCh.modelId,
        local: selCh.local
      })
      setChMsg(r.ok ? { kind: 'ok', text: t('set.llm.chTestOk', { reply: r.reply ?? 'pong' }) } : { kind: 'err', text: r.error ?? t('set.llm.validateFail') })
    } finally {
      setChBusy(null)
    }
  }
  const fetchModels = async (): Promise<void> => {
    if (!selCh) return
    setChBusy('models')
    setChMsg(null)
    try {
      const r = await window.api.llm.listModels({ baseUrl: selCh.baseUrl, apiKey: selCh.apiKey })
      if (r.ok) {
        setChModels(r.models)
        setChMsg({ kind: 'ok', text: t('set.llm.chModelsOk', { n: r.models.length }) })
      } else {
        setChMsg({ kind: 'err', text: r.error ?? t('set.llm.chModelsFail') })
      }
    } finally {
      setChBusy(null)
    }
  }

  return (
    <div className="h-full overflow-y-auto pr-1">
      <div className="mx-auto max-w-3xl space-y-4 pb-8">
        {/* ── 语言 ── */}
        <Section title={t('set.lang.section')} hint={t('set.lang.hint')}>
          <Row label={t('set.lang.ui')}>
            <select className="inp !w-72" value={s.ui.language} onChange={(e) => void patch({ ui: { language: e.target.value as 'zh' | 'en' } })}>
              <option value="zh">{t('set.lang.zh')}</option>
              <option value="en">English</option>
            </select>
          </Row>
          <Row label={t('set.rec.lang')}>
            <select className="inp !w-72" value={w.language} onChange={(e) => void patch({ whisper: { ...w, language: e.target.value } })}>
              <option value="en">{t('set.rec.lang.en')}</option>
              <option value="zh">{t('set.rec.lang.zh')}</option>
              <option value="auto">{t('set.rec.lang.auto')}</option>
            </select>
          </Row>
        </Section>

        {/* ── 麦克风/录音输入 ── */}
        <Section title={t('set.mic.title')} hint={t('set.mic.hint')}>
          <Row label={t('set.mic.access')}>
            {micState === 'working' ? (
              <span className="flex items-center gap-2 text-sm text-dim">
                <Spinner size={13} /> {t('set.mic.checking')}
              </span>
            ) : micState === 'granted' ? (
              <span className="flex items-center gap-1.5 text-sm text-emerald-400">✓ {t('set.mic.allowed')}</span>
            ) : (
              <span className="flex items-center gap-1.5 text-sm text-red-400">✕ {t('set.mic.denied')}</span>
            )}
            <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => void refreshMics(true)} disabled={micState === 'working'}>
              {t('set.mic.ask')}
            </button>
          </Row>
          <Row label={t('set.mic.device')}>
            <select
              className="inp"
              value={s?.mic?.preferredDeviceId ?? ''}
              disabled={micState !== 'granted'}
              onChange={(e) => void patch({ mic: { preferredDeviceId: e.target.value } })}
            >
              <option value="">{t('set.mic.default')}</option>
              {audioInputs.map((a) => (
                <option key={a.deviceId} value={a.deviceId}>
                  {a.label || 'Microphone'}
                </option>
              ))}
            </select>
          </Row>
          {(() => {
            const cur = resolveActiveMic(audioInputs, s?.mic?.preferredDeviceId ?? '')
            return cur ? (
              <p className="text-xs text-dim">
                🎤 {t('set.mic.current')} <span className="text-fg">{cur.label || 'Microphone'}</span>
              </p>
            ) : micState === 'denied' ? (
              <p className="text-xs text-warn">{t('set.mic.needGrant')}</p>
            ) : (
              <p className="text-xs text-dim">{t('set.mic.noDevice')}</p>
            )
          })()}
        </Section>

        {/* ── 转写引擎 ── */}
        <Section title={t('set.engine.section')} hint={t('set.engine.hint')}>
          <Row label={t('set.engine.state')}>
            {probe?.found ? (
              <span className="flex min-w-0 items-center gap-1.5 text-sm text-emerald-400">
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
                <span className="shrink-0 whitespace-nowrap">{t('common.ready')}</span>
                <span
                  className={`shrink-0 rounded px-1 text-[10px] whitespace-nowrap ${
                    probe.gpu && w.useGpu !== false ? 'bg-emerald-500/15 text-emerald-300' : 'bg-surface-3 text-dim'
                  }`}
                >
                  {probe.gpu
                    ? w.useGpu === false
                      ? t('set.engine.gpuOff')
                      : t('set.engine.gpuOn')
                    : t('set.engine.gpuMissing')}
                </span>
                <span className="min-w-0 max-w-[240px] truncate text-[11px] text-dim">{probe.binaryPath}</span>
              </span>
            ) : (
              <span className="text-sm text-red-400">
                {t('set.engine.notFoundPre')}{' '}
                <code className="rounded bg-surface-2 px-1">brew install whisper-cpp</code>
                {t('set.engine.notFoundPost')}
              </span>
            )}
          </Row>
          <Row label={t('set.engine.useGpu')}>
            <span className="min-w-0 text-right text-[10px] leading-tight text-dim">{t('set.engine.useGpuHint')}</span>
            <Toggle checked={w.useGpu !== false} onChange={(v) => void patch({ whisper: { ...w, useGpu: v } })} />
          </Row>
          <Row label={t('set.engine.threads', { n: w.threads })}>
            <span className="min-w-0 text-right text-[10px] leading-tight text-dim">{t('set.engine.threadsHint')}</span>
            <input
              type="range"
              min={2}
              max={10}
              value={w.threads}
              onChange={(e) => void patch({ whisper: { ...w, threads: Number(e.target.value) } })}
            />
          </Row>
          <Row label={t('set.engine.sensitivity', { n: w.sensitivity })}>
            <input
              type="range"
              min={25}
              max={85}
              value={w.sensitivity}
              onChange={(e) => void patch({ whisper: { ...w, sensitivity: Number(e.target.value) } })}
            />
          </Row>
          <Row label={t('set.engine.minSilence')}>
            <select
              className="inp !w-72"
              value={w.minSilenceMs}
              onChange={(e) => void patch({ whisper: { ...w, minSilenceMs: Number(e.target.value) } })}
            >
              <option value={350}>{t('set.engine.ms350')}</option>
              <option value={550}>{t('set.engine.ms550')}</option>
              <option value={800}>{t('set.engine.ms800')}</option>
            </select>
          </Row>
          <Row label={t('set.engine.saveWav')}>
            <Toggle checked={s.saveWav} onChange={(v) => void patch({ saveWav: v })} />
          </Row>
          <Row label={t('set.engine.autoOrg')}>
            <Toggle checked={s.autoOrganizeOnStop} onChange={(v) => void patch({ autoOrganizeOnStop: v })} />
          </Row>
        </Section>

        {/* ── 模型 ── */}
        <Section title={t('set.model.title')} hint={`${t('set.model.hint')} ${t('set.model.autoNote')}`}>
          {models?.map((m) => {
            const active = w.modelFile === m.info.file
            return (
              <div
                key={m.info.id}
                className={`rounded-xl border p-3.5 transition ${
                  active ? 'border-accent/60 bg-accent/[0.07]' : 'border-edge bg-surface-2'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-fg">{m.info.file}</span>
                      {active && (
                        <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-medium text-accent">
                          {t('set.model.active')}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-dim">
                      {m.info.desc} · {m.info.langs} · {m.info.sizeLabel}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {m.present ? (
                      <>
                        <button className="btn-ghost !px-4 !py-2 text-xs" onClick={() => void choose(m.info.file)}>
                          {t('set.model.use')}
                        </button>
                        {installedCount > 1 && (
                          <button
                            className="btn-danger !px-3 !py-2 text-xs"
                            onClick={() => void removeModel(m.info.file)}
                            title={t('set.model.remove')}
                          >
                            {t('set.model.remove')}
                          </button>
                        )}
                        <span className="flex items-center text-xs text-emerald-400">{t('common.ready')}</span>
                      </>
                    ) : downloading === m.info.id || modelProgress?.file === m.info.file ? (
                      <span className="flex items-center gap-1.5 text-xs text-accent">
                        <Spinner size={13} />
                        <button
                          className="rounded-md px-1.5 py-0.5 text-sm leading-none text-dim transition hover:bg-surface-3 hover:text-err cursor-pointer"
                          title={t('set.model.cancel')}
                          onClick={() => void cancelModel(m.info.file)}
                        >
                          ✕
                        </button>
                      </span>
                    ) : (
                      <button
                        className="btn-primary !px-4 !py-2 text-xs"
                        onClick={() => void download(m.info.id)}
                        disabled={!!downloading}
                      >
                        {t('set.model.download')}
                      </button>
                    )}
                  </div>
                </div>
                {modelProgress && modelProgress.file === m.info.file && (
                  <div className="mt-2">
                    <ProgressBar pct={modelProgress.pct} />
                    <p className="mt-1 text-[11px] text-dim">
                      {modelProgress.pct}% · {(modelProgress.received / 1024 / 1024).toFixed(0)} MB
                      {modelProgress.total ? ` / ${(modelProgress.total / 1024 / 1024).toFixed(0)} MB` : ''}
                    </p>
                  </div>
                )}
              </div>
            )
          })}
        </Section>

        {/* ── LLM ── */}
        {/* ── 手机连接（局域网） ── */}
        <Section title={t('set.mobile.title')} hint={t('set.mobile.hint')}>
          <Row label={t('set.mobile.enable')}>
            <Toggle checked={!!mobileStatus?.running} onChange={(v) => void toggleMobile(v)} />
          </Row>
          <p className="text-xs text-dim">
            {mobileStatus?.running
              ? t('set.mobile.running', { url: mobileStatus.urls[0] ?? `:${mobileStatus.port ?? ''}` })
              : t('set.mobile.stopped')}
            {mobileBusy ? ' …' : ''}
          </p>
          {mobileStatus?.running && (
            <>
              <p className="text-xs text-dim">
                {t('set.mobile.counts', {
                  notes: mobileStatus.noteCount,
                  notebooks: mobileStatus.notebookCount,
                  transcripts: mobileStatus.transcriptCount
                })}
              </p>
              <div className="rounded-xl bg-surface-2/60 p-3">
                <div className="flex flex-wrap items-start gap-4">
                  <div className="shrink-0 rounded-lg bg-white p-2">
                    {mobileQr ? (
                      <div className="h-[240px] w-[240px] [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: mobileQr.svg }} />
                    ) : (
                      <div className="flex h-[240px] w-[240px] items-center justify-center text-xs text-dim">
                        {t('set.mobile.qr')}
                      </div>
                    )}
                  </div>
                  <div className="min-w-48 flex-1 space-y-2">
                    <p className="text-xs text-dim">{t('set.mobile.scanHint')}</p>
                    {mobileQr?.url && (
                      <p className="break-all text-[11px] text-dim">
                        {t('set.mobile.url')}：<span className="font-mono">{mobileQr.url}</span>
                      </p>
                    )}
                    <button className="btn-ghost" onClick={() => void showQr()} disabled={mobileBusy}>
                      {mobileQr ? t('set.mobile.refreshQr') : t('set.mobile.qr')}
                    </button>
                    <Row label={t('set.mobile.serveApk')}>
                      <Toggle
                        checked={mobileStatus.serveApk}
                        onChange={(v) => void patch({ mobile: { ...(s.mobile ?? {}), serveApk: v } })}
                      />
                    </Row>
                    <p className="text-[11px] text-dim">
                      {mobileStatus.apkAvailable ? t('set.mobile.apkReady') : t('set.mobile.apkMissing')}
                    </p>
                  </div>
                </div>
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="lbl">{t('set.mobile.devices')}</span>
                  {(mobileStatus.devices.length ?? 0) > 1 && (
                    <button className="text-[11px] text-err underline" onClick={() => void window.api.mobile.revokeAll().then(setMobileStatus)}>
                      {t('set.mobile.revokeAll')}
                    </button>
                  )}
                </div>
                {mobileStatus.devices.length === 0 ? (
                  <p className="text-xs text-dim">{t('set.mobile.noDevices')}</p>
                ) : (
                  <ul className="space-y-1">
                    {mobileStatus.devices.map((d) => (
                      <li key={d.id} className="flex items-center justify-between rounded-lg bg-surface-2/60 px-3 py-2 text-xs">
                        <span className="min-w-0 flex-1 truncate">
                          {d.name}
                          {d.lastSeen ? ` · ${t('set.mobile.lastSeen', { ts: new Date(d.lastSeen).toLocaleString() })}` : ''}
                        </span>
                        <button className="shrink-0 text-err underline" onClick={() => void revokeDevice(d.id)}>
                          {t('set.mobile.revoke')}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </Section>

        <Section title={t('set.llm.title')} hint={t('set.llm.hint')}>
          {/* 渠道选择 */}
          <div>
            <span className="lbl">{t('set.llm.chCurrent')}</span>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="inp !w-72"
                value={selCh?.id ?? ''}
                onChange={(e) => {
                  setSelChId(e.target.value)
                  setChModels([])
                  setChMsg(null)
                }}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id === llm.activeProviderId ? '✓ ' : ''}
                    {p.name}
                    {p.modelId ? ` · ${p.modelId}` : ''}
                  </option>
                ))}
              </select>
              <button className="btn-ghost shrink-0" onClick={() => void useChannel()} disabled={!selCh || selCh.id === llm.activeProviderId}>
                {t('set.llm.chUse')}
              </button>
              <button className="btn-ghost shrink-0 text-err" onClick={() => void removeChannel()} disabled={!selCh}>
                {t('common.delete')}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-dim">{t('set.llm.chHint')}</p>
          </div>

          {/* 新增渠道 */}
          <div>
            <span className="lbl">{t('set.llm.chAdd')}</span>
            <div className="flex flex-wrap items-center gap-2">
              <select className="inp !w-72" value={addPresetId} onChange={(e) => setAddPresetId(e.target.value)}>
                <optgroup label={t('set.llm.gIntl')}>
                  {PROVIDER_PRESETS.filter((p) => p.group === 'intl').map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={t('set.llm.gCn')}>
                  {PROVIDER_PRESETS.filter((p) => p.group === 'cn').map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={t('set.llm.gLocal')}>
                  {PROVIDER_PRESETS.filter((p) => p.group === 'local' || p.group === 'custom').map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              </select>
              <button className="btn-ghost shrink-0" onClick={() => void addChannel(addPresetId)}>
                + {t('common.add')}
              </button>
              <span className="text-[11px] text-dim">{presetById(addPresetId)?.note ?? ''}</span>
            </div>
          </div>

          {selCh && (
            <div className="space-y-3 rounded-xl bg-surface-2/60 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  {t('set.llm.chEdit', { name: selCh.name })}
                  {selCh.id === llm.activeProviderId ? ` · ${t('set.llm.chInUse')}` : ''}
                </span>
                {presetById(selCh.id.replace(/-\d+$/, ''))?.keyUrl && (
                  <button
                    className="text-[11px] text-accent underline"
                    onClick={() => window.api.sys.openExternal(presetById(selCh.id.replace(/-\d+$/, ''))!.keyUrl!)}
                  >
                    {t('set.llm.chGetKey')}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="lbl">{t('set.llm.chName')}</span>
                  <input className="inp" value={selCh.name} onChange={(e) => void updateCh({ name: e.target.value })} />
                </div>
                <div>
                  <span className="lbl">{t('set.llm.baseUrl')}</span>
                  <input className="inp" value={selCh.baseUrl} onChange={(e) => void updateCh({ baseUrl: e.target.value })} />
                </div>
              </div>
              <div>
                <span className="lbl">{t('set.llm.apiKey')}</span>
                <div className="flex gap-2">
                  <input
                    className="inp"
                    type={showKey ? 'text' : 'password'}
                    value={selCh.apiKey}
                    placeholder={selCh.local ? t('set.llm.chNoKeyNeeded') : 'sk-…'}
                    onChange={(e) => void updateCh({ apiKey: e.target.value })}
                  />
                  <button className="btn-ghost shrink-0" onClick={() => setShowKey(!showKey)}>
                    {showKey ? t('set.llm.hide') : t('set.llm.show')}
                  </button>
                </div>
              </div>
              <div>
                <span className="lbl">{t('set.llm.modelId')}</span>
                <div className="flex gap-2">
                  <input
                    className="inp"
                    list={`models-${selCh.id}`}
                    value={selCh.modelId}
                    onChange={(e) => void updateCh({ modelId: e.target.value })}
                  />
                  <datalist id={`models-${selCh.id}`}>
                    {chModels.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                  <button className="btn-ghost shrink-0" onClick={() => void fetchModels()} disabled={chBusy !== null}>
                    {chBusy === 'models' ? <Spinner size={13} /> : t('set.llm.chFetchModels')}
                  </button>
                  <button className="btn-ghost shrink-0" onClick={() => void testChannel()} disabled={chBusy !== null}>
                    {chBusy === 'test' ? <Spinner size={13} /> : t('set.llm.validate')}
                  </button>
                </div>
              </div>
              <div>
                <span className="lbl">{t('set.llm.chFallbacks')}</span>
                <input
                  className="inp"
                  value={(selCh.fallbackModels ?? []).join(', ')}
                  placeholder={t('set.llm.chFallbacksPh')}
                  onChange={(e) =>
                    void updateCh({
                      fallbackModels: e.target.value
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean)
                    })
                  }
                />
                <p className="mt-1 text-[11px] text-dim">{t('set.llm.chFallbacksHint')}</p>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-xs">
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={selCh.local === true} onChange={(e) => void updateCh({ local: e.target.checked })} />
                  {t('set.llm.chLocal')}
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selCh.enabled !== false}
                    onChange={(e) => void updateCh({ enabled: e.target.checked })}
                  />
                  {t('set.llm.chEnabled')}
                </label>
              </div>
              {chMsg && <p className={chMsg.kind === 'ok' ? 'text-xs text-ok' : 'text-xs text-err'}>{chMsg.text}</p>}
            </div>
          )}

          <div>
            <Row label={t('set.llm.autoFallback')}>
              <Toggle
                checked={llm.autoFallback !== false}
                onChange={(v) => void patch({ llm: { ...llm, autoFallback: v } })}
              />
            </Row>
            <p className="mt-1 text-[11px] text-dim">{t('set.llm.autoFallbackHint')}</p>
          </div>
          <div className="rounded-xl bg-surface-2/70 p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-fg">{t('set.llm.freeQuota')}</span>
              <span className="font-mono text-accent">
                {t('set.llm.quotaValue', { used: usage?.used ?? 0, limit: quotaLimit })}
              </span>
            </div>
            <div className="mt-2">
              <ProgressBar pct={Math.min(100, ((usage?.used ?? 0) / Math.max(1, quotaLimit)) * 100)} />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[11px] text-dim">{t('set.llm.quotaLimit')}</span>
              <input
                className="inp !w-24 !py-1 text-xs"
                type="number"
                min={1}
                max={100000}
                value={quotaLimit}
                onChange={(e) => {
                  const v = Math.max(1, Math.min(100000, Number(e.target.value) || 0))
                  void patch({ llm: { ...llm, dailyFreeLimit: v } })
                }}
              />
              <span className="text-[11px] text-dim">{t('set.llm.quotaLimitHint')}</span>
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-dim">
              <span>{t('set.llm.quotaHint')}</span>
              <button
                className="text-dim underline hover:text-fg cursor-pointer"
                onClick={async () => {
                  await window.api.settings.resetDailyUsage()
                  useApp.getState().setUsage(await window.api.meta.dailyUsage())
                  useApp.getState().toastMsg({ kind: 'ok', msg: t('set.llm.resetToast') })
                }}
              >
                {t('set.llm.reset')}
              </button>
            </div>
          </div>
          <div>
            <button
              className="text-xs text-accent underline cursor-pointer"
              onClick={() => window.api.sys.openExternal('https://openrouter.ai/settings/keys')}
            >
              {t('set.llm.createKey')}
            </button>
          </div>
        </Section>

        {/* ── 清洗 ── */}
        <Section title={t('set.clean.title')} hint={t('set.clean.hint')}>
          <Row label={t('set.clean.fillers')}>
            <Toggle checked={s.clean.fillers} onChange={(v) => void patch({ clean: { ...s.clean, fillers: v } })} />
          </Row>
          <Row label={t('set.clean.repeats')}>
            <Toggle checked={s.clean.repeats} onChange={(v) => void patch({ clean: { ...s.clean, repeats: v } })} />
          </Row>
          <Row label={t('set.clean.punctuation')}>
            <Toggle checked={s.clean.punctuation} onChange={(v) => void patch({ clean: { ...s.clean, punctuation: v } })} />
          </Row>
        </Section>

        {/* ── 存储位置 ── */}
        <Section title={t('set.storage.title')} hint={t('set.storage.hint')}>
          <div>
            <span className="lbl">{t('set.storage.recordings')}</span>
            <div className="flex gap-2">
              <input
                readOnly
                className="inp flex-1 font-mono text-[11px]"
                value={s.storage.recordingsParent || t('set.storage.default')}
                title={s.storage.recordingsParent}
              />
              <button className="btn-ghost shrink-0 !px-3 !py-1.5 text-xs" onClick={() => void chooseStorage('recordingsParent')}>
                {t('set.storage.change')}
              </button>
              {s.storage.recordingsParent && (
                <button className="btn-ghost shrink-0 !px-3 !py-1.5 text-xs" onClick={() => void resetStorage('recordingsParent')}>
                  {t('set.storage.reset')}
                </button>
              )}
            </div>
            <p className="mt-1 text-[11px] text-dim">{t('set.storage.recordingsNote')}</p>
          </div>
          <div>
            <span className="lbl">{t('set.storage.data')}</span>
            <div className="flex gap-2">
              <input
                readOnly
                className="inp flex-1 font-mono text-[11px]"
                value={s.storage.dataParent || t('set.storage.default')}
                title={s.storage.dataParent}
              />
              <button className="btn-ghost shrink-0 !px-3 !py-1.5 text-xs" onClick={() => void chooseStorage('dataParent')}>
                {t('set.storage.change')}
              </button>
              {s.storage.dataParent && (
                <button className="btn-ghost shrink-0 !px-3 !py-1.5 text-xs" onClick={() => void resetStorage('dataParent')}>
                  {t('set.storage.reset')}
                </button>
              )}
            </div>
            <p className="mt-1 text-[11px] text-dim">{t('set.storage.dataNote')}</p>
          </div>
        </Section>

        {/* ── 笔记模板 ── */}
        <Section title={t('set.tpl.title')} hint={t('set.tpl.hint')}>
          <div>
            <span className="lbl">{t('set.tpl.default')}</span>
            <select
              className="inp"
              value={llm.templateId}
              onChange={(e) => void patch({ llm: { ...llm, templateId: e.target.value } })}
            >
              {TEMPLATE_DEFS.map((def) => (
                <option key={def.id} value={def.id}>
                  {t(def.key)}
                </option>
              ))}
            </select>
          </div>
          {llm.templateId === 'custom' && (
            <div>
              <span className="lbl">{t('set.tpl.customPrompt')}</span>
              <textarea
                className="inp h-40 font-mono text-xs"
                value={llm.customTemplate}
                onChange={(e) => void patch({ llm: { ...llm, customTemplate: e.target.value } })}
                placeholder={t('set.tpl.customPh')}
              />
            </div>
          )}
          <div>
            <span className="lbl">{t('set.tpl.chunkLimit', { n: llm.maxChunkChars })}</span>
            <input
              type="range"
              min={8000}
              max={48000}
              step={2000}
              value={llm.maxChunkChars}
              onChange={(e) => void patch({ llm: { ...llm, maxChunkChars: Number(e.target.value) } })}
            />
          </div>
          <div>
            <span className="lbl">{t('set.tpl.outLimit', { n: llm.maxOutputTokens ?? 16384 })}</span>
            <select
              className="inp !w-40"
              value={String(llm.maxOutputTokens ?? 16384)}
              onChange={(e) => void patch({ llm: { ...llm, maxOutputTokens: Number(e.target.value) } })}
            >
              <option value="8192">8192</option>
              <option value="16384">16384</option>
              <option value="32768">32768</option>
              <option value="65536">65536</option>
              <option value="131072">131072</option>
              <option value="262144">262144</option>
            </select>
            <p className="mt-1 text-[11px] leading-relaxed text-dim">{t('set.tpl.outLimitHint')}</p>
          </div>
        </Section>
      </div>
    </div>
  )
}
