import React, { useCallback, useEffect, useRef, useState } from 'react'
import { App as CapApp } from '@capacitor/app'
import { Preferences } from '@capacitor/preferences'
import { t, tError, setLang } from './i18n'
import { notebookColor } from '@shared/notebookColor'
import Connect from './screens/Connect'
import NotesList from './screens/NotesList'
import TranscriptsList from './screens/TranscriptsList'
import Reader from './screens/Reader'
import SettingsScreen from './screens/SettingsScreen'
import Flashcards from './screens/Flashcards'
import type { CardScope } from '@shared/cardScope'
import { nextBackAction } from './backNav'
import { Toast, Spinner, IconBook, IconCards, IconGear, IconWave } from './ui'
import {
  cachedLibrary,
  cachedNote,
  cachedTranscript,
  clearConn,
  discover,
  rebaseConn,
  fetchLibrary,
  fetchNote,
  fetchTranscript,
  flushReviews,
  loadQueue,
  loadConn,
  pair,
  syncAll,
  syncState,
  localCounts,
  wipeLocal,
  type SyncProgress,
  type SyncState,
  parsePairUrl,
  ping,
  Unauthorized,
  type Conn,
  type Library,
  type NoteFull,
  type TrFull
} from './api'

type Tab = 'notes' | 'transcripts' | 'cards' | 'settings'

const PREF = { tab: 'wn.tab', notesScope: 'wn.notesScope', cardsScope: 'wn.cardsScope', lang: 'wn.lang' }
type ReaderState =
  | { kind: 'note'; id: string; title: string; md: string; source: string; loading: boolean; error: string | null; showSource: boolean }
  | { kind: 'transcript'; id: string; title: string; md: string; raw: string; enhanced: string | null; showEnhanced: boolean; loading: boolean; error: string | null }

function resolveLang(sel: 'system' | 'zh' | 'en'): 'zh' | 'en' {
  if (sel === 'zh' || sel === 'en') return sel
  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export default function App(): React.JSX.Element {
  const [booted, setBooted] = useState(false)
  const [conn, setConn] = useState<Conn | null>(null)
  const [lib, setLib] = useState<Library | null>(null)
  const [online, setOnline] = useState(false)
  const [tab, setTab] = useState<Tab>('notes')
  const [busy, setBusy] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [reader, setReader] = useState<ReaderState | null>(null)
  const [pendingReviews, setPendingReviews] = useState(0)
  // 分类选择由 App 持有：切换页面/重启后都保留（用户反馈"返回后选择丢失"）
  const [notesScope, setNotesScope] = useState<string>('all')
  const [cardsScope, setCardsScope] = useState<CardScope>({ kind: 'all' })
  // 离线数据状态与下载进度
  const [syncInfo, setSyncInfo] = useState<SyncState | null>(null)
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)
  /** 正在"找回电脑"（换 IP 后的自动发现） */
  const [recovering, setRecovering] = useState(false)
  const [recoverNote, setRecoverNote] = useState('')
  const [lang, setLangState] = useState<'system' | 'zh' | 'en'>('system')
  /** 是否已完成"读取上次选择"（读完才允许把当前值写回去，避免默认值覆盖用户选择） */
  const hydratedRef = useRef(false)

  const flash = useCallback((kind: 'ok' | 'err', text: string): void => {
    setToast({ kind, text })
    window.setTimeout(() => setToast(null), 2600)
  }, [])

  /**
   * 找回电脑：电脑换 IP 后（DHCP/换 Wi-Fi），用配对时存下的候选地址 + 本地网段扫描
   * 自动找到它并把连接切过去 —— 这样就不用每次都重新扫码配对了。
   */
  const recover = useCallback(
    async (c: Conn): Promise<Conn | null> => {
      if (!c.deskId) return null
      setRecovering(true)
      try {
        const url = await discover(c, (phase, done, total) => {
          setRecoverNote(phase === 'candidates' ? t('mobile.findingDesk') : t('mobile.scanningDesk', { done, total }))
        })
        if (!url) return null
        const next = await rebaseConn(c, url)
        setConn(next)
        setOnline(true)
        flash('ok', t('mobile.foundDesk'))
        return next
      } catch {
        return null
      } finally {
        setRecovering(false)
        setRecoverNote('')
      }
    },
    [flash]
  )

  /** 全量下载到手机（离线可用）：文库 + 所有笔记正文 + 转写正文 + 卡片 */
  const runSync = useCallback(
    async (c: Conn | null = conn, silent = false): Promise<void> => {
      if (!c) return
      try {
        setSyncProgress({ phase: 'library', done: 0, total: 1 })
        const st = await syncAll(c, (p) => setSyncProgress(p))
        setSyncInfo(st)
        setOnline(true)
        setSyncProgress(null)
        // 同步完成后刷新内存里的文库
        const lib2 = await cachedLibrary()
        if (lib2) setLib(lib2)
        if (!silent) flash('ok', t('mobile.syncDone', { notes: st.notes, transcripts: st.transcripts, cards: st.cards }))
      } catch (e) {
        // 先别急着报"连不上"：可能是电脑换了 IP —— 自动找回一次再决定
        const found = await recover(c)
        if (found) {
          try {
            const st = await syncAll(found, (p) => setSyncProgress(p))
            setSyncInfo(st)
            setOnline(true)
            setSyncProgress(null)
            const lib2 = await cachedLibrary()
            if (lib2) setLib(lib2)
            if (!silent) flash('ok', t('mobile.syncDone', { notes: st.notes, transcripts: st.transcripts, cards: st.cards }))
            return
          } catch {
            /* 仍然失败 → 走下面的离线分支 */
          }
        }
        void e
        setOnline(false)
        setSyncProgress(null)
        if (!silent) flash('err', t('mobile.recoveredFail'))
      }
    },
    [conn, flash, recover]
  )

  const sync = useCallback(
    async (c: Conn | null = conn): Promise<void> => {
      if (!c) return
      setBusy(true)
      try {
        await runSync(c, true)
        const fresh = await cachedLibrary()
        if (fresh) {
          setLib(fresh)
          flash('ok', t('mobile.synced', { notes: fresh.notes.length, transcripts: fresh.transcripts.length }))
        }
      } catch (e) {
        if (e instanceof Unauthorized) {
          await clearConn()
          setConn(null)
          setLib(null)
          flash('err', t('mobile.unreachable'))
        } else {
          setOnline(false)
          flash('err', t('mobile.unreachable'))
        }
      } finally {
        setBusy(false)
      }
    },
    [conn, flash, runSync]
  )

  // 复习记录补传：只要连着电脑且在线就尝试（不依赖当前在哪个页签，
  // 否则重载后停在笔记页会一直不回传——这正是离线复习补传失败的坑）
  const flushNow = useCallback(async (): Promise<void> => {
    if (!conn || !online) return
    try {
      const r = await flushReviews(conn)
      setPendingReviews(r.remaining)
      if (r.flushed > 0) {
        flash('ok', t('mobile.reviewsFlushed', { n: r.flushed }))
        void sync(conn)
      }
    } catch {
      /* 下次再试 */
    }
  }, [conn, online, flash, sync])

  useEffect(() => {
    void flushNow()
  }, [flushNow])

  // 离线时每 15 秒探一次：电脑端服务回来就自动切回在线并触发补传
  useEffect(() => {
    if (!conn || online) return
    const t0 = window.setInterval(() => {
      void (async () => {
        if (await ping(conn.baseUrl)) {
          setOnline(true)
          void sync(conn)
        }
      })()
    }, 15000)
    return () => window.clearInterval(t0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, online])

  const doConnect = useCallback(
    async (baseUrl: string, code: string): Promise<void> => {
      setConnectError(null)
      setBusy(true)
      try {
        if (!baseUrl) throw new Error('badUrl')
        if (!code) throw new Error('noCode')
        const c = await pair(baseUrl, code)
        // 新配对先清掉旧本地内容：否则上一台电脑的笔记库会残留在本地，
        // 分类里会出现"笔记本对不上笔记"的空列表（旧 id 混新 id）。
        try {
          await wipeLocal()
        } catch {
          /* 清理失败不阻断配对 */
        }
        setConn(c)
        const fresh = await fetchLibrary(c)
        setLib(fresh)
        setOnline(true)
        flash('ok', t('mobile.synced', { notes: fresh.notes.length, transcripts: fresh.transcripts.length }))
        // 配对后立刻把全部内容下载到手机（之后不在电脑旁也能用）
        void runSync(c, true)
      } catch (e) {
        const msg = (e as Error).message
        setConnectError(
          msg === 'badCode'
            ? t('mobile.badCode')
            : msg === 'noCode'
              ? t('mobile.noCode')
              : msg === 'badUrl'
                ? t('mobile.unreachable')
                : t('mobile.connectFail', { msg: tError(msg) })
        )
      } finally {
        setBusy(false)
      }
    },
    [flash]
  )

  // 启动：恢复连接 + 缓存内容 + 探活 + 深链（扫码打开 App）
  useEffect(() => {
    void (async () => {
      // 恢复上次的选择与语言
      try {
        const [tab0, nb0, cs0, lg0, st0] = await Promise.all([
          Preferences.get({ key: PREF.tab }),
          Preferences.get({ key: PREF.notesScope }),
          Preferences.get({ key: PREF.cardsScope }),
          Preferences.get({ key: PREF.lang }),
          syncState()
        ])
        if (tab0.value) setTab(tab0.value as Tab)
        if (nb0.value) setNotesScope(nb0.value)
        if (cs0.value) {
          const parsed = JSON.parse(cs0.value) as { kind: string; id?: string; notes?: string[] }
          setCardsScope(
            parsed.kind === 'nb' && parsed.id
              ? { kind: 'nb', id: parsed.id, notes: new Set(parsed.notes ?? []) }
              : ({ kind: parsed.kind === 'none' ? 'none' : 'all' } as CardScope)
          )
        }
        if (lg0.value) {
          setLangState(lg0.value as 'system' | 'zh' | 'en')
          setLang(resolveLang(lg0.value as 'system' | 'zh' | 'en'))
        }
        if (st0) setSyncInfo(st0)
      } catch {
        /* 首次启动没有这些键 */
      }
      // 读完了才允许落盘（见上面的说明）
      hydratedRef.current = true
      // 本地内容先加载（离线也能秒开）
      const c = await loadConn()
      setPendingReviews((await loadQueue()).length)
      const cached = await cachedLibrary()
      if (cached) setLib(cached)
      if (c) {
        setConn(c)
        setBooted(true)
        const alive = await ping(c.baseUrl)
        setOnline(alive)
        if (alive) {
          // 连上就整份同步（离线时完全不动，用本地内容）
          void runSync(c, true)
        } else {
          // 连不上：多半是电脑换了 IP → 自动找回，找到就同步（不用重新扫码）
          void (async () => {
            const found = await recover(c)
            if (found) void runSync(found, true)
          })()
        }
      } else {
        setBooted(true)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 回到前台自动同步；在前台且在线时每 60 秒增量同步一次（失败才提示，成功静默）
  useEffect(() => {
    if (!conn) return
    const off = CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return
      void (async () => {
        if (await ping(conn.baseUrl, 2500)) {
          setOnline(true)
          void runSync(conn, true)
        } else {
          const found = await recover(conn)
          if (found) void runSync(found, true)
        }
      })()
    })
    return () => {
      void off.then((h) => h.remove())
    }
  }, [conn, recover, runSync])

  useEffect(() => {
    if (!conn || !online) return
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void runSync(conn, true)
    }, 60_000)
    return () => window.clearInterval(id)
  }, [conn, online, runSync])

  // 安卓返回键：先关阅读页 → 再回上一个页签 → 最后才退出
  useEffect(() => {
    const off = CapApp.addListener('backButton', () => {
      const action = nextBackAction({ hasReader: !!reader, tab })
      if (action === 'close-reader') setReader(null)
      else if (action === 'to-notes') setTab('notes')
      else void CapApp.exitApp()
    })
    return () => {
      void off.then((h) => h.remove())
    }
  }, [reader, tab])

  useEffect(() => {
    const off = CapApp.addListener('appUrlOpen', ({ url }) => {
      const p = parsePairUrl(url)
      if (p?.code) void doConnect(p.baseUrl, p.code)
    })
    void CapApp.getLaunchUrl().then((r) => {
      if (r?.url) {
        const p = parsePairUrl(r.url)
        if (p?.code) void doConnect(p.baseUrl, p.code)
      }
    })
    return () => {
      void off.then((h) => h.remove())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 选择/页签/语言变化 → 落盘（下次打开还原）
  // 关键：必须等"读取上次选择"完成后再允许写入。否则挂载时默认值（system/all）会先写进去，
  // 把用户上次的选择冲掉 —— 表现就是"切了中文，下次打开又变回英文"（时序竞态）。
  useEffect(() => {
    if (!hydratedRef.current) return
    void Preferences.set({ key: PREF.tab, value: tab })
  }, [tab])
  useEffect(() => {
    if (!hydratedRef.current) return
    void Preferences.set({ key: PREF.notesScope, value: notesScope })
  }, [notesScope])
  useEffect(() => {
    if (!hydratedRef.current) return
    void Preferences.set({
      key: PREF.cardsScope,
      value: JSON.stringify({ kind: cardsScope.kind, id: cardsScope.kind === 'nb' ? cardsScope.id : undefined, notes: cardsScope.kind === 'nb' ? Array.from(cardsScope.notes) : [] })
    })
  }, [cardsScope])
  useEffect(() => {
    if (!hydratedRef.current) return
    void Preferences.set({ key: PREF.lang, value: lang })
  }, [lang])

  /** 切语言：必须在这里同步调用 setLang（放 effect 里会因为不再触发重渲染而看起来"没生效"） */
  const changeLang = useCallback((l: 'system' | 'zh' | 'en'): void => {
    setLang(resolveLang(l))
    setLangState(l)
    void Preferences.set({ key: PREF.lang, value: l }) // 立即落盘，避免依赖 effect 时序
  }, [])

  const openNote = useCallback(
    async (id: string): Promise<void> => {
      const meta = lib?.notes.find((n) => n.id === id)
      setReader({ kind: 'note', id, title: meta?.title ?? '', md: '', source: '', loading: true, error: null, showSource: false })
      try {
        const full: NoteFull = conn ? await fetchNote(conn, id) : ((await cachedNote(id)) as NoteFull)
        if (!full) throw new Error('offline')
        setReader({ kind: 'note', id, title: full.title, md: full.noteMd, source: full.sourceText ?? '', loading: false, error: null, showSource: false })
      } catch (e) {
        const cached = await cachedNote(id)
        if (cached) {
          setReader({ kind: 'note', id, title: cached.title, md: cached.noteMd, source: cached.sourceText ?? '', loading: false, error: null, showSource: false })
        } else {
          setReader({
            kind: 'note',
            id,
            title: meta?.title ?? '',
            md: '',
            source: '',
            loading: false,
            error: t('mobile.loadFail', { msg: tError((e as Error).message) }),
            showSource: false
          })
        }
      }
    },
    [conn, lib]
  )

  const openTranscript = useCallback(
    async (id: string): Promise<void> => {
      const meta = lib?.transcripts.find((n) => n.id === id)
      setReader({ kind: 'transcript', id, title: meta?.title ?? '', md: '', raw: '', enhanced: null, showEnhanced: false, loading: true, error: null })
      try {
        const full: TrFull | null = conn ? await fetchTranscript(conn, id) : await cachedTranscript(id)
        if (!full) throw new Error('offline')
        const useEnhanced = !!full.enhanced
        setReader({
          kind: 'transcript',
          id,
          title: full.title,
          md: (useEnhanced ? full.enhanced! : full.raw).replace(/\n/g, '\n\n'),
          raw: full.raw,
          enhanced: full.enhanced,
          showEnhanced: useEnhanced,
          loading: false,
          error: null
        })
      } catch (e) {
        const cached = await cachedTranscript(id)
        if (cached) {
          setReader({
            kind: 'transcript',
            id,
            title: cached.title,
            md: (cached.enhanced ?? cached.raw).replace(/\n/g, '\n\n'),
            raw: cached.raw,
            enhanced: cached.enhanced,
            showEnhanced: !!cached.enhanced,
            loading: false,
            error: null
          })
        } else {
          setReader({
            kind: 'transcript',
            id,
            title: meta?.title ?? '',
            md: '',
            raw: '',
            enhanced: null,
            showEnhanced: false,
            loading: false,
            error: t('mobile.loadFail', { msg: tError((e as Error).message) })
          })
        }
      }
    },
    [conn, lib]
  )

  if (!booted) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-dim">
        <Spinner size={14} /> {t('mobile.loading')}
      </div>
    )
  }

  if (!conn) {
    return (
      <>
        <Connect busy={busy} error={connectError} hasCache={!!lib} onConnect={(b, c) => void doConnect(b, c)} />
        <Toast msg={toast} />
      </>
    )
  }

  if (reader) {
    if (reader.kind === 'note') {
      return (
        <Reader
          title={reader.title}
          md={reader.md}
          loading={reader.loading}
          error={reader.error}
          sourceText={reader.source}
          sourceLabel={t('notes.rawToggle')}
          onBack={() => setReader(null)}
          onToggleSource={() => setReader(reader.kind === 'note' ? { ...reader, showSource: !reader.showSource } : reader)}
        />
      )
    }
    return (
      <Reader
        title={reader.title}
        md={reader.md}
        loading={reader.loading}
        error={reader.error}
        sourceText={reader.raw}
        sourceLabel={reader.showEnhanced ? t('mobile.raw') : t('mobile.enhanced')}
        onBack={() => setReader(null)}
        onToggleSource={() => {
          if (reader.kind !== 'transcript') return
          const next = !reader.showEnhanced
          if (next && !reader.enhanced) {
            flash('err', t('mobile.noEnhanced'))
            return
          }
          setReader({
            ...reader,
            showEnhanced: next,
            md: (next ? reader.enhanced ?? reader.raw : reader.raw).replace(/\n/g, '\n\n')
          })
        }}
      />
    )
  }

  const counts = { notes: lib?.notes.length ?? 0, transcripts: lib?.transcripts.length ?? 0 }

  return (
    <div className="flex h-full flex-col">
      {/* 同步进度：首次配对后会自动整份下载，之后离线可用 */}
      {syncProgress && syncProgress.phase !== 'done' && (
        <div className="shrink-0 border-b border-accent/20 bg-accent-soft px-4 py-2 text-[11px] text-accent">
          <div className="flex items-center gap-2">
            <Spinner size={12} />
            <span className="min-w-0 flex-1 truncate">
              {syncProgress.phase === 'library'
                ? t('mobile.downloadFirst')
                : t('mobile.syncing', { done: syncProgress.done, total: syncProgress.total, title: syncProgress.title ?? '' })}
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${syncProgress.total ? Math.round((syncProgress.done / syncProgress.total) * 100) : 5}%` }}
            />
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {!lib ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-dim">
            <Spinner size={14} /> {t('mobile.loading')}
          </div>
        ) : (
          <>
            {/* 四个页签常驻挂载：切页面/进详情返回后选择都还在 */}
            <div className="h-full w-full min-w-0" style={{ display: tab === 'notes' ? 'flex' : 'none' }}>
              <NotesList lib={lib} onOpen={(id) => void openNote(id)} nb={notesScope} onNb={setNotesScope} />
            </div>
            <div className="h-full w-full min-w-0" style={{ display: tab === 'transcripts' ? 'flex' : 'none' }}>
              <TranscriptsList lib={lib} onOpen={(id) => void openTranscript(id)} />
            </div>
            <div className="h-full w-full min-w-0" style={{ display: tab === 'cards' ? 'flex' : 'none' }}>
              <Flashcards
                conn={conn}
                online={online}
                pending={pendingReviews}
                scope={cardsScope}
                onScope={setCardsScope}
                library={lib ? { notebooks: lib.notebooks, notes: lib.notes.map((n) => ({ id: n.id, title: n.title, notebookId: n.notebookId })) } : null}
                onToast={flash}
                onQueued={() => void flushNow()}
                onNeedLibrary={() => {
                  // 本地笔记库缺失/落后时自愈：重新拉文库（不阻塞界面）
                  if (lib && lib.notes.length === 0) void sync(conn)
                }}
              />
            </div>
            <div className="h-full w-full min-w-0" style={{ display: tab === 'settings' ? 'flex' : 'none' }}>
              <SettingsScreen
                conn={conn}
                online={online}
                counts={counts}
                busy={busy}
                sync={syncInfo}
                lang={lang}
                onLang={changeLang}
                onSyncAll={() => void runSync(conn)}
                onWipe={() => {
                  void wipeLocal()
                  setSyncInfo(null)
                  setLib(null)
                  flash('ok', t('mobile.wipe'))
                }}
                onSync={() => void sync()}
                onRecover={() => {
                  void (async () => {
                    if (!conn) return
                    const found = await recover(conn)
                    if (found) await runSync(found, true)
                    else flash('err', t('mobile.recoveredFail'))
                  })()
                }}
                recoverNote={recoverNote}
                recovering={recovering}
                onDisconnect={() => {
                  void clearConn()
                  setConn(null)
                  setLib(null)
                }}
              />
            </div>
          </>
        )}
      </div>

      <nav className="flex shrink-0 items-stretch border-t border-edge bg-surface pb-[env(safe-area-inset-bottom)]">
        {(
          [
            { id: 'notes' as Tab, label: t('nav.notes'), icon: <IconBook /> },
            { id: 'transcripts' as Tab, label: t('nav.transcripts'), icon: <IconWave /> },
            { id: 'cards' as Tab, label: t('nav.cards'), icon: <IconCards /> },
            { id: 'settings' as Tab, label: t('nav.settings'), icon: <IconGear /> }
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            data-tab={item.id}
            onClick={() => setTab(item.id)}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] transition ${
              tab === item.id ? 'text-accent' : 'text-dim'
            }`}
          >
            <span className="leading-none">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      <Toast msg={toast} />
    </div>
  )
}
