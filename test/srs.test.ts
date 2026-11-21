// D1 的公式断言：不依赖 electron / better-sqlite3，可脱离原生模块单独跑
// 运行：node test/srs.test.ts （Node 24 原生擦除类型；也可 npm run test:srs）
import assert from 'node:assert/strict'
import {
  calculateNextReview,
  calculateR,
  computeBatchSize,
  MAX_PER_DAY,
  NEW_QUOTA,
  R_NEW,
  S_MIN,
  T_MAX_DAYS,
  WRONG_GAP
} from '../src/shared/srs.ts'
import { parseMarkdown } from '../src/shared/md.ts'

let passed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}`)
    throw e
  }
}

console.log('srs / md 断言')

test('新题首次答对：S 增长、间隔为正、rBefore = R_NEW', () => {
  const r = calculateNextReview(null, 0, 3)
  assert.equal(r.rBefore, R_NEW)
  assert.ok(r.s > 1, `S 应大于 1，实际 ${r.s}`)
  assert.ok(r.tNext > 0)
  assert.equal(r.d, 4.9)
})

test('连续答对 3 次：S 与间隔单调递增', () => {
  let state = { s: 1, d: 5 }
  let prevS = state.s
  let prevT = 0
  for (let i = 0; i < 3; i++) {
    const r = calculateNextReview(state, Math.max(0.5, prevT), 3)
    assert.ok(r.s > prevS, `第 ${i + 1} 次答对后 S 未增长: ${prevS} → ${r.s}`)
    assert.ok(r.tNext > prevT, `第 ${i + 1} 次答对后间隔未增长: ${prevT} → ${r.tNext}`)
    prevS = r.s
    prevT = r.tNext
    state = { s: r.s, d: r.d }
  }
})

test('连续答对 8 次：前 4 次对齐 3/7/16/35，第 6 次起撞上 T_MAX=180', () => {
  let state: { s: number; d: number } | null = null
  const gaps: number[] = []
  for (let i = 0; i < 8; i++) {
    const r = calculateNextReview(state, state ? gaps[i - 1] : 0, 3)
    gaps.push(Number(r.tNext.toFixed(2)))
    state = { s: r.s, d: r.d }
  }
  const expected = [2.78, 6.35, 14.67, 34.26]
  expected.forEach((v, i) => assert.ok(Math.abs(gaps[i] - v) < 0.05, `第 ${i + 1} 次间隔 ${gaps[i]} ≠ ${v}`))
  assert.ok(Math.abs(gaps[4] - 80.96) < 0.5, `第 5 次间隔 ${gaps[4]} 应约 81 天`)
  assert.equal(gaps[5], T_MAX_DAYS, `第 6 次应撞上 T_MAX=${T_MAX_DAYS}，实际 ${gaps[5]}`)
  assert.equal(gaps[7], T_MAX_DAYS)
  assert.ok(
    gaps.every((g) => g <= T_MAX_DAYS),
    `任何间隔都不得超过 ${T_MAX_DAYS} 天`
  )
})

test('触顶后 R 大于保持率：R ≡ p 只在未触顶时成立', () => {
  const s = 300
  const p = 0.85
  const uncapped = 9 * s * (1 / p - 1) // ≈ 477 天，会被 T_MAX 截断
  assert.ok(uncapped > T_MAX_DAYS)
  const cappedR = calculateR(T_MAX_DAYS, s)
  assert.ok(cappedR > p, `截断后 R=${cappedR.toFixed(3)} 应大于 p=${p}`)
})

test('积压扩容：超过 3K 才放大，且最多翻倍', () => {
  assert.equal(computeBatchSize(0, 5), 5, '没有积压')
  assert.equal(computeBatchSize(15, 5), 5, '恰好 3K 不触发')
  assert.equal(computeBatchSize(16, 5), 10, '刚过 3K → 2K')
  assert.equal(computeBatchSize(22, 5), 10, '22 道 → 2K 封顶')
  assert.equal(computeBatchSize(40, 5), 10, '40 道也只弹 10，不许越积压弹得越狠')
  assert.equal(computeBatchSize(4, 3), 3, 'K=3 时 4 道不触发')
  assert.equal(computeBatchSize(10, 3), 6, 'K=3 时 10 道 → 6')
  assert.ok(computeBatchSize(40, 5) <= 2 * 5, '上限恒为 2K')
})

test('连续答错 3 次：S 减半且不低于下限、D 递增且不超过 10', () => {
  let state = { s: 4, d: 5 }
  for (let i = 0; i < 3; i++) {
    const before = state
    const r = calculateNextReview(state, 2, 1)
    assert.ok(r.s <= before.s)
    assert.ok(r.d > before.d)
    assert.ok(r.d <= 10)
    assert.ok(r.tNext <= WRONG_GAP, '答"不会"后间隔应被 WRONG_GAP 压住')
    state = { s: r.s, d: r.d }
  }
})

test('S 触底：连续答错不会跌破 0.1', () => {
  let s = 1
  let d = 5
  for (let i = 0; i < 30; i++) {
    const r = calculateNextReview({ s, d }, 1, 1)
    s = r.s
    d = r.d
  }
  assert.equal(s, S_MIN)
})

test('保持率 p 越大间隔越短（且只影响之后的自评）', () => {
  const high = calculateNextReview({ s: 2, d: 5 }, 2, 3, 0.9)
  const low = calculateNextReview({ s: 2, d: 5 }, 2, 3, 0.8)
  assert.ok(high.tNext < low.tNext, `p=0.9 应比 p=0.8 间隔短: ${high.tNext} vs ${low.tNext}`)
})

test('R 公式：到期点 R 恰好等于保持率 p', () => {
  const s = 3
  const p = 0.85
  const tNext = 9 * s * (1 / p - 1)
  assert.ok(Math.abs(calculateR(tNext, s) - p) < 1e-9)
})

test('三档自评的方向正确', () => {
  const fuzzy = calculateNextReview({ s: 2, d: 5 }, 2, 2)
  assert.ok(fuzzy.s > 2 && fuzzy.s < 2.3, '模糊：S ×1.1')
  assert.equal(fuzzy.d, 5)
  const wrong = calculateNextReview({ s: 2, d: 5 }, 2, 1)
  assert.equal(wrong.s, 1)
  assert.equal(wrong.d, 5.3)
})

test('常量符合设计稿', () => {
  assert.equal(NEW_QUOTA, 2)
  assert.equal(MAX_PER_DAY, 2)
  assert.equal(WRONG_GAP, 0.25)
})

test('markdown：标准三段切分', () => {
  const text = '# 题目\n求 1+1\n# 答案\n2\n# 解析\n小学数学'
  const qs = parseMarkdown(text)
  assert.equal(qs.length, 1)
  assert.equal(qs[0].content, '求 1+1')
  assert.equal(qs[0].answer, '2')
  assert.equal(qs[0].analysis, '小学数学')
})

test('markdown：一个文件多块', () => {
  const text = '# 题目\nA\n# 答案\n1\n\n# 题目\nB\n# 答案\n2'
  const qs = parseMarkdown(text)
  assert.equal(qs.length, 2)
  assert.equal(qs[0].content, 'A')
  assert.equal(qs[1].content, 'B')
  assert.equal(qs[1].analysis, '')
})

test('markdown：没有「题目」行 → 整篇当题目', () => {
  const qs = parseMarkdown('随便一段话\n没有标记')
  assert.equal(qs.length, 1)
  assert.equal(qs[0].content, '随便一段话\n没有标记')
  assert.equal(qs[0].answer, '')
})

test('markdown：缺答案 → 空串，不报错', () => {
  const qs = parseMarkdown('# 题目\n只有题干')
  assert.equal(qs.length, 1)
  assert.equal(qs[0].answer, '')
})

test('markdown：CRLF 与首尾空白被归一', () => {
  const qs = parseMarkdown('\r\n# 题目\r\nA\r\n\r\n# 答案\r\n1\r\n')
  assert.equal(qs[0].content, 'A')
  assert.equal(qs[0].answer, '1')
})

console.log(`\n全部 ${passed} 条断言通过`)
