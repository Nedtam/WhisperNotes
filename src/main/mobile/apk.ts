// 局域网直传用的 APK 定位：开发目录 / 打包后的 Resources / 用户数据目录都找一遍
import * as fs from 'node:fs'
import * as path from 'node:path'

const NAME = 'WhisperNotes-android.apk'

export function findApk(opts: { userData: string; resourcesPath?: string; appDir: string }): string | null {
  const candidates = [
    path.join(opts.resourcesPath ?? '', 'android', NAME),
    path.join(opts.userData, 'android', NAME),
    path.join(opts.appDir, 'native', 'android', NAME),
    path.join(opts.appDir, 'release', NAME),
    path.join(opts.appDir, 'mobile', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
  ]
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).size > 100_000) return p
    } catch {
      /* ignore */
    }
  }
  return null
}

export { NAME as APK_NAME }
