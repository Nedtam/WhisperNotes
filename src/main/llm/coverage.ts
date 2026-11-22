// 完整性地板：判断"统一润色"后的笔记有没有把某个分块的内容整块丢掉。
//
// 背景：分块整理出来的每一段都是真笔记，最后一步会请模型把它们统一成一篇。
// 模型有时会"顺手压缩"，把某一段的内容整块吃掉 —— 这正是用户最在意的"不完整"。
// 这里用零成本的办法兜住：从每个分块里挑几个"有辨识度"的词/数字，检查它们是否还在最终稿里；
// 只要有哪一段一个都没留下，就判定这次统一把内容吃掉了 → 调用方回退到完整拼接版。

/** 从一段文本里挑"有辨识度"的标记：长词 + 数字（去重、保序、限量） */
export function distinctiveTokens(text: string, limit = 6): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  // 1) 数字（含小数、百分比、kHz/dB 之类）：讲课里的关键数字最有辨识度
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const tok = m[0]
    if (tok.length < 2) continue
    if (seen.has(tok)) continue
    seen.add(tok)
    out.push(tok)
    if (out.length >= limit) break
  }
  // 2) 拉丁长词（≥6 字母，跳过纯数字）
  if (out.length < limit) {
    for (const m of text.matchAll(/[A-Za-z][A-Za-z-]{5,}/g)) {
      const tok = m[0].toLowerCase()
      if (seen.has(tok)) continue
      seen.add(tok)
      out.push(tok)
      if (out.length >= limit) break
    }
  }
  return out
}

/**
 * 每个分块至少还要留下一个标记才算"没丢内容"。
 * 返回 { ok, missing }；missing 是"整段都没留下痕迹"的段号（从 1 开始）。
 */
export function coverageOk(parts: string[], finalText: string, opts?: { minPerPart?: number }): { ok: boolean; missing: number[] } {
  const minPerPart = opts?.minPerPart ?? 1
  const lower = finalText.toLowerCase()
  const missing: number[] = []
  parts.forEach((p, i) => {
    const toks = distinctiveTokens(p)
    if (!toks.length) return // 这段没有可判断的标记（例如纯短句）→ 不参与判定
    const hit = toks.filter((t) => (/\d/.test(t) ? finalText.includes(t) : lower.includes(t))).length
    if (hit < minPerPart) missing.push(i + 1)
  })
  return { ok: missing.length === 0, missing }
}
