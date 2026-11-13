import crypto from 'node:crypto'
import { get, all, run, now, log } from '../lib/db.js'
import { readJson, fail, sendJson, clientIp } from '../lib/http.js'
import { requireUser, requirePerm, currentUser, can } from '../lib/auth.js'
import { pickForm, validateSubmission, gradeSubmission, computeStats, submissionData, paginate, fieldVisible, passLineOf, manualScoresOf, passHintOf, captchaChallenge, safeJson } from '../lib/forms.js'

/** 对外答卷编号：不可猜、无业务含义，只给提交者本人用 */
export function newPublicId() {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz'
  const bytes = crypto.randomBytes(10)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out.slice(0, 5) + '-' + out.slice(5, 10)
}

/** 编号查询：只认不可猜的 public_id；老数据没有 public_id 时才回退到自增 id */
function findSubmission(formId, raw) {
  const key = String(raw || '').trim()
  if (!key) return null
  const byPublic = get('SELECT * FROM submissions WHERE public_id = ? AND form_id = ? AND deleted_at IS NULL', key, Number(formId))
  if (byPublic) return byPublic
  if (/^\d+$/.test(key)) {
    return get('SELECT * FROM submissions WHERE id = ? AND form_id = ? AND deleted_at IS NULL AND public_id IS NULL', Number(key), Number(formId))
  }
  return null
}

const flatAnswer = v => (Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === '' ? [] : [String(v)])
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i])
import { notifySubmission, dispatchWebhooks } from '../lib/notify.js'

function fingerprint(req, extra = {}) {
  return {
    ip: clientIp(req),
    device: String(req.headers['user-agent'] || '').slice(0, 200),
    openid: extra.openid || '',
    userId: extra.userId || 0
  }
}

/** 从答卷数据里收集附件 id（upload/file 组件的值是 {id,name,url} 数组或单个对象） */
function collectFileIds(data) {
  const ids = new Set()
  const visit = (v) => {
    if (Array.isArray(v)) return v.forEach(visit)
    if (v && typeof v === 'object') {
      if (Number(v.id) > 0 && v.url) ids.add(Number(v.id))
      for (const x of Object.values(v)) visit(x)
    }
  }
  visit(data)
  return [...ids]
}

/**
 * 只保留当前可见题目的作答。
 * 显隐逻辑要求「隐藏的题不校验必填」，但它的值还留在 data 里，于是：
 * 用户先选了 A（显示追问）再改回 B（追问隐藏），那份残留作答照样入库、照样进报表。
 */
export function pickVisibleAnswers(schema, raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  for (const f of schema) {
    if (!fieldVisible(f, src)) continue
    if (src[f.id] !== undefined) out[f.id] = src[f.id]
  }
  return out
}

/** 校验答题限制：微信/账号/IP/设备/次数/时间窗口 */
export function checkLimit(form, req, extra = {}) {
  const s = form.settings || {}
  const fp = fingerprint(req, extra)
  const limit = s.limit || {}
  const where = ['form_id = ?', 'deleted_at IS NULL']
  const args = [form.id]
  if (limit.perWechat && fp.openid) { where.push('openid = ?'); args.push(fp.openid) }
  if (limit.perIp) { where.push('ip = ?'); args.push(fp.ip) }
  if (limit.perDevice) { where.push('device = ?'); args.push(fp.device) }
  if (limit.perUser && fp.userId) { where.push('user_id = ?'); args.push(fp.userId) }
  const max = Number(limit.maxTimes || 0)
  if (max > 0) {
    const used = get(`SELECT COUNT(*) c FROM submissions WHERE ${where.join(' AND ')}`, ...args).c
    if (used >= max) fail(429, `该${limit.perIp && !fp.openid ? 'IP' : '账号'}已提交 ${used} 次，达到上限`)
  }
  const time = s.timeWindow
  if (time?.start || time?.end) {
    const ts = Date.now()
    if (time.start && ts < new Date(time.start).getTime()) fail(403, '问卷尚未开始')
    if (time.end && ts > new Date(time.end).getTime()) fail(403, '问卷已结束')
  }
  if (s.needPassword) {
    const given = extra.password || ''
    if (String(given) !== String(s.password || '')) fail(403, '访问密码错误')
  }
  if (Array.isArray(s.whitelist) && s.whitelist.length) {
    const list = s.whitelist.map(x => String(x).trim()).filter(Boolean)
    const hit = [extra.userId ? String(extra.userId) : '', fp.openid, fp.ip, extra.phone || ''].filter(Boolean)
    if (!hit.some(v => list.includes(String(v)))) fail(403, '不在白名单内，无法填写')
  }
  if (s.onlyWechat) {
    const ua = String(req.headers['user-agent'] || '')
    if (!/MicroMessenger/i.test(ua)) fail(403, '请在微信中打开此问卷')
  }
  return fp
}

/** 验证码是防机器人的，不是题目；哪怕误填了分值也不该进阅卷队列 */
const NO_GRADE_TYPES = new Set(['captcha', 'divider', 'richtext', 'html', 'image'])

/** 需要人工给分的题：有分值、无标准答案、不是说明类组件 */
export function isSubjective(f) {
  return Number(f?.score) > 0 && !(f?.answer?.length) && !NO_GRADE_TYPES.has(f?.type)
}

/**
 * 这份答卷还剩几道主观题没给分。
 * 与 gradeSubmission 同口径：有分值、无标准答案、当前可见、且没出现在 manual_scores 里。
 */
export function pendingLeft(form, row) {
  if (!form || form.kind !== 'exam') return 0
  const data = safeJson(row.data, {})
  const manual = manualScoresOf(row)
  // 直接查库拿到的是未解析的行，schema 还是 JSON 字符串
  const schema = Array.isArray(form.schema) ? form.schema : safeJson(form.schema, [])
  return schema.filter(f =>
    isSubjective(f) && fieldVisible(f, data) && !Object.prototype.hasOwnProperty.call(manual, f.id)
  ).length
}

/** 列表/详情统一带上人工分，前端不用再 parse 一次 */
function withManual(row) {
  return { ...submissionData(row), manual_scores: manualScoresOf(row) }
}

export default function register(r) {
  /** 公开：读取表单（不含答案） */
  r.get('/api/public/forms/:id', async (req, res, { params }) => {
    const form = pickForm(params.id)
    if (!form) fail(404, '表单不存在或已删除')
    if (form.status !== 'published') fail(403, '表单未发布')
    // 验证码的题面（a + b）必须在这里下发：之前只清空 answer，前端算不出题面，
    // 唯一能对照的答案又被清空了，只能去后台表单详情里翻——验证码整体不可用
    const schema = form.schema.map(f => {
      // 白名单而不是「删掉 answer」：标准答案能藏在任何自定义属性里，
      // 例如 props.answers，删掉顶层 answer 之后它照样下发到浏览器。
      const out = {
        id: f.id, type: f.type, label: f.label, required: f.required,
        placeholder: f.placeholder, description: f.description, options: f.options,
        defaultValue: f.defaultValue, logic: f.logic, props: publicFieldProps(f)
      }
      if (f.type === 'captcha') out.challenge = captchaChallenge(f.id)
      return out
    })
    sendJson(res, 200, {
      ok: true,
      data: {
        id: form.id, title: form.title, description: form.description, kind: form.kind,
        schema, settings: publicSettings(form.settings)
      }
    })
  })

  /** 公开：提交答卷 */
  r.post('/api/public/forms/:id/submit', async (req, res, { params }) => {
    const form = pickForm(params.id)
    if (!form) fail(404, '表单不存在')
    if (form.status !== 'published') fail(403, '表单未发布')
    const body = await readJson(req)
    const user = currentUser(req)
    const fp = checkLimit(form, req, {
      openid: body.openid || '',
      userId: user?.id || 0,
      password: body.password
    })
    const data = pickVisibleAnswers(form.schema, body.data)
    const errors = validateSubmission(form.schema, data)
    if (errors.length) fail(422, errors.join('；'))
    const ts = now()
    let score = null
    let passed = null
    if (form.kind === 'exam') {
      // 交卷那一刻还没有人工分，主观题只算卷面总分，不计入可判分总分
      const g = gradeSubmission(form.schema, data, form.settings)
      score = g.score
      passed = g.passed ? 1 : 0
    }
    const publicId = newPublicId()
    const result = run(`INSERT INTO submissions(form_id, data, score, passed, duration, user_id, ip, device, openid, wx_nickname, wx_avatar, public_id, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      form.id, JSON.stringify(data), score, passed, Number(body.duration) || 0, user?.id || 0,
      fp.ip, fp.device, body.openid || '', body.wxNickname || '', body.wxAvatar || '', publicId, ts, ts)
    const id = Number(result.lastInsertRowid)
    // 附件是先上传后交卷的，交卷时把本次作答里引用到的文件认领到这份答卷上，
    // 否则「打包下载附件」会把它们漏掉。
    for (const fileId of collectFileIds(data)) {
      run('UPDATE files SET submission_id = ? WHERE id = ? AND submission_id = 0', id, fileId)
    }
    const submission = get('SELECT * FROM submissions WHERE id = ?', id)

    const review = form.kind === 'exam' && form.settings?.showResult !== false
      ? buildReview(form.schema, data, form.settings, {})
      : null

    sendJson(res, 201, {
      ok: true,
      id,
      publicId,
      score,
      total: form.kind === 'exam' ? review?.total ?? 0 : null,
      passLine: form.kind === 'exam' ? review?.passLine ?? 0 : null,
      paperTotal: form.kind === 'exam' ? review?.paperTotal ?? 0 : null,
      ungraded: form.kind === 'exam' ? review?.ungraded ?? 0 : 0,
      graded: form.kind === 'exam' ? !!review?.graded : false,
      passed: passed === 1,
      review,
      message: form.settings?.submitText || '提交成功，感谢您的参与！',
      redirect: form.settings?.redirectUrl || ''
    })

    // 异步通知，失败不影响提交
    Promise.resolve().then(async () => {
      try { await notifySubmission(form, submission) } catch {}
      try {
        await dispatchWebhooks('create', { formId: form.id, formTitle: form.title, submission: submissionData(submission) })
      } catch {}
    })
  })

  /** 交卷后逐题回顾：只返回对错、正确答案与解析，不回传用户原始作答之外的信息 */
  function buildReview(schema, data, settings = {}, manual = {}) {
    const items = []
    for (const f of schema) {
      if (['divider', 'richtext', 'html', 'image'].includes(f.type)) continue
      if (!fieldVisible(f, data)) continue
      const given = flatAnswer(data[f.id])
      const right = (f.answer || []).map(String)
      const auto = right.length > 0
      const correct = auto && sameSet(given, right)
      const manualGiven = manual?.[f.id]
      const hasManual = !auto && manualGiven !== undefined && manualGiven !== null && manualGiven !== ''
      const score = Number(f.score) || 0
      items.push({
        id: f.id,
        label: f.label,
        type: f.type,
        given,
        answer: right,
        judged: auto || hasManual,
        manual: hasManual,
        correct,
        score,
        got: auto ? (correct ? score : 0) : hasManual ? Math.min(score, Math.max(0, Number(manualGiven) || 0)) : 0,
        analysis: f.analysis || ''
      })
    }
    // 与 gradeSubmission 同一口径：自动判分题 + 已人工给分题才算进可判分总分
    const total = items.reduce((a, i) => a + (i.judged ? i.score : 0), 0)
    const paperTotal = items.reduce((a, i) => a + i.score, 0)
    return {
      items, total, paperTotal,
      ungraded: items.filter(i => !i.judged && i.score > 0).length,
      passLine: passLineOf(settings, total),
      hint: passHintOf(settings, total, paperTotal),
      graded: items.some(i => i.judged)
    }
  }

  /** 公开：按编号查询自己的答卷 */
  r.get('/api/public/forms/:id/query', async (req, res, { params }) => {
    const url = new URL(req.url, 'http://x')
    const id = url.searchParams.get('submissionId') || url.searchParams.get('code')
    if (!id) fail(400, '缺少答卷编号')
    const row = findSubmission(params.id, id)
    if (!row) fail(404, '答卷不存在或编号不正确')
    const form = pickForm(params.id)
    if (!form?.settings?.allowQuery) fail(403, '该问卷未开放查询')
    /*
     * 旧实现用自增 id 当编号，只能靠「同设备 / 同账号 / 同 IP」兜底——但同 IP 在 NAT 与代理后面
     * 等于没有（同一家公司、同一个学校出口都是同一个 IP），X-Forwarded-For 还能随手伪造，
     * 于是换个 UA 就能翻别人的答卷。现在编号本身不可猜，身份校验作为第二道闸保留。
     */
    const me = currentUser(req)
    const sameDevice = row.device && row.device === String(req.headers['user-agent'] || '').slice(0, 200)
    const sameUser = me?.id && row.user_id && Number(row.user_id) === Number(me.id)
    const sameOpenid = row.openid && row.openid === url.searchParams.get('openid')
    if (!sameDevice && !sameUser && !sameOpenid) fail(403, '只能查询本设备提交过的答卷')
    const review = form?.kind === 'exam' && form.settings?.showResult !== false
      ? buildReview(form.schema, JSON.parse(row.data), form.settings, manualScoresOf(row))
      : null
    sendJson(res, 200, {
      ok: true,
      data: {
        id: row.id, publicId: row.public_id || String(row.id), data: JSON.parse(row.data), score: row.score,
        passed: row.passed === 1, reviewed: !!row.reviewed_at, review, createdAt: row.created_at
      }
    })
  })

  /**
   * 回收中心·答卷。
   * 删除答卷的提示语一直写着「可在回收中心恢复」，但回收中心只列表单——
   * 手滑删掉一份答卷就再也找不回来，只能翻库。
   * 这里同时给出两类：自己躺进回收站的答卷，以及被删表单底下的答卷。
   */
  r.get('/api/recycle/submissions', async (req, res) => {
    const user = requirePerm(req, 'data:read')
    const own = can(user, '*') ? '' : ` AND f.created_by = ${user.id}`
    const self = all(`SELECT s.id, s.form_id, s.created_at, s.deleted_at, f.title AS form_title, f.deleted_at AS form_deleted_at
      FROM submissions s JOIN forms f ON f.id = s.form_id
      WHERE s.deleted_at IS NOT NULL AND f.deleted_at IS NULL${own} ORDER BY s.id DESC LIMIT 200`)
    const byForm = all(`SELECT s.id, s.form_id, s.created_at, NULL AS deleted_at, f.title AS form_title, f.deleted_at AS form_deleted_at
      FROM submissions s JOIN forms f ON f.id = s.form_id
      WHERE s.deleted_at IS NULL AND f.deleted_at IS NOT NULL${own} ORDER BY s.id DESC LIMIT 200`)
    sendJson(res, 200, { ok: true, data: { self, byForm } })
  })

  /** 管理端：答卷列表 */
  r.get('/api/submissions', async (req, res) => {
    const user = requirePerm(req, 'data:read')
    const url = new URL(req.url, 'http://x')
    // 表单进了回收站，它的答卷就不该还留在「答卷数据」列表里：
    // 之前只过滤答卷自己的 deleted_at，删掉的问卷底下 6 份答卷照样列出来、还能点开编辑。
    const where = ['s.deleted_at IS NULL', 'f.deleted_at IS NULL']
    const args = []
    // 有主观题（带分值、无标准答案）的考试表单；这些表单的答卷才需要过阅卷队列
    const pendingFormIds = all(`SELECT id, schema FROM forms WHERE kind = 'exam' AND deleted_at IS NULL`)
      .filter(f => safeJson(f.schema, []).some(isSubjective))
      .map(f => f.id)
    const formId = url.searchParams.get('formId')
    if (formId) { where.push('s.form_id = ?'); args.push(Number(formId)) }
    if (!can(user, '*')) { where.push('f.created_by = ?'); args.push(user.id) }
    const keyword = url.searchParams.get('keyword')
    if (keyword) { where.push('s.data LIKE ?'); args.push(`%${keyword}%`) }
    if (url.searchParams.get('marked') === '1') where.push('s.marked = 1')
    // 待批阅：考试答卷里还有主观题没给分
    if (url.searchParams.get('pending') === '1') {
      // 待批阅 = 这份卷子里确实还有主观题没给分，不是「没批过」就算；
      // 只含客观题的交卷不该堆进阅卷队列——队列一有噪音，老师就不看了。
      // 「还差几题没批」属于判分口径，和 gradeSubmission 一样放在 JS 里算：
      // 在 SQL 里拆 JSON 时，字段 id 的下划线在 LIKE 里是通配符，判据会静默出错。
      const finished = []
      for (const row of all('SELECT id, form_id, data, manual_scores FROM submissions WHERE deleted_at IS NULL')) {
        if (!pendingFormIds.includes(row.form_id)) continue
        if (pendingLeft(pickForm(row.form_id), row) === 0) finished.push(row.id)
      }
      if (finished.length) {
        where.push(`s.id NOT IN (${finished.map(() => '?').join(',')})`)
        args.push(...finished)
      }
      // 一张卷子要么留着等批、要么整张不在队列里：只收「有主观题」的表单
      where.push(`s.form_id IN (${pendingFormIds.length ? pendingFormIds.map(() => '?').join(',') : 'NULL'})`)
      args.push(...pendingFormIds)
    }
    if (url.searchParams.get('from')) { where.push('s.created_at >= ?'); args.push(url.searchParams.get('from')) }
    if (url.searchParams.get('to')) { where.push('s.created_at <= ?'); args.push(url.searchParams.get('to') + 'T23:59:59') }
    const base = `FROM submissions s JOIN forms f ON f.id = s.form_id WHERE ${where.join(' AND ')}`
    const total = get(`SELECT COUNT(*) c ${base}`, ...args).c
    const p = paginate(req, total)
    const order = url.searchParams.get('order') === 'asc' ? 'ASC' : 'DESC'
    const rows = all(`SELECT s.*, f.title AS form_title ${base} ORDER BY s.id ${order} LIMIT ? OFFSET ?`, ...args, p.pageSize, p.offset)
    sendJson(res, 200, { ok: true, data: rows.map(withManual), total, page: p.page, pageSize: p.pageSize, totalPages: p.totalPages })
  })

  r.get('/api/submissions/:id', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:read')
    const row = get('SELECT * FROM submissions WHERE id = ?', Number(params.id))
    if (!row) fail(404, '答卷不存在')
    const form = pickForm(row.form_id, { withDeleted: true })
    if (!can(user, '*') && form?.created_by !== user.id) fail(403, '无权查看')
    sendJson(res, 200, { ok: true, data: { ...withManual(row), form } })
  })

  r.post('/api/submissions', async (req, res) => {
    const user = requirePerm(req, 'data:write')
    const body = await readJson(req)
    const form = pickForm(body.formId)
    if (!form) fail(404, '表单不存在')
    const data = body.data || {}
    const errors = validateSubmission(form.schema, data)
    if (errors.length) fail(422, errors.join('；'))
    const ts = now()
    const g = form.kind === 'exam' ? gradeSubmission(form.schema, data, form.settings) : null
    const result = run(`INSERT INTO submissions(form_id, data, score, passed, user_id, ip, device, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      form.id, JSON.stringify(data), g?.score ?? null, g ? (g.passed ? 1 : 0) : null, user.id, clientIp(req), 'manual', ts, ts)
    log(user, '新增答卷', `#${result.lastInsertRowid} / ${form.title}`)
    const id = Number(result.lastInsertRowid)
    dispatchWebhooks('create', { formId: form.id, formTitle: form.title, submission: { id, data } }).catch(() => {})
    sendJson(res, 201, { ok: true, id })
  })

  r.put('/api/submissions/:id', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:write')
    const row = get('SELECT * FROM submissions WHERE id = ? AND deleted_at IS NULL', Number(params.id))
    if (!row) fail(404, '答卷不存在')
    const form = pickForm(row.form_id)
    if (!form) fail(404, '表单不存在')
    if (!can(user, '*') && form.created_by !== user.id) fail(403, '无权修改')
    const body = await readJson(req)
    const data = body.data ?? JSON.parse(row.data)
    const errors = validateSubmission(form.schema, data)
    if (errors.length) fail(422, errors.join('；'))
    const manual = manualScoresOf(row)
    const g = form.kind === 'exam' ? gradeSubmission(form.schema, data, form.settings, manual) : null
    const marked = body.marked === undefined ? row.marked : (body.marked ? 1 : 0)
    run('UPDATE submissions SET data = ?, score = ?, passed = ?, marked = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(data), g?.score ?? row.score, g ? (g.passed ? 1 : 0) : row.passed, marked, now(), row.id)
    log(user, '编辑答卷', `#${row.id}`)
    dispatchWebhooks('update', { formId: form.id, submission: { id: row.id, data } }).catch(() => {})
    sendJson(res, 200, { ok: true })
  })

  /**
   * 人工批阅：给主观题打分并重算成绩
   * body: { scores: { [fieldId]: 0..满分 }, note?: string }
   */
  r.put('/api/submissions/:id/review', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:write')
    const row = get('SELECT * FROM submissions WHERE id = ? AND deleted_at IS NULL', Number(params.id))
    if (!row) fail(404, '答卷不存在')
    const form = pickForm(row.form_id)
    if (!form) fail(404, '表单不存在')
    if (form.kind !== 'exam') fail(400, '只有考试答卷需要批阅')
    if (!can(user, '*') && form.created_by !== user.id) fail(403, '无权批阅')
    const body = await readJson(req)
    const data = JSON.parse(row.data)
    // 只认这份卷子里真有、且确实没有标准答案的题，防止给选择题凭空加分
    const subjective = new Map(form.schema.filter(f => isSubjective(f) && fieldVisible(f, data)).map(f => [f.id, f]))
    const scores = {}
    for (const [fid, raw] of Object.entries(body.scores || {})) {
      const f = subjective.get(fid)
      if (!f) continue
      if (raw === null || raw === undefined || raw === '') continue
      const n = Number(raw)
      if (!Number.isFinite(n)) fail(400, `「${f.label}」的分数不是数字`)
      if (n < 0 || n > f.score) fail(400, `「${f.label}」应在 0 - ${f.score} 分之间`)
      scores[fid] = Math.round(n * 100) / 100
    }
    const g = gradeSubmission(form.schema, data, form.settings, scores)
    run('UPDATE submissions SET manual_scores = ?, score = ?, passed = ?, reviewed_at = ?, reviewed_by = ?, review_note = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(scores), g.score, g.passed ? 1 : 0, now(), user.id, String(body.note ?? row.review_note ?? '').slice(0, 500), now(), row.id)
    log(user, '批阅答卷', `#${row.id} → ${g.score}/${g.total}`)
    const updated = get('SELECT * FROM submissions WHERE id = ?', row.id)
    dispatchWebhooks('update', { formId: form.id, formTitle: form.title, submission: withManual(updated) }).catch(() => {})
    sendJson(res, 200, { ok: true, data: { ...withManual(updated), review: buildReview(form.schema, data, form.settings, scores) } })
  })

  /** 从回收站恢复一份答卷 */
  r.post('/api/submissions/:id/restore', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:write')
    const row = get('SELECT * FROM submissions WHERE id = ?', Number(params.id))
    if (!row) fail(404, '答卷不存在')
    const form = pickForm(row.form_id, { withDeleted: true })
    if (!can(user, '*') && form?.created_by !== user.id) fail(403, '无权恢复')
    if (form?.deleted_at) fail(400, '该答卷所属的表单还在回收站里，请先恢复表单')
    run('UPDATE submissions SET deleted_at = NULL, updated_at = ? WHERE id = ?', now(), row.id)
    log(user, '恢复答卷', `#${row.id}`)
    sendJson(res, 200, { ok: true })
  })

  r.delete('/api/submissions/:id', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:write')
    const row = get('SELECT * FROM submissions WHERE id = ?', Number(params.id))
    if (!row) fail(404, '答卷不存在')
    const form = pickForm(row.form_id, { withDeleted: true })
    if (!can(user, '*') && form?.created_by !== user.id) fail(403, '无权删除')
    run('UPDATE submissions SET deleted_at = ? WHERE id = ?', now(), row.id)
    log(user, '删除答卷', `#${row.id}`)
    dispatchWebhooks('delete', { formId: row.form_id, submission: { id: row.id } }).catch(() => {})
    sendJson(res, 200, { ok: true })
  })

  r.post('/api/submissions/batch-delete', async (req, res) => {
    const user = requirePerm(req, 'data:write')
    const { ids } = await readJson(req)
    if (!Array.isArray(ids) || !ids.length) fail(400, '请选择答卷')
    const ts = now()
    let count = 0
    let skipped = 0
    for (const id of ids) {
      const row = get('SELECT * FROM submissions WHERE id = ? AND deleted_at IS NULL', Number(id))
      if (!row) { skipped++; continue }
      const form = pickForm(row.form_id, { withDeleted: true })
      if (!can(user, '*') && form?.created_by !== user.id) { skipped++; continue }
      run('UPDATE submissions SET deleted_at = ? WHERE id = ?', ts, row.id)
      count++
    }
    // 之前一律回报「已删除 N 份」，其中不存在的 id、无权的答卷都没删掉，用户以为清干净了
    sendJson(res, 200, { ok: true, count, skipped })
  })



  /** 报表统计 */
  r.get('/api/forms/:id/report', async (req, res, { params }) => {
    const user = requirePerm(req, 'report:read')
    const form = pickForm(params.id)
    if (!form) fail(404, '表单不存在')
    if (!can(user, '*') && form.created_by !== user.id) fail(403, '无权查看报表')
    const rows = all('SELECT * FROM submissions WHERE form_id = ? AND deleted_at IS NULL ORDER BY id DESC', form.id)
    const stats = computeStats(form, rows.map(submissionData))
    sendJson(res, 200, { ok: true, data: { form: { id: form.id, title: form.title, kind: form.kind }, ...stats } })
  })

  /** 导入答卷（JSON 数组） */
  r.post('/api/forms/:id/import', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:write')
    const form = pickForm(params.id)
    if (!form) fail(404, '表单不存在')
    const body = await readJson(req)
    const list = Array.isArray(body.items) ? body.items : []
    if (!list.length) fail(400, '没有可导入的数据')
    let ok = 0, skipped = 0
    const ts = now()
    for (const item of list) {
      const data = item.data || item
      if (validateSubmission(form.schema, data).length) { skipped++; continue }
      const g = form.kind === 'exam' ? gradeSubmission(form.schema, data, form.settings) : null
      run('INSERT INTO submissions(form_id, data, score, passed, user_id, ip, device, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        form.id, JSON.stringify(data), g?.score ?? null, g ? (g.passed ? 1 : 0) : null, user.id, 'import', 'import', ts, ts)
      ok++
    }
    sendJson(res, 200, { ok: true, imported: ok, skipped })
  })
}

/** 公开填写页只需要外观与开关，访问密码、白名单、通知邮箱一律不下发 */
const PUBLIC_SETTING_KEYS = [
  'submitText', 'buttonText', 'redirectUrl', 'headerImage', 'bgImage', 'bgColor', 'buttonColor',
  'allowQuery', 'onlyWechat', 'recordWechat', 'needPassword', 'passPercent', 'showResult', 'duration'
]

/** 作答需要的 props 白名单；标准答案常藏在自定义属性里，一律不下发 */
const PUBLIC_PROP_KEYS = [
  'max', 'min', 'step', 'rows', 'fields', 'multiple', 'maxSize', 'accept', 'html',
  'minLength', 'maxLength', 'unit', 'precision', 'labels', 'placeholder'
]

export function publicFieldProps(field = {}) {
  const src = field.props && typeof field.props === 'object' ? field.props : {}
  const out = {}
  // 组件类型是这些时，matrix 的「行」本身就是要作答的内容；但个别组件会把答案塞进 props.rows
  for (const k of PUBLIC_PROP_KEYS) if (src[k] !== undefined) out[k] = src[k]
  // 未登记的自定义属性一律不下发，避免成为答案走私通道
  return out
}

export function publicSettings(settings = {}) {
  const out = {}
  for (const k of PUBLIC_SETTING_KEYS) if (settings[k] !== undefined) out[k] = settings[k]
  return out
}
