// DSR 调度算法（纯函数，无外部依赖）
// 公式沿用《题醒》设计定稿：R = (1 + Δt/9S)^-1，S 按自评更新，T_next = 9S(1/p − 1)

export type Rating = 1 | 2 | 3

export const DEFAULT_RETENTION = 0.85

/** 新题没有 Δt，增长因子里的 R 用这个常量代入（"刚学完几乎全记得"） */
export const R_NEW = 0.9
/** 单批弹窗新题配额（A 池非空时） */
export const NEW_QUOTA = 2
/** 单题当日最多被复习次数（rating 1–3） */
export const MAX_PER_DAY = 2
/** 答"不会"后的最大间隔（天）= 6 小时 */
export const WRONG_GAP = 0.25
/** 稳定性的绝对下限 */
export const S_MIN = 0.1
/** 稳定性上限（天）：增长因子是乘性的，不给上限会指数爆炸（连续答对 8 次 ≈ 3 年） */
export const S_MAX = 365
/**
 * 间隔上限（天）。乘性增长会随 D 变低而越来越陡（D 每答对 −0.1），
 * 连对 6 次就顶到 ~185 天——那等于"这学期再也见不到这道题"。
 * 180 天 ≈ 一个学期，超过就不再延长。留 S_MAX 是因为 S 是记忆强度、T 是展示间隔，两者语义分开。
 */
export const T_MAX_DAYS = 180

/**
 * 答对增长因子里的指数系数（设计稿原稿为 0.1）。
 * 实测：到期点 R 恒等于 p=0.85，0.1 会让 e^(0.1×(1−R))−1 ≈ 0.015，
 * 即每次答对 S 只涨约 1.5%，间隔封顶在 2 天左右，与"1→3→7→16→35 天"的目标序列矛盾。
 * 取 4 后，"到期答对"的 S 倍率约 ×2.2，换算成间隔正好落在 1→2.8→5.9→12→25 天。
 */
export const R_BONUS_K = 4

/**
 * 单批题量（v1.1.1 §3.4 积压扩容）：积压超过 3K 时放大本批，上限 2K。
 * 护栏是 min(2K, …)：最多翻倍，不许"越积压弹得越狠"。只影响本批，NEW_QUOTA 仍为 2。
 */
export function computeBatchSize(dueCount: number, k: number): number {
  return dueCount > 3 * k ? Math.min(2 * k, dueCount) : k
}

export interface MemoryState {
  s: number
  d: number
}export interface ReviewResult {
  s: number
  d: number
  /** 距下次复习的天数 */
  tNext: number
  /** 自评前的可提取性（新题为 R_NEW，仅用于日志） */
  rBefore: number
}

const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max)

/** R = (1 + Δt / 9S)^-1 */
export function calculateR(deltaDays: number, s: number): number {
  if (deltaDays <= 0) return 1
  if (s <= 0) return 0
  return Math.pow(1 + deltaDays / (9 * s), -1)
}

/**
 * 一次自评后的新记忆状态。
 * @param state 新题传 null
 * @param deltaDays 距上次复习的天数（新题忽略）
 * @param rating 1 不会 / 2 模糊 / 3 答对
 */
export function calculateNextReview(
  state: MemoryState | null,
  deltaDays: number,
  rating: Rating,
  retention: number = DEFAULT_RETENTION
): ReviewResult {
  let s = state?.s ?? 1.0
  let d = state?.d ?? 5.0

  // 1. 自评前的 R（新题 = R_NEW）
  const rBefore = state ? calculateR(deltaDays, s) : R_NEW

  // 2. 更新 D
  if (rating === 1) d = d + 0.3
  else if (rating === 3) d = d - 0.1
  d = clamp(d, 1, 10)

  // 3. 更新 S
  if (rating === 1) {
    s = s * 0.5 // 不清零，保留部分历史
  } else if (rating === 2) {
    s = s * 1.1
  } else {
    // S' = S × (1 + e^(0.2(5−D)) × (e^(K(1−R)) − 1) × 1.5)，原稿 K = 0.1，见 R_BONUS_K
    const factor = Math.exp(0.2 * (5 - d))
    const rBonus = Math.exp(R_BONUS_K * (1 - rBefore)) - 1
    s = s * (1 + factor * rBonus * 1.5)
  }
  s = Math.min(Math.max(s, S_MIN), S_MAX)

  // 4. 下次间隔
  let tNext = 9 * s * (1 / retention - 1)
  if (rating === 1) tNext = Math.min(tNext, WRONG_GAP) // 错题当天还能再见一次
  tNext = Math.max(tNext, 0.1)
  tNext = Math.min(tNext, T_MAX_DAYS) // 触顶后 R > p，"到期点 R ≡ p"只在未触顶时成立

  return {
    s: Number(s.toFixed(4)),
    d: Number(d.toFixed(4)),
    tNext,
    rBefore: Number(rBefore.toFixed(4))
  }
}
