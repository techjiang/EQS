import { get, all, run, now, log } from '../lib/db.js'
import { readJson, fail, sendJson } from '../lib/http.js'
import { requireUser, requirePerm, can } from '../lib/auth.js'
import { normalizeField, paginate, safeJson, gradeSubmission, coerceAnswerToField, isAnswerCorrect, answerText } from '../lib/forms.js'
import { parseTextToFields, normalizeTags } from './forms.js'
import { readXlsxUpload } from './files.js'
import { parseXlsx, rowsToFields, questionsXlsx, templateXlsx } from '../lib/sheet.js'

const parseQ = q => ({ ...q, options: safeJson(q.options, []), answer: safeJson(q.answer, []), props: safeJson(q.props, {}) })

/**
 * 题库是「我的」资源：列表、组卷、删除都按 owner 过滤，
 * 但读题、刷题、看进度三处漏了同一道校验——任何登录用户换一个 id 就能读到别人题库的
 * 全部题目和标准答案（连做题都不需要），私有题库等于公开。
 */
/** 及格线是卷面百分比：<=0 落 60，>100 就是「永远不及格」，必须夹住 */
function clampPercent(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 60
  return Math.min(100, Math.max(1, Math.round(n * 10) / 10))
}

const TYPE_LABEL = {
  radio: '单选', checkbox: '多选', select: '下拉', text: '填空', textarea: '简答',
  judge: '判断', rate: '评分', nps: '量表', date: '日期', number: '数字',
  upload: '上传', phone: '手机', email: '邮箱', sort: '排序', matrix: '矩阵',
  slider: '滑动', signature: '签名'
}
function typeLabelOf(t) { return TYPE_LABEL[t] || t }

/**
 * 单题库抽题：题型 / 标签筛选 + 随机。
 * 筛了却一道都没有时明确报错——静默退回全库会让「只要单选」的卷子里冒出简答题。
 */
function pickQuestions(bankId, body, count) {
  const where = ['bank_id = ?', 'deleted_at IS NULL']
  const args = [bankId]
  const types = (Array.isArray(body.types) ? body.types : body.typeFilter ? [body.typeFilter] : []).filter(Boolean)
  if (types.length) { where.push(`type IN (${types.map(() => '?').join(',')})`); args.push(...types) }
  const tags = (Array.isArray(body.tags) ? body.tags : body.tag ? [body.tag] : []).map(t => String(t).trim()).filter(Boolean)
  for (const t of tags) {
    // 整词匹配：`LIKE %基础%` 会把「计算机基础」也算进来
    where.push("(',' || tags || ',') LIKE ?")
    args.push(`%,${t},%`)
  }
  const rows = all(`SELECT * FROM questions WHERE ${where.join(' AND ')} ORDER BY RANDOM() LIMIT ?`, ...args, count)
  if (!rows.length && (types.length || tags.length)) {
    const parts = []
    if (types.length) parts.push(`题型「${types.map(typeLabelOf).join(' / ')}」`)
    if (tags.length) parts.push(`标签「${tags.join(' / ')}」`)
    fail(400, `该题库中没有同时满足 ${parts.join(' + ')} 的题目`)
  }
  return rows
}

/*
 * 题库的访问身份有四档：管理员 / 所有者 / 协作者（editor、viewer）/ 无关。
 * 以前只有「owner 或管理员」一种判断，写死在七八个接口里，所以「两个人一起维护一个题库」
 * 根本没法表达，只能各建一个题库把题复制过去——题库协作与权限这一条一直是空的。
 *
 * 现在收敛成两个函数：readableBank（能不能看）与 writableBank（能不能改）。
 * 谁都不能既当裁判又当运动员：只有所有者和管理员能管理成员、删除题库。
 */
export function bankRole(user, bank) {
  if (!bank) return null
  if (can(user, '*')) return 'owner'
  if (bank.owner_id === user.id) return 'owner'
  const m = get('SELECT role FROM bank_members WHERE bank_id = ? AND user_id = ?', bank.id, user.id)
  return m?.role || null
}

/** 我能看到哪些题库（自建 + 被邀请协作） */
function visibleBankWhere(user) {
  if (can(user, '*')) return { sql: '', args: [] }
  return { sql: ' AND (b.owner_id = ? OR b.id IN (SELECT bank_id FROM bank_members WHERE user_id = ?))', args: [user.id, user.id] }
}

function readableBank(user, id) {
  const bank = get('SELECT * FROM banks WHERE id = ? AND deleted_at IS NULL', Number(id))
  if (!bank) return null
  return bankRole(user, bank) ? bank : null
}

/** 能改题、能组卷：所有者 + editor。viewer 只能读 */
function writableBank(user, id) {
  const bank = readableBank(user, id)
  if (!bank) return null
  const role = bankRole(user, bank)
  if (role === 'viewer') fail(403, '你在该题库中是「只读」协作者，无法修改题目')
  return bank
}

/** 成员管理与删除题库：只有所有者（含管理员） */
function ownedBank(user, id) {
  const bank = readableBank(user, id)
  if (!bank) return null
  if (bankRole(user, bank) !== 'owner') fail(403, '只有题库所有者可以执行该操作')
  return bank
}

export default function register(r) {
  r.get('/api/banks', async (req, res) => {
    const user = requireUser(req)
    const url = new URL(req.url, 'http://x')
    const keyword = url.searchParams.get('keyword')
    const where = ['b.deleted_at IS NULL']
    const args = []
    const vis = visibleBankWhere(user)
    if (vis.sql) { where.push('1 = 1' + vis.sql); args.push(...vis.args) }
    if (keyword) { where.push('b.name LIKE ?'); args.push(`%${keyword}%`) }
    const rows = all(`SELECT b.*,
        (SELECT COUNT(*) FROM questions q WHERE q.bank_id = b.id AND q.deleted_at IS NULL) AS question_count,
        (SELECT COUNT(*) FROM bank_members m WHERE m.bank_id = b.id) AS member_count
      FROM banks b WHERE ${where.join(' AND ')} ORDER BY b.id DESC`, ...args)
    /*
     * 每一行都带上「我和这个题库是什么关系」：前端据此收起导入/删除按钮，
     * 而不是让只读协作者点下去才收到 403——点了才知道不行，比没有按钮更让人恼火。
     */
    sendJson(res, 200, { ok: true, data: rows.map(b => ({ ...b, my_role: bankRole(user, b) })) })
  })

  r.post('/api/banks', async (req, res) => {
    const user = requirePerm(req, 'bank:write')
    const body = await readJson(req)
    if (!body.name) fail(400, '请填写题库名称')
    const result = run('INSERT INTO banks(name, description, owner_id, created_at) VALUES(?,?,?,?)',
      String(body.name).trim(), body.description || '', user.id, now())
    sendJson(res, 201, { ok: true, id: Number(result.lastInsertRowid) })
  })

  r.put('/api/banks/:id', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const bank = writableBank(user, params.id)
    if (!bank) fail(404, '题库不存在')
    const body = await readJson(req)
    run('UPDATE banks SET name = ?, description = ? WHERE id = ?', body.name ?? bank.name, body.description ?? bank.description, bank.id)
    sendJson(res, 200, { ok: true })
  })

  r.delete('/api/banks/:id', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const bank = ownedBank(user, params.id)
    if (!bank) fail(404, '题库不存在')
    run('UPDATE banks SET deleted_at = ? WHERE id = ?', now(), bank.id)
    log(user, '删除题库', `${bank.name} #${bank.id}`)
    sendJson(res, 200, { ok: true })
  })

  /* ---------------- 题库协作 ---------------- */
  /*
   * 「多人一起维护一个题库」这件事以前完全没有表达方式：题库只有 owner_id，
   * 团队要么共用一个管理员账号（审计日志里全是一个人），要么各建一个题库把题复制来复制去。
   * 现在引入协作者：editor 能增删改题与组卷，viewer 只能看和刷题。
   * 成员管理本身只有所有者能碰——把「谁能拉人」也放开，协作关系就自己长腿跑掉了。
   */
  const MEMBER_ROLES = ['editor', 'viewer']

  r.get('/api/banks/:id/members', async (req, res, { params }) => {
    const user = requireUser(req)
    const bank = readableBank(user, params.id)
    if (!bank) fail(404, '题库不存在')
    const owner = get('SELECT id, username, nickname, avatar FROM users WHERE id = ?', bank.owner_id)
    const rows = all(`SELECT m.user_id, m.role, m.created_at, u.username, u.nickname, u.avatar, d.name AS dept_name
      FROM bank_members m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN depts d ON d.id = u.dept_id
      WHERE m.bank_id = ? ORDER BY m.rowid ASC`, bank.id)
    const cnt = get(`SELECT COUNT(*) c FROM questions WHERE bank_id = ? AND deleted_at IS NULL`, bank.id).c
    const myRole = bankRole(user, bank)
    /*
     * 可邀请的人只发给所有者。协作者（哪怕是 editor）能看见这个名单，
     * 就等于看得见「全站还有哪些账号」—— 而账号清单是管理员信息，不是协作信息。
     */
    const candidates = myRole === 'owner' ? all(`SELECT u.id, u.username, u.nickname, u.avatar, d.name AS dept_name
      FROM users u LEFT JOIN depts d ON d.id = u.dept_id
      WHERE u.status = 1 AND u.id <> ?
        AND u.id NOT IN (SELECT user_id FROM bank_members WHERE bank_id = ?)
      ORDER BY u.id ASC`, bank.owner_id, bank.id) : []
    sendJson(res, 200, {
      ok: true,
      data: {
        bank: { id: bank.id, name: bank.name, owner_id: bank.owner_id, question_count: cnt },
        my_role: myRole,
        candidates,
        owner: owner || null,
        members: rows.map(m => ({
          user_id: m.user_id, role: m.role, created_at: m.created_at,
          username: m.username, nickname: m.nickname, avatar: m.avatar, dept_name: m.dept_name
        }))
      }
    })
  })

  r.post('/api/banks/:id/members', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const bank = ownedBank(user, params.id)
    if (!bank) fail(404, '题库不存在')
    const body = await readJson(req)
    const role = MEMBER_ROLES.includes(body.role) ? body.role : 'editor'
    // 账号或用户 id 都收：界面上是「输账号」，接口也允许直接给 id
    const target = body.userId
      ? get('SELECT id, username, nickname, status FROM users WHERE id = ?', Number(body.userId))
      : get('SELECT id, username, nickname, status FROM users WHERE username = ?', String(body.username || '').trim())
    if (!target) fail(404, '用户不存在')
    if (target.id === bank.owner_id) fail(400, '所有者本人不需要加入协作者')
    // 停用的账号拉进来等于给了一个「登录不上的人」的权限位，等它被启用那天自动生效
    if (target.status !== 1) fail(400, '该账号已被停用，无法加入协作')
    const exist = get('SELECT role FROM bank_members WHERE bank_id = ? AND user_id = ?', bank.id, target.id)
    if (exist) {
      if (exist.role === role) fail(400, `${target.nickname || target.username} 已经是该题库的协作者（${role === 'editor' ? '可编辑' : '只读'}）`)
      run('UPDATE bank_members SET role = ? WHERE bank_id = ? AND user_id = ?', role, bank.id, target.id)
      log(user, '调整题库协作者', `${bank.name} #${bank.id} → ${target.username} ${role}`)
      return sendJson(res, 200, { ok: true, updated: true, user_id: target.id, role })
    }
    run('INSERT INTO bank_members(bank_id, user_id, role, created_by, created_at) VALUES(?,?,?,?,?)',
      bank.id, target.id, role, user.id, now())
    log(user, '新增题库协作者', `${bank.name} #${bank.id} → ${target.username} ${role}`)
    sendJson(res, 201, { ok: true, user_id: target.id, role })
  })

  r.delete('/api/banks/:id/members/:userId', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const bank = ownedBank(user, params.id)
    if (!bank) fail(404, '题库不存在')
    const targetId = Number(params.userId)
    const row = get('SELECT * FROM bank_members WHERE bank_id = ? AND user_id = ?', bank.id, targetId)
    if (!row) fail(404, '该用户不是这个题库的协作者')
    run('DELETE FROM bank_members WHERE bank_id = ? AND user_id = ?', bank.id, targetId)
    const t = get('SELECT username FROM users WHERE id = ?', targetId)
    log(user, '移除题库协作者', `${bank.name} #${bank.id} → ${t?.username || targetId}`)
    sendJson(res, 200, { ok: true })
  })

  /** 可邀请的人：有题库写权限、账号启用、还没在这个题库里 */
  r.get('/api/banks/:id/members/candidates', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const bank = ownedBank(user, params.id)
    if (!bank) fail(404, '题库不存在')
    const rows = all(`SELECT u.id, u.username, u.nickname, u.avatar, d.name AS dept_name
      FROM users u LEFT JOIN depts d ON d.id = u.dept_id
      WHERE u.status = 1 AND u.id <> ?
        AND u.id NOT IN (SELECT user_id FROM bank_members WHERE bank_id = ?)
      ORDER BY u.id ASC`, bank.owner_id, bank.id)
    sendJson(res, 200, { ok: true, data: rows })
  })

  /** 回收中心：题库列表（含被删题库下的题目数） */
  r.get('/api/banks/recycle', async (req, res) => {
    const user = requireUser(req)
    const where = ['b.deleted_at IS NOT NULL']
    const args = []
    // 回收站里只回「自己删的」：协作者不该看见别人删掉、还可能被恢复的题库
    if (!can(user, '*')) { where.push('b.owner_id = ?'); args.push(user.id) }
    const rows = all(`SELECT b.*, (SELECT COUNT(*) FROM questions q WHERE q.bank_id = b.id AND q.deleted_at IS NULL) AS question_count
      FROM banks b WHERE ${where.join(' AND ')} ORDER BY b.id DESC`, ...args)
    sendJson(res, 200, { ok: true, data: rows })
  })

  /** 从回收站恢复题库（题目跟着回来，它们是软删除，一直都在） */
  r.post('/api/banks/:id/restore', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const bank = get('SELECT * FROM banks WHERE id = ?', Number(params.id))
    if (!bank) fail(404, '题库不存在')
    if (!can(user, '*') && bank.owner_id !== user.id) fail(403, '无权恢复')
    run('UPDATE banks SET deleted_at = NULL WHERE id = ?', bank.id)
    log(user, '恢复题库', `${bank.name} #${bank.id}`)
    sendJson(res, 200, { ok: true })
  })

  /** 回收中心：单独被删掉的题目 */
  r.get('/api/questions/recycle', async (req, res) => {
    const user = requireUser(req)
    const where = ['q.deleted_at IS NOT NULL', 'b.deleted_at IS NULL']
    const args = []
    if (!can(user, '*')) { where.push('b.owner_id = ?'); args.push(user.id) }
    const rows = all(`SELECT q.id, q.title, q.type, q.score, q.deleted_at, b.name AS bank_name
      FROM questions q JOIN banks b ON b.id = q.bank_id WHERE ${where.join(' AND ')} ORDER BY q.id DESC LIMIT 200`, ...args)
    sendJson(res, 200, { ok: true, data: rows })
  })

  r.post('/api/questions/:id/restore', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const q = get('SELECT * FROM questions WHERE id = ?', Number(params.id))
    if (!q) fail(404, '题目不存在')
    const bank = get('SELECT * FROM banks WHERE id = ?', q.bank_id)
    if (bank && bankRole(user, bank) !== 'owner') fail(403, '无权恢复')
    if (bank?.deleted_at) fail(400, '题目所属题库还在回收站里，请先恢复题库')
    run('UPDATE questions SET deleted_at = NULL WHERE id = ?', q.id)
    log(user, '恢复题目', `#${q.id} ${q.title}`)
    sendJson(res, 200, { ok: true })
  })

  /** 彻底删除题库：连题目一起，删掉就是删掉 */
  r.delete('/api/banks/:id/purge', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const bank = get('SELECT * FROM banks WHERE id = ?', Number(params.id))
    if (!bank) fail(404, '题库不存在')
    if (bankRole(user, bank) !== 'owner') fail(403, '只有题库所有者可以彻底删除')
    if (!bank.deleted_at) fail(400, '请先把题库移入回收中心，再彻底删除')
    const count = get('SELECT COUNT(*) c FROM questions WHERE bank_id = ?', bank.id).c
    run('DELETE FROM questions WHERE bank_id = ?', bank.id)
    run('DELETE FROM banks WHERE id = ?', bank.id)
    log(user, '彻底删除题库', `${bank.name} #${bank.id}（含 ${count} 道题）`)
    sendJson(res, 200, { ok: true, questions: count })
  })

  r.get('/api/banks/:id/questions', async (req, res, { params }) => {
    const user = requireUser(req)
    const bank = readableBank(user, params.id)
    if (!bank) fail(404, '题库不存在')
    const url = new URL(req.url, 'http://x')
    const keyword = url.searchParams.get('keyword')
    const type = url.searchParams.get('type')
    const where = ['bank_id = ?', 'deleted_at IS NULL']
    const args = [bank.id]
    // 搜「网络」时，题干里没有这两个字、但标签写了的题也该出来
    if (keyword) { where.push('(title LIKE ? OR tags LIKE ?)'); args.push(`%${keyword}%`, `%${keyword}%`) }
    if (type) { where.push('type = ?'); args.push(type) }
    // 标签筛选按整词匹配：`LIKE %基础%` 会让「基础」命中「计算机基础」
    const tag = url.searchParams.get('tag')
    if (tag) { where.push("(',' || tags || ',') LIKE ?"); args.push(`%,${String(tag).trim()},%`) }
    const rows = all(`SELECT * FROM questions WHERE ${where.join(' AND ')} ORDER BY id ASC`, ...args).map(parseQ)
    /*
     * 只读协作者看题是为了刷题和了解题库内容，把标准答案一起发下去，
     * 这一屏的每一道题就都提前剧透了——「只读」也就失去了意义。
     * 所以对 viewer 把答案与解析摘掉（练习接口本来就不下发答案，两边口径一致）。
     */
    if (bankRole(user, bank) === 'viewer') {
      return sendJson(res, 200, {
        ok: true,
        redacted: true,
        data: rows.map(q => ({ ...q, answer: [], analysis: '' })),
        total: rows.length
      })
    }
    sendJson(res, 200, { ok: true, data: rows, total: rows.length })
  })

  /*
   * 往题库里写题也要看题库归属。之前只查「题目存在」，于是任何登录用户
   * 拿着别人的题库 id 就能往里塞题、改题、删题 —— 实测把管理员题库的题删干净了，
   * 而写接口比读接口更该守门：读丢的是信息，写丢的是数据。
   */
  r.post('/api/banks/:id/questions', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const bank = writableBank(user, params.id)
    if (!bank) fail(404, '题库不存在')
    const body = await readJson(req)
    const items = Array.isArray(body.items) ? body.items : [body]
    const ids = []
    for (const item of items) {
      const f = normalizeField(item)
      if (!f.label) continue
      coerceAnswerToField(f)
      // 标签：item 自己的优先，请求体上的当默认值。
      // 之前只读 body.tags，批量传 items 时每条自带的标签被整批丢掉。
      const tags = normalizeTags(item.tags ?? item.tag ?? body.tags ?? '')
      // 分值：`f.score || 5` 会把用户明说的「不计分」写成 5 分，
      // 组卷时它就变成计分题，答错直接扣分
      const score = item.score === undefined || item.score === '' ? 5 : Math.max(0, Number(f.score) || 0)
      const result = run('INSERT INTO questions(bank_id, type, title, options, answer, analysis, score, tags, props, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        bank.id, f.type, f.label, JSON.stringify(f.options), JSON.stringify(f.answer), f.analysis, score, tags, JSON.stringify(f.props || {}), now())
      ids.push(Number(result.lastInsertRowid))
    }
    sendJson(res, 201, { ok: true, ids })
  })

  r.put('/api/questions/:id', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const q = get('SELECT * FROM questions WHERE id = ? AND deleted_at IS NULL', Number(params.id))
    if (!q) fail(404, '题目不存在')
    if (!writableBank(user, q.bank_id)) fail(403, '无权修改该题目')
    const body = await readJson(req)
    const f = normalizeField({ ...parseQ(q), ...body })
    coerceAnswerToField(f)
    const tags = body.tags === undefined ? q.tags : normalizeTags(body.tags)
    run('UPDATE questions SET type = ?, title = ?, options = ?, answer = ?, analysis = ?, score = ?, tags = ?, props = ? WHERE id = ?',
      f.type, f.label, JSON.stringify(f.options), JSON.stringify(f.answer), f.analysis, f.score, tags, JSON.stringify(f.props || {}), q.id)
    sendJson(res, 200, { ok: true })
  })

  r.delete('/api/questions/:id', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const q = get('SELECT * FROM questions WHERE id = ?', Number(params.id))
    if (!q) fail(404, '题目不存在')
    if (!writableBank(user, q.bank_id)) fail(403, '无权删除该题目')
    run('UPDATE questions SET deleted_at = ? WHERE id = ?', now(), q.id)
    sendJson(res, 200, { ok: true })
  })

  /** 批量导入题目（文本） */
  r.post('/api/banks/:id/import-text', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const bank = writableBank(user, params.id)
    if (!bank) fail(404, '题库不存在')
    const { text } = await readJson(req)
    // 题库导入的默认分值不能是 0：recalculate 里 `f.score || 5` 会把 0 变成 5，
    // 而「分值：0」是用户明说的「这题不计分」，不是没填
    const fields = parseTextToFields(String(text || ''), { defaultScore: 5 })
    if (!fields.length) fail(400, '未识别到题目')
    const dropped = []
    for (const f of fields) {
      // 解析阶段就已经剔除掉的越界答案（「答案：D」但只有 A/B/C）要带出来，
      // 否则接口一脸成功，用户以为答案写进去了
      if (f.dropped?.length) dropped.push(`${f.label}（${f.dropped.join('、')} 不存在）`)
      // 选择题的答案必须是已有选项，否则会变成永远答不对的题
      if (f.answer.length && f.options.length) {
        const values = new Set(f.options.map(o => String(o.value)))
        const kept = f.answer.filter(a => values.has(String(a)))
        if (kept.length !== f.answer.length) dropped.push(f.label)
        f.answer = kept
      }
      coerceAnswerToField(f)
      // 「分值：0」是用户明说的「这题不计分」，nullish 兜底不能写成 `|| 5`
      const score = f.score ?? 5
      run('INSERT INTO questions(bank_id, type, title, options, answer, analysis, score, tags, props, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        bank.id, f.type, f.label, JSON.stringify(f.options), JSON.stringify(f.answer), f.analysis, score, normalizeTags(f.tags || ''), JSON.stringify(f.props || {}), now())
    }
    sendJson(res, 200, { ok: true, imported: fields.length, droppedAnswers: dropped })
  })

  /** 题库导入模板：给用户一张照着改的表，比让人对着文档猜列名现实得多 */
  r.get('/api/banks/template.xlsx', async (req, res) => {
    requireUser(req)
    const buf = templateXlsx()
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="eqs-bank-template.xlsx"; filename*=UTF-8''${encodeURIComponent('EQS 题库导入模板.xlsx')}`,
      'Content-Length': buf.length
    })
    res.end(buf)
  })

  /** 题库导出为 xlsx：改完可以直接再导回来，形成「导出→批量改→导入」的闭环 */
  r.get('/api/banks/:id/export.xlsx', async (req, res, { params }) => {
    const user = requireUser(req)
    const bank = readableBank(user, params.id)
    if (!bank) fail(404, '题库不存在')
    // 导出的表带答案和解析：只读协作者能导出，等于刚才那层答案隐藏白做了
    if (bankRole(user, bank) === 'viewer') fail(403, '只读协作者不能导出题库（导出文件包含全部标准答案）')
    const questions = all('SELECT * FROM questions WHERE bank_id = ? AND deleted_at IS NULL ORDER BY id ASC', bank.id).map(parseQ)
    const buf = questionsXlsx(questions, bank.name)
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="bank-${bank.id}.xlsx"; filename*=UTF-8''${encodeURIComponent(bank.name + '.xlsx')}`,
      'Content-Length': buf.length
    })
    res.end(buf)
  })

  /** Excel 批量导入题目 */
  r.post('/api/banks/:id/import-xlsx', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const bank = writableBank(user, params.id)
    if (!bank) fail(404, '题库不存在')
    const buf = await readXlsxUpload(req)
    if (!buf?.length) fail(400, '请上传 xlsx 文件')
    const rows = parseXlsx(buf)
    if (!rows) fail(400, '无法读取该文件，请上传 .xlsx 格式的表格（.xls / .csv 请先另存为 xlsx）')
    if (!rows.length) fail(400, '表格是空的')
    const { fields, skipped, unknownColumns } = rowsToFields(rows)
    if (!fields.length) fail(400, '未识别到题目：表格需要有「题干」列，或按 题型/题干/选项/答案/分值/解析 的顺序排')
    let imported = 0
    const droppedAnswers = []
    for (const f of fields) {
      if (f.dropped?.length) droppedAnswers.push(`${f.label}（${f.dropped.join('、')}）`)
      delete f.dropped
      run('INSERT INTO questions(bank_id, type, title, options, answer, analysis, score, tags, props, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        bank.id, f.type, f.label, JSON.stringify(f.options), JSON.stringify(f.answer), f.analysis, f.score ?? 0, normalizeTags(f.tags || ''), JSON.stringify(f.props || {}), now())
      imported++
    }
    log(user, 'Excel 导入题目', `${bank.name} #${bank.id} → ${imported} 道`)
    sendJson(res, 200, { ok: true, imported, skipped, droppedAnswers, unknownColumns })
  })

  /** 组卷：按题库随机抽题生成考试 */
  r.post('/api/banks/:id/paper', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const bank = writableBank(user, params.id)
    if (!bank) fail(404, '题库不存在')
    const body = await readJson(req)
    const count = Math.max(1, Math.min(200, Number(body.count) || 10))
    const rows = pickQuestions(bank.id, body, count).map(parseQ)
    if (!rows.length) fail(400, '题库中没有题目')
    const schema = rows.map(q => {
      // 题库认「正确答案：A」「正确」，卷面上的多选认 ['选项值']、判断认「正确/错误」。
      // 直接把题库里的答案搬进卷面，会出现「卷面显示作答 A 却判 0 分」——所以入库前统一口径。
      const f = normalizeField({
        type: q.type, label: q.title, options: q.options, answer: q.answer,
        analysis: q.analysis, score: q.score,
        // 矩阵的行、评分的上限、子表单的字段都在 props 里：不带过来，
        // 卷面上的矩阵题只剩余项、没有行，答题框根本渲染不出来
        props: q.props
      })
      if (!f.answer.length && q.answer?.length) f.answer = q.answer
      coerceAnswerToField(f)
      return f
    })
    const ts = now()
    const settings = {
      // 与多题库组卷同口径：及格线是百分比，超过 100 就永远不及格
      passPercent: clampPercent(body.passPercent),
      duration: Math.max(0, Number(body.duration) || 0)
    }
    const result = run('INSERT INTO forms(title, description, kind, schema, settings, status, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      String(body.title || `${bank.name} - 试卷`).slice(0, 200), body.description || '由题库智能组卷生成', 'exam', JSON.stringify(schema),
      JSON.stringify(settings), 'draft', user.id, ts, ts)
    sendJson(res, 201, { ok: true, id: Number(result.lastInsertRowid), count: schema.length, settings })
  })

  /** 跨题库组卷：多个题库按比例抽题，或全库随机 */
  r.post('/api/banks/paper', async (req, res) => {
    const user = requirePerm(req, 'bank:write')
    const body = await readJson(req)
    const count = Math.max(1, Math.min(200, Number(body.count) || 10))
    const visPaper = visibleBankWhere(user)
    // 只读协作者的题库能抽题吗：不能。组卷产出的是自己的新表单，但用的是别人的题，
    // 而只读身份的含义就是「不参与生产」
    const allVisible = all(`SELECT b.* FROM banks b WHERE b.deleted_at IS NULL${visPaper.sql}`, ...visPaper.args)
    const visible = allVisible.filter(b => bankRole(user, b) !== 'viewer')
    // 只有只读题库时给一句能看懂的话：默认的「没有可用的题库」会让人以为题库被删了
    if (!visible.length && allVisible.length) fail(400, '你参与的题库都是「只读」身份，组卷需要可编辑权限')
    const byId = new Map(visible.map(b => [b.id, b]))
    // 指定了题库就只在指定范围内抽，没指定就全库
    let ids = Array.isArray(body.bankIds) ? body.bankIds.map(Number).filter(id => byId.has(id)) : []
    // 显式指定了题库却一个都不可用，直接拒绝；不要偷偷退化成「全库抽题」
    if (Array.isArray(body.bankIds) && body.bankIds.length && !ids.length) fail(400, '所选题库不存在或无权访问')
    if (!ids.length) ids = visible.map(b => b.id)
    if (!ids.length) fail(400, '没有可用的题库')
    const marks = ids.map(() => '?').join(',')
    const pool = all(`SELECT * FROM questions WHERE deleted_at IS NULL AND bank_id IN (${marks})`, ...ids)
    if (!pool.length) fail(400, '所选题库中没有题目')
    let picked = pool
    const wantedTypes = (Array.isArray(body.types) ? body.types : body.typeFilter ? [body.typeFilter] : []).filter(Boolean)
    if (wantedTypes.length) {
      const tf = pool.filter(q => wantedTypes.includes(q.type))
      // 选了题型却一道都没有：静默退回全库抽题，用户拿到的是「明明筛了单选，卷子里却有简答」
      if (!tf.length) fail(400, `所选题库中没有「${wantedTypes.map(t => typeLabelOf(t)).join(' / ')}」类型的题目`)
      picked = tf
    }
    // 按比例均衡抽题：先打乱再轮转各题库取，避免题目多的题库把卷子占满
    picked = picked.sort(() => Math.random() - 0.5)
    if (picked.length > count) {
      const buckets = new Map()
      for (const q of picked) {
        if (!buckets.has(q.bank_id)) buckets.set(q.bank_id, [])
        buckets.get(q.bank_id).push(q)
      }
      const lists = [...buckets.values()]
      const out = []
      while (out.length < count && lists.some(l => l.length)) {
        for (const l of lists) {
          if (out.length >= count) break
          if (l.length) out.push(l.shift())
        }
      }
      picked = out
    }
    const schema = picked.map(q => {
      const p = parseQ(q)
      const f = normalizeField({ type: p.type, label: p.title, options: p.options, answer: p.answer, analysis: p.analysis, score: p.score, props: p.props })
      if (!f.answer.length && p.answer?.length) f.answer = p.answer
      coerceAnswerToField(f)
      return f
    })
    const settings = {
      passPercent: clampPercent(body.passPercent),
      duration: Math.max(0, Number(body.duration) || 0)
    }
    const ts = now()
    const usedBanks = [...new Set(picked.map(q => byId.get(q.bank_id)?.name).filter(Boolean))]
    const result = run('INSERT INTO forms(title, description, kind, schema, settings, status, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      String(body.title || '智能组卷').slice(0, 200),
      body.description || `从 ${usedBanks.length} 个题库随机抽取生成`,
      'exam', JSON.stringify(schema), JSON.stringify(settings), 'draft', user.id, ts, ts)
    sendJson(res, 201, {
      ok: true,
      id: Number(result.lastInsertRowid),
      count: schema.length,
      banks: usedBanks,
      total: picked.reduce((a, q) => a + (Number(q.score) || 0), 0),
      settings
    })
  })


/** 题库里还能用的、刷题时真正会被抽到的题目 id（题目被删后，记录里的脏 id 会让「错题 N」虚高） */
function practicePool(bankId) {
  return new Set(all('SELECT id FROM questions WHERE bank_id = ? AND deleted_at IS NULL', bankId).map(r => Number(r.id)))
}

/** 记录里只留当前题库真实存在的题目，顺便去重去脏 */
function cleanIds(raw, pool) {
  const set = new Set()
  for (const v of Array.isArray(raw) ? raw : []) {
    const n = Number(v)
    if (Number.isFinite(n) && pool.has(n)) set.add(n)
  }
  return set
}

  /** 刷题：拉取题目（不返回答案） */
  r.get('/api/banks/:id/practice', async (req, res, { params }) => {
    const user = requireUser(req)
    const bank = readableBank(user, params.id)
    if (!bank) fail(404, '题库不存在')
    const url = new URL(req.url, 'http://x')
    const mode = url.searchParams.get('mode') || 'sequence'
    const rows = all('SELECT * FROM questions WHERE bank_id = ? AND deleted_at IS NULL ORDER BY id ASC', bank.id).map(parseQ)
    if (!rows.length) fail(400, '题库暂无题目')
    const record = get('SELECT * FROM practice_records WHERE bank_id = ? AND user_id = ?', bank.id, user.id)
    const pool = practicePool(bank.id)
    const wrongIds = cleanIds(record ? safeJson(record.wrong_ids, []) : [], pool)
    const favoriteIds = cleanIds(record ? safeJson(record.favorite_ids, []) : [], pool)
    const notes = record ? safeJson(record.notes, {}) : {}
    let list = rows
    if (mode === 'random') list = [...rows].sort(() => Math.random() - 0.5)
    if (mode === 'wrong') list = rows.filter(q => wrongIds.has(Number(q.id)))
    if (mode === 'favorite') list = rows.filter(q => favoriteIds.has(Number(q.id)))
    // 进度停在题库末尾时，错题/收藏模式不能直接给出空列表，否则「错题 1」点进去一片空白
    const rawProgress = Number(record?.progress) || 0
    const resumeAt = rawProgress < list.length ? rawProgress : 0
    /*
     * 组件的结构性属性要一起下发，否则刷题页渲染不出题：
     * 矩阵题的行在 props.rows，评分的上限在 props.max，子表单的字段在 props.fields。
     * 但 props 是用户自由填的，标准答案可能被塞在任何自定义键里——所以走白名单，不是整个吐出去。
     */
    const PLAY_PROPS = ['rows', 'max', 'min', 'step', 'fields', 'multiple', 'maxSize', 'accept', 'minLength', 'maxLength', 'unit', 'precision', 'labels']
    const playProps = (p) => {
      const src = p && typeof p === 'object' ? p : {}
      const out = {}
      for (const k of PLAY_PROPS) if (src[k] !== undefined) out[k] = src[k]
      return out
    }
    const safeList = list.map(q => ({
      id: q.id, type: q.type, title: q.title, options: q.options, analysis: '',
      props: playProps(q.props),
      score: q.score, favorite: favoriteIds.has(Number(q.id)), note: notes[q.id] || ''
    }))
    sendJson(res, 200, {
      ok: true,
      data: {
        bank: { id: bank.id, name: bank.name }, mode, questions: safeList,
        resumeAt,
        progress: record?.progress || 0,
        wrongCount: wrongIds.size,
        favoriteCount: favoriteIds.size
      }
    })
  })

  /** 刷题判题 + 记录进度 */
  r.post('/api/banks/:id/practice/answer', async (req, res, { params }) => {
    const user = requireUser(req)
    const bank = readableBank(user, params.id)
    if (!bank) fail(404, '题库不存在')
    const body = await readJson(req)
    const q = get('SELECT * FROM questions WHERE id = ? AND bank_id = ? AND deleted_at IS NULL', Number(body.questionId), bank.id)
    if (!q) fail(404, '题目不存在')
    const parsed = parseQ(q)
    // 只有真的提交了答案才判题；收藏 / 写笔记不应把题目算成答错
    const judging = body.judge === true || Array.isArray(body.value) || (typeof body.value === 'string' && body.value.trim() !== '')
    /*
     * 手写的作答可能直接给选项字母（A/B/…）。只对「按字母选」的题型映射：
     * 排序题的值是顺序、矩阵题是对象，逐个字母映射会把它们拆成一堆无意义的字符串。
     */
    const LETTER_TYPES = new Set(['radio', 'checkbox', 'select', 'carousel', 'cascader'])
    const toValue = (v) => {
      if (!LETTER_TYPES.has(parsed.type)) return v
      const tok = String(v).trim()
      if (!/^[A-Za-z]$/.test(tok)) return v
      const opt = parsed.options[tok.toUpperCase().charCodeAt(0) - 65]
      return opt ? String(opt.value) : v
    }
    const givenValue = Array.isArray(body.value) ? body.value.map(toValue) : toValue(body.value)
    /*
     * 判分只在 lib/forms.js 里维护一份口径。
     * 之前这里是自己写的「sort 一下数组再逐位比」，于是：
     *  - 排序题怎么排都算对（比的是集合，顺序根本不在比的范围里）；
     *  - 矩阵题的作答是 {行: 列}，被 String 成 [object Object]，全对也判错。
     * 传整个题目对象进去，题型 / 选项 / 矩阵行它自己会看。
     */
    const correct = judging && isAnswerCorrect(parsed, givenValue)
    let record = get('SELECT * FROM practice_records WHERE bank_id = ? AND user_id = ?', bank.id, user.id)
    if (!record) {
      run('INSERT INTO practice_records(bank_id, user_id, mode, progress, right_ids, wrong_ids, favorite_ids, notes, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        bank.id, user.id, 'sequence', 0, '[]', '[]', '[]', '{}', now())
      record = get('SELECT * FROM practice_records WHERE bank_id = ? AND user_id = ?', bank.id, user.id)
    }
    const pool = practicePool(bank.id)
    const rightIds = cleanIds(safeJson(record.right_ids, []), pool)
    const wrongIds = cleanIds(safeJson(record.wrong_ids, []), pool)
    const streak = safeJson(record.notes, {}).__streak || {}
    const req2 = Number(body.streakToClear) || 0
    if (!judging) {
      // 仅收藏 / 笔记：不动对错记录
    } else if (correct) {
      rightIds.add(q.id)
      const s = (streak[q.id] || 0) + 1
      streak[q.id] = s
      if (wrongIds.has(q.id) && (!req2 || s >= req2)) wrongIds.delete(q.id)
    } else {
      wrongIds.add(q.id)
      streak[q.id] = 0
      rightIds.delete(q.id)
    }
    const notes = safeJson(record.notes, {})
    notes.__streak = streak
    if (body.note !== undefined) notes[q.id] = String(body.note)
    const favoriteIds = new Set(safeJson(record.favorite_ids, []))
    if (body.favorite === true) favoriteIds.add(q.id)
    if (body.favorite === false) favoriteIds.delete(q.id)
    const progress = Math.max(Number(record.progress) || 0, Number(body.progress) || 0)
    run('UPDATE practice_records SET right_ids = ?, wrong_ids = ?, favorite_ids = ?, notes = ?, progress = ?, mode = ?, updated_at = ? WHERE id = ?',
      JSON.stringify([...rightIds]), JSON.stringify([...wrongIds]), JSON.stringify([...favoriteIds]), JSON.stringify(notes), progress, body.mode || record.mode, now(), record.id)
    sendJson(res, 200, {
      ok: true,
      correct: judging ? correct : null,
      judged: judging,
      answer: parsed.answer,
      // 人能读的版本：矩阵答案是逐行的、排序答案带顺序，直接 join 出来是「5, 5」
      answerText: answerText(parsed, parsed.answer),
      analysis: parsed.analysis,
      wrongCount: wrongIds.size,
      favorite: favoriteIds.has(q.id)
    })
  })

  r.get('/api/banks/:id/progress', async (req, res, { params }) => {
    const user = requireUser(req)
    if (!readableBank(user, params.id)) fail(404, '题库不存在')
    const record = get('SELECT * FROM practice_records WHERE bank_id = ? AND user_id = ?', Number(params.id), user.id)
    if (!record) return sendJson(res, 200, { ok: true, data: null })
    const notes = safeJson(record.notes, {})
    sendJson(res, 200, {
      ok: true,
      data: {
        progress: record.progress,
        right: safeJson(record.right_ids, []).length,
        wrong: cleanIds(safeJson(record.wrong_ids, []), practicePool(Number(params.id))).size,
        favorite: cleanIds(safeJson(record.favorite_ids, []), practicePool(Number(params.id))).size,
        notes: Object.fromEntries(Object.entries(notes).filter(([k]) => k !== '__streak'))
      }
    })
  })
}
