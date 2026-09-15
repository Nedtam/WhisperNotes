// 整理/精修任务的持久日志：logs/organize.log
// 目的：任务失败或界面看起来“没动静”时，能事后查清卡在哪一步（分块/请求大小/HTTP 状态/错误体）。
import * as fs from 'node:fs'
import * as path from 'node:path'

let dir = ''
const MAX_BYTES = 4 * 1024 * 1024

export function initOrgLog(logDir: string): void {
  dir = logDir
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
}

function file(): string {
  return path.join(dir || '.', 'organize.log')
}

export function orgLog(line: string): void {
  try {
    const f = file()
    try {
      if (fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, f + '.1')
    } catch {
      /* 文件不存在 */
    }
    fs.appendFileSync(f, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* ignore */
  }
  if (process.env['WN_DEBUG_ORG']) console.log('[org]', line)
}

export function orgLogPath(): string {
  return file()
}
