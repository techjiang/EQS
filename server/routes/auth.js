import { get, run, now, log } from '../lib/db.js'
import { readJson, fail, clientIp, sendJson } from '../lib/http.js'
import { hashPassword, verifyPassword, signSession, requireUser, currentUser, ensureAdmin, seedRoles, newApiKey } from '../lib/auth.js'

export default function register(r) {
  r.post('/api/auth/login', async (req, res) => {
    const { username, password } = await readJson(req)
    if (!username || !password) fail(400, '请输入账号和密码')
    const user = get('SELECT * FROM users WHERE username = ?', String(username).trim())
    if (!user || !verifyPassword(password, user.password)) fail(401, '账号或密码错误')
    if (user.status !== 1) fail(403, '账号已被禁用')
    run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), user.id)
    log(user, '登录', '', clientIp(req))
    const token = signSession({ uid: user.id, exp: Date.now() + 7 * 864e5 })
    sendJson(res, 200, { ok: true, user: { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar } }, {
      'Set-Cookie': `eqs_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`
    })
  })

  r.post('/api/auth/register', async (req, res) => {
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
    if (body.password) { fields.push('password = ?'); params.push(hashPassword(body.password)) }
    if (!fields.length) fail(400, '没有需要更新的内容')
    run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...params, user.id)
    sendJson(res, 200, { ok: true })
  })

  r.post('/api/auth/api-key', async (req, res) => {
    const user = requireUser(req)
    const key = newApiKey()
    run('INSERT INTO api_keys(name, key, enabled, created_at) VALUES(?,?,1,?)', `key-${user.username}`, key, now())
    sendJson(res, 200, { ok: true, key })
  })
}
