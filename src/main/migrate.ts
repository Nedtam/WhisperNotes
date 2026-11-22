// 一次性/幂等迁移：把库里既有的笔记与 AI 增强转写里的 LaTeX/实体/不可见字符还原成真正的符号。
// 只在内容确实会变化时才写库，并记录数量，方便日志排查。
import { normalizeNotation, needsNormalization, normalizeHighlights, needsHighlightNormalization } from '../shared/notation'
import { backupDb, getTranscription, listNotes, listTranscriptions, saveNote, saveTranscription } from './db'
import { orgLog } from './orgLog'

export interface MigrateResult {
  notes: number
  transcripts: number
  highlights: number
  backup: string | null
}

export async function normalizeStoredContent(): Promise<MigrateResult> {
  const res: MigrateResult = { notes: 0, transcripts: 0, highlights: 0, backup: null }
  try {
    // 先探测有无需要改写的笔记，避免无谓备份
    const pendingNotes = listNotes().filter(
      (n) => needsNormalization(n.noteMd ?? '') || needsNormalization(n.title ?? '') || needsHighlightNormalization(n.noteMd ?? '')
    )
    if (pendingNotes.length) res.backup = await backupDb()
    for (const n of listNotes()) {
      const md = n.noteMd ?? ''
      const title = n.title ?? ''
      const hl = needsHighlightNormalization(md)
      if (!needsNormalization(md) && !needsNormalization(title) && !hl) continue
      if (hl) res.highlights += 1
      saveNote({
        id: n.id,
        title: normalizeNotation(title),
        noteMd: normalizeHighlights(normalizeNotation(md)),
        sourceText: n.sourceText,
        templateId: n.templateId,
        notebookId: n.notebookId ?? null,
        durationMs: n.durationMs,
        tags: n.tags
      })
      res.notes += 1
    }

    for (const sum of listTranscriptions()) {
      if (!sum.hasEnhanced) continue
      const rec = getTranscription(sum.id)
      const txt = rec?.enhancedText ?? ''
      if (!txt || !needsNormalization(txt)) continue
      saveTranscription({ id: sum.id, keepEnhanced: false, enhancedText: normalizeNotation(txt) })
      res.transcripts += 1
    }

    if (res.notes || res.transcripts || res.highlights) {
      orgLog(
        `notation migration: notes=${res.notes} transcripts=${res.transcripts} highlights=${res.highlights} backup=${res.backup ?? 'none'}`
      )
    }
  } catch (e) {
    orgLog(`notation migration failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  return res
}
