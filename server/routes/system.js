import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { get, all, run, now, setting, setSetting, DATA_DIR, log, db, switchDb } from '../lib/db.js'
import { readBody, sendJson, fail, readJson, clientIp } from '../lib/http.js'
import { requireUser, can, createSession, sessionCookie } from '../lib/auth.js'
import { exportBackup, parseMultipart, extractZip } from './files.js'
import { smtpSend, wxAccessToken } from '../lib/notify.js'
import { generateForm } from '../lib/ai.js'

export default function register(r) {
  /** 健康检查（容器 / 负载均衡探活用） */
  r.get('/api/health', async (req, res) => {
    const ok = !!get('SELECT 1 AS x')
    sendJson(res, ok ? 200 : 503, { ok, uptime: Math.floor(process.uptime()), version: '1.0.0' })
  })

  /** 备份导出 */
  r.get('/api/backup/export', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const zip = exportBackup()
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="eqs-backup-${Date.now()}.zip"`,
      'Content-Length': zip.length
    })
    res.end(zip)
  })

  /**
   * 迁移导入：上传备份 zip，直接顶替当前数据库。
   * 不能只写一个待生效的文件等重启：面板已经显示「导入成功」，用户看到的却是空站。
   * 「导入成功」必须当场是真的，所以这里直接切连接（switchDb）。
   */
  r.post('/api/backup/import', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const ct = String(req.headers['content-type'] || '')
    const buf = await readBody(req)
    if (!ct.includes('multipart/form-data')) fail(400, '请上传 zip 备份文件')
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct)
    if (!boundary) fail(400, '缺少 boundary')
    const parts = parseMultipart(buf, boundary[1] || boundary[2])
    const file = parts.find(p => p.filename)
    if (!file) fail(400, '未找到备份文件')
    // 解包目录放在数据目录之外：放在 DATA_DIR 里时，exportBackup 会把上一次解包的残留也打进去
    const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eqs-restore-'))
    try {
      const unzipped = extractZip(file.data, restoreDir)
      if (unzipped && unzipped.ok === false) fail(400, unzipped.reason || '备份文件无法解包')
      const root = findEqsData(restoreDir)
      if (!root) fail(400, '备份文件结构不正确')
      const incoming = path.join(os.tmpdir(), `eqs-incoming-${Date.now()}.db`)
      fs.writeFileSync(incoming, fs.readFileSync(path.join(root, 'eqs.db')))
      // 切换连接：switchDb 内部 checkpoint → close → 覆盖 eqs.db → 重新打开（WAL 残留在里面清掉）
      switchDb(incoming)
      fs.rmSync(incoming, { force: true })
      /*
       * 合并而不是覆盖：旧备份里没有 files 目录时，之前这里一个都不动，
       * 于是「恢复了一个不含附件的旧备份」→ 数据库回到旧状态，附件还是新的，两边对不上；
       * 反过来若备份里带了 files，cpSync 又只覆盖不删除。两种情况都会留下孤儿文件或者丢附件。
       * 文件按「日期/随机名」存放，同名就是同一个文件，不覆盖才怪——所以这里只补不删，并在结束时报数。
       */
      const backupFiles = path.join(root, 'files')
      fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true })
      const added = fs.existsSync(backupFiles)
        ? fs.cpSync(backupFiles, path.join(DATA_DIR, 'files'), { recursive: true, force: false, errorOnExist: false }) ?? countFiles(backupFiles)
        : 0
      log(me, '导入备份', `已生效，附件合并 ${added || 0} 项`)
      sendJson(res, 200, {
        ok: true, restartRequired: false,
        message: '备份已导入并生效',
        filesMerged: added || 0,
        note: '附件按合并处理：备份里没有的文件会保留，不会被删除'
      })
    } finally {
      fs.rmSync(restoreDir, { recursive: true, force: true })
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
    sendJson(res, 200, {
      ok: true,
      data: {
        version: '1.0.0', node: process.version, uptime: Math.floor(process.uptime()),
        platform: `${process.platform} ${process.arch}`,
        dataDir: DATA_DIR, dbSize: size(path.join(DATA_DIR, 'eqs.db')),
        fileCount: counts.files, counts
      }
    })
  })

  /** 数据同步 API：全量导出（供外部系统拉取） */
  r.get('/api/sync/export', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const url = new URL(req.url, 'http://x')
    const formId = Number(url.searchParams.get('formId')) || 0
    const where = formId ? 'AND s.form_id = ?' : ''
    const args = formId ? [formId] : []
    const rows = all(`SELECT s.*, f.title AS form_title FROM submissions s JOIN forms f ON f.id = s.form_id WHERE s.deleted_at IS NULL ${where} ORDER BY s.id`, ...args)
    sendJson(res, 200, { ok: true, data: rows.map(x => ({ ...x, data: JSON.parse(x.data) })) })
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

function countFiles(dir) {
  let n = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(d, e.name))
      else n++
    }
  }
  return n
}

function findEqsData(dir) {
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name)
      if (!fs.statSync(full).isDirectory()) continue
      if (name === 'eqs-data') {
        if (fs.existsSync(path.join(full, 'eqs.db'))) return full
      }
      stack.push(full)
    }
  }
  return null
}
