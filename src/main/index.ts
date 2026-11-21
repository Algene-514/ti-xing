import { app, BrowserWindow, Menu, Tray, dialog, globalShortcut, ipcMain, nativeImage, powerMonitor, screen } from 'electron'
import { appendFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { DuplicateQuestionError, Store } from './db'
import { pickCandidates } from './scheduler'
import { toView } from '../shared/derive'
import { dndResumeAt, fmtHHMM, inDnd, parseHHMM } from '../shared/dnd'
import { computeBatchSize } from '../shared/srs'
import type { Res } from '../shared/api'
import type {
  FilterKey,
  ImportFile,
  LaunchResult,
  QuestionInput,
  QuizEmptyReason,
  QuizItem,
  Rating,
  Settings,
  SnoozeState
} from '../shared/types'

/** 启动日志（仅当设置 TIXING_LOG 时写文件；GUI 进程的 console 在 Windows 上不可见） */
const LOG_FILE = process.env.TIXING_LOG
function log(...parts: unknown[]): void {
  if (!LOG_FILE) return
  try {
    appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] ${parts
        .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
        .join(' ')}\n`
    )
  } catch {
    /* ignore */
  }
}
log('module loaded')

// 启动兼容性（实测结论，见 README「启动兼容性」）：
// 本机（Windows 11 10.0.26200，且 electron.exe 位于含中文的路径）Chromium 的沙箱初始化
// 会在 JS 执行之前就让主进程以 0x80000003 崩溃，所以 app.commandLine.appendSwitch('no-sandbox')
// 根本来不及生效——必须由启动命令传入 --no-sandbox（npm scripts 里已经带上）。
// 本应用不加载任何远程内容（本地 file:// + CSP + contextIsolation），风险评估可接受。
// 能正常启动的机器可以去掉这个参数，或设置 TIXING_KEEP_SANDBOX=1 提醒自己。

// userData 位置：默认 %APPDATA%\ti-xing 在本机的隔离环境里不可用（whenReady 会卡死、进程退出），
// 且把调试缓存写进系统目录也不干净。dev 模式统一放到项目内 .userdata，打包后仍用系统默认。
// 可用 TIXING_USER_DATA 显式覆盖（CI / 隔离环境）。
const userDataOverride = process.env.TIXING_USER_DATA
if (userDataOverride) {
  app.setPath('userData', userDataOverride)
} else if (!app.isPackaged) {
  app.setPath('userData', join(app.getAppPath(), '.userdata'))
}
log('userData =', app.getPath('userData'))

const APP_ID = 'com.tixing.app'
const HIDDEN_START = process.argv.includes('--hidden')
/** 轮询间隔；TIXING_POLL_MS 仅供自动化测试把节奏拉快 */
const POLL_MS = Number(process.env.TIXING_POLL_MS ?? '') || 30_000
/** 提示条存活时长：生产 3 秒；TIXING_PRENUDGE_MS 仅供自动化测试拉长 */
const PRENUDGE_MS = Number(process.env.TIXING_PRENUDGE_MS ?? '') || 3000
log('consts ok, argv', process.argv.join(' '))

let mainWindow: BrowserWindow | null = null
let quizWindow: BrowserWindow | null = null
let tray: Tray | null = null
let store: Store | null = null
let quitting = false
/** 绝对时刻计时：不用 setTimeout(90min)，否则睡眠唤醒后迟到或连环弹 */
let nextFireAt = 0
let pendingBatch: QuizItem[] = []
let tickTimer: NodeJS.Timeout | null = null
let trayHintShown = false
let lockServer: Server | null = null
/** 单实例锁降级（端口不可用 → 允许双开，靠 WAL + busy_timeout 保底） */
let lockDegraded = false
/** v1.1.0 三秒提示条 */
let preNudgeWin: BrowserWindow | null = null
let preNudgeTimer: NodeJS.Timeout | null = null

// ---------- 单实例 ----------
// 实测：本机 Chromium 的 ProcessSingleton（app.requestSingleInstanceLock()）恒返回 false
// （命名 mutex 在该环境下不可用），会让应用在加载后静默 app.quit()。
// 因此改用 localhost TCP 端口探测：第二次启动连不上自己的端口，就通知第一实例并退出。
// 测试时用 TIXING_LOCK_PORT 隔离，避免和已开着的正式实例抢端口
const LOCK_PORT = Number(process.env.TIXING_LOCK_PORT ?? '') || 39571

function claimSingleInstance(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.write('show')
      socket.end()
      showMainWindow()
    })
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log('another instance holds the lock port, asking it to show')
        const sock = connect(LOCK_PORT, '127.0.0.1', () => {
          sock.write('show')
          sock.end()
        })
        sock.on('error', () => undefined)
        resolve(false)
      } else {
        // 端口不可用的其他原因（权限 / 绑定失败）：降级为双开，靠 WAL + busy_timeout 保底
        log('WARNING: 单实例锁降级，端口不可用:', err.code)
        lockDegraded = true
        resolve(true)
      }
    })
    server.listen(LOCK_PORT, '127.0.0.1', () => resolve(true))
    lockServer = server
  })
}

log('calling whenReady')
app.whenReady().then(async () => {
  const first = await claimSingleInstance()
  log('single instance claim =', first)
  if (!first) {
    app.quit()
    return
  }
  bootstrap()
}).catch((e: unknown) => {
  log('bootstrap failed', e instanceof Error ? e.message : String(e))
  dialog.showErrorBox('题醒启动失败', e instanceof Error ? e.message : String(e))
  app.quit()
})

function bootstrap(): void {
  log('bootstrap start, os', process.platform, process.getSystemVersion())
  app.setAppUserModelId(APP_ID)
  Menu.setApplicationMenu(
    app.isPackaged
      ? null
      : Menu.buildFromTemplate([{ label: 'Developer', submenu: [{ role: 'toggleDevTools' }, { role: 'reload' }] }])
  )

  log('creating store at', dbFilePath())
  store = new Store(dbFilePath())
  log('store ready')
  registerIpc()
  log('ipc registered')
  createTray()
  log('tray created')
  if (lockDegraded) {
    // 醒目提示一次：双开是静默的库损坏风险，不能只写日志
    log('单实例已降级：请确认没有同时开两个题醒')
    tray?.displayBalloon({
      title: '题醒',
      content: '单实例锁降级：端口被占用。请确认没有同时开两个题醒，否则可能同时写库'
    })
  }
  applyAutostart(store.getSettings().autostart)
  createMainWindow()
  log('main window created')
  setNextFire(Date.now())
  const fastMs = Number(process.env.TIXING_FAST_MS ?? '')
  if (fastMs > 0) {
    // 仅自动化测试用：把首次到点拉近（生产不设这个变量）
    nextFireAt = Date.now() + fastMs
    log('TIXING_FAST_MS =', fastMs)
  }
  startTicker()
  log('ticker started, nextFire in', Math.round((nextFireAt - Date.now()) / 1000), 's')

  app.on('activate', () => showMainWindow())
  app.on('window-all-closed', () => {
    // 常驻托盘：不退出
  })
  app.on('before-quit', () => {
    quitting = true
    if (tickTimer) clearInterval(tickTimer)
    if (preNudgeTimer) clearTimeout(preNudgeTimer)
    try {
      globalShortcut.unregisterAll() // 退出时绝不留全局热键
    } catch {
      /* ignore */
    }
    store?.close()
  })
}

function dbFilePath(): string {
  if (process.env.TIXING_DB_PATH) return process.env.TIXING_DB_PATH
  return join(app.getPath('userData'), 'ti-xing.db')
}

// ---------- 窗口 ----------

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0F172A',
    title: '题醒',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  loadRenderer(mainWindow)
  mainWindow.once('ready-to-show', () => {
    if (HIDDEN_START) return
    mainWindow?.show()
  })
  mainWindow.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    mainWindow?.hide()
    if (!trayHintShown) {
      trayHintShown = true
      tray?.displayBalloon({ title: '题醒还在后台', content: '关闭窗口只是收进托盘，到点会弹窗提醒。' })
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function showMainWindow(): void {
  if (!mainWindow) {
    createMainWindow()
    return
  }
  mainWindow.show()
  mainWindow.focus()
}

function loadRenderer(win: BrowserWindow, query?: Record<string, string>): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : ''
    void win.loadURL(`${devUrl}/index.html${qs}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), query ? { query } : undefined)
  }
}

/** 全屏复习弹窗：只遮光标所在的一块屏（盖主屏会在副屏工作时静默劫持键盘输入） */
function openQuizWindow(): void {
  const point = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(point)
  const { x, y, width, height } = display.bounds

  quizWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreen: false,
    show: false,
    backgroundColor: '#0F172A',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  quizWindow.setAlwaysOnTop(true, 'screen-saver')
  loadRenderer(quizWindow, { quiz: '1' })
  quizWindow.once('ready-to-show', () => {
    quizWindow?.show()
    quizWindow?.focus() // 全屏窗默认不抢键盘焦点，不 focus 则空格/1/2/3 全部失效
  })
  quizWindow.on('closed', () => {
    quizWindow = null
    setNextFire(Date.now())
    maybeBacklogBalloon() // v1.1.1：关窗后若还积压，提醒一次
  })
}

function closeQuiz(): void {
  const win = quizWindow
  quizWindow = null
  if (win && !win.isDestroyed()) win.destroy()
  setNextFire(Date.now())
}

// ---------- 计时 ----------

function intervalMs(s: Settings): number {
  return s.intervalMin * 60_000
}

function setNextFire(from: number): void {
  if (!store) return
  nextFireAt = from + intervalMs(store.getSettings())
}

function startTicker(): void {
  tickTimer = setInterval(() => {
    maybeFire()
  }, POLL_MS)
  powerMonitor.on('resume', () => {
    maybeFire() // 合盖回来不装死
  })
}

function maybeFire(): void {
  if (!store || quitting) return
  if (quizWindow || preNudgeWin) return
  const s = store.getSettings()
  if (!s.enabled) return
  const now = Date.now()
  if (isDndNow(now)) {
    // 免打扰：不弹、不写日志、不动任何 next_due，只把下一次触发推到区间结束
    nextFireAt = dndResumeAt(new Date(now), s.dndEnd)
    return
  }
  if (now < nextFireAt) return
  fireQuiz(false)
}

/** 此刻是否处于免打扰（v1.1.0 §3.2） */
function isDndNow(now = Date.now()): boolean {
  if (!store) return false
  const s = store.getSettings()
  return s.dndEnabled && inDnd(new Date(now), s.dndStart, s.dndEnd)
}

// ---------- v1.1.0 三秒提示条 ----------

function preNudgeHtml(count: number, ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000))
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:transparent;overflow:hidden;
      font-family:'Microsoft YaHei',system-ui,sans-serif;-webkit-user-select:none;user-select:none;cursor:pointer}
    .card{box-sizing:border-box;height:100%;padding:11px 14px;border-radius:12px;background:#1E293B;
      border:1px solid #334155;box-shadow:0 10px 30px rgba(0,0,0,.45);color:#E2E8F0}
    .t{font-size:15px;font-weight:600;color:#F8FAFC}
    .s{margin-top:5px;font-size:12px;color:#94A3B8}
    .bar{margin-top:11px;height:4px;border-radius:2px;background:#0F172A;overflow:hidden}
    .bar i{display:block;height:100%;background:#3B82F6;width:100%;animation:run ${ms}ms linear forwards}
    @keyframes run{from{width:100%}to{width:0}}
  </style></head><body>
    <div class="card" onclick="window.tixing &amp;&amp; window.tixing.prenudgeSkip()">
      <div class="t">题醒 · ${sec} 秒后开始复习</div>
      <div class="s">${count} 道到期题 · 按 Esc 或点这里顺延 10 分钟</div>
      <div class="bar"><i></i></div>
    </div>
  </body></html>`
}

/** 到点先闪 3 秒：不抢焦点、可点击顺延，3 秒后进全屏弹窗 */
function showPreNudge(count: number): void {
  if (preNudgeWin) return
  const area = screen.getPrimaryDisplay().workArea
  const w = 360
  const h = 92
  const gap = 24

  preNudgeWin = new BrowserWindow({
    x: area.x + area.width - w - gap,
    y: area.y + gap,
    width: w,
    height: h,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false, // 绝不抢焦点：投屏/会议时不出全屏
    resizable: false,
    movable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  preNudgeWin.setAlwaysOnTop(true, 'screen-saver')
  void preNudgeWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(preNudgeHtml(count, PRENUDGE_MS)))
  preNudgeWin.once('ready-to-show', () => preNudgeWin?.showInactive())
  preNudgeWin.on('closed', () => cleanupPreNudge())

  // 全局 Esc 只活 3 秒；任何分支都必须反注册（finally / closed / before-quit）
  try {
    const ok = globalShortcut.register('Escape', () => skipPreNudge())
    if (!ok) log('globalShortcut Escape 注册失败，降级为只能点提示条或等 3 秒')
  } catch (e) {
    log('globalShortcut 异常', e instanceof Error ? e.message : String(e))
  }

  preNudgeTimer = setTimeout(() => {
    preNudgeTimer = null
    closePreNudge()
    openQuizWindow()
  }, PRENUDGE_MS)
  log('prenudge shown, count =', count)
}

/** 幂等清理：清定时器 + 反注册 Esc（窗口销毁由 closePreNudge 负责） */
function cleanupPreNudge(): void {
  if (preNudgeTimer) {
    clearTimeout(preNudgeTimer)
    preNudgeTimer = null
  }
  try {
    globalShortcut.unregister('Escape')
  } catch {
    /* ignore */
  }
  preNudgeWin = null
}

function closePreNudge(): void {
  const win = preNudgeWin
  cleanupPreNudge()
  if (win && !win.isDestroyed()) win.destroy()
}

/** Esc / 点击提示条 → 顺延 10 分钟，不写日志 */
function skipPreNudge(): void {
  if (!preNudgeWin) return
  closePreNudge()
  nextFireAt = Date.now() + 10 * 60_000
  log('prenudge skipped, next fire in 10 min')
}

function fireQuiz(manual: boolean): LaunchResult {
  if (!store) return { ok: false, reason: 'empty' }
  if (quizWindow) return { ok: true, count: pendingBatch.length }
  if (preNudgeWin) {
    // 提示条还在时点「立即复习」→ 直接进全屏，不再等
    closePreNudge()
    if (pendingBatch.length > 0) openQuizWindow()
    return { ok: true, count: pendingBatch.length }
  }

  const s = store.getSettings()
  const now = Date.now()
  // 积压扩容（v1.1.1 §3.4）：待复习 > 3K 时本批放大到 min(2K, 待复习)；NEW_QUOTA 仍为 2
  const k = s.batchSize
  const kEff = computeBatchSize(store.totals(now).pending, k)
  if (kEff !== k) log('backlog expand: due', store.totals(now).pending, 'k', k, '->', kEff)
  const picked = pickCandidates(store.inner(), now, kEff)

  if (picked.items.length === 0) {
    if (!manual) setNextFire(now)
    return { ok: false, reason: picked.reason ?? 'empty' }
  }

  pendingBatch = picked.items.map((q) => {
    const v = toView(q, now)
    return {
      id: q.id,
      content: q.content,
      answer: q.answer,
      analysis: q.analysis,
      status: v.status,
      daysOverdue: v.daysOverdue,
      isNew: q.n === 0
    }
  })

  if (manual) {
    openQuizWindow()
  } else {
    showPreNudge(pendingBatch.length)
  }
  return { ok: true, count: pendingBatch.length }
}

function feedbackEmpty(reason?: QuizEmptyReason): void {
  const message = reason === 'capped' ? '今日已达上限，明日继续' : '暂无到期题目'
  void dialog.showMessageBox({ type: 'info', message, buttons: ['好'], defaultId: 0 })
}

// ---------- 托盘 ----------

function createTray(): void {
  tray = new Tray(trayImage())
  tray.setToolTip('题醒')
  tray.on('click', () => showMainWindow())
  refreshTrayMenu()
}

function trayImage(): Electron.NativeImage {
  const candidates = [
    join(app.getAppPath(), 'resources', 'tray.png'),
    join(__dirname, '../../resources/tray.png')
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) return img
    }
  }
  return nativeImage.createEmpty()
}

/** 托盘「定时弹窗」三态文案（v1.1.0 §3.2） */
function timerMenuLabel(s: Settings): string {
  if (!s.enabled) return '定时弹窗：已暂停（点击恢复）'
  if (s.dndEnabled && inDnd(new Date(), s.dndStart, s.dndEnd)) {
    return `定时弹窗：免打扰中（${fmtHHMM(s.dndEnd)} 恢复）`
  }
  return '定时弹窗：已开启（点击暂停）'
}

/** v1.1.1 积压气泡：只提示、不扩容、不惩罚 */
function maybeBacklogBalloon(): void {
  if (!store || !tray) return
  const now = Date.now()
  const totals = store.totals(now)
  const k = store.getSettings().batchSize
  if (totals.pending <= k) return
  log('backlog balloon', totals.pending)
  tray.displayBalloon({
    title: '题醒',
    content: `还有 ${totals.pending} 道待复习 · 点此继续`
  })
  tray.once('balloon-click', () => {
    const r = fireQuiz(true)
    if (!r.ok) feedbackEmpty(r.reason)
  })
}

function refreshTrayMenu(): void {
  if (!tray || !store) return
  const s = store.getSettings()
  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => showMainWindow() },
    {
      label: '立即复习',
      click: () => {
        const r = fireQuiz(true)
        if (!r.ok) feedbackEmpty(r.reason)
      }
    },
    { type: 'separator' },
    { label: '备份数据…', click: () => void doBackup() },
    { label: '从备份恢复…', click: () => void doRestore() },
    { type: 'separator' },
    {
      label: '开机启动',
      type: 'checkbox',
      checked: s.autostart,
      click: (item) => {
        applyAutostart(item.checked)
        store?.setSetting('autostart', item.checked ? '1' : '0')
        refreshTrayMenu()
      }
    },
    {
      label: timerMenuLabel(s),
      type: 'checkbox',
      checked: s.enabled,
      click: (item) => {
        store?.setSetting('enabled', item.checked ? '1' : '0')
        if (item.checked) setNextFire(Date.now())
        refreshTrayMenu()
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

function applyAutostart(on: boolean): void {
  if (!app.isPackaged) return // 开发模式不注册登录项（会注册成 electron.exe）
  app.setLoginItemSettings({ openAtLogin: on, args: on ? ['--hidden'] : [] })
}

// ---------- 备份 / 恢复 ----------

async function doBackup(): Promise<void> {
  if (!store) return
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '备份数据',
    defaultPath: join(app.getPath('documents'), `题醒备份-${stamp}.db`),
    filters: [{ name: 'SQLite 数据库', extensions: ['db'] }]
  })
  if (canceled || !filePath) return
  try {
    await store.backup(filePath) // WAL 下必须走 API，裸拷 .db 会漏事务
    void dialog.showMessageBox({ type: 'info', message: '备份完成', detail: filePath, buttons: ['好'] })
  } catch (e) {
    void dialog.showMessageBox({ type: 'error', message: '备份失败', detail: e instanceof Error ? e.message : String(e) })
  }
}

async function doRestore(): Promise<void> {
  if (!store) return
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '从备份恢复',
    properties: ['openFile'],
    filters: [{ name: 'SQLite 数据库', extensions: ['db'] }]
  })
  if (canceled || !filePaths[0]) return
  const src = filePaths[0]
  const confirm = await dialog.showMessageBox({
    type: 'warning',
    message: '当前题库会被完全替换',
    detail: '恢复后程序需要重启。建议先备份当前数据。',
    buttons: ['取消', '恢复并重启'],
    defaultId: 0,
    cancelId: 0
  })
  if (confirm.response !== 1) return

  const target = store.path
  store.close()
  for (const suffix of ['-wal', '-shm']) {
    const side = target + suffix
    if (existsSync(side)) rmSync(side, { force: true })
  }
  copyFileSync(src, target)
  app.relaunch()
  app.exit(0)
}

// ---------- IPC ----------

function wrap<T>(fn: () => T): Res<T> {
  try {
    return { ok: true, data: fn() }
  } catch (e) {
    return { ok: false, error: errorCode(e) }
  }
}

function wrapAsync<T>(fn: () => Promise<T>): Promise<Res<T>> {
  return fn().then(
    (data) => ({ ok: true as const, data }),
    (e: unknown) => ({ ok: false as const, error: errorCode(e) })
  )
}

function errorCode(e: unknown): string {
  if (e instanceof DuplicateQuestionError) return 'DUPLICATE'
  return e instanceof Error ? e.message : String(e)
}

function registerIpc(): void {
  ipcMain.handle('db:list', (_e, filter: FilterKey, q: string) =>
    wrap(() => store!.list(filter ?? 'all', q ?? '', Date.now()))
  )
  ipcMain.handle('db:get', (_e, id: number) => {
    const row = store!.getRow(id)
    return wrap(() => (row ? toView(row, Date.now()) : null))
  })
  ipcMain.handle('db:create', (_e, input: QuestionInput) => wrap(() => store!.create(input, Date.now())))
  ipcMain.handle('db:update', (_e, id: number, input: QuestionInput) =>
    wrap(() => {
      store!.update(id, input, Date.now())
      return null
    })
  )
  ipcMain.handle('db:remove', (_e, id: number) =>
    wrap(() => {
      store!.remove(id)
      return null
    })
  )
  ipcMain.handle('db:import', (_e, files: ImportFile[]) => wrap(() => store!.importFiles(files ?? [], Date.now())))

  ipcMain.handle('settings:get', () => wrap(() => store!.getSettings()))
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) =>
    wrap(() => {
      const cur = store!.getSettings()
      const next: Settings = { ...cur, ...patch }
      if (![60, 90, 120].includes(next.intervalMin)) next.intervalMin = cur.intervalMin
      if (![3, 5, 10].includes(next.batchSize)) next.batchSize = cur.batchSize
      if (![0.8, 0.85, 0.9].includes(next.retention)) next.retention = cur.retention
      if (parseHHMM(next.dndStart) < 0) next.dndStart = cur.dndStart
      if (parseHHMM(next.dndEnd) < 0) next.dndEnd = cur.dndEnd
      next.prenudgeSeconds = 3 // 写死，key 只为将来可调

      store!.setSetting('enabled', next.enabled ? '1' : '0')
      store!.setSetting('interval_min', String(next.intervalMin))
      store!.setSetting('batch_size', String(next.batchSize))
      store!.setSetting('retention', String(next.retention))
      store!.setSetting('autostart', next.autostart ? '1' : '0')
      store!.setSetting('dnd_enabled', next.dndEnabled ? '1' : '0')
      store!.setSetting('dnd_start', fmtHHMM(next.dndStart))
      store!.setSetting('dnd_end', fmtHHMM(next.dndEnd))
      store!.setSetting('prenudge_seconds', String(next.prenudgeSeconds))

      if (next.intervalMin !== cur.intervalMin) setNextFire(Date.now()) // 旧截止时刻作废
      if (next.enabled !== cur.enabled) refreshTrayMenu()
      if (next.autostart !== cur.autostart) applyAutostart(next.autostart)
      if (next.dndEnabled !== cur.dndEnabled || next.dndStart !== cur.dndStart || next.dndEnd !== cur.dndEnd) {
        refreshTrayMenu()
        maybeFire() // 改完 DND 立刻按新规则校正下一次触发
      }
      return next
    })
  )

  ipcMain.handle('app:status', () =>
    wrap(() => {
      const now = Date.now()
      const totals = store!.totals(now)
      const s = store!.getSettings()
      const dnd = s.enabled && s.dndEnabled && inDnd(new Date(now), s.dndStart, s.dndEnd)
      return {
        total: totals.total,
        pending: totals.pending,
        // 四舍五入：10 分钟档不该因毫秒差显示成 11 分钟
        nextFireInMin: Math.max(0, Math.round((nextFireAt - now) / 60_000)),
        enabled: s.enabled,
        dnd,
        dndResumeText: dnd ? fmtHHMM(s.dndEnd) : ''
      }
    })
  )

  ipcMain.handle('quiz:start-now', () =>
    wrap(() => {
      const r = fireQuiz(true)
      return r
    })
  )
  ipcMain.handle('quiz:get-batch', () => wrap(() => pendingBatch))
  ipcMain.handle('quiz:rate', (_e, id: number, rating: Rating) =>
    wrap(() => {
      if (rating !== 1 && rating !== 2 && rating !== 3) throw new Error('非法自评')
      const s = store!.getSettings()
      store!.rate(id, rating, s.retention, Date.now())
      return null
    })
  )
  ipcMain.handle('quiz:done', () =>
    wrap(() => {
      closeQuiz()
      return null
    })
  )
  ipcMain.handle('quiz:skip', (_e, id: number) =>
    wrap(() => {
      store!.logSkip(id, Date.now())
      closeQuiz()
      return null
    })
  )

  // v1.1.1 稍后 10 分钟：与 Esc 的区别是"推迟"而不是"放弃"
  ipcMain.handle('quiz:snooze-state', () =>
    wrap<SnoozeState>(() => {
      const used = store!.snoozeToday(Date.now())
      return { allowed: used < 3, usedToday: used }
    })
  )
  ipcMain.handle('quiz:snooze', (_e, id: number) =>
    wrap(() => {
      const now = Date.now()
      const used = store!.snoozeToday(now)
      if (used >= 3) throw new Error('今日稍后次数已用完')
      store!.bumpSnooze(now)
      store!.logSnooze(id, now) // rating = −1：记"我现在不方便"，与 Esc 的 0 区分开
      closeQuiz()
      nextFireAt = now + 10 * 60_000
      log('snoozed qid', id, 'used', used + 1, 'next fire in 10 min')
      return null
    })
  )

  // v1.1.0 提示条被点击 / 按 Esc
  ipcMain.handle('prenudge:skip', () => {
    skipPreNudge()
  })

  ipcMain.handle('app:backup', () => wrapAsync(() => doBackup().then(() => null)))
  ipcMain.handle('app:restore', () => wrapAsync(() => doRestore().then(() => true)))
  ipcMain.handle('app:quit', () => {
    quitting = true
    app.quit()
  })
}
