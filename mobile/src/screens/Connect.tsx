import React, { useState } from 'react'
import { t } from '../i18n'
import { Btn, Spinner } from '../ui'
import { parsePairUrl, normalizeBaseUrl } from '../api'

export default function Connect({
  busy,
  error,
  onConnect,
  hasCache
}: {
  busy: boolean
  error: string | null
  onConnect: (baseUrl: string, code: string) => void
  hasCache: boolean
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const [code, setCode] = useState('')

  const submit = (): void => {
    const parsed = parsePairUrl(input)
    if (parsed && parsed.code) {
      onConnect(parsed.baseUrl, parsed.code)
      return
    }
    const base = normalizeBaseUrl(parsed?.baseUrl || input)
    onConnect(base, code.trim())
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6">
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-2xl text-white">W</div>
        <h1 className="text-lg font-semibold">{t('mobile.appName')}</h1>
        <p className="mt-2 max-w-xs text-xs leading-relaxed text-dim">{t('mobile.connectHint')}</p>
      </div>

      <div className="w-full max-w-sm space-y-3">
        {error && (
          <p className="rounded-xl border border-[var(--warn)]/40 bg-[var(--warn)]/10 px-3 py-2 text-[11px] leading-relaxed text-warn">
            {t('mobile.reconnectHint')}
          </p>
        )}
        <input
          className="inp"
          placeholder={t('mobile.urlPh')}
          value={input}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setInput(e.target.value)}
        />
        <input
          className="inp"
          placeholder={t('mobile.codePh')}
          value={code}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setCode(e.target.value)}
        />
        <Btn full disabled={busy || (!input.trim() && !code.trim())} onClick={submit}>
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Spinner size={14} /> {t('mobile.connecting')}
            </span>
          ) : (
            t('mobile.connect')
          )}
        </Btn>
        {error && <p className="text-center text-xs text-err">{error}</p>}
        {hasCache && <p className="text-center text-[11px] text-dim">{t('mobile.offline')}</p>}
        <p className="text-center text-[11px] leading-relaxed text-dim">{t('mobile.localOnly')}</p>
      </div>
    </div>
  )
}
