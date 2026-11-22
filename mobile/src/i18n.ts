// 手机端文案：直接复用桌面端的同一份词典（zh/en）
import { translate, type Lang } from '@shared/i18n'

let lang: Lang = (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'

export function setLang(l: Lang): void {
  lang = l
}
export function currentLang(): Lang {
  return lang
}
export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(lang, key, vars)
}
export function tError(msg: string): string {
  const m = /^@([a-zA-Z0-9_.]+)(?:\|(.*))?$/.exec(msg || '')
  if (!m) return msg
  const vars: Record<string, string> = {}
  if (m[2]) {
    for (const kv of m[2].split('&')) {
      const i = kv.indexOf('=')
      if (i > 0) vars[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1))
    }
  }
  return t(m[1], vars)
}
