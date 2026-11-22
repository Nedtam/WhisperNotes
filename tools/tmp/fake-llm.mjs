// 假 LLM：OpenAI 兼容，返回罐头闪卡 JSON（不动用户配额，完全可复现）
import * as http from 'node:http'
const PORT = Number(process.argv[2] || 8799)
let calls = 0
const server = http.createServer((req, res) => {
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    calls++
    const parsed = JSON.parse(body || '{}')
    const user = parsed.messages?.find((m) => m.role === 'user')?.content ?? ''
    const title = /Note title: (.+)/.exec(user)?.[1] ?? 'note'
    // 从提示里读出期望张数
    const want = Number(/with (\d+) cards/.exec(user)?.[1] ?? 5)
    // 故意混入低质量/行政内容，用来验证"考试导向"过滤确实生效
    const cards = [
      { front: `[${title.slice(0, 16)}] 采样率与奈奎斯特频率的关系？`, back: '最高可表示频率 = 采样率/2。', importance: 5, kind: 'formula', quote: '奈奎斯特频率 = 采样率/2', tags: ['采样'] },
      { front: 'VAD 与静音检测的区别是什么？', back: 'VAD 判断语音活动，静音检测只看能量阈值。', importance: 4, kind: 'comparison', quote: 'VAD 是语音活动检测', tags: ['音频'] },
      { front: '量化误差如何在工程上降低？', back: '提高位深或使用抖动（dithering）。', importance: 4, kind: 'application', quote: '量化误差', tags: ['量化'] },
      { front: `[${title.slice(0, 16)}] 作业什么时候交？`, back: '下周五 23:59。', importance: 5, kind: 'fact', quote: '作业下周五交', tags: ['行政'] },
      { front: '老师办公室在哪里？', back: 'B 座 302。', importance: 4, kind: 'fact', quote: '办公室 B302', tags: ['行政'] },
      { front: '怎么安装 Audacity？', back: '去官网下载安装包。', importance: 4, kind: 'procedure', quote: '安装 Audacity', tags: ['工具'] },
      { front: `[${title.slice(0, 16)}] 课堂提到了什么颜色？`, back: '蓝色。', importance: 1, kind: 'fact', quote: '蓝色', tags: ['琐事'] }
    ].slice(0, Math.max(4, Math.min(want + 3, 7)))
    if (process.env.FAKE_LLM_EMPTY === '1' && calls === 1) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '```json\n' + JSON.stringify(cards) + '\n```' }, finish_reason: 'stop' }],
        usage: { total_tokens: 100 }
      })
    )
  })
})
server.listen(PORT, '127.0.0.1', () => console.log(`[fake-llm] listening on ${PORT}`))
