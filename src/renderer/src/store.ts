// 全局 UI 状态（zustand）
import { create } from 'zustand'
import { setLang, t, tError } from './i18n'
import type { AudioInput } from './mic'
import type {
  AppSettings,
  AsrSegment,
  AsrStateMsg,
  BinaryProbe,
  DailyUsage,
  EngineState,
  LlmProgress,
  ModelProgress,
  ModelStatus,
  NoteRecord,
  Notebook,
  OrganizeJobDone,
  OrganizeJobError,
  OrganizeJobEvent,
  OrganizeRequest
} from '../../shared/types'

export type TabId = 'capture' | 'transcripts' | 'notes' | 'settings'

/** 界面上的整理任务（比主进程事件多了状态、日志、耗时） */
export interface OrgJob {
  jobId: string
  title: string
  mode: 'new' | 'replace'
  stage: string
  part: number
  parts: number
  detail: string
  chars?: number
  requests?: number
  startedAt: number
  updatedAt: number
  status: 'queued' | 'running' | 'error' | 'done' | 'canceled'
  error?: string
  logs: string[]
  noteId?: string
  /** 输出触顶过（可能不完整） */
  truncated?: boolean
  continuations?: number
}

/** 历史记录（持久化到 localStorage，重启后仍可查上次为什么失败） */
export interface OrgJobHistory {
  jobId: string
  title: string
  status: 'done' | 'error' | 'canceled'
  detail: string
  error?: string
  at: number
  requests?: number
  chunks?: number
  noteId?: string
  truncated?: boolean
  continuations?: number
}

const ORG_HISTORY_KEY = 'wn-org-history'
const ORG_HISTORY_MAX = 20

function loadOrgHistory(): OrgJobHistory[] {
  try {
    const raw = localStorage.getItem(ORG_HISTORY_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as OrgJobHistory[]
    return Array.isArray(arr) ? arr.slice(0, ORG_HISTORY_MAX) : []
  } catch {
    return []
  }
}

function saveOrgHistory(list: OrgJobHistory[]): void {
  try {
    localStorage.setItem(ORG_HISTORY_KEY, JSON.stringify(list.slice(0, ORG_HISTORY_MAX)))
  } catch {
    /* ignore */
  }
}

// 已删除笔记的墓碑：防止「删除后，在途的自动保存/整理写回」把笔记复活
const deletedNoteIds = new Set<string>()

// 会话内的原始请求缓存（失败后「重试」用；不持久化，避免把整段转写写进 localStorage）
const orgReqCache = new Map<string, OrganizeRequest>()
export function isNoteDeleted(id: string | undefined | null): boolean {
  return !!id && deletedNoteIds.has(id)
}
export function markNoteDeleted(id: string): void {
  deletedNoteIds.add(id)
}

export interface PendingNote {
  id?: string
  title: string
  noteMd: string
  sourceText: string
  templateId: string
  notebookId?: string | null
  durationMs: number
  tags: string[]
}

export interface ToastMsg {
  kind: 'ok' | 'err' | 'info'
  msg: string
}

export interface LayoutState {
  navW: number
  midW: number
}

function readLayout(): LayoutState {
  try {
    const v = localStorage.getItem('wn-layout')
    if (v) {
      const p = JSON.parse(v) as Partial<LayoutState>
      return { navW: p.navW ?? 208, midW: p.midW ?? 300 }
    }
  } catch {
    /* ignore */
  }
  return { navW: 208, midW: 300 }
}

interface AppState {
  tab: TabId
  engine: EngineState
  engineDetail: string
  settings: AppSettings | null
  usage: DailyUsage | null
  probe: BinaryProbe | null
  models: ModelStatus[] | null
  modelProgress: ModelProgress | null
  segments: AsrSegment[]
  transcriptText: string
  draftText: string
  level: number
  elapsedMs: number
  startedAt: number
  organizing: boolean
  orgProgress: LlmProgress | null
  /** 后台整理任务（进度卡片/详情面板用） */
  orgJobs: OrgJob[]
  /** 最近若干次整理的结果（含失败原因），重启后仍在 */
  orgHistory: OrgJobHistory[]
  /** 详情面板是否展开 */
  orgPanelOpen: boolean
  /** 刚整理出来的笔记：列表里高亮并滚动到它 */
  flashNoteId: string | null
  /** 是否正在导入录音转写（退出确认用） */
  importing: boolean
  /** 笔记本导航（左侧全局栏用）：列表 + 当前选择（'all' | 'none' | notebookId） */
  notebooks: Notebook[]
  nbSel: string
  pending: PendingNote | null
  notes: NoteRecord[] | null
  toast: ToastMsg | null
  saving: boolean
  lastLength: 'concise' | 'standard' | 'detailed'
  layout: LayoutState
  langVer: number
  audioInputs: AudioInput[]

  setLastLength(l: 'concise' | 'standard' | 'detailed'): void
  setNavW(w: number): void
  setMidW(w: number): void

  setTab(t: TabId): void
  setEngine(m: AsrStateMsg): void
  addSegment(s: AsrSegment): void
  clearTranscript(): void
  setDraft(t: string): void
  setTranscriptText(t: string): void
  setLevel(v: number): void
  tickElapsed(): void
  startElapsed(): void
  setSettings(s: AppSettings | null): void
  patchSettings(p: Partial<AppSettings>): Promise<AppSettings | null>
  setUsage(u: DailyUsage): void
  setProbe(p: BinaryProbe): void
  setModels(m: ModelStatus[]): void
  setModelProgress(p: ModelProgress | null): void
  setOrganizing(b: boolean): void
  setOrgProgress(p: LlmProgress | null): void
  setImporting(b: boolean): void
  setNotebooks(list: Notebook[]): void
  setNbSel(id: string): void
  upsertOrgJob(j: OrganizeJobEvent): void
  failOrgJob(jobId: string, error: string, canceled?: boolean): void
  finishOrgJob(jobId: string, info: { requests?: number; chunks?: number; noteId?: string; truncated?: boolean; continuations?: number }): void
  removeOrgJob(jobId: string): void
  setOrgPanelOpen(b: boolean): void
  setFlashNoteId(id: string | null): void
  pushOrgHistory(h: OrgJobHistory): void
  clearOrgHistory(): void
  setAudioInputs(list: AudioInput[]): void
  setPending(n: PendingNote | null): void
  setNotes(n: NoteRecord[]): void
  toastMsg(t: ToastMsg | null): void
  setSaving(b: boolean): void
}

export const useApp = create<AppState>((set, get) => ({
  tab: 'capture',
  engine: 'idle',
  engineDetail: '',
  settings: null,
  usage: null,
  probe: null,
  models: null,
  modelProgress: null,
  segments: [],
  transcriptText: '',
  draftText: '',
  level: 0,
  elapsedMs: 0,
  startedAt: 0,
  organizing: false,
  orgProgress: null,
  orgJobs: [],
  orgHistory: loadOrgHistory(),
  orgPanelOpen: false,
  flashNoteId: null,
  importing: false,
  notebooks: [],
  nbSel: 'all',
  pending: null,
  notes: null,
  toast: null,
  saving: false,
  langVer: 0,
  audioInputs: [],
  lastLength: (() => {
    try {
      const v = localStorage.getItem('wn-last-length')
      return v === 'concise' || v === 'detailed' || v === 'standard' ? v : 'standard'
    } catch {
      return 'standard'
    }
  })(),
  layout: readLayout(),

  setLastLength: (l) => {
    try {
      localStorage.setItem('wn-last-length', l)
    } catch {
      /* ignore */
    }
    set({ lastLength: l })
  },
  setNavW: (w) => {
    const navW = Math.max(64, Math.min(220, Math.round(w)))
    set((st) => ({ layout: { ...st.layout, navW } }))
    try {
      localStorage.setItem('wn-layout', JSON.stringify({ ...useApp.getState().layout, navW }))
    } catch {
      /* ignore */
    }
  },
  setMidW: (w) => {
    const midW = Math.max(150, Math.round(w))
    set((st) => ({ layout: { ...st.layout, midW } }))
    try {
      localStorage.setItem('wn-layout', JSON.stringify({ ...useApp.getState().layout, midW }))
    } catch {
      /* ignore */
    }
  },

  setTab: (t) => set({ tab: t }),
  setEngine: (m) => set({ engine: m.state, engineDetail: m.detail ?? '' }),
  addSegment: (s) =>
    set((st) => {
      const text = st.transcriptText
      const joined = text ? text + '\n' + s.text : s.text
      return { segments: [...st.segments, s], transcriptText: joined }
    }),
  clearTranscript: () => set({ segments: [], transcriptText: '', draftText: '', elapsedMs: 0 }),
  setDraft: (t) => set({ draftText: t }),
  setTranscriptText: (t) => set({ transcriptText: t }),
  setLevel: (v) => set({ level: v }),
  tickElapsed: () => set((st) => ({ elapsedMs: st.elapsedMs + 1000 })),
  startElapsed: () => set({ elapsedMs: 0, startedAt: Date.now() }),
  setSettings: (s) => set({ settings: s }),
  patchSettings: async (p) => {
    const next = await window.api.settings.set(p)
    if (p.ui?.language && p.ui.language !== get().settings?.ui.language) {
      setLang(p.ui.language)
    }
    set({ settings: next, langVer: get().langVer + 1 })
    return next
  },
  setUsage: (u) => set({ usage: u }),
  setProbe: (p) => set({ probe: p }),
  setModels: (m) => set({ models: m }),
  setModelProgress: (p) => set({ modelProgress: p }),
  setOrganizing: (b) => set({ organizing: b }),
  setOrgProgress: (p) => set({ orgProgress: p }),
  setImporting: (b) => set({ importing: b }),
  setNotebooks: (list) => set({ notebooks: list }),
  setNbSel: (id) => set({ nbSel: id }),
  upsertOrgJob: (j) =>
    set((st) => {
      const now = Date.now()
      const idx = st.orgJobs.findIndex((x) => x.jobId === j.jobId)
      const line = j.detail ? `${new Date(now).toLocaleTimeString()} ${j.detail}${j.chars ? ` · ${j.chars.toLocaleString()} 字符` : ''}` : ''
      if (idx < 0) {
        const job: OrgJob = {
          jobId: j.jobId,
          title: j.title || '…',
          mode: j.mode === 'replace' ? 'replace' : 'new',
          stage: String(j.stage ?? 'chunk'),
          part: j.part ?? 0,
          parts: j.parts ?? 0,
          detail: j.detail || '',
          chars: j.chars,
          requests: j.requests,
          startedAt: now,
          updatedAt: now,
          status: 'running',
          logs: line ? [line] : []
        }
        return { orgJobs: [...st.orgJobs, job], organizing: true }
      }
      const orgJobs: OrgJob[] = st.orgJobs.map((x) =>
        x.jobId === j.jobId
          ? {
              ...x,
              title: j.title ?? x.title,
              stage: String(j.stage ?? x.stage),
              part: j.part ?? x.part,
              parts: j.parts ?? x.parts,
              detail: j.detail ?? x.detail,
              chars: j.chars ?? x.chars,
              requests: j.requests ?? x.requests,
              updatedAt: now,
              status: (x.status === 'done' || x.status === 'error' || x.status === 'canceled'
                ? x.status
                : 'running') as OrgJob['status'],
              logs: line && line !== x.logs[x.logs.length - 1] ? [...x.logs, line].slice(-200) : x.logs
            }
          : x
      )
      return { orgJobs }
    }),
  failOrgJob: (jobId, error, canceled) =>
    set((st) => {
      const msg = tError(error || '')
      const orgJobs = st.orgJobs.map((x) =>
        x.jobId === jobId
          ? {
              ...x,
              status: canceled ? ('canceled' as const) : ('error' as const),
              error: msg,
              updatedAt: Date.now(),
              logs: [...x.logs, `${new Date().toLocaleTimeString()} ${msg}`].slice(-200)
            }
          : x
      )
      return { orgJobs, organizing: orgJobs.some((x) => x.status === 'running' || x.status === 'queued') }
    }),
  finishOrgJob: (jobId, info) =>
    set((st) => {
      const orgJobs = st.orgJobs.map((x) =>
        x.jobId === jobId
          ? {
              ...x,
              status: 'done' as const,
              part: x.parts || x.part,
              updatedAt: Date.now(),
              requests: info.requests ?? x.requests,
              noteId: info.noteId ?? x.noteId,
              truncated: info.truncated ?? x.truncated,
              continuations: info.continuations ?? x.continuations
            }
          : x
      )
      return { orgJobs, organizing: orgJobs.some((x) => x.status === 'running' || x.status === 'queued') }
    }),
  removeOrgJob: (jobId) =>
    set((st) => {
      const orgJobs = st.orgJobs.filter((x) => x.jobId !== jobId)
      return { orgJobs, organizing: orgJobs.some((x) => x.status === 'running' || x.status === 'queued') }
    }),
  setOrgPanelOpen: (b) => set({ orgPanelOpen: b }),
  setFlashNoteId: (id) => set({ flashNoteId: id }),
  pushOrgHistory: (h) =>
    set((st) => {
      const list = [h, ...st.orgHistory].slice(0, ORG_HISTORY_MAX)
      saveOrgHistory(list)
      return { orgHistory: list }
    }),
  clearOrgHistory: () =>
    set(() => {
      saveOrgHistory([])
      return { orgHistory: [] }
    }),
  setAudioInputs: (list) => set({ audioInputs: list }),
  setPending: (n) => set({ pending: n }),
  setNotes: (n) => set({ notes: n }),
  // 报错统一在这里翻译：主进程抛的是 @err.xxx|k=v 形式的错误码
  toastMsg: (msg) => set({ toast: msg && msg.kind === 'err' ? { ...msg, msg: tError(msg.msg) } : msg }),
  setSaving: (b) => set({ saving: b })
}))

/** 刷新笔记列表（后台整理完成后同步 UI） */
export async function refreshNotes(): Promise<void> {
  try {
    useApp.getState().setNotes(await window.api.notes.list())
  } catch {
    /* ignore */
  }
}

/** 开始一次后台整理（立即返回，不阻塞界面；进度/结果由 App 订阅事件处理） */
export async function startOrganize(
  req: OrganizeRequest
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  const r = await window.api.llm.organizeStart(req)
  if (r.ok && r.jobId) orgReqCache.set(r.jobId, req)
  if (!r.ok) {
    useApp.getState().toastMsg({ kind: 'err', msg: t('org.jobFailed') + tError(r.error || '') })
    return r
  }
  useApp.getState().upsertOrgJob({
    jobId: r.jobId as string,
    title: req.title,
    mode: req.mode === 'replace' ? 'replace' : 'new',
    stage: 'chunk',
    detail: t('org.queued')
  })
  return r
}

/** 后台任务进度 */
export function handleOrganizeJob(p: OrganizeJobEvent): void {
  useApp.getState().upsertOrgJob(p)
}

/** 后台任务完成：自动保存到笔记库；新笔记会自动跳到「全部笔记」并高亮定位 */
export async function handleOrganizeDone(p: OrganizeJobDone): Promise<void> {
  const st = useApp.getState()
  try {
    if (p.mode === 'replace' && p.replaceId) {
      // 整理期间这条笔记被删了 → 不写回（否则等于把它“复活”）
      if (isNoteDeleted(p.replaceId)) {
        st.finishOrgJob(p.jobId, { requests: p.requests, chunks: p.chunks })
        st.removeOrgJob(p.jobId)
        st.pushOrgHistory({
          jobId: p.jobId,
          title: p.title,
          status: 'canceled',
          detail: t('org.targetDeleted'),
          at: Date.now(),
          requests: p.requests,
          chunks: p.chunks
        })
        st.toastMsg({ kind: 'info', msg: t('org.targetDeleted') })
        return
      }
      const existing = await window.api.notes.get(p.replaceId)
      const rec = await window.api.notes.save({
        id: p.replaceId,
        title: existing?.title || p.title,
        sourceText: p.sourceText,
        noteMd: p.noteMd,
        templateId: p.templateId || existing?.templateId || 'study',
        notebookId: existing?.notebookId ?? null,
        durationMs: existing?.durationMs ?? 0,
        tags: existing?.tags ?? []
      })
      await refreshNotes()
      const pending = useApp.getState().pending
      if (pending?.id === rec.id) {
        useApp.getState().setPending({ ...pending, title: rec.title, noteMd: rec.noteMd, sourceText: rec.sourceText })
      }
      st.finishOrgJob(p.jobId, {
        requests: p.requests,
        chunks: p.chunks,
        noteId: rec.id,
        truncated: p.truncated,
        continuations: p.continuations
      })
      st.pushOrgHistory({
        jobId: p.jobId,
        title: rec.title,
        status: 'done',
        detail: p.truncated ? t('org.doneTruncated') : t('org.done'),
        at: Date.now(),
        requests: p.requests,
        chunks: p.chunks,
        noteId: rec.id,
        truncated: p.truncated,
        continuations: p.continuations
      })
      st.toastMsg({
        kind: p.truncated ? 'info' : 'ok',
        msg: t('org.savedExisting', { title: rec.title }) + (p.truncated ? t('org.truncatedShort') : '')
      })
      st.setPending({
        id: rec.id,
        title: rec.title,
        noteMd: rec.noteMd,
        sourceText: rec.sourceText,
        templateId: rec.templateId,
        notebookId: rec.notebookId ?? null,
        durationMs: rec.durationMs,
        tags: rec.tags
      })
      jumpToNote(rec.id)
    } else {
      const rec = await window.api.notes.save({
        title: p.title,
        sourceText: p.sourceText,
        noteMd: p.noteMd,
        templateId: p.templateId || 'study',
        durationMs: useApp.getState().elapsedMs,
        tags: []
      })
      await refreshNotes()
      st.finishOrgJob(p.jobId, {
        requests: p.requests,
        chunks: p.chunks,
        noteId: rec.id,
        truncated: p.truncated,
        continuations: p.continuations
      })
      st.pushOrgHistory({
        jobId: p.jobId,
        title: rec.title,
        status: 'done',
        detail: p.truncated ? t('org.doneTruncated') : t('org.done'),
        at: Date.now(),
        requests: p.requests,
        chunks: p.chunks,
        noteId: rec.id,
        truncated: p.truncated,
        continuations: p.continuations
      })
      st.toastMsg({
        kind: p.truncated ? 'info' : 'ok',
        msg: t('org.savedNew', { title: rec.title }) + (p.truncated ? t('org.truncatedShort') : '')
      })
      st.setPending({
        id: rec.id,
        title: rec.title,
        noteMd: rec.noteMd,
        sourceText: rec.sourceText,
        templateId: rec.templateId,
        notebookId: rec.notebookId ?? null,
        durationMs: rec.durationMs,
        tags: rec.tags
      })
      jumpToNote(rec.id)
    }
    // 完成 8 秒后自动收起卡片（结果留在“历史”里）
    setTimeout(() => useApp.getState().removeOrgJob(p.jobId), 8000)
  } catch (e) {
    const msg = tError((e as Error).message || '')
    st.failOrgJob(p.jobId, msg)
    st.pushOrgHistory({
      jobId: p.jobId,
      title: p.title,
      status: 'error',
      detail: t('org.saveFailed'),
      error: msg,
      at: Date.now(),
      requests: p.requests,
      chunks: p.chunks
    })
    st.toastMsg({ kind: 'err', msg: t('org.saveFailed') + msg })
  }
  try {
    useApp.getState().setUsage(await window.api.meta.dailyUsage())
  } catch {
    /* ignore */
  }
}

/** 后台任务失败：卡片保留为“失败”，写进历史，并弹出可读的错误 */
export function handleOrganizeError(p: OrganizeJobError): void {
  const st = useApp.getState()
  st.failOrgJob(p.jobId, p.error, p.canceled)
  const job = useApp.getState().orgJobs.find((x) => x.jobId === p.jobId)
  st.pushOrgHistory({
    jobId: p.jobId,
    title: job?.title || '…',
    status: p.canceled ? 'canceled' : 'error',
    detail: job?.detail || '',
    error: p.canceled ? undefined : tError(p.error || ''),
    at: Date.now(),
    requests: job?.requests,
    chunks: job?.parts
  })
  if (p.canceled) {
    st.toastMsg({ kind: 'info', msg: t('org.jobCanceled') })
    setTimeout(() => useApp.getState().removeOrgJob(p.jobId), 6000)
  } else {
    st.toastMsg({ kind: 'err', msg: t('org.jobFailed') + tError(p.error || '') })
  }
}

/** 跳到刚整理出来的笔记：切到笔记页 → 全部笔记 → 选中并高亮定位 */
export function jumpToNote(noteId: string): void {
  const st = useApp.getState()
  st.setTab('notes')
  st.setNbSel('all')
  st.setFlashNoteId(noteId)
  window.setTimeout(() => {
    if (useApp.getState().flashNoteId === noteId) useApp.getState().setFlashNoteId(null)
  }, 4000)
}

/** 兼容旧调用：现在改为后台任务，立即返回 */
export async function runOrganize(
  req: OrganizeRequest,
  _opts: { auto: boolean }
): Promise<{ ok: boolean; error?: string }> {
  const r = await startOrganize(req)
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

/** 失败任务重试：用会话内缓存的原始请求再跑一次 */
export async function retryOrgJob(jobId: string): Promise<void> {
  const st = useApp.getState()
  const req = orgReqCache.get(jobId)
  if (!req) {
    st.toastMsg({ kind: 'err', msg: t('org.retryUnavailable') })
    return
  }
  st.removeOrgJob(jobId)
  await startOrganize(req)
}
