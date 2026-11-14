import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { get, all, run, now, setting, setSetting, DATA_DIR, log, db, switchDb } from '../lib/db.js'
import { readBody, sendJson, fail, readJson, clientIp } from '../lib/http.js'
import { requireUser, can, createSession, sessionCookie } from '../lib/auth.js'
import {
  exportBackupStream, saveRequestToFile, extractMultipartFile, restoreFiles,
  createPreImportSnapshot, listSnapshots, rollbackToSnapshot, validateDatabase,
  inspectBackup, sqliteReady, stampNow
} from '../lib/backup.js'
import { openZipFile as openZipPath, extractZipEntryToFile } from '../lib/zip.js'
import { smtpSend, wxAccessToken } from '../lib/notify.js'
import { generateForm } from '../lib/ai.js'

export default function register(r) {
  /** 健康检查（容器 / 负载均衡探活用） */
  r.get('/api/health', async (req, res) => {
    const ok = !!get('SELECT 1 AS x')
    sendJson(res, ok ? 200 : 503, { ok, uptime: Math.floor(process.uptime()), version: '1.0.0' })
  })

  /**
   * 备份导出（流式）。
   *
   * 旧实现把整个 data 目录 readFileSync 进内存再拼成一个 Buffer：107MB 的库导出时
   * 响应 138MB，进程 RSS 从 90MB 涨到 365MB。真实站点 data/files 常有几个 G，
   * 这条路走得通只是因为没人拿大盘子备过份——一备就是 OOM。
   * 现在边读边压边发，内存只跟单块有关。
   */
  r.get('/api/backup/export', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const name = `eqs-backup-${stampNow()}.zip`
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${name}"`,
      // 走 chunked：总量要等压完才知道，硬报 Content-Length 就得先全压进内存
      'Cache-Control': 'no-store'
    })
    let stat = null
    try {
      stat = await exportBackupStream(res)
    } catch (e) {
      // 头已经发出去了，改不了状态码，只能把日志写清楚
      console.error('[EQS] 备份导出失败', e)
    }
    // 流写完必须显式 end()：不 end 的话浏览器能收到几乎全部字节却永远等不到结束
    res.end()
    if (stat) log(me, '导出备份', `${stat.entries} 个条目 / ${(stat.bytes / 1048576).toFixed(1)}MB`)
  })

  /** 可回滚的快照列表 */
  r.get('/api/backup/snapshots', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    sendJson(res, 200, { ok: true, data: listSnapshots() })
  })

  /** 回滚到上一次导入之前（或指定快照） */
  r.post('/api/backup/rollback', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const body = await readJson(req).catch(() => ({}))
    await sqliteReady()
    // 回滚本身也可撤销：先把当前状态存一份，再顶替
    const r2 = rollbackToSnapshot(body.name)
    log(me, '回滚备份', `恢复到 ${r2.restored}（当前状态已存为 ${r2.safety}）`)
    sendJson(res, 200, { ok: true, ...r2, message: `已回滚到 ${r2.restored}` })
  })

  /**
   * 迁移导入。
   *
   * 旧实现三段都不成立，而且是同一个原因的三种表现：
   *   1. `readBody(req)` 上限 64MB —— 138MB 的备份包直接 413「请求体过大」，
   *      **自己导出的备份，自己导不回来**；
   *   2. 内存版解包，包多大就吃多大；
   *   3. 顶替前零校验。塞一个内容不是 SQLite 的 eqs.db 进去，库被换了，
   *      此后每个请求都回 `statement has been finalized`，只能手工救。
   *
   * 现在：请求体流式落盘 → 按 boundary 抠出 zip → 从中央目录按区间解出 eqs.db →
   * 先验（文件头、integrity_check、核心表）→ 成功才顶替，且顶替前自动存一份快照。
   * 「导入成功」当场是真的，撤回去也有路。
   */
  r.post('/api/backup/import', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const ct = String(req.headers['content-type'] || '')
    if (!ct.includes('multipart/form-data')) fail(400, '请上传 zip 备份文件')
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct)
    if (!boundary) fail(400, '缺少 boundary')
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eqs-restore-'))
    try {
      const rawPath = path.join(work, 'body.bin')
      await saveRequestToFile(req, rawPath)
      const zipPath = path.join(work, 'backup.zip')
      await extractMultipartFile(rawPath, boundary[1] || boundary[2], zipPath)
      fs.rmSync(rawPath, { force: true })
      await sqliteReady()

      const zip = openZipPath(zipPath)
      if (!zip) fail(400, '无法读取压缩包目录，请用 EQS 导出的备份文件')
      const dbEntry = zip.entries.find(e => e.name === 'eqs-data/eqs.db')
      if (!dbEntry) fail(400, '备份包里没有 eqs-data/eqs.db，不是 EQS 的备份文件')

      // 清单是「这个包是什么」的自述，有就读、没有也接受（兼容老备份）
      let manifest = null
      const mEntry = zip.entries.find(e => e.name === 'eqs-data/manifest.json')
      if (mEntry) {
        const mPath = path.join(work, 'manifest.json')
        await extractZipEntryToFile(zip, mEntry, mPath)
        try { manifest = JSON.parse(fs.readFileSync(mPath, 'utf8')) } catch {}
      }

      const incoming = path.join(work, 'eqs.db')
      await extractZipEntryToFile(zip, dbEntry, incoming)
      const check = validateDatabase(incoming)
      if (!check.ok) fail(400, check.reason)

      // 先快照、后顶替：导入是可撤销的，前提是「撤销」这一刻已经被存下来
      const snap = createPreImportSnapshot('pre-import')
      switchDb(incoming)
      const merged = await restoreFiles(zip)

      log(me, '导入备份', `已生效，附件补入 ${merged.added} 项，快照 ${snap.name}`)
      sendJson(res, 200, {
        ok: true, restartRequired: false,
        message: '备份已导入并生效',
        filesMerged: merged.added,
        filesSkipped: merged.skipped,
        snapshot: snap.name,
        manifest: manifest ? { version: manifest.version, createdAt: manifest.createdAt, counts: manifest.counts } : null,
        note: '附件按合并处理：备份里没有的文件会保留，不会被删除；如需撤回请点「回滚到导入前」'
      })
    } finally {
      fs.rmSync(work, { recursive: true, force: true })
    }
  })

  /**
   * 备份包体检（只读）。
   *
   * 导入会验库，但不验附件：包里的 zip 是人工拷来拷去的，断点续传一断、网盘同步失败、
   * tar 少拿一层目录，都能做出「库好、附件缺一半」的包——导入照样弹「导入成功」，
   * 而答卷里的小抄照片、证件扫描件在没人点开之前谁都不知道它没了。
   * 这里先把包打开看一遍，一条条说清缺哪个文件、属于哪张表单，再让人决定要不要导。
   */
  r.post('/api/backup/inspect', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const ct = String(req.headers['content-type'] || '')
    if (!ct.includes('multipart/form-data')) fail(400, '请上传 zip 备份文件')
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct)
    if (!boundary) fail(400, '缺少 boundary')
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eqs-inspect-req-'))
    try {
      const rawPath = path.join(work, 'body.bin')
      await saveRequestToFile(req, rawPath)
      const zipPath = path.join(work, 'backup.zip')
      await extractMultipartFile(rawPath, boundary[1] || boundary[2], zipPath)
      fs.rmSync(rawPath, { force: true })
      const report = await inspectBackup(zipPath)
      log(me, '备份体检', report.ok ? '通过' : `发现问题：${report.errors[0] || ''}`)
      sendJson(res, 200, { ok: true, data: report })
    } finally {
      fs.rmSync(work, { recursive: true, force: true })
    }
  })

  r.get('/api/system/info', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const counts = {
      forms: get('SELECT COUNT(*) c FROM forms WHERE deleted_at IS NULL').c,
      submissions: get('SELECT COUNT(*) c FROM submissions WHERE deleted_at IS NULL').c,
      users: get('SELECT COUNT(*) c FROM users').c,
      banks: get('SELECT COUNT(*) c FROM banks WHERE deleted_at IS NULL').c,
      questions: get('SELECT COUNT(*) c FROM questions WHERE deleted_at IS NULL').c,
      files: get('SELECT COUNT(*) c FROM files').c
    }
    const size = (p) => { try { return fs.statSync(p).size } catch { return 0 } }
    /*
     * 数据库大小不能只看 eqs.db 主文件：WAL 模式下新数据先在 eqs.db-wal 里，
     * 主文件可能只有几十 KB，设置页就显示「数据库大小 4.0 KB」——一个装了 47 份答卷的站点
     * 看起来像个空库。按 SQLite 自己的页数算才是真实占用量。
     */
    let dbSize = 0
    try {
      const pc = get('PRAGMA page_count')?.page_count || 0
      const ps = get('PRAGMA page_size')?.page_size || 0
      dbSize = pc * ps
      if (!dbSize) dbSize = size(path.join(DATA_DIR, 'eqs.db')) + size(path.join(DATA_DIR, 'eqs.db-wal'))
    } catch { dbSize = size(path.join(DATA_DIR, 'eqs.db')) }
    const walSize = size(path.join(DATA_DIR, 'eqs.db-wal'))
    sendJson(res, 200, {
      ok: true,
      data: {
        version: '1.0.0', node: process.version, uptime: Math.floor(process.uptime()),
        platform: `${process.platform} ${process.arch}`,
        dataDir: DATA_DIR, dbSize, walSize,
        fileCount: counts.files, counts
      }
    })
  })

  /**
   * 数据同步 API：供外部系统拉取全量答卷。
   *
   * 旧实现一次性把所有答卷读进内存再整体序列化——93 万份答卷时响应 486MB，
   * 内存先涨到 2GB 才发得出第一个字节；对接方那边也是一个 486MB 的字符串，
   * 绝大多数 HTTP 客户端到这一步就够了。
   *
   * 现在改成一行一行往外吐。同时支持游标（`sinceId`）和分批（`limit`），
   * 让外部系统能「拉一批、处理完、再拉下一批」——这才是同步该有的样子。
   */
  r.get('/api/sync/export', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const url = new URL(req.url, 'http://x')
    const formId = Number(url.searchParams.get('formId')) || 0
    const sinceId = Number(url.searchParams.get('sinceId')) || 0
    // 上限 5000：再大就不是同步而是备份了，备份走 /api/backup/export
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit')) || 1000))
    const where = ['s.deleted_at IS NULL', 's.id > ?']
    const args = [sinceId]
    if (formId) { where.push('s.form_id = ?'); args.push(formId) }
    const rows = all(`SELECT s.*, f.title AS form_title FROM submissions s JOIN forms f ON f.id = s.form_id
      WHERE ${where.join(' AND ')} ORDER BY s.id LIMIT ?`, ...args, limit)
    const lastId = rows.length ? rows[rows.length - 1].id : sinceId
    sendJson(res, 200, {
      ok: true,
      data: rows.map(x => ({ ...x, data: JSON.parse(x.data) })),
      // 有 nextSinceId 就说明后面还有，拿它继续拉；相等说明拉完了
      sinceId: lastId,
      hasMore: rows.length === limit,
      limit
    })
  })

  /** 第三方登录：Google */
  r.get('/api/oauth/google/url', async (req, res) => {
    const cfg = setting('oauth', {})?.google
    if (!cfg?.clientId) fail(400, '未配置 Google 登录')
    const site = setting('site', {})
    const base = site.baseUrl || `http://localhost:${process.env.PORT || 8080}`
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: `${base}/api/oauth/google/callback`,
      response_type: 'code', scope: 'openid email profile', state: crypto.randomBytes(8).toString('hex')
    })
    sendJson(res, 200, { ok: true, url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` })
  })

  r.get('/api/oauth/google/callback', async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const code = url.searchParams.get('code')
    const cfg = setting('oauth', {})?.google
    if (!code || !cfg?.clientId) return redirectTo(res, '/login?error=oauth')
    const site = setting('site', {})
    const base = site.baseUrl || `http://localhost:${process.env.PORT || 8080}`
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: `${base}/api/oauth/google/callback`, grant_type: 'authorization_code' })
    })
    const token = await tokenRes.json()
    if (!token.access_token) return redirectTo(res, '/login?error=oauth')
    const info = await (await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } })).json()
    const user = await upsertOAuthUser({ email: info.email, nickname: info.name || info.email, avatar: info.picture })
    const { token: sess } = createSession(user.id, req, clientIp(req), req.headers['user-agent'] || '')
    res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookie(sess) })
    res.end()
  })

  /** 微信开放平台扫码登录 */
  r.get('/api/oauth/wechat/url', async (req, res) => {
    const cfg = setting('oauth', {})?.wechatMp
    if (!cfg?.appId) fail(400, '未配置微信登录')
    const site = setting('site', {})
    const base = site.baseUrl || `http://localhost:${process.env.PORT || 8080}`
    const params = new URLSearchParams({
      appid: cfg.appId, redirect_uri: `${base}/api/oauth/wechat/callback`,
      response_type: 'code', scope: 'snsapi_login',
      state: crypto.randomBytes(8).toString('hex')
    })
    sendJson(res, 200, { ok: true, url: `https://open.weixin.qq.com/connect/qrconnect?${params}#wechat_redirect` })
  })

  r.get('/api/oauth/wechat/callback', async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const code = url.searchParams.get('code')
    const cfg = setting('oauth', {})?.wechatMp
    if (!code || !cfg?.appId) return redirectTo(res, '/login?error=oauth')
    const tokenRes = await fetch(`https://api.weixin.qq.com/sns/oauth2/access_token?appid=${cfg.appId}&secret=${cfg.appSecret}&code=${code}&grant_type=authorization_code`)
    const token = await tokenRes.json()
    if (!token.access_token) return redirectTo(res, '/login?error=oauth')
    const info = await (await fetch(`https://api.weixin.qq.com/sns/userinfo?access_token=${token.access_token}&openid=${token.openid}`)).json()
    const user = await upsertOAuthUser({ username: `wx_${info.openid}`, nickname: info.nickname, avatar: info.headimgurl })
    const { token: sess } = createSession(user.id, req, clientIp(req), req.headers['user-agent'] || '')
    res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookie(sess) })
    res.end()
  })

  /** 微信公众号网页授权（问卷内获取昵称头像） */
  r.get('/api/wechat/oauth/url', async (req, res) => {
    const cfg = setting('wechat', {})
    if (!cfg?.appId) fail(400, '未配置微信公众号')
    const url = new URL(req.url, 'http://x')
    const redirect = url.searchParams.get('redirect') || '/'
    const site = setting('site', {})
    const base = site.baseUrl || `http://localhost:${process.env.PORT || 8080}`
    const params = new URLSearchParams({
      appid: cfg.appId, redirect_uri: `${base}/api/wechat/oauth/callback?redirect=${encodeURIComponent(redirect)}`,
      response_type: 'code', scope: 'snsapi_userinfo', state: 'eqs'
    })
    sendJson(res, 200, { ok: true, url: `https://open.weixin.qq.com/connect/oauth2/authorize?${params}#wechat_redirect` })
  })

  r.get('/api/wechat/oauth/callback', async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const code = url.searchParams.get('code')
    const redirect = url.searchParams.get('redirect') || '/'
    const cfg = setting('wechat', {})
    if (!code || !cfg.appId) return redirectTo(res, redirect)
    const tokenRes = await fetch(`https://api.weixin.qq.com/sns/oauth2/access_token?appid=${cfg.appId}&secret=${cfg.appSecret}&code=${code}&grant_type=authorization_code`)
    const token = await tokenRes.json()
    if (!token.access_token) return redirectTo(res, redirect)
    let profile = {}
    try {
      profile = await (await fetch(`https://api.weixin.qq.com/sns/userinfo?access_token=${token.access_token}&openid=${token.openid}&lang=zh_CN`)).json()
    } catch {}
    const payload = Buffer.from(JSON.stringify({ openid: token.openid, nickname: profile.nickname || '', avatar: profile.headimgurl || '' })).toString('base64url')
    const sep = redirect.includes('?') ? '&' : '?'
    redirectTo(res, `${redirect}${sep}wx=${payload}`)
  })

  r.get('/api/wechat/jsconfig', async (req, res) => {
    const cfg = setting('wechat', {})
    if (!cfg.appId) return sendJson(res, 200, { ok: true, data: null })
    const url = new URL(req.url, 'http://x')
    const pageUrl = url.searchParams.get('url') || ''
    try {
      const token = await wxAccessToken(cfg)
      const ticketRes = await (await fetch(`https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=${token}&type=jsapi`)).json()
      const noncestr = crypto.randomBytes(8).toString('hex')
      const timestamp = Math.floor(Date.now() / 1000)
      const str = `jsapi_ticket=${ticketRes.ticket}&noncestr=${noncestr}&timestamp=${timestamp}&url=${pageUrl}`
      const signature = crypto.createHash('sha1').update(str).digest('hex')
      sendJson(res, 200, { ok: true, data: { appId: cfg.appId, timestamp, nonceStr: noncestr, signature } })
    } catch (e) { fail(400, e.message) }
  })
}

function redirectTo(res, location) {
  res.writeHead(302, { Location: location })
  res.end()
}

async function upsertOAuthUser({ username, email, nickname, avatar }) {
  const uname = username || (email ? email.split('@')[0] : 'oauth_' + crypto.randomBytes(4).toString('hex'))
  let user = get('SELECT * FROM users WHERE username = ?', uname)
  if (!user && email) user = get('SELECT * FROM users WHERE email = ?', email)
  if (!user) {
    const role = get(`SELECT id FROM roles WHERE code = 'user'`)
    run('INSERT INTO users(username, nickname, password, email, avatar, role_id, status, created_at) VALUES(?,?,?,?,?,?,1,?)',
      uname, nickname || uname, hashPasswordless(), email || '', avatar || '', role.id, now())
    user = get('SELECT * FROM users WHERE username = ?', uname)
  }
  return user
}

const hashPasswordless = () => 'oauth$' + crypto.randomBytes(16).toString('hex')
