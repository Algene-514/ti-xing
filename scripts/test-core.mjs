// 一条命令跑核心测试：先用 esbuild 把 db/scheduler 打成 CJS，再用 Electron 的 Node 跑
// （better-sqlite3 是为 Electron ABI 编译的，普通 node 加载不了）
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const electron = join(root, 'node_modules', 'electron', 'dist', isWin ? 'electron.exe' : 'electron')

function run(cmd, args, extraEnv = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...extraEnv } })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

console.log('→ 编译 db.ts / scheduler.ts')
run(process.execPath, [
  'node_modules/esbuild/bin/esbuild',
  'src/main/db.ts',
  'src/main/scheduler.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--external:better-sqlite3',
  '--outdir=tmp/testbuild'
])

console.log('→ 运行核心断言（Electron Node，ABI 匹配）')
run(electron, ['test/core.test.cjs'], { ELECTRON_RUN_AS_NODE: '1' })
