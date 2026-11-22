// 文档解析（文档 → 笔记用）：PDF / PPTX / DOCX / TXT / MD → 带页码的纯文本
//
// 与 slides.ts 的关系：PDF/PPTX 直接复用那套解析（同一份 pdfjs / pptx 实现、同样支持加密 PDF），
// 这里补上 txt / md / docx，并把结果统一成"按页（或按段落块）带编号"的文本，
// 方便整理时在要点后面标注 (p.12) 回查原文。
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseDeck, PdfPasswordNeeded } from './slides'
import { i18nCode } from './i18n'

export type DocKind = 'pdf' | 'pptx' | 'docx' | 'txt' | 'md'

export interface DocPage {
  /** 页码 / 段落块号（从 1 开始） */
  n: number
  text: string
}

export interface ParsedDoc {
  fileName: string
  filePath: string
  kind: DocKind
  pages: DocPage[]
  /** 抽出来的正文字符数 */
  chars: number
  /** 需要密码（加密 PDF） */
  passwordNeeded?: boolean
  /** 有页面但一个字都没抽到（多半是扫描版 PDF / 纯图片） */
  emptyText?: boolean
}

export const DOC_EXTENSIONS = ['.pdf', '.pptx', '.docx', '.txt', '.md', '.markdown']

export function isDocPath(p: string): boolean {
  return DOC_EXTENSIONS.includes(path.extname(p).toLowerCase())
}

/** 统一的解析入口（password 仅 PDF 用得上） */
export async function parseDocument(filePath: string, password = ''): Promise<ParsedDoc> {
  const ext = path.extname(filePath).toLowerCase()
  const fileName = path.basename(filePath)
  if (ext === '.pdf' || ext === '.pptx') {
    let deck: Awaited<ReturnType<typeof parseDeck>>
    try {
      deck = await parseDeck(filePath, password)
    } catch (e) {
      // 加密 PDF：交给上层提示输密码（与课件流程一致）
      if (e instanceof PdfPasswordNeeded || (e as { code?: string }).code === 'PASSWORD_REQUIRED') {
        return { fileName, filePath, kind: ext === '.pdf' ? 'pdf' : 'pptx', pages: [], chars: 0, passwordNeeded: true }
      }
      throw e
    }
    const pages: DocPage[] = deck.pages.map((p) => ({ n: p.n, text: (p.text || '').trim() }))
    const chars = pages.reduce((n, p) => n + p.text.length, 0)
    return {
      fileName,
      filePath,
      kind: ext === '.pdf' ? 'pdf' : 'pptx',
      pages,
      chars,
      emptyText: chars < 40
    }
  }
  if (ext === '.docx') {
    const pages = await docxPages(filePath)
    const chars = pages.reduce((n, p) => n + p.text.length, 0)
    return { fileName, filePath, kind: 'docx', pages, chars, emptyText: chars < 40 }
  }
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    const raw = readTextFile(filePath)
    const pages = textBlocks(raw)
    const chars = pages.reduce((n, p) => n + p.text.length, 0)
    return { fileName, filePath, kind: ext === '.md' || ext === '.markdown' ? 'md' : 'txt', pages, chars, emptyText: chars < 40 }
  }
  throw new Error(i18nCode('err.docUnsupported'))
}

/** 读纯文本：UTF-8 优先，失败退回 latin1（避免整份文件读不出来） */
function readTextFile(filePath: string): string {
  const buf = fs.readFileSync(filePath)
  let text = buf.toString('utf8')
  // 替换字符过多 → 多半不是 UTF-8
  const bad = (text.match(/\uFFFD/g) || []).length
  if (bad > Math.max(8, text.length * 0.02)) text = buf.toString('latin1')
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/** 纯文本按空行切成"段落块"，每块 ≈ 一页的量（保持页码式标注可读） */
function textBlocks(raw: string, maxChars = 2600): DocPage[] {
  const paras = raw.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  const out: DocPage[] = []
  let buf = ''
  const flush = (): void => {
    if (buf.trim()) out.push({ n: out.length + 1, text: buf.trim() })
    buf = ''
  }
  for (const p of paras) {
    if (buf && buf.length + p.length + 2 > maxChars) flush()
    buf = buf ? `${buf}\n\n${p}` : p
  }
  flush()
  return out.length ? out : raw.trim() ? [{ n: 1, text: raw.trim() }] : []
}

/**
 * DOCX：.docx 就是个 zip，正文在 word/document.xml。
 * 这里只做"取文字"这一件事：<w:p> 段落、<w:t> 文本、<w:tab>/<w:br> 转空格/换行，
 * 表格里的单元格用 " | " 连接 —— 不需要引入 Word 排版引擎，也不需要新依赖（jszip 已在依赖里）。
 */
async function docxPages(filePath: string): Promise<DocPage[]> {
  const JSZip = (await import('jszip')).default as {
    loadAsync: (d: Buffer) => Promise<{ file: (n: string) => { async: (t: 'string') => Promise<string> } | null }>
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath))
  const entry = zip.file('word/document.xml')
  if (!entry) throw new Error(i18nCode('err.docUnsupported'))
  const xml = await entry.async('string')
  const blocks: string[] = []
  // 段落（<w:p>…</w:p>）；表格行 <w:tr> 里的单元格会被 <w:p> 覆盖，这里顺序拼接即可
  for (const para of xml.split(/<w:p[ >]/).slice(1)) {
    const body = para.split(/<\/w:p>/)[0] ?? ''
    const parts: string[] = []
    for (const m of body.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/?>/g)) {
      if (m[0].startsWith('<w:tab')) parts.push(' ')
      else if (m[0].startsWith('<w:br')) parts.push('\n')
      else parts.push(decodeXml(m[1] ?? ''))
    }
    const line = parts.join('').replace(/[ \t]{2,}/g, ' ').trim()
    if (line) blocks.push(line)
  }
  if (!blocks.length) return []
  // 按字符量合页：每页 ≈ 2600 字，与原 PDF/PPTX 的"页"粒度接近
  const pages: DocPage[] = []
  let buf = ''
  for (const b of blocks) {
    if (buf && buf.length + b.length + 1 > 2600) {
      pages.push({ n: pages.length + 1, text: buf.trim() })
      buf = ''
    }
    buf = buf ? `${buf}\n${b}` : b
  }
  if (buf.trim()) pages.push({ n: pages.length + 1, text: buf.trim() })
  return pages
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 拼成喂给模型的文档正文：每页带 [p.N] 标记，
 * 这样要点后面能自然带出 (p.12)，用户可回原文档核对。
 */
export function docToPromptText(doc: ParsedDoc, maxChars = 300_000): { text: string; truncated: boolean } {
  const chunks: string[] = []
  let total = 0
  let truncated = false
  for (const p of doc.pages) {
    const seg = `[p.${p.n}]\n${p.text}`.trim()
    if (total + seg.length > maxChars) {
      truncated = true
      break
    }
    chunks.push(seg)
    total += seg.length + 2
  }
  return { text: chunks.join('\n\n'), truncated }
}
