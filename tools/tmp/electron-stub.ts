// 仅用于离线单测：把 main 侧用到的 electron API 换成无害实现
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (s: string): string => s,
  decryptString: (s: string): string => s
}
export const app = { getPath: (): string => '/tmp/wn-test', setName: (): void => {} }
export const ipcMain = { on: (): void => {}, handle: (): void => {} }
export const clipboard = { writeText: (): void => {} }
export const BrowserWindow = class {}
