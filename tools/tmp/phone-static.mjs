// 极简静态服务器：把 mobile/dist 以 http://127.0.0.1:8801 提供（模拟 WebView origin）
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../mobile/dist')
const PORT = Number(process.argv[2] || 8801)
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }
http
  .createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0])
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel)
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404)
      res.end('nope')
      return
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  .listen(PORT, '127.0.0.1', () => console.log(`[phone-static] http://127.0.0.1:${PORT}`))
