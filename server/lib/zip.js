import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

/* ZIP 读写：只做 EQS 自己需要的那一小块。
 * 打包用 store（不压缩，浏览器/Excel/系统都能解），解包同时支持 store 与 deflate——
 * Excel 导出的 xlsx 一律是 deflate，只认 store 的话「导入 Excel」必然失败。 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 极简 ZIP 打包（store 模式），entries: [{name, data}] */
export function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data))
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, centralBuf, end])
}

/** 读中央目录：拿到每个条目的名字与内容（store / deflate 都支持） */
export function readZipEntries(buf) {
  // 从尾部找 EOCD（注释最长 65535）
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) return null
    const method = buf.readUInt16LE(at + 10)
    const compSize = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const localAt = buf.readUInt32LE(at + 42)
    const name = buf.slice(at + 46, at + 46 + nameLen).toString('utf8')
    at += 46 + nameLen + extraLen + commentLen
    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== 0x04034b50) continue
    const lNameLen = buf.readUInt16LE(localAt + 26)
    const lExtraLen = buf.readUInt16LE(localAt + 28)
    const start = localAt + 30 + lNameLen + lExtraLen
    const raw = buf.slice(start, start + compSize)
    let data
    try {
      data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null
    } catch { data = null }
    if (data) out.push({ name, data })
  }
  return out
}

/**
 * 解包到目录。
 * 只解我们自己生成的备份包（store）；外部的压缩包直接说明原因，不用半成品去顶替数据库。
 */
export function extractZip(buf, destDir) {
  const entries = readZipEntries(buf)
  if (!entries) return { ok: false, reason: '无法读取压缩包目录，请用 EQS 导出的备份文件' }
  const base = path.resolve(destDir)
  for (const e of entries) {
    const target = path.resolve(base, e.name)
    // 路径穿越（../）一律跳过：备份包来自用户上传，不该有写库目录之外的权力
    if (!target.startsWith(base)) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, e.data)
  }
  return { ok: true }
}

/* ---------------- 流式打包 ----------------
 *
 * 上面的 buildZip 把所有条目在内存里拼成一个 Buffer。对「几百个附件」够用，
 * 对「几十万行答卷导出 Excel」就是致命问题：工作表 XML 会先变成一整条几 GB 的字符串，
 * 再和它自己的压缩副本同时待在内存里。实测 93 万份答卷导出，直接抛
 * `RangeError: Invalid string length`——V8 单个字符串最多 512MB，连机会都不给。
 *
 * 所以另开一条流式路径：内容来源可以是文件（边读边压边发），
 * 只有真正的元数据留在内存里。CRC 与大小在发送过程中累加，
 * 按 ZIP 规范用「数据描述符」（bit 3）在内容之后补写。
 */
const crc32Update = (c, buf) => {
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c >>> 0
}

function zipLocalHeader(nameBuf, method) {
  const h = Buffer.alloc(30)
  h.writeUInt32LE(0x04034b50, 0)
  h.writeUInt16LE(20, 4)
  // bit 3（数据描述符）+ bit 11（UTF-8 文件名）：大小与 CRC 要等写完才知道
  h.writeUInt16LE(0x0808, 6)
  h.writeUInt16LE(method, 8)
  h.writeUInt16LE(0, 10)
  h.writeUInt32LE(0, 12)
  h.writeUInt32LE(0, 16)
  h.writeUInt32LE(0, 20)
  h.writeUInt16LE(nameBuf.length, 26)
  h.writeUInt16LE(0, 28)
  return h
}

/**
 * 流式写 ZIP 到 out（一个 Writable / ServerResponse）。
 * entries: [{ name, data?: Buffer|string, file?: 路径, compress?: boolean }]
 *
 * 慢客户端会把 write() 变成 false 并积压内存，所以每一块都等 drain。
 * 「导出大到把服务器搞挂」和「导出慢一点」之间，只能选后者。
 */
export async function writeZipStream(entries, out) {
  const { pipeline } = await import('node:stream/promises')
  const { Transform, Readable, Writable } = await import('node:stream')
  const fsmod = await import('node:fs')
  const zlib = await import('node:zlib')

  let offset = 0
  const send = async (buf) => {
    offset += buf.length
    if (!out.write(buf)) await new Promise(resolve => out.once('drain', resolve))
  }

  const central = []
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const compress = e.compress !== false
    const method = compress ? 8 : 0
    const startOffset = offset
    await send(zipLocalHeader(nameBuf, method))
    await send(nameBuf)

    let crc = 0xffffffff
    let uncomp = 0
    let comp = 0
    const meter = new Transform({
      transform(chunk, _enc, cb) { crc = crc32Update(crc, chunk); uncomp += chunk.length; cb(null, chunk) }
    })
    const collector = new Writable({
      write(chunk, _enc, cb) {
        comp += chunk.length
        offset += chunk.length
        if (out.write(chunk)) return cb()
        out.once('drain', cb)
      }
    })
    // data 可以是 Buffer / 字符串，也可以是异步迭代器（几十万行的表格就靠这个边生成边压）
    const isAsync = e.data && typeof e.data[Symbol.asyncIterator] === 'function'
    const src = e.file
      ? fsmod.createReadStream(e.file)
      : isAsync
        ? Readable.from(e.data)
        : Readable.from([Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''))])
    await pipeline(src, meter, ...(compress ? [zlib.default.createDeflateRaw()] : []), collector)

    const finalCrc = (crc ^ 0xffffffff) >>> 0
    const desc = Buffer.alloc(16)
    desc.writeUInt32LE(0x08074b50, 0)
    desc.writeUInt32LE(finalCrc, 4)
    desc.writeUInt32LE(comp, 8)
    desc.writeUInt32LE(uncomp, 12)
    await send(desc)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0808, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(0, 12)
    cd.writeUInt32LE(finalCrc, 16)
    cd.writeUInt32LE(comp, 20)
    cd.writeUInt32LE(uncomp, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(startOffset, 42)
    central.push(cd, nameBuf)
  }

  const centralStart = offset
  const centralBuf = Buffer.concat(central)
  await send(centralBuf)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(centralStart, 16)
  await send(end)
  return { entries: entries.length, bytes: offset }
}

/* ---------------- 随机访问式解包 ----------------
 *
 * 上面的 readZipEntries 要求整个 zip 在内存里。备份包动辄几百 MB 甚至几 GB，
 * 而现在导入接口又必须先把包收下来才能校验——「文件多大就得吃多大内存」这条路走不通。
 *
 * 所以另开一条：先把 zip 落到磁盘，再从尾部读中央目录拿到各条目的偏移与压缩后大小，
 * 需要哪个条目就按偏移 range 读哪一段。内存只跟单块大小有关。
 */
export function openZipFile(filePath) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size < 22) return null
    const tailLen = Math.min(size, 22 + 0xffff)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(fd, tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    }
    if (eocd < 0) return null
    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (cdOffset + cdSize > size) return null
    const cd = Buffer.alloc(cdSize)
    fs.readSync(fd, cd, 0, cdSize, cdOffset)
    const entries = []
    let at = 0
    for (let i = 0; i < count; i++) {
      if (at + 46 > cd.length || cd.readUInt32LE(at) !== 0x02014b50) break
      const method = cd.readUInt16LE(at + 10)
      const crc = cd.readUInt32LE(at + 16)
      const compSize = cd.readUInt32LE(at + 20)
      const uncompSize = cd.readUInt32LE(at + 24)
      const nameLen = cd.readUInt16LE(at + 28)
      const extraLen = cd.readUInt16LE(at + 30)
      const commentLen = cd.readUInt16LE(at + 32)
      const localOffset = cd.readUInt32LE(at + 42)
      const name = cd.slice(at + 46, at + 46 + nameLen).toString('utf8')
      at += 46 + nameLen + extraLen + commentLen
      // zip64 的字段是 0xffffffff 占位，靠 extra 里的真实值；EQS 自己产不出这么大的单条目，直接跳过
      if (compSize === 0xffffffff || localOffset === 0xffffffff) continue
      entries.push({ name, method, crc, compSize, uncompSize, localOffset })
    }
    return { filePath, size, entries }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 把 zip 里的单个条目解到指定文件。
 * 压缩后大小取自中央目录——用流式写出的包在本地头里是 0（bit 3），只能信中央目录。
 */
export async function extractZipEntryToFile(zip, entry, destPath) {
  const { pipeline } = await import('node:stream/promises')
  const { Transform } = await import('node:stream')
  const zlibmod = await import('node:zlib')
  const fd = fs.openSync(zip.filePath, 'r')
  let start = 0
  try {
    const lh = Buffer.alloc(30)
    fs.readSync(fd, lh, 0, 30, entry.localOffset)
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`ZIP 条目损坏：${entry.name}`)
    start = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
  } finally {
    fs.closeSync(fd)
  }
  if (start + entry.compSize > zip.size) throw new Error(`ZIP 条目越界：${entry.name}`)
  let crc = 0xffffffff
  let written = 0
  const meter = new Transform({
    transform(chunk, _enc, cb) { crc = crc32Update(crc, chunk); written += chunk.length; cb(null, chunk) }
  })
  const src = fs.createReadStream(zip.filePath, { start, end: start + entry.compSize - 1 })
  await pipeline(src, ...(entry.method === 8 ? [zlibmod.createInflateRaw()] : []), meter, fs.createWriteStream(destPath))
  if (entry.uncompSize && written !== entry.uncompSize) throw new Error(`ZIP 条目长度不符：${entry.name}`)
  if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error(`ZIP 条目校验失败：${entry.name}`)
  return { bytes: written }
}
