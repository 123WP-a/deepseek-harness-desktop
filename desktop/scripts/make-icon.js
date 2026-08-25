// Generates desktop/assets/deepseek.ico from the official DeepSeek Harness
// favicon.svg (the black whale logo), rendered with sharp (librsvg).
//
// Produces a multi-size ICO (16..256 px) with PNG-compressed entries, which
// Windows Vista+ renders natively.

const sharp = require('sharp')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, '..', 'apps', 'web', 'public', 'favicon.svg')
const OUT_DIR = path.join(ROOT, 'assets')
const OUT_ICO = path.join(OUT_DIR, 'deepseek.ico')

const SIZES = [16, 24, 32, 48, 64, 128, 256]

function icoFromPngs(entries) {
  // ICO header: reserved(2) + type(2) + count(2)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  // Directory entries: 16 bytes each
  const dirSize = entries.length * 16
  const bodyStart = 6 + dirSize
  const dir = Buffer.alloc(dirSize)
  const images = []
  let offset = bodyStart
  entries.forEach(({ size, png }, index) => {
    const e = dir.subarray(index * 16, index * 16 + 16)
    // Icon directory entry: width/height (0 means 256), colors, planes, bpp, size, offset
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2) // color count
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // color planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    images.push(png)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...images])
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const entries = []
  for (const size of SIZES) {
    const png = await sharp(SRC, { density: 300 })
      .resize(size, size)
      .png()
      .toBuffer()
    entries.push({ size, png })
  }
  fs.writeFileSync(OUT_ICO, icoFromPngs(entries))
  console.log(`Wrote ${OUT_ICO} (${entries.map(e => e.size).join(', ')} px)`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
