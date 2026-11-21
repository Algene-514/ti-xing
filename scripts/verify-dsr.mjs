// DSR 数值验算（不依赖 electron）：看连续答对 / 答错时 S 与间隔怎么走
import { calculateNextReview, calculateR, R_NEW, R_BONUS_K, S_MAX } from '../src/shared/srs.ts'

function series(label, rating, times, startS = 1, startD = 5) {
  let s = startS
  let d = startD
  let tNext = 0.5
  const rows = []
  for (let i = 1; i <= times; i++) {
    const r = calculateNextReview(i === 1 ? null : { s, d }, i === 1 ? 0 : tNext, rating)
    s = r.s
    d = r.d
    tNext = r.tNext
    rows.push(`第${i}次 S=${r.s} D=${r.d} 间隔=${r.tNext.toFixed(2)}天`)
  }
  console.log(`\n== ${label} ==`)
  console.log(rows.join('\n'))
}

console.log(`R_BONUS_K=${R_BONUS_K}  S_MAX=${S_MAX}  R_NEW=${R_NEW}`)
series('新题 → 连续答对 8 次', 3, 8)
series('连续答错 4 次（起点 S=4）', 1, 4, 4, 5)
series('连续模糊 4 次', 2, 4, 1, 5)

console.log('\n== 到期点 R 恒等于 p（这也是弹窗不显示 R 的原因） ==')
for (const p of [0.8, 0.85, 0.9]) {
  const s0 = 2
  const t = 9 * s0 * (1 / p - 1)
  console.log(`p=${p}  T_next=${t.toFixed(2)}天  R(T_next)=${calculateR(t, s0).toFixed(4)}`)
}
