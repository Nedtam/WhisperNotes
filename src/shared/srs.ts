// SM-2 间隔重复排程（电脑端与手机端共用同一份实现）
//  · 电脑端复习：主进程 reviewCard() 调它
//  · 手机端复习：本地先算（离线可复习），联网后把评分回传，电脑端用同一套算法落库
// 评分：0=again(忘了) 1=hard(有点难) 2=good(记得) 3=easy(太简单)
export interface SrsState {
  /** 熟练度系数，初始 2.5，最低 1.3 */
  ease: number
  /** 当前间隔（天），0 = 当天再来 */
  intervalDays: number
  /** 连续答对次数 */
  reps: number
  /** 遗忘次数 */
  lapses: number
}

export interface SrsResult extends SrsState {
  /** 下次到期时间戳 */
  dueAt: number
}

export const SRS_DEFAULT: SrsState = { ease: 2.5, intervalDays: 0, reps: 0, lapses: 0 }
/** 答错后多久再来（毫秒） */
export const SRS_RELEARN_MS = 10 * 60_000
const MAX_INTERVAL_DAYS = 3650

export function schedule(state: SrsState, grade: number, now = Date.now()): SrsResult {
  const g = Math.max(0, Math.min(3, Math.round(grade)))
  const q = g === 0 ? 2 : g === 1 ? 3 : g === 2 ? 4 : 5 // SM-2 quality
  let ease = state.ease ?? SRS_DEFAULT.ease
  let interval = state.intervalDays ?? 0
  let reps = state.reps ?? 0
  let lapses = state.lapses ?? 0

  if (q < 3) {
    reps = 0
    lapses += 1
    interval = 0
    ease = Math.max(1.3, ease - 0.2)
  } else {
    ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
    reps += 1
    if (reps === 1) interval = 1
    else if (reps === 2) interval = g === 1 ? 3 : 6
    else interval = Math.round(interval * ease * (g === 1 ? 0.6 : g === 3 ? 1.3 : 1))
    interval = Math.max(1, Math.min(MAX_INTERVAL_DAYS, interval))
  }

  const dueAt = interval <= 0 ? now + SRS_RELEARN_MS : now + interval * 86_400_000
  return { ease: Number(ease.toFixed(4)), intervalDays: interval, reps, lapses, dueAt }
}
