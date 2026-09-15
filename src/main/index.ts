// Electron 主进程入口
import { app, BrowserWindow, ipcMain, nativeImage, session } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { tm } from './i18n'
import { initOrgLog } from './orgLog'

// 固定应用名 → userData 始终为 ~/Library/Application Support/WhisperNotes
app.setName('WhisperNotes')

// 应用图标（dev/直跑时位于项目根 build/，打包后由 .icns/.ico 提供）
const appIconPng = path.join(__dirname, '../../build/icon.png')
const hasAppIcon = fs.existsSync(appIconPng)

// 崩溃/异常兜底：写入 userData/logs/main-errors.log，而不是让进程静默退出
function crashLog(line: string): void {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'main-errors.log'), `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* ignore */
  }
}
process.on('uncaughtException', (err) => {
  crashLog(`uncaughtException: ${err?.stack ?? String(err)}`)
})
process.on('unhandledRejection', (reason) => {
  crashLog(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`)
})

import { initPaths, loadConfig, ensureSecretsEncrypted, saveConfig } from './config'
import { bundledModelBin } from './bundled'
import { MODEL_CATALOG } from './modelCatalog'
import { downloadFile } from './download'
import { openDb, ensureGuideNotes } from './db'
import { registerIpc, emit } from './ipc'
import { AsrManager } from './asrManager'
import { probeBinary } from './whisperServer'
import type { AsrSegment, AsrDraft } from '@shared/types'

let mainWindow: BrowserWindow | null = null
let asr: AsrManager | null = null
let quitConfirmed = false
const lastRendererCrashAt = new Map<number, number>()

function dirs() {
  const userData = app.getPath('userData')
  const cfg = loadConfig()
  const dataParent = (cfg.storage?.dataParent ?? '').trim()
  const recParent = (cfg.storage?.recordingsParent ?? '').trim()
  const base = dataParent ? path.join(dataParent, 'whisper-notes') : userData
  const recordings = recParent ? path.join(recParent, 'whisper-notes-recordings') : path.join(base, 'recordings')
  // 模型/日志默认留在应用数据目录（不随库迁移，避免移动大文件）；库目录自定义时日志跟随
  const models = path.join(userData, 'models')
  const logs = path.join(base, 'logs')
  for (const d of [base, recordings, models, logs]) fs.mkdirSync(d, { recursive: true })
  // 首次切换到自定义库目录：把默认位置的 library.db 复制过去（之后以新位置为准）
  if (base !== userData) {
    const fromDb = path.join(userData, 'library.db')
    const toDb = path.join(base, 'library.db')
    if (fs.existsSync(fromDb) && !fs.existsSync(toDb)) {
      try {
        fs.copyFileSync(fromDb, toDb)
        for (const ext of ['-wal', '-shm']) {
          const f = fromDb + ext
          if (fs.existsSync(f)) fs.copyFileSync(f, toDb + ext)
        }
      } catch {
        /* 忽略：迁移失败则从空库开始 */
      }
    }
  }
  return { base, models, logs, recordings }
}

function createWindow(): void {
  const preloadPath = path.join(__dirname, '../preload/index.js')
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1000,
    minHeight: 660,
    title: tm('win.main'),
    backgroundColor: '#0a0e17',
    ...(hasAppIcon ? { icon: appIconPng } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // 麦克风权限：仅允许本项目页面
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // 点 ×（或关闭窗口）不静默隐藏：先问渲染层是否有未保存内容，确认后真正退出
  mainWindow.on('close', (e) => {
    if (quitConfirmed) return
    crashLog('main window close requested -> asking renderer')
    e.preventDefault()
    mainWindow?.webContents.send('app:closeRequest')
  })
}

/** 双击笔记 → 独立纯文本编辑窗 */
function createChildWindow(noteId: string): void {
  const preloadPath = path.join(__dirname, '../preload/index.js')
  const win = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 480,
    minHeight: 480,
    title: tm('win.child'),
    backgroundColor: '#0a0e17',
    ...(hasAppIcon ? { icon: appIconPng } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const query = `?child=1&id=${encodeURIComponent(noteId)}`
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'] + query)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), { search: query.slice(1) })
  }
}

/** 首次运行：若包内带默认模型且模型目录里没有，则复制过去（引擎用内置 whisper-server） */
function provisionBundledModel(): void {
  try {
    const model = bundledModelBin()
    const d = dirs()
    if (!model || !d.models) return
    const dest = path.join(d.models, path.basename(model))
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(d.models, { recursive: true })
      fs.copyFileSync(model, dest)
      crashLog(`bundled model provisioned -> ${dest}`)
    }
  } catch (err) {
    crashLog(`provisionBundledModel: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 没有任何模型且允许自动下载时，后台下载默认模型（更新/重装不会重复下载用户删过的模型） */
function hasAnyModel(modelsDir: string): boolean {
  try {
    return fs
      .readdirSync(modelsDir)
      .some((f) => /\.bin$/i.test(f) && fs.statSync(path.join(modelsDir, f)).size > 1_000_000)
  } catch {
    return false
  }
}

function autoDownloadModelIfNeeded(): void {
  try {
    const cfg = loadConfig()
    const d = dirs()
    if (hasAnyModel(d.models)) return
    const want = cfg.whisper.modelFile || ''
    const info = MODEL_CATALOG.find((m) => m.file === want) ?? MODEL_CATALOG.find((m) => m.file.includes('large-v3-turbo')) ?? MODEL_CATALOG[0]
    if (!info) return
    const dest = path.join(d.models, info.file)
    void (async () => {
      try {
        emit('model:progress', { file: info.file, received: 0, total: 0, pct: 0 })
        await downloadFile(info.url, dest, (received, total) => {
          emit('model:progress', {
            file: info.file,
            received,
            total,
            pct: total ? Math.round((received / total) * 100) : 0
          })
        })
        emit('model:progress', { file: info.file, received: 0, total: 0, pct: 100 })
        crashLog(`auto model downloaded: ${info.file}`)
        // 默认选用这个模型
        saveConfig({ whisper: { ...loadConfig().whisper, modelFile: info.file } })
      } catch (err) {
        crashLog(`auto model download failed: ${err instanceof Error ? err.message : String(err)}`)
        emit('model:error', { file: info.file, error: err instanceof Error ? err.message : String(err) })
      }
    })()
  } catch (err) {
    crashLog(`autoDownloadModelIfNeeded: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function bootAsr(): void {
  if (asr) return
  const d = dirs()
  initPaths(d.base)
  openDb(d.base)
  ensureGuideNotes()
  asr = new AsrManager(
    {
      onSegment: (s: AsrSegment) => emit('asr:segment', s),
      onDraft: (draft: AsrDraft) => emit('asr:draft', draft),
      onState: (m) => emit('asr:state', m)
    },
    { recordings: d.recordings, models: d.models, logs: d.logs }
  )
  initOrgLog(d.logs)
  registerIpc({ getWindow: () => mainWindow, asr, modelsDir: d.models, openChildWindow: createChildWindow })
}

async function smokeTest(): Promise<void> {
  const checks: string[] = []
  try {
    const d = dirs()
    initPaths(d.base)
    const db = openDb(d.base)
    db.prepare('CREATE TEMP TABLE smoke(x)').run()
    db.prepare('INSERT INTO smoke VALUES (1)').run()
    checks.push('db:ok')
    const probe = probeBinary(loadConfig().whisper.binaryPath)
    checks.push(probe.found ? `whisper:${probe.binaryPath}` : 'whisper:NOT_FOUND')
    checks.push(`dirs:${d.base}`)
  } catch (e) {
    checks.push('fail:' + (e as Error).message)
  }
  console.log(`[smoke] ${checks.join(' | ')}`)
  app.exit(0)
}

app.whenReady().then(() => {
  initPaths(app.getPath('userData'))
  // 迁移：明文 API Key → 本地加密存储
  ensureSecretsEncrypted()
  // 首次运行：把随包附带的默认模型放进模型目录（引擎由 probeBinary 直接使用内置二进制）
  provisionBundledModel()
  bootAsr()

  // Dock 图标（仅开发/直跑时替换 Electron 默认图标）
  if (process.platform === 'darwin' && hasAppIcon) {
    try {
      app.dock?.setIcon(nativeImage.createFromPath(appIconPng))
    } catch {
      /* 忽略：打包后使用 bundle 自带图标 */
    }
  }

  if (process.env.ELECTRON_SMOKE) {
    void smokeTest()
    return
  }

  // 渲染层异常上报（React 渲染错误 / window.onerror / unhandledrejection）
  ipcMain.on('app:rendererError', (_e, payload: { message?: string; stack?: string; source?: string }) => {
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      const line = `[${new Date().toISOString()}] ${payload?.source ?? 'renderer'}: ${payload?.message ?? ''}\n${payload?.stack ?? ''}\n`
      fs.appendFileSync(path.join(dir, 'renderer-errors.log'), line)
    } catch {
      /* ignore */
    }
  })

  ipcMain.handle('app:quitConfirmed', () => {
    quitConfirmed = true
    app.quit()
  })

  createWindow()
  autoDownloadModelIfNeeded()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  crashLog('window-all-closed')
  if (process.platform !== 'darwin') app.quit()
})

app.on('render-process-gone', (_e, wc, details) => {
  crashLog(`render-process-gone (${details.reason}) webContents=${wc.id}`)
  const now = Date.now()
  const last = lastRendererCrashAt.get(wc.id) ?? 0
  if (details.reason !== 'clean-exit' && now - last > 5000 && !wc.isDestroyed()) {
    lastRendererCrashAt.set(wc.id, now)
    // 崩溃后自动重载，避免窗口直接消失
    setTimeout(() => {
      if (!wc.isDestroyed()) wc.reload()
    }, 800)
  }
})

app.on('child-process-gone', (_e, details) => {
  crashLog(`child-process-gone type=${details.type} reason=${details.reason} exit=${details.exitCode}`)
})

app.on('before-quit', () => {
  crashLog(`before-quit (quitConfirmed=${quitConfirmed})`)
  if (asr) void asr.dispose()
})

app.on('will-quit', () => {
  crashLog('will-quit')
})
