import Database from 'better-sqlite3'
import type {
  ImportFile,
  ImportResult,
  QuestionInput,
  QuestionRow,
  QuestionView,
  Settings,
  TagInfo
} from '../shared/types'
import { TAG_MAX_LEN } from '../shared/types'
import { compareByR, startOfToday, toView } from '../shared/derive'
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

/** 标签名截断到 TAG_MAX_LEN 个字符（按 Unicode 字符计数，避免把 emoji 拆坏） */
function truncateTag(raw: string): string {
  const chars = Array.from(raw.trim())
  return chars.length > TAG_MAX_LEN ? chars.slice(0, TAG_MAX_LEN).join('') : raw.trim()
}

export class Store {
  readonly path: string
  private db: Database.Database
  /** user_version >= 2：标签表可用。备份失败导致迁移中止时为 false（v1.2 §4） */
  private v2Ready: boolean

  constructor(path: string) {
    this.path = path
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000') // 单实例降级为双开时的兜底：并发写排队 5 秒，而不是直接 SQLITE_BUSY
    this.db.pragma('foreign_keys = ON') // better-sqlite3 默认关闭，不开级联等于没写
    this.migrate()
    this.v2Ready = this.getUserVersion() >= 2
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

  // ---------- 迁移（v1.2 §4） ----------

  /** 当前 PRAGMA user_version */
  getUserVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number
  }

  /**
   * v1 → v2：只建 tag / question_tag 表与索引。
   * 调用方（主进程 bootstrap）必须先成功备份、再调用本方法；备份失败不得调用。
   * 事务失败会整体回滚，user_version 保持 1。
   */
  migrateToV2(): void {
    const tx = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tag (
          id   INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE
        );
        CREATE TABLE IF NOT EXISTS question_tag (
          question_id INTEGER NOT NULL REFERENCES question(id) ON DELETE CASCADE,
          tag_id      INTEGER NOT NULL REFERENCES tag(id)      ON DELETE CASCADE,
          PRIMARY KEY (question_id, tag_id)
        );
        CREATE INDEX IF NOT EXISTS idx_qt_tag ON question_tag(tag_id);
      `)
      this.db.pragma('user_version = 2')
    })
    tx()
    this.v2Ready = true
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

  /** 单题视图（带标签），供 db:get 使用 */
  getView(id: number, now: number): QuestionView | null {
    const row = this.getRow(id)
    if (!row) return null
    const view = toView(row, now)
    this.fillTags([view])
    return view
  }

  // ---------- 标签（v1.2） ----------

  /** 全部标签（只含至少关联一道题的，避免筛选下拉出现空标签） */
  getTags(): TagInfo[] {
    if (!this.v2Ready) return []
    return this.db
      .prepare(
        `SELECT t.id AS id, t.name AS name, COUNT(qt.question_id) AS count
           FROM tag t JOIN question_tag qt ON qt.tag_id = t.id
          GROUP BY t.id
          ORDER BY t.name COLLATE NOCASE`
      )
      .all() as TagInfo[]
  }

  /**
   * 替换一道题的标签集合：先清空关联再插入（标签表本身不删，孤立的 tag 行不参与筛选）。
   * 名字先 trim、去空、截断到 TAG_MAX_LEN、按 NOCASE 去重。
   */
  private setQuestionTags(questionId: number, names?: string[]): void {
    if (!this.v2Ready) return // 升级未完成（备份失败）时降级：忽略标签写入，不阻塞录题
    const clean: string[] = []
    const seen = new Set<string>()
    for (const raw of names ?? []) {
      const name = truncateTag(raw)
      if (!name) continue
      const key = name.toLowerCase() // 与 UNIQUE COLLATE NOCASE 对齐
      if (seen.has(key)) continue
      seen.add(key)
      clean.push(name)
    }
    this.db.prepare('DELETE FROM question_tag WHERE question_id = ?').run(questionId)
    const insTag = this.db.prepare('INSERT OR IGNORE INTO tag (name) VALUES (?)')
    const selTag = this.db.prepare('SELECT id FROM tag WHERE name = ?')
    const insQT = this.db.prepare('INSERT OR IGNORE INTO question_tag (question_id, tag_id) VALUES (?, ?)')
    for (const name of clean) {
      insTag.run(name)
      const tag = selTag.get(name) as { id: number } | undefined
      if (tag) insQT.run(questionId, tag.id)
    }
  }

  /** 给一批视图补上 tags（一次查询全表关联，避免 IN 参数上限） */
  private fillTags(views: QuestionView[]): void {
    if (!this.v2Ready || views.length === 0) return
    const rows = this.db
      .prepare(
        `SELECT qt.question_id AS qid, t.name AS name
           FROM question_tag qt JOIN tag t ON t.id = qt.tag_id
          ORDER BY t.name COLLATE NOCASE`
      )
      .all() as { qid: number; name: string }[]
    const byId = new Map<number, string[]>()
    for (const r of rows) {
      const arr = byId.get(r.qid)
      if (arr) arr.push(r.name)
      else byId.set(r.qid, [r.name])
    }
    for (const v of views) v.tags = byId.get(v.id) ?? []
  }

  // ---------- 列表（v1.2：LIKE 搜索 + 标签筛选，SQL 过滤后内存按 R 排序） ----------

  list(filter: 'all' | 'today' | 'overdue', q: string, now: number, tag?: string | null): QuestionView[] {
    const where: string[] = []
    const params: (string | number)[] = []

    if (filter === 'today') {
      where.push('n > 0 AND next_due IS NOT NULL AND next_due <= ?')
      params.push(now)
    } else if (filter === 'overdue') {
      where.push('n > 0 AND next_due IS NOT NULL AND next_due < ?')
      params.push(startOfToday(now))
    }

    if (tag) {
      where.push(
        `EXISTS (SELECT 1 FROM question_tag qt JOIN tag t ON t.id = qt.tag_id
                  WHERE qt.question_id = question.id AND t.name = ? COLLATE NOCASE)`
      )
      params.push(tag)
    }

    // v1.2 §3.2：空格分隔多个词，每个词都要命中至少一个字段（AND）；% 与 _ 按字面匹配
    const words = q.trim().split(/\s+/).filter(Boolean)
    for (const word of words) {
      const escaped = word.replace(/[\\%_]/g, (m) => '\\' + m)
      const like = `%${escaped}%`
      where.push(
        `(content LIKE ? ESCAPE '\\'
          OR answer LIKE ? ESCAPE '\\'
          OR analysis LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM question_tag qt JOIN tag t ON t.id = qt.tag_id
                      WHERE qt.question_id = question.id AND t.name LIKE ? ESCAPE '\\'))`
      )
      params.push(like, like, like, like)
    }

    const sql = `SELECT * FROM question ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`
    const rows = this.db.prepare(sql).all(...params) as QuestionRow[]
    const views = rows.map((r) => toView(r, now))
    this.fillTags(views)
    return views.sort(compareByR)
  }

  create(input: QuestionInput, now: number): number {
    const content = input.content.trim()
    if (!content) throw new Error('题目不能为空')
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO question (content, answer, analysis, n, s, d, last_reviewed_at, next_due, created_at, updated_at)
           VALUES (?, ?, ?, 0, 1.0, 5.0, NULL, NULL, ?, ?)`
        )
        .run(content, input.answer.trim(), input.analysis.trim(), now, now)
      const id = Number(info.lastInsertRowid)
      this.setQuestionTags(id, input.tags)
      return id
    })
    try {
      return tx()
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateQuestionError()
      throw e
    }
  }

  update(id: number, input: QuestionInput, now: number): void {
    const content = input.content.trim()
    if (!content) throw new Error('题目不能为空')
    const tx = this.db.transaction(() => {
      this.db
        .prepare('UPDATE question SET content = ?, answer = ?, analysis = ?, updated_at = ? WHERE id = ?')
        .run(content, input.answer.trim(), input.analysis.trim(), now, id)
      this.setQuestionTags(id, input.tags)
    })
    try {
      tx()
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateQuestionError()
      throw e
    }
  }

  /** 物理删除，日志与标签关联由 ON DELETE CASCADE 连带删除 */
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
