import { get, all, run, now, log, setting, setSetting } from '../lib/db.js'
import { readJson, fail, sendJson, clientIp } from '../lib/http.js'
import { requireUser, requirePerm, can, hashPassword } from '../lib/auth.js'
import { storageConfig } from '../lib/storage.js'
import { smtpSend, sendSms, dispatchWebhooks } from '../lib/notify.js'
import { aiConfig, generateForm, localGenerate } from '../lib/ai.js'
import { safeJson } from '../lib/forms.js'

const SECRET_FIELDS = ['password', 'pass', 'apiKey', 'secretKey', 'secret', 'accessKey', 'appSecret', 'secretId']

/** 输出时脱敏密钥类字段 */
function mask(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const out = Array.isArray(obj) ? [] : {}
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') out[k] = mask(v)
    else if (isSecretKey(k) && typeof v === 'string' && v.length > 4) out[k] = v.slice(0, 2) + '****' + v.slice(-2)
    else out[k] = v
  }
  return out
}

/**
 * 密钥字段名判断：不分大小写，并覆盖「名字里带这些东西」的组合词。
 * 之前只做精确匹配，clientSecret / sdkAppId 这类名字漏网，密钥被原样下发到浏览器。
 */
const SECRET_SUFFIX = ['secret', 'secretkey', 'secretid', 'password', 'pass', 'apikey', 'accesskey', 'token']
function isSecretKey(key) {
  const k = String(key).toLowerCase()
  if (SECRET_FIELDS.some(f => f.toLowerCase() === k)) return true
  return SECRET_SUFFIX.some(s2 => k.endsWith(s2))
}

/** 单个密钥值脱敏：短密钥整体遮掉，避免「前 2 后 2」把 6 位的 key 泄露一半 */
function maskSecret(v) {
  const s2 = String(v ?? '')
  if (!s2) return ''
  return s2.length > 8 ? s2.slice(0, 2) + '****' + s2.slice(-2) : '****'
}

/** 值里带 **** 就是脱敏残留，回写时必须换成库里的原值，否则密钥被这一串星号覆盖掉 */
const MASKED = /\*\*\*\*/

/**
 * 把前端提交的配置合并到现有配置上。
 * 值为脱敏串（含 ****）时保留库里的原值；对象递归合并，数组直接替换。
 */
function mergeMasked(prev, next) {
  if (next === null || next === undefined) return prev
  if (typeof next === 'string') return MASKED.test(next) ? prev : next
  if (typeof next !== 'object') return next
  if (Array.isArray(next)) return next
  const base = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}
  const out = { ...base }
  for (const [k, v] of Object.entries(next)) {
    if (isSecretKey(k) && typeof v === 'string' && MASKED.test(v)) {
      // 名字就是密钥的字段，脱敏串一律视为「没改」
      if (typeof base[k] === 'string') continue
    }
    out[k] = k in base ? mergeMasked(base[k], v) : v
  }
  return out
}

export default function register(r) {
  /* ---------------- 用户 ---------------- */
  r.get('/api/users', async (req, res) => {
    const me = requirePerm(req, 'form:read')
    const url = new URL(req.url, 'http://x')
    const keyword = url.searchParams.get('keyword')
    const where = []
    const args = []
    if (keyword) { where.push('(u.username LIKE ? OR u.nickname LIKE ?)'); args.push(`%${keyword}%`, `%${keyword}%`) }
    const rows = all(`SELECT u.id, u.username, u.nickname, u.email, u.phone, u.avatar, u.role_id, u.dept_id, u.status, u.last_login_at, u.created_at,
      r.name AS role_name, d.name AS dept_name
      FROM users u LEFT JOIN roles r ON r.id = u.role_id LEFT JOIN depts d ON d.id = u.dept_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.id ASC`, ...args)
    // 通讯录不是公开资料。普通用户带 form:read 就能拿到全站账号、邮箱、手机号，
    // 前端那一栏明明写着「用户与权限（仅管理员）」——非管理员只回自己这一条。
    if (!can(me, '*')) return sendJson(res, 200, { ok: true, data: rows.filter(u => u.id === me.id), self: true })
    sendJson(res, 200, { ok: true, data: rows })
  })

  r.post('/api/users', async (req, res) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '仅管理员可新增用户')
    const body = await readJson(req)
    if (!body.username || !body.password) fail(400, '账号和密码必填')
    if (String(body.password).length < 6) fail(400, '密码至少 6 位')
    if (get('SELECT id FROM users WHERE username = ?', body.username)) fail(409, '账号已存在')
    run('INSERT INTO users(username, nickname, password, email, phone, role_id, dept_id, status, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      body.username, body.nickname || body.username, hashPassword(body.password), body.email || '', body.phone || '',
      Number(body.role_id) || 2, Number(body.dept_id) || 0, body.status === 0 ? 0 : 1, now())
    log(me, '新增用户', body.username)
    sendJson(res, 201, { ok: true })
  })

  r.put('/api/users/:id', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    const target = get('SELECT * FROM users WHERE id = ?', Number(params.id))
    if (!target) fail(404, '用户不存在')
    if (!can(me, '*') && me.id !== target.id) fail(403, '无权修改其他用户')
    const body = await readJson(req)
    const sets = []
    const args = []
    for (const k of ['nickname', 'email', 'phone', 'avatar']) {
      if (body[k] !== undefined) { sets.push(`${k} = ?`); args.push(String(body[k])) }
    }
    if (can(me, '*')) {
      if (body.role_id !== undefined) { sets.push('role_id = ?'); args.push(Number(body.role_id)) }
      if (body.dept_id !== undefined) { sets.push('dept_id = ?'); args.push(Number(body.dept_id)) }
      if (body.status !== undefined) { sets.push('status = ?'); args.push(body.status ? 1 : 0) }
    }
    if (body.password) {
      if (String(body.password).length < 6) fail(400, '密码至少 6 位')
      sets.push('password = ?'); args.push(hashPassword(body.password))
    }
    if (!sets.length) fail(400, '没有需要更新的内容')
    run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...args, target.id)
    log(me, '修改用户', target.username)
    sendJson(res, 200, { ok: true })
  })

  r.delete('/api/users/:id', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '仅管理员可删除用户')
    const target = get('SELECT * FROM users WHERE id = ?', Number(params.id))
    if (!target) fail(404, '用户不存在')
    if (target.id === me.id) fail(400, '不能删除自己')
    if (target.username === 'admin') fail(400, '内置管理员不可删除')
    run('DELETE FROM users WHERE id = ?', target.id)
    log(me, '删除用户', target.username)
    sendJson(res, 200, { ok: true })
  })

  /* ---------------- 角色 / 部门 ---------------- */
  r.get('/api/roles', async (req, res) => {
    const me = requirePerm(req, 'form:read')
    const rows = all(`SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count
      FROM roles r ORDER BY r.id`).map(x => ({ ...x, perms: safeJson(x.perms, []) }))
    // 角色表是权限模型本身。非管理员拿不到别人的权限位，也不需要：
    // 只回自己那一个，前端下拉框不至于空着，越权面也不再外扩。
    if (!can(me, '*')) return sendJson(res, 200, { ok: true, data: rows.filter(r2 => r2.id === me.role_id) })
    sendJson(res, 200, { ok: true, data: rows })
  })

  r.post('/api/roles', async (req, res) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const body = await readJson(req)
    if (!body.name || !body.code) fail(400, '角色名称和标识必填')
    if (get('SELECT id FROM roles WHERE code = ?', body.code)) fail(409, '角色标识已存在')
    run('INSERT INTO roles(name, code, perms, builtin) VALUES(?,?,?,0)', body.name, body.code, JSON.stringify(body.perms || []))
    sendJson(res, 201, { ok: true })
  })

  r.put('/api/roles/:id', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const role = get('SELECT * FROM roles WHERE id = ?', Number(params.id))
    if (!role) fail(404, '角色不存在')
    const body = await readJson(req)
    /*
     * 内置 admin 的 ['*'] 是「唯一还能改回来」的那把钥匙：
     * 勾掉它保存一次，全站立刻没有管理员，而这把钥匙本身也再没人改得回来——
     * 只能进数据库手动改。所以它只允许改名，权限位锁死。
     */
    if (role.code === 'admin' && body.perms !== undefined) {
      const next = Array.isArray(body.perms) ? body.perms : []
      if (!next.includes('*')) fail(400, '内置「超级管理员」角色的权限不可移除，否则将无人能再管理系统')
    }
    run('UPDATE roles SET name = ?, perms = ? WHERE id = ?',
      body.name ?? role.name, JSON.stringify(body.perms ?? safeJson(role.perms, [])), role.id)
    sendJson(res, 200, { ok: true })
  })

  r.delete('/api/roles/:id', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const role = get('SELECT * FROM roles WHERE id = ?', Number(params.id))
    if (!role) fail(404, '角色不存在')
    if (role.builtin) fail(400, '内置角色不可删除')
    // 删角色不检查占用：用户会留在一个不存在的 role_id 上，权限全空，
    // 登录后每个按钮都「权限不足」，而他自己的资料页看不出任何原因。
    const used = get('SELECT COUNT(*) c FROM users WHERE role_id = ?', role.id).c
    if (used) fail(400, `还有 ${used} 个用户属于该角色，请先把他们改到其他角色`)
    run('DELETE FROM roles WHERE id = ?', role.id)
    sendJson(res, 200, { ok: true })
  })

  r.get('/api/depts', async (req, res) => {
    requireUser(req)
    sendJson(res, 200, { ok: true, data: all('SELECT * FROM depts ORDER BY sort, id') })
  })

  r.post('/api/depts', async (req, res) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const body = await readJson(req)
    if (!body.name) fail(400, '请填写部门名称')
    const result = run('INSERT INTO depts(name, parent_id, sort) VALUES(?,?,?)', body.name, Number(body.parent_id) || 0, Number(body.sort) || 0)
    sendJson(res, 201, { ok: true, id: Number(result.lastInsertRowid) })
  })

  r.delete('/api/depts/:id', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    run('DELETE FROM depts WHERE id = ?', Number(params.id))
    sendJson(res, 200, { ok: true })
  })

  /* ---------------- 系统设置 ---------------- */
  const CONFIG_KEYS = ['site', 'storage', 'mail', 'sms', 'wechat', 'oauth', 'map', 'ai', 'i18n', 'notify']

  r.get('/api/settings', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const out = {}
    for (const k of CONFIG_KEYS) out[k] = mask(setting(k, {}))
    sendJson(res, 200, { ok: true, data: out })
  })

  r.get('/api/settings/public', async (req, res) => {
    const site = setting('site', {})
    sendJson(res, 200, {
      ok: true,
      data: {
        name: site.name || 'EQS',
        logo: site.logo || '',
        icp: site.icp || '',
        lang: setting('i18n', {})?.defaultLang || 'zh',
        mapKey: setting('map', {})?.enabled ? { key: setting('map', {}).amapKey, security: setting('map', {}).amapSecurity } : null,
        oauth: {
          google: !!setting('oauth', {})?.google?.clientId,
          wechat: !!setting('oauth', {})?.wechatMp?.appId
        }
      }
    })
  })

  r.put('/api/settings/:key', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    if (!CONFIG_KEYS.includes(params.key)) fail(400, '不支持的配置项')
    const body = await readJson(req)
    const prev = setting(params.key, {})
    // 合并而不是整块替换：clientId / apiKey 这些是嵌套两层的对象，
    // 只比顶层 key 时，前端提交的 {'google': {clientSecret: 'GO****ET'}} 会整块顶上，
    // 脱敏串被当成真密钥写回库里——保存一次，密钥就废了。
    const merged = mergeMasked(prev, body)
    setSetting(params.key, merged)
    log(me, '修改设置', params.key)
    sendJson(res, 200, { ok: true })
  })

  r.post('/api/settings/storage/test', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const cfg = storageConfig()
    sendJson(res, 200, { ok: true, driver: cfg.driver, message: cfg.driver === 'local' ? '本地存储可用' : '已保存配置，上传时将进行真实验证' })
  })

  r.post('/api/settings/mail/test', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const body = await readJson(req)
    const cfg = setting('mail', {})
    if (!cfg.host) fail(400, '请先保存邮件服务器配置')
    try {
      await smtpSend(cfg, { to: body.to || cfg.user, subject: 'EQS 邮件测试', html: '<p>这是一封来自 EQS 的测试邮件。</p>' })
      sendJson(res, 200, { ok: true, message: '测试邮件已发送' })
    } catch (e) { fail(400, e.message) }
  })

  r.post('/api/settings/sms/test', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const body = await readJson(req)
    if (!body.phone) fail(400, '请填写测试手机号')
    const cfg = setting('sms', {})
    try {
      await sendSms(cfg, { phone: body.phone, text: 'EQS 短信测试', params: { code: '123456' } })
      sendJson(res, 200, { ok: true })
    } catch (e) { fail(400, e.message) }
  })

  /* ---------------- WebHook / API Key ---------------- */
  r.get('/api/webhooks', async (req, res) => {
    const me = requirePerm(req, 'form:read')
    // 订阅地址和签名密钥是管理员的东西：普通用户带 form:read 也能拿到 secret，
    // 就等于拿到伪造回调签名的能力。非管理员只被告知「有配置」，不给内容。
    if (!can(me, '*')) return sendJson(res, 200, { ok: true, data: [], masked: true })
    sendJson(res, 200, {
      ok: true,
      data: all('SELECT * FROM webhooks ORDER BY id').map(x => ({ ...x, secret: maskSecret(x.secret), events: safeJson(x.events, []) }))
    })
  })

  r.post('/api/webhooks', async (req, res) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const body = await readJson(req)
    if (!body.url) fail(400, '请填写回调地址')
    run('INSERT INTO webhooks(name, url, events, secret, enabled, created_at) VALUES(?,?,?,?,?,?)',
      body.name || 'webhook', body.url, JSON.stringify(body.events || ['create']), body.secret || '', body.enabled === 0 ? 0 : 1, now())
    sendJson(res, 201, { ok: true })
  })

  r.put('/api/webhooks/:id', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const h = get('SELECT * FROM webhooks WHERE id = ?', Number(params.id))
    if (!h) fail(404, 'WebHook 不存在')
    const body = await readJson(req)
    // 前端拿到的是脱敏后的 secret，原样提交回来不能把真密钥覆盖成一串星号
    const secret = typeof body.secret === 'string' && MASKED.test(body.secret) ? h.secret : (body.secret ?? h.secret)
    run('UPDATE webhooks SET name = ?, url = ?, events = ?, secret = ?, enabled = ? WHERE id = ?',
      body.name ?? h.name, body.url ?? h.url, JSON.stringify(body.events ?? safeJson(h.events, [])),
      secret, body.enabled === undefined ? h.enabled : (body.enabled ? 1 : 0), h.id)
    sendJson(res, 200, { ok: true })
  })

  r.delete('/api/webhooks/:id', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    run('DELETE FROM webhooks WHERE id = ?', Number(params.id))
    sendJson(res, 200, { ok: true })
  })

  r.post('/api/webhooks/:id/test', async (req, res, { params }) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const h = get('SELECT * FROM webhooks WHERE id = ?', Number(params.id))
    if (!h) fail(404, 'WebHook 不存在')
    const result = await dispatchWebhooks('test', { message: 'EQS 测试事件', hookId: h.id })
    sendJson(res, 200, { ok: true, result })
  })

  r.get('/api/api-keys', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    sendJson(res, 200, { ok: true, data: all('SELECT id, name, enabled, created_at FROM api_keys ORDER BY id DESC') })
  })

  r.post('/api/api-keys', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const body = await readJson(req)
    const key = 'eqs_' + (await import('node:crypto')).randomBytes(24).toString('hex')
    run('INSERT INTO api_keys(name, key, enabled, created_at) VALUES(?,?,1,?)', body.name || '默认密钥', key, now())
    sendJson(res, 201, { ok: true, key })
  })

  r.delete('/api/api-keys/:id', async (req, res, { params }) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    run('DELETE FROM api_keys WHERE id = ?', Number(params.id))
    sendJson(res, 200, { ok: true })
  })

  /* ---------------- AI ---------------- */
  r.post('/api/ai/generate', async (req, res) => {
    const me = requirePerm(req, 'form:create')
    const body = await readJson(req)
    if (!body.prompt) fail(400, '请描述你想要的表单')
    try {
      const result = await generateForm(body.prompt, { lang: body.lang || 'zh', kind: body.kind || 'survey' })
      sendJson(res, 200, { ok: true, data: result, source: 'ai' })
    } catch (e) {
      log(me, 'AI 生成失败', e.message)
      sendJson(res, 200, { ok: true, data: localGenerate(body.prompt, body.kind), source: 'local', warning: e.message })
    }
  })

  r.post('/api/ai/stream', async (req, res) => {
    requirePerm(req, 'form:create')
    const body = await readJson(req)
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    try {
      const { streamForm } = await import('../lib/ai.js')
      for await (const chunk of streamForm(body.prompt || '', { lang: body.lang, kind: body.kind })) {
        res.write(`data: ${JSON.stringify({ delta: chunk.delta })}\n\n`)
      }
      res.write('data: [DONE]\n\n')
    } catch (e) {
      const local = localGenerate(body.prompt || '', body.kind)
      res.write(`data: ${JSON.stringify({ error: e.message, fallback: local })}\n\n`)
      res.write('data: [DONE]\n\n')
    }
    res.end()
  })

  r.get('/api/ai/config', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const cfg = aiConfig()
    sendJson(res, 200, { ok: true, data: { ...cfg, apiKey: cfg.apiKey ? cfg.apiKey.slice(0, 3) + '****' : '' } })
  })

  /* ---------------- 日志 ---------------- */
  r.get('/api/logs', async (req, res) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const rows = all('SELECT * FROM logs ORDER BY id DESC LIMIT 200')
    sendJson(res, 200, { ok: true, data: rows })
  })

  /* ---------------- 多语言 ---------------- */
  r.get('/api/i18n/:lang', async (req, res, { params }) => {
    const rows = all('SELECT key, value FROM i18n WHERE lang = ?', params.lang)
    sendJson(res, 200, { ok: true, data: Object.fromEntries(rows.map(x => [x.key, x.value])) })
  })

  r.put('/api/i18n/:lang', async (req, res, { params }) => {
    const me = requireUser(req)
    if (!can(me, '*')) fail(403, '权限不足')
    const body = await readJson(req)
    for (const [k, v] of Object.entries(body)) {
      run('INSERT INTO i18n(lang, key, value) VALUES(?,?,?) ON CONFLICT(lang, key) DO UPDATE SET value = excluded.value', params.lang, k, String(v))
    }
    sendJson(res, 200, { ok: true })
  })
}
