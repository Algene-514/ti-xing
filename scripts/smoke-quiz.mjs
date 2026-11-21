// 闭环冒烟：通过 CDP 驱动真实应用，走一遍 建题 → 立即复习 → 空格显答案 → 按 3 评分 → 弹窗关闭
// 用法: node scripts/smoke-quiz.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const electron = join(root, 'node_modules', 'electron', 'dist', isWin ? 'electron.exe' : 'electron')
const port = 9334
const tmp = join(root, 'tmp')
mkdirSync(tmp, { recursive: true })
const dbPath = join(tmp, 'smoke-quiz.db')
rmSync(dbPath, { force: true })
rmSync(dbPath + '-wal', { force: true })
rmSync(dbPath + '-shm', { force: true })

const child = spawn(electron, ['.', '--no-sandbox', `--remote-debugging-port=${port}`], {
  cwd: root,
  env: { ...process.env, TIXING_DB_PATH: dbPath, TIXING_LOG: join(tmp, 'smoke-quiz.log') },
  stdio: 'ignore'
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pass = (m) => console.log(`  ✓ ${m}`)
function fail(m) {
  console.error(`  ✗ ${m}`)
  process.exitCode = 1
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return await res.json()
}

async function waitFor(fn, label, tries = 30) {
  for (let i = 0; i < tries; i++) {
    await sleep(400)
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
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }))
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text + ' ' + (msg.result.exceptionDetails.exception?.description ?? '')))
      else resolve(msg.result?.result?.value)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('CDP 连接失败'))
    }
  })
}

const pageMain = async () => {
  const list = await targets()
  return list.find((t) => t.type === 'page' && !t.url.includes('quiz=1'))
}
const pageQuiz = async () => {
  const list = await targets()
  return list.find((t) => t.type === 'page' && t.url.includes('quiz=1'))
}

try {
  const main = await waitFor(pageMain, '主窗口')
  pass('主窗口已打开')

  const created = await evalIn(
    main.webSocketDebuggerUrl,
    `window.tixing.create({ content: '求 lim(x→0) sinx/x 的值', answer: '1', analysis: '洛必达' }).then(r => JSON.stringify(r))`,
    true
  )
  const c = JSON.parse(created)
  if (c.ok) pass(`建题成功 id=${c.data}`)
  else fail(`建题失败 ${JSON.stringify(c)}`)

  const launched = await evalIn(main.webSocketDebuggerUrl, `window.tixing.startQuizNow().then(r => JSON.stringify(r))`, true)
  const l = JSON.parse(launched)
  if (l.ok && l.data.ok) pass(`立即复习 → 弹窗打开（${l.data.count} 题）`)
  else fail(`立即复习失败 ${JSON.stringify(l)}`)

  const quiz = await waitFor(pageQuiz, '弹窗窗口')
  pass('弹窗是独立窗口')

  const stateA = JSON.parse(
    await evalIn(
      quiz.webSocketDebuggerUrl,
      `JSON.stringify({
        quiz: !!document.querySelector('.quiz'),
        reveal: !!document.querySelector('.reveal'),
        placeholder: (document.querySelector('.reveal')?.textContent || '').trim(),
        text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 120)
      })`
    )
  )
  if (stateA.quiz && stateA.reveal) pass(`状态 A（看题）: "${stateA.text}"`)
  else fail(`状态 A 异常: ${JSON.stringify(stateA)}`)

  await evalIn(quiz.webSocketDebuggerUrl, `window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true })), 'sent'`)
  await sleep(400)
  const stateB = JSON.parse(
    await evalIn(
      quiz.webSocketDebuggerUrl,
      `JSON.stringify({
        answerBox: !!document.querySelector('.answer-box'),
        rates: document.querySelectorAll('.rate').length,
        text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160)
      })`
    )
  )
  if (stateB.answerBox && stateB.rates === 3) pass(`空格 → 状态 B，答案与三档自评可见: "${stateB.text}"`)
  else fail(`空格未生效: ${JSON.stringify(stateB)}`)

  await evalIn(quiz.webSocketDebuggerUrl, `window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', bubbles: true })), 'sent'`)
  const closed = await waitFor(async () => !(await pageQuiz()), '弹窗关闭', 20).catch(() => null)
  if (closed !== undefined) pass('按 3 评分 → 弹窗自动关闭')
  else fail('按 3 后弹窗没有关闭')

  const after = await evalIn(
    main.webSocketDebuggerUrl,
    `window.tixing.list('all', '').then(r => JSON.stringify(r.data.map(v => ({ status: v.status, n: v.n, s: v.s }))))`,
    true
  )
  console.log('  评分后题目状态:', after)
} catch (e) {
  fail(e instanceof Error ? e.message : String(e))
} finally {
  child.kill()
}
