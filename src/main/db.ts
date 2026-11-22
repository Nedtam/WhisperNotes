// SQLite 笔记库（better-sqlite3）：笔记 + 笔记本（文件夹式归类）
import Database from 'better-sqlite3'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { i18nCode, tm } from './i18n'
import { normalizeNotation, normalizeHighlights, normalizeBreaks } from '../shared/notation'
import { schedule, SRS_DEFAULT } from '../shared/srs'
import type {
  Card,
  CardStats,
  NoteConvertStatus,
  NoteDraft,
  NoteRecord,
  Notebook,
  SearchHit,
  TranscriptionDraft,
  TranscriptionRecord,
  TranscriptionSummary
} from '@shared/types'

let db: Database.Database | null = null
let dbDir = ''

/** 在线备份（WAL 安全），返回备份文件路径；失败返回 null */
export async function backupDb(): Promise<string | null> {
  if (!db || !dbDir) return null
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const target = path.join(dbDir, `library.db.bak-${stamp}`)
    await db.backup(target)
    return target
  } catch {
    return null
  }
}

export function openDb(dir: string): Database.Database {
  if (db) return db
  dbDir = dir
  db = new Database(path.join(dir, 'library.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'lecture',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      template_id TEXT NOT NULL DEFAULT 'study',
      source_text TEXT,
      note_md TEXT,
      recording_path TEXT,
      meta TEXT
    );
    CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transcriptions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'import',
      title TEXT NOT NULL DEFAULT '',
      source_name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      language TEXT,
      raw_text TEXT NOT NULL DEFAULT '',
      enhanced_text TEXT
    );
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      note_id TEXT,
      notebook_id TEXT,
      front TEXT NOT NULL DEFAULT '',
      back TEXT NOT NULL DEFAULT '',
      hint TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'ai',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      due_at INTEGER,
      interval_days REAL,
      ease REAL,
      reps INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0,
      last_review_at INTEGER,
      suspended INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS card_reviews (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      grade INTEGER NOT NULL,
      ms INTEGER,
      source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transcriptions_created ON transcriptions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cards_note ON cards(note_id);
    CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due_at);
    CREATE INDEX IF NOT EXISTS idx_reviews_at ON card_reviews(at DESC);
    -- 整理进度缓存：每段（分块）整理成功后立刻落盘。
    -- 作用：AI 整理失败/中断后，点「继续转成笔记」只重做失败的那几段，不再整篇重来（省额度）。
    CREATE TABLE IF NOT EXISTS org_parts (
      doc_hash TEXT NOT NULL,
      part_hash TEXT NOT NULL,
      fp TEXT NOT NULL,
      md TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (doc_hash, part_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_org_parts_doc ON org_parts(doc_hash);
  `)
  // 迁移：转写记录的"最后修改时间"（手机端同步靠它判断"这条变了没有"）
  try {
    const cols = db.prepare('PRAGMA table_info(transcriptions)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'updated_at')) {
      db.exec('ALTER TABLE transcriptions ADD COLUMN updated_at INTEGER')
      db.exec('UPDATE transcriptions SET updated_at = created_at WHERE updated_at IS NULL')
    }
  } catch {
    /* ignore */
  }

  // 迁移：转写记录 → 笔记 的转换状态（未完成的笔记不进笔记库，在转写页继续）
  for (const [col, ddl] of [
    ['note_status', "ALTER TABLE transcriptions ADD COLUMN note_status TEXT NOT NULL DEFAULT 'none'"],
    ['note_error', 'ALTER TABLE transcriptions ADD COLUMN note_error TEXT'],
    ['note_id', 'ALTER TABLE transcriptions ADD COLUMN note_id TEXT']
  ] as Array<[string, string]>) {
    try {
      const cols = db.prepare('PRAGMA table_info(transcriptions)').all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === col)) db.exec(ddl)
    } catch {
      /* ignore */
    }
  }
  // 迁移：闪卡的质量字段（重要度/类型/原文依据）
  for (const [col, ddl] of [
    ['importance', 'ALTER TABLE cards ADD COLUMN importance INTEGER'],
    ['kind', 'ALTER TABLE cards ADD COLUMN kind TEXT'],
    ['quote', 'ALTER TABLE cards ADD COLUMN quote TEXT'],
    ['reviewed_at', 'ALTER TABLE cards ADD COLUMN reviewed_at INTEGER']
  ] as Array<[string, string]>) {
    try {
      const cols = db.prepare('PRAGMA table_info(cards)').all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === col)) db.exec(ddl)
    } catch {
      /* 表还不存在时忽略（下面会建） */
    }
  }
  // 迁移：tags 列 + notebook_id 列 + 索引
  const cols = db.prepare(`PRAGMA table_info(notes)`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'tags')) {
    db.exec(`ALTER TABLE notes ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`)
  }
  if (!cols.some((c) => c.name === 'notebook_id')) {
    db.exec(`ALTER TABLE notes ADD COLUMN notebook_id TEXT`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_notebook ON notes(notebook_id)`)
  }
  if (!cols.some((c) => c.name === 'ord')) {
    // 手动排序列：新笔记默认排最前（-created_at 升序）
    db.exec(`ALTER TABLE notes ADD COLUMN ord REAL`)
    db.exec(`UPDATE notes SET ord = -created_at WHERE ord IS NULL`)
  }
  // 笔记本颜色列迁移
  const nbCols = db.prepare(`PRAGMA table_info(notebooks)`).all() as Array<{ name: string }>
  if (!nbCols.some((c) => c.name === 'color')) {
    db.exec(`ALTER TABLE notebooks ADD COLUMN color TEXT NOT NULL DEFAULT ''`)
  }
  // 子笔记本 / 排序 / 隐藏 迁移
  if (!nbCols.some((c) => c.name === 'parent_id')) {
    db.exec(`ALTER TABLE notebooks ADD COLUMN parent_id TEXT`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_notebooks_parent ON notebooks(parent_id)`)
  }
  if (!nbCols.some((c) => c.name === 'ord')) {
    db.exec(`ALTER TABLE notebooks ADD COLUMN ord REAL`)
    db.exec(`UPDATE notebooks SET ord = -created_at WHERE ord IS NULL`)
  }
  if (!nbCols.some((c) => c.name === 'hidden')) {
    db.exec(`ALTER TABLE notebooks ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`)
  }
  return db
}

function getDb(): Database.Database {
  if (!db) throw new Error('db not open')
  return db
}

function parseTags(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(v) ? v.map((t) => String(t)).filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * 文本列一律强制成字符串：SQLite 允许同一列混存 TEXT/BLOB（例如用 readfile() 写入会变成 BLOB），
 * 而渲染层会对 noteMd 调 .replace()/split()，拿到 Buffer 会直接崩掉整个笔记视图。
 */
function asText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  if (Buffer.isBuffer(v)) return v.toString('utf-8')
  if (v instanceof Uint8Array) return Buffer.from(v).toString('utf-8')
  return String(v)
}

function rowToNote(r: Record<string, unknown>): NoteRecord {
  return {
    id: asText(r.id),
    title: asText(r.title),
    kind: asText(r.kind),
    notebookId: (r.notebook_id as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    durationMs: r.duration_ms as number,
    templateId: asText(r.template_id),
    sourceText: asText(r.source_text),
    noteMd: asText(r.note_md),
    recordingPath: r.recording_path == null ? undefined : asText(r.recording_path),
    meta: r.meta == null ? undefined : asText(r.meta),
    tags: parseTags(r.tags),
    ord: r.ord == null ? undefined : Number(r.ord)
  }
}

const NOTE_COLS = `id,title,kind,notebook_id,created_at,updated_at,duration_ms,template_id,source_text,note_md,recording_path,meta,tags,ord`

export function listNotes(): NoteRecord[] {
  const rows = getDb()
    .prepare(`SELECT ${NOTE_COLS} FROM notes ORDER BY ord ASC, created_at DESC`)
    .all() as Record<string, unknown>[]
  return rows.map(rowToNote)
}

export function getNote(id: string): NoteRecord | null {
  const r = getDb().prepare(`SELECT ${NOTE_COLS} FROM notes WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  return r ? rowToNote(r) : null
}

export function saveNote(draft: NoteDraft): NoteRecord {
  const now = Date.now()
  const id = draft.id ?? randomUUID()
  const existing = draft.id ? getNote(draft.id) : null
  // 入库前统一：① LaTeX 写法/HTML 实体/不可见字符 → 真正的符号（\rightarrow → →）
  //            ② 旧式荧光 ==文字== → <mark class="hl-yellow">（代码段/代码式比较不受影响）
  const draftSafe: NoteDraft = {
    ...draft,
    title: draft.title ? normalizeNotation(draft.title) : draft.title,
    noteMd: typeof draft.noteMd === 'string' ? normalizeBreaks(normalizeHighlights(normalizeNotation(draft.noteMd))) : draft.noteMd
  }
  draft = draftSafe
  const tagsJson = JSON.stringify(Array.isArray(draft.tags) ? draft.tags.filter(Boolean) : [])
  const notebookId = draft.notebookId ?? existing?.notebookId ?? null
  const record: NoteRecord = {
    id,
    title: draft.title || tm('note.untitled'),
    // 未显式指定时沿用原笔记的类型（重新整理文档笔记不该把它降级成 lecture）
    kind: draft.kind ?? (existing?.kind === 'doc' ? 'doc' : 'lecture'),
    notebookId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    durationMs: draft.durationMs ?? 0,
    templateId: draft.templateId || 'study',
    sourceText: draft.sourceText ?? '',
    noteMd: draft.noteMd ?? '',
    recordingPath: draft.recordingPath,
    meta: undefined,
    tags: JSON.parse(tagsJson)
  }
  const ordRow = draft.id
    ? (getDb().prepare('SELECT ord FROM notes WHERE id = ?').get(id) as { ord: number | null } | undefined)
    : undefined
  const ord = existing
    ? (ordRow?.ord ?? null)
    : ((getDb().prepare('SELECT COALESCE(MIN(ord), 0) - 1 AS m FROM notes').get() as { m: number }).m ?? -1)
  getDb()
    .prepare(
      `INSERT INTO notes (id,title,kind,created_at,updated_at,duration_ms,template_id,source_text,note_md,recording_path,meta,tags,notebook_id,ord)
       VALUES (@id,@title,@kind,@createdAt,@updatedAt,@durationMs,@templateId,@sourceText,@noteMd,@recordingPath,@meta,@tags,@notebookId,@ord)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, updated_at=excluded.updated_at, duration_ms=excluded.duration_ms,
         template_id=excluded.template_id, notebook_id=excluded.notebook_id,
         source_text=excluded.source_text,
         note_md=excluded.note_md, recording_path=excluded.recording_path, meta=excluded.meta,
         tags=excluded.tags`
    )
    .run({ ...record, tags: tagsJson, ord })
  return record
}

/** 按给定 id 顺序重写手动排序（前端拖拽换位后调用） */
export function reorderNotes(orderedIds: string[]): boolean {
  const db = getDb()
  const tx = db.transaction((ids: string[]) => {
    ids.forEach((nid, idx) => {
      db.prepare('UPDATE notes SET ord = ? WHERE id = ?').run(idx, nid)
    })
  })
  if (!Array.isArray(orderedIds) || !orderedIds.length) return false
  tx(orderedIds.filter(Boolean))
  return true
}

export function setNoteNotebook(id: string, notebookId: string | null): boolean {
  if (notebookId) {
    const nb = getDb().prepare('SELECT id FROM notebooks WHERE id = ?').get(notebookId)
    if (!nb) return false
  }
  const res = getDb().prepare('UPDATE notes SET notebook_id = ?, updated_at = ? WHERE id = ?').run(notebookId, Date.now(), id)
  return res.changes > 0
}

export function deleteNote(id: string): boolean {
  const res = getDb().prepare('DELETE FROM notes WHERE id = ?').run(id)
  return res.changes > 0
}

export function searchNotes(q: string): SearchHit[] {
  const needle = `%${q}%`
  const rows = getDb()
    .prepare(
      `SELECT ${NOTE_COLS} FROM notes
       WHERE title LIKE ? OR note_md LIKE ? OR source_text LIKE ? OR tags LIKE ?
       ORDER BY updated_at DESC LIMIT 50`
    )
    .all(needle, needle, needle, needle) as Record<string, unknown>[]
  return rows.map((r) => {
    const n = rowToNote(r)
    const hay = `${n.title}\n\n${n.noteMd}\n\n${n.sourceText}`
    const idx = hay.toLowerCase().indexOf(q.toLowerCase())
    let snippet = ''
    if (idx >= 0) {
      const start = Math.max(0, idx - 60)
      const end = Math.min(hay.length, idx + q.length + 140)
      snippet = (start > 0 ? '…' : '') + hay.slice(start, end).replace(/\s+/g, ' ').trim() + (end < hay.length ? '…' : '')
    }
    return { id: n.id, title: n.title, updatedAt: n.updatedAt, durationMs: n.durationMs, tags: n.tags, snippet }
  })
}

// ── 笔记本（文件夹） ────────────────────────────────────────────
const NB_PALETTE = [
  '#f87171', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa', '#f472b6',
  '#2dd4bf', '#fb923c', '#a3e635', '#38bdf8', '#e879f9', '#facc15'
]

function nbRow(r: Record<string, unknown>): Notebook {
  return {
    id: r.id as string,
    name: r.name as string,
    createdAt: r.created_at as number,
    color: (r.color as string | null | undefined) || '',
    parentId: (r.parent_id as string | null) ?? null,
    ord: (r.ord as number | null) ?? undefined,
    hidden: Number(r.hidden ?? 0) === 1
  }
}

export function listNotebooks(): Notebook[] {
  const rows = getDb()
    .prepare(`SELECT id,name,color,created_at,parent_id,ord,hidden FROM notebooks ORDER BY COALESCE(ord, 0) ASC, created_at ASC`)
    .all() as Record<string, unknown>[]
  return rows.map(nbRow)
}

export function createNotebook(name: string, parentId: string | null = null): Notebook {
  const clean = name.trim()
  if (!clean) throw new Error(i18nCode('err.nbNameRequired'))
  if (parentId) {
    const p = getDb().prepare('SELECT id FROM notebooks WHERE id = ?').get(parentId)
    if (!p) throw new Error(i18nCode('err.nbParentMissing'))
  }
  const count = (getDb().prepare('SELECT COUNT(*) AS c FROM notebooks').get() as { c: number }).c
  const minOrd = (getDb()
    .prepare(`SELECT COALESCE(MIN(ord), 0) AS m FROM notebooks WHERE ${parentId ? 'parent_id = @p' : 'parent_id IS NULL'}`)
    .get(parentId ? { p: parentId } : {}) as { m: number }).m
  const nb: Notebook = {
    id: randomUUID(),
    name: clean,
    color: NB_PALETTE[count % NB_PALETTE.length],
    createdAt: Date.now(),
    parentId: parentId ?? null,
    ord: (minOrd ?? 0) - 1,
    hidden: false
  }
  getDb()
    .prepare(`INSERT INTO notebooks (id,name,color,created_at,parent_id,ord,hidden) VALUES (?,?,?,?,?,?,0)`)
    .run(nb.id, nb.name, nb.color, nb.createdAt, nb.parentId ?? null, nb.ord ?? 0)
  return nb
}

export function renameNotebook(id: string, name: string): boolean {
  const clean = name.trim()
  if (!clean) return false
  const res = getDb().prepare('UPDATE notebooks SET name = ? WHERE id = ?').run(clean, id)
  return res.changes > 0
}

export function setNotebookHidden(id: string, hidden: boolean): boolean {
  const res = getDb().prepare('UPDATE notebooks SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id)
  return res.changes > 0
}

/** 批量更新笔记本的父级与排序（拖拽用）；禁止把笔记本拖进自己的子孙里 */
export function reorderNotebooks(updates: Array<{ id: string; parentId: string | null; ord: number }>): boolean {
  const db = getDb()
  const all = listNotebooks()
  const byId = new Map(all.map((n) => [n.id, n]))
  const isDescendant = (candidate: string, ancestor: string): boolean => {
    let cur = byId.get(candidate)
    const seen = new Set<string>()
    while (cur && cur.parentId) {
      if (cur.parentId === ancestor) return true
      if (seen.has(cur.parentId)) break
      seen.add(cur.parentId)
      cur = byId.get(cur.parentId)
    }
    return false
  }
  for (const u of updates) {
    if (u.parentId && (u.parentId === u.id || isDescendant(u.parentId, u.id))) return false
  }
  const tx = db.transaction((rows: typeof updates) => {
    const stmt = db.prepare('UPDATE notebooks SET parent_id = ?, ord = ? WHERE id = ?')
    for (const u of rows) stmt.run(u.parentId ?? null, u.ord, u.id)
  })
  tx(updates.filter((u) => byId.has(u.id)))
  return true
}

/** 返回该笔记本及其所有子孙 id（用于整棵删除/计数） */
export function notebookSubtreeIds(id: string): string[] {
  const all = listNotebooks()
  const out: string[] = [id]
  let changed = true
  while (changed) {
    changed = false
    for (const n of all) {
      if (n.parentId && out.includes(n.parentId) && !out.includes(n.id)) {
        out.push(n.id)
        changed = true
      }
    }
  }
  return out
}

export function deleteNotebook(id: string): boolean {
  const ids = notebookSubtreeIds(id)
  if (!ids.length) return false
  const db = getDb()
  const ph = ids.map(() => '?').join(',')
  const tx = db.transaction(() => {
    // 笔记本删除，其中的笔记（含子笔记本里的）移回「未归档」，不删内容
    db.prepare(`UPDATE notes SET notebook_id = NULL WHERE notebook_id IN (${ph})`).run(...ids)
    db.prepare(`DELETE FROM notebooks WHERE id IN (${ph})`).run(...ids)
  })
  tx()
  return true
}

// ── 转写记录库 ──────────────────────────────────────────────
const TR_COLS = `id,source,title,source_name,created_at,duration_ms,language,raw_text,enhanced_text,note_status,note_error,note_id`

function trRow(r: Record<string, unknown>): TranscriptionRecord {
  return {
    id: r.id as string,
    source: (r.source as TranscriptionRecord['source']) ?? 'import',
    title: (r.title as string) || '',
    sourceName: (r.source_name as string) || '',
    createdAt: r.created_at as number,
    durationMs: (r.duration_ms as number) || 0,
    language: (r.language as string | null) ?? undefined,
    rawText: (r.raw_text as string) || '',
    enhancedText: (r.enhanced_text as string | null) ?? null,
    updatedAt: (r.updated_at as number | null) ?? (r.created_at as number),
    noteStatus: ((r.note_status as string) || 'none') as NoteConvertStatus,
    noteError: (r.note_error as string | null) ?? undefined,
    noteId: (r.note_id as string | null) ?? undefined
  }
}

/** 默认标题：源文件名去扩展名 → “录音 MM-DD HH:mm” */
function fallbackTitle(d: TranscriptionDraft, createdAt: number): string {
  if (d.title?.trim()) return d.title.trim()
  if (d.sourceName?.trim()) {
    const base = d.sourceName.replace(/\.[a-z0-9]{2,5}$/i, '').trim()
    if (base) return base
  }
  const dt = new Date(createdAt)
  const p = (n: number): string => String(n).padStart(2, '0')
  return tm('note.recordingTitle', { md: p(dt.getMonth() + 1), dd: p(dt.getDate()), hh: p(dt.getHours()), mm: p(dt.getMinutes()) })
}

/** 标记某条转写的"转笔记"状态（未完成时记下原因，供转写页显示与继续） */
export function setTranscriptionNote(
  id: string,
  status: 'none' | 'ok' | 'incomplete',
  error?: string | null,
  noteId?: string | null
): boolean {
  try {
    const r = getDb()
      .prepare('UPDATE transcriptions SET note_status = ?, note_error = ?, note_id = ?, updated_at = ? WHERE id = ?')
      .run(status, error ?? null, noteId ?? null, Date.now(), id)
    return r.changes > 0
  } catch {
    return false
  }
}

/** ── 整理进度缓存（断点续做）──────────────────────────────
 *  · doc_hash  = 转写正文的哈希（同一篇转写 → 同一组缓存）
 *  · part_hash = 该段文本的哈希（分块大小改了也能复用相同的段落）
 *  · fp        = 组织参数指纹（模型/模板/长度/语言/课件），参数变了就不复用
 */
export interface OrgPartRow {
  partHash: string
  md: string
  status: 'ok' | 'raw' | 'fail'
}

export function getOrgParts(docHash: string, fp: string): Map<string, OrgPartRow> {
  const out = new Map<string, OrgPartRow>()
  try {
    const rows = getDb()
      .prepare('SELECT part_hash, md, status FROM org_parts WHERE doc_hash = ? AND fp = ?')
      .all(docHash, fp) as Array<{ part_hash: string; md: string; status: string }>
    for (const r of rows) {
      const st = r.status === 'raw' ? 'raw' : r.status === 'fail' ? 'fail' : 'ok'
      out.set(r.part_hash, { partHash: r.part_hash, md: asText(r.md), status: st })
    }
  } catch {
    /* 缓存读失败不影响整理 */
  }
  return out
}

export function putOrgPart(docHash: string, partHash: string, fp: string, md: string, status: 'ok' | 'raw' | 'fail'): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO org_parts (doc_hash, part_hash, fp, md, status, created_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(doc_hash, part_hash) DO UPDATE SET md=excluded.md, status=excluded.status, fp=excluded.fp, created_at=excluded.created_at`
      )
      .run(docHash, partHash, fp, md, status, Date.now())
  } catch {
    /* ignore */
  }
}

/** 只保留最近 keepDocs 篇转写的缓存，其余清掉（避免库无限膨胀） */
export function pruneOrgParts(keepDocs = 30): number {
  try {
    const keep = getDb()
      .prepare('SELECT doc_hash, MAX(created_at) AS t FROM org_parts GROUP BY doc_hash ORDER BY t DESC LIMIT ?')
      .all(keepDocs) as Array<{ doc_hash: string }>
    if (!keep.length) return 0
    const ids = keep.map((k) => k.doc_hash)
    const ph = ids.map(() => '?').join(',')
    const r = getDb().prepare(`DELETE FROM org_parts WHERE doc_hash NOT IN (${ph})`).run(...ids)
    return r.changes
  } catch {
    return 0
  }
}

/** 清掉某篇转写的整理缓存（用户要求"彻底重转"时用） */
export function clearOrgParts(docHash: string): number {
  try {
    return getDb().prepare('DELETE FROM org_parts WHERE doc_hash = ?').run(docHash).changes
  } catch {
    return 0
  }
}

export function listTranscriptions(): TranscriptionSummary[] {
  const rows = getDb()
    .prepare(`SELECT ${TR_COLS} FROM transcriptions ORDER BY created_at DESC`)
    .all() as Record<string, unknown>[]
  return rows.map((r) => {
    const raw = (r.raw_text as string) || ''
    const en = (r.enhanced_text as string | null) ?? null
    const src = (r.source_name as string) || ''
    return {
      id: r.id as string,
      source: (r.source as TranscriptionRecord['source']) ?? 'import',
      title: (r.title as string) || src,
      sourceName: src,
      createdAt: r.created_at as number,
      durationMs: (r.duration_ms as number) || 0,
      rawLen: raw.length,
      updatedAt: (r.updated_at as number | null) ?? (r.created_at as number),
      hasEnhanced: !!en && en.length > 0,
      noteStatus: ((r.note_status as string) || 'none') as 'none' | 'ok' | 'incomplete',
      noteError: (r.note_error as string | null) ?? undefined,
      noteId: (r.note_id as string | null) ?? undefined,
      preview: (raw || en || '').replace(/\s+/g, ' ').trim().slice(0, 220)
    }
  })
}

export function getTranscription(id: string): TranscriptionRecord | null {
  const r = getDb().prepare(`SELECT ${TR_COLS} FROM transcriptions WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  return r ? trRow(r) : null
}

export function saveTranscription(draft: TranscriptionDraft): TranscriptionRecord {
  const db = getDb()
  const createdAt = draft.id
    ? ((db.prepare('SELECT created_at FROM transcriptions WHERE id = ?').get(draft.id) as { created_at: number } | undefined)?.created_at ?? Date.now())
    : Date.now()
  const existing = draft.id ? getTranscription(draft.id) : null
  const source = draft.source ?? existing?.source ?? 'import'
  const sourceName = draft.sourceName?.trim() || existing?.sourceName || ''
  const title = fallbackTitle(draft, createdAt)
  const rawText =
    draft.rawText !== undefined && draft.rawText !== null
      ? draft.rawText
      : existing?.rawText ?? ''
  const enhancedRaw = draft.keepEnhanced
    ? (existing?.enhancedText ?? null)
    : draft.enhancedText !== undefined && draft.enhancedText !== null
      ? draft.enhancedText
      : (existing?.enhancedText ?? null)
  // AI 增强版同样还原符号；raw_text 保持原样（原文不动）
  const enhancedText = enhancedRaw === null ? null : normalizeNotation(enhancedRaw)
  const language = draft.language ?? existing?.language ?? null
  const durationMs = draft.durationMs ?? existing?.durationMs ?? 0
  const id = draft.id ?? randomUUID()
  db.prepare(
    `INSERT INTO transcriptions (id,source,title,source_name,created_at,duration_ms,language,raw_text,enhanced_text,updated_at)
     VALUES (@id,@source,@title,@sourceName,@createdAt,@durationMs,@language,@rawText,@enhancedText,@updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       source=excluded.source, title=excluded.title, source_name=excluded.source_name,
       duration_ms=excluded.duration_ms, language=excluded.language,
       raw_text=excluded.raw_text, enhanced_text=excluded.enhanced_text, updated_at=excluded.updated_at`
  ).run({ id, source, title, sourceName, createdAt, durationMs, language, rawText, enhancedText, updatedAt: Date.now() })
  return {
    id,
    source,
    title,
    sourceName,
    createdAt,
    durationMs,
    language: language ?? undefined,
    rawText,
    enhancedText,
    updatedAt: Date.now()
  }
}

export function deleteTranscription(id: string): boolean {
  const res = getDb().prepare('DELETE FROM transcriptions WHERE id = ?').run(id)
  return res.changes > 0
}

// ── 使用指南（中英各一份；无需切换界面语言即可对照阅读）──────────
const GUIDE_ZH_MD = `# 👋 欢迎使用 WhisperNotes

一份课堂录音转写 + AI 笔记的小工具。所有转写都在本机运行（whisper），只有「AI 整理/润色」会联网调用你配置的模型。

## 三步上手
1. **录音转写**：在「录音转写」页点 ● 开始说话；每句说完会自动定稿，右侧可随时修改。
2. **整理成笔记**：停止后点「整理成笔记」（或录音前拖入 PDF/PPT 让 AI 校准术语）。笔记会出现在「笔记库」，可直接编辑保存。
3. **历史转写**：每次录音/导入都会自动存到「转写记录」，可随时重新整理，无需再转写一次。

## 提示
- 可导入已有的 m4a/mp3/wav 录音并本地转写（支持暂停/继续/停止，长录音也能跑）。
- 关键词、术语建议先填在左侧「本课提示词」，识别更准。
- API Key 在「设置 → LLM」里填（本地加密保存）；没有 Key 也能录音转写，只是不能用 AI 整理。
- 打开「保存原始录音」后，可在「设置 → 存储位置」里选择存放的文件夹（默认在应用数据目录）。`

const GUIDE_EN_MD = `# 👋 Welcome to WhisperNotes

**Live classroom transcription + AI note organizing.** The local whisper engine turns the lecturer's speech into text in real time, then AI (OpenRouter) organizes it into structured notes — everything is saved locally on your computer.

## 🚀 Quick start

1. **Prepare the environment on the Settings page**
   - Make sure the "ASR engine" shows ==Ready== (if not, run \`brew install whisper-cpp\`, then return to Settings — it re-detects automatically)
   - In "Transcription models", ==download== a model and click "Use" (default: large-v3-turbo-q5_0; switch to base.en / small.en if you want it faster)
   - Enter your OpenRouter API Key and click "Validate" (optional: without a key you can still record & transcribe — only AI organizing is disabled)
   - Optional: confirm your device under "Microphone / audio input"

2. **Go to the Recording tab and press the red round button to start**
   - Speech becomes sentences automatically; the text box on the right lets you ==edit while listening== without interrupting the transcription
   - While recording, press the button again to **pause / resume**; tap "End recording" when you are truly done

3. **Organize into a note**
   - If you stop with slides attached (PDF/PPTX — just drag them into the window), it asks whether to "Polish transcript" first
   - It then auto-generates a note from your finalized text and jumps to the Notes library, where you can edit, save, and export immediately

## 📚 Notes library

- **Double-click** any note title → opens a separate editing window with **live two-way sync**
- **Folder-style notebooks**: next to "All notes / Unsorted" at the top you can create notebooks, then use the 📁 at the end of a row to file notes into them
- Supports tags, full-text search, and Markdown export

## ✍️ Editor tips

- Typing \`# heading\`, \`- list\`, \`1. list\`, \`- [ ] task\`, \`==highlight==\` becomes formatted live
- Shortcuts: \`⌘B\` bold · \`⌘I\` italic · \`⌘Z\` undo · \`Tab\` indent
- The colour squares on the toolbar let you ==highlight== instantly

## 🔒 Privacy & data

- Transcription runs fully **locally and offline**; notes and settings exist only on this machine
- The API Key is stored only in the local config file — it is never uploaded
- Data folder (macOS): \`~/Library/Application Support/WhisperNotes/\`

Happy studying! 🎓
`

export function ensureGuideNotes(): void {
  const existing = listNotes()
  const hasZh = existing.some((n) => n.title.includes('使用指南'))
  const hasEn = existing.some((n) => n.title.includes('Welcome to WhisperNotes'))
  if (!hasZh) {
    saveNote({ title: '👋 欢迎使用 WhisperNotes · 使用指南', sourceText: '', noteMd: GUIDE_ZH_MD, templateId: 'study', tags: [] })
  }
  if (!hasEn) {
    saveNote({ title: '👋 Welcome to WhisperNotes · Getting Started', sourceText: '', noteMd: GUIDE_EN_MD, templateId: 'study', tags: [] })
  }
}

// ── 闪卡：CRUD + 间隔重复（SM-2）────────────────────────────────
function rowToCard(r: Record<string, unknown>): Card {
  return {
    id: asText(r.id),
    noteId: r.note_id == null ? null : asText(r.note_id),
    notebookId: r.notebook_id == null ? null : asText(r.notebook_id),
    front: asText(r.front),
    back: asText(r.back),
    hint: r.hint == null ? undefined : asText(r.hint),
    tags: parseTags(r.tags),
    source: asText(r.source) || 'ai',
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    dueAt: r.due_at == null ? undefined : Number(r.due_at),
    intervalDays: r.interval_days == null ? undefined : Number(r.interval_days),
    ease: r.ease == null ? undefined : Number(r.ease),
    reps: Number(r.reps ?? 0),
    lapses: Number(r.lapses ?? 0),
    lastReviewAt: r.last_review_at == null ? undefined : Number(r.last_review_at),
    suspended: Number(r.suspended ?? 0) === 1,
    importance: r.importance == null ? undefined : Number(r.importance),
    kind: r.kind == null ? undefined : asText(r.kind),
    quote: r.quote == null ? undefined : asText(r.quote)
  }
}

const CARD_COLS = `id,note_id,notebook_id,front,back,hint,tags,source,created_at,updated_at,due_at,interval_days,ease,reps,lapses,last_review_at,suspended,deleted,importance,kind,quote`

export function listCards(filter?: {
  noteId?: string
  notebookId?: string
  due?: boolean
  includeSuspended?: boolean
}): Card[] {
  const where: string[] = ['deleted = 0']
  const params: unknown[] = []
  if (filter?.noteId) {
    where.push('note_id = ?')
    params.push(filter.noteId)
  }
  if (filter?.notebookId) {
    where.push('notebook_id = ?')
    params.push(filter.notebookId)
  }
  if (!filter?.includeSuspended) where.push('suspended = 0')
  if (filter?.due) where.push('(due_at IS NULL OR due_at <= ?)')
  if (filter?.due) params.push(Date.now())
  const rows = getDb()
    .prepare(`SELECT ${CARD_COLS} FROM cards WHERE ${where.join(' AND ')} ORDER BY created_at ASC`)
    .all(...params) as Record<string, unknown>[]
  return rows.map(rowToCard)
}

export function countCardsForNote(noteId: string): number {
  const r = getDb().prepare('SELECT COUNT(*) AS n FROM cards WHERE note_id = ? AND deleted = 0').get(noteId) as { n: number }
  return r?.n ?? 0
}

export function getCard(id: string): Card | null {
  const r = getDb().prepare(`SELECT ${CARD_COLS} FROM cards WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  return r ? rowToCard(r) : null
}

export function saveCard(draft: Partial<Card> & { front: string; back: string }): Card {
  const now = Date.now()
  const id = draft.id ?? randomUUID()
  const existing = draft.id ? getCard(draft.id) : null
  const rec = {
    id,
    note_id: draft.noteId ?? existing?.noteId ?? null,
    notebook_id: draft.notebookId ?? existing?.notebookId ?? null,
    front: asText(draft.front),
    back: asText(draft.back),
    hint: draft.hint ?? existing?.hint ?? null,
    tags: JSON.stringify(Array.isArray(draft.tags) ? draft.tags.filter(Boolean) : existing?.tags ?? []),
    source: draft.source ?? existing?.source ?? 'manual',
    created_at: existing?.createdAt ?? now,
    updated_at: now,
    due_at: draft.dueAt ?? existing?.dueAt ?? null,
    interval_days: draft.intervalDays ?? existing?.intervalDays ?? null,
    ease: draft.ease ?? existing?.ease ?? null,
    reps: draft.reps ?? existing?.reps ?? 0,
    lapses: draft.lapses ?? existing?.lapses ?? 0,
    last_review_at: draft.lastReviewAt ?? existing?.lastReviewAt ?? null,
    suspended: (draft.suspended ?? existing?.suspended ?? false) ? 1 : 0,
    deleted: 0,
    importance: draft.importance ?? existing?.importance ?? null,
    kind: draft.kind ?? existing?.kind ?? null,
    quote: draft.quote ?? existing?.quote ?? null
  }
  getDb()
    .prepare(
      `INSERT INTO cards (${CARD_COLS}) VALUES (@id,@note_id,@notebook_id,@front,@back,@hint,@tags,@source,@created_at,@updated_at,@due_at,@interval_days,@ease,@reps,@lapses,@last_review_at,@suspended,@deleted,@importance,@kind,@quote)
       ON CONFLICT(id) DO UPDATE SET note_id=@note_id, notebook_id=@notebook_id, front=@front, back=@back, hint=@hint, tags=@tags, source=@source, updated_at=@updated_at, due_at=@due_at, interval_days=@interval_days, ease=@ease, reps=@reps, lapses=@lapses, last_review_at=@last_review_at, suspended=@suspended, deleted=0, importance=@importance, kind=@kind, quote=@quote`
    )
    .run(rec)
  return getCard(id) as Card
}

/** 删除卡片：墓碑式（与笔记一致，避免在途写入复活） */
export function deleteCard(id: string): boolean {
  const r = getDb().prepare('UPDATE cards SET deleted = 1, updated_at = ? WHERE id = ?').run(Date.now(), id)
  return r.changes > 0
}

export function deleteCardsForNote(noteId: string): number {
  const r = getDb().prepare('UPDATE cards SET deleted = 1, updated_at = ? WHERE note_id = ? AND deleted = 0').run(Date.now(), noteId)
  return r.changes
}

export function listCardFronts(noteId?: string): string[] {
  const rows = (
    noteId
      ? getDb().prepare('SELECT front FROM cards WHERE deleted = 0 AND note_id = ?').all(noteId)
      : getDb().prepare('SELECT front FROM cards WHERE deleted = 0').all()
  ) as Array<{ front: string }>
  return rows.map((r) => r.front)
}

/**
 * SM-2 间隔重复：grade 0=again 1=hard 2=good 3=easy
 * 结果会写回卡片排程，并记录一条复习历史（手机端回传也走这里，保证算法只有一份）
 */
export function reviewCard(id: string, grade: number, ms?: number, source = 'desktop'): Card | null {
  const card = getCard(id)
  if (!card) return null
  const now = Date.now()
  // 排程算法与手机端共用 src/shared/srs.ts，保证两边算出来的到期时间一致
  const next = schedule(
    { ease: card.ease ?? SRS_DEFAULT.ease, intervalDays: card.intervalDays ?? 0, reps: card.reps ?? 0, lapses: card.lapses ?? 0 },
    grade,
    now
  )
  const updated = saveCard({
    id,
    front: card.front,
    back: card.back,
    dueAt: next.dueAt,
    intervalDays: next.intervalDays,
    ease: next.ease,
    reps: next.reps,
    lapses: next.lapses,
    lastReviewAt: now
  })
  getDb()
    .prepare('INSERT INTO card_reviews (id, card_id, at, grade, ms, source) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), id, now, Math.max(0, Math.min(3, Math.round(grade))), ms ?? null, source)
  return updated
}

/** 复习历史回传（手机端批量提交） */
export function importReviews(
  items: Array<{ cardId: string; grade: number; at?: number; ms?: number; source?: string }>
): number {
  let n = 0
  for (const it of items) {
    if (!it?.cardId) continue
    const card = getCard(it.cardId)
    if (!card) continue
    // 离线队列可能重复提交：比本卡最近一次复习还旧的记录直接忽略，避免 reps 被重复计入
    if (it.at && card.lastReviewAt && it.at < card.lastReviewAt) continue
    n += reviewCard(it.cardId, it.grade, it.ms, it.source ?? 'android') ? 1 : 0
  }
  return n
}

export function cardStats(): CardStats {
  const dbx = getDb()
  const total = (dbx.prepare('SELECT COUNT(*) AS n FROM cards WHERE deleted = 0').get() as { n: number }).n
  const due = (
    dbx.prepare('SELECT COUNT(*) AS n FROM cards WHERE deleted = 0 AND suspended = 0 AND (due_at IS NULL OR due_at <= ?)').get(Date.now()) as { n: number }
  ).n
  const suspended = (dbx.prepare('SELECT COUNT(*) AS n FROM cards WHERE deleted = 0 AND suspended = 1').get() as { n: number }).n
  const aiCount = (dbx.prepare("SELECT COUNT(*) AS n FROM cards WHERE deleted = 0 AND source = 'ai'").get() as { n: number }).n
  const manualCount = total - aiCount
  const dayMs = 86_400_000
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  const reviewedToday = (
    dbx.prepare('SELECT COUNT(*) AS n FROM card_reviews WHERE at >= ?').get(startOfToday) as { n: number }
  ).n
  const rows = dbx
    .prepare('SELECT at, grade FROM card_reviews WHERE at >= ? ORDER BY at ASC')
    .all(Date.now() - 30 * dayMs) as Array<{ at: number; grade: number }>
  const byDay = new Map<string, number>()
  for (const r of rows) {
    const k = new Date(r.at).toISOString().slice(0, 10)
    byDay.set(k, (byDay.get(k) ?? 0) + 1)
  }
  const daily: Array<{ day: string; n: number }> = []
  for (let i = 29; i >= 0; i--) {
    const k = new Date(Date.now() - i * dayMs).toISOString().slice(0, 10)
    daily.push({ day: k, n: byDay.get(k) ?? 0 })
  }
  const good = rows.filter((r) => r.grade >= 2).length
  const accuracy = rows.length ? good / rows.length : 0
  // 连续天数：从今天（或昨天）往前数
  let streak = 0
  for (let i = 0; i < 400; i++) {
    const k = new Date(Date.now() - i * dayMs).toISOString().slice(0, 10)
    const has = (byDay.get(k) ?? 0) > 0
    if (has) streak += 1
    else if (i === 0) continue // 今天还没复习不算断
    else break
  }
  return { total, due, suspended, reviewedToday, daily, accuracy, streak, aiCount, manualCount }
}
