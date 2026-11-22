// 手机端本地库（IndexedDB）：把笔记/转写/卡片正文都存下来，离线也能看
// 选择 IndexedDB 而不是 SharedPreferences：笔记正文动辄几万字，KV 大对象放 IndexedDB 更合适，
// 且 WebView 里原生支持、无需额外原生插件。
const DB_NAME = 'whispernotes'
const STORE = 'kv'
let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexeddb-unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('idb-open-failed'))
  })
  return dbPromise
}

export async function put(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('idb-put-failed'))
  })
}

export async function get<T>(key: string): Promise<T | null> {
  const db = await openDb()
  return new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve((req.result as T) ?? null)
    req.onerror = () => reject(req.error ?? new Error('idb-get-failed'))
  })
}

export async function del(key: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('idb-del-failed'))
  })
}

/** 批量写入（一个事务，几百条也很快） */
export async function putMany(entries: Array<[string, unknown]>): Promise<void> {
  if (!entries.length) return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const os = tx.objectStore(STORE)
    for (const [k, v] of entries) os.put(v, k)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('idb-putmany-failed'))
  })
}

/** 列出前缀匹配的键（用于统计已下载数量） */
export async function keysWithPrefix(prefix: string): Promise<string[]> {
  const db = await openDb()
  return new Promise<string[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAllKeys()
    req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String).filter((k) => k.startsWith(prefix)))
    req.onerror = () => reject(req.error ?? new Error('idb-keys-failed'))
  })
}

/** 清空本地库（断开连接时用） */
export async function clearAll(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('idb-clear-failed'))
  })
}

export const K = {
  library: 'library',
  syncState: 'syncState',
  note: (id: string): string => `note/${id}`,
  transcript: (id: string): string => `tr/${id}`,
  cards: 'cards'
}
