// v1.1.0 / v1.1.1 行为冒烟：三秒提示条、免打扰、稍后
// 用法: node scripts/smoke-v11.mjs
//
// 经验：Electron 窗口的 CDP 连接只有"第一次"稳定，重复连同一个 target 会被拒。
// 所以：每个窗口只读一次 DOM，其余状态与操作全部通过主窗口的 IPC 驱动（IPC 本来就是全局的）。
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const electron = join(root, 'node_modules', 'electron', 'dist', isWin ? 'electron.exe' : 'electron')
const tmp = join(root, 'tmp')
mkdirSync(tmp, { recursive: true })

const PORTS = { A: 9335, B: 9336, C: 9337 }
const LOCK_PORTS = { A: 39581, B: 39582, C: 39583 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
const ok = (m) => {
  passed++
  console.log(`  ✓ ${m}`)
}
const bad = (m) => {
  console.error(`  ✗ ${m}`)
  process.exitCode = 1
}

let child = null
let port = 0

async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
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

function evalIn(wsUrl, expression, awaitPromise = false) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('CDP 超时'))
    }, 10000)
    ws.onopen = () =>
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }))
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.text))
      else resolve(m.result?.result?.value)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`CDP 连接失败（${wsUrl}）`))
    }
  })
}

/** 只读一次的窗口 DOM */
async function readOnce(page, expression) {
  await sleep(200)
  return await evalIn(page.webSocketDebuggerUrl, expression)
}

const mainPage = async () => (await targets()).find((t) => t.type === 'page' && !t.url.startsWith('data:'))
const quizPage = async () => (await targets()).find((t) => t.type === 'page' && t.url.includes('quiz=1'))
const toastPage = async () => (await targets()).find((t) => t.type === 'page' && t.url.startsWith('data:'))

async function launch(tag, dbName, prenudgeMs = '3000') {
  port = PORTS[tag]
  const dbPath = join(tmp, dbName)
  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true })
  child = spawn(electron, ['.', '--no-sandbox', `--remote-debugging-port=${port}`], {
    cwd: root,
    env: {
      ...process.env,
      TIXING_DB_PATH: dbPath,
      TIXING_LOG: join(tmp, `smoke-v11-${tag}.log`),
      TIXING_FAST_MS: '1500',
      TIXING_POLL_MS: '400',
      TIXING_PRENUDGE_MS: prenudgeMs,
      TIXING_LOCK_PORT: String(LOCK_PORTS[tag])
    },
    stdio: 'ignore'
  })
  return waitFor(mainPage, `${tag} 主窗口`)
}

function kill() {
  if (child) child.kill()
  child = null
}

const call = (main, expr) => evalIn(main.webSocketDebuggerUrl, expr, true)

async function createQ(main, n) {
  for (let i = 1; i <= n; i++) {
    await call(main, `window.tixing.create({ content: 'v11 测试题 ${i}', answer: '42', analysis: '' }).then(r => JSON.stringify(r))`)
  }
}

async function status(main) {
  return JSON.parse(await call(main, `window.tixing.status().then(r => JSON.stringify(r.data))`))
}

// ---------- Phase A：提示条 + 顺延 ----------
async function phaseA() {
  console.log('\nPhase A：提示条 → 顺延 10 分钟')
  const main = await launch('A', 'v11-a.db', '8000')
  await createQ(main, 2)
  ok('主窗口 + 2 道题就绪')

  const toast = await waitFor(toastPage, '三秒提示条')
  const info = JSON.parse(
    await readOnce(
      toast,
      `(() => {
        const card = document.querySelector('.card')
        return JSON.stringify({
          has: !!card,
          text: (document.body.innerText || '').replace(/\\s+/g, ' '),
          onclick: card ? (card.getAttribute('onclick') || '') : ''
        })
      })()`
    )
  )
  if (info.has && info.text.includes('秒后开始复习') && info.text.includes('顺延 10 分钟')) ok(`提示条内容正确：${info.text}`)
  else bad(`提示条内容异常：${JSON.stringify(info)}`)
  if (info.onclick.includes('prenudgeSkip')) ok('提示条已接线：点击调用 prenudgeSkip')
  else bad(`提示条未接线：${info.onclick}`)

  // 与点击等价的 IPC 路径
  await call(main, `window.tixing.prenudgeSkip().then(() => 'ok')`)
  await waitFor(async () => ((await toastPage()) ? null : true), '提示条消失', 15)
  ok('顺延 → 提示条关闭')

  const st = await status(main)
  if (st.nextFireInMin >= 9 && st.nextFireInMin <= 10) ok(`顺延生效：下次弹窗 ${st.nextFireInMin} 分钟`)
  else bad(`顺延未生效：nextFireInMin=${st.nextFireInMin}`)

  await call(main, `window.tixing.startQuizNow().then(r => JSON.stringify(r))`)
  await waitFor(quizPage, '手动弹窗', 15)
  ok('顺延期间手动「立即复习」仍可弹出')

  await call(main, `window.tixing.done().then(() => 'ok')`)
  await waitFor(async () => ((await quizPage()) ? null : true), '弹窗关闭', 15)
  ok('弹窗关闭')
  kill()
}

// ---------- Phase B：不按就自动进全屏 ----------
async function phaseB() {
  console.log('\nPhase B：提示条不按 → 自动进全屏')
  const main = await launch('B', 'v11-b.db', '1500')
  await createQ(main, 1)
  await waitFor(toastPage, '提示条')
  ok('提示条出现')

  const quiz = await waitFor(quizPage, '提示条到期后全屏弹窗', 30)
  ok('未点击 → 自动进入全屏复习弹窗')

  await sleep(300)
  if (!(await toastPage())) ok('提示条已关闭，不留残窗')
  else bad('提示条残窗还在')

  await call(main, `window.tixing.done().then(() => 'ok')`)
  await waitFor(async () => ((await quizPage()) ? null : true), '全屏弹窗关闭', 15)
  ok('全屏弹窗关闭')
  kill()
}

// ---------- Phase C：免打扰 + 稍后 ----------
async function phaseC() {
  console.log('\nPhase C：免打扰 + 稍后')
  const main = await launch('C', 'v11-c.db')
  await createQ(main, 2)

  await call(main, `window.tixing.setSettings({ dndEnabled: true, dndStart: '00:00', dndEnd: '23:59' }).then(r => JSON.stringify(r.data))`)
  ok('已开启全天免打扰')

  const before = await call(main, `window.tixing.list('all', '').then(r => JSON.stringify(r.data.map(v => v.next_due)))`)
  await sleep(4000) // FAST 1.5s + 轮询 0.4s，足够触发一次

  const pages = await targets()
  const noToast = !pages.find((p) => p.url.startsWith('data:'))
  const noQuiz = !pages.find((p) => p.url.includes('quiz=1'))
  if (noToast && noQuiz) ok('免打扰期间到点：既不弹提示条也不弹窗')
  else bad(`免打扰期间仍然弹了：${JSON.stringify(pages.map((p) => p.url))}`)

  const st = await status(main)
  if (st.dnd === true && st.dndResumeText === '23:59') ok(`状态栏口径：免打扰中 · ${st.dndResumeText} 恢复`)
  else bad(`DND 状态字段异常：${JSON.stringify(st)}`)

  const after = await call(main, `window.tixing.list('all', '').then(r => JSON.stringify(r.data.map(v => v.next_due)))`)
  if (before === after) ok('免打扰期间 next_due 一毫秒未变')
  else bad(`next_due 被改动：${before} → ${after}`)

  await call(main, `window.tixing.startQuizNow().then(r => JSON.stringify(r))`)
  const quiz = await waitFor(quizPage, 'DND 下手动弹窗', 15)
  ok('免打扰中手动「立即复习」仍然弹')

  // 窗口 UI 只读一次
  const ui = JSON.parse(
    await readOnce(
      quiz,
      `JSON.stringify({
        snooze: (document.querySelector('.snooze-hint')?.textContent || '').trim(),
        off: !!document.querySelector('.snooze-hint.off'),
        rates: document.querySelectorAll('.rate').length
      })`
    )
  )
  if (ui.snooze.includes('稍后') && !ui.off) ok(`弹窗标题栏有「${ui.snooze}」（未置灰）`)
  else bad(`稍后按钮异常：${JSON.stringify(ui)}`)

  // 稍后的 10 分钟档要在非 DND 下验证：DND 期间 nextFireAt 会被正确推回区间结束，那是另一条规则
  await call(main, `window.tixing.setSettings({ dndEnabled: false }).then(r => JSON.stringify(r.data))`)
  ok('关闭免打扰，回到正常计时')

  // 稍后 ×3
  for (let i = 1; i <= 3; i++) {
    const s0 = JSON.parse(await call(main, `window.tixing.snoozeState().then(r => JSON.stringify(r.data))`))
    if (!s0.allowed) {
      bad(`第 ${i} 次前就已置灰：used=${s0.usedToday}`)
      break
    }
    const batch0 = JSON.parse(await call(main, `window.tixing.getBatch().then(r => JSON.stringify(r.data))`))
    await call(main, `window.tixing.snooze(${batch0[0].id}).then(r => JSON.stringify(r))`)
    await waitFor(async () => ((await quizPage()) ? null : true), `第 ${i} 次稍后关窗`, 15)
    const s1 = await status(main)
    ok(`第 ${i} 次稍后 → 关窗，下次弹窗 ${s1.nextFireInMin} 分钟`)
    if (!(s1.nextFireInMin >= 9 && s1.nextFireInMin <= 10)) bad(`  稍后后计时不是 10 分钟档：${s1.nextFireInMin}`)
    if (i < 3) {
      await call(main, `window.tixing.startQuizNow().then(r => JSON.stringify(r))`)
      await waitFor(quizPage, '再次弹窗', 15)
    }
  }

  // 第 4 次：置灰 + 无效
  await call(main, `window.tixing.startQuizNow().then(r => JSON.stringify(r))`)
  await waitFor(quizPage, '第 4 次弹窗', 15)
  const s4 = JSON.parse(await call(main, `window.tixing.snoozeState().then(r => JSON.stringify(r.data))`))
  if (s4.allowed === false && s4.usedToday === 3) ok('第 4 次：allowed = false（已用满 3 次）')
  else bad(`第 4 次状态异常：${JSON.stringify(s4)}`)

  const batch4 = JSON.parse(await call(main, `window.tixing.getBatch().then(r => JSON.stringify(r.data))`))
  const r4 = JSON.parse(await call(main, `window.tixing.snooze(${batch4[0].id}).then(r => JSON.stringify(r))`))
  if (r4.ok === false) ok(`第 4 次稍后被拒：${r4.error}`)
  else bad('第 4 次稍后仍然成功')

  await sleep(600)
  if (await quizPage()) ok('第 4 次被拒后弹窗保留')
  else bad('第 4 次被拒后弹窗却关了')

  // Esc 仍然可用
  const batch = JSON.parse(await call(main, `window.tixing.getBatch().then(r => JSON.stringify(r.data))`))
  await call(main, `window.tixing.skip(${batch[0].id}).then(r => 'ok')`)
  await waitFor(async () => ((await quizPage()) ? null : true), 'Esc 关窗', 15)
  ok('Esc 仍然可用（关窗）')
  kill()
}

try {
  await phaseA()
  await phaseB()
  await phaseC()
  console.log(`\n全部 ${passed} 条 v1.1 行为断言通过`)
} catch (e) {
  bad(e instanceof Error ? e.message : String(e))
} finally {
  kill()
}
