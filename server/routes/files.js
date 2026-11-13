import fs from 'node:fs'
import path from 'node:path'
import { get, all, run, now, DATA_DIR, db } from '../lib/db.js'
import { readBody, sendJson, fail, send, clientIp } from '../lib/http.js'
import { requireUser, requirePerm, currentUser } from '../lib/auth.js'
import { upload, localPath, storageConfig, DRIVERS } from '../lib/storage.js'
import { safeJson } from '../lib/forms.js'

/** multipart/form-data 解析（够用即可） */
/**
 * multipart/form-data 解析（够用即可）。
 * 分隔符必须带上 CRLF：RFC 2046 规定的分隔是 "\r\n--" + boundary。
 * 只找 "--" + boundary 的话，第一段前面那对换行会被算进段内，header 与正文整体错位——
 * 用户传了 5MB 问卷，服务端却在说「未找到上传文件」。
 */
export function parseMultipart(buf, boundary) {
  const parts = []
  const marker = Buffer.from(`--${boundary}`)
  const crlfMarker = Buffer.from(`\r\n--${boundary}`)
  // 第一段前面没有 CRLF，补一个虚拟前缀，之后所有分隔都按 CRLF-- 切
  const src = Buffer.concat([Buffer.from('\r\n'), buf])
  let at = src.indexOf(crlfMarker)
  while (at >= 0) {
    const bodyStart = at + crlfMarker.length
    // 结束标记 "--boundary--"
    if (src.slice(bodyStart, bodyStart + 2).toString() === '--') break
    const nextAt = src.indexOf(crlfMarker, bodyStart)
    if (nextAt < 0) break
    let seg = src.slice(bodyStart, nextAt)
    // 跳过分隔行尾部的 CRLF
    if (seg.slice(0, 2).toString() === '\r\n') seg = seg.slice(2)
    const sep = seg.indexOf('\r\n\r\n')
    if (sep > 0) {
      const header = seg.slice(0, sep).toString('utf8')
      const content = seg.slice(sep + 4)
      const nameMatch = /name="([^"]*)"/.exec(header)
      const fileMatch = /filename="([^"]*)"/.exec(header)
      const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(header)
      parts.push({
        name: nameMatch?.[1] || '',
        filename: fileMatch?.[1] ?? null,
        contentType: typeMatch?.[1]?.trim() || '',
        data: content
      })
    }
    at = nextAt
  }
  void marker
  return parts
}

export default function register(r) {
  r.post('/api/upload', async (req, res) => {
    const ct = String(req.headers['content-type'] || '')
    const buf = await readBody(req)
    let name = 'file'
    let data = buf
    let mime = 'application/octet-stream'
    let formId = 0
    let submissionId = 0
    if (ct.includes('multipart/form-data')) {
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct)
      if (!boundary) fail(400, '缺少 boundary')
      // 找回边界：用户交了 5MB 问卷，之前却在说「未找到上传文件」——
      // 因为解析器只认 `\r\n--boundary`，浏览器写的分隔符前面带 CRLF，第一段被整段吃掉
      const parts = parseMultipart(buf, boundary[1] || boundary[2])
      const filePart = parts.find(p => p.filename)
      if (!filePart) fail(400, '未找到上传文件')
      name = filePart.filename
      data = filePart.data
      mime = filePart.contentType || mime
      // 字段顺序不固定，filename 出现在 formId 之前是常态，边界统一遍历
      const fieldOf = n => { const x = parts.find(p => p.name === n); return x ? Number(x.data.toString()) || 0 : 0 }
      formId = fieldOf('formId') || formId
      submissionId = fieldOf('submissionId') || submissionId
    } else {
      const url = new URL(req.url, 'http://x')
      name = url.searchParams.get('name') || 'file'
      mime = ct || mime
      formId = Number(url.searchParams.get('formId')) || 0
    }
    // 登录用户随意传；匿名只允许「已发布表单」的答卷附件，避免变成公共图床
    const user = currentUser(req)
    if (!user) {
      if (!formId) fail(401, '请先登录')
      const form = get('SELECT id, status FROM forms WHERE id = ? AND deleted_at IS NULL', formId)
      if (!form) fail(404, '表单不存在')
      if (form.status !== 'published') fail(403, '表单未发布，无法上传附件')
    }
    const maxMb = 100
    if (data.length > maxMb * 1024 * 1024) fail(413, `文件超过 ${maxMb}MB`)
    const stored = await upload({ name, buf: data, mime, formId, submissionId })
    const result = run('INSERT INTO files(name, stored, size, mime, form_id, submission_id, driver, url, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      stored.name, stored.stored, stored.size, stored.mime, stored.formId, stored.submissionId, stored.driver, stored.url, now())
    sendJson(res, 201, {
      ok: true,
      id: Number(result.lastInsertRowid),
      name: stored.name,
      size: stored.size,
      url: stored.driver === 'local' ? `/api/files/raw/${stored.stored}` : stored.url,
      driver: stored.driver
    })
  })

  /** 公开读取本地文件 */
  r.get('/api/files/raw/*', async (req, res, { params }) => {
    const key = params['*']
    const file = localPath(key)
    if (!file) fail(404, '文件不存在')
    const stat = fs.statSync(file)
    res.writeHead(200, {
      'Content-Type': get('SELECT mime FROM files WHERE stored = ?', key)?.mime || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
      'Cache-Control': 'public, max-age=31536000'
    })
    fs.createReadStream(file).pipe(res)
  })

  r.get('/api/files', async (req, res) => {
    requirePerm(req, 'data:read')
    const url = new URL(req.url, 'http://x')
    const where = []
    const args = []
    if (url.searchParams.get('formId')) { where.push('form_id = ?'); args.push(Number(url.searchParams.get('formId'))) }
    const rows = all(`SELECT * FROM files ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`, ...args)
    sendJson(res, 200, { ok: true, data: rows })
  })

  r.delete('/api/files/:id', async (req, res, { params }) => {
    requirePerm(req, 'data:write')
    const row = get('SELECT * FROM files WHERE id = ?', Number(params.id))
    if (!row) fail(404, '文件不存在')
    if (row.driver === 'local') {
      const f = localPath(row.stored)
      if (f) fs.rmSync(f, { force: true })
    }
    run('DELETE FROM files WHERE id = ?', row.id)
    sendJson(res, 200, { ok: true })
  })

  /** 打包下载某表单所有附件（zip，store 模式无需依赖） */
  r.get('/api/forms/:id/attachments.zip', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:read')
    const form = get('SELECT id, title FROM forms WHERE id = ?', Number(params.id)) || { id: params.id, title: '' }
    const rows = all(`SELECT fl.* FROM files fl JOIN submissions s ON s.id = fl.submission_id
      WHERE s.form_id = ? AND s.deleted_at IS NULL AND fl.driver = 'local'`, Number(params.id))
    // 文件可能已经从磁盘上被删或在别处丢失，一个 readFileSync 抛异常就会让整包下载 500——
    // 用户看到的是「打包附件坏了」，而不是「其中 1 个文件丢了」。这里跳过并在响应头里报数。
    const entries = []
    let missing = 0
    for (const f of rows) {
      const local = localPath(f.stored)
      if (!local) { missing++; continue }
      // 同一份答卷里同名文件很常见（截图.png），直接拼会互相覆盖
      const baseName = `${f.submission_id}/${f.name}`
      let name = baseName
      let n = 1
      while (entries.some(e => e.name === name)) {
        const dot = baseName.lastIndexOf('.')
        name = dot > 0 ? `${baseName.slice(0, dot)}(${n})${baseName.slice(dot)}` : `${baseName}(${n})`
        n++
      }
      entries.push({ name, data: fs.readFileSync(local) })
    }
    const zip = buildZip(entries)
    const stamp = new Date()
    const pad = n => String(n).padStart(2, '0')
    const name = `attachments-${form.title || params.id}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}.zip`
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      // 中文表单名要按 RFC 5987 编码，否则浏览器下载下来是一串乱码文件名
      'Content-Disposition': `attachment; filename="attachments-${params.id}.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Content-Length': zip.length,
      'X-EQS-Files': String(entries.length),
      'X-EQS-Missing': String(missing)
    })
    res.end(zip)
  })
}

/** 极简 ZIP 打包（deflate store），单文件上限内可用 */
export function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  const crcTable = (() => {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[i] = c >>> 0
    }
    return t
  })()
  const crc32 = buf => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
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

/** 极简 zip 解包（仅 store 模式，配合自带备份包） */
export function extractZip(buf, destDir) {
  let off = 0
  const base = path.resolve(destDir)
  while (off < buf.length - 4) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break
    const method = buf.readUInt16LE(off + 8)
    const flags = buf.readUInt16LE(off + 6)
    const size = buf.readUInt32LE(off + 18)
    const nameLen = buf.readUInt16LE(off + 26)
    const extraLen = buf.readUInt16LE(off + 28)
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8')
    const start = off + 30 + nameLen + extraLen
    const data = buf.slice(start, start + size)
    const target = path.resolve(base, name)
    if (target.startsWith(base) && method === 0) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      // ZIP 的 general purpose bit 3：大小写在数据之后的描述符里，这里 local header 的长度是 0，
      // 直接按 0 长度写会把文件内容吞掉。备份包由我们自己生成（不置该位），遇到外部包直接拒绝并说明。
      if (flags & 0x0008) return { ok: false, reason: '备份包使用了流式压缩格式，请用 EQS 导出的备份文件' }
      fs.writeFileSync(target, data)
    }
    off = start + size
  }
  return { ok: true }
}

/**
 * 备份/迁移：导出整个数据目录为 zip
 * WAL 模式下新数据先落在 eqs.db-wal，eqs.db 主文件可能还是空的。
 * 不先 checkpoint 就打包，得到的 eqs.db 是个没有表的空壳——「备份成功，恢复全空」。
 */
export function exportBackup() {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch (e) {
    console.error('[EQS] 备份前 checkpoint 失败', e.message)
  }
  const entries = []
  const walk = (dir, prefix = '') => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      const st = fs.statSync(full)
      if (st.isDirectory()) walk(full, rel)
      else if (!name.endsWith('-wal') && !name.endsWith('-shm')) entries.push({ name: `eqs-data/${rel}`, data: fs.readFileSync(full) })
    }
  }
  walk(DATA_DIR)
  return buildZip(entries)
}
