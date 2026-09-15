// 把 whisper 转写文本整理成笔记（OpenRouter），并写入 App 笔记库
// 用法:
//   WN_KEY=sk-or-... node tools/convert-lecture.mjs \
//       --title "SYE2066-1" --txt /tmp/sye2066.txt --json /tmp/sye2066.json \
//       --out "/Users/nedt/Downloads/whisper notes/SYE2066-1-输出"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import * as path from 'node:path'
import Database from 'better-sqlite3'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => {
  if (a.startsWith('--')) return [a.slice(2), arr[i + 1]]
  return null
}).filter(Boolean))

const KEY = process.env.WN_KEY
const MODEL = 'dots-studio/dots-3-note-preview:free'
const BASE = 'https://openrouter.ai/api/v1'

const STUDY_SYSTEM = `You are an expert study-note assistant. Turn the classroom transcript into clean, well-structured Markdown study notes.
Rules:
- Cover every key idea, definition, formula, example, number and name that actually appears. Never invent content or facts.
- Structure with clear headings and bullet lists; bold important terms.
- Fix transcription artifacts silently (repetitions, fillers, broken words) but keep the lecturer's meaning and wording where sensible.
- Write in the same language as the transcript.
- End with a short "Key takeaways" bullet list.
Output Markdown only.`

async function chat(messages, maxTokens = 8192) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://localhost/whisper-notes',
      'X-Title': 'WhisperNotes'
    },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: 0.3, stream: false })
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json()).error?.message ?? '' } catch {}
    throw new Error(`HTTP ${res.status}: ${detail}`)
  }
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content ?? ''
  if (!content) throw new Error('空返回')
  return content
}

function splitParts(text, maxChars) {
  text = text.replace(/\r/g, '').trim()
  if (text.length <= maxChars) return [text]
  const parts = []
  let rest = text
  while (rest.length > maxChars) {
    let cut = rest.slice(0, maxChars)
    let at = cut.length
    for (let i = cut.length - 1; i >= maxChars * 0.6; i--) {
      if (cut[i] === '\n' || cut[i] === '.' || cut[i] === '?' || cut[i] === '!') { at = i + 1; break }
    }
    parts.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

async function main() {
  const title = args.title || '课堂笔记'
  const txt = readFileSync(args.txt, 'utf-8')
  // 规整：折叠连续重复行（whisper 对音乐/噪声段的循环幻觉），合并多余空行
  const rawLines = txt.replace(/\r/g, '').split('\n')
  const lines = []
  let i = 0
  while (i < rawLines.length) {
    const cur = rawLines[i].trim()
    if (!cur) { i++; continue }
    let j = i + 1
    while (j < rawLines.length && rawLines[j].trim() === cur) j++
    const run = j - i
    if (run >= 3) {
      lines.push(`[重复音频段 ×${run}] ${cur}`)
    } else {
      for (let k = i; k < j; k++) lines.push(rawLines[k].trim())
    }
    i = j
  }
  const transcript = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  console.log(`转录文本: ${transcript.length} 字符（原始 ${txt.length}）`)

  if (!transcript) throw new Error('转录为空')
  const parts = splitParts(transcript, 24000)
  console.log(`分块: ${parts.length}`)

  const outs = []
  for (let i = 0; i < parts.length; i++) {
    console.log(`[${i + 1}/${parts.length}] 整理第 ${i + 1} 块…`)
    const sys = parts.length > 1
      ? `${STUDY_SYSTEM}\n\nNote: This is part ${i + 1} of ${parts.length}. Produce notes for this part only; do not summarize the whole lecture.`
      : STUDY_SYSTEM
    outs.push(await chat([
      { role: 'system', content: sys },
      { role: 'user', content: `Class title: ${title}\n\nTranscript (part ${i + 1}/${parts.length}):\n\n${parts[i]}` }
    ]))
    console.log(`  → ${outs[i].length} 字符`)
  }

  let note = outs[0]
  if (parts.length > 1) {
    console.log('合并各部分…')
    const joined = outs.map((m, i) => `=== Part ${i + 1} notes ===\n${m}`).join('\n\n')
    note = await chat([
      {
        role: 'system',
        content: `${STUDY_SYSTEM}\n\nYou are now merging partial notes from the same lecture. Remove overlap and duplication, smooth transitions, keep a single cohesive structure. Output the final complete Markdown notes only.`
      },
      { role: 'user', content: `Class title: ${title}\n\nBelow are the partial notes produced from consecutive transcript chunks. Merge them into one final note:\n\n${joined}` }
    ])
  }

  const dir = args.out || '.'
  mkdirSync(dir, { recursive: true })
  const base = path.join(dir, title)
  writeFileSync(`${base}.transcript.txt`, transcript, 'utf-8')
  writeFileSync(`${base}.notes.md`, note.trim() + '\n', 'utf-8')

  // 写入 App 笔记库（如果存在）
  const dbPath = `${process.env.HOME}/Library/Application Support/WhisperNotes/library.db`
  let insertedId = null
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath)
      const now = Date.now()
      const dur = args.durationMs ? Number(args.durationMs) : 0
      const rec = db.prepare(`INSERT INTO notes (id,title,kind,created_at,updated_at,duration_ms,template_id,source_text,note_md,recording_path,meta)
        VALUES (@id,@title,'lecture',@now,@now,@dur,'study',@src,@note,NULL,NULL)`)
        .run({ id: `ext-${now}`, title, now, dur, src: transcript, note: note.trim() })
      insertedId = rec.lastInsertRowid
      console.log(`已写入 App 笔记库 (id=${insertedId})`)
      db.close()
    } catch (e) {
      console.log('写入笔记库失败（忽略）:', e.message)
    }
  }

  console.log('\n完成:')
  console.log('  transcript: ' + `${base}.transcript.txt`)
  console.log('  notes:      ' + `${base}.notes.md`)
  console.log(`请求数: ${parts.length + (parts.length > 1 ? 1 : 0)}`)
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
