// PPT/PDF 课件文本抽取：PPTX 按页、PDF 逐页（pdfjs v3 主解析 + pdf-parse 兜底）
import * as fs from 'node:fs'
import * as path from 'node:path'
import JSZip from 'jszip'
import { i18nCode } from './i18n'

export interface DeckPage {
  n: number
  text: string
}

export interface DeckInfo {
  path: string
  fileName: string
  kind: 'pdf' | 'pptx'
  pageCount: number
  chars: number
  pages: DeckPage[]
  /** 术语/专名提示词（给转写引擎 bias） */
  terms: string
}

export class PdfPasswordNeeded extends Error {
  code = 'PASSWORD_REQUIRED'
  constructor() {
    super(i18nCode('err.pdfEncrypted'))
  }
}

const cache = new Map<string, { mtimeMs: number; deck: DeckInfo }>()

export async function parseDeckCached(filePath: string, password = ''): Promise<DeckInfo> {
  const st = fs.statSync(filePath)
  const key = `${filePath}|${password}`
  const hit = cache.get(key)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.deck
  const deck = await parseDeck(filePath, password)
  cache.set(key, { mtimeMs: st.mtimeMs, deck })
  return deck
}

export async function parseDeck(filePath: string, password = ''): Promise<DeckInfo> {
  const ext = path.extname(filePath).toLowerCase()
  const fileName = path.basename(filePath)
  if (ext === '.pdf') return pdfDeck(filePath, fileName, password)
  if (ext === '.pptx') return pptxDeck(filePath, fileName)
  throw new Error(i18nCode('err.deckUnsupported'))
}

// ── PDF ─────────────────────────────────────────────
async function pdfDeck(filePath: string, fileName: string, password: string): Promise<DeckInfo> {
  const buf = fs.readFileSync(filePath)
  const pages: DeckPage[] = []
  try {
    // pdfjs v3 legacy：逐页取文本（课件 PDF 可能带权限/用户密码）
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.js')) as {
      getDocument: (opts: { data: Uint8Array; password?: string }) => { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str: string }> }> }> }> }
    }
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), password }).promise
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      const text = content.items
        .map((it) => it.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      pages.push({ n, text })
    }
  } catch (err) {
    const name = (err as { name?: string }).name
    if (name === 'PasswordException') throw new PdfPasswordNeeded()
    // 非密码类失败：兜底 pdf-parse（无逐页、不支持密码）
    console.warn('[slides] pdfjs parse failed, fallback pdf-parse:', (err as Error).message)
    try {
      const mod = (await import('pdf-parse')) as unknown as {
        default?: (data: Buffer) => Promise<{ numpages: number; text: string }>
        [k: string]: unknown
      }
      const parse = (mod.default ?? mod) as (data: Buffer) => Promise<{ numpages: number; text: string }>
      const out = await parse(buf)
      pages.push({ n: 1, text: out.text.replace(/\s+/g, ' ').trim() })
      if (out.numpages > 1) pages.push({ n: out.numpages, text: '' })
    } catch (e2) {
      const n2 = (e2 as { name?: string }).name
      if (n2 === 'PasswordException') throw new PdfPasswordNeeded()
      throw e2
    }
  }
  return finalize(filePath, fileName, 'pdf', pages)
}

// ── PPTX ────────────────────────────────────────────
async function pptxDeck(filePath: string, fileName: string): Promise<DeckInfo> {
  const buf = await fs.promises.readFile(filePath)
  const zip = await JSZip.loadAsync(buf)
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)/)?.[1] ?? 0)
      const nb = Number(b.match(/slide(\d+)/)?.[1] ?? 0)
      return na - nb
    })
  if (slideFiles.length === 0) throw new Error(i18nCode('err.deckNoSlides'))
  const pages: DeckPage[] = []
  for (const f of slideFiles) {
    const xml = await zip.file(f)?.async('string')
    const n = Number(f.match(/slide(\d+)/)?.[1] ?? pages.length + 1)
    const texts = xml ? [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]) : []
    const joined = texts.join(' ').replace(/\s+/g, ' ').trim()
    if (joined) pages.push({ n, text: joined })
  }
  return finalize(filePath, fileName, 'pptx', pages)
}

function finalize(
  filePath: string,
  fileName: string,
  kind: 'pdf' | 'pptx',
  pages: DeckPage[]
): DeckInfo {
  const chars = pages.reduce((a, p) => a + p.text.length, 0)
  return {
    path: filePath,
    fileName,
    kind,
    pageCount: pages.length,
    chars,
    pages,
    terms: extractTerms(pages)
  }
}

// ── 术语抽取：重复出现的专名/大写词，用于转写初始提示词 ─────
const STOP = new Set(
  'okay ok so and the of a to in is it that this you we they i my your our are was be have has as for on with at by from an or not but if then how why what when where who which just really very can will do does did these those there here good great yeah yes no all about into over under during after before their its one two three four five six seven eight nine ten'.split(' ')
)

function extractTerms(pages: DeckPage[]): string {
  const counts = new Map<string, number>()
  const push = (w: string): void => {
    if (w.length < 3 || w.length > 24) return
    if (/^\d+$/.test(w)) return
    if (STOP.has(w.toLowerCase())) return
    counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  for (const p of pages) {
    const words = p.text.split(/[^A-Za-z0-9'’-]+/)
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      const clean = w.replace(/[^A-Za-z'’-]/g, '')
      if (!clean) continue
      // 大写专名（非句首启发式：本词大写且前后不含句号）
      if (/^[A-Z][a-z]+(?:[ '-][A-Z][a-z]+)*$/.test(clean)) push(clean)
      else if (/^[A-Z]{2,}$/.test(clean)) push(clean) // 缩写 OPERATING 等
      // 专名常见于真实词库中多次出现
      push(clean)
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
  return sorted
    .filter(([, c]) => c >= 2)
    .slice(0, 220)
    .map(([w]) => w)
    .join(', ')
}

/** 多份课件合并上下文：逐文件取前部，总预算内尽量覆盖每个文件的开始 */
export function fitSlidesList(items: Array<{ label: string; pages: DeckPage[] }>, budgetChars: number): string {
  const lines: string[] = []
  let used = 0
  for (const item of items) {
    if (used >= budgetChars) break
    lines.push(`--- ${item.label} ---`)
    used += item.label.length + 6
    for (const p of item.pages) {
      const head = `[${p.n}] ${p.text}\n`
      if (used + head.length > budgetChars) {
        const remain = budgetChars - used
        if (remain > 40) lines.push(head.slice(0, remain))
        used = budgetChars
        break
      }
      lines.push(head)
      used += head.length
    }
    if (used < budgetChars) lines.push('')
  }
  return lines.join('\n').trim()
}

/** 把单份课件折进预算（旧接口保留） */
export function fitSlidesText(pages: DeckPage[], budgetChars: number): string {
  return fitSlidesList([{ label: '', pages }], budgetChars)
}
