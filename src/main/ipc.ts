// IPC：注册所有主进程可调用通道与上行事件
import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell } from 'electron'
import type {
  AppSettings,
  DailyUsage,
  ModelStatus,
  NoteDraft,
  NoteRecord,
  OrganizeRequest,
  OrganizeResult,
  CardGenRequest,
  Card as CardRecord
} from '@shared/types'
import { loadConfig,
  saveConfig,
  getDailyUsage,
  resetDailyUsage } from './config'
import { i18nCode,
  tm } from './i18n'
import { clip } from './llm/openrouter'
import { orgLog } from './orgLog'
import {
  listNotes,
  getNote,
  saveNote,
  deleteNote,
  searchNotes,
  setNoteNotebook,
  reorderNotes,
  listNotebooks,
  createNotebook,
  renameNotebook,
  deleteNotebook,
  setNotebookHidden,
  reorderNotebooks,
  listTranscriptions,
  getTranscription,
  saveTranscription,
  getOrgParts,
  putOrgPart,
  pruneOrgParts,
  clearOrgParts,
  deleteTranscription,
  setTranscriptionNote
} from './db'
import { MODEL_CATALOG, localizeModel } from './modelCatalog'
import { downloadFile } from './download'
import { organizeText, partHashOf, organizeFingerprint, docHashOf, type OrganizeCheckpoint } from './llm/organize'
import { polishText } from './llm/polish'
import { validateKey, testChannel, listChannelModels } from './llm/openrouter'
import type { MobileServer } from './mobile/server'
import { countCardsForNote, deleteCard, deleteCardsForNote, listCardFronts, listCards, saveCard, cardStats, reviewCard } from './db'
import { generateCardsForNote, draftToCard } from './llm/cards'
import { probeBinary } from './whisperServer'
import { decodeTo16kWavFile } from './decodeAudio'
import { DOC_EXTENSIONS, isDocPath, parseDocument, docToPromptText, type ParsedDoc } from './docparse'
import { parseDeckCached, fitSlidesList } from './slides'
import { buildAsrPrompt, buildDictTerms } from './course'
import type { AsrManager } from './asrManager'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'

export interface IpcContext {
  getWindow: () => BrowserWindow | null
  asr: AsrManager
  modelsDir: string
  openChildWindow?: (id: string) => void
  /** 局域网手机连接服务（阶段 2） */
  mobile: MobileServer
}

let ctxRef: IpcContext | null = null
let organizeBusy = false
let importBusy = false
// 后台整理任务队列（不阻塞界面，可排队）
interface OrgJob {
  jobId: string
  req: OrganizeRequest
  mode: 'new' | 'replace'
  replaceId?: string
}
const orgQueue: OrgJob[] = []
let orgRunning = false
// 进行中的模型下载（可取消）
const modelDl = new Map<string, AbortController>()

export function emit(channel: string, payload: unknown): void {
  const win = ctxRef?.getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

export function registerIpc(ctx: IpcContext): void {
  ctxRef = ctx

  const currentSettings = (): AppSettings => loadConfig()

  const deckContext = async (
    req: { slidesPath?: string; slidesPaths?: string[]; slidesPassword?: string; slidesPasswords?: string[] }
  ): Promise<string> => {
    const paths = req.slidesPaths?.length ? req.slidesPaths : req.slidesPath ? [req.slidesPath] : []
    if (!paths.length) return ''
    const items: Array<{ label: string; pages: Array<{ n: number; text: string }> }> = []
    for (let i = 0; i < paths.length; i++) {
      try {
        const d = await parseDeckCached(paths[i], (req.slidesPasswords?.[i] ?? req.slidesPassword) || '')
        items.push({ label: d.fileName, pages: d.pages })
      } catch {
        /* 单文件失败跳过 */
      }
    }
    return fitSlidesList(items, 11000)
  }

  // ── 录音 ────────────────────────────────────────────
  // payload: { prompt?: string; decks?: Array<{path,password}> } —— 会话级（不持久化，防跨课污染）
  ipcMain.handle('rec:start', async (_e, payload: { prompt?: string; decks?: Array<{ path: string; password: string }> }) => {
    try {
      const settings = currentSettings()
      const decks = Array.isArray(payload?.decks) ? payload.decks.filter((d) => d && d.path) : []
      const manual = typeof payload?.prompt === 'string' ? payload.prompt : ''
      const prompt = decks.length ? await buildAsrPrompt(decks, manual) : manual.slice(0, 800)
      ctx.asr.setCorrectionTerms(decks.length ? await buildDictTerms(decks) : [])
      ctx.asr.settingsSnapshot = settings
      const out = await ctx.asr.start(settings, prompt)
      return { ok: true, sessionId: out.sessionId }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.on('audio:pcm', (_ev, msg: { rate: number; data: Float32Array }) => {
    if (!msg || typeof msg.rate !== 'number' || !(msg.data instanceof Float32Array)) return
    if (msg.data.length === 0) return
    const settings = ctx.asr.settingsSnapshot ?? currentSettings()
    ctx.asr.settingsSnapshot = settings
    ctx.asr.pushPcm(msg.data, Math.round(msg.rate) || 16000, settings)
  })

  ipcMain.handle('rec:stop', async () => {
    try {
      const out = await ctx.asr.stop()
      return { ok: true, result: out }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('rec:pause', async () => {
    try {
      ctx.asr.pause()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('rec:resume', async () => {
    try {
      ctx.asr.resume()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ── 设置 ────────────────────────────────────────────
  ipcMain.handle('settings:get', () => currentSettings())

  /** 转写 → 笔记 状态回填（前端保存笔记后调用） */
  ipcMain.handle('trans:setNoteStatus', (_e, id: string, status: 'none' | 'ok' | 'incomplete', error?: string, noteId?: string) =>
    setTranscriptionNote(String(id), status, error ?? null, noteId ?? null)
  )

  /** 未完成的整理：返回该转写的原文，供"继续转成笔记"复用 */
  ipcMain.handle('trans:get', (_e, id: string) => getTranscription(String(id)))

  // ── 闪卡（AI 从整理好的笔记出卡 + 间隔重复） ──────────────
  interface CardJob {
    jobId: string
    req: CardGenRequest
    canceled: boolean
    ctrl: AbortController
    /** 断点续跑：已处理的笔记 id */
    done: string[]
  }
  const cardJobs = new Map<string, CardJob>()
  let cardJobSeq: Promise<void> = Promise.resolve()

  /** 解析目标笔记：单篇 / 整本笔记本（含子笔记本） */
  const resolveCardNotes = (req: CardGenRequest): NoteRecord[] => {
    const all = listNotes()
    if (req.noteIds?.length) {
      const want = new Set(req.noteIds)
      return all.filter((n) => want.has(n.id))
    }
    if (req.noteId) {
      const n = all.find((x) => x.id === req.noteId)
      return n ? [n] : []
    }
    if (req.notebookId) {
      const ids = new Set<string>([req.notebookId])
      const bks = listNotebooks()
      let grew = true
      while (grew) {
        grew = false
        for (const b of bks) {
          if (b.parentId && ids.has(b.parentId) && !ids.has(b.id)) {
            ids.add(b.id)
            grew = true
          }
        }
      }
      return all.filter((n) => n.notebookId && ids.has(n.notebookId))
    }
    // 都没给：所有还没有卡片的笔记
    return all.filter((n) => countCardsForNote(n.id) === 0)
  }

  const runCardJob = async (job: CardJob): Promise<void> => {
    const { req, jobId } = job
    const notes = resolveCardNotes(req)
    const todo = notes.filter((n) => (n.noteMd ?? '').trim().length > 0 && !job.done.includes(n.id) && !job.canceled)
    let saved = 0
    let failed = 0
    let requests = 0
    emit('cards:progress', { jobId, stage: 'plan', n: todo.length, detail: tm('cards.plan', { n: todo.length }) })
    for (let i = 0; i < todo.length; i++) {
      if (job.canceled) break
      const n = todo[i]
      emit('cards:progress', { jobId, stage: 'note', i: i + 1, n: todo.length, title: n.title, detail: tm('cards.noteOf', { i: i + 1, n: todo.length }) })
      try {
        const existing = listCardFronts(n.id)
        const r = await generateCardsForNote(
          currentSettings(),
          { id: n.id, title: n.title, noteMd: n.noteMd ?? '', notebookId: n.notebookId ?? null, tags: n.tags },
          req,
          existing,
          job.ctrl.signal,
          undefined,
          (detail) => emit('cards:progress', { jobId, stage: 'note', i: i + 1, n: todo.length, title: n.title, detail })
        )
        requests += r.requests
        for (const d of r.cards) saveCard(draftToCard(d, { id: n.id, title: n.title, noteMd: n.noteMd ?? '', notebookId: n.notebookId ?? null, tags: n.tags }))
        saved += r.cards.length
        job.done.push(n.id)
        emit('cards:progress', { jobId, stage: 'save', i: i + 1, n: todo.length, title: n.title, cards: saved, detail: tm('cards.savedSoFar', { n: r.cards.length, total: saved }) })
      } catch (e) {
        if (job.canceled) break
        failed += 1
        const msg = (e as Error).message || String(e)
        orgLog(`[cards ${jobId.slice(0, 8)}] note=${n.id} failed: ${msg}`)
        emit('cards:progress', { jobId, stage: 'note', i: i + 1, n: todo.length, title: n.title, detail: localizeError(msg) })
      }
    }
    const canceled = job.canceled
    cardJobs.delete(jobId)
    emit('cards:done', {
      jobId,
      cards: saved,
      notes: job.done.length,
      failed,
      requests,
      canceled,
      error: failed && !saved ? i18nCode('cards.allFailed', { n: failed }) : undefined
    })
    orgLog(`[cards ${jobId.slice(0, 8)}] done cards=${saved} notes=${job.done.length} failed=${failed} requests=${requests} canceled=${canceled}`)
  }

  ipcMain.handle('cards:generate', (_e, req: CardGenRequest): { ok: boolean; jobId?: string; error?: string } => {
    const notes = resolveCardNotes(req ?? {})
    if (!notes.length) return { ok: false, error: i18nCode('cards.noNotes') }
    const jobId = randomUUID()
    const job: CardJob = { jobId, req: { ...req }, canceled: false, ctrl: new AbortController(), done: [] }
    cardJobs.set(jobId, job)
    orgLog(`[cards ${jobId.slice(0, 8)}] queued notes=${notes.length} style=${req?.style ?? 'balanced'}`)
    // 串行执行（与整理错开，避免同时打满上游）
    cardJobSeq = cardJobSeq.then(() => runCardJob(job)).catch(() => {})
    return { ok: true, jobId }
  })

  ipcMain.handle('cards:cancel', (_e, jobId: string): boolean => {
    const job = cardJobs.get(jobId)
    if (!job) return false
    job.canceled = true
    try {
      job.ctrl.abort()
    } catch {
      /* ignore */
    }
    return true
  })

  ipcMain.handle('cards:list', (_e, filter?: { noteId?: string; notebookId?: string; due?: boolean; includeSuspended?: boolean }) =>
    listCards(filter ?? {})
  )

  ipcMain.handle('cards:stats', () => cardStats())

  ipcMain.handle('cards:update', (_e, id: string, patch: Partial<CardRecord>) => {
    const cur = listCards({ includeSuspended: true }).find((c) => c.id === id)
    if (!cur) return null
    return saveCard({
      id,
      front: patch.front ?? cur.front,
      back: patch.back ?? cur.back,
      hint: patch.hint ?? cur.hint,
      tags: patch.tags ?? cur.tags,
      source: patch.source ?? cur.source,
      suspended: patch.suspended ?? cur.suspended
    })
  })

  ipcMain.handle('cards:remove', (_e, id: string): boolean => deleteCard(String(id)))

  ipcMain.handle('cards:removeForNote', (_e, noteId: string): number => deleteCardsForNote(String(noteId)))

  ipcMain.handle('cards:review', (_e, id: string, grade: number, ms?: number) => reviewCard(String(id), Number(grade), ms, 'desktop'))

  // ── 手机连接（局域网只读） ──────────────────────────────
  ipcMain.handle('mobile:status', () => ctx.mobile.status())

  ipcMain.handle('mobile:setEnabled', async (_e, enabled: boolean) => {
    const cur = currentSettings()
    saveConfig({ mobile: { ...(cur.mobile ?? {}), enabled: !!enabled } })
    if (enabled) {
      const r = await ctx.mobile.start(cur.mobile?.port ?? 0)
      if (!r.ok) throw new Error(i18nCode('mobile.startFail', { msg: r.error ?? '' }))
      // 端口是随机挑的：记下来，下次保持同一端口（手机端缓存的地址不会失效）
      if (r.port && r.port !== cur.mobile?.port) {
        const now = currentSettings()
        saveConfig({ mobile: { ...(now.mobile ?? {}), port: r.port } })
      }
    } else {
      ctx.mobile.stop()
    }
    ctx.asr.settingsSnapshot = currentSettings()
    return ctx.mobile.status()
  })

  ipcMain.handle('mobile:qr', async () => {
    const r = await ctx.mobile.qrPayload()
    if ('error' in r) return { ok: false, error: i18nCode(r.error === 'no-lan' ? 'mobile.noLan' : 'mobile.startFail', { msg: '' }) }
    return { ok: true, svg: r.svg, url: r.url, code: r.code }
  })

  ipcMain.handle('mobile:revoke', (_e, id: string) => {
    ctx.mobile.revoke(String(id))
    return ctx.mobile.status()
  })

  ipcMain.handle('mobile:revokeAll', () => {
    ctx.mobile.revokeAll()
    return ctx.mobile.status()
  })

  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    const next = saveConfig(patch ?? {})
    ctx.asr.settingsSnapshot = next
    return next
  })

  ipcMain.handle('settings:resetUsage', () => {
    resetDailyUsage()
    return getDailyUsage()
  })

  ipcMain.handle('meta:dailyUsage', (): DailyUsage => getDailyUsage())
  ipcMain.handle('meta:version', () => process.env.npm_package_version ?? '0.1.0')

  // ── 笔记 ────────────────────────────────────────────
  ipcMain.handle('notes:list', (): NoteRecord[] => listNotes())
  ipcMain.handle('notes:get', (_e, id: string): NoteRecord | null => getNote(id))
  ipcMain.handle('notes:save', (_e, draft: NoteDraft): NoteRecord => {
    if (!draft || typeof draft !== 'object') throw new Error(i18nCode('err.badParam'))
    return saveNote(draft)
  })
  ipcMain.handle('notes:remove', (_e, id: string): boolean => deleteNote(id))
  ipcMain.handle('notes:setNotebook', (_e, id: string, notebookId: string | null): boolean => {
    if (typeof id !== 'string' || !getNote(id)) return false
    return setNoteNotebook(id, notebookId || null)
  })
  ipcMain.handle('notes:reorder', (_e, ids: string[]): boolean => {
    if (!Array.isArray(ids)) return false
    return reorderNotes(ids)
  })

  // ── 笔记本（文件夹式归类） ─────────────────────────
  ipcMain.handle('notebooks:list', () => listNotebooks())
  ipcMain.handle('notebooks:create', (_e, name: string, parentId?: string | null) => {
    try {
      return createNotebook(name, parentId ?? null)
    } catch (e) {
      throw new Error((e as Error).message)
    }
  })
  ipcMain.handle('notebooks:reorder', (_e, updates: Array<{ id: string; parentId: string | null; ord: number }>) =>
    reorderNotebooks(Array.isArray(updates) ? updates : [])
  )
  ipcMain.handle('notebooks:setHidden', (_e, id: string, hidden: boolean) => setNotebookHidden(id, !!hidden))
  ipcMain.handle('notebooks:createOld', (_e, name: string) => {
    if (typeof name !== 'string') throw new Error(i18nCode('err.badParam'))
    return createNotebook(name)
  })
  ipcMain.handle('notebooks:rename', (_e, id: string, name: string) => {
    if (typeof id !== 'string' || typeof name !== 'string') return false
    return renameNotebook(id, name)
  })
  ipcMain.handle('notebooks:remove', (_e, id: string) => {
    if (typeof id !== 'string') return false
    return deleteNotebook(id)
  })

  ipcMain.handle('notes:search', (_e, q: string) => {
    const query = typeof q === 'string' ? q.trim() : ''
    if (!query) return []
    return searchNotes(query)
  })

  // ── 独立编辑窗（双击笔记） + 双向同步 ──────────────────
  ipcMain.handle('notes:openChild', (_e, id: string) => {
    if (typeof id !== 'string' || !getNote(id)) throw new Error(i18nCode('err.noteNotFound'))
    ctx.openChildWindow?.(id)
    return true
  })

  const childSaveTimers = new Map<string, NodeJS.Timeout>()
  ipcMain.on('note:edit', (_ev, data: { id?: string; title?: string; noteMd?: string }) => {
    if (!data || typeof data.id !== 'string' || !getNote(data.id)) return
    const id = data.id
    const prev = childSaveTimers.get(id)
    if (prev) clearTimeout(prev)
    childSaveTimers.set(
      id,
      setTimeout(() => {
        childSaveTimers.delete(id)
        try {
          const rec = getNote(id)
          if (!rec) return
          saveNote({
            id,
            title: typeof data.title === 'string' && data.title.trim() ? data.title : rec.title,
            noteMd: typeof data.noteMd === 'string' ? data.noteMd : rec.noteMd,
            sourceText: rec.sourceText,
            templateId: rec.templateId,
            durationMs: rec.durationMs,
            tags: rec.tags
          })
        } catch {
          /* ignore */
        }
      }, 700)
    )
    const payload = { id, title: data.title ?? '', noteMd: data.noteMd ?? '' }
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && w.webContents !== _ev.sender) {
        w.webContents.send('note:sync', payload)
      }
    }
  })

  // 主窗编辑内容实时同步到已开的子窗（只广播、不写库；主窗保存仍走 notes:save）
  ipcMain.on('note:broadcast', (_ev, data: { id?: string; title?: string; noteMd?: string }) => {
    if (!data || typeof data.id !== 'string' || !getNote(data.id)) return
    const payload = { id: data.id, title: typeof data.title === 'string' ? data.title : '', noteMd: typeof data.noteMd === 'string' ? data.noteMd : '' }
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && w.webContents !== _ev.sender) {
        w.webContents.send('note:sync', payload)
      }
    }
  })

  ipcMain.handle('dialog:pickImage', async (): Promise<import('@shared/types').PickedImage | null> => {
    const win = ctx.getWindow()
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: tm('err.pickImage'),
      properties: ['openFile'],
      filters: [
        { name: tm('err.image'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }
      ]
    })
    if (canceled || !filePaths[0]) return null
    const p = filePaths[0]
    const st = fs.statSync(p)
    if (st.size > 8 * 1024 * 1024) throw new Error(i18nCode('err.imgTooLarge'))
    const mime = p.toLowerCase().endsWith('.png')
      ? 'image/png'
      : p.toLowerCase().endsWith('.gif')
        ? 'image/gif'
        : p.toLowerCase().endsWith('.webp')
          ? 'image/webp'
          : 'image/jpeg'
    const b64 = fs.readFileSync(p).toString('base64')
    return {
      name: path.basename(p),
      size: st.size,
      dataUrl: `data:${mime};base64,${b64}`
    }
  })

  ipcMain.handle('notes:export', async (_e, id: string): Promise<string | null> => {    const note = getNote(id)
    if (!note) throw new Error(i18nCode('err.noteNotFound'))
    const safe = note.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: tm('app.exportMd'),
      defaultPath: `${safe || 'note'}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (canceled || !filePath) return null
    const header = [
      `# ${note.title}`,
      '',
      `> 创建于 ${new Date(note.createdAt).toLocaleString()}`,
      note.durationMs ? `> 时长 ${Math.round(note.durationMs / 60000)} 分钟` : '',
      '',
      '---',
      ''
    ].filter(Boolean).join('\n')
    fs.writeFileSync(filePath, header + note.noteMd + '\n', 'utf-8')
    return filePath
  })

  /** 把主进程抛出的 @key|vars 错误码翻成当前语言（进度里给人看） */
  const localizeError = (msg: string): string => {
    const m = /^@([a-zA-Z0-9_.]+)(?:\|(.*))?$/.exec(msg || '')
    if (!m) return msg
    const vars: Record<string, string> = {}
    if (m[2]) {
      for (const kv of m[2].split('&')) {
        const i = kv.indexOf('=')
        if (i > 0) vars[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1))
      }
    }
    return tm(m[1], vars)
  }

  // ── LLM 整理 ────────────────────────────────────────
  const orgCtl = new Map<string, { ctrl: AbortController; startedAt: number }>()
  /** 中止原因：区分「用户取消」与「看门狗自动中止」，避免把自动中止误报成取消 */
  const orgAbortReason = new Map<string, 'user' | 'watchdog'>()
  /**
   * 长时间毫无动静才中止。注意两点：
   *  · 每个 LLM 请求都会心跳（start/end），所以只有「没有任何请求在飞」时才可能是卡死；
   *  · 单个请求本身有 120s 超时兜底，这里只是防我们自己的代码挂住（含系统休眠后的时间跳变）。
   */
  const ORG_STALL_MS = 300_000

  const runOrgJob = async (job: OrgJob): Promise<void> => {
    const { req } = job
    organizeBusy = true
    const startedAt = Date.now()
    let requests = 0
    let lastBeat = Date.now()
    let inFlight = 0
    const ctrl = new AbortController()
    orgCtl.set(job.jobId, { ctrl, startedAt })
    const beat = (line: string): void => {
      lastBeat = Date.now()
      orgLog(`[${job.jobId.slice(0, 8)}] ${line}`)
    }
    // 看门狗：长时间没有任何进展（含 120s 请求超时 + 合并阶段）就中止，避免“永远挂着没动静”
    const onActivity = (phase: 'start' | 'end' | 'tick'): void => {
      if (phase === 'start') inFlight += 1
      else if (phase === 'end') inFlight = Math.max(0, inFlight - 1)
      // tick：流式每收到一段数据就续命（慢模型长时间生成不会被误判卡死）
      lastBeat = Date.now()
    }
    const watchdog = setInterval(() => {
      const gap = Date.now() - lastBeat
      // 只要有请求在飞，就交给请求自身的 120s 超时处理，绝不在这里误杀
      if (inFlight === 0 && gap > ORG_STALL_MS) {
        orgLog(`[${job.jobId.slice(0, 8)}] watchdog: idle for ${Math.round(gap / 1000)}s with no request in flight -> abort`)
        orgAbortReason.set(job.jobId, 'watchdog')
        ctrl.abort()
      }
    }, 10_000)
    const progress = (p: { stage?: string; part?: number; parts?: number; detail?: string; chars?: number }): void => {
      if (p.detail) beat(`${p.stage} ${p.part ?? 0}/${p.parts ?? 0} ${p.detail}`)
      emit('llm:job', {
        jobId: job.jobId,
        title: req.title,
        mode: job.mode,
        stage: (p.stage as 'chunk') ?? 'chunk',
        part: p.part,
        parts: p.parts,
        detail: p.detail,
        chars: p.chars,
        requests,
        elapsedMs: Date.now() - startedAt
      })
    }
    progress({ stage: 'chunk', part: 0, parts: 0, detail: tm('org.preparing') })
    beat(`start mode=${job.mode} srcChars=${req.sourceText.length} title=${req.title}`)
    try {
      const slidesText = await deckContext(req)
      if (slidesText) beat(`slides context chars=${slidesText.length}`)
      let lastCountedPart = 0
      const wrappedProgress = (p: { stage?: string; part?: number; parts?: number; detail?: string; chars?: number }): void => {
        // 同一块可能因为"续写"再发一次进度，只按块号变化计数，避免请求数虚高
        if (p.stage === 'chunk' && (p.part ?? 0) > lastCountedPart) {
          lastCountedPart = p.part ?? 0
          requests += 1
        }
        progress(p)
      }
      // 断点续做：同一篇转写 + 同样的组织参数 → 上次已成功的段落直接复用（0 请求），
      // 只重做失败/没做过的段落。用户点「继续转成笔记」时不再整篇重来。
      const settingsNow = currentSettings()
      const docHash = docHashOf(req.sourceText)
      const fp = organizeFingerprint({
        modelId: settingsNow.llm.modelId,
        templateId: req.templateId ?? settingsNow.llm.templateId,
        length: req.length,
        sourceText: req.sourceText,
        slidesText
      })
      const cached = getOrgParts(docHash, fp)
      if (cached.size) beat(`resume: ${cached.size} cached part(s) available`)
      const checkpoint: OrganizeCheckpoint = {
        load: (h) => cached.get(h),
        save: (h, md, status) => {
          putOrgPart(docHash, h, fp, md, status)
          cached.set(h, { partHash: h, md, status })
        }
      }
      const res = await organizeText(
        settingsNow,
        {
          title: req.title,
          sourceText: req.sourceText,
          templateId: req.templateId,
          length: req.length,
          slidesText,
          source: req.source === 'document' ? 'document' : 'transcript'
        },
        wrappedProgress,
        ctrl.signal,
        onActivity,
        checkpoint
      )
      try {
        pruneOrgParts(30)
      } catch {
        /* ignore */
      }
      const degraded = !!res.degraded
      // 只有"确实缺段落"才算未完成；合并退化为本地拼接时内容仍在，照常入库（只加警告横幅）
      const incomplete = (res.failedParts ?? 0) > 0
      beat(
        `done requests=${res.requests} chunks=${res.chunks} noteChars=${res.noteMd.length} degraded=${degraded}` +
          (degraded ? ` failedParts=${res.failedParts ?? 0}` : '')
      )
      // 不完成就不进笔记库：有段落只能保留原文时，标记转写为"未完成"，由用户在转写页决定是否继续
      if (incomplete && req.transcriptId) {
        setTranscriptionNote(req.transcriptId, 'incomplete', i18nCode('trans.noteIncompleteReason', { n: res.failedParts ?? 0 }), null)
      }
      if (!incomplete && req.transcriptId && job.mode === 'new') {
        // 成功建立笔记时先记下"进行中"，等前端保存后回填 noteId（前端会再调用一次标记）
        setTranscriptionNote(req.transcriptId, 'ok', null, null)
      }
      emit('llm:jobDone', {
        jobId: job.jobId,
        mode: job.mode,
        replaceId: job.replaceId,
        transcriptId: req.transcriptId,
        // 文档笔记：前端据此把 kind='doc' 落库（笔记列表会显示 📄）
        kind: req.kind ?? (req.source === 'document' ? 'doc' : 'lecture'),
        title: req.title,
        noteMd: res.noteMd,
        sourceText: req.sourceText,
        templateId: req.templateId,
        length: req.length,
        requests: res.requests,
        chunks: res.chunks,
        truncated: res.truncated,
        continuations: res.continuations,
        degraded,
        degradedReason: degraded ? i18nCode('trans.noteIncompleteReason', { n: res.failedParts ?? 0 }) : undefined,
        incomplete,
        failedParts: res.failedParts ?? 0
      })
    } catch (e) {
      // 区分三种收尾：用户取消 / 看门狗自动中止 / 真实错误
      const reason = orgAbortReason.get(job.jobId)
      const byUser = reason === 'user'
      const stalled = reason === 'watchdog'
      const msg = byUser
        ? i18nCode('org.jobCanceled')
        : stalled
          ? i18nCode('org.jobStalled')
          : (e as Error).message
      const raw = (e as { raw?: string }).raw
      beat(`error byUser=${byUser} stalled=${stalled} ${clip(msg)}${raw ? ` raw=${clip(raw, 1500)}` : ''}`)
      if (!byUser && req.transcriptId) setTranscriptionNote(req.transcriptId, 'incomplete', msg, null)
      emit('llm:jobError', { jobId: job.jobId, error: msg, canceled: byUser })
    } finally {
      clearInterval(watchdog)
      orgCtl.delete(job.jobId)
      orgAbortReason.delete(job.jobId)
      organizeBusy = false
    }
  }
  const pumpOrg = (): void => {
    if (orgRunning) return
    const job = orgQueue.shift()
    if (!job) return
    orgRunning = true
    void runOrgJob(job).finally(() => {
      orgRunning = false
      pumpOrg()
    })
  }

  // 后台任务式整理：立即返回 jobId，进度/结果通过 llm:job* 事件推送
  ipcMain.handle(
    'llm:organizeStart',
    (_e, req: OrganizeRequest & { mode?: 'new' | 'replace'; replaceId?: string }): { ok: boolean; jobId?: string; error?: string } => {
      if (!req || typeof req.sourceText !== 'string' || !req.sourceText.trim()) {
        return { ok: false, error: i18nCode('org.noText') }
      }
      const jobId = randomUUID()
      orgQueue.push({ jobId, req, mode: req.mode === 'replace' ? 'replace' : 'new', replaceId: req.replaceId })
      orgLog(`[${jobId.slice(0, 8)}] queued title=${req.title} srcChars=${req.sourceText.length} mode=${req.mode ?? 'new'}`)
      pumpOrg()
      return { ok: true, jobId }
    }
  )

  // 取消：排队中的直接移除；进行中的中止 HTTP 请求
  ipcMain.handle('llm:organizeCancel', (_e, jobId: string): boolean => {
    if (typeof jobId !== 'string') return false
    const qi = orgQueue.findIndex((j) => j.jobId === jobId)
    if (qi >= 0) {
      orgQueue.splice(qi, 1)
      orgLog(`[${jobId.slice(0, 8)}] canceled while queued`)
      emit('llm:jobError', { jobId, error: i18nCode('org.jobCanceled'), canceled: true })
      return true
    }
    const cur = orgCtl.get(jobId)
    if (cur) {
      orgLog(`[${jobId.slice(0, 8)}] cancel requested by user (aborting in-flight request)`)
      orgAbortReason.set(jobId, 'user')
      cur.ctrl.abort()
      return true
    }
    return false
  })

  // 「彻底重转」：清掉这篇转写的断点缓存，下次整理会重新做每一段
  ipcMain.handle('trans:clearCheckpoint', (_e, sourceText: string): boolean => {
    if (typeof sourceText !== 'string' || !sourceText.trim()) return false
    return clearOrgParts(docHashOf(sourceText)) >= 0
  })

  // 兼容旧调用：同步等待一次整理
  ipcMain.handle('llm:organize', async (_e, req: OrganizeRequest): Promise<OrganizeResult> => {
    if (!req || typeof req.sourceText !== 'string' || !req.sourceText.trim()) {
      throw new Error(i18nCode('org.noText'))
    }
    const slidesText = await deckContext(req)
    return organizeText(
      currentSettings(),
      {
        title: req.title,
        sourceText: req.sourceText,
        templateId: req.templateId,
        length: req.length,
        slidesText,
        source: req.source === 'document' ? 'document' : 'transcript'
      },
      (p) => emit('llm:progress', p)
    )
  })

  const toDesc = async (
    p: string,
    password = ''
  ): Promise<import('@shared/types').DeckDescriptor> => {
    const deck = await parseDeckCached(p, password)
    return {
      path: deck.path,
      fileName: deck.fileName,
      kind: deck.kind,
      pageCount: deck.pageCount,
      chars: deck.chars,
      terms: deck.terms.slice(0, 1500)
    }
  }
  const passwordNeededDesc = (p: string): import('@shared/types').DeckDescriptor => ({
    path: p,
    fileName: path.basename(p),
    kind: p.toLowerCase().endsWith('.pdf') ? 'pdf' : 'pptx',
    pageCount: 0,
    chars: 0,
    terms: '',
    passwordNeeded: true
  })

  ipcMain.handle('slides:pick', async (): Promise<import('@shared/types').DeckDescriptor | null> => {
    const win = ctx.getWindow()
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: tm('app.pickDeck'),
      properties: ['openFile'],
      filters: [
        { name: tm('app.deck'), extensions: ['pdf', 'pptx'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'PowerPoint', extensions: ['pptx'] }
      ]
    })
    if (canceled || !filePaths[0]) return null
    try {
      return await toDesc(filePaths[0], '')
    } catch {
      return passwordNeededDesc(filePaths[0])
    }
  })

  // ── 文档 → 笔记（笔记页用；与语音/转写完全无关）───────────────
  ipcMain.handle('doc:pick', async (): Promise<{ path: string; fileName: string } | null> => {
    const win = ctx.getWindow()
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: tm('doc.pickTitle'),
      properties: ['openFile'],
      filters: [
        { name: tm('doc.filterAll'), extensions: DOC_EXTENSIONS.map((e) => e.replace('.', '')) },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'PowerPoint', extensions: ['pptx'] },
        { name: 'Word', extensions: ['docx'] },
        { name: 'Text / Markdown', extensions: ['txt', 'md', 'markdown'] }
      ]
    })
    if (canceled || !filePaths[0]) return null
    return { path: filePaths[0], fileName: path.basename(filePaths[0]) }
  })

  /** 解析文档：返回按页文本 + 字符数（加密 PDF 会回 passwordNeeded） */
  ipcMain.handle('doc:parse', async (_e, filePath: string, password = ''): Promise<ParsedDoc> => {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error(i18nCode('err.badParam'))
    if (!isDocPath(filePath)) throw new Error(i18nCode('err.docUnsupported'))
    return await parseDocument(filePath, password)
  })

  ipcMain.handle('slides:parse', async (_e, filePath: string): Promise<import('@shared/types').DeckDescriptor> => {
    if (typeof filePath !== 'string') throw new Error(i18nCode('err.badParam'))
    try {
      return await toDesc(filePath, '')
    } catch {
      return passwordNeededDesc(filePath)
    }
  })

  ipcMain.handle(
    'slides:unlock',
    async (_e, filePath: string, password: string): Promise<import('@shared/types').DeckDescriptor> => {
      if (typeof filePath !== 'string' || typeof password !== 'string') throw new Error(i18nCode('err.badParam'))
      return toDesc(filePath, password)
    }
  )

  // 会话使用该课件：解析 + 立即并入句子术语词典（开始录音后拖入也生效）
  ipcMain.handle(
    'slides:useForSession',
    async (_e, filePath: string, password = ''): Promise<import('@shared/types').DeckDescriptor> => {
      if (typeof filePath !== 'string') throw new Error(i18nCode('err.badParam'))
      const deck = await parseDeckCached(filePath, password ?? '')
      const terms = await buildDictTerms([
        { path: filePath, name: deck.fileName, kind: deck.kind, password: password ?? '' }
      ])
      ctx.asr.addCorrectionTerms(terms)
      return {
        path: deck.path,
        fileName: deck.fileName,
        kind: deck.kind,
        pageCount: deck.pageCount,
        chars: deck.chars,
        terms: deck.terms.slice(0, 1500)
      }
    }
  )

  let polishCtl: AbortController | null = null
  ipcMain.handle('llm:polish', async (_e, req: import('@shared/types').PolishRequest) => {
    if (organizeBusy) throw new Error(i18nCode('err.orgBusy'))
    if (!req || typeof req.sourceText !== 'string' || !req.sourceText.trim()) {
      throw new Error(i18nCode('pol.noText'))
    }
    organizeBusy = true
    polishCtl = new AbortController()
    try {
      const slidesContext = await deckContext(req)
      const out = await polishText(
        currentSettings(),
        { sourceText: req.sourceText, slidesContext },
        (p) => emit('llm:progress', p),
        polishCtl.signal
      )
      return { text: out.text, requests: out.requests, chunks: out.chunks }
    } finally {
      organizeBusy = false
      polishCtl = null
    }
  })
  // 取消"生成增强版"（长转写要跑几分钟，用户得能停）
  ipcMain.handle('llm:polishCancel', () => {
    try {
      polishCtl?.abort()
    } catch {
      /* ignore */
    }
    return true
  })

  ipcMain.handle('llm:validate', async () => {
    const r = await validateKey(currentSettings())
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  })

  // 指定渠道（可未保存）连通性测试
  ipcMain.handle(
    'llm:testChannel',
    async (_e, ch: { baseUrl: string; apiKey: string; modelId: string; local?: boolean }) => {
      if (!ch?.baseUrl || !ch?.modelId) return { ok: false, error: i18nCode('err.channelIncomplete') }
      return testChannel(currentSettings(), ch)
    }
  )

  // 渠道模型列表
  ipcMain.handle('llm:listModels', async (_e, ch: { baseUrl: string; apiKey: string }) => {
    if (!ch?.baseUrl) return { ok: false, models: [], error: i18nCode('err.channelIncomplete') }
    return listChannelModels(ch)
  })

  // ── 模型 ────────────────────────────────────────────
  ipcMain.handle('models:catalog', () => MODEL_CATALOG.map(localizeModel))

  ipcMain.handle('models:status', (): ModelStatus[] => {
    return MODEL_CATALOG.map((m) => localizeModel(m)).map((info) => {
      const p = path.join(ctx.modelsDir, info.file)
      try {
        const st = fs.statSync(p)
        return { info, present: st.size > 1_000_000, sizeBytes: st.size, localPath: p }
      } catch {
        return { info, present: false, sizeBytes: 0 }
      }
    })
  })

  ipcMain.handle('models:download', async (_e, id: string) => {
    const info = MODEL_CATALOG.find((m) => m.id === id)
    if (!info) throw new Error(i18nCode('err.unknownModel'))
    const dest = path.join(ctx.modelsDir, info.file)
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) return
    const prev = modelDl.get(info.file)
    if (prev) prev.abort()
    const ctrl = new AbortController()
    modelDl.set(info.file, ctrl)
    try {
      await downloadFile(
        info.url,
        dest,
        (received, total) => {
          emit('model:progress', {
            file: info.file,
            received,
            total,
            pct: total ? Math.round((received / total) * 100) : 0
          })
        },
        ctrl.signal
      )
    } catch (e) {
      if (ctrl.signal.aborted) {
        try {
          fs.unlinkSync(dest + '.part')
        } catch {
          /* ignore */
        }
        emit('model:progress', { file: info.file, received: 0, total: 0, pct: 0 })
        return
      }
      throw e
    } finally {
      modelDl.delete(info.file)
    }
  })

  ipcMain.handle('models:cancel', (_e, file: string): boolean => {
    if (typeof file !== 'string' || !file) return false
    const ctrl = modelDl.get(file)
    if (!ctrl) return false
    ctrl.abort()
    return true
  })

  ipcMain.handle('models:remove', (_e, file: string): { ok: boolean; error?: string } => {
    try {
      if (typeof file !== 'string' || !file) return { ok: false, error: i18nCode('err.badParam') }
      // 转写/导入进行中禁止删除（避免删掉正在使用的模型）
      if (ctx.asr.busy || importBusy) {
        return { ok: false, error: i18nCode('err.asrBusy') }
      }
      // 当前“选用中”的模型不允许直接删除，需先选用其他模型
      const cur = currentSettings().whisper.modelFile
      const curPath = cur ? (path.isAbsolute(cur) ? cur : path.join(ctx.modelsDir, cur)) : ''
      if (curPath && path.resolve(curPath) === path.resolve(path.join(ctx.modelsDir, file))) {
        return { ok: false, error: i18nCode('err.modelInUse') }
      }
      // 至少保留一个已安装模型（不能删到零）
      const present = MODEL_CATALOG.filter((m) => {
        try {
          const p = path.join(ctx.modelsDir, m.file)
          return fs.existsSync(p) && fs.statSync(p).size > 1_000_000
        } catch {
          return false
        }
      })
      if (present.length <= 1) return { ok: false, error: i18nCode('err.keepOneModel') }
      const target = path.join(ctx.modelsDir, file)
      if (!fs.existsSync(target)) return { ok: false, error: i18nCode('err.modelFileMissing') }
      fs.unlinkSync(target)
      // 记住“用户主动删除过模型”：更新后不再自动下载回来
      try {
        const cur = currentSettings()
      } catch {
        /* ignore */
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ── 系统 ────────────────────────────────────────────
  ipcMain.handle('sys:probeWhisper', () => probeBinary(currentSettings().whisper.binaryPath))
  ipcMain.handle('sys:copyText', (_e, text: string): boolean => {
    try {
      clipboard.writeText(typeof text === 'string' ? text : String(text ?? ''))
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle('sys:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url)
  })

  // ── 导入录音文件（已有录音 → 本地转写）────────────────
  ipcMain.handle('dialog:pickAudio', async (): Promise<{ path: string; fileName: string } | null> => {
    const win = ctx.getWindow()
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: tm('app.pickAudio'),
      properties: ['openFile'],
      filters: [
        { name: tm('app.audio'), extensions: ['m4a', 'mp3', 'wav', 'mp4', 'm4b', 'aac', 'flac', 'ogg', 'opus', 'webm', 'caf', 'aiff', 'mov'] },
        { name: tm('app.allFiles'), extensions: ['*'] }
      ]
    })
    if (canceled || !filePaths[0]) return null
    return { path: filePaths[0], fileName: path.basename(filePaths[0]) }
  })

  ipcMain.handle('dialog:pickFolder', async (): Promise<string | null> => {
    const win = ctx.getWindow()
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: tm('app.pickFolder'),
      properties: ['openDirectory', 'createDirectory']
    })
    return canceled || !filePaths[0] ? null : filePaths[0]
  })

  ipcMain.handle('rec:importPause', async (): Promise<{ ok: boolean }> => {
    ctx.asr.pauseImport()
    emit('import:progress', { stage: 'paused', pct: 0 })
    return { ok: true }
  })
  ipcMain.handle('rec:importResume', async (): Promise<{ ok: boolean }> => {
    ctx.asr.resumeImport()
    emit('import:progress', { stage: 'resumed', pct: 0 })
    return { ok: true }
  })
  ipcMain.handle('rec:importStop', async (): Promise<{ ok: boolean }> => {
    ctx.asr.stopImport()
    return { ok: true }
  })

  ipcMain.handle(
    'rec:importFile',
    async (_e, filePath: string): Promise<{ ok: boolean; error?: string; segmentCount?: number; fileName?: string; stopped?: boolean; durationMs?: number }> => {
      if (typeof filePath !== 'string' || !filePath.trim()) return { ok: false, error: i18nCode('err.badParam') }
      if (importBusy) return { ok: false, error: i18nCode('err.importRunning') }
      importBusy = true
      let tmpWav: string | null = null
      let lastTotalSec = 0
      try {
        emit('import:progress', { stage: 'decode', pct: 0 })
        // 解码为临时 WAV 文件（长录音不再整段驻留内存，避免 Array buffer allocation failed）
        tmpWav = await decodeTo16kWavFile(filePath)
        const settings = currentSettings()
        ctx.asr.settingsSnapshot = settings
        emit('import:progress', { stage: 'ready', pct: 0 })
        const segments = await ctx.asr.transcribeFileOnce(
          settings,
          tmpWav,
          (s) => emit('asr:segment', s),
          (p) => {
            if (typeof p.totalSec === 'number') lastTotalSec = p.totalSec
            emit('import:progress', { stage: 'transcribe', ...p })
          }
        )
        const stopped = ctx.asr.importStopped
        const durationMs =
          Math.round(lastTotalSec * 1000) ||
          (segments.length ? Math.round((segments[segments.length - 1].t1 ?? 0) * 1000) : 0)
        if (stopped) {
          emit('import:progress', { stage: 'stopped', pct: 100, count: segments.length })
          return { ok: true, segmentCount: segments.length, fileName: path.basename(filePath), stopped: true, durationMs }
        }
        emit('import:progress', { stage: 'done', pct: 100, count: segments.length })
        return { ok: true, segmentCount: segments.length, fileName: path.basename(filePath), durationMs }
      } catch (e) {
        emit('import:progress', { stage: 'error' })
        return { ok: false, error: (e as Error).message }
      } finally {
        if (tmpWav) {
          try {
            fs.unlinkSync(tmpWav)
          } catch {
            /* ignore */
          }
        }
        importBusy = false
      }
    }
  )

  // ── 转写记录库 ─────────────────────────────────────────
  ipcMain.handle('transcription:list', () => listTranscriptions())

  ipcMain.handle('transcription:get', (_e, id: string) => {
    if (typeof id !== 'string' || !id) return null
    return getTranscription(id)
  })

  ipcMain.handle(
    'transcription:save',
    (_e, draft: import('@shared/types').TranscriptionDraft): import('@shared/types').TranscriptionRecord => {
      if (!draft || typeof draft !== 'object') throw new Error(i18nCode('err.badParam'))
      return saveTranscription(draft)
    }
  )

  ipcMain.handle('transcription:remove', (_e, id: string): boolean => {
    if (typeof id !== 'string' || !id) return false
    return deleteTranscription(id)
  })
}
