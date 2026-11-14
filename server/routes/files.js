import fs from 'node:fs'
import path from 'node:path'
import { get, all, run, now, DATA_DIR, db } from '../lib/db.js'
import { readBody, sendJson, fail, send, clientIp } from '../lib/http.js'
import { requireUser, requirePerm, currentUser, can } from '../lib/auth.js'
import { upload, localPath, storageConfig, DRIVERS } from '../lib/storage.js'
import { safeJson, formWindow } from '../lib/forms.js'
import { buildZip, extractZip, writeZipStream } from '../lib/zip.js'
import { formRole, formVisibleScope, requireFormRole } from '../lib/formMembers.js'
import { checkUpload, dispositionFor, RAW_HEADERS, rateLimit, publicLimit } from '../lib/guard.js'
import { signFileUrl, verifyFileTicket } from '../lib/fileAccess.js'

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
      const form = get('SELECT id, status, settings FROM forms WHERE id = ? AND deleted_at IS NULL', formId)
      if (!form) fail(404, '表单不存在')
      if (form.status !== 'published') fail(403, '表单未发布，无法上传附件')
      // 表单要求登录才能填时，附件上传也必须拦住：否则匿名者仍能往这个表单灌文件，
      // 「仅登录可填」只剩答题那一步成立
      let fs2 = {}
      try { fs2 = JSON.parse(form.settings || '{}') } catch {}
      if (fs2.needLogin) fail(401, '该表单仅限登录用户填写，请先登录')
      // 定时发布的表单在开放时间窗之外不该收文件：否则「尚未开始」的卷子能先把附件传上来，
      // 而附件一旦落盘就占着磁盘，跟「这个问卷还没开放」是矛盾的
      const win = formWindow(fs2)
      if (!win.open) fail(403, win.notStarted ? '问卷尚未开始，暂不能上传附件' : '问卷已结束，不能上传附件')
    }
    const maxMb = 100
    if (data.length > maxMb * 1024 * 1024) fail(413, `文件超过 ${maxMb}MB`)
    /*
     * 上传频率：匿名上传是「不需要任何身份就能写磁盘」的唯一入口，
     * 不设闸的话，一个循环就能把 data/files 灌满，把整个站点的磁盘一起带走。
     * 按 IP 计，登录用户给得宽一些（批量导入附件是正常用法）。
     */
    const rl = rateLimit({ key: `upload:${clientIp(req)}`, limit: user ? publicLimit('upload') * 5 : publicLimit('upload'), windowMs: 60_000 })
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter))
      fail(429, `上传过于频繁，请 ${rl.retryAfter} 秒后再试`)
    }
    /*
     * 按真实内容判断类型。
     * 以前 name/mime 都是客户端说了算，`/api/upload` 收下一个 .html 就落在同源目录下，
     * 拿到 /api/files/raw/<key> 发给管理员——点开就在你的域里执行脚本。
     */
    const judged = checkUpload({ name, buf: data, mime })
    if (!judged.ok) fail(415, judged.reason)
    name = judged.name
    mime = judged.mime
    const stored = await upload({ name, buf: data, mime, formId, submissionId })
    const result = run('INSERT INTO files(name, stored, size, mime, form_id, submission_id, owner_id, driver, url, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      stored.name, stored.stored, stored.size, stored.mime, stored.formId, stored.submissionId, user?.id || 0, stored.driver, stored.url, now())
    sendJson(res, 201, {
      ok: true,
      id: Number(result.lastInsertRowid),
      name: stored.name,
      size: stored.size,
      /*
       * 回给上传者的地址带一张限期票据：匿名填表的人此刻还没有会话，
       * 不给票据的话，他连自己刚传的图片都预览不了（页面上一片裂图）。
       * 管理端拿到的是同一条带票据的地址，但页面刷新后重取时走的是会话那一路。
       */
      url: stored.driver === 'local' ? signFileUrl(`/api/files/raw/${stored.stored}`) : stored.url,
      driver: stored.driver
    })
  })

  /**
   * 读取本地文件（需鉴权）。
   *
   * 前几轮把「进来」这一头堵死了，这一头一直是敞开的：任何拿到 `/api/files/raw/<key>`
   * 的人都能下载，不需要登录、不需要任何凭据。key 里那 8 字节随机数确实猜不到，
   * 但「猜不到」不是「有权限」——链接被转发一次、进了一次浏览器同步，
   * 答卷附件里的身份证照片、薪资表就永久可读，且无法撤销。
   *
   * 现在两条准入路径，都得先有身份：
   *   1. 签名票据 `?e=&s=`：匿名填表的人刚传完文件、还没有会话，只能靠这个，
   *      限期、只对这一个 key 有效（见 lib/fileAccess.js）；
   *   2. 会话：管理员、文件归属者、该文件所属表单的协作者。
   *      管理端页面点附件走的就是这条，URL 里不带任何凭据。
   */
  r.get('/api/files/raw/*', async (req, res, { params }) => {
    const key = params['*']
    const file = localPath(key)
    if (!file) fail(404, '文件不存在')
    const stat = fs.statSync(file)
    const row = get('SELECT name, mime, form_id, owner_id FROM files WHERE stored = ?', key)
    const url = new URL(req.url, 'http://x')
    const signed = verifyFileTicket(key, url.searchParams.get('e'), url.searchParams.get('s'))
    if (!signed) {
      const me = currentUser(req)
      if (!me) fail(401, '请先登录后再下载该附件')
      let allowed = can(me, '*') || (row?.owner_id && Number(row.owner_id) === Number(me.id))
      if (!allowed && row?.form_id) {
        const form = get('SELECT * FROM forms WHERE id = ?', row.form_id)
        allowed = !!form && !!formRole(me, form)
      }
      if (!allowed) fail(403, '无权访问该附件')
    }
    /*
     * 出去这一层也要挡一次。
     * 库里的 mime 是上传那一刻记下来的，而存量文件可能早于这套校验（升级前传的 .html）。
     * 所以：非白名单类型一律转成下载，且所有响应都带 sandbox CSP——
     * 万一有人把这个同源地址当页面打开，它也没有脚本执行权、拿不到同源身份。
     */
    const mime = row?.mime || 'application/octet-stream'
    const name = row?.name || path.basename(file)
    /*
     * 缓存策略跟着鉴权一起改。
     * 以前是 `public, max-age=31536000`：任何人取一次，公司代理和 CDN 就替你长期存着，
     * 后来加上的那道鉴权对它一点约束都没有。
     * 但改成 `private, max-age=600` 也不对——实测这么写之后，
     * 管理员看过的一张图，在同一个浏览器里退出登录后仍然能打开（命中磁盘缓存，请求根本没发出去）。
     * 所以是 no-cache：允许存，但每次必须回来问一句，那问的这一下就会过鉴权。
     * ETag 让「问一句」的代价只有一次 304，不是重下一遍文件。
     */
    const etag = `W/"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`
    const headers = {
      'Content-Type': mime,
      'Content-Disposition': dispositionFor({ name, mime }),
      ETag: etag,
      'Cache-Control': 'private, no-cache',
      ...RAW_HEADERS
    }
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size })
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
    // 附件可见性跟表单一致：协作者也能看到自己那份问卷的附件
    const scope = formVisibleScope(me, 'forms')
    if (scope.sql !== '1 = 1') { where.push(`form_id IN (SELECT id FROM forms WHERE ${scope.sql})`); args.push(...scope.args) }
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
      const form = row.form_id ? get('SELECT * FROM forms WHERE id = ?', row.form_id) : null
      if (!form || formRole(me, form) !== 'owner') fail(403, '无权删除该文件')
    }
    if (row.driver === 'local') {
      const f = localPath(row.stored)
      if (f) fs.rmSync(f, { force: true })
    }
    run('DELETE FROM files WHERE id = ?', row.id)
    sendJson(res, 200, { ok: true })
  })

  /**
   * 打包下载某表单所有附件。
   *
   * 以前是「每个文件 readFileSync → 塞进 entries → buildZip 拼成一个 Buffer」：
   * 100 个 10MB 的附件就是 1GB 常驻内存，和导出 Excel 当年那个坑是同一个。
   * 现在文件按路径流式压进去，内存只跟单块有关。
   */
  r.get('/api/forms/:id/attachments.zip', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:read')
    const form = get('SELECT * FROM forms WHERE id = ?', Number(params.id))
    if (!form) fail(404, '表单不存在')
    requireFormRole(user, form, 'edit')
    const rows = all(`SELECT fl.* FROM files fl JOIN submissions s ON s.id = fl.submission_id
      WHERE s.form_id = ? AND s.deleted_at IS NULL AND fl.driver = 'local'`, Number(params.id))
    // 文件可能已经从磁盘上被删或在别处丢失，跳过后在响应头里报数——
    // 直接让整包 500 的话，用户看到的是「打包附件坏了」，而不是「其中 1 个文件丢了」
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
      entries.push({ name, file: local, compress: /^text\/|json|xml|csv/i.test(f.mime || '') })
    }
    const stamp = new Date()
    const pad2 = n => String(n).padStart(2, '0')
    const name = `attachments-${form.title || params.id}-${stamp.getFullYear()}${pad2(stamp.getMonth() + 1)}${pad2(stamp.getDate())}.zip`
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      // 中文表单名要按 RFC 5987 编码，否则浏览器下载下来是一串乱码文件名
      'Content-Disposition': `attachment; filename="attachments-${params.id}.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-EQS-Files': String(entries.length),
      'X-EQS-Missing': String(missing)
    })
    // 空包也得给一个合法的 zip：以前 entries 为空时 buildZip 仍然产出结构完整的空包
    await writeZipStream(entries, res)
    res.end()
  })
}

