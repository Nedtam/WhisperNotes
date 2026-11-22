// 拖入文件决策的纯函数单测（录音中拖文件 / 空闲拖文件 / 课件 / 无关文件）
import { fileClass, isDocForNote, pickDocForNote, planDrop, nextQueued } from '../../src/renderer/src/importDrop'

let pass = 0
let total = 0
const rec = (n: string, ok: boolean, detail = ''): void => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? '✅' : '❌'} ${n}${detail ? ' — ' + detail : ''}`)
}

rec('识别录音文件（m4a/mp3/wav/mp4/aiff）', ['a.m4a', 'b.mp3', 'c.wav', 'd.mp4', 'e.AIFF'].every((p) => fileClass(p) === 'audio'))
rec('识别幻灯片/文档（pdf/pptx 归 slides，docx/txt/md 归 textdoc）', ['x.pdf', 'y.PPTX'].every((p) => fileClass(p) === 'slides') && ['a.docx', 'b.txt', 'c.md'].every((p) => fileClass(p) === 'textdoc'))
rec('其它文件忽略', fileClass('data.csv') === 'other' && fileClass('') === 'other')
rec('笔记页：PDF/PPTX/DOCX/TXT/MD 都能转笔记', ['a.pdf', 'b.pptx', 'c.docx', 'd.txt', 'e.md'].every(isDocForNote))
rec('笔记页：音频/表格/图片不当作可转文档', !isDocForNote('a.m4a') && !isDocForNote('b.csv') && !isDocForNote('c.png'))

const idle = planDrop(['/tmp/a.m4a', '/tmp/slides.pdf', '/tmp/x.txt'], false)
rec('空闲时：音频立刻转写', idle.importNow.length === 1 && idle.importNow[0].endsWith('a.m4a'), JSON.stringify(idle.importNow))
rec('空闲时：课件照旧作为参考', idle.decks.length === 1, JSON.stringify(idle.decks))
rec('空闲时：无关文件忽略', idle.ignored.length === 1)

const busy = planDrop(['/tmp/a.m4a', '/tmp/b.mp3'], true)
rec('录音中：音频全部排队（不抢占 whisper 引擎）', busy.queued.length === 2 && busy.importNow.length === 0, JSON.stringify(busy))
rec('录音中：排队顺序 = 拖入顺序', busy.queued[0].endsWith('a.m4a') && busy.queued[1].endsWith('b.mp3'))
rec('录音中拖入课件依然立即生效（不排队）', planDrop(['/tmp/slides.pdf'], true).decks.length === 1)

rec('队列消费顺序为先进先出', nextQueued(['1', '2']) === '1' && nextQueued([]) === undefined)
rec('笔记页从一堆拖入文件里挑第一篇能转的文档', pickDocForNote(['a.m4a', 'b.csv', 'c.docx']) === 'c.docx' && pickDocForNote(['a.m4a']) === null)

console.log(`\n结果: ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
