// 把多段笔记拼成一篇"完整"的文档（纯函数：0 次请求、内容零丢失）
// 设计目标：任何输入/输出上限下都能得到结构正常、内容完整的笔记；
// 统一润色（LLM）只是锦上添花，失败或"写少了"都必须能退回这里的结果。

/**
 * 把各分段的笔记拼成一篇"完整"的文档（0 次请求、内容零丢失）：
 *  · 同名小节合并（同一个主题在不同分段里出现 → 合到一起，而不是重复两遍）
 *  · "小结 / Key takeaways"类小节收集成最后一节，逐条去重
 *  · 顶层标题统一重排编号；分段里没有标题的，按段落原样接上
 * 这样即使后面的统一润色失败，用户拿到的也是一篇结构正常、内容完整的笔记。
 */
export function assembleNotes(notes: string[]): string {
  if (notes.length === 1) return notes[0].trim()
  const summaryRe = /^(key takeaways?|takeaways?|summary|conclusion|小结|总结|结论|要点回顾)[:：]?$/i
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[\s*_`~]/g, '')
      .replace(/[.。:：、,，)）(（\-—]+$/g, '')
      .trim()
  interface Section {
    level: number
    title: string
    body: string[]
  }
  const sections: Section[] = []
  const prelude: string[] = []
  const summaryItems: string[] = []
  const seenBullets = new Set<string>()
  let cur: Section | null = null
  for (const note of notes) {
    const lines = note.replace(/\r/g, '').split('\n')
    for (const line of lines) {
      const h = /^(#{1,6})\s+(.*\S)\s*$/.exec(line)
      if (h) {
        const title = h[2].trim()
        if (summaryRe.test(title)) {
          cur = null
          continue
        }
        const key = `${h[1].length}|${norm(title)}`
        const hit = sections.find((x) => `${x.level}|${norm(x.title)}` === key)
        if (hit) {
          cur = hit
        } else {
          cur = { level: h[1].length, title, body: [] }
          sections.push(cur)
        }
        continue
      }
      if (!line.trim()) {
        if (cur) cur.body.push('')
        else prelude.push('')
        continue
      }
      // 小结里的条目 → 收集去重
      const isBullet = /^\s*([-*+]|\d+[.)、])\s+/.test(line)
      if (cur === null) {
        if (isBullet) {
          const k = norm(line.replace(/^\s*([-*+]|\d+[.)、])\s+/, ''))
          if (k && !seenBullets.has(k)) {
            seenBullets.add(k)
            summaryItems.push(line.trim().replace(/^\s*\d+[.)、]\s*/, '- '))
          }
          continue
        }
        if (line.trim()) prelude.push(line)
        continue
      }
      cur.body.push(line)
    }
  }
  // 顶层编号重排（只有明确带编号时才重排，避免乱改用户/模型的结构）
  const tops = sections.filter((x) => x.level === 1)
  const numbered = tops.filter((x) => /^\d+[.、)]\s*/.test(x.title)).length
  if (tops.length >= 2 && numbered >= 2) {
    let n = 0
    for (const x of sections) {
      if (x.level !== 1) continue
      n += 1
      x.title = `${n}. ${x.title.replace(/^\d+[.、)]\s*/, '')}`
    }
  }
  const out: string[] = []
  const trimmedPrelude = prelude.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (trimmedPrelude) out.push(trimmedPrelude)
  for (const sec of sections) {
    const body = sec.body.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    out.push(`${'#'.repeat(Math.min(6, Math.max(1, sec.level)))} ${sec.title}${body ? `\n\n${body}` : ''}`)
  }
  if (summaryItems.length) out.push(`## Key takeaways\n\n${summaryItems.join('\n')}`)
  return out.join('\n\n').trim()
}
