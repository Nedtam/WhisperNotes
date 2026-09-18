// 独立笔记窗：所见即所得 Markdown 编辑，与主窗实时双向同步
import React, { useEffect, useRef, useState } from 'react'
import MdEditor from './MdEditor'
import { Spinner } from './ui'
import { t } from './i18n'

export default function ChildApp({ noteId }: { noteId: string }): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [state, setState] = useState<'load' | 'ready' | 'err'>('load')
  const textRef = useRef('')
  const skipSyncRef = useRef(true)
  const [sentTick, setSentTick] = useState(0)
  // 最近一次由外部同步写入的内容（用于抑制“回显”：收到主窗/他窗内容后不再当成本窗编辑发回）
  const lastExternalRef = useRef('')

  useEffect(() => {
    void (async () => {
      try {
        const n = await window.api.notes.get(noteId)
        if (!n) throw new Error(t('child.noteMissing'))
        setTitle(n.title)
        setText(n.noteMd)
        textRef.current = n.noteMd
        skipSyncRef.current = false
        setState('ready')
      } catch (e) {
        setState('err')
      }
    })()
    const off = window.api.onNoteSync((p) => {
      if (p.id !== noteId) return
      lastExternalRef.current = JSON.stringify({ title: p.title, noteMd: p.noteMd })
      if (textRef.current !== p.noteMd) {
        textRef.current = p.noteMd
        setText(p.noteMd)
      }
      if (title !== p.title) setTitle(p.title)
    })
    return off
  }, [noteId])

  // 编辑 → 防抖广播（他人窗会同步，本窗由主进程排除回显）
  useEffect(() => {
    if (skipSyncRef.current) return
    if (state !== 'ready') return
    const timer = setTimeout(() => {
      // 内容与最近一次外部同步相同 → 视为回显，不发（避免把主窗未保存内容写入库）
      const current = JSON.stringify({ title, noteMd: text })
      if (current === lastExternalRef.current) return
      window.api.notes.emitEdit({ id: noteId, title, noteMd: text })
      setSentTick((x) => x + 1)
    }, 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, title, state])

  if (state === 'load') {
    return (
      <div className="flex h-screen items-center justify-center text-[color:var(--dim)]">
        <Spinner /> {t('child.loading')}
      </div>
    )
  }
  if (state === 'err') {
    return <div className="p-6 text-err">{t('child.openErr')}</div>
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center gap-2 border-b border-edge/60 px-4 py-2">
        <input
          className="inp !py-1.5 text-base font-semibold"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('child.titlePh')}
        />
        <span className="shrink-0 text-[10px] text-[color:var(--dim)]">
          {sentTick > 0 ? t('child.syncedCount', { n: sentTick }) : t('child.autoSave')}
        </span>
      </div>
      <MdEditor
        value={text}
        onChange={(md) => {
          textRef.current = md
          setText(md)
        }}
      />
    </div>
  )
}
