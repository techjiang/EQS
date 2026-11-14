import { get, run, now, log, setting } from '../lib/db.js'
import { readJson, fail, clientIp, sendJson } from '../lib/http.js'
import {
  hashPassword, verifyPassword, requireUser, currentUser, ensureAdmin, seedRoles, newApiKey, stampPasswordChange,
  createSession, sessionCookie, clearCookie, readSession, revokeSession, revokeUserSessions, listSessions, SESSION_TTL, can
} from '../lib/auth.js'

/**
 * 登录失败限速。
 * 之前连打 30 次错误密码，全部 401，服务端一声不吭 —— 六位密码在局域网里一夜就能跑完。
 * 按「账号 + IP」计失败次数，超了先锁一段时间；成功登录清零。
 * 放内存即可：重启丢掉计数不是问题，重启本来就打断了攻击节奏。
 */
const MAX_FAILS = 8
const LOCK_MS = 10 * 60 * 1000
const fails = new Map()
const failKey = (username, ip) => `${String(username || '').trim().toLowerCase()}|${ip}`
function checkLocked(username, ip) {
  const rec = fails.get(failKey(username, ip))
  if (!rec) return
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
    const min = Math.ceil((rec.lockedUntil - Date.now()) / 60000)
    fail(429, `密码错误次数过多，请 ${min} 分钟后再试`)
  }
}
function noteFail(username, ip) {
  const k = failKey(username, ip)
  const rec = fails.get(k) || { count: 0, lockedUntil: 0 }
  rec.count++
  if (rec.count >= MAX_FAILS) { rec.lockedUntil = Date.now() + LOCK_MS; rec.count = 0 }
  fails.set(k, rec)
  // 顺手清掉过期记录，避免一张表无限长
  if (fails.size > 5000) for (const [k2, v] of fails) if (!v.lockedUntil || v.lockedUntil < Date.now()) fails.delete(k2)
}
const clearFail = (username, ip) => fails.delete(failKey(username, ip))

/** 注册是否开放：默认关。私域问卷系统里「任何人都能注册」等于任何人都能建卷、看数据 */
const registerOpen = () => setting('site', {})?.allowRegister === true

export default function register(r) {
  r.post('/api/auth/login', async (req, res) => {
    const { username, password } = await readJson(req)
    if (!username || !password) fail(400, '请输入账号和密码')
    const ip = clientIp(req)
    checkLocked(username, ip)
    const user = get('SELECT * FROM users WHERE username = ?', String(username).trim())
    if (!user || !verifyPassword(password, user.password)) {
      noteFail(username, ip)
      fail(401, '账号或密码错误')
    }
    clearFail(username, ip)
    if (user.status !== 1) fail(403, '账号已被禁用')
    run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), user.id)
    log(user, '登录', '', clientIp(req))
    const { token } = createSession(user.id, req, ip, req.headers['user-agent'] || '')
    sendJson(res, 200, { ok: true, user: { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar } }, {
      'Set-Cookie': sessionCookie(token)
    })
  })

  r.post('/api/auth/register', async (req, res) => {
    // 默认关闭自动注册：站点一上线，陌生人注册进来就能建卷、看自己的数据，
    // 而系统里根本没有「审核 / 停用」这一环。要开放就在 系统设置 → 站点 里打开。
    if (!registerOpen()) fail(403, '本站未开放自助注册，请联系管理员开通账号')
    const { username, password, nickname, email } = await readJson(req)
    if (!username || !password) fail(400, '请输入账号和密码')
    if (String(password).length < 6) fail(400, '密码至少 6 位')
    if (get('SELECT id FROM users WHERE username = ?', String(username).trim())) fail(409, '账号已存在')
    const role = get(`SELECT id FROM roles WHERE code = 'user'`)
    run('INSERT INTO users(username, nickname, password, email, role_id, status, created_at) VALUES(?,?,?,?,?,1,?)',
      String(username).trim(), nickname || username, hashPassword(password), email || '', role.id, now())
    const user = get('SELECT * FROM users WHERE username = ?', String(username).trim())
    const { token } = createSession(user.id, req, clientIp(req), req.headers['user-agent'] || '')
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token) })
  })

  r.post('/api/auth/logout', async (req, res) => {
    // 退出不只是「把浏览器里的 Cookie 删掉」：服务端那一条也要吊销，
    // 否则抓到的 Cookie 在别处还能用满 7 天。
    const session = readSession(req)
    if (session?.sid) revokeSession(session.sid)
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() })
  })

  r.get('/api/auth/me', async (req, res) => {
    const user = currentUser(req)
    sendJson(res, 200, { ok: true, user })
  })

  r.put('/api/auth/me', async (req, res) => {
    const user = requireUser(req)
    const body = await readJson(req)
    const fields = []
    const params = []
    for (const k of ['nickname', 'email', 'phone', 'avatar']) {
      if (body[k] !== undefined) { fields.push(`${k} = ?`); params.push(String(body[k])) }
    }
    if (body.password) {
      // 改密码必须验旧密码并守长度：以前这里既不验旧密码也不校验位数，
      // 任何一次 XSS 或借来的电脑，都能把账号密码改成 1 位然后拿走。
      const row = get('SELECT password FROM users WHERE id = ?', user.id)
      if (!body.oldPassword) fail(400, '请输入当前密码')
      if (!verifyPassword(body.oldPassword, row.password)) fail(403, '当前密码不正确')
      if (String(body.password).length < 6) fail(400, '新密码至少 6 位')
      if (String(body.password) === String(body.oldPassword)) fail(400, '新密码不能与当前密码相同')
      fields.push('password = ?'); params.push(hashPassword(body.password))
    }
    if (!fields.length) fail(400, '没有需要更新的内容')
    run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...params, user.id)
    if (body.password) {
      stampPasswordChange(user.id)
      log(user, '修改密码', '')
      // 旧会话全部作废（包含当前这条）：让用户拿新密码重新登录一次，才知道密码真的换了
      revokeUserSessions(user.id, { byUserId: user.id })
      return sendJson(res, 200, { ok: true, relogin: true }, { 'Set-Cookie': clearCookie() })
    }
    sendJson(res, 200, { ok: true })
  })

  r.post('/api/auth/api-key', async (req, res) => {
    // 自助签发已下线：以前任何登录用户都能在这里给自己签一把「管理员级」Key。
    // 现在只能由管理员在 系统设置 → API Key 里签，且签出来的 Key 只继承签发人自己的权限。
    requireUser(req)
    fail(403, 'API Key 请由管理员在「系统设置 → API Key」中创建')
  })

  /* ---------------- 登录设备（会话） ---------------- */

  /**
   * 当前账号的会话列表。
   * 之前会话是签名 Cookie，服务端没有记录，于是「我登过哪些设备」这件事根本无从回答。
   */
  r.get('/api/auth/sessions', async (req, res) => {
    const me = requireUser(req)
    const cur = readSession(req)
    const rows = listSessions(me.id).map(s => ({
      id: s.id,
      ip: s.ip || '-',
      device: describeUa(s.ua),
      ua: s.ua || '',
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      current: s.id === cur?.sid
    }))
    sendJson(res, 200, { ok: true, data: rows })
  })

  /** 踢掉某一台设备；踢自己 = 退出当前登录 */
  r.delete('/api/auth/sessions/:id', async (req, res, { params }) => {
    const me = requireUser(req)
    const row = get('SELECT * FROM sessions WHERE id = ?', String(params.id))
    if (!row) fail(404, '会话不存在')
    // 只能踢自己的：别人家的设备列表里不该出现你的 id
    if (row.user_id !== me.id && !can(me, '*')) fail(403, '无权操作其他账号的会话')
    revokeSession(row.id, me.id)
    log(me, '下线设备', `${row.ip || '-'} ${describeUa(row.ua)}`)
    const cur = readSession(req)
    sendJson(res, 200, { ok: true, self: row.user_id === me.id && row.id === cur?.sid })
  })

  /** 退出其它所有设备 */
  r.post('/api/auth/sessions/revoke-others', async (req, res) => {
    const me = requireUser(req)
    const cur = readSession(req)
    revokeUserSessions(me.id, { exceptSid: cur?.sid || '', byUserId: me.id })
    log(me, '退出其它设备', '')
    sendJson(res, 200, { ok: true })
  })
}

/** 把 User-Agent 归成人话：这条会话到底是哪台设备 */
function describeUa(ua) {
  const s = String(ua || '')
  if (!s) return '未知设备'
  const os = /iPhone/i.test(s) ? 'iPhone'
    : /iPad/i.test(s) ? 'iPad'
    : /iPod/i.test(s) ? 'iPod'
    : /Android/i.test(s) ? (/Mobile/i.test(s) ? 'Android 手机' : 'Android 平板')
    : /Windows/i.test(s) ? 'Windows'
    : /Macintosh|Mac OS X/i.test(s) ? 'macOS'
    : /Linux/i.test(s) ? 'Linux' : ''
  const br = /Edg\//i.test(s) ? 'Edge'
    : /OPR\/|Opera/i.test(s) ? 'Opera'
    : /Firefox\//i.test(s) ? 'Firefox'
    : /Chrome\//i.test(s) ? 'Chrome'
    : /Safari\//i.test(s) ? 'Safari'
    : /curl|node|python|axios/i.test(s) ? '脚本 / 客户端'
    : /bot|spider|crawler/i.test(s) ? '爬虫' : ''
  const name = [os, br].filter(Boolean).join(' · ')
  return name || s.slice(0, 40)
}
