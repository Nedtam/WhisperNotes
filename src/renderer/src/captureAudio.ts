// 麦克风采集：getUserMedia + AudioWorklet → 16k 附近 PCM 批次回调
const WORKLET_SRC = `
class WNPcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch[0]) {
      this.port.postMessage(ch[0].slice());
    }
    return true;
  }
}
registerProcessor('wn-pcm', WNPcmProcessor);
`.trim()

export interface CaptureHandle {
  stop: () => Promise<void>
  rate: number
  /** 实际使用的输入设备 label（用于界面提示） */
  micLabel: string
}

/** 启动采集。onBatch 收到 <1s 的 float32 批次；onLevel 每帧给 RMS(0..1)。deviceId 空 = 系统默认。 */
export async function startCapture(
  onBatch: (batch: Float32Array, rate: number) => void,
  onLevel: (v: number) => void,
  deviceId?: string
): Promise<CaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {})
    },
    video: false
  })

  // 解析实际使用的设备名（用于录音页展示）
  let micLabel = 'Default microphone'
  try {
    const realId = stream.getAudioTracks()[0]?.getSettings().deviceId
    if (realId) {
      const devs = await navigator.mediaDevices.enumerateDevices()
      const hit = devs.find((d) => d.kind === 'audioinput' && d.deviceId === realId)
      if (hit?.label) micLabel = hit.label
    }
  } catch {
    /* ignore */
  }

  let ctx: AudioContext
  try {
    ctx = new AudioContext({ sampleRate: 16000 })
  } catch {
    ctx = new AudioContext()
  }
  await ctx.resume()
  const rate = ctx.sampleRate || 16000

  const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  await ctx.audioWorklet.addModule(url)

  const source = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'wn-pcm')
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048

  source.connect(node)
  source.connect(analyser)
  // 保持 context 运行
  node.connect(ctx.destination)

  let pending: number[] = []
  let raf = 0
  const timeData = new Uint8Array(analyser.fftSize)

  const flush = (): void => {
    if (pending.length >= 1600) {
      const batch = Float32Array.from(pending.slice(0, Math.floor(pending.length / 1600) * 1600))
      onBatch(batch, rate)
      pending = pending.slice(batch.length)
    }
  }

  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const arr = e.data
    if (arr) {
      // pending 里避免无限增长：最多留 2 秒
      pending.push(...Array.from(arr))
      if (pending.length > 32000) pending = pending.slice(pending.length - 32000)
      flush()
    }
  }

  const levelLoop = (): void => {
    raf = requestAnimationFrame(levelLoop)
    analyser.getByteTimeDomainData(timeData)
    let sum = 0
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128
      sum += v * v
    }
    onLevel(Math.min(1, Math.sqrt(sum / timeData.length) * 3.2))
  }
  levelLoop()

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(raf)
    node.port.onmessage = null
    try {
      source.disconnect()
      node.disconnect()
      analyser.disconnect()
    } catch {
      /* ignore */
    }
    stream.getTracks().forEach((t) => t.stop())
    URL.revokeObjectURL(url)
    await ctx.close().catch(() => undefined)
  }

  return { stop, rate, micLabel }
}
