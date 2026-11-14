import fs from 'node:fs'
import path from 'node:path'
import { get, all, run, now, DATA_DIR, db } from '../lib/db.js'
import { readBody, sendJson, fail, send, clientIp } from '../lib/http.js'
import { requireUser, requirePerm, currentUser, can } from '../lib/auth.js'
import { upload, localPath, storageConfig, DRIVERS } from '../lib/storage.js'
import { safeJson } from '../lib/forms.js'
import { buildZip, extractZip } from '../lib/zip.js'

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

/**
 * 读取上传的 xlsx（multipart 或裸二进制）。
 * 表格类导入都走这里：文件字段名不固定，多段里挑第一个有文件名的。
 */
export async function readXlsxUpload(req) {
  const ct = String(req.headers['content-type'] || '')
  const buf = await readBody(req)
  if (!ct.includes('multipart/form-data')) return buf
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct)
  if (!boundary) fail(400, '缺少 boundary')
  const parts = parseMultipart(buf, boundary[1] || boundary[2])
  const file = parts.find(p => p.filename)
  if (!file) fail(400, '未找到上传文件')
  return file.data
}

export { buildZip, extractZip }

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
    const result = run('INSERT INTO files(name, stored, size, mime, form_id, submission_id, owner_id, driver, url, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      stored.name, stored.stored, stored.size, stored.mime, stored.formId, stored.submissionId, user?.id || 0, stored.driver, stored.url, now())
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
    const me = requirePerm(req, 'data:read')
    const url = new URL(req.url, 'http://x')
    const where = []
    const args = []
    if (url.searchParams.get('formId')) { where.push('form_id = ?'); args.push(Number(url.searchParams.get('formId'))) }
    // 附件挂在表单上，可见性就该跟表单一致：之前任何带 data:read 的账号
    // 都能列出全站附件（含别人的表单 id、原始文件名、存储路径）。
    if (!can(me, '*')) { where.push('form_id IN (SELECT id FROM forms WHERE created_by = ?)'); args.push(me.id) }
    const rows = all(`SELECT * FROM files ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`, ...args)
    sendJson(res, 200, { ok: true, data: rows })
  })

  r.delete('/api/files/:id', async (req, res, { params }) => {
    const me = requirePerm(req, 'data:write')
    const row = get('SELECT * FROM files WHERE id = ?', Number(params.id))
    if (!row) fail(404, '文件不存在')
    // 删文件比删表单更狠：磁盘上的文件当场没了，回收中心接不住。
    // 之前只校验 data:write，换一个 id 就能删掉别人整个问卷的附件。
    if (!can(me, '*')) {
      const form = row.form_id ? get('SELECT created_by FROM forms WHERE id = ?', row.form_id) : null
      if (form?.created_by !== me.id) fail(403, '无权删除该文件')
    }
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
    const form = get('SELECT id, title, created_by FROM forms WHERE id = ?', Number(params.id))
    if (!form) fail(404, '表单不存在')
    if (!can(user, '*') && form.created_by !== user.id) fail(403, '无权导出该表单的附件')
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
