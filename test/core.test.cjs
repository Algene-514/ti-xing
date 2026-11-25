// 核心逻辑端到端测试：真实 SQLite + 真实调度，跑在 Electron 的 Node 环境里（原生模块 ABI 130）
// 运行：npm run test:core   （内部会设置 ELECTRON_RUN_AS_NODE）
const assert = require('node:assert/strict')
const { existsSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')

// 本机隔离环境的 TEMP 目录不可写（mkdtemp 会 EPERM），所以统一用项目内的 tmp/tests
const TEST_ROOT = join(__dirname, '..', 'tmp', 'tests')
mkdirSync(TEST_ROOT, { recursive: true })

const { Store, DuplicateQuestionError } = require('../tmp/testbuild/db.js')
const { pickCandidates } = require('../tmp/testbuild/scheduler.js')

const DAY = 86_400_000
const HOUR = 3_600_000

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}`)
    throw e
  }
}

function fresh() {
  const dir = mkdtempSync(join(TEST_ROOT, 'case-'))
  const store = new Store(join(dir, 't.db'))
  return { store, dir }
}

const mk = (store, content, answer = '') => store.create({ content, answer, analysis: '' }, Date.now())

console.log('核心逻辑断言（真实 SQLite）')

test('空库：候选为空且原因为 empty', () => {
  const { store, dir } = fresh()
  const now = Date.now()
  const r = pickCandidates(store.inner(), now, 5)
  assert.deepEqual(r.items, [])
  assert.equal(r.reason, 'empty')
  assert.equal(store.totals(now).total, 0)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('A 池为空时新题可用满 K：建 3 道题全部进候选', () => {
  const { store, dir } = fresh()
  for (let i = 1; i <= 3; i++) mk(store, `题目 ${i}`)
  const r = pickCandidates(store.inner(), Date.now(), 5)
  assert.equal(r.items.length, 3)
  assert.equal(store.totals(Date.now()).total, 3)
  assert.equal(store.totals(Date.now()).pending, 0)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('答对：n+1、S 增长、next_due 落在 2~4 天后、写一条 rating=3 日志', () => {
  const { store, dir } = fresh()
  const now = Date.now()
  const id = mk(store, '极限')
  store.rate(id, 3, 0.85, now)
  const row = store.getRow(id)
  assert.equal(row.n, 1)
  assert.ok(row.s > 1, `S 应大于 1，实际 ${row.s}`)
  assert.ok(row.last_reviewed_at === now)
  const gap = row.next_due - now
  assert.ok(gap > 2 * DAY && gap < 4 * DAY, `间隔应在 2~4 天，实际 ${(gap / DAY).toFixed(2)} 天`)
  const logs = store.inner().prepare('SELECT rating, r_before, s_after, d_after FROM review_log').all()
  assert.equal(logs.length, 1)
  assert.equal(logs[0].rating, 3)
  assert.equal(logs[0].r_before, 0.9) // 新题用 R_NEW
  assert.ok(logs[0].s_after > 1 && logs[0].d_after === 4.9)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('答"不会"：间隔被压到 6 小时内，S 减半，D 增加', () => {
  const { store, dir } = fresh()
  const now = Date.now()
  const id = mk(store, '积分')
  store.rate(id, 3, 0.85, now) // 先建立状态
  const before = store.getRow(id)
  store.rate(id, 1, 0.85, now + 1000)
  const after = store.getRow(id)
  assert.ok(after.s <= before.s)
  assert.ok(after.d > before.d)
  const gap = after.next_due - (now + 1000)
  assert.ok(gap <= 0.25 * DAY + 1000, `间隔应 ≤ 6 小时，实际 ${(gap / HOUR).toFixed(1)} 小时`)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('每日上限：同一题当天答满 2 次后不再进候选，且原因为 capped', () => {
  const { store, dir } = fresh()
  const now = Date.now()
  const id = mk(store, '每日上限')
  store.rate(id, 3, 0.85, now)
  store.rate(id, 3, 0.85, now)
  // 强制到期，确认是被"当日次数"挡住而不是没到期
  store.inner().prepare('UPDATE question SET next_due = ? WHERE id = ?').run(now - HOUR, id)
  const r = pickCandidates(store.inner(), now, 5)
  assert.equal(r.items.length, 0)
  assert.equal(r.reason, 'capped')
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('新题配额：有旧题到期时，本批新题不超过 2 道', () => {
  const { store, dir } = fresh()
  const now = Date.now()
  const oldId = mk(store, '旧题')
  // 伪造成已复习且到期
  store.inner()
    .prepare('UPDATE question SET n = 3, s = 2, d = 5, last_reviewed_at = ?, next_due = ? WHERE id = ?')
    .run(now - 2 * DAY, now - DAY, oldId)
  for (let i = 1; i <= 5; i++) mk(store, `新题 ${i}`)
  const r = pickCandidates(store.inner(), now, 5)
  assert.equal(r.items.length, 3, '应为 1 道旧题 + 2 道新题')
  assert.equal(r.items[0].id, oldId, '旧题应排在最前（R 升序）')
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('状态：新题 / 今日到期 / 已逾期 / 未到期', () => {
  const { store, dir } = fresh()
  const now = Date.now()
  const today0 = new Date(now)
  today0.setHours(0, 0, 0, 0)
  const newId = mk(store, '新')
  const todayId = mk(store, '今日')
  const overdueId = mk(store, '逾期')
  const laterId = mk(store, '未到期')
  const upd = store.inner().prepare('UPDATE question SET n = 1, s = 2, last_reviewed_at = ? WHERE id = ?')
  upd.run(now - 2 * DAY, todayId)
  store.inner().prepare('UPDATE question SET next_due = ? WHERE id = ?').run(now - 1000, todayId)
  upd.run(now - 5 * DAY, overdueId)
  store.inner().prepare('UPDATE question SET next_due = ? WHERE id = ?').run(today0.getTime() - DAY, overdueId)
  upd.run(now - 1 * DAY, laterId)
  store.inner().prepare('UPDATE question SET next_due = ? WHERE id = ?').run(now + 3 * DAY, laterId)

  const all = new Map(store.list('all', '', now).map((v) => [v.id, v.status]))
  assert.equal(all.get(newId), '新题')
  assert.equal(all.get(todayId), '今日到期')
  assert.equal(all.get(overdueId), '已逾期')
  assert.equal(all.get(laterId), '未到期')

  // 筛选口径：today = 已逾期 ∪ 今日到期
  const today = store.list('today', '', now).map((v) => v.id).sort()
  assert.deepEqual(today, [todayId, overdueId].sort())
  const overdue = store.list('overdue', '', now).map((v) => v.id)
  assert.deepEqual(overdue, [overdueId])
  assert.equal(store.totals(now).pending, 2)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('删除题目：review_log 级联清空，无孤儿行', () => {
  const { store, dir } = fresh()
  const now = Date.now()
  const id = mk(store, '要删的题')
  store.rate(id, 3, 0.85, now)
  store.remove(id)
  const logs = store.inner().prepare('SELECT COUNT(*) c FROM review_log').get().c
  assert.equal(logs, 0)
  assert.equal(store.totals(now).total, 0)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('导入：同一内容第二次被唯一索引挡掉（skipped）', () => {
  const { store, dir } = fresh()
  const md = '# 题目\n求 1+1\n# 答案\n2'
  const first = store.importFiles([{ name: 'a.md', text: md }], Date.now())
  assert.equal(first.inserted, 1)
  assert.equal(first.skipped, 0)
  const second = store.importFiles([{ name: 'a.md', text: md }], Date.now())
  assert.equal(second.inserted, 0)
  assert.equal(second.skipped, 1)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('新建重复题目：抛 DUPLICATE', () => {
  const { store, dir } = fresh()
  mk(store, '同一道题')
  assert.throws(() => mk(store, '同一道题'), (e) => e instanceof DuplicateQuestionError)
  assert.throws(() => mk(store, '  同一道题  '), (e) => e instanceof DuplicateQuestionError, 'trim 后也应视为重复')
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('Esc 跳过：只写 rating=0 日志，题目状态完全不变', () => {
  const { store, dir } = fresh()
  const now = Date.now()
  const id = mk(store, '跳过')
  const before = store.getRow(id)
  store.logSkip(id, now)
  const after = store.getRow(id)
  assert.equal(after.n, before.n)
  assert.equal(after.s, before.s)
  assert.equal(after.d, before.d)
  assert.equal(after.next_due, before.next_due)
  const log = store.inner().prepare('SELECT rating FROM review_log').get()
  assert.equal(log.rating, 0)
  // 跳过不计入当日次数：仍能进候选
  const r = pickCandidates(store.inner(), now, 5)
  assert.equal(r.items.length, 1)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('稍后：只写 rating=-1 日志，状态不变，不消耗当日次数', () => {
  const { store, dir } = fresh()
  const now = Date.now()
  const id = mk(store, '稍后')
  const before = store.getRow(id)
  store.logSnooze(id, now)
  const after = store.getRow(id)
  assert.equal(after.n, before.n)
  assert.equal(after.s, before.s)
  assert.equal(after.d, before.d)
  assert.equal(after.next_due, before.next_due)
  const log = store.inner().prepare('SELECT rating FROM review_log').get()
  assert.equal(log.rating, -1, '稍后必须记 -1，不能和 Esc 的 0 混')
  const r = pickCandidates(store.inner(), now, 5)
  assert.equal(r.items.length, 1, '稍后不应消耗当日次数')
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('度量四类计数：真答 1–3、Esc 0、稍后 -1 互不污染', () => {
  const { store, dir } = fresh()
  const now = Date.now()
  const a = mk(store, '真答')
  const b = mk(store, 'Esc')
  const c = mk(store, '稍后')
  store.rate(a, 3, 0.85, now)
  store.logSkip(b, now)
  store.logSnooze(c, now)
  const count = (sql) => store.inner().prepare(sql).get().c
  assert.equal(count('SELECT COUNT(*) c FROM review_log WHERE rating BETWEEN 1 AND 3'), 1)
  assert.equal(count('SELECT COUNT(*) c FROM review_log WHERE rating = 0'), 1)
  assert.equal(count('SELECT COUNT(*) c FROM review_log WHERE rating = -1'), 1)
  assert.equal(count('SELECT COUNT(*) c FROM review_log'), 3)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('间隔上限：连续到期答对 8 次，任何一次 next_due 都不超过 180 天', () => {
  const { store, dir } = fresh()
  const id = mk(store, '长间隔')
  let at = Date.now()
  for (let i = 0; i < 8; i++) {
    store.rate(id, 3, 0.85, at)
    const row = store.getRow(id)
    const gap = (row.next_due - at) / DAY
    assert.ok(gap <= 180 + 1e-6, `第 ${i + 1} 次间隔 ${gap.toFixed(1)} 天超过 180`)
    at = row.next_due
  }
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('设置持久化：改题量/间隔后重新打开仍是新值', () => {
  const { store, dir } = fresh()
  store.setSetting('batch_size', '10')
  store.setSetting('interval_min', '60')
  store.setSetting('enabled', '0')
  store.close()
  const reopened = new Store(join(dir, 't.db'))
  const s = reopened.getSettings()
  assert.equal(s.batchSize, 10)
  assert.equal(s.intervalMin, 60)
  assert.equal(s.enabled, false)
  assert.equal(s.retention, 0.85)
  assert.equal(s.autostart, true)
  reopened.close()
  rmSync(dir, { recursive: true, force: true })
})

// ---------- v1.2：标签 / 搜索 / 迁移 ----------

test('v1.2 标签：保存去重、截断 12 字、更新替换、清空后筛选列表消失', () => {
  const { store, dir } = fresh()
  store.migrateToV2()
  const now = Date.now()
  const id = store.create(
    { content: '极限', answer: '1', analysis: '', tags: ['高数', '高数', '极限', '超长的标签名超过十二个字符', 'C语言'] },
    now
  )
  const v = store.getView(id, now)
  assert.deepEqual(v.tags.slice().sort(), ['C语言', '极限', '高数', '超长的标签名超过十二个字'].slice().sort(), `实际: ${v.tags.join(',')}`)
  assert.equal(store.getTags().length, 4)

  // 更新为两个标签：旧关联被替换
  store.update(id, { content: '极限', answer: '1', analysis: '', tags: ['高数', '英语'] }, now)
  assert.deepEqual(store.getView(id, now).tags.slice().sort(), ['英语', '高数'].slice().sort())

  // 清空标签：关联消失、题目保留；count=0 的标签不再出现在筛选列表
  store.update(id, { content: '极限', answer: '1', analysis: '', tags: [] }, now)
  assert.deepEqual(store.getView(id, now).tags, [])
  assert.equal(store.getTags().length, 0)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('v1.2 标签：按标签单选筛选 + 删除题目级联清理关联', () => {
  const { store, dir } = fresh()
  store.migrateToV2()
  const now = Date.now()
  const a = store.create({ content: 'A', answer: '', analysis: '', tags: ['高数'] }, now)
  store.create({ content: 'B', answer: '', analysis: '', tags: ['英语'] }, now)
  assert.equal(store.list('all', '', now, '高数').length, 1)
  assert.equal(store.list('all', '', now, null).length, 2)
  store.remove(a)
  const orphans = store.inner().prepare('SELECT COUNT(*) c FROM question_tag WHERE question_id = ?').get(a).c
  assert.equal(orphans, 0)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('v1.2 搜索：多词 AND、标签名命中、% 与 _ 按字面匹配', () => {
  const { store, dir } = fresh()
  store.migrateToV2()
  const now = Date.now()
  store.create({ content: '求极限 sinx/x', answer: '1', analysis: '洛必达', tags: ['高数'] }, now)
  store.create({ content: '英语阅读 T2P3', answer: '', analysis: '', tags: ['英语'] }, now)
  store.create({ content: 'C语言 指针 100%', answer: '', analysis: '', tags: ['编程'] }, now)
  store.create({ content: 'a_b 下划线', answer: '', analysis: '', tags: [] }, now)
  assert.equal(store.list('all', '洛必达', now).length, 1)
  assert.equal(store.list('all', '极限 洛必达', now).length, 1) // 两个词都命中同一题
  assert.equal(store.list('all', '极限 英语', now).length, 0) // AND：没有题同时命中
  assert.equal(store.list('all', '高数', now).length, 1) // 标签名命中
  assert.equal(store.list('all', '100%', now).length, 1) // % 按字面
  assert.equal(store.list('all', '%', now).length, 1) // 只有含字面 % 的那道题
  assert.equal(store.list('all', 'a_b', now).length, 1) // _ 按字面
  assert.equal(store.list('all', 'aXb', now).length, 0) // _ 不作通配符
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function testAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}`)
    throw e
  }
}

;(async () => {
  await testAsync('v1.2 迁移：备份可打开、升到 2、重复启动不重复迁移', async () => {
    const { store, dir } = fresh()
    assert.equal(store.getUserVersion(), 1)

    const backupPath = join(dir, 'backup.db')
    await store.backup(backupPath)
    assert.ok(existsSync(backupPath), '备份文件应存在')
    const Bak = require('better-sqlite3')
    const bak = new Bak(backupPath)
    assert.equal(bak.prepare('SELECT COUNT(*) c FROM question').get().c, 0)
    bak.close()

    store.migrateToV2()
    assert.equal(store.getUserVersion(), 2)
    store.close()

    const reopened = new Store(join(dir, 't.db'))
    assert.equal(reopened.getUserVersion(), 2, '重复打开不应回退版本')
    assert.equal(reopened.getTags().length, 0)
    reopened.close()
    rmSync(dir, { recursive: true, force: true })
  })

  await testAsync('v1.2 迁移：备份失败时中止，user_version 保持 1', async () => {
    const { store, dir } = fresh()
    await assert.rejects(() => store.backup(join(dir, 'no-such-dir', 'x.db')))
    assert.equal(store.getUserVersion(), 1)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  console.log(`\n全部 ${passed} 条核心断言通过`)
})()
