// IPC：注册所有主进程可调用通道与上行事件
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import type {
  AppSettings,
  DailyUsage,
  ModelStatus,
  NoteDraft,
  NoteRecord,
  OrganizeRequest,
  OrganizeResult
} from '@shared/types'
import { loadConfig, saveConfig, getDailyUsage, resetDailyUsage } from './config'
import { i18nCode, tm } from './i18n'
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
  deleteTranscription
} from './db'
import { MODEL_CATALOG, localizeModel } from './modelCatalog'
import { downloadFile } from './download'
import { organizeText } from './llm/organize'
import { polishText } from './llm/polish'
import { validateKey } from './llm/openrouter'
import { probeBinary } from './whisperServer'
import { decodeTo16kWavFile } from './decodeAudio'
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

  // ── LLM 整理 ────────────────────────────────────────
  const orgCtl = new Map<string, { ctrl: AbortController; startedAt: number }>()
  /** 超过这个时间没有任何进展就自动中止（正常每块 30~60s，120s 请求超时兜底） */
  const ORG_STALL_MS = 210_000

  const runOrgJob = async (job: OrgJob): Promise<void> => {
    const { req } = job
    organizeBusy = true
    const startedAt = Date.now()
    let requests = 0
    let lastBeat = Date.now()
    const ctrl = new AbortController()
    orgCtl.set(job.jobId, { ctrl, startedAt })
    const beat = (line: string): void => {
      lastBeat = Date.now()
      orgLog(`[${job.jobId.slice(0, 8)}] ${line}`)
    }
    // 看门狗：长时间没有任何进展（含 120s 请求超时 + 合并阶段）就中止，避免“永远挂着没动静”
    const watchdog = setInterval(() => {
      if (Date.now() - lastBeat > ORG_STALL_MS) {
        orgLog(`[${job.jobId.slice(0, 8)}] watchdog: no progress for ${Math.round((Date.now() - lastBeat) / 1000)}s -> abort`)
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
      const res = await organizeText(
        currentSettings(),
        {
          title: req.title,
          sourceText: req.sourceText,
          templateId: req.templateId,
          length: req.length,
          slidesText
        },
        wrappedProgress,
        ctrl.signal
      )
      beat(`done requests=${res.requests} chunks=${res.chunks} noteChars=${res.noteMd.length}`)
      emit('llm:jobDone', {
        jobId: job.jobId,
        mode: job.mode,
        replaceId: job.replaceId,
        title: req.title,
        noteMd: res.noteMd,
        sourceText: req.sourceText,
        templateId: req.templateId,
        length: req.length,
        requests: res.requests,
        chunks: res.chunks,
        truncated: res.truncated,
        continuations: res.continuations
      })
    } catch (e) {
      const canceled = ctrl.signal.aborted
      const msg = canceled ? i18nCode('org.jobCanceled') : (e as Error).message
      const raw = (e as { raw?: string }).raw
      beat(`error canceled=${canceled} ${clip(msg)}${raw ? ` raw=${clip(raw, 1500)}` : ''}`)
      emit('llm:jobError', { jobId: job.jobId, error: msg, canceled })
    } finally {
      clearInterval(watchdog)
      orgCtl.delete(job.jobId)
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
      orgLog(`[${jobId.slice(0, 8)}] cancel requested (aborting in-flight request)`)
      cur.ctrl.abort()
      return true
    }
    return false
  })

  // 兼容旧调用：同步等待一次整理
  ipcMain.handle('llm:organize', async (_e, req: OrganizeRequest): Promise<OrganizeResult> => {
    if (!req || typeof req.sourceText !== 'string' || !req.sourceText.trim()) {
      throw new Error(i18nCode('org.noText'))
    }
    const slidesText = await deckContext(req)
    return organizeText(
      currentSettings(),
      { title: req.title, sourceText: req.sourceText, templateId: req.templateId, length: req.length, slidesText },
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

  ipcMain.handle('llm:polish', async (_e, req: import('@shared/types').PolishRequest) => {
    if (organizeBusy) throw new Error(i18nCode('err.orgBusy'))
    if (!req || typeof req.sourceText !== 'string' || !req.sourceText.trim()) {
      throw new Error(i18nCode('pol.noText'))
    }
    organizeBusy = true
    try {
      const slidesContext = await deckContext(req)
      const out = await polishText(
        currentSettings(),
        { sourceText: req.sourceText, slidesContext },
        (p) => emit('llm:progress', p)
      )
      return { text: out.text, requests: out.requests, chunks: out.chunks }
    } finally {
      organizeBusy = false
    }
  })

  ipcMain.handle('llm:validate', async () => {
    const r = await validateKey(currentSettings())
    return r.ok ? { ok: true } : { ok: false, error: r.error }
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
