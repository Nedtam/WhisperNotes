import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import ChildApp from './ChildApp'
import { ErrorBoundary, installGlobalErrorHooks } from './ErrorBoundary'

const params = new URLSearchParams(window.location.search)
const isChild = params.get('child') === '1'

// 全局异常先落盘（写 logs/renderer-errors.log），再交给 ErrorBoundary 显示可操作卡片
installGlobalErrorHooks()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>{isChild ? <ChildApp noteId={params.get('id') ?? ''} /> : <App />}</ErrorBoundary>
  </React.StrictMode>
)
