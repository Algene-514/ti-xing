# 题醒 (Tixing)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 到点锁屏，逼你答几道到期的题，答完立刻还你电脑。

桌面常驻的间隔重复复习工具。它不是又一个 Anki，也不打算做学习平台——**只做一件事：按记忆曲线，在你最需要的那 3 秒里出现，答完就走。**

```
到点啦
  └─ 右上角闪一个 3 秒小条：不抢焦点、不拦鼠标、不社死
       ├─ 按 Esc / 点一下 → 顺延 10 分钟
       └─ 不管它 → 全屏弹窗：题面 → 空格看答案 → 1/2/3 自评 → 下一题
```

## 这是什么

- **锁屏式复习**：到点弹一块全屏窗（只遮鼠标所在的那块屏），答完自动关；
- **自己录的题才有用**：手动录题、或从 Markdown / Obsidian 批量导入；
- **记忆算法驱动**：DSR 模型（稳定度 S / 难度 D / 可提取性 R），决定每道题下一次什么时候出现；
- **纯本地**：SQLite 单文件，不联网、不上传、无账号；
- **不打扰**：免打扰时段、3 秒提示条、稍后 10 分钟——开会、投屏、深夜都不至于让你把软件删了。

## 功能一览（v1.1.1）

| 模块 | 能力 |
|---|---|
| 复习闭环 | 定时到点 → 3 秒提示条 → 全屏弹窗；空格显答案，`1/2/3` 自评后自动下一题 |
| 调度算法 | 到期题按可提取性 R 升序、新题配额 ≤ 2、单题当日最多 2 次、答错 6 小时后可再测 |
| 免打扰 | 任意区间（支持跨午夜），区间内不弹、**不改任何到期时间**；手动「立即复习」不受限 |
| 稍后 10 分钟 | 弹窗内按 `S` 或点「稍后(S)」，当日 3 次后置灰；与「跳过」分开计数 |
| 积压消化 | 待复习 > 3×每批题量时，本批自动扩容至最多 2 倍（不推送轰炸） |
| 数据 | 题库 / 复习日志 / 设置三张表；WAL 模式；备份与恢复走 SQLite 官方 API |
| 导入 | `.md` / `.txt` 单文件或整个文件夹；多题块切分；事务导入；按题干去重 |

### 弹窗快捷键

| 按键 | 动作 |
|---|---|
| `空格` / `回车` | 显示答案 |
| `1` / `2` / `3` | 不会 / 模糊 / 答对 |
| `Esc` | 跳过（记录为「不想学」，`rating = 0`） |
| `S` | 稍后 10 分钟（记录为「不方便」，`rating = −1`） |

## 快速开始

### 从源码运行

```bash
npm install
node scripts/fetch-prebuild.mjs   # better-sqlite3 的 Electron 预编译包
node scripts/install-electron.mjs # 若 node_modules/electron/dist 不存在
npm run dev
```

要求：Node.js 22+、Windows 10/11（当前只在 Windows 上验证过）。

> `.npmrc` 已指向国内 npm 镜像（作者在无法直连 GitHub 的网络环境开发）；海外网络可删除该文件。

### 安装包

用 [electron-builder](https://www.electron.build/) 打包 NSIS 安装包（约 80 MB），见下方「打包」。暂未发布 Releases，可自行构建。

## 使用方式

### 录题

主窗口右下「+ 新建题目」，填题干 / 答案 / 解析即可。题目只存在本地数据库里。

### 从 Markdown 导入

支持 `.md` / `.markdown` / `.txt`，可拖入文件或整个文件夹：

```markdown
# 题目
求 lim(x→0) sinx/x 的值
# 答案
1
# 解析
洛必达，或等价无穷小。
```

- 只认行首 1–3 个 `#` + `题目/答案/解析`（关键字独占一行）；
- 一个文件可含多个「题目」块；
- 找不到「题目」行时整篇当题目（不打断批量导入）；
- 整次导入一个事务，中途出错全部回滚；重复题干自动跳过。

### 界面与托盘

- 顶部四个控件：锁屏复习开关、触发间隔（60/90/120 分钟）、每次题量（3/5/10）、目标保持率（90/85/80%）；
- 右上角 `⏰` 打开免打扰设置；
- 关闭主窗口 = 收进托盘；托盘菜单：立即复习 / 备份数据 / 从备份恢复 / 开机启动 / 定时弹窗（三态）/ 退出。

## 工作原理

```
定时轮询(30s) ──→ 到点？
                   ├─ 免打扰中 → 顺延到区间结束（不动任何题目数据）
                   └─ 否 → 取一批到期题 → 3 秒提示条
                              ├─ Esc / 点击 → 10 分钟后再说（不写日志）
                              └─ 3 秒到 → 全屏弹窗
                                        ├─ 空格 → 显示答案 → 1/2/3 自评 → 写库 → 下一题
                                        ├─ Esc → 跳过，90 分钟后再弹
                                        └─ S → 稍后，10 分钟后再弹
```

### 为什么是「间隔重复」

记忆强度 S 随时间衰减为可提取概率 R，到期点 R 恒等于目标保持率 p（默认 0.85）。答对会拉长 S、降低难度 D；答错则缩短 S、拉高 D。核心公式：

```
R(Δt) = 1 / (1 + Δt / (9S))
T_next = 9S(1/p − 1)                                  ← p = 目标保持率
答对：S' = S × (1 + e^(0.2×(5−D)) × (e^(4×(1−R)) − 1) × 1.5)
```

几个刻意的工程决策：

- **答对增长系数 K = 4**（设计原稿 0.1）：原稿下间隔每次只涨约 1.5%，永远到不了「3/7/16/35 天」的目标序列；
- **间隔上限 180 天**：乘性增长会让连对 6 次后的间隔飞到 ~580 天 = 一个学期都见不到这道题；
- **单题当日 ≤ 2 次**：否则「答错 → 6 小时后再见 → 又答错」的题会垄断每一次弹窗；
- **免打扰期间不动任何 `next_due`**：只推迟「弹窗时刻」，绝不篡改复习计划本身。

## 技术栈与架构

| 层 | 技术 | 职责 |
|---|---|---|
| 外壳 | Electron 33 | 窗口 / 托盘 / 全局快捷键 / 系统事件 |
| 主进程 | Node.js + better-sqlite3 | 计时调度、数据库、导入、备份恢复 |
| 界面 | React 18 + TypeScript 5.7 | 主窗口与全屏弹窗（无 UI 框架，纯 CSS） |
| 构建 | electron-vite 2 + Vite 5 | 三端打包，开发热更新 |
| 发布 | electron-builder 25 | NSIS 安装包 + 绿色版 |
| 测试 | node:test 风格断言 + CDP 冒烟 | 纯函数、真实 SQLite、界面行为三层验证 |

```
主进程（Node：调度 / 托盘 / 数据库 / 备份）
   │  ipcMain.handle  ◄──┐
   ▼                      │
preload：contextBridge 把白名单 API 挂成 window.tixing
   │                      │
   ▼                      │
渲染进程（React：主窗口 + 全屏弹窗）──► IPC 调用 ──┘

主进程独占一个 SQLite 文件（WAL）：题库 / 复习日志 / 设置
```

- 渲染进程零 Node 权限（`contextIsolation: true`），只能通过白名单 IPC 访问数据；
- 不加载任何远程内容，CSP + 本地文件；
- 单实例用 localhost TCP 端口探测（这台机器上 `requestSingleInstanceLock()` 不可用，见开发文档）。

## 项目结构

```
src/
├─ main/      index.ts 窗口/托盘/计时/提示条/DND/稍后/备份 IPC
│            db.ts      SQLite 建库迁移、CRUD、评分、日志、导入
│            scheduler.ts  A 池到期题 + B 池新题 → 一批
├─ preload/   contextBridge → window.tixing
├─ renderer/  MainApp.tsx（主窗口）QuizApp.tsx（全屏弹窗）styles.css
└─ shared/    srs.ts / dnd.ts / derive.ts / md.ts（纯函数，可独立测试）
test/         srs（16）+ dnd（9）+ core（15，真实 SQLite）
scripts/      冒烟（25 条行为断言）、预编译包、图标、打包核验
```

## 测试

```bash
npm run test:srs    # 16 条：公式、常量、8 连对序列、间隔截断
npm run test:dnd    # 9 条：免打扰（重点跨午夜）
npm run test:core   # 15 条：真实 SQLite 集成（调度/评分/日志/导入去重）
npm test            # 以上全部
node scripts/smoke-v11.mjs  # 25 条界面行为断言（需开发版窗口 + CDP）
```

合计 65 条断言。其中 `test:core` 通过 esbuild 打包后用 Electron 的 Node 运行（better-sqlite3 编译的是 Electron ABI）。

## 打包

```bash
npm run build
node node_modules/electron-builder/cli.js --win nsis --x64 --config.electronDist=node_modules/electron/dist
```

在无法直连 GitHub 的机器上需要这些环境变量（详见[开发文档](DEVELOPMENT.md)）：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:ELECTRON_BUILDER_CACHE = '<项目>/tmp/eb-cache'
$env:TMP = '<项目>/tmp/nsis-tmp'; $env:TEMP = $env:TMP
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
```

产物：`dist/tixing-setup-1.1.1.exe`（NSIS）与 `dist/win-unpacked/`（绿色版，复制到英文路径可直接运行）。

## 已知限制

- **仅 Windows 验证过**；Linux/macOS 未测试。
- 当前导入是极简版：**不读 frontmatter、不处理图片、不渲染公式**。v1.1.2 正在做（见路线图）。
- 应用 exe 暂用 Electron 默认图标（无代码签名证书，`signAndEditExecutable: false`）。
- 界面暂无多语言。

## 路线图

| 版本 | 状态 | 内容 |
|---|---|---|
| v1.0 MVP | ✅ | 调度 / 主窗口 / 全屏弹窗 / 托盘 / 导入 / 备份恢复 / 打包 |
| v1.1.0 | ✅ | 3 秒提示条、免打扰时段 |
| v1.1.1 | ✅ | 稍后 10 分钟、积压单批扩容、间隔上限 180 天 |
| **v1.1.2** | 🧭 计划中 | Obsidian 完整导入（frontmatter / 图片 / 导入预览）+ KaTeX 公式渲染 |
| v1.2 | 计划 | 标签最小版、窗口内快捷键 |

**明确不做**（防止功能膨胀，写下来就不加了）：统计图表 / 遗忘曲线、云同步与多设备、AI 出题、富文本编辑器、主题皮肤、连续天数与成就系统——这是刷题 App 的性格，不是题醒的。

## 开发文档

环境坑（中文路径、单实例、userData）、设计稿偏离记录、每个版本的裁决理由、验收清单，都在 [DEVELOPMENT.md](DEVELOPMENT.md)。

## License

[MIT](LICENSE)
