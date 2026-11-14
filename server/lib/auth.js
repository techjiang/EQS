import crypto from 'node:crypto'
import { get, run, setting, setSetting } from './db.js'
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

export function signSession(payload) {
  const body = b64(JSON.stringify({ iat: Date.now(), ...payload }))
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function readSession(req) {
  const token = parseCookies(req).eqs_token
  if (!token) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (payload.exp && payload.exp < Date.now()) return null
    return payload
  } catch { return null }
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
