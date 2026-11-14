import { get, run, now, log, setting } from '../lib/db.js'
import { readJson, fail, clientIp, sendJson } from '../lib/http.js'
import { hashPassword, verifyPassword, signSession, requireUser, currentUser, ensureAdmin, seedRoles, newApiKey, stampPasswordChange } from '../lib/auth.js'

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
    const token = signSession({ uid: user.id, exp: Date.now() + 7 * 864e5 })
    sendJson(res, 200, { ok: true, user: { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar } }, {
      'Set-Cookie': `eqs_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`
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
    const token = signSession({ uid: user.id, exp: Date.now() + 7 * 864e5 })
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': `eqs_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}` })
  })

  r.post('/api/auth/logout', async (req, res) => {
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'eqs_token=; Path=/; HttpOnly; Max-Age=0' })
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
      return sendJson(res, 200, { ok: true, relogin: true }, { 'Set-Cookie': 'eqs_token=; Path=/; HttpOnly; Max-Age=0' })
    }
    sendJson(res, 200, { ok: true })
  })

  r.post('/api/auth/api-key', async (req, res) => {
    // 自助签发已下线：以前任何登录用户都能在这里给自己签一把「管理员级」Key。
    // 现在只能由管理员在 系统设置 → API Key 里签，且签出来的 Key 只继承签发人自己的权限。
    requireUser(req)
    fail(403, 'API Key 请由管理员在「系统设置 → API Key」中创建')
  })
}
