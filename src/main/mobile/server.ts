// 手机连接：局域网只读 HTTP 服务（同一 Wi-Fi 下手机扫码配对后读取笔记/转写）
//
// 设计要点：
//  · 默认关闭；开启后仅监听局域网网卡，全部数据接口都要 Bearer 令牌
//  · 配对：电脑上生成一次性配对码 → 二维码 → 手机 POST /api/pair 换取长期设备令牌
//  · 只读：不提供任何写接口（笔记编辑永远在电脑端）；复习结果回传在阶段 5 再加
//  · 不上云：请求不出局域网，日志落在数据目录 logs/mobile.log
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { getNote, getTranscription, listNotebooks, listNotes, listTranscriptions, listCards, importReviews, cardStats } from '../db'
import { loadConfig, saveConfig } from '../config'
import { lanIPv4, primaryLanIPv4 } from './lan'
import type { MobileDevice, MobileStatus } from '@shared/types'

const PAIR_TTL_MS = 5 * 60_000
const MAX_BODY = 512 * 1024
const LOG_MAX = 512 * 1024

export interface MobileServerOptions {
  /** 日志目录（数据目录/logs） */
  logsDir: string
  /** 局域网直传的 APK 路径（可为空 = 不提供下载） */
  apkPath?: () => string | null
  /** 版本号，用于落地页/接口展示 */
  version: string
}

interface Pairing {
  code: string
  expires: number
}

export class MobileServer {
  private srv: http.Server | null = null
  private port = 0
  private pairing: Pairing | null = null
  private lastError: string | undefined
  private pairAttempts: number[] = []
  private readonly opts: MobileServerOptions

  constructor(opts: MobileServerOptions) {
    this.opts = opts
  }

  get running(): boolean {
    return this.srv !== null
  }

  private log(line: string): void {
    try {
      const file = path.join(this.opts.logsDir, 'mobile.log')
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX) fs.writeFileSync(file, '')
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      /* 日志失败不影响服务 */
    }
  }

  private devices(): MobileDevice[] {
    return loadConfig().mobile?.devices ?? []
  }

  /**
   * 电脑的持久身份：手机在局域网里扫描时用它确认"这就是我那台电脑"。
   * 随机生成一次后写进配置，重装/重置才会变。
   */
  deskId(): string {
    const cfg = loadConfig()
    const cur = cfg.mobile?.deskId
    if (cur) return cur
    const id = randomBytes(8).toString('hex')
    saveConfig({ mobile: { ...(cfg.mobile ?? {}), deskId: id } })
    return id
  }

  /** 这台电脑当前所有可连接地址（手机连不上时挨个试的就是这些） */
  candidates(): string[] {
    if (!this.running) return []
    return lanIPv4().map((ip) => `http://${ip}:${this.port}`)
  }

  status(): MobileStatus {
    const cfg = loadConfig()
    const devs = cfg.mobile?.devices ?? []
    const ip = primaryLanIPv4()
    let notes = 0
    let notebooks = 0
    let transcripts = 0
    try {
      notes = listNotes().length
      notebooks = listNotebooks().length
      transcripts = listTranscriptions().length
    } catch {
      /* 数据库未就绪时忽略 */
    }
    const apk = this.opts.apkPath?.() ?? null
    return {
      running: this.running,
      port: this.running ? this.port : null,
      urls: this.candidates(),
      devices: devs.map((d) => ({ id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen })),
      apkAvailable: !!apk && fs.existsSync(apk) && (cfg.mobile?.serveApk ?? true),
      apkName: apk ? path.basename(apk) : undefined,
      serveApk: cfg.mobile?.serveApk ?? true,
      noteCount: notes,
      notebookCount: notebooks,
      transcriptCount: transcripts,
      lastError: this.lastError
    }
  }

  /** 生成/复用一次性配对码与可扫码地址 */
  async qrPayload(): Promise<{ url: string; code: string; svg: string } | { error: string }> {
    if (!this.running) return { error: 'not-running' }
    const ip = primaryLanIPv4()
    if (!ip) return { error: 'no-lan' }
    const code = randomBytes(4).toString('hex') // 8 位十六进制
    this.pairing = { code, expires: Date.now() + PAIR_TTL_MS }
    const url = `http://${ip}:${this.port}/p?t=${code}`
    const QRCode = (await import('qrcode')).default
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240, errorCorrectionLevel: 'M' })
    this.log(`pairing code issued from ${ip}`)
    return { url, code, svg }
  }

  async start(preferredPort = 0): Promise<{ ok: boolean; port?: number; error?: string }> {
    if (this.srv) return { ok: true, port: this.port }
    const server = http.createServer((req, res) => void this.handle(req, res))
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        // 绑定所有网卡（含局域网）；未配对请求一律 401，配对必须输一次性码
        server.listen(preferredPort, '0.0.0.0', () => resolve())
      })
    } catch (e) {
      this.lastError = (e as Error).message
      this.log(`start failed: ${this.lastError}`)
      try {
        server.close()
      } catch {
        /* ignore */
      }
      return { ok: false, error: this.lastError }
    }
    const addr = server.address()
    this.port = typeof addr === 'object' && addr ? addr.port : preferredPort
    this.srv = server
    this.lastError = undefined
    this.log(`listening on 0.0.0.0:${this.port}`)
    return { ok: true, port: this.port }
  }

  stop(): void {
    if (!this.srv) return
    try {
      this.srv.close()
    } catch {
      /* ignore */
    }
    this.log(`stopped (was port ${this.port})`)
    this.srv = null
    this.port = 0
    this.pairing = null
  }

  revoke(id: string): void {
    const cur = loadConfig()
    const devices = (cur.mobile?.devices ?? []).filter((d) => d.id !== id)
    saveConfig({ mobile: { ...(cur.mobile ?? {}), devices } })
    this.log(`device revoked: ${id}`)
  }

  revokeAll(): void {
    const cur = loadConfig()
    saveConfig({ mobile: { ...(cur.mobile ?? {}), devices: [] } })
    this.log('all devices revoked')
  }

  // ── 请求处理 ────────────────────────────────────────────────
  /** 手机端（Capacitor WebView）origin 是 http://localhost / capacitor://localhost，属跨源请求 */
  private cors(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.setHeader('Access-Control-Max-Age', '600')
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    this.cors(res)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(text)
    })
    res.end(text)
  }

  private html(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY) {
          reject(new Error('too-large'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      req.on('error', reject)
    })
  }

  /** 解析 Bearer 令牌并返回对应设备 */
  private auth(req: http.IncomingMessage, url: URL): MobileDevice | null {
    const h = req.headers.authorization ?? ''
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : (url.searchParams.get('dt') ?? '')
    if (!token) return null
    const dev = this.devices().find((d) => d.token === token)
    return dev ?? null
  }

  private touch(dev: MobileDevice): void {
    // 心跳写入节流：最多每 60 秒写一次配置
    if (dev.lastSeen && Date.now() - dev.lastSeen < 60_000) return
    const cur = loadConfig()
    const devices = (cur.mobile?.devices ?? []).map((d) => (d.id === dev.id ? { ...d, lastSeen: Date.now() } : d))
    saveConfig({ mobile: { ...(cur.mobile ?? {}), devices } })
  }

  private landing(t: string, host: string): string {
    const apk = this.opts.apkPath?.() ?? null
    const hasApk = !!apk && fs.existsSync(apk) && (loadConfig().mobile?.serveApk ?? true)
    const deep = `whispernotes://pair?host=${encodeURIComponent(host)}&t=${encodeURIComponent(t)}`
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhisperNotes 手机连接</title>
<style>
 body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:28px 18px;background:#0f1115;color:#e8eaf0}
 .card{max-width:460px;margin:0 auto;background:#171a21;border:1px solid #262b36;border-radius:16px;padding:22px}
 h1{font-size:19px;margin:0 0 6px} p{color:#9aa3b2;font-size:14px;line-height:1.6}
 a.btn{display:block;text-align:center;padding:13px;border-radius:12px;text-decoration:none;font-weight:600;margin-top:12px}
 .p{background:#3b82f6;color:#fff} .s{background:#22262f;color:#e8eaf0;border:1px solid #333a47}
 .warn{background:rgba(217,119,6,.12);border:1px solid rgba(217,119,6,.4);color:#fbbf24;padding:10px 12px;border-radius:10px;font-size:13px}
 code{background:#22262f;padding:3px 7px;border-radius:6px;font-size:13px}
</style></head><body><div class="card">
<h1>WhisperNotes 手机连接</h1>
<p>同一 Wi-Fi 下即可在手机上复习你的笔记与转写。数据只在本机与手机之间传输，不上云。</p>
${hasApk ? `<a class="btn p" href="/apk">⬇︎ 下载 Android App（${path.basename(apk!)}，${(fs.statSync(apk!).size / 1048576).toFixed(1)} MB）</a>` : `<p class="warn">电脑端没有附带安装包：请把 WhisperNotes-android.apk 用数据线 / AirDrop 传到手机安装，再回来点下面的按钮连接。</p>`}
<a class="btn s" href="${deep}">已在手机装好 App？点这里连接</a>
<p style="margin-top:16px">配对码：<code>${t.slice(0, 4)}-${t.slice(4)}</code></p>
<p>若链接没反应，请在 App 内选择「扫描二维码」。</p>
</div></body></html>`
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = req.headers.host ?? ''
    const url = new URL(req.url ?? '/', `http://${host || 'localhost'}`)
    const p = url.pathname
    try {
      // 预检请求（POST + JSON 会触发）直接放行
      if (req.method === 'OPTIONS') {
        this.cors(res)
        res.writeHead(204)
        res.end()
        return
      }

      // 免鉴权：探活
      if (p === '/api/ping') {
        this.json(res, 200, {
          ok: true,
          app: 'WhisperNotes',
          version: this.opts.version,
          deskId: this.deskId(),
          port: this.port
        })
        return
      }

      // 免鉴权：二维码落地页（用一次性配对码打开；本身不含数据）
      if (p === '/p' || p === '/pair') {
        const t = url.searchParams.get('t') ?? ''
        this.html(res, 200, this.landing(t, `http://${host}`))
        return
      }

      // 免鉴权（需配对码）：换取长期设备令牌
      if (p === '/api/pair' && req.method === 'POST') {
        const now = Date.now()
        this.pairAttempts = this.pairAttempts.filter((x) => now - x < 60_000)
        if (this.pairAttempts.length >= 10) {
          this.log('pair rate-limited')
          this.json(res, 429, { ok: false, error: 'too-many-attempts' })
          return
        }
        this.pairAttempts.push(now)
        const raw = await this.readBody(req)
        let body: { code?: string; device?: string; t?: string } = {}
        try {
          body = JSON.parse(raw || '{}') as typeof body
        } catch {
          this.json(res, 400, { ok: false, error: 'bad-json' })
          return
        }
        const code = (body.code ?? body.t ?? '').trim()
        const active = this.pairing
        if (!active || active.expires < now) {
          this.log('pair rejected: no active code')
          this.json(res, 401, { ok: false, error: 'no-active-code' })
          return
        }
        if (code.toLowerCase() !== active.code.toLowerCase()) {
          this.log('pair rejected: wrong code')
          this.json(res, 401, { ok: false, error: 'bad-code' })
          return
        }
        const dev: MobileDevice = {
          id: randomUUID(),
          name: (body.device || 'Android').slice(0, 60),
          token: randomBytes(24).toString('hex'),
          pairedAt: now,
          lastSeen: now
        }
        const cur = loadConfig()
        saveConfig({ mobile: { ...(cur.mobile ?? {}), devices: [...(cur.mobile?.devices ?? []), dev] } })
        this.pairing = null // 一次性
        this.log(`paired device: ${dev.name} (${dev.id})`)
        this.json(res, 200, {
          ok: true,
          token: dev.token,
          deviceId: dev.id,
          app: 'WhisperNotes',
          // 手机存下电脑身份 + 所有候选地址：IP 变了也能自己找回来
          deskId: this.deskId(),
          urls: this.candidates()
        })
        return
      }

      // 免鉴权：局域网直传 APK
      if (p === '/apk') {
        const apk = this.opts.apkPath?.() ?? null
        if (!apk || !fs.existsSync(apk) || !(loadConfig().mobile?.serveApk ?? true)) {
          this.json(res, 404, { ok: false, error: 'no-apk' })
          return
        }
        const stat = fs.statSync(apk)
        res.writeHead(200, {
          'Content-Type': 'application/vnd.android.package-archive',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${path.basename(apk)}"`
        })
        fs.createReadStream(apk).pipe(res)
        this.log(`apk served (${stat.size} bytes)`)
        return
      }

      // 以下全部需要已配对令牌
      const dev = this.auth(req, url)
      if (!dev) {
        this.json(res, 401, { ok: false, error: 'unauthorized' })
        return
      }
      this.touch(dev)

      if (p === '/api/library') {
        const notes = listNotes().map((n) => ({
          id: n.id,
          title: n.title,
          notebookId: n.notebookId ?? null,
          updatedAt: n.updatedAt,
          createdAt: n.createdAt,
          durationMs: n.durationMs,
          tags: n.tags ?? [],
          excerpt: (n.noteMd ?? '').replace(/#+\s*/g, '').replace(/\s+/g, ' ').trim().slice(0, 160)
        }))
        const transcripts = listTranscriptions().map((t) => ({
          id: t.id,
          title: t.title,
          source: t.source,
          sourceName: t.sourceName,
          createdAt: t.createdAt,
          // 手机端靠 updatedAt 判断"这条变了没有"（增强版/转笔记状态更新都要能带过去）
          updatedAt: t.updatedAt ?? t.createdAt,
          durationMs: t.durationMs,
          hasEnhanced: t.hasEnhanced,
          preview: t.preview
        }))
        this.json(res, 200, {
          ok: true,
          notebooks: listNotebooks().map((b) => ({ id: b.id, name: b.name, parentId: b.parentId ?? null, color: b.color, ord: b.ord ?? 0, hidden: !!b.hidden })),
          notes,
          transcripts,
          generatedAt: Date.now()
        })
        return
      }

      const noteMatch = p.match(/^\/api\/note\/([^/]+)$/)
      if (noteMatch) {
        const rec = getNote(decodeURIComponent(noteMatch[1]))
        if (!rec) {
          this.json(res, 404, { ok: false, error: 'not-found' })
          return
        }
        this.json(res, 200, {
          ok: true,
          id: rec.id,
          title: rec.title,
          noteMd: rec.noteMd ?? '',
          sourceText: rec.sourceText ?? '',
          notebookId: rec.notebookId ?? null,
          updatedAt: rec.updatedAt,
          createdAt: rec.createdAt,
          durationMs: rec.durationMs,
          tags: rec.tags ?? []
        })
        return
      }

      // 闪卡：手机端复习用（只读列卡 + 回传复习结果）
      if (p === '/api/cards') {
        const due = url.searchParams.get('due') === '1'
        const noteId = url.searchParams.get('noteId') ?? undefined
        const all = url.searchParams.get('all') === '1'
        const cards = listCards({ due: due && !all, noteId, includeSuspended: all })
        const notes = listNotes()
        const nbOfNote = new Map(notes.map((n) => [n.id, n.notebookId ?? null]))
        this.json(res, 200, {
          ok: true,
          stats: cardStats(),
          cards: cards.map((c) => ({
            id: c.id,
            noteId: c.noteId,
            front: c.front,
            back: c.back,
            hint: c.hint ?? null,
            tags: c.tags,
            dueAt: c.dueAt ?? null,
            intervalDays: c.intervalDays ?? null,
            ease: c.ease ?? null,
            reps: c.reps ?? 0,
            lapses: c.lapses ?? 0,
            suspended: !!c.suspended,
            // 笔记本以"笔记当前归属"为准（笔记换本子后分类自动跟上）
            notebookId: c.noteId ? (nbOfNote.get(c.noteId) ?? c.notebookId ?? null) : (c.notebookId ?? null),
            importance: c.importance ?? null,
            kind: c.kind ?? null,
            quote: c.quote ?? null
          }))
        })
        return
      }

      if (p === '/api/review' && req.method === 'POST') {
        const raw = await this.readBody(req)
        let body: { items?: Array<{ cardId: string; grade: number; at?: number; ms?: number }> } = {}
        try {
          body = JSON.parse(raw || '{}') as typeof body
        } catch {
          this.json(res, 400, { ok: false, error: 'bad-json' })
          return
        }
        const items = Array.isArray(body.items) ? body.items : []
        if (!items.length) {
          this.json(res, 400, { ok: false, error: 'empty' })
          return
        }
        const n = importReviews(items.map((x) => ({ cardId: String(x.cardId), grade: Number(x.grade), at: x.at, ms: x.ms, source: 'android' })))
        this.log(`review import from ${dev.name}: ${n} cards`)
        this.json(res, 200, { ok: true, imported: n, stats: cardStats() })
        return
      }

      const trMatch = p.match(/^\/api\/transcript\/([^/]+)$/)
      if (trMatch) {
        const rec = getTranscription(decodeURIComponent(trMatch[1]))
        if (!rec) {
          this.json(res, 404, { ok: false, error: 'not-found' })
          return
        }
        this.json(res, 200, {
          ok: true,
          id: rec.id,
          title: rec.title,
          raw: rec.rawText ?? '',
          enhanced: rec.enhancedText ?? null,
          createdAt: rec.createdAt,
          // 手机端据此判断"这条是不是新的"（增量同步）
          updatedAt: rec.updatedAt ?? rec.createdAt,
          noteStatus: rec.noteStatus ?? 'none',
          durationMs: rec.durationMs
        })
        return
      }

      this.json(res, 404, { ok: false, error: 'unknown-endpoint' })
    } catch (e) {
      this.lastError = (e as Error).message
      this.log(`error ${p}: ${this.lastError}`)
      if (!res.headersSent) this.json(res, 500, { ok: false, error: 'internal' })
      else res.end()
    }
  }
}

export { primaryLanIPv4 }
