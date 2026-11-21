// 校验 npmmirror 上的 electron zip 是否与官方 checksums.json 一致
// 用法: node scripts/verify-electron-zip.mjs
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const require = createRequire(join(root, 'package.json'))
const version = require('electron/package.json').version
const zipName = `electron-v${version}-win32-x64.zip`
const expected = require('electron/checksums.json')[zipName]
const dest = join(root, 'tmp', zipName)
const mirrors = [
  `https://npmmirror.com/mirrors/electron/${version}/${zipName}`,
  `https://ghfast.top/https://github.com/electron/electron/releases/download/v${version}/${zipName}`
]

mkdirSync(dirname(dest), { recursive: true })

async function sha256File(path) {
  return await new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

let got = false
if (!existsSync(dest)) {
  for (const url of mirrors) {
    try {
      console.log(`下载 ${url}`)
      const res = await fetch(url)
      if (!res.ok) {
        console.log(`  HTTP ${res.status}`)
        continue
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 50_000_000) {
        console.log(`  文件过小 ${(buf.length / 1e6).toFixed(1)} MB，忽略`)
        continue
      }
      writeFileSync(dest, buf)
      console.log(`  已保存 ${(buf.length / 1e6).toFixed(1)} MB`)
      got = true
      break
    } catch (e) {
      console.log(`  失败 ${e instanceof Error ? e.message : e}`)
    }
  }
} else {
  got = true
}

if (!got) {
  console.error('没有可用的 zip')
  process.exit(1)
}

const actual = await sha256File(dest)
console.log(`期望 sha256: ${expected}`)
console.log(`实际 sha256: ${actual}`)
console.log(actual === expected ? '✅ 与官方一致（二进制完整）' : '❌ 与官方不一致（镜像包被改动或损坏）')
