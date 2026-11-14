import crypto from 'node:crypto'
import { get, all, run, each, now, log } from '../lib/db.js'
import { readJson, fail, sendJson, clientIp } from '../lib/http.js'
import { requireUser, requirePerm, currentUser, can } from '../lib/auth.js'
import { pickForm, formWindow, validateSubmission, sanitizeAnswers, sanitizeSubmission, isSubjective, pendingLeft, reviewTally, gradeSubmission, computeStats, createStatsAccumulator, submissionData, paginate, fieldVisible, passLineOf, manualScoresOf, passHintOf, captchaChallenge, safeJson, isAnswerCorrect, answerText, DISPLAY_TYPES } from '../lib/forms.js'
// 逻辑规则只有一份，浏览器与服务端都跑它：页面上看到几道题、哪几道必填，
// 与服务端判分时的口径必须完全一致
import { buildFlow, resolveAnswers, renderText } from '../../web/js/flow.js'
// 乱序也只有一份实现：页面按 seed 打乱，测试按同一个 seed 复现，不靠 Math.random
import { shuffleSchema } from '../../web/js/shuffle.js'

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

import { notifySubmission, dispatchWebhooks } from '../lib/notify.js'
import { formRole, submissionVisibleScope, requireFormRole } from '../lib/formMembers.js'
import { rateLimit, publicLimit } from '../lib/guard.js'
import { rankingTop, rankOf, publicRanking, distributionOf } from '../lib/ranking.js'
import { bandsOf, crossedBySubmission, formBandReader } from '../lib/bands.js'
import { submissionsXlsx, submissionsHead, submissionRow } from '../lib/sheet.js'
import { writeXlsxStream } from '../lib/xlsx.js'
import { signFileUrl, signFileUrls, signHtmlFiles, QUERY_FILE_TTL } from '../lib/fileAccess.js'
// 份数/分数的留痕口径只有一份：前端也是这套（web/js/review.js），两边说的必须是同一件事
import { scoreChanges, changeText, calibrate, gapLevel, reviewDrift, driftText } from '../../web/js/review.js'

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
 * 只保留「这份作答真正触及的题」。
 *
 * 旧实现只过滤了显隐逻辑，两个后果：
 *  1. 被条件跳转跳过的题（答完第 2 题就结束）的值还留在 data 里，照样入库、照样进报表；
 *  2. 计算题的值完全由客户端说了算——一份被改过的全对答案能把总分刷成任意数字。
 * 现在统一走 buildFlow / resolveAnswers：跳过的题丢掉，计算题用服务端的值覆盖。
 */
export function pickVisibleAnswers(schema, raw) {
  return resolveAnswers(schema, raw).data
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
  // 开放时间窗和「打开发表单」共用同一个判断（formWindow），
  // 否则会出现「页面能打开、填完提交才说没开始」这种白填一场的体验
  const win = formWindow(s)
  if (win.notStarted) fail(403, `问卷将于 ${s.timeWindow.start.replace('T', ' ')} 开放`)
  if (win.ended) fail(403, '问卷已于 ' + String(s.timeWindow.end).replace('T', ' ') + ' 结束')
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
  /*
   * 「仅登录用户可填」。Issue 原文「白名单、密码、登录、微信填写…」里的「登录」一直在
   * 设计器里没有开关、在服务端也没有校验：问卷是公开入口，任何人拿到链接就能填。
   * 现在它是真的：查不到会话就 403，并且这条判据在提交时也走同一处。
   * 注意它和「按账号限次」不是一回事——限次只是记 userId，匿名照样能填。
   */
  if (s.needLogin && !extra.userId) fail(401, '该表单仅限登录用户填写，请先登录')
  return fp
}

/**
 * 报表结果缓存。
 *
 * 报表是「同一份数据被反复点开」的典型：看一眼、切个图表类型、再刷新。
 * 93 万份答卷时算一遍 3.5 秒，而这些字节其实一模一样。
 *
 * 缓存键不是时间，是数据指纹：行数 + 最大 id + 最大 updated_at。
 * 任何一份答卷新增、编辑、删除、批阅都会改动这三个值之一，
 * 所以「缓存命中」和「数据没变」是同一件事——不会出现「刚提交的答卷报表里没有」。
 * （指纹本身是一次索引扫描，20 万行以上也就几十毫秒。）
 *
 * 只留最近 8 张表单，且单份结果超过 20 秒就丢弃：报表页是随手点开的东西，
 * 不值得为它长期占内存。
 */
const reportCache = new Map()
function reportCacheKey(form) {
  const r = get('SELECT COUNT(*) c, MAX(id) m, MAX(updated_at) u FROM submissions WHERE form_id = ? AND deleted_at IS NULL', form.id)
  return `${form.id}:${r.c}:${r.m}:${r.u}:${form.updated_at}`
}
function cachedReport(form) {
  const key = reportCacheKey(form)
  const hit = reportCache.get(form.id)
  if (hit && hit.key === key) return hit.stats
  const acc = createStatsAccumulator(form)
  for (const row of each('SELECT data, score, passed, created_at FROM submissions WHERE form_id = ? AND deleted_at IS NULL', form.id)) {
    acc.push({ data: safeJson(row.data, {}), score: row.score, passed: row.passed, created_at: row.created_at })
  }
  const stats = acc.result()
  if (reportCache.size >= 8) reportCache.delete(reportCache.keys().next().value)
  reportCache.set(form.id, { key, stats })
  return stats
}

/** 列表/详情统一带上人工分，前端不用再 parse 一次 */
function withManual(row) {
  return { ...submissionData(row), manual_scores: manualScoresOf(row) }
}

/**
 * 批阅留痕的读法。
 *
 * 与写入端（applyReview）成对：那边记「谁、什么时候、动了哪几题」，这边只负责按次取回来。
 * changes 里存的是 JSON 数组，解析失败不给 500——一条坏记录不该让整页批阅历史打不开。
 */
function reviewLogs(submissionId, limit = 50) {
  return all(`SELECT id, user_id, username, source, seconds, score_before, score_after, changes, note, created_at
    FROM review_logs WHERE submission_id = ? ORDER BY id DESC LIMIT ?`, Number(submissionId), Math.min(Math.max(Number(limit) || 50, 1), 200))
    .map(r => ({
      id: r.id, userId: r.user_id, username: r.username || '', source: r.source,
      seconds: r.seconds || 0, scoreBefore: r.score_before, scoreAfter: r.score_after,
      changes: safeJson(r.changes, []), note: r.note || '', createdAt: r.created_at
    }))
}

/**
 * 一页答卷的批阅人姓名。
 *
 * 列表里每个人一行、每行都要显示「谁批的」，逐行 pickUser 一遍就是 N+1 次查询；
 * 而一页 20 行的批阅人常常只有两三个。这里按 id 去重取一次，查不到就给空串——
 * 账号被删掉之后，姓名列退化成空比显示「#7」更像人话。
 */
function reviewerNames(rows) {
  const ids = [...new Set(rows.map(r => Number(r.reviewed_by) || 0).filter(Boolean))]
  const map = new Map()
  if (ids.length) {
    for (const u of all(`SELECT id, nickname, username FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)) {
      map.set(u.id, u.nickname || u.username || '')
    }
  }
  return id => map.get(Number(id) || 0) || ''
}

export default function register(r) {
  /** 公开接口的频率闸。按「用途 + 来源 IP（+ 表单）」分桶，互不牵连。 */
  const gate = (req, res, kind, formId = '') => {
    const key = `${kind}:${clientIp(req)}:${formId}`
    const hit = rateLimit({ key, limit: publicLimit(kind), windowMs: 60_000 })
    if (!hit.ok) {
      res.setHeader('Retry-After', String(hit.retryAfter))
      fail(429, `操作过于频繁，请 ${hit.retryAfter} 秒后再试`)
    }
  }

  /** 公开：读取表单（不含答案） */
  r.get('/api/public/forms/:id', async (req, res, { params }) => {
    gate(req, res, 'query', params.id)
    const form = pickForm(params.id)
    if (!form) fail(404, '表单不存在或已删除')
    if (form.status !== 'published') fail(403, '表单未发布')
    /*
     * 定时发布：状态是「已发布」但还没到点（或已过点）时，这里不再直接 403。
     * 403 的文案是「表单未发布」，而真实情况是「明天九点才开」——
     * 拿到链接的人只会以为链接坏了。现在把时间窗一起下发，页面自己说清楚什么时候能填。
     */
    const win = formWindow(form.settings)
    // 验证码的题面（a + b）必须在这里下发：之前只清空 answer，前端算不出题面，
    // 唯一能对照的答案又被清空了，只能去后台表单详情里翻——验证码整体不可用
    /*
     * 题目 / 选项乱序。
     * seed 由服务端生成并跟着答卷一起入库：乱序只有在能重现时才是可解释的——
     * 老师问「第 3 题为什么错了」，而每个人卷子上的第 3 题都不一样，
     * 没有种子就永远对不上。同一份答卷在「逐题回顾」里用同一个 seed 重排，看到的还是当年那套顺序。
     */
    const anti = form.settings?.antiCheat || {}
    // 只有真的开了乱序才给种子：没开的卷子下发一个种子，会让人以为「这卷乱过」
    const shuffling = !!(anti.shuffleQuestions || anti.shuffleOptions)
    const seed = shuffling ? crypto.randomBytes(6).toString('hex') : ''
    const shuffledRes = shuffleSchema(form.schema, seed, {
      questions: !!anti.shuffleQuestions,
      options: !!anti.shuffleOptions
    })
    const schema = shuffledRes.schema.map(f => {
      // 白名单而不是「删掉 answer」：标准答案能藏在任何自定义属性里，
      // 例如 props.answers，删掉顶层 answer 之后它照样下发到浏览器。
      const out = {
        id: f.id, type: f.type, label: f.label, required: f.required,
        placeholder: f.placeholder, description: f.description, options: f.options,
        defaultValue: f.defaultValue, logic: f.logic, props: publicFieldProps(f),
        // 逻辑规则必须下发，否则浏览器根本不知道「选了否就别再问下去」
        requiredWhen: f.requiredWhen, jump: f.jump, fill: f.fill
      }
      // 富文本正文里内嵌的图片也要换签：公开页访客没有会话，原地址一律 401
      if ((f.type === 'richtext' || f.type === 'html') && typeof out.props?.html === 'string') {
        out.props = { ...out.props, html: signHtmlFiles(out.props.html) }
      }
      if (f.type === 'captcha') out.challenge = captchaChallenge(f.id)
      return out
    })
    /*
     * 头图 / 背景图是发布出去给人看的，但它同样落在需要鉴权的 /api/files/raw 下。
     * 公开页的访客没有会话，这里现签一张票给他——票只对这两张图有效、限期而已。
     */
    const pub = publicSettings(form.settings)
    for (const k of ['headerImage', 'bgImage']) if (pub[k]) pub[k] = signFileUrl(pub[k])
    sendJson(res, 200, {
      ok: true,
      data: {
        id: form.id, title: form.title, description: form.description, kind: form.kind,
        schema, settings: pub,
        // 开放时间窗：页面据此把入口换成「尚未开始 / 已结束」，而不是让人白填一场
        window: win,
        seed,
        // 防作弊里「需要浏览器配合」的部分：切屏计数、是否超限即交卷
        antiCheat: {
          detectSwitch: !!anti.detectSwitch,
          maxSwitch: Number(anti.maxSwitch) || 0,
          autoSubmit: !!anti.autoSubmit
        }
      }
    })
  })

  /** 公开：提交答卷 */
  r.post('/api/public/forms/:id/submit', async (req, res, { params }) => {
    /*
     * 公开提交是全站唯一「不登录就能写库、还能触发 WebHook 与通知」的入口。
     * 之前一个 while 循环就能把库灌满，顺手把下游 WebHook 也打一遍。
     */
    gate(req, res, 'submit', params.id)
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
    // 先把作答折成这个题型收得下的形状，再走逻辑计算与校验。
    // 顺序不能反：条件逻辑拿脏值判断显隐会得出错误的「哪些题在作答范围内」，
    // 而校验又是按那个范围做的——脏值会一路带到判分和统计里。
    const resolved = resolveAnswers(form.schema, sanitizeSubmission(form.schema, body.data))
    const data = resolved.data
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
    /*
     * 切屏次数。
     * 这个数字由浏览器上报，因此**它只是证据，不是判决**：改一个前端变量就能报 0。
     * 所以它只有两个用途：给阅卷人一个「值得看一眼」的排序依据，以及超过阈值时把卷子标出来。
     * 不据此判零分——误判一个真被弹窗打断的考生，比放过一个切屏十次的人代价大得多。
     */
    const anti = form.settings?.antiCheat || {}
    const switchCount = Math.max(0, Math.min(9999, Number(body.switchCount) || 0))
    const maxSwitch = Number(anti.maxSwitch) || 0
    const flagged = maxSwitch > 0 && switchCount >= maxSwitch ? 1 : 0
    /*
     * 乱序种子跟着答卷存：逐题回顾要按当年那套顺序排（选项顺序影响「你选的是 B」怎么解释）。
     * 只在开了乱序时才存；没开乱序的卷子存一个种子毫无意义，还会让人误以为「这卷乱过」。
     */
    const shuffling = !!(anti.shuffleQuestions || anti.shuffleOptions)
    const seed = shuffling ? String(body.seed || '').replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 32) : ''
    const result = run(`INSERT INTO submissions(form_id, data, score, passed, duration, user_id, ip, device, openid, wx_nickname, wx_avatar, public_id, seed, switch_count, flagged, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      form.id, JSON.stringify(data), score, passed, Number(body.duration) || 0, user?.id || 0,
      fp.ip, fp.device, body.openid || '', body.wxNickname || '', body.wxAvatar || '', publicId,
      seed, switchCount, flagged, ts, ts)
    const id = Number(result.lastInsertRowid)
    // 附件是先上传后交卷的，交卷时把本次作答里引用到的文件认领到这份答卷上，
    // 否则「打包下载附件」会把它们漏掉。
    // 只认领「属于这张表单、且还没人认领」的文件：以前只看 id + submission_id=0，
    // 把别的表单的 file id 写进自己的作答，就能把别人的附件挂到自己的卷子上
    // （打包下载、导出都会把它算进来）。
    for (const fileId of collectFileIds(data)) {
      run('UPDATE files SET submission_id = ? WHERE id = ? AND submission_id = 0 AND form_id = ?', id, fileId, form.id)
    }
    const submission = get('SELECT * FROM submissions WHERE id = ?', id)

    const review = form.kind === 'exam' && form.settings?.showResult !== false
      ? buildReview(form.schema, data, form.settings, {}, seed)
      : null
    // 条件跳转结束后，提交页要说清楚「为什么只有这几题」：
    // 只回一句「提交成功」，用户会以为剩下的题没显示是坏了
    const stop = resolved.stopped
      ? { stopped: true, fieldId: resolved.stopFieldId, text: resolved.stopText || form.settings?.submitText || '提交成功，感谢您的参与！' }
      : { stopped: false }

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
      jump: stop,
      message: form.settings?.submitText || '提交成功，感谢您的参与！',
      redirect: form.settings?.redirectUrl || '',
      // 交卷那一刻就能看到自己的名次：这是考试类表单最想立刻知道的一件事，
      // 而以前要等管理员导出 Excel 才能算出来。
      // 但名次本身透露分数（第 1 名配满分就是满分），所以「不公布成绩」时也不能给名次。
      rank: form.kind === 'exam' && form.settings?.showResult !== false && form.settings?.showRank !== false
        ? rankOf(form.id, id)
        : null,
      // 交卷时把切屏次数回给本人：想让人当场知道自己被记下来了，比事后悄悄标记公平
      switchCount,
      flagged: !!flagged,
      maxSwitch
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
  function buildReview(schema, data, settings = {}, manual = {}, seed = '') {
    const items = []
    // 与校验、判分同一口径：被条件跳转跳过的题不进回顾——
    // 一份「答到第 2 题就结束」的卷子，回顾里不该出现后面 8 道没答的题然后判他全错
    const flow = buildFlow(schema, data)
    /*
     * 回顾按「当年那份卷子的顺序」排。
     * 卷子开了乱序时，学生记得的是「第 5 题我选了 B」；如果回顾按题库原顺序列，
     * 同一个第 5 题指的是另一道题，逐题对错就变成一次误导。选项同理：
     * 「你选的是 B，正确答案是 C」只有在选项顺序一致时才成立。
     */
    const anti = settings?.antiCheat || {}
    const ordered = seed
      ? shuffleSchema(schema, seed, { questions: !!anti.shuffleQuestions, options: !!anti.shuffleOptions }).schema
      : schema
    for (const f of ordered) {
      if (DISPLAY_TYPES.has(f.type)) continue
      if (!flow.active.has(f.id)) continue
      const right = (f.answer || []).map(String)
      const auto = right.length > 0
      // 与 gradeSubmission 同一套判分口径：排序题看顺序、矩阵题逐行比
      const correct = auto && isAnswerCorrect(f, data[f.id])
      const manualGiven = manual?.[f.id]
      const hasManual = !auto && manualGiven !== undefined && manualGiven !== null && manualGiven !== ''
      const score = Number(f.score) || 0
      items.push({
        id: f.id,
        label: f.label,
        type: f.type,
        // 作答/答案都要变成人能读的字：矩阵是对象、排序是顺序、子表单是行
        given: answerText(f, data[f.id]) ? [answerText(f, data[f.id])] : [],
        givenRaw: data[f.id] === undefined ? null : data[f.id],
        answer: right,
        // 矩阵答案是「每行各选哪一列」，直接 join 出来是「5、5」，看不出哪行是哪行
        answerText: answerText(f, right),
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
    // 查询接口带编号暴力试，等于把别人答卷的编号当密码猜
    gate(req, res, 'query', params.id)
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
      ? buildReview(form.schema, JSON.parse(row.data), form.settings, manualScoresOf(row), row.seed || '')
      : null
    // 附件地址在这里现签一张短期票：匿名访客刚交完卷要回看自己的附件，
    // 此刻他没有会话，库里存的又是规范路径（不带票），不签就全是一片裂图
    const queryData = signFileUrls(safeJson(row.data, {}), QUERY_FILE_TTL)
    sendJson(res, 200, {
      ok: true,
      data: {
        id: row.id, publicId: row.public_id || String(row.id), data: queryData, score: row.score,
        passed: row.passed === 1, reviewed: !!row.reviewed_at, review, createdAt: row.created_at,
        // 与交卷同一口径：不公布成绩的表单，连名次也不该从查询接口漏出去
        rank: form?.kind === 'exam' && form?.settings?.showResult !== false && form?.settings?.showRank !== false
          ? rankOf(row.form_id, row.id)
          : null
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
    const scope = submissionVisibleScope(user)
    const own = scope.sql === '1 = 1' ? '' : ` AND ${scope.sql}`
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
    if (formId) {
      /*
       * 指定了表单就先把身份判清楚。只读协作者不该看到「该表单还没有答卷」——
       * 那句话的意思是「没人填过」，而真实情况是「你没权限看明细」。
       * 列表默认按 editor 及以上过滤（见 submissionVisibleScope），会静默少掉一批行，
       * 静默才是最坏的结果：用户会照着这个数字做判断。
       */
      const scoped = pickForm(formId)
      if (!scoped) fail(404, '表单不存在')
      const role = requireFormRole(user, scoped, 'view')
      if (role === 'viewer') fail(403, '你在该表单中是「只读」协作者，只能看统计分析，看不到答卷明细')
      where.push('s.form_id = ?'); args.push(Number(formId))
    }
    // 协作者也能看答卷：他要批阅、要导出、要看报表。只按 created_by 过滤的话，
    // 协作在列表里成立、点进数据页就 403，等于没有协作。
    const scope = submissionVisibleScope(user)
    if (scope.sql !== '1 = 1') { where.push(scope.sql); args.push(...scope.args) }
    const keyword = url.searchParams.get('keyword')
    if (keyword) { where.push('s.data LIKE ?'); args.push(`%${keyword}%`) }
    if (url.searchParams.get('marked') === '1') where.push('s.marked = 1')
    // 待批阅：考试答卷里还有主观题没给分
    if (url.searchParams.get('pending') === '1') {
      // 待批阅 = 这份卷子里确实还有主观题没给分，不是「没批过」就算；
      // 只含客观题的交卷不该堆进阅卷队列——队列一有噪音，老师就不看了。
      // 「还差几题没批」属于判分口径，和 gradeSubmission 一样放在 JS 里算：
      // 在 SQL 里拆 JSON 时，字段 id 的下划线在 LIKE 里是通配符，判据会静默出错。
      /*
       * 只扫「有主观题的考试」的答卷，不再扫全表。
       * 旧实现是 `WHERE deleted_at IS NULL` 全量读、再在 JS 里按 form_id 过滤：
       * 93 万份答卷时，点一次「待批阅」要 2 秒，其中 99% 的行读完就被丢掉了。
       * 表单对象也只取一次（以前每行都 pickForm 一遍，同一个表单解析了十几次）。
       */
      const finished = []
      const formsById = new Map(pendingFormIds.map(id => [id, pickForm(id)]))
      if (pendingFormIds.length) {
        const marks = pendingFormIds.map(() => '?').join(',')
        for (const row of each(`SELECT id, form_id, data, manual_scores FROM submissions WHERE deleted_at IS NULL AND form_id IN (${marks})`, ...pendingFormIds)) {
          if (pendingLeft(formsById.get(row.form_id), row) === 0) finished.push(row.id)
        }
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
    // 带上表单类型：前端要按它决定「批阅」按钮出不出。
    // 之前列表里没有这个字段，问卷答卷也摆着「批阅」，点了才弹「只有考试答卷需要批阅」。
    const rows = all(`SELECT s.*, f.title AS form_title, f.kind AS form_kind ${base} ORDER BY s.id ${order} LIMIT ? OFFSET ?`, ...args, p.pageSize, p.offset)
    /*
     * 带上「还剩几道主观题没批」。
     * 前端原先只按 kind==='exam' 摆「批阅」，于是一张纯客观题的卷子，每一行都有颗按钮，
     * 点下去才弹「这份卷子没有待批阅的主观题」——白点一次、还要读懂一句否定。
     * 表单对象按 id 缓存：一页 20 行常常来自同一张卷子。
     */
    const formCache = new Map()
    const withPending = (row) => {
      const base2 = withManual(row)
      // 「谁批的」摆在行上：一封卷子两道题分差得离谱时，第一眼要看到的是人，不是一个时间戳
      const reviewer = nameOf(row.reviewed_by)
      if (row.form_kind !== 'exam') return { ...base2, pending: 0, reviewer }
      if (!formCache.has(row.form_id)) formCache.set(row.form_id, pickForm(row.form_id))
      return { ...base2, pending: pendingLeft(formCache.get(row.form_id), row), reviewer }
    }
    const nameOf = reviewerNames(rows)
    /*
     * 分数区间整页一次算完。
     * 「同一道题张老师给 5 分、李老师给 17 分」这件事，尺度对账已经能看出来，
     * 但成绩单上照旧只有一个精确的 71——读者不知道该信几成。这里给每行带上区间，
     * 留痕按这一页的 id 一次查完：一行一次就是 20 次索引扫描。
     */
    const rowsByForm = new Map()
    for (const row of rows) {
      if (row.form_kind !== 'exam' || !row.form_id) continue
      if (!rowsByForm.has(row.form_id)) rowsByForm.set(row.form_id, [])
      rowsByForm.get(row.form_id).push(row)
    }
    const bandsByForm = new Map()
    for (const [fid, group] of rowsByForm) bandsByForm.set(fid, bandsOf(pickForm(fid), group))
    const bandOf = (row) => (row.form_kind === 'exam' ? bandsByForm.get(row.form_id)?.get(Number(row.id)) || null : null)
    sendJson(res, 200, { ok: true, data: rows.map(r => ({ ...withPending(r), band: bandOf(r) })), total, page: p.page, pageSize: p.pageSize, totalPages: p.totalPages })
  })

  r.get('/api/submissions/:id', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:read')
    const row = get('SELECT * FROM submissions WHERE id = ?', Number(params.id))
    if (!row) fail(404, '答卷不存在')
    const form = pickForm(row.form_id, { withDeleted: true })
    // 单份答卷是明细，不是汇总：只读协作者看报表就够了
    if (form) requireFormRole(user, form, 'edit')
    const reviewer = reviewerNames([row])(row.reviewed_by)
    // 批阅历史跟着详情一起给：批阅弹窗打开就要显示「上次谁批的、改了什么」，
    // 再单独发一次请求会让弹窗先空一下再补上，等于把两次渲染拼在人眼前
    // 分数区间同一口径算：详情页说「71 分」，弹窗里说「59 ~ 71」，两处数字对不上最伤信任
    const band = form ? bandsOf(form, [row]).get(Number(row.id)) || null : null
    sendJson(res, 200, { ok: true, data: { ...withManual(row), reviewer, band, review_logs: reviewLogs(row.id, 20), form } })
  })

  /** 一份答卷的批阅历史（按次倒序）：谁、什么时候、动了哪几题、从几分改到几分 */
  r.get('/api/submissions/:id/review-logs', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:read')
    const row = get('SELECT * FROM submissions WHERE id = ?', Number(params.id))
    if (!row) fail(404, '答卷不存在')
    const form = pickForm(row.form_id, { withDeleted: true })
    if (form) requireFormRole(user, form, 'edit')
    const url = new URL(req.url, 'http://x')
    const logs = reviewLogs(row.id, url.searchParams.get('limit') || 50)
    sendJson(res, 200, { ok: true, data: logs, total: logs.length })
  })

  r.post('/api/submissions', async (req, res) => {
    const user = requirePerm(req, 'data:write')
    const body = await readJson(req)
    const form = pickForm(body.formId)
    if (!form) fail(404, '表单不存在')
    // 后台「新增答卷」是给表单维护人补录的，不是给任何人往别人问卷里灌数据的入口
    requireFormRole(user, form, 'edit')
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

  /**
   * 批量保存人工分：`{ items: [{ id, scores, note }] }`。
   * 只保存传上来的那几份；某一份出错不牵连其它份——报回哪几份被拒，别整批回滚。
   */
  r.put('/api/submissions/review-batch', async (req, res) => {
    const user = requirePerm(req, 'data:write')
    const body = await readJson(req)
    const items = Array.isArray(body.items) ? body.items : []
    if (!items.length) fail(400, '没有要保存的答卷')
    if (items.length > 200) fail(400, '一次最多保存 200 份答卷')
    const saved = []
    const rejected = []
    const formCache = new Map()
    for (const it of items) {
      const id = Number(it?.id)
      const row = id ? get('SELECT * FROM submissions WHERE id = ? AND deleted_at IS NULL', id) : null
      if (!row) { rejected.push({ id, reason: '答卷不存在' }); continue }
      if (!formCache.has(row.form_id)) formCache.set(row.form_id, pickForm(row.form_id))
      const form = formCache.get(row.form_id)
      if (!form) { rejected.push({ id, reason: '表单不存在' }); continue }
      if (form.kind !== 'exam') { rejected.push({ id, reason: '只有考试答卷需要批阅' }); continue }
      const role = formRole(user, form)
      if (!role || role === 'viewer') { rejected.push({ id, reason: '无权批阅该答卷' }); continue }
      try {
        const data = applyReview(user, row, form, it.scores, it.note, { merge: true, source: 'batch', seconds: it.seconds })
        saved.push({ id, score: data.score, review: data.review, changes: data.changes?.length || 0 })
      } catch (e) {
        rejected.push({ id, reason: e.message || '保存失败' })
      }
    }
    if (saved.length) log(user, '批量批阅', `${saved.length} 份答卷${rejected.length ? `，${rejected.length} 份被拒` : ''}`)
    sendJson(res, 200, { ok: true, saved: saved.length, rejected })
  })

  r.put('/api/submissions/:id', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:write')
    const row = get('SELECT * FROM submissions WHERE id = ? AND deleted_at IS NULL', Number(params.id))
    if (!row) fail(404, '答卷不存在')
    const form = pickForm(row.form_id)
    if (!form) fail(404, '表单不存在')
    requireFormRole(user, form, 'edit')
    const body = await readJson(req)
    // 编辑同样要过清洗：否则「先正常交卷、再回头改一份脏的」就绕过了提交时的全部约束
    const data = body.data === undefined
      ? JSON.parse(row.data)
      : resolveAnswers(form.schema, sanitizeSubmission(form.schema, body.data)).data
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
  /**
   * 给一份答卷落人工分。单份批阅与批量阅卷共用这一处：
   * 两条路各写一遍的话，「哪些题可以给分」很快会分叉——而分叉的后果是
   * 老师在工作台里给的分，换个入口保存就变成非法值。
   */
  function applyReview(user, row, form, rawScores, note, { merge = false, source = 'single', seconds = 0 } = {}) {
    const data = JSON.parse(row.data)
    // 改之前的那份人工分：留痕要记「从几分改到几分」，而不是只记最后落在哪
    const before = manualScoresOf(row)
    const scoreBefore = row.score
    // 只认这份卷子里真有、且确实没有标准答案的题，防止给选择题凭空加分
    const subjective = new Map(form.schema.filter(f => isSubjective(f) && fieldVisible(f, data)).map(f => [f.id, f]))
    /*
     * merge 是批量阅卷用的：那一页只提交「这次填了分的题」。
     * 直接整体覆盖的话，同一份卷子分两次批（先批第一题、第二天再批第二题），
     * 第二次就把第一次的分抹了——成绩悄悄回落，而两次都提示「已保存」。
     * 单份批阅保持整体覆盖：老师看到的是全部题目，改动就是全部改动。
     */
    const scores = merge ? { ...manualScoresOf(row) } : {}
    for (const [fid, raw] of Object.entries(rawScores || {})) {
      const f = subjective.get(fid)
      if (!f) continue
      // 显式传 null 表示「撤掉这道题的分数」，让它回到待批
      if (raw === null) { delete scores[fid]; continue }
      if (raw === undefined || raw === '') continue
      const n = Number(raw)
      if (!Number.isFinite(n)) fail(400, `「${f.label}」的分数不是数字`)
      if (n < 0 || n > f.score) fail(400, `「${f.label}」应在 0 - ${f.score} 分之间`)
      scores[fid] = Math.round(n * 100) / 100
    }
    const g = gradeSubmission(form.schema, data, form.settings, scores)
    const ts = now()
    const finalNote = String(note ?? row.review_note ?? '').slice(0, 500)
    run('UPDATE submissions SET manual_scores = ?, score = ?, passed = ?, reviewed_at = ?, reviewed_by = ?, review_note = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(scores), g.score, g.passed ? 1 : 0, ts, user.id, finalNote, ts, row.id)
    /*
     * 逐题留痕。
     * submissions 上的 reviewed_at / reviewed_by 只记得「最后一次」，而且改一次覆盖一次：
     * 「这份卷子是谁批的、这两道题的分差得离谱是不是同一个人给的」在真学校里是要被追问的，
     * 而那一列永远只给出最后一个人、最后一个时间点。这里按「次」记：
     * 谁、什么时候、动了哪几题、从几分改到几分、这份卷子花了多久。
     *
     * 只在真有改动时落一条：「打开看一眼就关掉」不该在留痕里长出一行空记录。
     */
    const changes = scoreChanges(before, scores, id => subjective.get(id)?.label || id)
    if (changes.length) {
      run(`INSERT INTO review_logs(submission_id, form_id, user_id, username, source, seconds, score_before, score_after, changes, note, created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        row.id, row.form_id, user.id, user.nickname || user.username || '', source,
        Math.min(Math.max(Math.round(Number(seconds) || 0), 0), 6 * 3600),
        scoreBefore ?? null, g.score, JSON.stringify(changes), finalNote, ts)
    }
    const updated = get('SELECT * FROM submissions WHERE id = ?', row.id)
    return { ...withManual(updated), review: buildReview(form.schema, data, form.settings, scores), changes }
  }

  r.put('/api/submissions/:id/review', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:write')
    const row = get('SELECT * FROM submissions WHERE id = ? AND deleted_at IS NULL', Number(params.id))
    if (!row) fail(404, '答卷不存在')
    const form = pickForm(row.form_id)
    if (!form) fail(404, '表单不存在')
    if (form.kind !== 'exam') fail(400, '只有考试答卷需要批阅')
    requireFormRole(user, form, 'edit')
    const body = await readJson(req)
    // 合并而不是覆盖：文档里一直写着「未出现在 scores 里的主观题保留原有分数」，
    // 而代码此前是整体替换——前端每次都把全部题目回传，所以没人发现这句话是假的。
    const data = applyReview(user, row, form, body.scores, body.note, { merge: true, source: 'single', seconds: body.seconds })
    log(user, '批阅答卷', `#${row.id} → ${data.score}/${data.review?.total ?? '-'}`)
    dispatchWebhooks('update', { formId: form.id, formTitle: form.title, submission: withManual(get('SELECT * FROM submissions WHERE id = ?', row.id)) }).catch(() => {})
    sendJson(res, 200, { ok: true, data })
  })

  /**
   * 批量阅卷：一次拿一整页待批的主观题。
   *
   * 以前批卷是「点开一份 → 给分 → 保存 → 回到列表 → 点开下一份」，
   * 一次五步，30 份就是 150 次点击，而且中间还要重新加载列表。
   * 现在按表单一次取出这一页的待批答卷（含逐题作答原文与已给的分），
   * 前端翻页即阅，保存可以攒着一起提交。
   *
   * 口径与「待批阅」筛选完全一致：有主观题的考试表单、还有题没给分。
   */
  r.get('/api/forms/:id/review-queue', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:read')
    const form = pickForm(params.id)
    if (!form) fail(404, '表单不存在')
    requireFormRole(user, form, 'edit')
    if (form.kind !== 'exam') fail(400, '只有考试答卷需要批阅')
    const url = new URL(req.url, 'http://x')
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50)
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0)
    // 先按「这份卷子还剩几题没批」筛一遍：没有主观题或已批完的不进队列。
    // 顺手统计整场考试的批阅进度——一页存完就清空，批到第 6 页时已经不知道
    // 自己在整场里的位置，也不知道还剩几个人的卷子没看。分母只算「有主观题的卷子」，
    // 否则纯客观题的答卷会让进度永远到不了头。
    const queue = []
    let scanned = 0
    let need = 0
    for (const row of each('SELECT id, public_id, data, manual_scores, score, passed, created_at, review_note, reviewed_at, reviewed_by FROM submissions WHERE form_id = ? AND deleted_at IS NULL ORDER BY id ASC', form.id)) {
      scanned++
      const tally = reviewTally(form, row)
      if (!tally.subjective) continue
      need++
      if (tally.pending === 0) continue
      queue.push(row)
    }
    const page = queue.slice(offset, offset + limit)
    const nameOfReviewer = reviewerNames(page)
    /*
     * 别人对这题给过多少分。
     *
     * 「谁偏松」在尺度页上能看出来，但批到第 6 页时已经没人记得住那些名字——
     * 而分叉的口径必须在给分的那一刻摆在眼前：这一份同题有人给 5、有人给 17，
     * 我正在敲的这个数字落进去，就是第三种口径。
     */
    const crossed = crossedBySubmission(form, page)
    const data = page.map(row => {
      const answers = JSON.parse(row.data)
      const manual = manualScoresOf(row)
      const flow = buildFlow(form.schema, answers)
      const cross = new Map((crossed.get(Number(row.id)) || []).map(x => [x.id, x]))
      const items = form.schema
        .filter(f => isSubjective(f) && flow.active.has(f.id))
        .map(f => ({
          id: f.id, label: f.label, type: f.type, score: Number(f.score) || 0,
          // 作答原文按题目自己的样子摊开：矩阵题 join 出来是 [object Object]
          given: answerText(f, answers[f.id]) || '',
          givenRaw: answers[f.id] === undefined ? null : answers[f.id],
          analysis: f.analysis || '',
          current: manual[f.id] === undefined ? null : manual[f.id],
          // 这道题被两个人给出过不同的分：把两个人各自的分一并递出去
          // （刚被撤分的题也一样给——总分里没有它了，但口径分歧还在）
          others: cross.get(f.id)?.by || null
        }))
      return {
        id: row.id, publicId: row.public_id, createdAt: row.created_at,
        score: row.score, passed: row.passed, note: row.review_note || '',
        // 这一份之前有没有人动过：批量阅卷里最怕「两个人各批了一半，谁也不知道对方给了多少」
        reviewedAt: row.reviewed_at || '', reviewedBy: row.reviewed_by || 0,
        reviewer: nameOfReviewer(row.reviewed_by),
        answeredCount: items.filter(i => i.given).length,
        items
      }
    })
    // done 只报「已批完」的份数，不报「扫过多少」：后者包含没有主观题的卷子，
    // 拿它做进度分子的话，刚打开阅卷界面就显示「已批 40 份」，一份都还没批。
    sendJson(res, 200, { ok: true, data, total: queue.length, need, done: Math.max(need - queue.length, 0), scanned, offset, limit })
  })

  /**
   * 评分尺度：这道题，两个人给出过差多远的分。
   *
   * 留痕已经能回答「谁批的、改了什么」，但两条痕迹只是并排摆着——
   * 张老师给 4 分、李老师给 18 分，系统不会提醒任何人，成绩单照旧只有一个总分。
   * 教研组真正常做的事是「同一道题先各自批 10 份，对一遍尺子再开工」，
   * 而这件事此前只能靠人喊。
   *
   * 不新建表：留痕里逐题记着 from/to，按时间回放就能还原「每一格最后是谁给了几分」。
   * 多一张汇总表只会多一个会跟留痕对不上的地方。
   */
  r.get('/api/forms/:id/review-calibration', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:read')
    const form = pickForm(params.id)
    if (!form) fail(404, '表单不存在')
    // 尺度对账会暴露「这份卷子谁给了几分」，只读协作者看报表就够了
    requireFormRole(user, form, 'edit')
    if (form.kind !== 'exam') fail(400, '只有考试答卷需要批阅')
    const url = new URL(req.url, 'http://x')
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 0, 0), 365)
    const since = days ? new Date(Date.now() - days * 86400_000).toISOString() : ''
    /*
     * 只取「有改动」的留痕。回放要的是每一格最后一次的值，
     * 而 review_logs.changes 是 JSON，SQL 里拆不开——一次考试几千条而已，读回来再算。
     * 按 id 正序：后写的覆盖先写的，跟写入端的时间顺序一致。
     */
    const rows = all(`SELECT id, submission_id, user_id, username, changes, created_at FROM review_logs
      WHERE form_id = ?${since ? ' AND created_at >= ?' : ''} ORDER BY id ASC`,
      ...(since ? [form.id, since] : [form.id]))
    const entries = rows.map(r => ({
      submissionId: r.submission_id, userId: r.user_id, username: r.username || '',
      createdAt: r.created_at, changes: safeJson(r.changes, [])
    }))
    // 满分从当前 schema 取：尺度说的「差了几分」必须跟题目现在的分值对得上
    const maxOf = id => Number(form.schema.find(f => f.id === id)?.score) || 0
    const result = calibrate(entries, { maxOf })
    // 每道题再标一句人话，别让前端各算一遍口径
    for (const q of result.questions) q.level = gapLevel(q.worst?.gap, q.max)
    /*
     * 尺子的时间维度：同一个人批前 20 份偏松、被谈过之后后 40 份收紧，这件事在
     * 「谁偏松 N 分」里看不出来——那是所有历史摞在一起的平均值，两极被互相抵消。
     * 与尺度对账共用同一份留痕回放，只是换个切法：按时间分桶，每个点仍是「同格对比」的偏移。
     */
    const drift = reviewDrift(entries)
    for (const t of drift.teachers) t.text = driftText(t)
    sendJson(res, 200, {
      ok: true,
      data: {
        ...result,
        logs: entries.length,
        /*
         * 没有分歧时要说清是哪种「没有」：一张空表会让人以为功能坏了。
         * 而且这句话不能吹：「同分不留痕」（分数没动就不落记录），所以
         * 「两人给分一致」在库里其实是看不见的——能说的只有「没找到改过分的地方」。
         */
        drift,
        note: result.conflicts ? '' : '还没有同一道题被两位老师给出不同的分（同分不留痕，所以一致的那些看不见）'
      }
    })
  })

  /** 从回收站恢复一份答卷 */
  r.post('/api/submissions/:id/restore', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:write')
    const row = get('SELECT * FROM submissions WHERE id = ?', Number(params.id))
    if (!row) fail(404, '答卷不存在')
    const form = pickForm(row.form_id, { withDeleted: true })
    if (form) requireFormRole(user, form, 'edit')
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
    if (form) requireFormRole(user, form, 'edit')
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
      // 表单记录都没了（被彻底删除）时 form 是 null，得单独判：默默跳过而不是 500
      if (!form || !formRole(user, form) || formRole(user, form) === 'viewer') { skipped++; continue }
      run('UPDATE submissions SET deleted_at = ? WHERE id = ?', ts, row.id)
      count++
    }
    // 之前一律回报「已删除 N 份」，其中不存在的 id、无权的答卷都没删掉，用户以为清干净了
    sendJson(res, 200, { ok: true, count, skipped })
  })



  /**
   * 报表统计。
   *
   * 这里以前是 `SELECT *` 全量读进内存再算——93 万份答卷时它要 13 秒、峰值 2.2GB，
   * 而返回的 JSON 只有 18KB。现在流式喂给累加器，只取统计真正用到的四列，
   * 内存跟答卷数量脱钩。
   */
  r.get('/api/forms/:id/report', async (req, res, { params }) => {
    const user = requirePerm(req, 'report:read')
    const form = pickForm(params.id)
    if (!form) fail(404, '表单不存在')
    requireFormRole(user, form, 'view')
    const stats = cachedReport(form)
    sendJson(res, 200, { ok: true, data: { form: { id: form.id, title: form.title, kind: form.kind }, ...stats } })
  })

  /**
   * 成绩排名（管理端）。
   * 榜单只读前 N 名，SQL 排序 + 索引，与答卷总量无关；并列同名次、下一名跳号。
   */
  r.get('/api/forms/:id/ranking', async (req, res, { params }) => {
    const user = requirePerm(req, 'report:read')
    const form = pickForm(params.id)
    if (!form) fail(404, '表单不存在')
    requireFormRole(user, form, 'view')
    const url = new URL(req.url, 'http://x')
    const limit = Number(url.searchParams.get('limit')) || 20
    const top = rankingTop(form.id, limit, form)
    /*
     * 榜单上也要带区间：名次是「按分数排的」，而分数的尺子可能不齐——
     * 第 3 名 78 分、第 4 名 77 分，如果两个人的区间分别是 70~78 和 71~84，
     * 那个「1 分之差」其实什么也没说明。不给区间，名次就在暗示一个不存在的精确度。
     */
    const bands = bandsOf(form, top)
    for (const r of top) {
      r.band = bands.get(Number(r.id)) || null
      delete r.manual_scores
    }
    const total = get('SELECT COUNT(*) c FROM submissions WHERE form_id = ? AND deleted_at IS NULL AND score IS NOT NULL', form.id).c
    sendJson(res, 200, {
      ok: true,
      data: {
        form: { id: form.id, title: form.title, kind: form.kind },
        total,
        top,
        // 分数分布按分数档（满分 100 制给 10 档，否则按实际分差均分），用来判断「这个排名有没有意义」
        distribution: distributionOf(form, total)
      }
    })
  })

  /** 公开榜单：匿名入口，名字打码、只给前 N 名，且必须由表单开关显式打开 */
  r.get('/api/public/forms/:id/ranking', async (req, res, { params }) => {
    gate(req, res, 'query', params.id)
    const form = pickForm(params.id)
    if (!form) fail(404, '表单不存在')
    if (form.status !== 'published') fail(403, '表单未发布')
    if (form.settings?.showRanking !== true) fail(403, '该表单未开放排行榜')
    const url = new URL(req.url, 'http://x')
    sendJson(res, 200, { ok: true, data: publicRanking(form, Number(url.searchParams.get('limit')) || 10) })
  })

  /**
   * 导出答卷为 xlsx（当前筛选条件下的全部，不只是当前页）。
   * 之前只有前端拿当前页拼 CSV：翻到第 2 页再导出，导出的还是第 1 页。
   */
  r.get('/api/forms/:id/submissions.xlsx', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:read')
    const form = pickForm(params.id)
    if (!form) fail(404, '表单不存在')
    // 明细导出给「可编辑」及以上：只读协作者的权限是「看报表」，不是把整库答卷带走
    requireFormRole(user, form, 'edit')
    const url = new URL(req.url, 'http://x')
    const where = ['form_id = ?', 'deleted_at IS NULL']
    const args = [form.id]
    if (url.searchParams.get('keyword')) { where.push('data LIKE ?'); args.push(`%${url.searchParams.get('keyword')}%`) }
    if (url.searchParams.get('marked') === '1') where.push('marked = 1')
    /*
     * 这里是流式导出。旧实现把全部答卷读进内存、拼成二维数组、再拼成一整条工作表 XML：
     * 93 万份答卷时直接 `RangeError: Invalid string length`（V8 单字符串上限 512MB），
     * 用户看到的是一个 500，连「导出失败」的原因都读不出来。
     * 现在边读库边写响应，内存里只有一行。
     *
     * 代价是拿不到 Content-Length（流式长度未知），所以不设它——让浏览器按 chunked 收。
     */
    const { schema, head } = submissionsHead(form)
    /*
     * 批阅人用子查询带出来，而不是 JOIN users：
     * 导出沿用同一个 where（列名裸露、没有表别名），JOIN 之后 id / created_at 立刻变成歧义列，
     * 而要改的就是「按时间范围导出」这种最常用的语句。外层仍叫 submissions，where 一个字不用动。
     */
    // 留痕一次读完按行取：导出是流式的，但批阅留痕不能跟着每行查一次
    const bandOf = formBandReader(form)
    const cursor = each(`SELECT id, public_id, data, score, passed, created_at, reviewed_at, switch_count, flagged,
      (SELECT COALESCE(NULLIF(u.nickname, ''), u.username, '') FROM users u WHERE u.id = submissions.reviewed_by) AS reviewer_name
      FROM submissions WHERE ${where.join(' AND ')} ORDER BY id DESC`, ...args)
    const rows = {
      [Symbol.asyncIterator]() {
        let first = true
        const it = cursor[Symbol.iterator]()
        return {
          async next() {
            if (first) { first = false; return { done: false, value: head } }
            const r = it.next()
            if (r.done) return { done: true }
            return { done: false, value: submissionRow(form, schema, { ...r.value, data: safeJson(r.value.data, {}), band: bandOf(r.value) }) }
          }
        }
      }
    }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="submissions-${form.id}.xlsx"; filename*=UTF-8''${encodeURIComponent((form.title || '答卷') + '-答卷.xlsx')}`,
      'Cache-Control': 'no-store'
    })
    try {
      const stat = await writeXlsxStream(form.title || '答卷', rows, res)
      // 流写完必须显式 end()：writeZipStream 只管往里灌字节，不知道这跟连接该不该收尾。
      // 少了这一句，浏览器能收到几乎全部内容却永远等不到结束，只看到「下载没有进度」。
      res.end()
      log(user, '导出答卷 Excel', `${form.title} #${form.id} → ${Math.round(stat.bytes / 1024)}KB`)
    } catch (e) {
      // 响应头已经发出去了，这里不能再改成 500；能做的只有记下来
      log(user, '导出答卷 Excel 失败', `${form.title} #${form.id}：${e.message}`)
      res.destroy()
    }
  })

  /** 导入答卷（JSON 数组） */
  r.post('/api/forms/:id/import', async (req, res, { params }) => {
    const user = requirePerm(req, 'data:write')
    const form = pickForm(params.id)
    if (!form) fail(404, '表单不存在')
    requireFormRole(user, form, 'edit')
    const body = await readJson(req)
    const list = Array.isArray(body.items) ? body.items : []
    if (!list.length) fail(400, '没有可导入的数据')
    let ok = 0, skipped = 0
    const ts = now()
    for (const item of list) {
      const data = resolveAnswers(form.schema, sanitizeAnswers(form.schema, item.data || item).data).data
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
  'allowQuery', 'onlyWechat', 'recordWechat', 'needPassword', 'passPercent', 'showResult', 'duration',
  'showRank', 'showRanking',
  // needLogin 必须下发：浏览器要据此提示「先登录再填」，而不是让人填完整份才吃一句 401
  'needLogin'
]

/** 作答需要的 props 白名单；标准答案常藏在自定义属性里，一律不下发 */
const PUBLIC_PROP_KEYS = [
  'max', 'min', 'step', 'rows', 'fields', 'multiple', 'maxSize', 'accept', 'html',
  'minLength', 'maxLength', 'unit', 'precision', 'labels', 'placeholder',
  // 计算题的公式要下发：浏览器要在答题过程中实时算给用户看。
  // 公式本身不含答案（引用的是别的题），但服务端仍会重算一遍再入库，不采信客户端算的数
  'formula',
  // 级联的作答控件（层级下拉 / 搜索式）是外观选择，与答案无关；
  // 不下发的话，设计器里配成搜索、公开页还是一排下拉
  'picker'
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
