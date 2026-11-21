import Database from 'better-sqlite3'
import type {
  ImportFile,
  ImportResult,
  QuestionInput,
  QuestionRow,
  QuestionView,
  Settings
} from '../shared/types'
import { compareByR, matchFilter, toView } from '../shared/derive'
import { localDateKey } from '../shared/dnd'
import { calculateNextReview, R_NEW, type Rating } from '../shared/srs'
import { parseMarkdown } from '../shared/md'

const DAY = 86_400_000

const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  intervalMin: 90,
  batchSize: 5,
  retention: 0.85,
  autostart: true,
  dndEnabled: false,
  dndStart: '22:00',
  dndEnd: '08:00',
  prenudgeSeconds: 3
}

/** 同一 content 已存在（唯一索引冲突） */
export class DuplicateQuestionError extends Error {
  constructor() {
    super('DUPLICATE')
  }
}

export class Store {
  readonly path: string
  private db: Database.Database

  constructor(path: string) {
    this.path = path
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000') // 单实例降级为双开时的兜底：并发写排队 5 秒，而不是直接 SQLITE_BUSY
    this.db.pragma('foreign_keys = ON') // better-sqlite3 默认关闭，不开级联等于没写
    this.migrate()
  }

  inner(): Database.Database {
    return this.db
  }

  /** 建表只在 user_version = 0 时做一次；以后加列靠它判断，不引入迁移框架 */
  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version >= 1) return
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS question (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        content          TEXT NOT NULL,
        answer           TEXT NOT NULL DEFAULT '',
        analysis         TEXT,
        n                INTEGER DEFAULT 0,
        s                REAL    DEFAULT 1.0,
        d                REAL    DEFAULT 5.0,
        last_reviewed_at INTEGER,
        next_due         INTEGER,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_question_due ON question(next_due);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_question_content ON question(content);

      CREATE TABLE IF NOT EXISTS review_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        question_id INTEGER NOT NULL REFERENCES question(id) ON DELETE CASCADE,
        reviewed_at INTEGER NOT NULL,
        rating      INTEGER NOT NULL,
        r_before    REAL,
        s_after     REAL,
        d_after     REAL
      );
      CREATE INDEX IF NOT EXISTS idx_log_question ON review_log(question_id);
      CREATE INDEX IF NOT EXISTS idx_log_time     ON review_log(reviewed_at);

      CREATE TABLE IF NOT EXISTS setting (k TEXT PRIMARY KEY, v TEXT);
    `)
    this.db.pragma('user_version = 1')
  }

  // ---------- 设置 ----------

  getSettings(): Settings {
    const rows = this.db.prepare('SELECT k, v FROM setting').all() as { k: string; v: string }[]
    const m = new Map(rows.map((r) => [r.k, r.v]))
    const flag = (k: string, def: boolean): boolean => {
      const v = m.get(k)
      return v === undefined ? def : v !== '0'
    }
    return {
      enabled: flag('enabled', DEFAULT_SETTINGS.enabled),
      intervalMin: Number(m.get('interval_min') ?? DEFAULT_SETTINGS.intervalMin),
      batchSize: Number(m.get('batch_size') ?? DEFAULT_SETTINGS.batchSize),
      retention: Number(m.get('retention') ?? DEFAULT_SETTINGS.retention),
      autostart: flag('autostart', DEFAULT_SETTINGS.autostart),
      dndEnabled: flag('dnd_enabled', DEFAULT_SETTINGS.dndEnabled),
      dndStart: m.get('dnd_start') ?? DEFAULT_SETTINGS.dndStart,
      dndEnd: m.get('dnd_end') ?? DEFAULT_SETTINGS.dndEnd,
      prenudgeSeconds: Number(m.get('prenudge_seconds') ?? DEFAULT_SETTINGS.prenudgeSeconds)
    }
  }

  /** 当日已用「稍后」次数；跨天自动归零（不写日志、不动任何 next_due） */
  snoozeToday(now: number): number {
    const key = localDateKey(new Date(now))
    const rows = this.db
      .prepare("SELECT k, v FROM setting WHERE k IN ('snooze_date','snooze_count')")
      .all() as { k: string; v: string }[]
    const m = new Map(rows.map((r) => [r.k, r.v]))
    if (m.get('snooze_date') !== key) return 0
    return Number(m.get('snooze_count') ?? 0)
  }

  bumpSnooze(now: number): number {
    const used = this.snoozeToday(now) + 1
    this.setSetting('snooze_date', localDateKey(new Date(now)))
    this.setSetting('snooze_count', String(used))
    return used
  }

  setSetting(k: string, v: string): void {
    this.db
      .prepare('INSERT INTO setting (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(k, v)
  }

  // ---------- 题目 CRUD ----------

  rawRows(): QuestionRow[] {
    return this.db.prepare('SELECT * FROM question').all() as QuestionRow[]
  }

  getRow(id: number): QuestionRow | null {
    const row = this.db.prepare('SELECT * FROM question WHERE id = ?').get(id) as QuestionRow | undefined
    return row ?? null
  }

  list(filter: 'all' | 'today' | 'overdue', q: string, now: number): QuestionView[] {
    const needle = q.trim().toLowerCase()
    let views = this.rawRows().map((r) => toView(r, now))
    if (needle) {
      views = views.filter(
        (v) =>
          v.content.toLowerCase().includes(needle) ||
          (v.answer ?? '').toLowerCase().includes(needle) ||
          (v.analysis ?? '').toLowerCase().includes(needle)
      )
    }
    views = views.filter((v) => matchFilter(v, filter))
    return views.sort(compareByR)
  }

  create(input: QuestionInput, now: number): number {
    const content = input.content.trim()
    if (!content) throw new Error('题目不能为空')
    try {
      const info = this.db
        .prepare(
          `INSERT INTO question (content, answer, analysis, n, s, d, last_reviewed_at, next_due, created_at, updated_at)
           VALUES (?, ?, ?, 0, 1.0, 5.0, NULL, NULL, ?, ?)`
        )
        .run(content, input.answer.trim(), input.analysis.trim(), now, now)
      return Number(info.lastInsertRowid)
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateQuestionError()
      throw e
    }
  }

  update(id: number, input: QuestionInput, now: number): void {
    const content = input.content.trim()
    if (!content) throw new Error('题目不能为空')
    try {
      this.db
        .prepare('UPDATE question SET content = ?, answer = ?, analysis = ?, updated_at = ? WHERE id = ?')
        .run(content, input.answer.trim(), input.analysis.trim(), now, id)
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateQuestionError()
      throw e
    }
  }

  /** 物理删除，日志由 ON DELETE CASCADE 连带删除 */
  remove(id: number): void {
    this.db.prepare('DELETE FROM question WHERE id = ?').run(id)
  }

  // ---------- 复习 ----------

  /** 一次自评：更新 question + 写 review_log（同一事务） */
  rate(id: number, rating: Rating, retention: number, now: number): void {
    const q = this.getRow(id)
    if (!q) throw new Error('题目不存在')

    const state = q.n > 0 && q.last_reviewed_at != null ? { s: q.s, d: q.d } : null
    const deltaDays = q.last_reviewed_at != null ? Math.max(0, (now - q.last_reviewed_at) / DAY) : 0
    const res = calculateNextReview(state, deltaDays, rating, retention)
    const nextDue = now + res.tNext * DAY

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE question
              SET n = n + 1, s = ?, d = ?, last_reviewed_at = ?, next_due = ?, updated_at = ?
            WHERE id = ?`
        )
        .run(res.s, res.d, now, nextDue, now, id)
      this.db
        .prepare(
          `INSERT INTO review_log (question_id, reviewed_at, rating, r_before, s_after, d_after)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, now, rating, res.rBefore, res.s, res.d)
    })
    tx()
  }

  /** Esc 跳过：只写一行 rating = 0，不改 question 的任何状态 */
  logSkip(id: number, now: number): void {
    this.logOnly(id, now, 0)
  }

  /** 稍后（v1.1.1）：只写一行 rating = −1，不改 question 的任何状态。
   *  0 = 我现在不想学（改产品），−1 = 我现在不方便（改时机）——两类信号不能混。 */
  logSnooze(id: number, now: number): void {
    this.logOnly(id, now, -1)
  }

  private logOnly(id: number, now: number, rating: number): void {
    const q = this.getRow(id)
    if (!q) return
    this.db
      .prepare(
        `INSERT INTO review_log (question_id, reviewed_at, rating, r_before, s_after, d_after)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, now, rating, q.n > 0 ? calculateRForLog(q, now) : R_NEW, q.s, q.d)
  }

  // ---------- 统计口径 ----------

  totals(now: number): { total: number; pending: number } {
    const total = (this.db.prepare('SELECT COUNT(*) c FROM question').get() as { c: number }).c
    const pending = (
      this.db.prepare('SELECT COUNT(*) c FROM question WHERE n > 0 AND next_due IS NOT NULL AND next_due <= ?').get(now) as {
        c: number
      }
    ).c
    return { total, pending }
  }

  // ---------- 导入 ----------

  /** 整次导入包在一个事务里：任一条数据库错误 → 全部回滚 */
  importFiles(files: ImportFile[], now: number): ImportResult {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO question (content, answer, analysis, n, s, d, last_reviewed_at, next_due, created_at, updated_at)
       VALUES (?, ?, ?, 0, 1.0, 5.0, NULL, NULL, ?, ?)`
    )
    const tx = this.db.transaction((): ImportResult => {
      let inserted = 0
      let skipped = 0
      let failed = 0
      for (const f of files) {
        let parsed: ReturnType<typeof parseMarkdown>
        try {
          parsed = parseMarkdown(f.text)
        } catch {
          failed++
          continue
        }
        for (const item of parsed) {
          const content = item.content.trim()
          if (!content) {
            failed++
            continue
          }
          const info = stmt.run(content, item.answer.trim(), item.analysis.trim(), now, now)
          if (info.changes > 0) inserted++
          else skipped++
        }
      }
      return { inserted, skipped, failed }
    })
    return tx()
  }

  // ---------- 备份 ----------

  async backup(dest: string): Promise<void> {
    await this.db.backup(dest)
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }
}

function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /UNIQUE constraint failed/i.test(msg)
}

function calculateRForLog(q: QuestionRow, now: number): number {
  const deltaDays = q.last_reviewed_at != null ? Math.max(0, (now - q.last_reviewed_at) / DAY) : 0
  if (deltaDays <= 0) return 1
  return Math.pow(1 + deltaDays / (9 * q.s), -1)
}
