// 免打扰（DND）纯函数：跨午夜是唯一需要小心的地方（写错就整晚不弹或整天不弹）。
// v1.1.0 §3.2：只做"不打扰"，绝不改 next_due。

/** "22:00" / "8:5" → 分钟数；非法返回 -1 */
export function parseHHMM(text: string): number {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec((text ?? '').trim())
  if (!m) return -1
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return -1
  return h * 60 + min
}

/** 规范化成 HH:MM，用于 UI 与托盘文案 */
export function fmtHHMM(text: string): string {
  const v = parseHHMM(text)
  if (v < 0) return text
  const h = Math.floor(v / 60)
  const m = v % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * now 是否落在免打扰区间内。
 * start <= end：t >= start && t < end
 * start >  end：t >= start || t < end（跨午夜）
 * start == end：视为空区间，不打扰判定恒 false
 */
export function inDnd(now: Date, start: string, end: string): boolean {
  const s = parseHHMM(start)
  const e = parseHHMM(end)
  if (s < 0 || e < 0 || s === e) return false
  const t = now.getHours() * 60 + now.getMinutes()
  return s < e ? t >= s && t < e : t >= s || t < e
}

/** 下一次离开免打扰的时刻（毫秒）：dnd_end 的今天或明天 */
export function dndResumeAt(now: Date, end: string): number {
  const e = parseHHMM(end)
  if (e < 0) return now.getTime()
  const d = new Date(now.getTime())
  d.setHours(Math.floor(e / 60), e % 60, 0, 0)
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** 本地日期串 yyyy-MM-dd：snooze 次数按天重置用 */
export function localDateKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
