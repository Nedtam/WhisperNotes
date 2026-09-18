// 录音 + 实时转写视图（v2：会话课件拖放/精修/整理询问）
import React, { useEffect, useRef, useState } from 'react'
import { useApp, runOrganize } from './store'
import { startCapture, type CaptureHandle } from './captureAudio'
import OrganizeDialog from './OrganizeDialog'
import type { DeckDescriptor } from '../../shared/types'
import { IconMic, IconStop, IconPause, IconPlay, Spinner, SplitterV } from './ui'
import { t } from './i18n'
import { resolveActiveMic, micPermission, requestMicPermission, listAudioInputs } from './mic'

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const mm = String(m % 60).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function defaultTitle(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `Lecture ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

interface SessionSlide {
  path: string
  fileName: string
  kind: 'pdf' | 'pptx'
  pageCount: number
  chars: number
  password: string
}

type StopMode = 'polish' | 'organize' | 'none'

export default function CaptureView(): React.JSX.Element {
  const engine = useApp((s) => s.engine)
  const engineDetail = useApp((s) => s.engineDetail)
  const segments = useApp((s) => s.segments)
  const transcriptText = useApp((s) => s.transcriptText)
  const draftText = useApp((s) => s.draftText)
  const settings = useApp((s) => s.settings)
  const elapsedMs = useApp((s) => s.elapsedMs)
  const organizing = useApp((s) => s.organizing)
  const orgProgress = useApp((s) => s.orgProgress)
  const audioInputs = useApp((s) => s.audioInputs)
  const midW = useApp((s) => s.layout.midW)

  const textRef = useRef<HTMLTextAreaElement>(null)
  const levelRef = useRef<HTMLDivElement>(null)
  const captureRef = useRef<CaptureHandle | null>(null)
  const recActiveRef = useRef(false)
  const preBufRef = useRef<{ data: Float32Array; rate: number }[]>([])
  const busyRef = useRef(false)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [showOrg, setShowOrg] = useState(false)
  // 导入已有录音
  const [importing, setImporting] = useState(false)
  const [importStage, setImportStage] = useState<'' | 'decode' | 'ready' | 'transcribe'>('')
  const [importPct, setImportPct] = useState(0)
  const [importPaused, setImportPaused] = useState(false)
  const [importPos, setImportPos] = useState(0) // 当前转写到的位置（秒）
  const [importTotal, setImportTotal] = useState(0) // 总时长（秒）
  const [importSkip, setImportSkip] = useState(0) // 已跳过静音（秒）

  useEffect(() => {
    return window.api.onImportProgress((p) => {
      if (p.stage === 'decode' || p.stage === 'ready') {
        setImportStage(p.stage)
        setImportPct(0)
      } else if (p.stage === 'transcribe') {
        setImportStage('transcribe')
        if (typeof p.pct === 'number') setImportPct(p.pct)
        if (typeof p.posSec === 'number') setImportPos(p.posSec)
        if (typeof p.totalSec === 'number') setImportTotal(p.totalSec)
        if (typeof p.skipSec === 'number') setImportSkip(p.skipSec)
      } else if (p.stage === 'paused') {
        setImportPaused(true)
      } else if (p.stage === 'resumed') {
        setImportPaused(false)
      } else if (p.stage === 'done' || p.stage === 'stopped') {
        setImportStage('')
        setImportPct(100)
      }
    })
  }, [])

  const fmtClock = (sec: number): string => {
    const s = Math.max(0, Math.floor(sec))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const ss = s % 60
    const mm = String(m).padStart(2, '0')
    const t = String(ss).padStart(2, '0')
    return h > 0 ? `${h}:${mm}:${t}` : `${mm}:${t}`
  }

  // 导入时用录音按钮下方的电平条显示完成百分比
  useEffect(() => {
    const bar = levelRef.current
    if (!bar) return
    if (importing && importStage !== '') {
      const p = importStage === 'transcribe' ? Math.max(1, importPct) : 2
      bar.style.width = `${p}%`
    } else if (!importing) {
      bar.style.width = '0%'
    }
  }, [importing, importStage, importPct])

  // 会话课件
  const [decks, setDecks] = useState<SessionSlide[]>([])
  const decksRef = useRef<SessionSlide[]>([])
  const [sessionPrompt, setSessionPrompt] = useState('')
  const [pwdDraft, setPwdDraft] = useState<{ path: string; fileName: string } | null>(null)
  const [pwdInput, setPwdInput] = useState('')
  const [dragging, setDragging] = useState(false)
  // 停止流程
  const [stopSheet, setStopSheet] = useState<{ orig: string; title: string } | null>(null)
  const [review, setReview] = useState<{ orig: string; pol: string } | null>(null)
  const [busyAction, setBusyAction] = useState<'' | 'polish' | 'organize'>('')
  // 实际用于本次录音的麦克风名（录音中展示）
  const [activeMic, setActiveMic] = useState('')

  const caretRef = useRef({ s: 0, e: 0, atEnd: true })
  const prevCountRef = useRef(0)
  const enginePrevRef = useRef(engine)
  // 本次录音/导入对应的转写记录 id（停止时归档，精修后写回增强版）
  const archiveIdRef = useRef<string | null>(null)

  // 计时器（暂停/恢复时冻结/续走，不归零）
  useEffect(() => {
    const prev = enginePrevRef.current
    enginePrevRef.current = engine
    if (engine !== 'recording') return
    if (prev !== 'paused') useApp.getState().startElapsed()
    const t = setInterval(() => useApp.getState().tickElapsed(), 1000)
    return () => clearInterval(t)
  }, [engine])

  // 追加转写时保住光标
  useEffect(() => {
    const ta = textRef.current
    if (!ta) return
    const count = segments.length
    if (count > prevCountRef.current) {
      prevCountRef.current = count
      const caret = caretRef.current
      requestAnimationFrame(() => {
        if (ta !== textRef.current) return
        const end = ta.value.length
        if (caret.atEnd || end === 0) {
          ta.setSelectionRange(end, end)
        } else {
          ta.setSelectionRange(Math.min(caret.s, end), Math.min(caret.e, end))
        }
        ta.scrollTop = ta.scrollHeight
      })
    }
  }, [transcriptText, segments.length])

  const rememberCaret = (): void => {
    const ta = textRef.current
    if (!ta) return
    caretRef.current = {
      s: ta.selectionStart,
      e: ta.selectionEnd,
      atEnd: ta.selectionEnd >= ta.value.length - 2
    }
  }

  const pushChunk = (data: Float32Array, rate: number): void => {
    if (recActiveRef.current) {
      window.api.rec.pushPcm(data, rate)
    } else {
      preBufRef.current.push({ data, rate })
      if (preBufRef.current.length > 400) preBufRef.current.shift()
    }
  }

  const flushPre = (): void => {
    const buf = preBufRef.current
    preBufRef.current = []
    for (const b of buf) window.api.rec.pushPcm(b.data, b.rate)
  }

  // 录音前确保麦克风：未授权 → 先请求权限；未设置或设备已失效 → 回退系统默认
  const ensureMicForRecord = async (): Promise<string | null> => {
    const perm = await micPermission()
    let granted = perm.granted
    let inputs = useApp.getState().audioInputs
    const pref = settings?.mic?.preferredDeviceId ?? ''
    const prefValid = !!pref && inputs.some((i) => i.deviceId === pref)
    if (!granted || !prefValid) {
      if (!granted) granted = await requestMicPermission()
      if (!granted) {
        useApp.getState().toastMsg({ kind: 'err', msg: t('cap.micDenied') })
        return null
      }
      inputs = await listAudioInputs()
      useApp.getState().setAudioInputs(inputs)
    }
    return pref && inputs.some((i) => i.deviceId === pref) ? pref : ''
  }

  const handleStart = async (): Promise<void> => {
    if (busyRef.current || !settings) return
    busyRef.current = true
    setStarting(true)
    try {
      useApp.getState().clearTranscript()
      archiveIdRef.current = null
      const fakeMic = (window as unknown as { __fakeMic?: boolean }).__fakeMic === true
      if (fakeMic) {
        captureRef.current = { stop: async () => undefined, rate: 16000, micLabel: 'Fake mic' }
      } else {
        // 未配置/未授权麦克风：先请求权限并选用默认设备
        const deviceId = await ensureMicForRecord()
        if (deviceId === null) return
        const cap = await startCapture(
          pushChunk,
          (v) => {
            if (levelRef.current) levelRef.current.style.width = `${Math.round(v * 100)}%`
          },
          deviceId || undefined
        )
        captureRef.current = cap
        setActiveMic(cap.micLabel)
      }
      const res = await window.api.rec.start({
        prompt: sessionPrompt,
        decks: decksRef.current.map((d) => ({ path: d.path, password: d.password }))
      })
      if (!res.ok) {
        await captureRef.current?.stop()
        captureRef.current = null
        useApp.getState().toastMsg({ kind: 'err', msg: res.error || t('cap.startFail') })
        return
      }
      recActiveRef.current = true
      flushPre()
      useApp.getState().toastMsg({ kind: 'ok', msg: t('cap.started') })
    } catch (e) {
      useApp.getState().toastMsg({
        kind: 'err',
        msg: t('cap.micFail', { err: (e as Error).message || '' })
      })
    } finally {
      busyRef.current = false
      setStarting(false)
    }
  }

  const handleStop = async (): Promise<void> => {
    if (!recActiveRef.current || stopping) return
    setStopping(true)
    recActiveRef.current = false
    try {
      await new Promise((r) => setTimeout(r, 300))
      const res = await window.api.rec.stop()
      await captureRef.current?.stop()
      captureRef.current = null
      setActiveMic('')
      const st = useApp.getState()
      st.toastMsg({ kind: 'ok', msg: t('cap.stopped', { n: res.result?.segmentCount ?? 0 }) })
      const expected = res.result?.segmentCount ?? 0
      for (let i = 0; i < 60; i++) {
        if (useApp.getState().segments.length >= expected) break
        await new Promise((r) => setTimeout(r, 50))
      }
      const text = useApp.getState().transcriptText.trim()
      if (!text) return
      // 归档本次实时转写（供「转写记录」页复用）
      await archiveRaw(text, { source: 'mic', title: defaultTitle() })
      const cfg = await window.api.settings.get()
      if (cfg.llm.apiKey && decksRef.current.length) {
        // 有会话课件 → 询问处理方式
        setStopSheet({ orig: text, title: defaultTitle() })
        return
      }
      // 无课件：保持原逻辑（自动整理或提示配 Key）
      if (cfg.autoOrganizeOnStop && cfg.llm.apiKey) {
        await runOrganize({ title: defaultTitle(), sourceText: text }, { auto: true })
      } else if (cfg.autoOrganizeOnStop && !cfg.llm.apiKey) {
        useApp.getState().toastMsg({
          kind: 'info',
          msg: t('cap.noKeyAutoSkip')
        })
      }
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: t('cap.stopFail') + ((e as Error).message || '') })
    } finally {
      setStopping(false)
    }
  }

  const handlePause = async (): Promise<void> => {
    if (!recActiveRef.current) return
    try {
      await window.api.rec.pause()
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: t('cap.pauseFail') + ((e as Error).message || '') })
    }
  }

  const handleResume = async (): Promise<void> => {
    try {
      await window.api.rec.resume()
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: t('cap.resumeFail') + ((e as Error).message || '') })
    }
  }

  // ── 转写记录自动归档（供「转写记录」页再次整理，无需重新转写）──
  const archiveRaw = async (raw: string, opts: { source: 'mic' | 'import'; title?: string; sourceName?: string; durationMs?: number }): Promise<void> => {
    const text = (raw || '').trim()
    if (!text) {
      archiveIdRef.current = null
      return
    }
    try {
      const rec = await window.api.transcriptions.save({
        source: opts.source,
        title: opts.title,
        sourceName: opts.sourceName ?? (opts.source === 'mic' ? t('trans.sourceMic') : ''),
        rawText: text,
        durationMs: opts.durationMs ?? useApp.getState().elapsedMs
      })
      archiveIdRef.current = rec.id
    } catch {
      archiveIdRef.current = null
    }
  }

  const applyEnhancedToArchive = async (enhanced: string): Promise<void> => {
    if (!archiveIdRef.current) return
    try {
      await window.api.transcriptions.save({ id: archiveIdRef.current, enhancedText: enhanced, keepEnhanced: false })
    } catch {
      /* 静默：归档失败不影响主流程 */
    }
  }

  // ── 会话课件（拖放/选择/解锁） ──────────────────────────
  const updateDecks = (next: SessionSlide[]): void => {
    decksRef.current = next
    setDecks(next)
  }

  const commitDeck = async (desc: DeckDescriptor, password: string): Promise<void> => {
    if (decksRef.current.some((d) => d.path === desc.path)) return
    const slide: SessionSlide = {
      path: desc.path,
      fileName: desc.fileName,
      kind: desc.kind,
      pageCount: desc.pageCount,
      chars: desc.chars,
      password
    }
    updateDecks([...decksRef.current, slide])
    if (useApp.getState().engine === 'recording') {
      // 录音中拖入：立即并入句子术语词典（提示词需下次开始生效）
      window.api.slides.useForSession(desc.path, password || undefined).catch(() => undefined)
      useApp.getState().toastMsg({ kind: 'info', msg: t('cap.deckAdded') })
    }
  }

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const arr = Array.from(files).slice(0, 6)
    for (const file of arr) {
      try {
        const p = await window.api.slides.fromFile(file)
        if (!p) continue
        if (/\.(m4a|mp3|wav|mp4|m4b|aac|flac|ogg|opus|webm|caf|aiff)$/i.test(p)) {
          // 拖入的是录音文件 → 走导入转写
          await importPath(p, file.name || p.split('/').pop() || t('note.recordingFallback'))
          continue
        }
        if (!/\.(pdf|pptx)$/i.test(p)) continue
        const desc = await window.api.slides.parse(p)
        if (desc.passwordNeeded) {
          setPwdDraft({ path: p, fileName: desc.fileName })
          continue
        }
        await commitDeck(desc, '')
      } catch {
        /* ignore */
      }
    }
  }

  const unlockDropped = async (): Promise<void> => {
    if (!pwdDraft || !pwdInput.trim()) return
    try {
      const desc = await window.api.slides.unlock(pwdDraft.path, pwdInput.trim())
      await commitDeck(desc, pwdInput.trim())
      setPwdDraft(null)
      setPwdInput('')
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: t('cap.unlockFail') + ((e as Error).message || '') })
    }
  }

  const removeDeck = (path: string): void => {
    updateDecks(decksRef.current.filter((d) => d.path !== path))
  }

  const pickDeckFile = async (): Promise<void> => {
    const d = await window.api.slides.pick()
    if (!d) return
    if (d.passwordNeeded) {
      setPwdDraft({ path: d.path, fileName: d.fileName })
      return
    }
    await commitDeck(d, '')
  }

  // 全局拖放（仅接收课件文件；内部笔记拖拽不应触发课件遮罩）
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent): boolean =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    const over = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDragging(true)
    }
    const enter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const leave = (): void => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const drop = (e: DragEvent): void => {
      depth = 0
      setDragging(false)
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files)
    }
    const end = (): void => {
      depth = 0
      setDragging(false)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('dragend', end)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('dragend', end)
    }
  }, [])

  // ── 停止流程动作 ────────────────────────────────────────
  const deckPayload = (): { paths: string[]; passwords: string[] } => ({
    paths: decksRef.current.map((d) => d.path),
    passwords: decksRef.current.map((d) => d.password)
  })

  const organizeWithText = async (title: string, text: string): Promise<boolean> => {
    setBusyAction('organize')
    try {
      const { paths, passwords } = deckPayload()
      const r = await runOrganize(
        { title, sourceText: text, slidesPaths: paths, slidesPasswords: passwords },
        { auto: true }
      )
      if (r.ok) useApp.getState().toastMsg({ kind: 'ok', msg: t('cap.orgDone') })
      return r.ok
    } finally {
      setBusyAction('')
    }
  }

  const chooseStopMode = async (mode: StopMode): Promise<void> => {
    const s = stopSheet
    setStopSheet(null)
    if (!s) return
    if (mode === 'none') {
      useApp.getState().toastMsg({ kind: 'ok', msg: t('cap.stoppedNoDeck') })
      return
    }
    if (mode === 'organize') {
      await organizeWithText(s.title, s.orig)
      return
    }
    // polish
    setBusyAction('polish')
    try {
      const { paths, passwords } = deckPayload()
      const pol = await window.api.llm.polish({
        sourceText: s.orig,
        slidesPaths: paths,
        slidesPasswords: passwords
      })
      setReview({ orig: s.orig, pol: pol.text })
    } catch (e) {
      useApp.getState().toastMsg({ kind: 'err', msg: t('cap.polishFail') + ((e as Error).message || '') })
      setStopSheet(s) // 让用户重选
    } finally {
      setBusyAction('')
    }
  }

  const reviewAction = async (action: 'apply-organize' | 'apply-only' | 'skip-organize' | 'cancel'): Promise<void> => {
    const r = review
    setReview(null)
    if (!r) return
    const title = defaultTitle()
    if (action === 'cancel') return
    if (action === 'apply-only') {
      void applyEnhancedToArchive(r.pol)
      useApp.getState().setTranscriptText(r.pol)
      useApp.getState().toastMsg({ kind: 'ok', msg: t('cap.polishApplied') })
      return
    }
    const text = action === 'apply-organize' ? r.pol : r.orig
    if (action === 'apply-organize') {
      void applyEnhancedToArchive(r.pol)
      useApp.getState().setTranscriptText(r.pol)
    }
    await organizeWithText(title, text)
  }

  const patchClean = (k: 'fillers' | 'repeats' | 'punctuation', v: boolean): void => {
    const st = useApp.getState()
    const cur = st.settings
    if (!cur) return
    void st.patchSettings({ clean: { ...cur.clean, [k]: v } })
  }

  const handleOrganize = (): void => {    const st = useApp.getState()
    const text = st.transcriptText.trim()
    if (!text) {
      st.toastMsg({ kind: 'err', msg: t('cap.noText') })
      return
    }
    if (!st.settings?.llm.apiKey) {
      st.toastMsg({ kind: 'info', msg: t('cap.needKey') })
      st.setTab('settings')
      return
    }
    setShowOrg(true)
  }

  const handleClear = (): void => {
    if (!transcriptText) return
    if (window.confirm(t('cap.clearConfirm'))) {
      useApp.getState().clearTranscript()
      updateDecks([])
    }
  }

  // 导入已有录音文件 → 本地转写（适合用别的设备录好、还没用过本应用整理的用户）
  const importPath = async (filePath: string, fileName: string): Promise<void> => {
    const st = useApp.getState()
    if (importing || st.engine !== 'idle') return
    useApp.getState().clearTranscript()
    updateDecks([])
    archiveIdRef.current = null
    setImporting(true)
    useApp.getState().setImporting(true)
    setImportStage('decode')
    setImportPct(0)
    setImportPaused(false)
    setImportPos(0)
    setImportSkip(0)
    try {
      const res = await window.api.rec.importFile(filePath)
      if (res.ok && !res.stopped) {
        // 归档完整转写
        await archiveRaw(useApp.getState().transcriptText, {
          source: 'import',
          title: fileName.replace(/\.[a-z0-9]{2,5}$/i, ''),
          sourceName: fileName,
          durationMs: res.durationMs
        })
      }
      if (res.stopped) {
        const n = res.segmentCount ?? 0
        st.toastMsg({ kind: 'info', msg: t('cap.importStopped', { file: fileName, n }) })
      } else if (res.ok) {
        const n = res.segmentCount ?? 0
        st.toastMsg({ kind: 'ok', msg: t('cap.importDone', { file: fileName, n }) })
      } else {
        st.toastMsg({ kind: 'err', msg: t('cap.importFail') + ' ' + (res.error || '') })
      }
    } catch (e) {
      useApp.getState().toastMsg({
        kind: 'err',
        msg: t('cap.importFail') + ' ' + ((e as Error).message || '')
      })
    } finally {
      setImporting(false)
      useApp.getState().setImporting(false)
      setImportStage('')
      setImportPct(0)
      setImportPaused(false)
    }
  }

  const handleImport = async (): Promise<void> => {
    const st = useApp.getState()
    if (importing || st.engine !== 'idle') return
    try {
      const picked = await window.api.dialog.pickAudio()
      if (!picked) return
      await importPath(picked.path, picked.fileName)
    } catch (e) {
      useApp.getState().toastMsg({
        kind: 'err',
        msg: t('cap.importFail') + ' ' + ((e as Error).message || '')
      })
    }
  }

  const handleImportPauseToggle = async (): Promise<void> => {
    if (importPaused) await window.api.rec.importResume()
    else await window.api.rec.importPause()
    setImportPaused(!importPaused)
  }
  const handleImportStop = async (): Promise<void> => {
    await window.api.rec.importStop()
  }

  const rec = engine === 'recording'
  const paused = engine === 'paused'
  const startingUp = engine === 'starting' || starting
  const busy = startingUp || stopping || busyAction !== '' || importing
  const statusText = importing
    ? importPaused
      ? t('cap.importPausedNote')
      : importStage === 'decode'
        ? t('cap.importDecoding')
        : t('cap.importStatus', { pct: Math.round(importPct) })
    : engine === 'starting'
      ? engineDetail || t('rec.loadingModel')
      : engine === 'recording'
        ? t('rec.recording')
        : paused
          ? t('cap.paused')
          : engine === 'stopping' || stopping
            ? t('rec.finishing')
            : engineDetail || t('rec.idle')

  // 当前麦克风提示（录音中用真实 label；空闲时用设置里选中的）
  const micCaption = activeMic || resolveActiveMic(audioInputs, settings?.mic?.preferredDeviceId ?? '')?.label || ''

  // 中栏宽度响应式（与侧栏/笔记栏一致：文字随宽度收缩、过窄截断/隐藏）
  const capTitleFs = Math.max(13, Math.min(18, midW * 0.066))
  const capLabelFs = Math.max(9.5, Math.min(12, midW * 0.043))
  const capDeckHintShow = midW >= 170
  const capMicShow = midW >= 250
  const capMicFs = Math.max(8, Math.min(10.5, (midW - 250) / 5))
  // 右侧「使用提示」：空闲且还没有转写内容时展示，一旦开始转写/录音即消失
  const showGuideHints = engine === 'idle' && !importing && !transcriptText.trim()

  return (
    <div className="flex h-full gap-4">
      {/* 左：控制面板 */}
      <div className="panel flex min-h-0 shrink-0 flex-col overflow-hidden p-5" style={{ width: midW }}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="min-w-0 truncate font-semibold" style={{ fontSize: capTitleFs }} title={t('rec.title')}>
              {t('rec.title')}
            </h2>
          </div>
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              importing
                ? 'animate-pulse bg-warn'
                : rec
                  ? 'animate-pulse bg-err'
                  : paused
                    ? 'animate-pulse bg-warn'
                    : startingUp
                      ? 'animate-pulse bg-warn'
                      : 'bg-ok/70'
            }`}
          />
        </div>

        <div className="mt-6 flex flex-col items-center gap-3">
          <button
            onClick={rec ? () => void handlePause() : paused ? () => void handleResume() : () => void handleStart()}
            disabled={busy || !settings}
            title={rec ? t('cap.pause') : paused ? t('cap.resume') : t('rec.start')}
            className={`flex h-24 w-24 items-center justify-center rounded-full border-4 transition active:scale-95 disabled:opacity-50 cursor-pointer ${
              rec
                ? 'border-err bg-err/15 text-err'
                : paused
                  ? 'border-warn bg-warn/15 text-warn'
                  : 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
            }`}
          >
            {startingUp ? <Spinner size={30} /> : rec ? <IconPause /> : paused ? <IconPlay /> : <IconMic />}
          </button>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className={`shrink-0 font-mono tabular-nums ${rec ? 'text-err' : paused ? 'text-warn' : 'text-[color:var(--dim)]'}`}>
              {fmtTime(elapsedMs)}
            </span>
            <span className="text-[color:var(--dim)]">·</span>
            <span className="min-w-0 truncate text-[color:var(--dim)]" title={statusText}>
              {statusText}
            </span>
          </div>
          {paused && (
            <div className="flex items-center gap-1.5 rounded-lg border border-warn/40 bg-warn/10 px-3 py-1.5 text-[11px] text-warn">
              ⏸ {t('cap.pausedHint')}
            </div>
          )}
          {(rec || paused) && (
            <button
              className="btn-danger !px-4 !py-1.5 text-xs"
              onClick={() => void handleStop()}
              disabled={stopping || busyAction !== ''}
              title={t('rec.stop')}
            >
              <IconStop /> {t('cap.endRecording')}
            </button>
          )}
          <div className="h-1.5 w-full max-w-[176px] overflow-hidden rounded-full bg-surface-3">
            <div
              ref={levelRef}
              className={`h-full w-0 rounded-full transition-none ${importing ? 'bg-amber-400' : 'bg-[var(--accent)]'}`}
            />
          </div>
          {importing ? (
            <div className="flex w-full items-center justify-center gap-1 overflow-hidden text-[color:var(--dim)]" style={{ fontSize: capMicFs }}>
              <span className="shrink-0">{importPaused ? '⏸' : '⏳'}</span>
              <span className="min-w-0 flex-1 truncate text-center" title={t('cap.importTranscribing')}>
                {importStage === 'decode'
                  ? t('cap.importDecoding')
                  : importStage === 'ready'
                    ? t('cap.importReady')
                    : `${Math.round(importPct)}% · ${t('cap.importPosShort', { pos: fmtClock(importPos), total: fmtClock(importTotal) })}`}
              </span>
            </div>
          ) : (
            micCaption &&
            capMicShow && (
              <div className="flex w-full items-center justify-start gap-1 overflow-hidden text-[color:var(--dim)]" style={{ fontSize: capMicFs }}>
                <span className="shrink-0">🎤</span>
                <span className="min-w-0 flex-1 truncate" title={micCaption}>{micCaption}</span>
              </div>
            )
          )}
        </div>

        {/* 其余设置区：小窗时可滚动（录音按钮/状态保持在框内固定） */}
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="my-3 border-t border-edge/60" />

        {/* 会话课件 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-medium text-[color:var(--dim)]" style={{ fontSize: capLabelFs }} title={t('rec.slides')}>
              {t('rec.slides')}
            </span>
            <button className="btn-ghost shrink-0 !px-2 !py-1 text-[11px]" style={{ fontSize: capLabelFs }} onClick={() => void pickDeckFile()} disabled={busy}>
              {t('cap.pickDeck')}
            </button>
          </div>
          {capDeckHintShow && (
            <div className="truncate leading-relaxed text-[color:var(--dim)]" style={{ fontSize: Math.max(9, capLabelFs - 1) }}>
              {t('cap.dropHint')}
            </div>
          )}
          {decks.length > 0 && (
            <div className="space-y-1.5">
              {decks.map((d) => (
                <div key={d.path} className="flex items-center justify-between gap-1 rounded-lg border border-edge bg-[var(--surface-2)] px-2 py-1.5 text-xs">
                  <span className="min-w-0 truncate" title={d.fileName}>
                    📎 {d.fileName}
                    <span className="ml-1 text-[10px] text-[color:var(--dim)]">{d.kind.toUpperCase()} · {d.pageCount}p</span>
                  </span>
                  <button className="shrink-0 text-[color:var(--dim)] hover:text-err cursor-pointer" onClick={() => removeDeck(d.path)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          {pwdDraft && (
            <div className="rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-2">
              <p className="text-[11px] text-warn">{t('cap.encrypted', { name: pwdDraft.fileName })}</p>
              <div className="mt-1.5 flex gap-1.5">
                <input
                  className="inp !py-1 text-xs"
                  type="password"
                  placeholder={t('common.passwordPh')}
                  value={pwdInput}
                  onChange={(e) => setPwdInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void unlockDropped()
                  }}
                />
                <button className="btn-primary !px-3 !py-1.5 text-xs" onClick={() => void unlockDropped()}>
                  {t('cap.unlock')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-1.5 space-y-1">
          <span className="truncate font-medium text-[color:var(--dim)]" style={{ fontSize: capLabelFs }}>{t('rec.prompt')}</span>
          <textarea
            className="inp h-14 resize-none font-mono"
            style={{ fontSize: Math.max(10, capLabelFs) }}
            value={sessionPrompt}
            onChange={(e) => setSessionPrompt(e.target.value)}
            placeholder={t('cap.promptPh')}
            spellCheck={false}
          />
          <div className="pt-1">
            <span className="truncate font-medium text-[color:var(--dim)]" style={{ fontSize: capLabelFs }}>{t('rec.clean')}</span>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-dim" style={{ fontSize: Math.max(9.5, capLabelFs - 0.5) }}>
              <CheckSmall label={t('cap.cleanFillers')} checked={settings?.clean.fillers ?? false} onChange={(v) => void patchClean('fillers', v)} />
              <CheckSmall label={t('cap.cleanRepeats')} checked={settings?.clean.repeats ?? false} onChange={(v) => void patchClean('repeats', v)} />
              <CheckSmall label={t('cap.cleanPunct')} checked={settings?.clean.punctuation ?? false} onChange={(v) => void patchClean('punctuation', v)} />
            </div>
          </div>
        </div>

        <div className="my-3 border-t border-edge/60" />

        {/* 已有录音：导入并本地转写（不需要开始录音） */}
        {!importing ? (
          <button
            className="btn-ghost flex w-full items-center justify-center gap-1.5"
            onClick={() => void handleImport()}
            disabled={importing || busy}
          >
            <span aria-hidden>📂</span>
            <span className="min-w-0 truncate" title={t('cap.importBtn')}>
              {t('cap.importBtn')}
            </span>
          </button>
        ) : (
          <div className="space-y-2 rounded-xl border border-edge bg-[var(--surface-2)] p-2.5">
            <div className="flex items-center gap-1.5 text-xs">
              {importing && <Spinner size={13} />}
              <span className="min-w-0 flex-1 truncate text-[color:var(--fg)]" title={importStage === 'decode' ? t('cap.importDecoding') : t('cap.importTranscribing')}>
                {importStage === 'decode'
                  ? t('cap.importDecoding')
                  : importStage === 'ready'
                    ? t('cap.importReady')
                    : t('cap.importStatus', { pct: Math.round(importPct) })}
              </span>
            </div>
            {/* 当前转写位置 / 跳过静音 */}
            {(importStage === 'transcribe' || importStage === '') && importTotal > 0 && (
              <div className="truncate font-mono text-[10px] text-[color:var(--dim)]">
                {t('cap.importAt', { pos: fmtClock(importPos), total: fmtClock(importTotal) })}
                {importSkip > 0 ? ` · ${t('cap.importSkip', { s: fmtClock(importSkip) })}` : ''}
              </div>
            )}
            <div className="flex gap-1.5">
              <button
                className="btn-ghost flex-1 !px-2 !py-1.5 text-xs"
                onClick={() => void handleImportPauseToggle()}
                title={importPaused ? t('cap.importResume') : t('cap.importPause')}
              >
                {importPaused ? t('cap.importResume') : t('cap.importPause')}
              </button>
              <button className="btn-danger flex-1 !px-2 !py-1.5 text-xs" onClick={() => void handleImportStop()} title={t('cap.importStop')}>
                {t('cap.importStop')}
              </button>
            </div>
          </div>
        )}

        {importing && !importPaused && (
          <div className="min-w-0 truncate text-center text-[11px] text-[color:var(--dim)]" title={t('cap.importNote')}>
            {t('cap.importNote')}
          </div>
        )}
        {importing && importPaused && (
          <div className="min-w-0 truncate text-center text-[11px] text-[color:var(--warn)]">{t('cap.importPausedNote')}</div>
        )}

        <button className="btn-ghost mt-2 w-full" onClick={handleOrganize} disabled={organizing || !transcriptText.trim()}>
          {organizing && <Spinner size={15} />}
          {organizing ? t('rec.organizing') : t('rec.organize')}
        </button>
        <button className="btn-ghost mt-2 w-full" onClick={handleClear} disabled={!transcriptText}>
          {t('rec.clear')}
        </button>

        <div className="mt-3 flex items-center justify-between rounded-xl bg-[var(--surface-2)] px-3 py-2">
          <span className="truncate text-[color:var(--dim)]" style={{ fontSize: Math.max(10, capLabelFs) }}>{t('rec.sentences')}</span>
          <span className="shrink-0 font-mono text-sm text-[var(--accent)]">{segments.length}</span>
        </div>
        </div>
      </div>

      <SplitterV value={midW} onChange={useApp((s2) => s2.setMidW)} min={150} reserveRight={440} />
      {/* 右：转写编辑区 */}
      <div className="panel flex min-w-0 flex-1 flex-col overflow-hidden" style={{ minWidth: 380 }}>
        <div className="flex items-center justify-between border-b border-edge/60 px-5 py-3">
          <span className="text-sm font-medium">{t('cap.transHeader')}</span>
          {organizing && orgProgress && (
            <span className="flex items-center gap-2 text-xs text-[var(--accent)]">
              <Spinner size={13} /> {orgProgress.detail || t('rec.organizing')}
            </span>
          )}
        </div>
        {showGuideHints && (
          <div className="border-b border-edge/60 px-5 py-2.5 leading-relaxed text-[color:var(--dim)]" style={{ fontSize: Math.max(10, capLabelFs - 0.5) }}>
            <ul className="space-y-1">
              <li>· {t('cap.hint1')}</li>
              <li>· {t('cap.hint2')}</li>
              <li>· {t('cap.hint3')}</li>
            </ul>
          </div>
        )}
        <textarea
          ref={textRef}
          className="min-h-0 w-full flex-1 resize-none bg-transparent p-5 font-mono text-[13.5px] leading-6 outline-none placeholder:text-[color:var(--dim)]"
          value={transcriptText}
          onChange={(e) => useApp.getState().setTranscriptText(e.target.value)}
          onKeyUp={rememberCaret}
          onMouseUp={rememberCaret}
          onSelect={rememberCaret}
          placeholder={rec ? t('cap.phListening') : t('cap.phStart')}
          spellCheck={false}
        />
        <div className="flex min-h-[54px] items-start gap-2 border-t border-edge/60 px-5 py-3 text-sm">
          <span className="mt-0.5 shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--dim)]">{t('rec.draft')}</span>
          <span className={`italic leading-relaxed ${rec ? 'text-[color:var(--dim)]' : 'text-[color:var(--dim)]/60'}`}>
            {draftText || (rec ? t('cap.listening') : t('cap.draftGone'))}
          </span>
        </div>
      </div>

      {/* 拖放遮罩 */}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center border-2 border-dashed border-[var(--accent)] bg-[var(--accent-soft)]/60">
          <div className="text-lg font-medium text-[var(--accent)]">{t('cap.dropOverlay')}</div>
        </div>
      )}

      {/* 停止询问 */}
      {stopSheet && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(0,0,0,0.4)] backdrop-blur-sm" onClick={() => !busyAction && setStopSheet(null)}>
          <div className="panel w-[560px] max-w-[92vw] rounded-2xl p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold">{t('cap.stopSheetTitle', { n: decksRef.current.length })}</h3>
            <p className="mt-1 text-xs text-[color:var(--dim)]">
              {t('cap.stopSheetChars', { n: stopSheet.orig.length.toLocaleString() })}
            </p>
            <div className="mt-4 space-y-2">
              <SheetOption
                title={t('cap.sheetPolishTitle')}
                desc={t('cap.sheetPolishDesc')}
                onClick={() => void chooseStopMode('polish')}
                busy={busyAction === 'polish'}
              />
              <SheetOption
                title={t('cap.sheetOrgTitle')}
                desc={t('cap.sheetOrgDesc')}
                onClick={() => void chooseStopMode('organize')}
                busy={busyAction === 'organize'}
              />
              <SheetOption
                title={t('cap.sheetNoneTitle')}
                desc={t('cap.sheetNoneDesc')}
                onClick={() => void chooseStopMode('none')}
                busy={false}
              />
            </div>
          </div>
        </div>
      )}

      {/* 精修审阅 */}
      {review && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(0,0,0,0.5)] backdrop-blur-sm">
          <div className="panel flex h-[86vh] w-[1100px] max-w-[96vw] flex-col overflow-hidden rounded-2xl p-5">
            <h3 className="text-lg font-semibold">{t('cap.reviewTitle')}</h3>
            <p className="mt-1 text-xs text-[color:var(--dim)]">{t('cap.reviewHint')}</p>
            <div className="mt-3 grid min-h-0 flex-1 grid-cols-2 gap-3">
              <div className="flex min-h-0 flex-col rounded-xl border border-edge">
                <div className="border-b border-edge/60 px-3 py-1.5 text-xs font-medium text-[color:var(--dim)]">{t('cap.reviewOrig')}</div>
                <textarea readOnly className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-5 outline-none" value={review.orig} />
              </div>
              <div className="flex min-h-0 flex-col rounded-xl border border-[var(--accent)]/50">
                <div className="border-b border-edge/60 bg-[var(--accent-soft)] px-3 py-1.5 text-xs font-medium text-[var(--accent)]">{t('cap.reviewPol')}</div>
                <textarea readOnly className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-5 outline-none text-[var(--fg)]" value={review.pol} />
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button className="btn-ghost" onClick={() => void reviewAction('cancel')}>{t('common.cancel')}</button>
              <button className="btn-ghost" onClick={() => void reviewAction('skip-organize')} disabled={busyAction === 'organize'}>
                {busyAction === 'organize' ? <Spinner size={14} /> : null}{t('cap.skipPolOrg')}
              </button>
              <button className="btn-ghost" onClick={() => void reviewAction('apply-only')}>{t('cap.applyOnly')}</button>
              <button className="btn-primary" onClick={() => void reviewAction('apply-organize')} disabled={busyAction === 'organize'}>
                {busyAction === 'organize' && <Spinner size={14} />}{t('cap.applyAndOrg')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showOrg && (
        <OrganizeDialog
          title={defaultTitle()}
          sourceText={useApp.getState().transcriptText.trim()}
          initialDecks={decksRef.current}
          onClose={() => setShowOrg(false)}
        />
      )}
    </div>
  )
}

function SheetOption({
  title,
  desc,
  onClick,
  busy
}: {
  title: string
  desc: string
  onClick: () => void
  busy: boolean
}): React.JSX.Element {
  return (
    <button
      className="w-full rounded-xl border border-edge bg-[var(--surface-2)] p-3.5 text-left transition hover:border-[var(--accent)] disabled:opacity-60 cursor-pointer"
      onClick={onClick}
      disabled={busy}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{title}</span>
        {busy && <Spinner size={14} />}
      </div>
      <div className="mt-1 text-xs text-[color:var(--dim)]">{desc}</div>
    </button>
  )
}

function CheckSmall({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <input
        type="checkbox"
        className="accent-[var(--accent)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  )
}
