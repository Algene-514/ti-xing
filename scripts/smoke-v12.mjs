// v1.2 行为冒烟：标签（显示/折叠/筛选）、搜索（AND/转义）、快捷键、独立新建入口
// 用法: node scripts/smoke-v12.mjs
//
// 经验：CDP 对同一 target 的重复连接会被拒。这里只连一次主窗口 ws，后续复用同一连接多次求值；
// 数据层断言全部通过 window.tixing IPC 驱动（不是每步都读 DOM）。
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const electron = join(root, 'node_modules', 'electron', 'dist', isWin ? 'electron.exe' : 'electron')
const tmp = join(root, 'tmp')
mkdirSync(tmp, { recursive: true })

const PORT = 9338
const LOCK_PORT = 39585
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
let failed = 0
function ok(m) {
  passed++
  console.log(`  ✓ ${m}`)
}
function bad(m) {
  failed++
  console.error(`  ✗ ${m}`)
}

const child = spawn(electron, ['.', '--no-sandbox', `--remote-debugging-port=${PORT}`], {
  cwd: root,
  env: {
    ...process.env,
    TIXING_DB_PATH: join(tmp, 'smoke-v12.db'),
    TIXING_LOCK_PORT: String(LOCK_PORT),
    TIXING_LOG: join(tmp, 'smoke-v12.log'),
    TIXING_POLL_MS: '60000'
  },
  stdio: 'ignore'
})

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return await res.json()
}

async function waitFor(fn, label, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await sleep(300)
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* retry */
    }
  }
  throw new Error(`超时等待：${label}`)
}

/** 单连接、多请求的 CDP 求值器 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('CDP 连接失败'))
  })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.error) p.reject(new Error(m.error.message))
    else p.resolve(m.result?.result?.value)
  }
  return {
    async eval(expression, awaitPromise = false) {
      await ready
      const id = ++seq
      const result = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            reject(new Error('CDP 求值超时'))
          }
        }, 10_000)
      })
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise }
        })
      )
      return result
    },
    close() {
      ws.close()
    }
  }
}

try {
  const page = await waitFor(async () => {
    const list = await targets()
    return list.find((t) => t.type === 'page' && !t.url.includes('quiz')) ?? null
  }, '主窗口 target')
  const cdp = connect(page.webSocketDebuggerUrl)

  // 等 React 挂载
  await waitFor(async () => (await cdp.eval(`(document.querySelector('#root')?.childElementCount ?? 0) > 0`)) === true, '主窗口挂载')

  const call = (expr, awaitPromise = false) => cdp.eval(expr, awaitPromise)
  const ipc = (expr) =>
    call(`(${expr}).then(r => JSON.stringify(r))`, true).then((s) => (s ? JSON.parse(s) : null))

  // ---------- Phase A：数据层（IPC 驱动） ----------
  console.log('Phase A：标签 / 搜索（数据层）')

  const mk = (content, tags) =>
    ipc(`window.tixing.create(${JSON.stringify({ content, answer: '1', analysis: '', tags })})`)

  const longTag = '超长的标签名超过十二个字符'
  const r1 = await mk('求极限 sinx/x', ['高数', '极限', '分析学', longTag])
  const r2 = await mk('英语阅读 T2P3', ['英语'])
  const r3 = await mk('C语言 指针 100%', ['编程'])
  if (r1?.ok && r2?.ok && r3?.ok) ok('建 3 道带标签的题')
  else bad(`建题失败：${JSON.stringify([r1, r2, r3])}`)

  const all = await ipc(`window.tixing.list('all', '', null)`)
  if (all?.ok && all.data.length === 3) ok('列表 3 道题')
  else bad(`列表数量异常：${JSON.stringify(all)}`)

  const first = all?.data.find((v) => v.content.includes('求极限'))
  if (first?.tags.length === 4) ok('标签全量返回 4 个（列表层做前 3 + 折叠）')
  else bad(`标签数量异常：${JSON.stringify(first?.tags)}`)
  if (first?.tags.includes('超长的标签名超过十二个字')) ok('超长标签名截断为 12 字')
  else bad(`截断失败：${JSON.stringify(first?.tags)}`)

  const tagsRes = await ipc(`window.tixing.tags()`)
  if (tagsRes?.ok && tagsRes.data.some((t) => t.name === '高数' && t.count === 1)) ok('标签列表带计数')
  else bad(`标签列表异常：${JSON.stringify(tagsRes)}`)

  const byTag = await ipc(`window.tixing.list('all', '', '高数')`)
  if (byTag?.ok && byTag.data.length === 1) ok('按标签单选筛选只出 1 道')
  else bad(`标签筛选异常：${JSON.stringify(byTag)}`)

  const andHit = await ipc(`window.tixing.list('all', '极限 高数', null)`)
  if (andHit?.ok && andHit.data.length === 1) ok('搜索「极限 高数」AND 命中 1 道')
  else bad(`AND 搜索异常：${JSON.stringify(andHit)}`)

  const andMiss = await ipc(`window.tixing.list('all', '极限 英语', null)`)
  if (andMiss?.ok && andMiss.data.length === 0) ok('搜索「极限 英语」AND 无结果')
  else bad(`AND 搜索异常：${JSON.stringify(andMiss)}`)

  const pct = await ipc(`window.tixing.list('all', '100%', null)`)
  if (pct?.ok && pct.data.length === 1) ok('搜索「100%」按字面匹配')
  else bad(`% 转义异常：${JSON.stringify(pct)}`)

  const wild = await ipc(`window.tixing.list('all', '%', null)`)
  if (wild?.ok && wild.data.length === 1) ok('搜索「%」只匹配含字面 % 的题（不是全命中）')
  else bad(`% 转义异常：${JSON.stringify(wild)}`)

  // ---------- Phase B：界面（DOM 快照一次 + 键盘模拟） ----------
  console.log('Phase B：界面（DOM）')

  // Phase A 走 IPC 建题，主窗口靠 15s 轮询才会看到；点两次 chip 触发真实刷新
  // （必须分开两次求值：React 18 会把同步的双击批处理成一次，最终 filter 没变就不会刷新）
  await call(`(() => { [...document.querySelectorAll('.chip')].find((b) => b.textContent === '已逾期')?.click(); return true })()`)
  await sleep(400)
  await call(`(() => { [...document.querySelectorAll('.chip')].find((b) => b.textContent === '全部')?.click(); return true })()`)
  await sleep(600)

  const dom = JSON.parse(
    await call(`JSON.stringify({
      rowTags: document.querySelectorAll('.row .tag').length,
      moreChips: document.querySelectorAll('.row .tag-more').length,
      tagFilter: !!document.querySelector('.tag-filter'),
      newBtn: [...document.querySelectorAll('.list-actions button')].some(b => (b.textContent || '').includes('新建')),
      search: !!document.querySelector('.search')
    })`)
  )
  if (dom.rowTags >= 4) ok(`列表行有标签 chip（${dom.rowTags} 个，含 +N）`)
  else bad(`列表行标签 chip 数量异常：${dom.rowTags}`)
  if (dom.moreChips >= 1) ok('第 4 个标签折叠为 +1')
  else bad('未出现 +N 折叠')
  if (dom.tagFilter) ok('标签筛选下拉存在')
  else bad('缺少标签筛选下拉')
  if (dom.newBtn) ok('列表底部「+ 新建」按钮存在')
  else bad('缺少独立新建按钮')

  // 快捷键：Ctrl+F 聚焦搜索；Ctrl+N 打开新建表单，且新建按钮在编辑态禁用
  const ctrlF = await call(`(() => {
    const ev = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(ev)
    return document.activeElement === document.querySelector('.search')
  })()`)
  if (ctrlF === true) ok('Ctrl+F 聚焦搜索框')
  else bad('Ctrl+F 未聚焦搜索框')

  await call(`(() => {
    const ev = new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(ev)
    return true
  })()`)
  await sleep(300)
  const formState = JSON.parse(
    await call(`JSON.stringify({
      form: !!document.querySelector('.form'),
      newBtnDisabled: [...document.querySelectorAll('.list-actions button')].find(b => (b.textContent || '').includes('新建'))?.disabled ?? null
    })`)
  )
  if (formState.form) ok('Ctrl+N 打开新建表单')
  else bad('Ctrl+N 未打开表单')
  if (formState.newBtnDisabled === true) ok('编辑态下「+ 新建」置灰')
  else bad(`编辑态「+ 新建」未置灰：${formState.newBtnDisabled}`)

  cdp.close()
  console.log(failed === 0 ? `\n全部 ${passed} 条 v1.2 断言通过` : `\n❌ ${failed} 条失败`)
  process.exitCode = failed === 0 ? 0 : 1
} catch (e) {
  console.error('❌', e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  child.kill()
}
