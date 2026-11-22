// 验证「导入录音后、整理按钮上方那条 · 转成笔记 / 先只存转写」在窄列下不会顶出容器
//   做法：把中栏拖到最窄（150px，App 允许的最小值）、再在正常宽度各验一遍
//   判据：按钮 rect 不越过父容器、按钮内文字不溢出（scrollWidth<=clientWidth）、竖排不重叠
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
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

const UD = '/tmp/wn-narrow'
fs.rmSync(UD, { recursive: true, force: true })
fs.mkdirSync(UD, { recursive: true })
const child = spawn(path.join(ROOT, 'node_modules/.bin/electron'), [path.join(ROOT, 'out/main/index.js'), '--remote-debugging-port=9564', `--user-data-dir=${UD}`], { cwd: ROOT })
child.stderr.on('data', () => {})
setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } process.exit(1) }, 240000).unref?.()

const probe = async (dc, midW) => {
  return await dc.evalJs(`(async () => {
    const st = window.__wnStore.getState()
    st.setMidW(${midW})
    st.setTab('capture')
    // 造一条"导入完成、等待转笔记"的状态（就是用户看到这条 bar 的时机）
    st.setPendingNoteSources([{ id: 'x1', title: 'Lecture 2026-11-20 14:48（一篇名字很长的讲座录音）', text: 'hello world' }])
    // 再塞两条排队中的音频（把引擎标记成"录音中"，否则队列会被立刻消费掉）
    st.setEngine({ state: 'recording' })
    st.enqueueImport({ path: '/tmp/fake-audio-1.m4a', name: '这一段文件名特别特别长的录音文件.m4a' })
    st.enqueueImport({ path: '/tmp/fake-audio-2.m4a', name: '第二个文件也不短.m4a' })
    await new Promise((r) => setTimeout(r, 900))
    window.__wnStore.getState().setImporting(false)
    const bar = document.querySelector('[data-note-ready="1"]')
    if (!bar) return { error: 'no-bar' }
    const btns = [...bar.querySelectorAll('button')]
    const cont = bar.getBoundingClientRect()
    const rows = btns.map((b) => {
      const r = b.getBoundingClientRect()
      const label = b.querySelector('span')
      return {
        text: (b.innerText || '').trim(),
        left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
        inside: r.right <= cont.right + 1 && r.left >= cont.left - 1,
        // 两种"出界"要分开看：
        //  · 按钮自身被内容撑爆（scrollWidth > clientWidth）→ 真 bug
        //  · 文字放不下被省略号截断（truncate 生效）→ 可接受，不会画出按钮外
        btnOverflow: b.scrollWidth > b.clientWidth + 1,
        textClipped: label ? label.scrollWidth > label.clientWidth + 1 : false,
        textOverflow: label
          ? label.scrollWidth > label.clientWidth + 1 && getComputedStyle(label).textOverflow !== 'ellipsis'
          : b.scrollWidth > b.clientWidth + 1
      }
    })
    // 两个按钮是否各自整行（竖排，不重叠也不并排）
    const stacked = rows.length === 2 ? Math.abs(rows[0].left - rows[1].left) <= 1 && rows[1].width > 0 : false
    // 整条 bar 是否在中间栏内
    const col = bar.parentElement.getBoundingClientRect()
    const queueBar = document.querySelector('[data-import-queue="1"]')
    const q = queueBar ? queueBar.getBoundingClientRect() : null
    window.__wnStore.getState().setEngine({ state: 'idle' })
    return {
      midW: ${midW},
      cont: { left: Math.round(cont.left), right: Math.round(cont.right) },
      col: { left: Math.round(col.left), right: Math.round(col.right) },
      barInside: bar.getBoundingClientRect().right <= col.right + 1,
      queueInside: q ? q.right <= col.right + 1 : null,
      queueTextOverflow: queueBar ? queueBar.scrollWidth > queueBar.clientWidth + 1 : null,
      rows, stacked,
      oldButtons: [
        (() => { const b = [...document.querySelectorAll('button')].find((x) => /整理成笔记/.test(x.textContent || '')); if (!b) return null; const r = b.getBoundingClientRect(); return { right: Math.round(r.right), overflow: b.scrollWidth > b.clientWidth + 1 } })(),
        (() => { const b = [...document.querySelectorAll('button')].find((x) => /清空/.test(x.textContent || '')); if (!b) return null; const r = b.getBoundingClientRect(); return { right: Math.round(r.right), overflow: b.scrollWidth > b.clientWidth + 1 } })()
      ]
    }
  })()`)
}

try {
  const dc = await conn(9564)
  await sleep(4500)
  for (const [label, midW] of [['最窄 150px', 150], ['偏窄 200px', 200], ['正常 300px', 300]]) {
    const r = await probe(dc, midW)
    if (r.error) { rec(`${label}：找到那条 bar`, false, JSON.stringify(r)); continue }
    const bad = r.rows.filter((x) => !x.inside || x.btnOverflow || x.textOverflow)
    rec(`${label}：两个按钮都在容器内`, bad.length === 0, JSON.stringify(r.rows))
    rec(
      `${label}：按钮没被文字撑爆（放不下就省略号，不会画出框外）`,
      r.rows.every((x) => x.btnOverflow === false && x.textOverflow === false),
      JSON.stringify(r.rows.map((x) => ({ t: x.text, clip: x.textClipped, over: x.btnOverflow })))
    )
    rec(`${label}：两个按钮整行竖排（不再并排挤压）`, r.stacked === true, JSON.stringify(r.rows.map((x) => [x.left, x.width])))
    rec(`${label}：整条提示在中间栏内`, r.barInside === true, JSON.stringify({ cont: r.cont, col: r.col }))
    if (r.queueInside !== null) rec(`${label}：排队提示也不越界`, r.queueInside === true && r.queueTextOverflow === false, JSON.stringify({ inside: r.queueInside, overflow: r.queueTextOverflow }))
    if (r.oldButtons?.length === 2 && r.oldButtons.every(Boolean)) {
      rec(`${label}：下方「整理成笔记/清空」也没被挤坏`, r.oldButtons.every((b) => b.overflow === false), JSON.stringify(r.oldButtons))
    }
  }
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
