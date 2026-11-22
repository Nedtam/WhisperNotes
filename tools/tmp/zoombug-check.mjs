// 验证「笔记页整页被缩小」这个 bug 的修法：
//  ① 手机视口下页面不能横向溢出（横向溢出会让 WebView 触发"整页适配缩小"）
//  ② 页面外壳高度 = 可视视口高度（不能比屏幕矮，否则底部露黑）
//  ③ 底部页签栏贴在屏幕底部
//  ④ pinch 手势被 CSS touch-action 挡住；viewport meta 里 minimum-scale/maximum-scale/user-scalable 齐全
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (n, ok, extra = '') => {
  results.push({ n, ok })
  console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`)
}

function conn(port) {
  return (async () => {
    for (let i = 0; i < 120; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const page = l.find((t) => t.type === 'page')
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl)
          await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
          let id = 0
          const pend = new Map()
          const errs = []
          ws.addEventListener('message', (ev) => {
            const m = JSON.parse(ev.data)
            if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) }
            else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
          })
          const send = (method, params = {}) => new Promise((r) => { const i2 = ++id; pend.set(i2, r); ws.send(JSON.stringify({ id: i2, method, params })) })
          return {
            errs,
            send,
            evalJs: async (e) => {
              const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true })
              if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
              return r.result?.value
            }
          }
        }
      } catch { /* retry */ }
      await sleep(500)
    }
    throw new Error('cdp')
  })()
}

const LIB = {
  generatedAt: Date.now(),
  notebooks: [
    { id: 'nb-sem', name: '26-27 Semester A', parentId: null, color: '#38bdf8', ord: 0, hidden: false },
    { id: 'nb-mgt', name: 'MGT2324', parentId: 'nb-sem', color: '#f97316', ord: 1, hidden: false },
    { id: 'nb-sye', name: 'SYE2066', parentId: 'nb-sem', color: '#a3e635', ord: 2, hidden: false }
  ],
  notes: Array.from({ length: 8 }, (_, i) => ({
    id: `n${i}`,
    title: ['Lecture 2026-10-29 01:18', 'MGT2324 Week 7', 'MGT2324 Week 8', 'MGT2324 Week 6', 'MGT2324 Week 4', 'MGT2324 Week 5', 'SYE2066 Week 3', 'SYE2066 Week 2'][i],
    notebookId: i === 0 ? null : i < 6 ? 'nb-mgt' : 'nb-sye',
    updatedAt: Date.now() - i * 86400000,
    createdAt: Date.now() - i * 86400000,
    durationMs: 0,
    tags: [],
    excerpt: 'Lecture Notes: Entrepreneurship for Impact (MGT 2324, Class 9) **Lecture Date:** October 29, 2026 **Topic:** Scoop Case Study Wrap-up'
  })),
  transcripts: [{ id: 't0', title: 'Lecture 2026-10-08 14:48', source: 'import', sourceName: 'a.m4a', createdAt: Date.now(), durationMs: 1000, hasEnhanced: false, preview: 'So after 2023, I decided to stay off my comfort zone.' }]
}

const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'tools/tmp/mobile-shell.cjs'), '--remote-debugging-port=9560', '--user-data-dir=/tmp/wn-zoom'], { cwd: ROOT })
child.stderr.on('data', () => {})
setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } process.exit(1) }, 240000).unref?.()

try {
  const dc = await conn(9560)
  await sleep(2500)
  // 手机视口（390x844，dpr 3，mobile）——和真实安卓手机接近
  await dc.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })

  // 假装已配对 + 本地有一份文库（离线也能进笔记页）
  await dc.evalJs(`(async () => {
    localStorage.setItem('CapacitorStorage.wn.conn', JSON.stringify({ baseUrl: 'http://127.0.0.1:9', token: 'x', deviceId: 'dev' }))
    document.title = 'seeded'
    await new Promise((res) => {
      const open = indexedDB.open('whispernotes', 1)
      open.onupgradeneeded = () => { const db = open.result; if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv') }
      open.onsuccess = async () => {
        const db = open.result
        const tx = db.transaction('kv', 'readwrite')
        tx.objectStore('kv').put(${JSON.stringify(LIB)}, 'library')
        tx.oncomplete = () => res(true)
        tx.onerror = () => res(false)
      }
      open.onerror = () => res(false)
    })
    location.reload()
    return true
  })()`)
  await sleep(3500)

  // viewport meta 自检
  const meta = await dc.evalJs(`(() => { const m = document.querySelector('meta[name=viewport]'); return m ? m.getAttribute('content') : null })()`)
  rec('viewport 里锁定了最小/最大缩放且禁手势缩放', !!meta && /minimum-scale=1/.test(meta) && /maximum-scale=1/.test(meta) && /user-scalable=no/.test(meta), meta ?? 'null')

  // 进入笔记页
  const nav = await dc.evalJs(`(async () => {
    const b = document.querySelector('[data-tab="notes"]')
    if (b) b.click()
    await new Promise(r => setTimeout(r, 1200))
    return !!document.querySelector('[data-tab="notes"]')
  })()`)
  rec('手机壳里能进入笔记页', nav === true)

  const layout = await dc.evalJs(`(() => {
    const de = document.documentElement
    const body = document.body
    const bar = document.querySelector('[data-tab="notes"]')?.parentElement
    const root = document.getElementById('root')
    const barRect = bar ? bar.getBoundingClientRect() : null
    const rootRect = root ? root.getBoundingClientRect() : null
    const chips = [...document.querySelectorAll('div')].find((d) => getComputedStyle(d).overflowX === 'auto' && d.className.includes('gap-2'))
    return {
      innerW: window.innerWidth, innerH: window.innerHeight,
      docScrollW: de.scrollWidth, bodyScrollW: body.scrollWidth,
      rootH: rootRect ? Math.round(rootRect.height) : null,
      barBottom: barRect ? Math.round(barRect.bottom) : null,
      barTop: barRect ? Math.round(barRect.top) : null,
      vvScale: window.visualViewport ? window.visualViewport.scale : null,
      touchHtml: getComputedStyle(de).touchAction,
      touchBody: getComputedStyle(body).touchAction,
      overflowBody: getComputedStyle(body).overflow,
      chipsScrollable: chips ? chips.scrollWidth > chips.clientWidth : null
    }
  })()`)
  rec('页面没有横向溢出（不会触发整页适配缩小）', layout.docScrollW <= layout.innerW + 1 && layout.bodyScrollW <= layout.innerW + 1, `doc=${layout.docScrollW} body=${layout.bodyScrollW} innerW=${layout.innerW}`)
  rec('页面外壳高度 = 可视视口高度（不再只占半屏）', layout.rootH !== null && Math.abs(layout.rootH - layout.innerH) <= 2, `rootH=${layout.rootH} innerH=${layout.innerH}`)
  rec('底部页签栏贴在屏幕底部', layout.barBottom !== null && Math.abs(layout.barBottom - layout.innerH) <= 2, `barBottom=${layout.barBottom} innerH=${layout.innerH}`)
  rec('初始缩放为 1（整页没有被缩小）', layout.vvScale === null || Math.abs(layout.vvScale - 1) < 0.01, `scale=${layout.vvScale}`)
  rec('CSS 挡掉 pinch-zoom（touch-action 只允许平移）', layout.touchHtml === 'pan-x pan-y' && layout.touchBody === 'pan-x pan-y', `html=${layout.touchHtml} body=${layout.touchBody}`)
  rec('页面级滚动已关闭（滚动交给内层列表）', layout.overflowBody === 'hidden', `body overflow=${layout.overflowBody}`)
  rec('横向筛选条自身可横滑（内容不会被压出屏幕）', layout.chipsScrollable === true, `chipsScrollable=${layout.chipsScrollable}`)

  // 页面高度不随内容变高：把笔记数翻倍后 root 高度仍是视口高度
  const stable = await dc.evalJs(`(async () => {
    const de = document.documentElement
    const root = document.getElementById('root')
    return { scrollH: de.scrollHeight, innerH: window.innerHeight, rootH: Math.round(root.getBoundingClientRect().height) }
  })()`)
  rec('文档高度不超视口（整页不可上下滚动）', stable.scrollH <= stable.innerH + 2, `scrollH=${stable.scrollH} innerH=${stable.innerH}`)

  // ⑤ 页面本身拖不动（整页拖动会让轻点变成拖拽，按钮就点不到）
  const drag = await dc.evalJs(`(async () => {
    const de = document.documentElement
    window.scrollTo(0, 300)
    await new Promise(r => setTimeout(r, 200))
    const afterScroll = { x: window.scrollX, y: window.scrollY }
    // 底部页签中心点命中的是不是页签按钮本体（没有东西盖住它 / 没有偏移）
    const btn = document.querySelector('[data-tab="notes"]')
    const r = btn.getBoundingClientRect()
    const cx = Math.round(r.left + r.width / 2)
    const cy = Math.round(r.top + r.height / 2)
    const hit = document.elementFromPoint(cx, cy)
    const hitIsButton = !!hit && (hit === btn || btn.contains(hit) || hit.closest('[data-tab="notes"]') !== null)
    // 轻点（tap）能真的触发 click
    let clicked = false
    window.addEventListener('whisper-test-click', () => { clicked = true }, { once: true })
    btn.addEventListener('click', () => window.dispatchEvent(new Event('whisper-test-click')), { once: true })
    for (const type of ['touchstart', 'touchend', 'click']) {
      btn.dispatchEvent(new (type === 'click' ? MouseEvent : TouchEvent)(type === 'click' ? 'click' : type, { bubbles: true }))
    }
    await new Promise(r => setTimeout(r, 200))
    return { afterScroll, hitIsButton, clicked, touchOnButton: getComputedStyle(btn).touchAction, overscroll: getComputedStyle(de).overscrollBehavior }
  })()`)
  rec('页面整体拖不动（scrollTo 无效）', drag.afterScroll.y === 0 && drag.afterScroll.x === 0, JSON.stringify(drag.afterScroll))
  rec('页签按钮位置没有偏移（点的就是它）', drag.hitIsButton === true, `hitIsButton=${drag.hitIsButton}`)
  rec('轻点能触发按钮的 click（不会被拖拽吃掉）', drag.clicked === true, `clicked=${drag.clicked}`)
  rec('按钮去掉了双击缩放等待（touch-action: manipulation）', drag.touchOnButton === 'manipulation', `touch-action=${drag.touchOnButton}`)
  rec('关闭了页面级回弹/下拉刷新（overscroll-behavior: none）', drag.overscroll === 'none', `overscroll=${drag.overscroll}`)

  rec('无渲染层异常', dc.errs.length === 0, dc.errs.slice(0, 2).join(' | '))
} catch (e) {
  rec('脚本', false, String(e))
} finally {
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(600)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`)
  process.exit(0)
}
