// 下载 Electron 二进制到 node_modules/electron/dist
// 本机 GitHub 不通，默认走 npmmirror 镜像；可用 ELECTRON_MIRROR 覆盖
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
console.log(`ELECTRON_MIRROR = ${process.env.ELECTRON_MIRROR}`)

execFileSync(process.execPath, ['node_modules/electron/install.js'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
})
console.log('electron 二进制就绪')
