// 轻量 i18n：App 界面语言（zh/en）。词典本体在 src/shared/i18n.ts，与主进程共用，
// 保证主进程弹出的报错/进度/默认标题跟界面语言一致。
// 读取优先级：localStorage('wn-app-lang') → config.ui.language（由 store 同步进来）→ 默认 zh
import { DEFAULT_LANG, MESSAGES, translate, type Lang } from '../../shared/i18n'

export type { Lang }

const KEY = 'wn-app-lang'

let lang: Lang = ((): Lang => {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'en' || v === 'zh' ? v : DEFAULT_LANG
  } catch {
    return DEFAULT_LANG
  }
})()

type Listener = (l: Lang) => void
const listeners = new Set<Listener>()

/** 订阅语言变化（用于需要重算文案的组件/派生状态） */
export function onLangChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function setLang(l: Lang): void {
  lang = l
  try {
    localStorage.setItem(KEY, l)
  } catch {
    /* ignore */
  }
  for (const fn of listeners) fn(l)
}

export function getLang(): Lang {
  return lang
}

export function t(key: string, vars?: Record<string, string | number>): string {
  // 缺 key 时回退：当前语言 → 中文 → key 本身
  return translate(lang, key, vars)
}

/** 供非 React 场景判断 key 是否存在（例如把主进程回来的错误码翻译成当前语言） */
export function hasKey(key: string): boolean {
  return Boolean(MESSAGES[lang]?.[key] ?? MESSAGES.zh[key])
}

/**
 * 主进程报错统一走「错误码」：形如 `@err.asrBusy` 或 `@org.tooLong|len=1,2&max=3`。
 * 这里把消息里出现的错误码翻译成当前语言（可出现在前缀之后，如「保存失败：@err.x」）；
 * 不是错误码就原样返回（兼容旧的自由文本）。
 */
export function tError(msg: string): string {
  if (!msg || !msg.includes('@')) return msg
  return msg.replace(/@([a-zA-Z][\w.]*)(\|([^\s]*))?/g, (_all, key: string, _p: string, raw?: string) => {
    if (!hasKey(key)) return key
    const vars: Record<string, string> = {}
    if (raw) {
      for (const pair of raw.split('&')) {
        const i = pair.indexOf('=')
        if (i > 0) vars[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1))
      }
    }
    return t(key, vars)
  })
}
