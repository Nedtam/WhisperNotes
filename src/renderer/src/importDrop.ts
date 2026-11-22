// 拖入文件的处理决策（纯函数，便于单测）
//
// 同一个 PDF 在两个页面的含义不同：
//   · 录音页：是"本次录音的课件参考"（deck）
//   · 笔记页：是"要转成笔记的文档"（document）
// 所以这里先把"文件是什么"判出来，再由各页面决定怎么用。
//
// 单独抽成纯函数是因为"拖拽"在自动化里没法真的模拟（合成 File 拿不到真实路径），
// 决策逻辑做成纯函数就能测死；"排队 → 转写 → 转成笔记"这条链路由 E2E 覆盖。

export const AUDIO_RE = /\.(m4a|mp3|wav|mp4|m4b|aac|flac|ogg|opus|webm|caf|aiff)$/i
export const SLIDES_RE = /\.(pdf|pptx)$/i
export const TEXTDOC_RE = /\.(docx|txt|md|markdown)$/i
/** 文档转笔记支持的格式（与主进程 docparse 一致） */
export const DOC_RE = /\.(pdf|pptx|docx|txt|md|markdown)$/i

export type FileClass = 'audio' | 'slides' | 'textdoc' | 'other'

export function fileClass(filePath: string): FileClass {
  if (!filePath) return 'other'
  if (AUDIO_RE.test(filePath)) return 'audio'
  if (SLIDES_RE.test(filePath)) return 'slides'
  if (TEXTDOC_RE.test(filePath)) return 'textdoc'
  return 'other'
}

/** 录音页：PDF/PPTX 当课件参考 */
export function isDeckPath(filePath: string): boolean {
  return fileClass(filePath) === 'slides'
}

/** 笔记页：凡是"文档转笔记"支持的格式都算可转 */
export function isDocForNote(filePath: string): boolean {
  return DOC_RE.test(filePath)
}

export function pickDocForNote(paths: string[]): string | null {
  return paths.find((p) => isDocForNote(p)) ?? null
}

/**
 * 录音页的拖入决策：
 *   busy = 正在录音 / 正在转写 / 正在导入（whisper 引擎只有一个，同一时刻只能跑一件事）。
 *   音频忙时排队、闲时立刻转写；PDF/PPTX 永远立即生效（只解析，不占引擎）。
 */
export function planDrop(
  paths: string[],
  busy: boolean
): { importNow: string[]; queued: string[]; decks: string[]; ignored: string[] } {
  const out = { importNow: [] as string[], queued: [] as string[], decks: [] as string[], ignored: [] as string[] }
  for (const p of paths) {
    const kind = fileClass(p)
    if (kind === 'audio') (busy ? out.queued : out.importNow).push(p)
    else if (kind === 'slides') out.decks.push(p)
    else out.ignored.push(p)
  }
  return out
}

/** 队列里的文件依次处理：一次只跑一个（引擎串行） */
export function nextQueued<T>(queue: T[]): T | undefined {
  return queue.length ? queue[0] : undefined
}
