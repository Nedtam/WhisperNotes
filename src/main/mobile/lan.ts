// 局域网地址探测：给手机连接用的 http://<ip>:<port>
import * as os from 'node:os'

function rank(ip: string): number {
  if (ip.startsWith('192.168.')) return 0
  if (ip.startsWith('10.')) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
  if (ip.startsWith('169.254.')) return 9 // 链路本地，基本不可用，放最后
  return 5
}

/** 本机所有非内部 IPv4（按“最可能是家庭/校园网”排序） */
export function lanIPv4(): string[] {
  const out: string[] = []
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address)
    }
  }
  return Array.from(new Set(out)).sort((a, b) => rank(a) - rank(b))
}

export function primaryLanIPv4(): string | null {
  return lanIPv4()[0] ?? null
}
