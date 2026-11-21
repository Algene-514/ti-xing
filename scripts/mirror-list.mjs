// 查询 npmmirror 上 better-sqlite3 的预编译包清单（Node 24 自带 fetch，不受 PowerShell TLS 影响）
const BASE = 'https://registry.npmmirror.com/-/binary/better-sqlite3/'

const list = await (await fetch(BASE)).json()
const versions = list.map((x) => x.name)
console.log('镜像上的版本（末尾 6 个）:', versions.slice(-6).join(', '))

for (const v of ['v11.7.0', 'v12.4.1', 'v12.2.0']) {
  if (!versions.includes(v)) {
    console.log(`\n${v}: 镜像上没有`)
    continue
  }
  const files = await (await fetch(BASE + v + '/')).json()
  const win = files.map((f) => f.name).filter((n) => /win32-x64/.test(n))
  console.log(`\n${v} win32-x64 文件:`)
  console.log(win.length ? win.join('\n') : '（无）')
}
