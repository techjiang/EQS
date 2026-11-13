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
