import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.whispernotes.review',
  appName: 'WhisperNotes',
  webDir: 'dist',
  // http scheme：手机端要访问局域网里的 http://192.168.x.x，避免 https→http 的混合内容拦截
  server: { androidScheme: 'http' },
  android: { allowMixedContent: true },
  plugins: {
    // 震动/键盘等默认即可
  }
}

export default config
