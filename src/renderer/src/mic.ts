// 麦克风/音频输入设备工具：权限探测、设备枚举、选中设备解析
export interface AudioInput {
  deviceId: string
  label: string
  groupId?: string
}

export interface MicPerm {
  granted: boolean
  state: 'granted' | 'denied' | 'prompt' | 'unsupported'
}

/** 请求麦克风访问（会触发系统/浏览器权限询问）。返回是否已授权。 */
export async function requestMicPermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    stream.getTracks().forEach((t) => t.stop())
    return true
  } catch {
    return false
  }
}

/** 只读权限状态（safari 可能不支持 permissions.query('microphone')） */
export async function micPermission(): Promise<MicPerm> {
  try {
    const pm = navigator.permissions as unknown as {
      query: (d: { name: string }) => Promise<{ state: PermissionState }>
    }
    if (pm?.query) {
      const st = await pm.query({ name: 'microphone' as PermissionName })
      if (st.state === 'granted') return { granted: true, state: 'granted' }
      if (st.state === 'denied') return { granted: false, state: 'denied' }
      return { granted: false, state: 'prompt' }
    }
  } catch {
    /* fall through */
  }
  // 无 permissions API：通过一次静默试探判断
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    stream.getTracks().forEach((t) => t.stop())
    return { granted: true, state: 'granted' }
  } catch {
    return { granted: false, state: 'denied' }
  }
}

/** 枚举所有可用输入设备（需先获得权限才有 label）。 */
export async function listAudioInputs(): Promise<AudioInput[]> {
  const out: AudioInput[] = []
  try {
    const devs = await navigator.mediaDevices.enumerateDevices()
    for (const d of devs) {
      if (d.kind !== 'audioinput') continue
      // macOS/Chromium 会把同一物理设备以 default/communications/具体 id 列三次，去重
      if (out.some((x) => x.deviceId === d.deviceId)) continue
      out.push({ deviceId: d.deviceId, label: d.label || 'Microphone', groupId: d.groupId })
    }
  } catch {
    /* ignore */
  }
  return out
}

/** 根据偏好 deviceId 找当前将使用的输入设备描述。 */
export function resolveActiveMic(inputs: AudioInput[], preferredDeviceId: string): AudioInput | null {
  if (!inputs.length) return null
  if (preferredDeviceId) {
    const hit = inputs.find((i) => i.deviceId === preferredDeviceId)
    if (hit) return hit
  }
  // 默认：优先 default 组，其次第一个
  const def = inputs.find((i) => i.label.includes('default') || i.deviceId === 'default')
  return def ?? inputs[0]
}

/** 把一个真实 stream deviceId（getSettings() 返回值）映射成展示 label */
export async function labelForDevice(realDeviceId: string): Promise<string> {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices()
    const d = devs.find((x) => x.kind === 'audioinput' && x.deviceId === realDeviceId)
    if (d?.label) return d.label
  } catch {
    /* ignore */
  }
  return 'Default microphone'
}
