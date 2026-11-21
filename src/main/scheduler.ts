import type Database from 'better-sqlite3'
import type { QuestionRow, QuizEmptyReason } from '../shared/types'
import { calculateR, MAX_PER_DAY, NEW_QUOTA } from '../shared/srs'

const DAY = 86_400_000

export interface Picked {
  items: QuestionRow[]
  reason?: QuizEmptyReason
}

function startOfToday(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 分两池再拼一批（设计稿 §4.3）：
 *   A 池 = 到期旧题（按 R 升序 = 逾期最久的在前），B 池 = 新题（按 id 升序，先进先出）
 *   A 非空时本批新题 ≤ NEW_QUOTA；A 为空时新题可用满 K
 *   单题当日复习（rating 1–3）≥ MAX_PER_DAY 的不进候选
 */
export function pickCandidates(db: Database.Database, now: number, k: number): Picked {
  const today0 = startOfToday(now)

  // 当日计数：没记录过的题必须带默认 0（用 Map 兜底）
  const cntRows = db
    .prepare(
      `SELECT question_id AS qid, COUNT(*) AS c FROM review_log
        WHERE reviewed_at >= ? AND rating BETWEEN 1 AND 3
        GROUP BY question_id`
    )
    .all(today0) as { qid: number; c: number }[]
  const cnt = new Map<number, number>(cntRows.map((r) => [r.qid, r.c]))
  const c = (id: number): number => cnt.get(id) ?? 0

  // A 池：到期旧题。next_due 必须非空，否则 SQL 比较恒为 false，题会静默消失
  const allDue = db
    .prepare('SELECT * FROM question WHERE n > 0 AND next_due IS NOT NULL AND next_due <= ?')
    .all(now) as QuestionRow[]

  const overdueRows = allDue.filter((q) => c(q.id) < MAX_PER_DAY)
  const dueCapped = allDue.length > 0 && overdueRows.length === 0

  overdueRows.sort((x, y) => rOf(x, now) - rOf(y, now))

  const allNew = db.prepare('SELECT * FROM question WHERE n = 0 ORDER BY id ASC').all() as QuestionRow[]
  const newRows = allNew.filter((q) => c(q.id) < MAX_PER_DAY)
  const newCapped = allNew.length > 0 && newRows.length === 0

  const takeA = overdueRows.slice(0, k)
  // A 池非空时本批新题 ≤ NEW_QUOTA（设计稿规则 4 + 验收：有旧题到期时新题不超过 2 道）
  const quota = takeA.length === 0 ? k : Math.min(NEW_QUOTA, k - takeA.length)
  const takeB = newRows.slice(0, Math.min(quota, k - takeA.length))

  const items = takeA.concat(takeB)
  if (items.length > 0) return { items }

  // 0 候选要区分两种原因（否则用户会以为数据丢了）
  if (dueCapped || newCapped) return { items: [], reason: 'capped' }
  return { items: [], reason: 'empty' }
}

function rOf(q: QuestionRow, now: number): number {
  if (q.last_reviewed_at == null) return Number.POSITIVE_INFINITY
  return calculateR(Math.max(0, (now - q.last_reviewed_at) / DAY), q.s)
}
