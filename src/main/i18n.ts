// 主进程文案：与渲染层共用 src/shared/i18n.ts 词典，语言取 config.ui.language。
// 用户可见的报错一律抛 i18nCode(...)（形如 @err.asrBusy|status=402），由渲染层按当前语言翻译；
// 必须在主进程内成文的（日志、文件头、窗口标题）用 tm() 直接取当前语言。
import { MESSAGES, DEFAULT_LANG, translate, type Lang } from '../shared/i18n'
import { loadConfig } from './config'

export function currentLang(): Lang {
  try {
    const l = loadConfig().ui?.language
    return l === 'en' || l === 'zh' ? l : DEFAULT_LANG
  } catch {
    return DEFAULT_LANG
  }
}

export function tm(key: string, vars?: Record<string, string | number>): string {
  return translate(currentLang(), key, vars)
}

/**
 * 可翻译的错误：message 里带 `@key` 或 `@key|k=v&k2=v2` 标记，
 * 渲染层收到后用 tError() 翻译；主进程日志/终端里仍可读。
 */
export class I18nError extends Error {
  constructor(key: string, vars?: Record<string, string | number>) {
    super(i18nCode(key, vars))
    this.name = 'I18nError'
  }
}

export function i18nCode(key: string, vars?: Record<string, string | number>): string {
  if (!vars) return `@${key}`
  const q = Object.entries(vars)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')
  return `@${key}|${q}`
}

/** 抛可翻译错误 */
export function fail(key: string, vars?: Record<string, string | number>): never {
  throw new I18nError(key, vars)
}

/** 缺 key 自检（开发期用；生产不调用） */
export function missingKeys(): string[] {
  const zh = Object.keys(MESSAGES.zh)
  const en = new Set(Object.keys(MESSAGES.en))
  return zh.filter((k) => !en.has(k))
}
