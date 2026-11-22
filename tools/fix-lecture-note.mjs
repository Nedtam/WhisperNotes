// 定向修复 Lecture 2026-09-25 16:58（C++ 笔记）里被旧版表格/荧光逻辑写坏的 3 类内容：
//   ① 表格行尾多余空列（旧 split('|') 把 || 切成空列后再序列化，留下 `|  |  |`）
//   ② 表格内联代码里被吃掉的 || （`if (c == 'A' |  | 'E')` → `... 'A' || 'E')`）
//   ③ 内联代码里叠加的等号（`if (a == ==b ==== c)` → `if (a == b == c)`）
// 安全约束：只处理该笔记；只动表格行 / 反引号代码段内部；先备份原文与数据库；幂等（修完再跑无变化）
// 用法: node tools/fix-lecture-note.mjs            (dry-run，只打印 diff)
//       node tools/fix-lecture-note.mjs --write    (写库)
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const NOTE_ID = 'd1070dda-591c-4076-815e-27e0ad0e101d'
const DB = path.join(os.homedir(), 'Downloads/whisper-notes/library.db')
const WRITE = process.argv.includes('--write')

const raw = execFileSync('sqlite3', [`file:${DB}?mode=ro`, `SELECT note_md FROM notes WHERE id='${NOTE_ID}';`], {
  encoding: 'utf-8',
  maxBuffer: 64 * 1024 * 1024
})
const md = raw.replace(/\n$/, '')

/** 按反引号切分表格行（返回单元格，含代码段内的 | ） */
function splitCells(line) {
  const body = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
  const cells = []
  let cur = ''
  let code = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && body[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (ch === '`') {
      code = !code
      cur += ch
      continue
    }
    if (ch === '|' && !code) {
      cells.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur)
  return cells.map((c) => c.trim())
}

/** ② + ③：在代码段内部修 || 与叠加等号 */
function fixInsideCode(line) {
  let out = ''
  let code = false
  const isCellBoundary = (i) => /^[ \t]*\|[ \t]*/.test(line.slice(i))
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '`') {
      code = !code
      out += ch
      continue
    }
    if (code) {
      // ② 代码段里出现 `| |` / `|  |` → 还原成 ||
      if (ch === '|') {
        const m = /^\|[ \t]*\|/.exec(line.slice(i))
        if (m) {
          out += '||'
          i += m[0].length - 1
          continue
        }
      }
      // ③ `== ==` → `== `（保留空白），`====` → `==`
      if (ch === '=') {
        const m4 = /^={4,}/.exec(line.slice(i))
        if (m4) {
          out += '=='
          i += m4[0].length - 1
          continue
        }
        const m2 = /^={2,}([ \t]+)={2,}/.exec(line.slice(i))
        if (m2) {
          out += '==' + m2[1]
          i += m2[0].length - 1
          continue
        }
      }
    }
    void isCellBoundary
    out += ch
  }
  return out
}

const lines = md.split('\n')
const out = [...lines]
const diff = []

// 先按连续表格块处理列数（①），再逐行处理代码段（②③）
let i = 0
while (i < lines.length) {
  const isRow = (l) => /^\s*\|/.test(l)
  if (!isRow(lines[i])) {
    i++
    continue
  }
  let j = i
  while (j < lines.length && isRow(lines[j])) j++
  const block = lines.slice(i, j)
  // 目标列数 = 最右侧非空单元格的位置（修掉尾部空列）
  const isSep = (cells) => cells.every((c) => /^:?-{2,}:?$/.test(c))
  let width = 1
  for (const l of block) {
    const cells = splitCells(l)
    // 分隔行（|---|---|）不算内容宽度：它本身可能被旧逻辑撑宽，正是要修的对象
    if (isSep(cells)) continue
    let last = cells.length - 1
    while (last >= 0 && cells[last] === '') last--
    width = Math.max(width, last + 1)
  }
  for (let k = i; k < j; k++) {
    const before = out[k]
    let cells = splitCells(before)
    // 尾部空列：裁到 width；不足则补齐（表格对齐需要）
    cells = cells.slice(0, width)
    while (cells.length < width) cells.push('')
    let line = '| ' + cells.join(' | ') + ' |'
    const line2 = fixInsideCode(line)
    if (line2 !== before) {
      out[k] = line2
      diff.push({ n: k + 1, before, after: line2 })
    }
  }
  i = j
}

if (!diff.length) {
  console.log('没有需要修复的内容（可能已经修过了）。')
  process.exit(0)
}

console.log(`将要修改 ${diff.length} 行：\n`)
for (const d of diff) {
  console.log(`  L${d.n}`)
  console.log(`  - ${d.before.trim().slice(0, 220)}`)
  console.log(`  + ${d.after.trim().slice(0, 220)}\n`)
}

if (!WRITE) {
  console.log('（dry-run，未写库；加 --write 才写入）')
  process.exit(0)
}

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backupPath = path.join(path.dirname(DB), `note-backup-${NOTE_ID}-${ts}.md`)
fs.writeFileSync(backupPath, md, 'utf-8')
execFileSync('sqlite3', [DB, `.backup '${path.join(path.dirname(DB), `library.db.bak-${ts}`)}'`])
const tmp = path.join(os.tmpdir(), `wn-note-fixed-${ts}.md`)
fs.writeFileSync(tmp, out.join('\n'), 'utf-8')
// 注意：readfile() 返回 BLOB，必须 CAST 成 TEXT —— 否则 SQLite 把该列存成 BLOB，
// better-sqlite3 读出来是 Buffer，渲染层 .replace() 会崩（笔记视图整页白屏）。
execFileSync('sqlite3', [DB, `UPDATE notes SET note_md = CAST(readfile('${tmp}') AS TEXT) WHERE id='${NOTE_ID}';`])
const typeCheck = execFileSync('sqlite3', [`file:${DB}?mode=ro`, `SELECT typeof(note_md) FROM notes WHERE id='${NOTE_ID}';`], {
  encoding: 'utf-8'
}).trim()
if (typeCheck !== 'text') {
  execFileSync('sqlite3', [DB, `UPDATE notes SET note_md = CAST(note_md AS TEXT) WHERE id='${NOTE_ID}';`])
  console.log(`⚠️ 写入后列类型为 ${typeCheck}，已自动 CAST 回 text`)
}
const check = execFileSync('sqlite3', [`file:${DB}?mode=ro`, `SELECT length(note_md) || ' 字符 / ' || typeof(note_md) FROM notes WHERE id='${NOTE_ID}';`], {
  encoding: 'utf-8'
})
console.log(`✅ 已写入（${check.trim()}）`)
console.log(`   笔记原文备份: ${backupPath}`)
console.log(`   数据库备份  : ${path.join(path.dirname(DB), `library.db.bak-${ts}`)}`)
