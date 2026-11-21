// v1.1.0 免打扰纯函数断言（跨午夜是重点）
// 运行：node test/dnd.test.ts
import assert from 'node:assert/strict'
import { dndResumeAt, fmtHHMM, inDnd, localDateKey, parseHHMM } from '../src/shared/dnd.ts'

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

const at = (h: number, m = 0): Date => {
  const d = new Date(2026, 10, 8, h, m, 0, 0)
  return d
}

console.log('dnd 断言')

test('parseHHMM 解析与非法值', () => {
  assert.equal(parseHHMM('22:00'), 1320)
  assert.equal(parseHHMM('08:00'), 480)
  assert.equal(parseHHMM('8:5'), 485)
  assert.equal(parseHHMM(' 0:00 '), 0)
  assert.equal(parseHHMM('24:00'), -1)
  assert.equal(parseHHMM('12:60'), -1)
  assert.equal(parseHHMM(''), -1)
  assert.equal(parseHHMM('abc'), -1)
})

test('fmtHHMM 规范化补零', () => {
  assert.equal(fmtHHMM('8:5'), '08:05')
  assert.equal(fmtHHMM('22:00'), '22:00')
  assert.equal(fmtHHMM('bad'), 'bad')
})

test('同日区间：22:00–23:00', () => {
  assert.equal(inDnd(at(21, 59), '22:00', '23:00'), false)
  assert.equal(inDnd(at(22, 0), '22:00', '23:00'), true)
  assert.equal(inDnd(at(22, 59), '22:00', '23:00'), true)
  assert.equal(inDnd(at(23, 0), '22:00', '23:00'), false) // 左闭右开
})

test('跨午夜：22:00–08:00 的边界', () => {
  assert.equal(inDnd(at(21, 59), '22:00', '08:00'), false)
  assert.equal(inDnd(at(22, 0), '22:00', '08:00'), true)
  assert.equal(inDnd(at(23, 59), '22:00', '08:00'), true)
  assert.equal(inDnd(at(0, 0), '22:00', '08:00'), true)
  assert.equal(inDnd(at(7, 59), '22:00', '08:00'), true)
  assert.equal(inDnd(at(8, 0), '22:00', '08:00'), false)
  assert.equal(inDnd(at(12, 0), '22:00', '08:00'), false)
})

test('start == end 视为空区间（不打扰）', () => {
  assert.equal(inDnd(at(12, 0), '10:00', '10:00'), false)
  assert.equal(inDnd(at(10, 0), '10:00', '10:00'), false)
})

test('非法时间不打扰', () => {
  assert.equal(inDnd(at(12, 0), 'bad', '08:00'), false)
  assert.equal(inDnd(at(12, 0), '22:00', '99:99'), false)
})

test('dndResumeAt：夜里算明天，凌晨算今天', () => {
  const night = at(22, 30)
  const resume = new Date(dndResumeAt(night, '08:00'))
  assert.equal(resume.getDate(), night.getDate() + 1)
  assert.equal(resume.getHours(), 8)
  assert.equal(resume.getMinutes(), 0)

  const dawn = at(6, 0)
  const resume2 = new Date(dndResumeAt(dawn, '08:00'))
  assert.equal(resume2.getDate(), dawn.getDate())
  assert.equal(resume2.getHours(), 8)
})

test('dndResumeAt：整点边界不早于 now', () => {
  const exactly = at(8, 0)
  const resume = new Date(dndResumeAt(exactly, '08:00'))
  assert.ok(resume.getTime() > exactly.getTime(), '恰好等于结束时刻应顺延到明天')
})

test('localDateKey 本地日期串', () => {
  assert.equal(localDateKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
  assert.equal(localDateKey(new Date(2026, 10, 8, 0, 0)), '2026-11-08')
})

console.log(`\n全部 ${passed} 条 dnd 断言通过`)
