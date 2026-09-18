// Preload：安全桥接 contextBridge
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { WhisperNotesApi, OrganizeRequest, PolishRequest } from '../shared/types'

function on<T>(channel: string, cb: (p: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: WhisperNotesApi = {
  rec: {
    start: (payload) => ipcRenderer.invoke('rec:start', payload ?? {}) as Promise<{ ok: boolean; error?: string; sessionId?: string }>,
    pause: () => ipcRenderer.invoke('rec:pause') as Promise<{ ok: boolean; error?: string }>,
    resume: () => ipcRenderer.invoke('rec:resume') as Promise<{ ok: boolean; error?: string }>,
    stop: () => ipcRenderer.invoke('rec:stop') as Promise<{ ok: boolean; error?: string; result?: import('../shared/types').RecordingResult }>,
    importFile: (path) => ipcRenderer.invoke('rec:importFile', path) as Promise<{ ok: boolean; error?: string; segmentCount?: number; fileName?: string; stopped?: boolean }>,
    importPause: () => ipcRenderer.invoke('rec:importPause') as Promise<{ ok: boolean }>,
    importResume: () => ipcRenderer.invoke('rec:importResume') as Promise<{ ok: boolean }>,
    importStop: () => ipcRenderer.invoke('rec:importStop') as Promise<{ ok: boolean }>,
    pushPcm: (chunk, rate) => {
      ipcRenderer.send('audio:pcm', { rate, data: new Float32Array(chunk) })
    }
  },
  onAsrSegment: (cb) => on('asr:segment', cb),
  onAsrDraft: (cb) => on('asr:draft', cb),
  onAsrState: (cb) => on('asr:state', cb),
  onImportProgress: (cb) => on('import:progress', cb),
  onCloseRequest: (cb) => on('app:closeRequest', cb),
  quitConfirmed: () => ipcRenderer.invoke('app:quitConfirmed'),
  reportError: (payload) => ipcRenderer.send('app:rendererError', payload),
  onLlamaProgress: (cb) => on('llm:progress', cb),
  onOrganizeJob: (cb) => on('llm:job', cb),
  onOrganizeDone: (cb) => on('llm:jobDone', cb),
  onOrganizeError: (cb) => on('llm:jobError', cb),
  onModelProgress: (cb) => on('model:progress', cb),
  onModelError: (cb) => on('model:error', cb),

  notes: {
    list: () => ipcRenderer.invoke('notes:list'),
    get: (id) => ipcRenderer.invoke('notes:get', id),
    save: (draft) => ipcRenderer.invoke('notes:save', draft),
    remove: (id) => ipcRenderer.invoke('notes:remove', id),
    setNotebook: (id, notebookId) => ipcRenderer.invoke('notes:setNotebook', id, notebookId),
    reorder: (ids) => ipcRenderer.invoke('notes:reorder', ids),
    exportMd: (id) => ipcRenderer.invoke('notes:export', id),
    search: (q) => ipcRenderer.invoke('notes:search', q),
    openChild: (id) => ipcRenderer.invoke('notes:openChild', id),
    emitEdit: (d) => ipcRenderer.send('note:edit', d),
    broadcastEdit: (d) => ipcRenderer.send('note:broadcast', d)
  },
  notebooks: {
    list: () => ipcRenderer.invoke('notebooks:list'),
    create: (name, parentId) => ipcRenderer.invoke('notebooks:create', name, parentId ?? null),
    rename: (id, name) => ipcRenderer.invoke('notebooks:rename', id, name),
    remove: (id) => ipcRenderer.invoke('notebooks:remove', id),
    reorder: (updates) => ipcRenderer.invoke('notebooks:reorder', updates),
    setHidden: (id, hidden) => ipcRenderer.invoke('notebooks:setHidden', id, hidden)
  },
  onNoteSync: (cb) => on('note:sync', cb),

  transcriptions: {
    list: () => ipcRenderer.invoke('transcription:list'),
    get: (id) => ipcRenderer.invoke('transcription:get', id),
    save: (draft) => ipcRenderer.invoke('transcription:save', draft),
    remove: (id) => ipcRenderer.invoke('transcription:remove', id)
  },

  dialog: {
    pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
    pickAudio: () => ipcRenderer.invoke('dialog:pickAudio') as Promise<{ path: string; fileName: string } | null>,
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder') as Promise<string | null>
  },

  slides: {
    pick: () => ipcRenderer.invoke('slides:pick'),
    parse: (p) => ipcRenderer.invoke('slides:parse', p),
    unlock: (p, pw) => ipcRenderer.invoke('slides:unlock', p, pw),
    useForSession: (p, pw) => ipcRenderer.invoke('slides:useForSession', p, pw),
    fromFile: async (f: unknown) => {
      const file = f as Parameters<typeof webUtils.getPathForFile>[0]
      try {
        return webUtils.getPathForFile(file) ?? null
      } catch {
        return null
      }
    }
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    resetDailyUsage: () => ipcRenderer.invoke('settings:resetUsage')
  },

  llm: {
    organize: (req: OrganizeRequest) => ipcRenderer.invoke('llm:organize', req),
    organizeStart: (req: OrganizeRequest) => ipcRenderer.invoke('llm:organizeStart', req),
    organizeCancel: (jobId: string) => ipcRenderer.invoke('llm:organizeCancel', jobId),
    polish: (req: PolishRequest) => ipcRenderer.invoke('llm:polish', req),
    validateKey: () => ipcRenderer.invoke('llm:validate')
  },

  models: {
    catalog: () => ipcRenderer.invoke('models:catalog'),
    status: () => ipcRenderer.invoke('models:status'),
    download: (id) => ipcRenderer.invoke('models:download', id),
    cancel: (file) => ipcRenderer.invoke('models:cancel', file),
    remove: (file) => ipcRenderer.invoke('models:remove', file)
  },

  sys: {
    probeWhisper: () => ipcRenderer.invoke('sys:probeWhisper'),
    openExternal: (url) => ipcRenderer.invoke('sys:openExternal', url),
    copyText: (text: string) => ipcRenderer.invoke('sys:copyText', text) as Promise<boolean>
  },

  meta: {
    dailyUsage: () => ipcRenderer.invoke('meta:dailyUsage'),
    version: () => ipcRenderer.invoke('meta:version')
  }
}

contextBridge.exposeInMainWorld('api', api)
