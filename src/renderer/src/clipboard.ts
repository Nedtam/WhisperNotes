// 复制到剪贴板：打包后页面是 file://，navigator.clipboard 在非安全上下文不可用（表现为“复制了但粘贴是空的”），
// 所以统一走主进程 Electron clipboard，并保留一个浏览器回退。
import { t } from './i18n'
import { useApp } from './store'

export async function copyText(text: string): Promise<void> {
  const s = text ?? ''
  if (!s) return
  let ok = false
  try {
    ok = await window.api.sys.copyText(s)
  } catch {
    ok = false
  }
  if (!ok) {
    try {
      await navigator.clipboard.writeText(s)
      ok = true
    } catch {
      ok = false
    }
  }
  useApp.getState().toastMsg({ kind: ok ? 'ok' : 'err', msg: ok ? t('app.copied') : t('app.copyFailed') })
}
