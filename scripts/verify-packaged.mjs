// 验证打包产物：连上指定 CDP 端口，确认主窗口渲染且带 v1.2 的标签/新建入口
// 用法: node scripts/verify-packaged.mjs 9447
const port = process.argv[2] || '9447'

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.url.includes('index.html'))
if (!page) {
  console.error('没有找到主窗口页面')
  process.exit(1)
}

const expr = `JSON.stringify({
  dndBtn: !!document.querySelector('.dnd-btn'),
  status: (document.querySelector('.stat')?.textContent || '').trim(),
  topControls: document.querySelectorAll('.ctl').length,
  title: document.title,
  hasTagsApi: typeof window.tixing?.tags === 'function',
  newBtn: [...document.querySelectorAll('.list-actions button')].some((b) => (b.textContent || '').includes('新建'))
})`

const value = await new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => reject(new Error('CDP 超时')), 8000)
  ws.onopen = () =>
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id !== 1) return
    clearTimeout(timer)
    ws.close()
    resolve(m.result?.result?.value)
  }
  ws.onerror = () => {
    clearTimeout(timer)
    reject(new Error('CDP 连接失败'))
  }
})

const info = JSON.parse(value)
console.log('title        :', info.title)
console.log('顶栏控件数   :', info.topControls)
console.log('免打扰入口   :', info.dndBtn)
console.log('tags API     :', info.hasTagsApi)
console.log('独立新建按钮 :', info.newBtn)
console.log('状态栏       :', info.status)
const ok = info.dndBtn === true && info.topControls === 4 && info.hasTagsApi === true && info.newBtn === true
console.log(ok ? '\n✅ 打包产物是 v1.2（含标签 API 与独立新建入口）' : '\n❌ 打包产物看起来不是 v1.2')
process.exit(ok ? 0 : 1)
