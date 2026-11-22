// ── 跨进程共享类型 ──────────────────────────────────────────────

export interface AsrSegment {
  seq: number
  text: string
  t0: number // 秒（相对本段录音起点）
  t1: number
  cleaned: boolean
}

/** 转写状态（状态栏）：录音期间实时反映"引擎在忙什么、还有多少在排队" */
export interface AsrStatus {
  /** recording | paused | stopping | idle */
  state: string
  /** 正在转写的句数（引擎忙时为 1） */
  busy: boolean
  /** 排队等待转写的句数 */
  queued: number
  /** 本次已定稿句数 */
  finals: number
  /** 本次录音时长（毫秒） */
  elapsedMs: number
  /** 当前使用的模型文件名 */
  model: string
  /** 是否走 GPU（Metal） */
  gpu: boolean
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
  /** 最后修改时间（手机端同步用它判断"这条变了没有"） */
  updatedAt?: number
  /** AI 增强（润色）版本；尚未生成时为 null */
  enhancedText?: string | null
  /** 转笔记状态：none 未转过 · ok 已完成 · incomplete 未完成（可在转写页继续） */
  noteStatus?: NoteConvertStatus
  noteError?: string
  noteId?: string
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
  /** 最后修改时间（手机端据此判断是否需要重新拉取） */
  updatedAt?: number
  durationMs: number
  rawLen: number
  hasEnhanced: boolean
  /** 转笔记状态：none 未转过 · ok 已完成 · incomplete 未完成（可在转写页继续） */
  noteStatus?: NoteConvertStatus
  noteError?: string
  noteId?: string
  preview: string
}



// ── 闪卡（AI 从整理好的笔记生成 + 间隔重复复习） ────────────────
export interface Card {
  id: string
  /** 来源笔记（手动创建的卡片可为空） */
  noteId: string | null
  notebookId: string | null
  front: string
  back: string
  hint?: string
  tags: string[]
  /** 'ai' | 'manual' */
  source: string
  /** 1-5：AI 判断的"考试/掌握重要度"，低于阈值的卡不会被采纳 */
  importance?: number
  /** 卡片类型：definition | formula | example | application | comparison | procedure | fact */
  kind?: string
  /** 依据的原文片段（便于判断这张卡有没有价值） */
  quote?: string
  createdAt: number
  updatedAt: number
  /** SM-2 排程：下次到期时间（0/undefined = 未排程，立即到期） */
  dueAt?: number
  intervalDays?: number
  ease?: number
  reps?: number
  lapses?: number
  lastReviewAt?: number
  suspended?: boolean
}

export interface CardReview {
  id: string
  cardId: string
  at: number
  /** 0=again 1=hard 2=good 3=easy */
  grade: number
  /** 复习耗时（毫秒） */
  ms?: number
  /** 来源设备：desktop | android… */
  source?: string
}

export interface CardStats {
  total: number
  due: number
  suspended: number
  reviewedToday: number
  /** 最近 30 天每天复习数（用于统计图） */
  daily: Array<{ day: string; n: number }>
  /** 正确率（grade >= 2 的比例，最近 30 天） */
  accuracy: number
  /** 连续复习天数 */
  streak: number
  aiCount: number
  manualCount: number
}

export interface CardGenRequest {
  /** 单篇笔记 */
  noteId?: string
  /** 多篇笔记（界面上按笔记本勾选，例如 MGT2324 的 Week 2–4） */
  noteIds?: string[]
  /** 或整本笔记本（含子笔记本） */
  notebookId?: string
  /** 覆盖默认尺度：每 1000 字多少张 */
  per1000?: number
  /** 单篇上限 */
  maxPerNote?: number
  /** 出题侧重 */
  style?: 'balanced' | 'definition' | 'application' | 'formula'
  /** 预设：exam=考试冲刺（最严）· study=日常理解（默认）· broad=全面覆盖 */
  preset?: 'exam' | 'study' | 'broad'
  /** 重要度门槛：只保留 importance ≥ 此值的卡片（1-5） */
  minImportance?: number
  /** 允许的卡片类型（留空=全部） */
  includeKinds?: string[]
  /** 过滤行政/无关内容（公告、截止日期、签到、分数占比…） */
  blockAdmin?: boolean
  /** 卡片语言 */
  language?: 'auto' | 'zh' | 'en'
  /** 只对“还没有卡片”的笔记生成 */
  skipExisting?: boolean
}

export interface CardGenProgress {
  stage: 'plan' | 'note' | 'save' | 'done'
  /** 正在处理的笔记序号/总数 */
  i?: number
  n?: number
  title?: string
  cards?: number
  detail?: string
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
  /** 同级手动/自动排序（负数越小越靠前；新笔记 = -createdAt） */
  ord?: number
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
  /** lecture=录音/转写笔记（默认）· doc=文档笔记 */
  kind?: 'lecture' | 'doc'
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
  /**
   * 草稿（边说边出预览）的节流间隔，毫秒；默认 15000。
   * 草稿每次都要跑一个完整 30 秒窗口，所以"多久发一次"直接决定开销。
   */
  partialIntervalMs?: number
  /** 草稿要求的最小语音长度（毫秒），默认 5000：短句马上就有定稿，不值得为它跑一个窗口 */
  partialMinMs?: number
  /**
   * 草稿专用模型（文件名，留空 = 与主模型相同）。
   * 草稿用 small.en、定稿仍用 large-v3-turbo：预览更勤而草稿成本降约 99%。
   */
  partialModelFile?: string
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

/** 一个 AI 渠道（OpenRouter / DeepSeek / Kimi / GLM / 通义 / OpenAI / Gemini / Groq / Ollama …） */
export interface LlmProvider {
  id: string
  /** 显示名，如 “DeepSeek 官方” */
  name: string
  /** OpenAI 兼容 base URL，如 https://api.deepseek.com/v1 */
  baseUrl: string
  apiKey: string
  modelId: string
  /** 同渠道备用模型（主模型被拒/限流时自动改用） */
  fallbackModels?: string[]
  enabled?: boolean
  /** 本地模型（Ollama/LM Studio）不需要 Key，也不占免费额度 */
  local?: boolean
  /** 该渠道按“免费额度”限流（一般只有免费模型需要） */
  free?: boolean
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
  /** 已配置的渠道列表（首个/activeProviderId 为当前使用） */
  providers?: LlmProvider[]
  /** 当前渠道 id */
  activeProviderId?: string
  /** 当前渠道的备用模型 */
  fallbackModels?: string[]
  /** 失败时自动换模型/换渠道（默认开） */
  autoFallback?: boolean
  /** 本地免费额度保护上限（默认 1000；达到后本机停用免费模型，防止跑光当天额度） */
  dailyFreeLimit?: number
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
  /** 局域网手机连接（只读复习客户端） */
  mobile?: MobileSettings
}

// ── 手机连接（局域网，只读） ─────────────────────────────────────
export interface MobileDevice {
  id: string
  /** 设备名（手机端上报，如 "Pixel 8"） */
  name: string
  /** 长期令牌（配对后下发；撤销即失效） */
  token: string
  pairedAt: number
  lastSeen?: number
}

export interface MobileSettings {
  /** 打开局域网服务（默认关，需用户显式开启） */
  enabled?: boolean
  /** 端口；0/未设 = 自动挑选一个空闲端口 */
  port?: number
  /** 已配对设备 */
  devices?: MobileDevice[]
  /** 电脑的持久身份（手机在局域网里靠它找回换 IP 后的电脑） */
  deskId?: string
  /** 允许同一 Wi-Fi 直传 APK（扫码下载安装包） */
  serveApk?: boolean
}

export interface MobileStatus {
  running: boolean
  port: number | null
  /** 可供手机访问的地址（http://<局域网IP>:<port>） */
  urls: string[]
  devices: Array<{ id: string; name: string; pairedAt: number; lastSeen?: number }>
  apkAvailable: boolean
  apkName?: string
  /** 是否允许局域网直传安装包（用户开关本身的值） */
  serveApk: boolean
  /** 读取笔记本/笔记的数量，用于界面展示“手机上能看到多少内容” */
  noteCount: number
  notebookCount: number
  transcriptCount: number
  lastError?: string
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

/** keypoints = 要点式（文档转笔记的默认档：只抓要点，最密） */
export type NoteLength = 'keypoints' | 'concise' | 'standard' | 'detailed'

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

/** 转写记录 → 笔记的转换状态 */
export type NoteConvertStatus = 'none' | 'ok' | 'incomplete'

export interface OrganizeJobDone {
  jobId: string
  mode: 'new' | 'replace'
  /** 来源转写记录（成功转成笔记后回填状态） */
  transcriptId?: string
  /** 笔记类型（doc = 文档笔记） */
  kind?: 'lecture' | 'doc'
  replaceId?: string
  title: string
  noteMd: string
  sourceText: string
  templateId?: string
  length?: NoteLength
  requests: number
  chunks: number
  /** 有段落只能保留原文/合并退化 → 笔记带警告横幅 */
  degraded?: boolean
  /** 未完成的原因（给用户看的短句） */
  degradedReason?: string
  /** 缺段落（真正不完整）→ 不写入笔记库，转写页给「继续转成笔记」 */
  incomplete?: boolean
  /** 退化为原文的段数 */
  failedParts?: number
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
  /** 有段落退化为原文/合并退化为拼接 → 不算完成（不写入笔记库） */
  degraded?: boolean
  /** 退化为原文的段数 */
  failedParts?: number
}

export interface OrganizeRequest {
  /** 内容来源：transcript=语音转写（默认）· document=文档（只从文档抓要点） */
  source?: 'transcript' | 'document'
  /** 文档来源的显示名（文件名），用于标题与提示词 */
  docName?: string
  /** 笔记类型：lecture=录音/转写笔记（默认）· doc=文档笔记 */
  kind?: 'lecture' | 'doc'
  title: string
  sourceText: string
  /** 来源转写记录（用于在其上标记"未完成转笔记"并可继续） */
  transcriptId?: string
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
  onAsrStatus(cb: (st: AsrStatus) => void): () => void
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

  /** 文档 → 笔记（笔记页用；只有文档，没有语音/转写） */
  doc: {
    pick(): Promise<{ path: string; fileName: string } | null>
    parse(filePath: string, password?: string): Promise<{
      fileName: string
      filePath: string
      kind: 'pdf' | 'pptx' | 'docx' | 'txt' | 'md'
      pages: Array<{ n: number; text: string }>
      chars: number
      passwordNeeded?: boolean
      emptyText?: boolean
    }>
  },

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

  cards: {
    list(filter?: { noteId?: string; notebookId?: string; due?: boolean; includeSuspended?: boolean }): Promise<Card[]>
    stats(): Promise<CardStats>
    generate(req: CardGenRequest): Promise<{ ok: boolean; jobId?: string; error?: string }>
    cancel(jobId: string): Promise<void>
    update(id: string, patch: Partial<Card>): Promise<Card | null>
    remove(id: string): Promise<boolean>
    /** 删除某篇笔记的全部卡片（重建卡片时用） */
    removeForNote(noteId: string): Promise<number>
    /** 桌面端复习：提交一次评分，返回更新后的卡片 */
    review(id: string, grade: number, ms?: number): Promise<Card | null>
    onProgress(cb: (p: CardGenProgress & { jobId: string }) => void): () => void
    onDone(
      cb: (d: {
        jobId: string
        noteId?: string
        cards: number
        notes?: number
        failed?: number
        requests?: number
        canceled?: boolean
        error?: string
      }) => void
    ): () => void
  }

  mobile: {
    status(): Promise<MobileStatus>
    setEnabled(enabled: boolean): Promise<MobileStatus>
    /** 打开连接面板：生成新的一次性配对码 + 二维码 SVG */
    qr(): Promise<{ ok: boolean; svg?: string; url?: string; code?: string; error?: string }>
    revoke(id: string): Promise<MobileStatus>
    /** 断开所有已配对设备 */
    revokeAll(): Promise<MobileStatus>
  },

  llm: {
    organize(req: OrganizeRequest): Promise<OrganizeResult>
    /** 后台任务式整理：立即返回 jobId，进度/结果走 onOrganizeJob/Done/Error */
    organizeStart(req: OrganizeRequest): Promise<{ ok: boolean; jobId?: string; error?: string }>
    /** 取消排队中/进行中的整理任务（进行中会中止当前 HTTP 请求） */
    organizeCancel(jobId: string): Promise<boolean>
    polish(req: PolishRequest): Promise<PolishResult>
    /** 取消正在跑的润色（长转写要几分钟，用户得能停） */
    polishCancel(): Promise<boolean>
    validateKey(): Promise<{ ok: boolean; error?: string }>
    testChannel(ch: {
      baseUrl: string
      apiKey: string
      modelId: string
      local?: boolean
    }): Promise<{ ok: boolean; error?: string; reply?: string }>
    listModels(ch: { baseUrl: string; apiKey: string }): Promise<{ ok: boolean; models: string[]; error?: string }>
  }
  onOrganizeJob(cb: (p: OrganizeJobEvent) => void): () => void
  onOrganizeDone(cb: (p: OrganizeJobDone) => void): () => void
  onOrganizeError(cb: (p: OrganizeJobError) => void): () => void

  trans: {
    setNoteStatus(id: string, status: NoteConvertStatus, error?: string, noteId?: string): Promise<boolean>
    get(id: string): Promise<TranscriptionRecord | null>
    /** 清掉这篇转写的整理进度缓存（=从头重做） */
    clearCheckpoint(sourceText: string): Promise<boolean>
  },

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
