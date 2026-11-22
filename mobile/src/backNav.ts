// 安卓返回键的决策逻辑（纯函数，便于单测；真机上由 Capacitor backButton 事件驱动）
export type BackAction = 'close-reader' | 'to-notes' | 'exit'

export function nextBackAction(state: { hasReader: boolean; tab: string }): BackAction {
  if (state.hasReader) return 'close-reader'
  if (state.tab !== 'notes') return 'to-notes'
  return 'exit'
}
