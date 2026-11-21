// 手动补 better-sqlite3 的 Electron 预编译包（本机 GitHub 不通，走加速站）
// 用法: node scripts/fetch-prebuild.mjs <abi>   例: node scripts/fetch-prebuild.mjs 130
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const require = createRequire(join(root, 'package.json'))

const pkgPath = join(root, 'node_modules', 'better-sqlite3', 'package.json')
const bsVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version
const electronPkg = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'))
const abi = process.argv[2] || String(require('node-abi').getAbi(electronPkg.version, 'electron'))
const name = `better-sqlite3-v${bsVersion}-electron-v${abi}-win32-x64.tar.gz`
const ghUrl = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bsVersion}/${name}`
const bases = ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/']

console.log(`better-sqlite3 ${bsVersion} / electron ${electronPkg.version} / ABI ${abi}`)
console.log(`目标文件 ${name}`)

const tmpDir = join(root, 'tmp')
mkdirSync(tmpDir, { recursive: true })
const tmpFile = join(tmpDir, name)

let ok = false
for (const base of bases) {
  try {
    const res = await fetch(base + ghUrl, { redirect: 'follow' })
    if (!res.ok) {
      console.log(`${base}: HTTP ${res.status}`)
      continue
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 100_000) {
      console.log(`${base}: 文件过小（${buf.length}），跳过`)
      continue
    }
    writeFileSync(tmpFile, buf)
    console.log(`${base}: 下载成功 ${(buf.length / 1024 / 1024).toFixed(1)} MB`)
    ok = true
    break
  } catch (e) {
    console.log(`${base}: 失败 ${e instanceof Error ? e.message : e}`)
  }
}

if (!ok) {
  console.error('全部镜像失败')
  process.exit(1)
}

const target = join(root, 'node_modules', 'better-sqlite3')
execFileSync('tar', ['-xzf', tmpFile, '-C', target], { stdio: 'inherit' })
console.log(`解压完成 → ${join(target, 'build', 'Release')}`)
