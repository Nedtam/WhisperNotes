// SQLite 笔记库（better-sqlite3）：笔记 + 笔记本（文件夹式归类）
import Database from 'better-sqlite3'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { i18nCode, tm } from './i18n'
import type {
  NoteDraft,
  NoteRecord,
  Notebook,
  SearchHit,
  TranscriptionDraft,
  TranscriptionRecord,
  TranscriptionSummary
} from '@shared/types'

let db: Database.Database | null = null

export function openDb(dir: string): Database.Database {
  if (db) return db
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
    CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transcriptions_created ON transcriptions(created_at DESC);
  `)
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

function rowToNote(r: Record<string, unknown>): NoteRecord {
  return {
    id: r.id as string,
    title: r.title as string,
    kind: r.kind as string,
    notebookId: (r.notebook_id as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    durationMs: r.duration_ms as number,
    templateId: r.template_id as string,
    sourceText: (r.source_text as string) ?? '',
    noteMd: (r.note_md as string) ?? '',
    recordingPath: (r.recording_path as string) ?? undefined,
    meta: (r.meta as string) ?? undefined,
    tags: parseTags(r.tags)
  }
}

const NOTE_COLS = `id,title,kind,notebook_id,created_at,updated_at,duration_ms,template_id,source_text,note_md,recording_path,meta,tags`

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
  const tagsJson = JSON.stringify(Array.isArray(draft.tags) ? draft.tags.filter(Boolean) : [])
  const notebookId = draft.notebookId ?? existing?.notebookId ?? null
  const record: NoteRecord = {
    id,
    title: draft.title || tm('note.untitled'),
    kind: 'lecture',
    notebookId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    durationMs: draft.durationMs ?? 0,
    templateId: draft.templateId,
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
const TR_COLS = `id,source,title,source_name,created_at,duration_ms,language,raw_text,enhanced_text`

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
    enhancedText: (r.enhanced_text as string | null) ?? null
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
      hasEnhanced: !!en && en.length > 0,
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
  const enhancedText = draft.keepEnhanced
    ? (existing?.enhancedText ?? null)
    : draft.enhancedText !== undefined && draft.enhancedText !== null
      ? draft.enhancedText
      : (existing?.enhancedText ?? null)
  const language = draft.language ?? existing?.language ?? null
  const durationMs = draft.durationMs ?? existing?.durationMs ?? 0
  const id = draft.id ?? randomUUID()
  db.prepare(
    `INSERT INTO transcriptions (id,source,title,source_name,created_at,duration_ms,language,raw_text,enhanced_text)
     VALUES (@id,@source,@title,@sourceName,@createdAt,@durationMs,@language,@rawText,@enhancedText)
     ON CONFLICT(id) DO UPDATE SET
       source=excluded.source, title=excluded.title, source_name=excluded.source_name,
       duration_ms=excluded.duration_ms, language=excluded.language,
       raw_text=excluded.raw_text, enhanced_text=excluded.enhanced_text`
  ).run({ id, source, title, sourceName, createdAt, durationMs, language, rawText, enhancedText })
  return { id, source, title, sourceName, createdAt, durationMs, language: language ?? undefined, rawText, enhancedText }
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
