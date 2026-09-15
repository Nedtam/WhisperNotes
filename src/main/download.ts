// 带进度的 HTTP 文件下载（HuggingFace 直链）
import * as fs from 'node:fs'
import * as path from 'node:path'
import { i18nCode } from './i18n'

export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal
): Promise<number> {
  const tmp = dest + '.part'
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'WhisperNotes/0.1' },
    signal
  })
  if (!res.ok || !res.body) {
    throw new Error(i18nCode('err.downloadFailed', { status: res.status, text: res.statusText }))
  }
  const total = Number(res.headers.get('content-length')) || 0
  const reader = res.body.getReader()
  const out = fs.createWriteStream(tmp)
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (signal?.aborted) {
      out.destroy()
      throw new Error(i18nCode('err.downloadCanceled'))
    }
    if (!out.write(Buffer.from(value))) {
      await new Promise<void>((resolve) => out.once('drain', () => resolve()))
    }
    received += value.byteLength
    onProgress?.(received, total)
  }
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve())
    out.on('error', reject)
  })
  fs.renameSync(tmp, dest)
  return received
}
