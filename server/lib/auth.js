import crypto from 'node:crypto'
import { get, all, run, setting, setSetting } from './db.js'
import { parseCookies, fail, clientIp } from './http.js'

const SECRET = (() => {
  let s = setting('app_secret')
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setSetting('app_secret', s) }
  return s
})()

export function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex')
  const key = crypto.scryptSync(String(pwd), salt, 32).toString('hex')
  return `scrypt$${salt}$${key}`
}

export function verifyPassword(pwd, stored) {
  const [alg, salt, key] = String(stored || '').split('$')
  if (alg !== 'scrypt' || !salt || !key) return false
  const calc = crypto.scryptSync(String(pwd), salt, 32)
  const expect = Buffer.from(key, 'hex')
  return expect.length === calc.length && crypto.timingSafeEqual(expect, calc)
}

const b64 = s => Buffer.from(s).toString('base64url')

/**
 * 会话 = 服务端一行记录，Cookie 里只放一个不可猜的随机串。
 *
 * 以前是「HMAC 签名的 Cookie」，签名本身没问题，问题在于服务端没有那份记录：
 * 除了改密码那一下，没有任何办法单独作废某一条会话 ——
 * 手机丢了、电脑借人用过、在网吧登过，都只能「等 7 天」。
 * 签发一串随机 token、库里存它的 sha256，就能做到「按设备踢人」。
 */
export const SESSION_TTL = 7 * 864e5
const TOUCH_MS = 60 * 1000

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex')

export function createSession(userId, req = null, ip = '', ua = '') {
  const token = crypto.randomBytes(32).toString('hex')
  const id = crypto.randomBytes(12).toString('hex')
  const t = new Date()
  const exp = new Date(t.getTime() + SESSION_TTL)
  run(
    `INSERT INTO sessions(id, token_hash, user_id, ip, ua, created_at, last_seen_at, expires_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    id, sha256(token), userId,
    String(ip || (req ? clientIp(req) : '') || '').slice(0, 64),
    String(ua || (req?.headers?.['user-agent'] || '')).slice(0, 300),
    t.toISOString(), t.toISOString(), exp.toISOString()
  )
  // 顺手清掉过期记录，别让这张表无限长
  try { run('DELETE FROM sessions WHERE expires_at < ?', t.toISOString()) } catch {}
  return { token, id }
}

export const sessionCookie = token =>
  `eqs_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`

export const clearCookie = () => 'eqs_token=; Path=/; HttpOnly; Max-Age=0'

/** 读会话：库里查得到、没被吊销、没过期，才算数 */
export function readSession(req) {
  const token = parseCookies(req).eqs_token
  if (!token) return null
  const row = get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token))
  if (!row) return null
  if (row.revoked_at) return null
  if (row.expires_at && row.expires_at < new Date().toISOString()) return null
  // last_seen 不必每次请求都写库：一分钟一次足够画出「最近活跃」
  if (!row.last_seen_at || Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_MS) {
    try {
      run('UPDATE sessions SET last_seen_at = ?, ip = ? WHERE id = ?', new Date().toISOString(), clientIp(req).slice(0, 64), row.id)
    } catch {}
  }
  return { sid: row.id, uid: row.user_id, iat: new Date(row.created_at).getTime(), exp: new Date(row.expires_at).getTime() }
}

export function revokeSession(sid, byUserId = 0) {
  run('UPDATE sessions SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL',
    new Date().toISOString(), byUserId, String(sid))
}

/** 作废某个用户的会话；exceptSid 用来「退出其它设备」时保留当前这条 */
export function revokeUserSessions(userId, { exceptSid = '', byUserId = 0 } = {}) {
  const now2 = new Date().toISOString()
  if (exceptSid) {
    run('UPDATE sessions SET revoked_at = ?, revoked_by = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL', now2, byUserId, userId, String(exceptSid))
  } else {
    run('UPDATE sessions SET revoked_at = ?, revoked_by = ? WHERE user_id = ? AND revoked_at IS NULL', now2, byUserId, userId)
  }
}

export function listSessions(userId) {
  return all(`SELECT id, ip, ua, created_at, last_seen_at, expires_at FROM sessions
    WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC`,
    userId, new Date().toISOString())
}

export const ROLE_PERMS = {
  admin: ['*'],
  user: ['form:create', 'form:read', 'form:update', 'form:delete', 'data:read', 'data:write', 'bank:read', 'bank:write', 'report:read']
}

/**
 * API Key 身份：文档承诺 X-API-Key 可调接口，这里真正兑现。
 *
 * 但「Key 是谁签的」必须一起记住。之前一律按管理员解析 ——
 * 任何登录用户（包括自助注册的）自己签一把 Key，就拿到了全站管理员权限：
 * 实测能导出整站备份、新建管理员账号、改别人的问卷。Key 是凭证不是提权通道，
 * 它只该等价于「签发它的那个人」。
 */
function apiKeyUser(req) {
  const raw = req.headers['x-api-key'] || parseCookies(req).eqs_apikey || ''
  const key = String(raw).trim()
  if (!key) return null
  const row = get('SELECT * FROM api_keys WHERE key = ? AND enabled = 1', key)
  if (!row) return null
  // owner_id=0 是老数据：签发人未知，不能再当成管理员，一律作废（重新签一把即可）
  if (!row.owner_id) return null
  const owner = get('SELECT id, username, nickname, avatar, role_id, status FROM users WHERE id = ?', row.owner_id)
  if (!owner || owner.status !== 1) return null
  const role = get('SELECT * FROM roles WHERE id = ?', owner.role_id)
  let perms = []
  try { perms = JSON.parse(role?.perms || '[]') } catch {}
  return {
    ...owner, role: role?.code || 'user', roleName: role?.name || '用户', perms, viaApiKey: true, apiKeyName: row.name
  }
}

export function currentUser(req) {
  const session = readSession(req)
  if (!session?.uid) return apiKeyUser(req)
  const user = get('SELECT id, username, nickname, email, phone, avatar, role_id, dept_id, status, pwd_changed_at FROM users WHERE id = ?', session.uid)
  if (!user || user.status !== 1) return null
  // 改过密码之后，之前签出去的会话全部作废：否则「密码泄露 → 改密码」等于没改
  if (user.pwd_changed_at && (!session.iat || session.iat < new Date(user.pwd_changed_at).getTime())) return null
  const role = get('SELECT * FROM roles WHERE id = ?', user.role_id)
  let perms = []
  try { perms = JSON.parse(role?.perms || '[]') } catch {}
  return { ...user, role: role?.code || 'user', roleName: role?.name || '用户', perms }
}

export function can(user, perm) {
  if (!user) return false
  if (user.perms.includes('*')) return true
  return user.perms.includes(perm)
}

export function requireUser(req) {
  const user = currentUser(req)
  if (!user) fail(401, '请先登录')
  return user
}

export function requirePerm(req, perm) {
  const user = requireUser(req)
  if (!can(user, perm)) fail(403, '权限不足')
  return user
}

export function tokenFromApiKey(req, cookies) {
  const key = req.headers['x-api-key'] || cookies?.eqs_apikey
  if (!key) return false
  const row = get('SELECT * FROM api_keys WHERE key = ? AND enabled = 1', String(key))
  if (!row || !row.owner_id) return false
  const owner = get('SELECT status FROM users WHERE id = ?', row.owner_id)
  return owner?.status === 1
}

/** 记录「最后一次改密码的时间」，用来作废更早签发的会话 */
export function stampPasswordChange(userId) {
  run('UPDATE users SET pwd_changed_at = ? WHERE id = ?', new Date().toISOString(), userId)
}

export function ensureAdmin() {
  const count = get('SELECT COUNT(*) c FROM users').c
  if (count > 0) return
  const adminRole = get(`SELECT id FROM roles WHERE code = 'admin'`)
  run('INSERT INTO users(username, nickname, password, role_id, status, created_at) VALUES(?,?,?,?,1,?)',
    'admin', '超级管理员', hashPassword(process.env.EQS_ADMIN_PASSWORD || 'admin123'), adminRole.id, new Date().toISOString())
}

export function seedRoles() {
  const roles = [
    { name: '超级管理员', code: 'admin', perms: ['*'], builtin: 1 },
    { name: '普通用户', code: 'user', perms: ROLE_PERMS.user, builtin: 1 },
    { name: '只读访客', code: 'viewer', perms: ['form:read', 'data:read', 'report:read'], builtin: 1 }
  ]
  for (const r of roles) {
    if (!get('SELECT id FROM roles WHERE code = ?', r.code)) {
      run('INSERT INTO roles(name, code, perms, builtin) VALUES(?,?,?,?)', r.name, r.code, JSON.stringify(r.perms), r.builtin)
    }
  }
}

export function newApiKey() {
  return 'eqs_' + crypto.randomBytes(24).toString('hex')
}

export { SECRET, clientIp }
