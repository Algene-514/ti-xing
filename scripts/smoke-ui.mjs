// UI 冒烟：启动应用 + 通过 CDP 检查主窗口是否真的渲染出内容（而不是白屏）
// 用法: node scripts/smoke-ui.mjs
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const electron = join(root, 'node_modules', 'electron', 'dist', isWin ? 'electron.exe' : 'electron')
const port = 9333
const dbDir = join(root, 'tmp')
mkdirSync(dbDir, { recursive: true })

const child = spawn(electron, ['.', '--no-sandbox', `--remote-debugging-port=${port}`], {
  cwd: root,
  env: { ...process.env, TIXING_DB_PATH: join(dbDir, 'smoke-ui.db'), TIXING_LOG: join(dbDir, 'smoke-ui.log') },
  stdio: 'ignore'
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return await res.json()
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('CDP 超时'))
    }, 8000)
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === 1) {
        clearTimeout(timer)
        ws.close()
        resolve(msg.result?.result?.value)
      }
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('CDP 连接失败'))
    }
  })
}

try {
  let list = []
  for (let i = 0; i < 20; i++) {
    await sleep(800)
    try {
      list = await targets()
      if (list.length > 0) break
    } catch {
      /* 还没起来 */
    }
  }
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('没有找到页面 target：' + JSON.stringify(list))
  console.log('页面:', page.url)

  const info = await evaluate(
    page.webSocketDebuggerUrl,
    `JSON.stringify({
      title: document.title,
      rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
      hasBrand: !!document.querySelector('.brand'),
      hasTopbar: !!document.querySelector('.topbar'),
      text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240)
    })`
  )
  const parsed = JSON.parse(info)
  console.log('title       :', parsed.title)
  console.log('#root 子节点:', parsed.rootChildren)
  console.log('顶栏/品牌   :', parsed.hasTopbar, parsed.hasBrand)
  console.log('可见文本    :', parsed.text)
  const ok = parsed.rootChildren > 0 && parsed.hasTopbar && parsed.hasBrand
  console.log(ok ? '\n✅ 主窗口渲染正常' : '\n❌ 渲染异常（白屏或组件未挂载）')
  process.exitCode = ok ? 0 : 1
} catch (e) {
  console.error('❌', e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  child.kill()
}
