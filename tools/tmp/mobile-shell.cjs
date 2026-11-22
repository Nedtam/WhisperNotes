// 用 Electron 当"手机浏览器"：加载手机端 web 构建，验证它对着真实电脑端服务的完整流程
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 420,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  // 默认 file://；设 WN_PHONE_URL 时从 http origin 加载（与 Capacitor WebView 的 origin 行为一致：
  // 跨源请求会带 Origin 头、localStorage 按 origin 隔离）
  const url = process.env.WN_PHONE_URL
  if (url) win.loadURL(url)
  else win.loadFile(path.join(__dirname, '..', '..', 'mobile', 'dist', 'index.html'))
})
app.on('window-all-closed', () => app.quit())
