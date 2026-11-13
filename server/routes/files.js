import fs from 'node:fs'
import path from 'node:path'
import { get, all, run, now, DATA_DIR } from '../lib/db.js'
import { readBody, sendJson, fail, send, clientIp } from '../lib/http.js'
import { requireUser, requirePerm } from '../lib/auth.js'
import { upload, localPath, storageConfig, DRIVERS } from '../lib/storage.js'
import { safeJson } from '../lib/forms.js'

/** multipart/form-data 解析（够用即可） */
export function parseMultipart(buf, boundary) {
  const parts = []
  const delimiter = Buffer.from(`--${boundary}`)
  let start = buf.indexOf(delimiter)
  while (start >= 0) {
    start += delimiter.length
    if (buf.slice(start, start + 2).toString() === '--') break
    if (buf.slice(start, start + 2).toString() === '\r\n') start += 2
    const end = buf.indexOf(delimiter, start)
    if (end < 0) break
    const raw = buf.slice(start, end - 2)
    const sep = raw.indexOf('\r\n\r\n')
    if (sep > 0) {
      const header = raw.slice(0, sep).toString('utf8')
      const content = raw.slice(sep + 4)
      const nameMatch = /name="([^"]*)"/.exec(header)
      const fileMatch = /filename="([^"]*)"/.exec(header)
      const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(header)
      parts.push({
        name: nameMatch?.[1] || '',
        filename: fileMatch?.[1] || null,
        contentType: typeMatch?.[1]?.trim() || '',
        data: content
      })
    }
    start = end
  }
  return parts
}

export default function register(r) {
  r.post('/api/upload', async (req, res) => {
    const user = requireUser(req)
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
      const parts = parseMultipart(buf, boundary[1] || boundary[2])
      const filePart = parts.find(p => p.filename)
      if (!filePart) fail(400, '未找到上传文件')
      name = filePart.filename
      data = filePart.data
      mime = filePart.contentType || mime
      const fid = parts.find(p => p.name === 'formId')
      if (fid) formId = Number(fid.data.toString()) || 0
      const sid = parts.find(p => p.name === 'submissionId')
      if (sid) submissionId = Number(sid.data.toString()) || 0
    } else {
      const url = new URL(req.url, 'http://x')
      name = url.searchParams.get('name') || 'file'
      mime = ct || mime
      formId = Number(url.searchParams.get('formId')) || 0
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
    const rows = all(`SELECT fl.* FROM files fl JOIN submissions s ON s.id = fl.submission_id
      WHERE s.form_id = ? AND s.deleted_at IS NULL AND fl.driver = 'local'`, Number(params.id))
    const entries = rows.map(f => ({ name: `${f.submission_id}/${f.name}`, data: fs.readFileSync(localPath(f.stored)) }))
    const zip = buildZip(entries)
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="attachments-${params.id}.zip"`,
      'Content-Length': zip.length
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

/** 备份/迁移：导出整个数据目录为 zip */
export function exportBackup() {
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
