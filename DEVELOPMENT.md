> 这是《题醒》的开发/交接文档：环境坑、设计偏离记录（DP-1~4）、逐版本裁决、验收清单。
> 项目介绍、快速开始与路线图请看 [README.md](README.md)。

---

# 题醒（MVP）

到点锁屏，逼你答几道到期的题，答完立刻还你电脑。

设计依据（按优先级）：

- `../设计/《题醒》MVP核心设计-减法版-v0.3.1.md`（勘误版，覆盖 v0.3 的增长因子、配额与 R 定理表述）
- `../设计/《题醒》MVP核心设计-减法版-v0.3.md`（原稿，仅作对照）
- 《题醒》V1.1 设计稿（v1.1.0 / v1.1.1 的范围与裁决，见下文「v1.1.0 / v1.1.1」一节）

---

## 快速开始

```bash
npm install                 # 已配置镜像（见 .npmrc）
node scripts/fetch-prebuild.mjs   # better-sqlite3 的 Electron 预编译包（本机 GitHub 不通，走加速站）
npm run dev                 # 开发模式（已带 --no-sandbox，原因见下文）
```

首次安装如果 `node_modules/electron/dist` 不存在：

```bash
node scripts/install-electron.mjs   # 从 npmmirror 下载 electron 二进制
```

其他命令：

```bash
npm run build       # 构建到 out/
npm run typecheck   # tsc --noEmit
npm test            # 依次运行 test:srs / test:dnd / test:core（条数以输出为准）
npm run gen:icon    # 重新生成托盘/应用图标
```

数据库：dev 模式在项目内 `.userdata/`（Electron userData）下，或由 `TIXING_DB_PATH` 指定的文件；
打包后是 `%APPDATA%\tixing\ti-xing.db`（应用 productName 为 `tixing`）。备份与恢复前请先确认该路径。

---

## 本机环境的三个坑（已内置处理）

这台机器（Windows 11 10.0.26200 + DSH 隔离环境）踩了三个坑，都会让 Electron 应用**静默退出或启动即崩**，
逐个排查后固化进代码，换机器时可以按需回退：

### 1. 启动必须带 `--no-sandbox`（否则 0x80000003 崩溃）

现象：进程启动后立刻以 `0x80000003 (STATUS_BREAKPOINT)` 崩溃，什么都不打印，连主进程的 JS 都跑不到。
分治结论：

| 场景 | 结果 |
|---|---|
| electron.exe 在**英文**路径，app 脚本在中文路径 | ✅ 正常 |
| electron.exe 在**中文**路径（本工程 `《题醒》`），无参数 | ❌ 崩 |
| electron.exe 在中文路径 + `--no-sandbox` | ✅ 正常 |

所以 `npm run dev` / `start` 里带上了 `--no-sandbox`（electron-vite 用 `-- --no-sandbox` 透传）。
注意 `app.commandLine.appendSwitch('no-sandbox')` **没用**——崩溃发生在 JS 执行之前。

安全说明：应用不加载任何远程内容（本地 `file://` + CSP + `contextIsolation`），关沙箱风险可控。
在能正常启动的机器上可以去掉这个参数。

### 2. 单实例锁不能用 `requestSingleInstanceLock()`

现象：`app.requestSingleInstanceLock()` 在这台机器上**恒返回 false**（命名 mutex 不可用），
调用即等于 `app.quit()`，应用静默退出。

处理：改用 localhost TCP 端口探测（`39571`）。第二个实例连不上端口就通知第一个实例显示窗口后退出；
端口被别的软件占用时退化为允许双开，不会阻止启动。

### 3. userData 不能放隔离的 `%APPDATA%`

现象：userData 指到 `%APPDATA%\ti-xing` 时 `app.whenReady()` 永远不 resolve，进程随后退出
（该目录在 DSH 隔离环境里 ACL 受限，`mkdtemp`/写缓存都会 EPERM）。

处理：**dev 模式把 userData 放到项目内 `.userdata/`**；打包后仍用系统默认。
需要自定义时设 `TIXING_USER_DATA=<目录>`。

---

## 与设计稿的偏离（都记在这里，不在别处）

### DP-1 增长因子系数 `0.1 → 4`，并加 `S_MAX = 365`

设计稿 §4.1 的答对增长因子是 `e^(0.1×(1−R)) − 1`。实测（`node scripts/verify-dsr.mjs`）：

```
新题起连续答对 8 次（原稿系数）
第1次 S=1.015 间隔=1.61天
第4次 S=1.091 间隔=1.73天
第8次 S=1.208 间隔=1.92天   ← 间隔封顶 2 天，与"1→3→7→16→35 天"矛盾
```

原因：到期点 R 恒等于 p（设计稿 §4.4 事实 1 自己证明了），所以 `e^(0.1×0.15)−1 ≈ 0.015`，
每次答对 S 只涨 1.5%。

改 `R_BONUS_K = 4` 后，连对 1–4 次后的间隔分别为 2.78 / 6.35 / 14.67 / 34.26 天（与 srs.test.ts 断言一致），对齐目标 3/7/16/35；
再加 `S_MAX = 365`（乘性增长不给上限时第 8 次会到 1146 天）。
想回到原公式：改 `src/shared/srs.ts` 里的 `R_BONUS_K = 0.1`。

### DP-2 单实例：TCP 端口替代 `requestSingleInstanceLock`

见上文坑 2。设计稿要求单实例，实现方式变了，行为不变（第二次启动唤出第一个实例）。

### DP-3 dev 模式 userData 在项目内

见上文坑 3。打包版仍是系统默认路径。

### DP-4 新题配额用 `min` 而不是 `max`

设计稿 §4.3 的代码片段写 `quota = max(NEW_QUOTA, K - takeA.length)`，但同页规则 4 与验收第 3 条
都要求"有旧题到期时新题 ≤ 2 道"。按文字与验收实现为
`quota = takeA.length === 0 ? K : min(NEW_QUOTA, K - takeA.length)`。

---

## 目录

```
src/shared/   srs.ts（DSR 公式与常量）、derive.ts（状态/R/逾期）、md.ts（导入切分）、types.ts、api.ts
src/main/     index.ts（托盘/计时/弹窗/IPC/备份恢复/单实例）、db.ts（建库与 CRUD）、scheduler.ts（分池取候选）
src/preload/  contextBridge → window.tixing
src/renderer/ MainApp.tsx（两栏主窗口）、QuizApp.tsx（全屏弹窗）、styles.css
scripts/      gen-icon.mjs、fetch-prebuild.mjs、install-electron.mjs、verify-dsr.mjs、test-core.mjs
test/         srs.test.ts（公式断言）、dnd.test.ts（免打扰）、core.test.cjs（真实 SQLite 断言）
```

## 导入语法（唯一契约）

支持 `.md` / `.markdown` / `.txt`，可拖入单个文件或整个文件夹：

```markdown
# 题目
求 lim(x→0) sinx/x 的值
# 答案
1
# 解析
洛必达……
```

- 只认行首 1–3 个 `#` + 关键字，且关键字独占该行
- 一个文件可含多个「题目」块，按出现顺序切
- 找不到任何「题目」行 → 整篇当题目，答案留空
- 整次导入在一个事务里：中途数据库出错则全部回滚
- 去重靠唯一索引（`question.content`），撞了跳过，不报错

## 测试

```bash
npm run test:srs    # 纯函数：公式、常量、Markdown 切分（15 条）
npm run test:core   # 真实 SQLite：调度、状态、级联删除、导入去重、设置持久化、稍后日志（15 条）
```

`test:core` 会先用 esbuild 把 `db.ts`/`scheduler.ts` 打成 CJS，再用 **Electron 的 Node**
（`ELECTRON_RUN_AS_NODE=1`）跑，因为 better-sqlite3 编译的是 Electron ABI（130）。

## 打包

```bash
npm run build
# 本机必需的环境变量见下表
node node_modules/electron-builder/cli.js --win nsis --x64 --config.electronDist=node_modules/electron/dist
```

产物（`dist/`）：

- `tixing-setup-1.1.1.exe` —— NSIS 安装包（80.7 MB，默认装到 `%LOCALAPPDATA%\Programs\tixing`，快捷方式名「题醒」）
- `win-unpacked/` —— 绿色版，整个目录复制到**英文路径**即可直接运行

打包时的环境变量（本机必需，缺一个就会失败）：

| 变量 | 值 | 缺了会怎样 |
|---|---|---|
| `ELECTRON_BUILDER_BINARIES_MIRROR` | `https://npmmirror.com/mirrors/electron-builder-binaries/` | nsis / winCodeSign 从 GitHub 下不下来 |
| `ELECTRON_BUILDER_CACHE` | `<项目>/tmp/eb-cache` | `%LOCALAPPDATA%\electron-builder` 建不出来，直接 Access denied |
| `TMP` / `TEMP` | `<项目>/tmp/nsis-tmp` | makensis 报 `!tempfile: Unable to create temporary file` |
| `CSC_IDENTITY_AUTO_DISCOVERY` | `false` | 没有证书时反复尝试签名 |

配置里已经处理的三件事：

- `npmRebuild: false` —— 用现成的预编译包，不让 `@electron/rebuild` 去下载 electron headers（下载还会把 build 目录清空）
- `asarUnpack: ["node_modules/better-sqlite3/**"]` —— 原生模块必须解包，否则运行时 bindings 找不到
- `signAndEditExecutable: false` —— winCodeSign 解压需要符号链接权限（普通用户没有），跳过 exe 资源编辑
  （代价：exe 显示 Electron 默认图标）

安装包在 DSH 隔离环境里无法静默安装（`/S` 返回 0 但无产物），需要在真实桌面双击安装；
绿色版已实测可启动（`C:\Users\12131\tixing-app\tixing.exe`），**不带 `--no-sandbox`**，英文路径。

## v1.1.0 / v1.1.1（不社死 + 不打断）

按《题醒》V1.1 设计稿的第一刀实现。**不动数据库结构**：只新增 setting key（`getSettings` 对缺失 key 用默认值），
`user_version` 仍是 1，建表迁移留给 v1.1.2。

### 做了什么

| 项 | 实现要点 | 验证 |
|---|---|---|
| 三秒提示条 | 主屏 workArea 右上角 360×92 透明窗，`focusable:false` + `showInactive()`，绝不抢焦点 | smoke Phase A/B |
| — 点击顺延 | 卡片**可点**（没有 `setIgnoreMouseEvents(true)`，按你的决定），点击调 `prenudgeSkip` | smoke Phase A |
| — Esc 顺延 | `globalShortcut.register('Escape')`，只活 `PRENUDGE_MS`；`closed` / `finally` / `before-quit` 三处 `unregister` | smoke Phase A |
| 免打扰时段 | `dnd_enabled` / `dnd_start` / `dnd_end`；区间内**不写日志、不动任何 `next_due`**，只把 `nextFireAt` 推到 `dnd_end` | smoke Phase C + `test:dnd` |
| 托盘 / 状态栏三态 | `已开启` / `已暂停` / `免打扰中（08:00 恢复）` | 状态字段 + 代码 |
| 稍后 10 分钟 | 弹窗内按 S 或点「稍后(S)」：关窗、`nextFireAt = now + 10min`、写一行 `rating = −1`；当日 3 次后置灰、S 无效。**当日次数不从 `review_log` 统计**，而是存在 `setting` 表的 `snooze_date` / `snooze_count` 里，按本地日期归零 | smoke Phase C + `test:core` |
| 积压扩容 | `待复习 > 3K → K_eff = min(2K, 待复习)`，只放大单批；`NEW_QUOTA` 仍为 2 | 代码 + `test:core` |
| 间隔上限 | `T_MAX_DAYS = 180`：连对第 6 次起不再延长（原来会飞到 ~580 天） | `test:srs` 2 条 |
| 单实例护栏 | `journal_mode = WAL` + `busy_timeout = 5000` + 显式 `127.0.0.1` 绑定；TCP 不可用时降级双开，打印醒目日志 + 托盘提示一次 | 代码 |

### 与 v1.1 文档的四处裁决

1. **不显示 R**。v1.1 §6 的标题栏写 `R=0.52 稍后(S) esc`，但 v0.3 已判定「到期点 R 恒等于 p」没有信息量。
   实现只加「稍后(S)」，标题栏不出现 R。
2. **DND 不用 `setTimeout`**。文档 §3.2 写「计时器 = 距离 dnd_end 的毫秒数（单次 timeout）」，
   这里改成 `nextFireAt = dndResumeAt(...)`，沿用 30 秒轮询 + `powerMonitor.resume` 补偿——
   合盖睡一夜醒来，DND 该解除就解除，不会因为定时器停摆而整晚卡住。
3. **零迁移**。`ALTER TABLE` 和 tag 表都推迟到 v1.1.2，前两个包只写 setting。
4. **`T_MAX_DAYS = 180`**（v0.3.1 勘误）。乘性增长随 D 变低越来越陡，连对第 6 次到 ~185 天 = 这学期再也见不到。
   截断后「到期点 R ≡ p」只在未触顶时成立，按 R 排序对超长间隔题轻微失真（可接受）。

### 已知取舍

- **单实例降级不做文件锁兜底**：`39571` 端口被占概率极低，而文件锁自身也会失败（桩锁、PID 复用、跨用户读进程），
  用 40 行代码换一个概率极低的分支不划算。降级时靠 `WAL + busy_timeout = 5000` 串行化写入，并打日志 + 托盘提示一次。
- **积压不再用托盘气泡**：Win11 会把 `displayBalloon` 转成系统 toast，用户可以一键关掉应用全部通知；改为单批扩容，积压被消化而不是被通知。
- **Leech 延后**：`T_MAX` 让"会做的题"飞去 180 天后，池子里更容易只剩错题，顽固题霸位风险变高——登记进 v1.1.2 待办。

### 度量口径（四类 SQL）

```sql
SELECT COUNT(*) FROM review_log;                              -- 弹窗总轮次
SELECT COUNT(*) FROM review_log WHERE rating BETWEEN 1 AND 3; -- 真答案数
SELECT COUNT(*) FROM review_log WHERE rating = 0;             -- Esc 次数（我现在不想学）
SELECT COUNT(*) FROM review_log WHERE rating = -1;            -- 稍后次数（我现在不方便）
```

### 测试

```bash
npm run test:srs            # 15 条公式（含 T_MAX 与 8 连对序列）
npm run test:dnd            # 9 条 DND（跨午夜是重点）
npm run test:core           # 15 条真实 SQLite（含 -1 日志、四类计数、间隔上限）
node scripts/smoke-v11.mjs  # 25 条行为断言：提示条 / 顺延 / 自动全屏 / DND / 稍后
```

冒烟脚本用的测试环境变量（生产不设）：`TIXING_FAST_MS`（首次到点拉近）、`TIXING_POLL_MS`、
`TIXING_PRENUDGE_MS`（提示条时长）、`TIXING_LOCK_PORT`（单实例端口隔离）。

## 验收状态

自动化验证通过（`npm test` + `scripts/smoke-ui.mjs` + `scripts/smoke-quiz.mjs`）：

- [x] `npm run build` 与 `tsc --noEmit` 通过，产物齐全
- [x] dev 模式启动：主进程 / 托盘 / 主窗口 / 计时器全部就绪，db 正常创建
- [x] 主窗口渲染（CDP 实读 DOM：顶栏 4 个控件、筛选 chips、空态、状态栏都在）
- [x] 闭环：建题 → 「立即复习」→ 弹窗（独立窗口）→ 空格显答案 → 按 3 → 弹窗自动关闭
- [x] 评分后题目变「未到期」、n=1、S=1.7526（与公式一致）
- [x] 调度：A 池空时新题满 K、有旧题时新题 ≤ 2、当日 ≤ 2 次、R 升序
- [x] 状态四态与筛选口径、待复习计数
- [x] 答对/不会的间隔与 S/D 变化、review_log 字段
- [x] Esc 只写 rating=0 且不改状态
- [x] 删除级联、导入去重、重复题目报错、设置持久化
- [x] 单实例：第二个实例只唤出第一个，不重复起计时器
- [x] 打包：NSIS 安装包生成（80.7 MB）+ 绿色版在英文路径实测启动（标题「题醒」、db 正常、托盘就绪）
- [x] **v1.1.0 提示条**：到点先出小窗、内容正确、点击 / Esc 都能顺延 10 分钟、不按则自动进全屏、残窗清理干净
- [x] **v1.1.0 DND**：区间内到点不弹（既不提示条也不弹窗）、`next_due` 一毫秒未变、手动复习不受限、状态栏文案正确
- [x] **v1.1.1 稍后**：3 次 10 分钟档生效、第 4 次 allowed=false 且被拒、被拒后弹窗保留、Esc 仍然可用（计数来源：setting 表）
- [x] **v1.1.1 日志口径**：稍后写 `rating = -1`，与 Esc 的 `0` 分开计数，四类 SQL 互不污染
- [x] **v1.1.1 间隔上限**：8 连对序列 2.78 / 6.35 / 14.67 / 34.26 / 80.96 / **180 / 180 / 180**，任何 next_due 都不超 180 天
- [x] **v1.1 全量**：srs 15 + dnd 9 + core 15 + smoke-v11 25 = 64 条断言全绿

需要人肉过一遍（我只到 CDP 层，没有物理键鼠 / 双屏 / 托盘点击）：

- [x] **提示条出现时，在别的程序（全屏视频 / 投屏）里按 Esc → 小窗消失且 10 分钟不再弹；同时确认这 3 秒内别处的 Esc 被吃掉后能恢复（`closed` / `finally` / `before-quit` 三处 `unregister` 是否都执行到）**
- [x] 物理键盘空格 / 1 / 2 / 3 / S，以及**中文输入法开着**时仍然生效（S 走 `event.code` 且 `isComposing` 时跳过）
- [x] 弹窗开在鼠标所在屏（双屏）；提示条固定在主屏右上角
- [x] 托盘：备份数据… / 从备份恢复… / 开机启动 / 暂停 / **免打扰中 三态文案**
- [x] **开机自启**：重启系统 → 托盘图标是否自动出现（v0.3.1 §8 验收项；不做这条，7 天指标物理上不成立）
- [x] 改间隔 1 分钟 → 自动弹窗；改回 90 分钟 → 不再按 1 分钟弹
- [x] 合盖睡眠 5 分钟唤醒后不连环弹；跨过 dnd_end 后能正常弹
- [x] 积压扩容：题库造 20 道到期题、每次 5 题 → 本批应弹 10 道（2K 封顶），不是 5 道
- [x] 绿色版 `tixing.exe` 不带 `--no-sandbox` 在英文路径启动成功（已实测）
- [x] 在真实桌面双击 `tixing-setup-1.1.1.exe` 完成安装并启动（**不带** `--no-sandbox`，英文安装路径）

---

## v1.2（标签 + 搜索 + 快捷键 + 独立新建入口）

立项文档：`../设计/V1.2 立项草案（定稿）.md`（范围、验收、未决事项）。

### 数据库迁移 1 → 2（v1.2 §4）

- 建 `tag` / `question_tag` 两张表 + `idx_qt_tag`；`title_text`、`content_hash` 仍留给录题包，不在本次。
- 顺序：`Store` 构造时只做 v0→v1；主进程 `bootstrap()` 里 `await ensureV2Migration()`：
  先 `db.backup(userData/ti-xing-backup-v2-<时间戳>.db)`，**备份失败则中止迁移、弹错误框、保持 user_version=1**（下次启动重试）；备份成功后 `store.migrateToV2()` 事务建表 + 版本推进。
- 迁移中止时 `Store.v2Ready=false`：标签写入被忽略（录题不受阻），`getTags()` 返回空，列表照常。
- 测试：`test:core` 覆盖备份可打开、升到 2、重复启动不重复迁移、备份失败中止（4 条）。

### 标签

- 名字上限 `TAG_MAX_LEN = 12`（`shared/types.ts`），db 层按 Unicode 字符截断（`Array.from`），UI 层在 save 时提示「超长标签名已截断为 12 字」。
- `setQuestionTags`：trim → 去空 → 截断 → NOCASE 去重（与 `UNIQUE COLLATE NOCASE` 对齐）→ 删旧关联 → `INSERT OR IGNORE` + `question_tag`。
- `getTags()` 只返回至少关联一道题的标签（JOIN + COUNT > 0），空标签不进入筛选下拉。
- 删除题目由外键 `ON DELETE CASCADE` 连带清理 `question_tag`；删除标签的语义 = 从题目上移除（编辑里删掉），tag 行残留但 count=0 不显示。

### 搜索（LIKE）

- `Store.list()` 改为 SQL 过滤：`content / answer / analysis / 标签名`；空格分多词，每个词 AND；`%`、`_`、`\` 转义后配合 `ESCAPE '\'` 按字面匹配。
- 排序仍在内存按 R 升序（`compareByR`），不改变原有口径；筛选（全部/今日/已逾期）与标签筛选取交集。
- UI：搜索 `onChange` 200ms 防抖；`Ctrl/Cmd+F` 聚焦、`Esc`（焦点在搜索框内时）清空。

### 快捷键（主窗口）

- `Ctrl/Cmd+F` 聚焦搜索；`Ctrl/Cmd+N` 打开新建（仅 `view` 模式，编辑态不覆盖）；`Esc` 仅当 `e.target === 搜索框` 时清空。
- 全部挂在主窗口 `window.addEventListener('keydown')`，不注册全局快捷键；复习弹窗是独立 BrowserWindow，天然收不到主窗口事件。

### 独立新建入口

- 左侧列表底部 `+ 新建` 常驻；选中题目时可用；编辑态 disabled（tooltip「先保存或取消当前编辑」），与 `Ctrl/Cmd+N` 等价。

### 测试（v1.2 新增）

```bash
npm run test:core          # 20 条（+5：标签 ×2、搜索 ×1、迁移 ×2）
node scripts/smoke-v12.mjs # 17 条：标签显示/折叠/筛选、搜索 AND/转义、快捷键、新建入口
```

`smoke-ui.mjs` 已补「等 React 挂载」轮询（迁移让启动多一步，原脚本会误报白屏）。

### 待办（发版前）

- [x] 人肉验收：迁移在**真实旧库**（`.userdata/ti-xing.db`，user_version=1）上跑一次，确认备份文件与题库计数
- [x] 真实键盘：中文输入法开着按 Ctrl+F / Ctrl+N / Esc
- [x] 打 `tixing-setup-1.2.0.exe`（80.7 MB，`dist-v12/`）；绿色版复制到英文路径启动 + CDP 核验通过（tags API、独立新建按钮、免打扰入口都在）
