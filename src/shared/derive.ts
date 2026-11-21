import type { QuestionRow, QuestionView, Status } from './types'
import { calculateR } from './srs'

const DAY = 86_400_000

/** 本地时区「今天 00:00」的毫秒数（不用 UTC） */
export function startOfToday(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 状态（优先级从上到下，先命中先显示）：
 *   新题     n = 0
 *   已逾期   n > 0 且 next_due < 今天 00:00
 *   今日到期 n > 0 且 next_due <= now
 *   未到期   其余
 */
export function statusOf(q: QuestionRow, now: number): Status {
  if (q.n === 0) return '新题'
  if (q.next_due == null) return '今日到期'
  if (q.next_due < startOfToday(now)) return '已逾期'
  if (q.next_due <= now) return '今日到期'
  return '未到期'
}

/** 新题没有 Δt，R 未定义 → null（界面不显示 R=0.00） */
export function rOf(q: QuestionRow, now: number): number | null {
  if (q.n === 0 || q.last_reviewed_at == null) return null
  const deltaDays = Math.max(0, (now - q.last_reviewed_at) / DAY)
  return calculateR(deltaDays, q.s)
}

export function daysOverdue(q: QuestionRow, now: number): number {
  if (q.next_due == null) return 0
  return Math.max(0, (now - q.next_due) / DAY)
}

export function daysToDue(q: QuestionRow, now: number): number | null {
  if (q.next_due == null) return null
  return (q.next_due - now) / DAY
}

export function toView(q: QuestionRow, now: number): QuestionView {
  return {
    ...q,
    status: statusOf(q, now),
    r: rOf(q, now),
    daysOverdue: daysOverdue(q, now),
    daysToDue: daysToDue(q, now)
  }
}

/** 「待复习」不是状态值，只是筛选/统计口径 = 已逾期 ∪ 今日到期 */
export function isPending(v: QuestionView): boolean {
  return v.status === '已逾期' || v.status === '今日到期'
}

export function matchFilter(v: QuestionView, filter: 'all' | 'today' | 'overdue'): boolean {
  if (filter === 'overdue') return v.status === '已逾期'
  if (filter === 'today') return isPending(v)
  return true
}

/** 按 R 升序（到期最久的在前）；新题 R 为 null，排在最后 */
export function compareByR(a: QuestionView, b: QuestionView): number {
  const ra = a.r ?? Number.POSITIVE_INFINITY
  const rb = b.r ?? Number.POSITIVE_INFINITY
  if (ra === rb) return (a.next_due ?? 0) - (b.next_due ?? 0)
  return ra - rb
}

export function fmtDays(v: number): string {
  if (!Number.isFinite(v)) return '-'
  if (v < 1) return `${Math.round(v * 24)} 小时`
  return `${v.toFixed(1)} 天`
}

export function fmtDueLabel(v: QuestionView): string {
  if (v.status === '新题') return '新题'
  if (v.status === '已逾期') return `已逾期 ${Math.max(1, Math.floor(v.daysOverdue))} 天`
  if (v.status === '今日到期') return '今日到期'
  if (v.daysToDue == null) return '未到期'
  return v.daysToDue < 1 ? `${Math.max(1, Math.round(v.daysToDue * 24))} 小时后` : `${Math.round(v.daysToDue)} 天后`
}
