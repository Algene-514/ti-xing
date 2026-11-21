// 生成托盘与应用图标（纯 Node，无第三方依赖）：一个蓝底 + 白色对勾的圆。
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy || 1
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  const radius = size / 2 - Math.max(1, size * 0.02)
  const lineW = size * 0.085
  // 对勾三点（相对坐标）
  const p1 = [0.3 * size, 0.53 * size]
  const p2 = [0.45 * size, 0.67 * size]
  const p3 = [0.72 * size, 0.36 * size]

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const d = Math.hypot(x - c, y - c)
      // 抗锯齿圆形边缘
      const circleAlpha = Math.max(0, Math.min(1, radius - d + 0.5))
      if (circleAlpha <= 0) {
        rgba[i + 3] = 0
        continue
      }
      // 底色 #1E3A8A 偏深，便于浅色/深色任务栏都看得见
      let r = 0x1e
      let g = 0x3a
      let b = 0x8a
      const dd = Math.min(
        distToSegment(x, y, p1[0], p1[1], p2[0], p2[1]),
        distToSegment(x, y, p2[0], p2[1], p3[0], p3[1])
      )
      const check = Math.max(0, Math.min(1, lineW - dd + 0.5))
      if (check > 0) {
        r = Math.round(r * (1 - check) + 255 * check)
        g = Math.round(g * (1 - check) + 255 * check)
        b = Math.round(b * (1 - check) + 255 * check)
      }
      rgba[i] = r
      rgba[i + 1] = g
      rgba[i + 2] = b
      rgba[i + 3] = Math.round(255 * circleAlpha)
    }
  }
  return encodePNG(size, size, rgba)
}

mkdirSync(join(root, 'resources'), { recursive: true })
mkdirSync(join(root, 'build'), { recursive: true })

for (const size of [16, 32, 64, 256]) {
  const buf = render(size)
  writeFileSync(join(root, 'resources', `tray-${size}.png`), buf)
}
writeFileSync(join(root, 'resources', 'tray.png'), render(32))
writeFileSync(join(root, 'build', 'icon.png'), render(256))
console.log('icons written to resources/ and build/')
