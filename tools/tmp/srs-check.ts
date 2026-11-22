import { schedule, SRS_DEFAULT } from '../../src/shared/srs'
let st = SRS_DEFAULT
const seq = [2, 2, 2, 3, 1, 0, 2]
const now = 1_700_000_000_000
for (const g of seq) {
  const r = schedule(st, g, now)
  st = { ease: r.ease, intervalDays: r.intervalDays, reps: r.reps, lapses: r.lapses }
  console.log(`grade=${g} → 间隔=${r.intervalDays}d ease=${r.ease} reps=${r.reps} lapses=${r.lapses} 到期=+${Math.round((r.dueAt - now) / 60000)}min`)
}
const again = schedule({ ease: 2.5, intervalDays: 20, reps: 5, lapses: 0 }, 0, now)
console.log('长间隔答错 → 间隔重置为', again.intervalDays, '分钟级到期 =', Math.round((again.dueAt - now) / 60000))
