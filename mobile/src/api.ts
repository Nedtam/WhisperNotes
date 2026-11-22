// 与电脑端局域网服务通信：配对 + 只读拉取笔记/转写（离线时用本地缓存）
import { Preferences } from '@capacitor/preferences'
import * as local from './local'
import type { Notebook } from '@shared/types'

export interface Conn {
  baseUrl: string
  token: string
  deviceName: string
  pairedAt: number
  /** 电脑的持久身份（局域网扫描时确认"是同一台"） */
  deskId?: string
  /** 配对时电脑给的全部候选地址（换 IP 时挨个试） */
  urls?: string[]
}

export interface NoteMeta {
  id: string
  title: string
  notebookId: string | null
  updatedAt: number
  createdAt: number
  durationMs: number
  tags: string[]
  excerpt: string
}
export interface TrMeta {
  id: string
  title: string
  source: string
  sourceName: string
  createdAt: number
  /** 最后修改时间：变了才重新拉（增强版、转笔记状态都靠它带过来） */
  updatedAt?: number
  durationMs: number
  hasEnhanced: boolean
  preview: string
}
export interface Library {
  notebooks: Notebook[]
  notes: NoteMeta[]
  transcripts: TrMeta[]
  generatedAt: number
}
export interface NoteFull {
  id: string
  title: string
  noteMd: string
  sourceText: string
  notebookId: string | null
  updatedAt: number
  tags: string[]
}
export interface TrFull {
  id: string
  title: string
  raw: string
  enhanced: string | null
  createdAt: number
  durationMs: number
}

const CONN_KEY = 'wn.conn'
const LIB_KEY = 'wn.library'

export async function loadConn(): Promise<Conn | null> {
  try {
    const { value } = await Preferences.get({ key: CONN_KEY })
    return value ? (JSON.parse(value) as Conn) : null
  } catch {
    return null
  }
}

export async function saveConn(c: Conn): Promise<void> {
  await Preferences.set({ key: CONN_KEY, value: JSON.stringify(c) })
}

export async function clearConn(): Promise<void> {
  await Preferences.remove({ key: CONN_KEY })
}

export function deviceName(): string {
  const ua = navigator.userAgent
  const m = /Android[^;]*;\s*([^)]+?)(?:\s+Build|\))/.exec(ua)
  return (m?.[1] || 'Android').trim().slice(0, 40)
}

/** 规范化用户输入/扫码得到的地址：允许省略 http://，去掉末尾斜杠与 /p?t= 之类的路径 */
export function normalizeBaseUrl(raw: string): string {
  let s = (raw || '').trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  try {
    const u = new URL(s)
    return `${u.protocol}//${u.host}`
  } catch {
    return ''
  }
}

/** 从扫码/深链 URL 里解析出 { baseUrl, code } */
export function parsePairUrl(raw: string): { baseUrl: string; code: string } | null {
  try {
    const u = new URL(raw)
    let host = u.searchParams.get('host') ?? ''
    let code = u.searchParams.get('t') ?? u.searchParams.get('code') ?? ''
    if (!host) host = `${u.protocol}//${u.host}`
    if (!code && u.hash) {
      const h = new URLSearchParams(u.hash.replace(/^#/, ''))
      code = h.get('t') ?? h.get('code') ?? ''
    }
    const baseUrl = normalizeBaseUrl(host)
    if (!baseUrl) return null
    return { baseUrl, code }
  } catch {
    return null
  }
}

export async function pair(baseUrl: string, code: string): Promise<Conn> {
  const res = await fetch(`${baseUrl}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, device: deviceName() })
  })
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    token?: string
    error?: string
    deskId?: string
    urls?: string[]
  }
  if (!res.ok || !data.ok || !data.token) {
    throw new Error(data.error === 'bad-code' ? 'badCode' : data.error === 'no-active-code' ? 'noCode' : data.error || `http${res.status}`)
  }
  const conn: Conn = {
    baseUrl,
    token: data.token,
    deviceName: deviceName(),
    pairedAt: Date.now(),
    deskId: data.deskId,
    urls: Array.from(new Set([baseUrl, ...(data.urls ?? [])]))
  }
  await saveConn(conn)
  return conn
}

export class Unauthorized extends Error {}

async function get<T>(conn: Conn, path: string): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    const res = await fetch(`${conn.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${conn.token}` },
      signal: ctrl.signal
    })
    if (res.status === 401) throw new Unauthorized('unauthorized')
    if (!res.ok) throw new Error(`http${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchLibrary(conn: Conn): Promise<Library> {
  const lib = await get<Library & { ok: boolean }>(conn, '/api/library')
  const clean: Library = {
    notebooks: lib.notebooks ?? [],
    notes: lib.notes ?? [],
    transcripts: lib.transcripts ?? [],
    generatedAt: Date.now()
  }
  await local.put(local.K.library, clean)
  await Preferences.set({ key: LIB_KEY, value: JSON.stringify({ generatedAt: clean.generatedAt }) })
  return clean
}

export async function cachedLibrary(): Promise<Library | null> {
  try {
    return await local.get<Library>(local.K.library)
  } catch {
    return null
  }
}

export async function fetchNote(conn: Conn, id: string): Promise<NoteFull> {
  const n = await get<NoteFull & { ok: boolean }>(conn, `/api/note/${encodeURIComponent(id)}`)
  await local.put(local.K.note(id), n)
  return n
}

export async function cachedNote(id: string): Promise<NoteFull | null> {
  try {
    return await local.get<NoteFull>(local.K.note(id))
  } catch {
    return null
  }
}

export async function fetchTranscript(conn: Conn, id: string): Promise<TrFull> {
  const t = await get<TrFull & { ok: boolean }>(conn, `/api/transcript/${encodeURIComponent(id)}`)
  await local.put(local.K.transcript(id), t)
  return t
}

export async function cachedTranscript(id: string): Promise<TrFull | null> {
  try {
    return await local.get<TrFull>(local.K.transcript(id))
  } catch {
    return null
  }
}

/** 探活（用于连接状态指示） */
export async function ping(baseUrl: string, timeoutMs = 4000): Promise<boolean> {
  const info = await pingInfo(baseUrl, timeoutMs)
  return info !== null
}

/** 探活并拿回电脑身份（deskId）与端口；连不上返回 null */
export async function pingInfo(
  baseUrl: string,
  timeoutMs = 4000
): Promise<{ deskId?: string; port?: number; version?: string } | null> {
  try {
    const res = await fetch(`${baseUrl}/api/ping`, { signal: AbortSignal.timeout(timeoutMs) })
    const d = (await res.json()) as { ok?: boolean; app?: string; deskId?: string; port?: number; version?: string }
    if (d.ok !== true || d.app !== 'WhisperNotes') return null
    return { deskId: d.deskId, port: d.port, version: d.version }
  } catch {
    return null
  }
}

/**
 * 找回电脑：先试配对时记下的候选地址，再并发扫一遍本地网段。
 * 为什么能这样：端口是持久的、/api/ping 免鉴权、deskId 能确认"就是我那台电脑"，
 * 所以 IP 变了（DHCP/换 Wi-Fi）也能自己找回来，不用重新扫码配对。
 */
export async function discover(conn: Conn, onPhase?: (p: 'candidates' | 'scan', done: number, total: number) => void): Promise<string | null> {
  const want = conn.deskId
  // 1) 候选地址（配对时电脑给的全集 + 当前地址）
  const cands = Array.from(new Set([conn.baseUrl, ...(conn.urls ?? [])])).filter(Boolean)
  for (const [i, u] of cands.entries()) {
    onPhase?.('candidates', i + 1, cands.length)
    const info = await pingInfo(u, 1500)
    if (info && (!want || !info.deskId || info.deskId === want)) return u
  }
  // 2) 网段扫描：拿候选地址里的 /24 前缀，扫 1..254，端口沿用已知端口
  const ports = new Set<number>()
  const prefixes = new Set<string>()
  for (const u of cands) {
    try {
      const url = new URL(u)
      if (url.port) ports.add(Number(url.port))
      const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(url.hostname)
      if (m) prefixes.add(m[1])
    } catch {
      /* ignore */
    }
  }
  if (!prefixes.size || !ports.size) return null
  const targets: string[] = []
  for (const pre of prefixes) for (const port of ports) for (let h = 1; h <= 254; h++) targets.push(`http://${pre}.${h}:${port}`)
  let done = 0
  const total = targets.length
  const CONCURRENCY = 16
  let found: string | null = null
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (found) return
      const idx = cursor++
      if (idx >= targets.length) return
      const u = targets[idx]
      const info = await pingInfo(u, 450)
      done += 1
      if (done % 16 === 0) onPhase?.('scan', done, total)
      if (info && (!want || info.deskId === want)) {
        found = u
        return
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  onPhase?.('scan', total, total)
  return found
}

/** 用找到的新地址更新连接（保留 token / deskId） */
export async function rebaseConn(conn: Conn, baseUrl: string): Promise<Conn> {
  const next: Conn = { ...conn, baseUrl, urls: Array.from(new Set([baseUrl, ...(conn.urls ?? [])])) }
  await saveConn(next)
  return next
}

// ── 闪卡（阶段 5）────────────────────────────────────────────────
export interface CardRow {
  id: string
  noteId: string | null
  front: string
  back: string
  hint: string | null
  tags: string[]
  dueAt: number | null
  intervalDays: number | null
  ease: number | null
  reps: number
  lapses: number
  suspended: boolean
  /** 所属笔记本（服务端按笔记当前归属解析） */
  notebookId?: string | null
  importance?: number | null
  kind?: string | null
  quote?: string | null
}

export interface CardStatsLite {
  total: number
  due: number
  suspended: number
  reviewedToday: number
  accuracy: number
  streak: number
  aiCount: number
  manualCount: number
}

export interface QueuedReview {
  cardId: string
  grade: number
  at: number
  ms?: number
}

const REVIEWS_KEY = 'wn.reviews'

export async function fetchCards(conn: Conn): Promise<{ cards: CardRow[]; stats: CardStatsLite }> {
  const r = await get<{ ok: boolean; cards: CardRow[]; stats: CardStatsLite }>(conn, '/api/cards?all=1')
  const data = { cards: r.cards ?? [], stats: r.stats }
  await local.put(local.K.cards, data)
  return data
}

export async function cachedCards(): Promise<{ cards: CardRow[]; stats: CardStatsLite } | null> {
  try {
    return await local.get<{ cards: CardRow[]; stats: CardStatsLite }>(local.K.cards)
  } catch {
    return null
  }
}

export async function saveCachedCards(data: { cards: CardRow[]; stats: CardStatsLite }): Promise<void> {
  await local.put(local.K.cards, data)
}

export async function loadQueue(): Promise<QueuedReview[]> {
  try {
    const { value } = await Preferences.get({ key: REVIEWS_KEY })
    return value ? (JSON.parse(value) as QueuedReview[]) : []
  } catch {
    return []
  }
}

export async function saveQueue(items: QueuedReview[]): Promise<void> {
  await Preferences.set({ key: REVIEWS_KEY, value: JSON.stringify(items) })
}

/** 联网时把离线队列回传电脑端（电脑端用同一套 SM-2 落库） */
export async function flushReviews(conn: Conn): Promise<{ flushed: number; remaining: number }> {
  const queue = await loadQueue()
  if (!queue.length) return { flushed: 0, remaining: 0 }
  const res = await fetch(`${conn.baseUrl}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.token}` },
    body: JSON.stringify({ items: queue })
  })
  if (res.status === 401) throw new Unauthorized('unauthorized')
  if (!res.ok) throw new Error(`http${res.status}`)
  const data = (await res.json()) as { ok?: boolean; imported?: number }
  if (!data.ok) throw new Error('flush-failed')
  // 只清掉已提交的这批（期间可能又新增了）
  const rest = (await loadQueue()).filter((r) => !queue.some((q) => q.cardId === r.cardId && q.at === r.at))
  await saveQueue(rest)
  return { flushed: queue.length, remaining: rest.length }
}

// ── 全量离线下载（阶段：离线可用）────────────────────────────────
export interface SyncProgress {
  phase: 'library' | 'notes' | 'transcripts' | 'cards' | 'done'
  done: number
  total: number
  title?: string
}

export interface SyncState {
  at: number
  notes: number
  transcripts: number
  cards: number
  /** 本地已存的正文数量（用于判断是否完整） */
  localNotes: number
  localTranscripts: number
}

export async function syncState(): Promise<SyncState | null> {
  try {
    return await local.get<SyncState>(local.K.syncState)
  } catch {
    return null
  }
}

export async function localCounts(): Promise<{ notes: number; transcripts: number }> {
  const [n, t] = await Promise.all([local.keysWithPrefix('note/'), local.keysWithPrefix('tr/')])
  return { notes: n.length, transcripts: t.length }
}

/**
 * 把电脑上的内容整份下载到手机：文库元数据 → 每篇笔记正文 → 每条转写正文 → 卡片。
 * 已下载且 updatedAt/时间没变的会跳过，所以重复同步很快。
 */
export async function syncAll(
  conn: Conn,
  onProgress?: (p: SyncProgress) => void,
  opts?: { includeCards?: boolean }
): Promise<SyncState> {
  // 顺序很重要：先读旧索引（上一次同步的状态），再拉新索引（fetchLibrary 会覆盖本地索引）
  const prev = await local.get<Library>(local.K.library)
  const lib = await fetchLibrary(conn)
  const prevNotes = new Map((prev?.notes ?? []).map((n) => [n.id, n.updatedAt]))

  // 1) 笔记正文
  let done = 0
  const noteTotal = lib.notes.length
  onProgress?.({ phase: 'notes', done, total: noteTotal })
  for (const meta of lib.notes) {
    const cached = await local.get<NoteFull>(local.K.note(meta.id))
    const unchanged = cached && prevNotes.get(meta.id) === meta.updatedAt && cached.updatedAt === meta.updatedAt
    if (!unchanged) {
      try {
        const full = await get<NoteFull & { ok: boolean }>(conn, `/api/note/${encodeURIComponent(meta.id)}`)
        await local.put(local.K.note(meta.id), full)
      } catch {
        /* 单篇失败不中断整份同步，下次补齐 */
      }
    }
    done += 1
    onProgress?.({ phase: 'notes', done, total: noteTotal, title: meta.title })
  }

  // 2) 转写正文：按 updatedAt 增量（以前只看"有没有缓存"，导致增强版/状态变化永远同步不过来）
  done = 0
  const trTotal = lib.transcripts.length
  const prevTrs = new Map((prev?.transcripts ?? []).map((t) => [t.id, t.updatedAt ?? t.createdAt]))
  onProgress?.({ phase: 'transcripts', done, total: trTotal })
  const trDebug: Array<{ id: string; wantAt: number; haveAt: number; fetched: boolean }> = []
  for (const meta of lib.transcripts) {
    const cached = await local.get<TrFull & { updatedAt?: number }>(local.K.transcript(meta.id))
    const wantAt = meta.updatedAt ?? meta.createdAt
    const haveAt = cached ? (cached.updatedAt ?? prevTrs.get(meta.id) ?? 0) : 0
    let fetched = false
    const missingEnhanced = !!meta.hasEnhanced && !cached?.enhanced
    if (!cached || wantAt > haveAt || missingEnhanced) {
      try {
        const full = await get<TrFull & { ok: boolean; updatedAt?: number }>(conn, `/api/transcript/${encodeURIComponent(meta.id)}`)
        await local.put(local.K.transcript(meta.id), { ...full, updatedAt: full.updatedAt ?? wantAt })
        fetched = true
      } catch {
        /* 单条失败不中断，下次补齐 */
      }
    }
    trDebug.push({ id: meta.id, wantAt, haveAt, fetched })
    done += 1
    onProgress?.({ phase: 'transcripts', done, total: trTotal, title: meta.title })
  }

  // 调试留痕（自动化测试读它，排查"为什么没更新"）
  ;(globalThis as unknown as { __syncDebug?: unknown }).__syncDebug = { transcripts: trDebug }

  // 2.5) 清理：电脑上已经删掉的笔记/转写，手机本地也删掉（否则会一直显示旧条目）
  try {
    const liveNotes = new Set(lib.notes.map((n) => local.K.note(n.id)))
    const liveTrs = new Set(lib.transcripts.map((t) => local.K.transcript(t.id)))
    for (const k of await local.keysWithPrefix('note/')) if (!liveNotes.has(k)) await local.del(k)
    for (const k of await local.keysWithPrefix('tr/')) if (!liveTrs.has(k)) await local.del(k)
  } catch {
    /* 清理失败不影响同步本身 */
  }

  // 3) 卡片
  let cards = 0
  if (opts?.includeCards !== false) {
    onProgress?.({ phase: 'cards', done: 0, total: 1 })
    try {
      const r = await fetchCards(conn)
      cards = r.cards.length
    } catch {
      /* 离线/失败时保留旧缓存 */
    }
    onProgress?.({ phase: 'cards', done: 1, total: 1 })
  } else {
    const c = await cachedCards()
    cards = c?.cards.length ?? 0
  }

  const counts = await localCounts()
  const state: SyncState = {
    at: Date.now(),
    notes: lib.notes.length,
    transcripts: lib.transcripts.length,
    cards,
    localNotes: counts.notes,
    localTranscripts: counts.transcripts
  }
  await local.put(local.K.syncState, state)
  onProgress?.({ phase: 'done', done: 1, total: 1 })
  return state
}

/** 断开连接时清掉本地内容（避免残留别人数据/占空间） */
export async function wipeLocal(): Promise<void> {
  await local.clearAll()
}
