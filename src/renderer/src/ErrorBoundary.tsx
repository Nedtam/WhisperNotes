// 界面异常兜底：React 渲染错误 + 全局 window.onerror / unhandledrejection
// - 写盘到 logs/renderer-errors.log（下次能查到根因）
// - 显示可操作的错误卡片（重载界面 / 复制详情），而不是白屏或直接消失
import React from 'react'
import { t } from './i18n'
import { copyText } from './clipboard'

interface State {
  error: Error | null
}

export function reportRendererError(message: string, stack?: string, source?: string): void {
  try {
    window.api?.reportError?.({ message, stack, source })
  } catch {
    /* ignore */
  }
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportRendererError(error.message, `${error.stack ?? ''}\n\nComponent stack:${info.componentStack ?? ''}`, 'react-render')
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const detail = `${error.message}\n${error.stack ?? ''}`
    return (
      <div className="flex h-screen items-center justify-center p-8">
        <div className="panel w-full max-w-lg rounded-2xl p-5">
          <h2 className="text-base font-semibold text-err">{t('app.crashTitle')}</h2>
          <p className="mt-2 text-xs leading-relaxed text-dim">{t('app.rendererError')}</p>
          <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-surface-2 p-2 text-[10px] leading-4 whitespace-pre-wrap text-dim">
            {detail.slice(0, 4000)}
          </pre>
          <div className="mt-4 flex items-center gap-2">
            <button className="btn-primary !px-4 !py-2 text-xs" onClick={() => window.location.reload()}>
              {t('app.reloadUi')}
            </button>
            <button
              className="btn-ghost !px-4 !py-2 text-xs"
              onClick={() => {
                void copyText(detail)
              }}
            >
              {t('app.copyDetail')}
            </button>
          </div>
        </div>
      </div>
    )
  }
}

/** 挂全局兜底（只在入口调用一次） */
export function installGlobalErrorHooks(): void {
  window.addEventListener('error', (e) => {
    reportRendererError(e.message || String(e.error ?? ''), e.error?.stack, `window.error @${e.filename}:${e.lineno}`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | undefined
    reportRendererError(r?.message ?? String(e.reason ?? ''), r?.stack, 'unhandledrejection')
  })
}
