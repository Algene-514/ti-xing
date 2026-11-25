export type Rating = 1 | 2 | 3

export type Status = '新题' | '已逾期' | '今日到期' | '未到期'

export type FilterKey = 'all' | 'today' | 'overdue'

export interface QuestionRow {
  id: number
  content: string
  answer: string
  analysis: string | null
  n: number
  s: number
  d: number
  last_reviewed_at: number | null
  next_due: number | null
  created_at: number
  updated_at: number
}

export interface QuestionView extends QuestionRow {
  status: Status
  /** 可提取性；新题为 null（不显示 R=0.00） */
  r: number | null
  /** 逾期天数（>=0） */
  daysOverdue: number
  /** 距到期天数；新题为 null */
  daysToDue: number | null
  /** v1.2 标签（列表行显示前 3 个，其余折叠为 +N） */
  tags: string[]
}

/** v1.2 标签（只包含至少关联一道题的标签） */
export interface TagInfo {
  id: number
  name: string
  count: number
}

/** v1.2 标签名上限（字符数，非字节）；db 层截断，UI 层提示 */
export const TAG_MAX_LEN = 12

export interface Settings {
  enabled: boolean
  intervalMin: number
  batchSize: number
  retention: number
  autostart: boolean
  /** v1.1.0 免打扰 */
  dndEnabled: boolean
  /** "22:00" */
  dndStart: string
  /** "08:00" */
  dndEnd: string
  /** v1.1.0 三秒提示条（写死 3，留 key 只为将来调） */
  prenudgeSeconds: number
}

export interface StatusSnapshot {
  total: number
  pending: number
  nextFireInMin: number
  enabled: boolean
  /** 此刻是否处于免打扰 */
  dnd: boolean
  /** 免打扰结束时的时间文本，如 "08:00"；非 DND 时为空串 */
  dndResumeText: string
}

/** 稍后（v1.1.1）：当日第 4 次起无效 */
export interface SnoozeState {
  allowed: boolean
  usedToday: number
}

export interface QuizItem {
  id: number
  content: string
  answer: string
  analysis: string | null
  status: Status
  daysOverdue: number
  isNew: boolean
}

export type QuizEmptyReason = 'empty' | 'capped'

export interface LaunchResult {
  ok: boolean
  reason?: QuizEmptyReason
  count?: number
}

export interface ImportFile {
  name: string
  text: string
}

export interface ImportResult {
  inserted: number
  skipped: number
  failed: number
}

export interface QuestionInput {
  content: string
  answer: string
  analysis: string
  /** v1.2 标签；缺省视为空数组 */
  tags?: string[]
}
