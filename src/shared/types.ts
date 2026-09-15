// ── 跨进程共享类型 ──────────────────────────────────────────────

export interface AsrSegment {
  seq: number
  text: string
  t0: number // 秒（相对本段录音起点）
  t1: number
  cleaned: boolean
}

export interface AsrDraft {
  text: string
  t0: number
  sinceLastUpdate: boolean
}

export type EngineState =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'finalizing'
  | 'ready'
  | 'error'

export interface AsrStateMsg {
  state: EngineState
  detail?: string
}

export interface RecordingResult {
  elapsedMs: number
  segmentCount: number
  wavPath?: string
}

// ── 转写记录库 ───────────────────────────────────────────────────
/** 一次完整转写的来源 */
export type TranscriptionSource = 'mic' | 'import'

/** 转写记录：原始转写 + 可选 AI 增强（润色）版本，列表/详情/删除 */
export interface TranscriptionRecord {
  id: string
  /** mic=实时录音 · import=导入文件 */
  source: TranscriptionSource
  title: string
  /** 来源名：导入=文件名 · 实时=“实时录音” */
  sourceName: string
  createdAt: number
  durationMs: number
  /** 转写所用语言代码（如 zh/en/auto），可为空 */
  language?: string
  rawText: string
  /** AI 增强（润色）版本；尚未生成时为 null */
  enhancedText?: string | null
}

export interface TranscriptionDraft {
  id?: string
  source?: TranscriptionSource
  title?: string
  sourceName?: string
  durationMs?: number
  language?: string
  rawText?: string
  /** 传入即覆盖增强版；传 null 表示清除 */
  enhancedText?: string | null
  /** true 表示保留原 enhancedText（防止误清） */
  keepEnhanced?: boolean
}

/** 列表项（不含全文，供列表性能） */
export interface TranscriptionSummary {
  id: string
  source: TranscriptionSource
  title: string
  sourceName: string
  createdAt: number
  durationMs: number
  rawLen: number
  hasEnhanced: boolean
  preview: string
}


// ── 笔记 ────────────────────────────────────────────────────────
export interface NoteRecord {
  id: string
  title: string
  kind: string
  notebookId?: string | null
  createdAt: number
  updatedAt: number
  durationMs: number
  templateId: string
  sourceText: string
  noteMd: string
  recordingPath?: string
  meta?: string
  tags: string[]
}

export interface Notebook {
  id: string
  name: string
  createdAt: number
  color?: string
  /** 父笔记本（null/缺失 = 顶层），支持子笔记本 */
  parentId?: string | null
  /** 同级手动排序（越小越靠前） */
  ord?: number
  /** 侧栏隐藏 */
  hidden?: boolean
}

export interface NoteDraft {
  id?: string
  title: string
  sourceText: string
  noteMd: string
  templateId: string
  notebookId?: string | null
  durationMs?: number
  recordingPath?: string
  tags?: string[]
}

export interface SearchHit {
  id: string
  title: string
  updatedAt: number
  durationMs: number
  tags: string[]
  snippet: string
}

export interface PickedImage {
  name: string
  size: number
  dataUrl: string
}

export interface NoteTemplate {
  id: string
  name: string
  description: string
  systemPrompt: string // 完整整理指令（可含 {title}）
}

// ── 设置 ────────────────────────────────────────────────────────
export interface CleanRules {
  fillers: boolean
  repeats: boolean
  punctuation: boolean
}

export interface WhisperSettings {
  modelFile: string // 文件名（在模型目录内）或绝对路径
  binaryPath: string // 留空 = 自动探测 whisper-server
  language: string
  threads: number
  sensitivity: number // 0-100 → VAD 阈值
  minSilenceMs: number
  maxSpeechSec: number
  partialPreview: boolean
  maxFinalQueue: number
  /** 使用 GPU（Metal）加速；关掉则强制 CPU（-ng）。默认开 */
  useGpu?: boolean
}

export interface UiSettings {
  language: 'zh' | 'en'
}

/** 录音输入设备偏好（持久化；preferredDeviceId 空 = 系统默认麦克风） */
export interface MicSettings {
  preferredDeviceId: string
}

export interface LlmSettings {
  baseUrl: string
  modelId: string
  apiKey: string
  maxChunkChars: number
  templateId: string
  customTemplate: string
  /** 单次请求输出上限（tokens）；越大笔记越长但越慢。默认 16384 */
  maxOutputTokens?: number
}

export interface StorageSettings {
  /** 原始录音所在根目录（空 = 默认）；实际存到 <root>/whisper-notes-recordings/ */
  recordingsParent: string
  /** 笔记/转写库所在根目录（空 = 默认）；实际存到 <root>/whisper-notes/（含 library.db） */
  dataParent: string
}

export interface AppSettings {
  whisper: WhisperSettings
  clean: CleanRules
  llm: LlmSettings
  ui: UiSettings
  mic: MicSettings
  saveWav: boolean
  autoOrganizeOnStop: boolean
  storage: StorageSettings
  /** 保留字段（历史遗留）：缺少模型时始终自动下载，不再提供开关 */
  models?: { autoDownload?: boolean }
}

export interface DailyUsage {
  date: string // YYYY-MM-DD
  used: number
}

// ── 模型目录 ────────────────────────────────────────────────────
export interface ModelInfo {
  id: string
  file: string
  url: string
  sizeLabel: string
  langs: string
  desc: string
}

export interface ModelStatus {
  info: ModelInfo
  present: boolean
  sizeBytes: number
  localPath?: string
}

export interface ModelProgress {
  file: string
  received: number
  total: number
  pct: number
}

export type NoteLength = 'concise' | 'standard' | 'detailed'

export interface DeckDescriptor {
  path: string
  fileName: string
  kind: 'pdf' | 'pptx'
  pageCount: number
  chars: number
  terms: string
  passwordNeeded?: boolean
}

export type LlmProgressStage = 'chunk' | 'merge' | 'polish' | 'done' | 'error'

export interface LlmProgress {
  stage: LlmProgressStage
  part?: number
  parts?: number
  detail?: string
  /** 当前这一步处理的字符数（详情面板显示“本次请求大小”） */
  chars?: number
}

export interface OrganizeJobEvent {
  jobId: string
  title?: string
  mode?: 'new' | 'replace'
  stage: LlmProgressStage
  part?: number
  parts?: number
  detail?: string
  /** 当前这一步处理的字符数（详情面板用） */
  chars?: number
  /** 该任务已耗时（ms） */
  elapsedMs?: number
  /** 该任务已发出的模型请求数 */
  requests?: number
}

export interface OrganizeJobError {
  jobId: string
  error: string
  /** 用户主动取消（不算失败，不弹红条） */
  canceled?: boolean
}

export interface OrganizeJobDone {
  jobId: string
  mode: 'new' | 'replace'
  replaceId?: string
  title: string
  noteMd: string
  sourceText: string
  templateId?: string
  length?: NoteLength
  requests: number
  chunks: number
  truncated?: boolean
  continuations?: number
}

export interface OrganizeResult {
  noteMd: string
  requests: number
  chunks: number
  /** 有内容触顶（即使续写过仍可能不完整） */
  truncated?: boolean
  /** 续写次数合计 */
  continuations?: number
}

export interface OrganizeRequest {
  title: string
  sourceText: string
  templateId?: string
  length?: NoteLength
  /** new=生成新笔记（默认） · replace=替换指定笔记内容 */
  mode?: 'new' | 'replace'
  replaceId?: string
  slidesPath?: string
  slidesPassword?: string
  slidesPaths?: string[]
  slidesPasswords?: string[]
}

export interface PolishRequest {
  sourceText: string
  slidesPath?: string
  slidesPassword?: string
  slidesPaths?: string[]
  slidesPasswords?: string[]
}

export interface PolishResult {
  text: string
  requests: number
  chunks: number
}

export interface SettingsResult {
  ok: boolean
  error?: string
}

// ── 渲染层状态 ──────────────────────────────────────────────────
export interface SessionMeta {
  sessionId: string
  startedAt: number
}

// window.api 桥接声明
export interface BinaryProbe {
  found: boolean
  binaryPath: string
  /** 该引擎是否带 Metal（GPU）后端 */
  gpu?: boolean
}

export interface RecStartPayload {
  prompt?: string
  decks?: Array<{ path: string; password: string }>
}

/** 导入录音文件进度 */
export interface ImportProgress {
  stage: 'decode' | 'ready' | 'transcribe' | 'paused' | 'resumed' | 'done' | 'stopped' | 'error'
  /** 0-100（transcribe 阶段逐窗推进） */
  pct?: number
  /** 当前已送达转写的文件位置（秒） */
  posSec?: number
  /** 文件总时长（秒） */
  totalSec?: number
  /** 已识别并跳过的静音累计（秒） */
  skipSec?: number
  count?: number
}

export interface WhisperNotesApi {
  rec: {
    start(payload?: RecStartPayload): Promise<{ ok: boolean; error?: string; sessionId?: string }>
    pause(): Promise<{ ok: boolean; error?: string }>
    resume(): Promise<{ ok: boolean; error?: string }>
    stop(): Promise<{ ok: boolean; error?: string; result?: RecordingResult }>
    pushPcm(chunk: Float32Array, rate: number): void
    importFile(path: string): Promise<{ ok: boolean; error?: string; segmentCount?: number; fileName?: string; stopped?: boolean; durationMs?: number }>
    importPause(): Promise<{ ok: boolean }>
    importResume(): Promise<{ ok: boolean }>
    importStop(): Promise<{ ok: boolean }>
  }
  onAsrSegment(cb: (s: AsrSegment) => void): () => void
  onAsrDraft(cb: (d: AsrDraft) => void): () => void
  onAsrState(cb: (m: AsrStateMsg) => void): () => void
  onImportProgress(cb: (p: ImportProgress) => void): () => void
  onCloseRequest(cb: () => void): () => void
  quitConfirmed(): Promise<void>
  /** 渲染层异常上报（写 logs/renderer-errors.log） */
  reportError(payload: { message: string; stack?: string; source?: string }): void
  onLlamaProgress(cb: (p: LlmProgress) => void): () => void
  onModelProgress(cb: (p: ModelProgress) => void): () => void
  onModelError(cb: (p: { file: string; error: string }) => void): () => void

  notes: {
    list(): Promise<NoteRecord[]>
    get(id: string): Promise<NoteRecord | null>
    save(draft: NoteDraft): Promise<NoteRecord>
    remove(id: string): Promise<boolean>
    setNotebook(id: string, notebookId: string | null): Promise<boolean>
    reorder(ids: string[]): Promise<boolean>
    exportMd(id: string): Promise<string | null>
    search(q: string): Promise<SearchHit[]>
    openChild(id: string): Promise<boolean>
    emitEdit(d: { id: string; title?: string; noteMd?: string }): void
    /** 主窗把编辑内容广播给已开子窗（不写库） */
    broadcastEdit(d: { id: string; title?: string; noteMd?: string }): void
  }

  notebooks: {
    list(): Promise<Notebook[]>
    create(name: string, parentId?: string | null): Promise<Notebook>
    rename(id: string, name: string): Promise<boolean>
    remove(id: string): Promise<boolean>
    reorder(updates: Array<{ id: string; parentId: string | null; ord: number }>): Promise<boolean>
    setHidden(id: string, hidden: boolean): Promise<boolean>
  }

  onNoteSync(cb: (p: { id: string; title: string; noteMd: string }) => void): () => void

  transcriptions: {
    list(): Promise<TranscriptionSummary[]>
    get(id: string): Promise<TranscriptionRecord | null>
    /** 新建或更新（带 id 即按 id 覆盖） */
    save(draft: TranscriptionDraft): Promise<TranscriptionRecord>
    remove(id: string): Promise<boolean>
  }

  dialog: {
    pickImage(): Promise<PickedImage | null>
    pickAudio(): Promise<{ path: string; fileName: string } | null>
    pickFolder(): Promise<string | null>
  }

  slides: {
    pick(): Promise<DeckDescriptor | null>
    unlock(path: string, password: string): Promise<DeckDescriptor>
    parse(path: string): Promise<DeckDescriptor>
    useForSession(path: string, password?: string): Promise<DeckDescriptor>
    fromFile(file: File): Promise<string | null>
  }

  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
    resetDailyUsage(): Promise<void>
  }

  llm: {
    organize(req: OrganizeRequest): Promise<OrganizeResult>
    /** 后台任务式整理：立即返回 jobId，进度/结果走 onOrganizeJob/Done/Error */
    organizeStart(req: OrganizeRequest): Promise<{ ok: boolean; jobId?: string; error?: string }>
    /** 取消排队中/进行中的整理任务（进行中会中止当前 HTTP 请求） */
    organizeCancel(jobId: string): Promise<boolean>
    polish(req: PolishRequest): Promise<PolishResult>
    validateKey(): Promise<{ ok: boolean; error?: string }>
  }
  onOrganizeJob(cb: (p: OrganizeJobEvent) => void): () => void
  onOrganizeDone(cb: (p: OrganizeJobDone) => void): () => void
  onOrganizeError(cb: (p: OrganizeJobError) => void): () => void

  models: {
    catalog(): Promise<ModelInfo[]>
    status(): Promise<ModelStatus[]>
    download(id: string): Promise<void>
    cancel(file: string): Promise<boolean>
    remove(file: string): Promise<{ ok: boolean; error?: string }>
  }

  sys: {
    probeWhisper(): Promise<BinaryProbe>
    openExternal(url: string): void
    /** 复制文本（打包后页面是 file://，浏览器剪贴板 API 不可用，必须走主进程 clipboard） */
    copyText(text: string): Promise<boolean>
  }

  meta: {
    dailyUsage(): Promise<DailyUsage>
    version(): Promise<string>
  }
}
