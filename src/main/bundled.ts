// 内置运行资源（随安装包分发，免去安装 brew / ffmpeg 等外部依赖）
// 目录：native/<mac|win>/bin（whisper-server/cli、dll、ffmpeg.exe）、native/model（默认模型）
import { app } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'

const DEFAULT_MODEL = 'ggml-large-v3-turbo-q5_0.bin'

/** native 根目录：打包后位于 Contents/Resources/native（extraFiles），开发时位于项目根 */
export function bundledNativeDir(): string {
  if (app.isPackaged) {
    const inResources = path.join(process.resourcesPath, 'native')
    if (fs.existsSync(inResources)) return inResources
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'native')
  }
  // 开发：项目根 native；按 __dirname（out/main）向上两级的路径更可靠
  const viaApp = path.join(app.getAppPath(), 'native')
  if (fs.existsSync(viaApp)) return viaApp
  return path.join(__dirname, '..', '..', 'native')
}

function platformDir(): 'mac' | 'win' | null {
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'win32') return 'win'
  return null
}

/** 随包附带的 whisper-server 可执行文件（不存在返回 null） */
export function bundledEngineBin(): string | null {
  const plat = platformDir()
  if (!plat) return null
  const exe = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'
  const p = path.join(bundledNativeDir(), plat, 'bin', exe)
  return fs.existsSync(p) ? p : null
}

/** 随包附带的 ffmpeg（仅打包平台需要；mac 用系统 afconvert 兜底也可不带） */
export function bundledFfmpegBin(): string | null {
  const plat = platformDir()
  if (!plat) return null
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const p = path.join(bundledNativeDir(), plat, 'bin', exe)
  return fs.existsSync(p) ? p : null
}

/** 随包附带的默认模型文件（不存在返回 null） */
export function bundledModelBin(): string | null {
  const p = path.join(bundledNativeDir(), 'model', DEFAULT_MODEL)
  return fs.existsSync(p) ? p : null
}

export { DEFAULT_MODEL }
