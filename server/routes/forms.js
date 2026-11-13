import { get, all, run, now, db } from '../lib/db.js'
import { readJson, fail, sendJson } from '../lib/http.js'
import { requireUser, requirePerm, currentUser, can } from '../lib/auth.js'
import { normalizeSchema, parseForm, pickForm, paginate, safeJson, judgeOptions } from '../lib/forms.js'
import { localPath } from '../lib/storage.js'
import fs from 'node:fs'
import { log } from '../lib/db.js'

const KINDS = ['survey', 'exam', 'practice', 'form']

export default function register(r) {
  r.get('/api/forms', async (req, res) => {
    const user = requirePerm(req, 'form:read')
    const url = new URL(req.url, 'http://x')
    const kind = url.searchParams.get('kind')
    const keyword = url.searchParams.get('keyword')
    const isTemplate = url.searchParams.get('template')
    const category = url.searchParams.get('category')
    const status = url.searchParams.get('status')
    const recycle = url.searchParams.get('recycle') === '1'
    const where = [recycle ? 'f.deleted_at IS NOT NULL' : 'f.deleted_at IS NULL']
    const args = []
    if (!can(user, '*')) { where.push('f.created_by = ?'); args.push(user.id) }
    if (kind) { where.push('f.kind = ?'); args.push(kind) }
    if (status) { where.push('f.status = ?'); args.push(status) }
    if (isTemplate === '1' || isTemplate === '0') { where.push('f.is_template = ?'); args.push(Number(isTemplate)) }
    else where.push('f.is_template = 0')
    if (category) { where.push('f.category = ?'); args.push(category) }
    if (keyword) { where.push('(f.title LIKE ? OR f.description LIKE ?)'); args.push(`%${keyword}%`, `%${keyword}%`) }
    const sql = `SELECT f.*, (SELECT COUNT(*) FROM submissions s WHERE s.form_id = f.id AND s.deleted_at IS NULL) AS submission_count FROM forms f WHERE ${where.join(' AND ')} ORDER BY f.updated_at DESC`
    const rows = all(sql, ...args).map(parseForm)
    const p = paginate(req, rows.length)
    sendJson(res, 200, { ok: true, data: rows.slice(p.offset, p.offset + p.pageSize), page: p.page, pageSize: p.pageSize, total: p.total, totalPages: p.totalPages })
  })

  r.get('/api/forms/:id', async (req, res, { params }) => {
    const user = requirePerm(req, 'form:read')
    const form = pickForm(params.id, { withDeleted: true })
    if (!form) fail(404, '表单不存在')
    if (!can(user, '*') && form.created_by !== user.id && !form.is_template) fail(403, '无权访问该表单')
    sendJson(res, 200, { ok: true, data: form })
  })

  r.post('/api/forms', async (req, res) => {
    const user = requirePerm(req, 'form:create')
    const body = await readJson(req)
    if (!body.title) fail(400, '请填写表单标题')
    const kind = KINDS.includes(body.kind) ? body.kind : 'survey'
    const ts = now()
    const result = run(
      'INSERT INTO forms(title, description, kind, schema, settings, status, is_template, category, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      String(body.title).trim(), body.description || '', kind,
      JSON.stringify(normalizeSchema(body.schema)), JSON.stringify(body.settings || {}),
      ['draft', 'published', 'closed'].includes(body.status) ? body.status : 'draft',
      body.is_template ? 1 : 0, body.category || '', user.id, ts, ts
    )
    const id = Number(result.lastInsertRowid)
    log(user, '创建表单', `${body.title} #${id}`)
    sendJson(res, 201, { ok: true, id, data: pickForm(id) })
  })

  r.put('/api/forms/:id', async (req, res, { params }) => {
    const user = requirePerm(req, 'form:update')
    const form = pickForm(params.id)
    if (!form) fail(404, '表单不存在')
    if (!can(user, '*') && form.created_by !== user.id) fail(403, '无权修改该表单')
    const body = await readJson(req)
    const sets = []
    const args = []
    if (body.title !== undefined) { sets.push('title = ?'); args.push(String(body.title).trim()) }
    if (body.description !== undefined) { sets.push('description = ?'); args.push(String(body.description)) }
    if (body.kind !== undefined && KINDS.includes(body.kind)) { sets.push('kind = ?'); args.push(body.kind) }
    if (body.schema !== undefined) { sets.push('schema = ?'); args.push(JSON.stringify(normalizeSchema(body.schema))) }
    if (body.settings !== undefined) { sets.push('settings = ?'); args.push(JSON.stringify(body.settings)) }
    if (body.status !== undefined) { sets.push('status = ?'); args.push(['draft', 'published', 'closed'].includes(body.status) ? body.status : 'draft') }
    if (body.is_template !== undefined) { sets.push('is_template = ?'); args.push(body.is_template ? 1 : 0) }
    if (body.category !== undefined) { sets.push('category = ?'); args.push(String(body.category)) }
    if (!sets.length) fail(400, '没有需要更新的内容')
    sets.push('updated_at = ?'); args.push(now())
    run(`UPDATE forms SET ${sets.join(', ')} WHERE id = ?`, ...args, form.id)
    log(user, '更新表单', `${form.title} #${form.id}`)
    sendJson(res, 200, { ok: true, data: pickForm(form.id) })
  })

  r.delete('/api/forms/:id', async (req, res, { params }) => {
    const user = requirePerm(req, 'form:delete')
    const form = pickForm(params.id)
    if (!form) fail(404, '表单不存在')
    if (!can(user, '*') && form.created_by !== user.id) fail(403, '无权删除该表单')
    run('UPDATE forms SET deleted_at = ? WHERE id = ?', now(), form.id)
    log(user, '删除表单（移入回收站）', `${form.title} #${form.id}`)
    sendJson(res, 200, { ok: true })
  })

  r.post('/api/forms/:id/restore', async (req, res, { params }) => {
    const user = requirePerm(req, 'form:update')
    const form = pickForm(params.id, { withDeleted: true })
    if (!form) fail(404, '表单不存在')
    run('UPDATE forms SET deleted_at = NULL, updated_at = ? WHERE id = ?', now(), form.id)
    log(user, '恢复表单', `${form.title} #${form.id}`)
    sendJson(res, 200, { ok: true })
  })

  r.delete('/api/forms/:id/purge', async (req, res, { params }) => {
    const user = requirePerm(req, 'form:delete')
    const form = pickForm(params.id, { withDeleted: true })
    if (!form) fail(404, '表单不存在')
    // 只有已经进了回收站的表单才允许彻底删除：直接对在用表单调 purge 的话，
    // 一次误点就是「问卷连同全部答卷消失」，而回收中心根本没机会接住它。
    if (!form.deleted_at) fail(400, '请先把表单移入回收中心，再彻底删除')
    // 彻底删除要连附件一起清：之前只删了 forms / submissions 两张表，
    // files 记录和磁盘上的文件全留着——用户以为「删干净了」，磁盘里还在涨。
    let files = 0
    for (const f of all(`SELECT * FROM files WHERE form_id = ? OR submission_id IN (SELECT id FROM submissions WHERE form_id = ?)`, form.id, form.id)) {
      if (f.driver === 'local') {
        const local = localPath(f.stored)
        if (local) fs.rmSync(local, { force: true })
      }
      run('DELETE FROM files WHERE id = ?', f.id)
      files++
    }
    run('DELETE FROM submissions WHERE form_id = ?', form.id)
    run('DELETE FROM forms WHERE id = ?', form.id)
    log(user, '彻底删除表单', `${form.title} #${form.id}（含 ${files} 个附件）`)
    sendJson(res, 200, { ok: true, files })
  })

  r.post('/api/forms/:id/duplicate', async (req, res, { params }) => {
    const user = requirePerm(req, 'form:create')
    const form = pickForm(params.id, { withDeleted: true })
    if (!form) fail(404, '表单不存在')
    const ts = now()
    const result = run(
      'INSERT INTO forms(title, description, kind, schema, settings, status, is_template, category, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      `${form.title} - 副本`, form.description, form.kind, JSON.stringify(form.schema), JSON.stringify(form.settings),
      'draft', form.is_template, form.category, user.id, ts, ts
    )
    sendJson(res, 201, { ok: true, id: Number(result.lastInsertRowid) })
  })

  /** 文本批量导入题目 */
  r.post('/api/forms/:id/import-text', async (req, res, { params }) => {
    const user = requirePerm(req, 'form:update')
    const form = pickForm(params.id)
    if (!form) fail(404, '表单不存在')
    const { text } = await readJson(req)
    if (!text) fail(400, '请粘贴题目文本')
    const fields = parseTextToFields(String(text))
    if (!fields.length) fail(400, '未识别到题目，请检查格式')
    // 解析器剔掉的越界答案要报出来：不然用户看到「已导入 5 道题」，却不知道有题的答案是空的
    const droppedAnswers = fields.filter(f => f.dropped?.length).map(f => f.label)
    const schema = [...form.schema, ...fields.map(f => { const c = { ...f }; delete c.dropped; return c })]
    run('UPDATE forms SET schema = ?, updated_at = ? WHERE id = ?', JSON.stringify(schema), now(), form.id)
    sendJson(res, 200, { ok: true, added: fields.length, schema, droppedAnswers })
  })

  /** 模板中心 */
  r.get('/api/templates', async (req, res) => {
    const user = currentUser(req)
    if (!user) fail(401, '请先登录')
    const rows = all(`SELECT f.id, f.title, f.description, f.kind, f.category, f.settings, f.updated_at,
      (SELECT COUNT(*) FROM forms x WHERE x.is_template = 0 AND x.title LIKE f.title || '%') AS uses
      FROM forms f WHERE f.is_template = 1 AND f.deleted_at IS NULL ORDER BY f.updated_at DESC`)
    sendJson(res, 200, { ok: true, data: rows.map(x => ({ ...x, settings: safeJson(x.settings, {}) })) })
  })

  r.post('/api/templates/:id/use', async (req, res, { params }) => {
    const user = requirePerm(req, 'form:create')
    const tpl = pickForm(params.id)
    if (!tpl || !tpl.is_template) fail(404, '模板不存在')
    const ts = now()
    const result = run(
      'INSERT INTO forms(title, description, kind, schema, settings, status, is_template, category, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,0,?,?,?,?)',
      `${tpl.title} - 副本`, tpl.description, tpl.kind, JSON.stringify(tpl.schema), JSON.stringify(tpl.settings), 'draft', tpl.category, user.id, ts, ts
    )
    sendJson(res, 201, { ok: true, id: Number(result.lastInsertRowid) })
  })

  r.get('/api/stats/overview', async (req, res) => {
    const user = requireUser(req)
    // 模板也躺在 forms 表里。之前没排除，工作台一进来就报「表单总数 6 / 已发布 6」，
    // 而用户其实一张问卷都没建——数字全来自内置模板，第一眼就在骗人。
    const own = `f.is_template = 0 AND f.deleted_at IS NULL` + (can(user, '*') ? '' : ` AND f.created_by = ${user.id}`)
    const forms = get(`SELECT COUNT(*) c FROM forms f WHERE ${own}`).c
    const published = get(`SELECT COUNT(*) c FROM forms f WHERE ${own} AND f.status = 'published'`).c
    // 答卷要跟着表单一起算：表单进了回收站，它的答卷就不该还在工作台上冒出来。
    // 之前只过滤 s.deleted_at，删掉的问卷答卷照样躺在趋势图和「最近提交」里。
    const visible = `s.deleted_at IS NULL AND f.deleted_at IS NULL AND f.is_template = 0` + (can(user, '*') ? '' : ` AND f.created_by = ${user.id}`)
    const subsFrom = `FROM submissions s JOIN forms f ON f.id = s.form_id WHERE ${visible}`
    const submissions = get(`SELECT COUNT(*) c ${subsFrom}`).c
    const today = get(`SELECT COUNT(*) c ${subsFrom} AND s.created_at >= ?`, new Date().toISOString().slice(0, 10)).c
    const trend = all(`SELECT substr(s.created_at,1,10) AS date, COUNT(*) AS count ${subsFrom} GROUP BY date ORDER BY date DESC LIMIT 14`).reverse()
    const recent = all(`SELECT s.id, s.form_id, s.created_at, f.title ${subsFrom} ORDER BY s.id DESC LIMIT 8`)
    const users = get('SELECT COUNT(*) c FROM users').c
    sendJson(res, 200, { ok: true, data: { forms, published, submissions, today, users, trend, recent } })
  })
}

/**
 * 文本批量导入：把「人写的题目」翻译成 schema。
 *
 * 难的不是认题型，是认「这一行到底是什么」：
 *   `A. 步行` 是选项，`① 步行` 也是选项，`请只选最主要的那个` 却是上一题的题干补充；
 *   `答案：B` 指第一个选项（正确），`答案：错` 指「错误」选项（错误）——
 *   两个都是常识，但写错一个是「题库答案全选 A」，另一个是「判断题全员答错」。
 *
 * 所以先切片（题目 / 选项 / 元信息 / 未知三类），再把每个「题目块」三段式解释：
 * 元信息归位、选项按序号排、剩下的文本原序拼回题干。「未知」宁可留给题干，也不造选项。
 */
const TYPE_WORDS = [
  ['日期时间', 'datetime'], ['日期', 'date'], ['时间', 'time'],
  ['单选', 'radio'], ['多选', 'checkbox'], ['下拉', 'select'], ['判断', 'judge'],
  ['填空', 'text'], ['单行', 'text'], ['简答', 'textarea'], ['问答', 'textarea'], ['多行', 'textarea'],
  ['评分', 'rate'], ['量表', 'nps'], ['滑动', 'slider'], ['上传', 'upload'], ['手机', 'phone'],
  ['邮箱', 'email'], ['身份证', 'idcard'], ['矩阵', 'matrix'], ['排序', 'sort'], ['定位', 'location'],
  ['签名', 'signature'], ['级联', 'cascader'], ['轮播', 'carousel'], ['开关', 'switch'], ['数字', 'number'],
  ['single choice', 'radio'], ['multiple choice', 'checkbox'], ['choose one', 'radio'],
  ['true/false', 'judge'], ['true or false', 'judge'], ['judge', 'judge'], ['dropdown', 'select'],
  ['radio', 'radio'], ['checkbox', 'checkbox'], ['textarea', 'textarea'], ['text', 'text'],
  ['number', 'number'], ['date', 'date'], ['rating', 'rate'], ['upload', 'upload']
]

const CHOICE_WORDS = /^(单选|多选|选择|下拉|判断|排序|级联|轮播)题?$/
const JUDGE_WORDS = new Set(['判断', '判断题', '是非题', '对错题', 'true/false', 'true or false', 'judge'])

/** 题型词 → 字段类型；认不出返回 null */
export function matchType(word = '') {
  const w = String(word).trim()
  if (!w) return null
  const lower = w.toLowerCase()
  for (const [key, type] of TYPE_WORDS) {
    if (w.includes(key) || (key.length > 2 && lower.includes(key))) return type
  }
  return null
}

const BRACKET_TAGS = /[\[【]\s*([^\]】]{1,20})\s*[\]】]/g
const PAREN_TAGS = /[（(]\s*([^()（）]{1,20})\s*[)）]/g
/** 行首的标签：`[单选] 题干`、`（单选）`，含全角空格 */
const LEAD_TAG = /^\s*[\[【(（]\s*([^\]】)）]{1,20})\s*[\]】)）]\s*/

/**
 * 只认「括号里只写了题型」的那一组。
 * 方括号优先；同类取最后一个，因为标签习惯写在行尾。
 * `简述事件循环（Event Loop）的作用 [简答]` 里的 `（Event Loop）` 因此不会被误当题型。
 */
function pickTypeTag(line) {
  const hits = []
  for (const rx of [BRACKET_TAGS, PAREN_TAGS]) {
    rx.lastIndex = 0
    const list = []
    for (const m of String(line).matchAll(rx)) {
      const type = matchType(m[1])
      if (type) list.push({ type, start: m.index, end: m.index + m[0].length })
    }
    if (list.length) { hits.push(...list); break }
  }
  const rank = t => (CHOICE_WORDS.test(t) || JUDGE_WORDS.has(String(t).toLowerCase()) ? 2 : 1)
  return choose(hits, rank)
}

function choose(hits, rank) {
  if (!hits.length) return null
  const best = Math.max(...hits.map(h => rank(h.type)))
  return [...hits].reverse().find(h => rank(h.type) === best) || null
}

// 「A. 选项」「A、选项」「A) 选项」「(1) 选项」「① 选项」都算选项；「H2/SQLite」「MySQL」不是
const MARKER = /^\s*(?:([A-Za-z])\s*[.．、)）:：]|([①-⑳])|([(（]\s*\d{1,2}\s*[)）]))\s*/
const NUM_PREFIX = /^(?:[①-⑳]|\d{1,3}\s*[.、)．]|[（(]\s*\d{1,3}\s*[)）]|[一二三四五六七八九十]{1,3}\s*[、.．])\s*/

function markerShape(m) {
  if (m[1]) return 'letter'
  if (m[2]) return 'circled'
  return 'number'
}

/** 选项行：「A. 步行」认识，「① 步行」「(1) 步行」也认识。题号本身的序号不认（那是题干） */
function optionLine(line) {
  // 圈号、字母、括号数字开头；汉字 / 数字开头的是题号或小标题
  if (!/^\s*(?:[A-Za-z][.．、)）:：]|[①-⑳]|[(（]\s*\d{1,2}\s*[)）])/.test(line)) return null
  const m = MARKER.exec(line)
  if (!m) return null
  const shape = markerShape(m)
  if (shape === 'letter' && /^[a-z]/.test(m[1] || '')) return null
  const label = line.slice(m[0].length).trim()
  if (!label || label.length > 200) return null
  if (/^(答案|正确答案|解析|分值|分数|说明|备注)\s*[:：]/.test(label)) return null
  return { shape, index: m[1] ? m[1].toUpperCase().charCodeAt(0) - 65 : m[2] ? m[2].charCodeAt(0) - 0x2460 : null, label }
}

const BULLET = /^\s*[-*+•·]\s+(.+)$/

function isBulletOption(line) {
  const m = BULLET.exec(line)
  if (!m) return false
  const t = m[1].trim()
  return t.length > 0 && t.length <= 200 && !/^(答案|解析|分值|分数|说明|备注)/.test(t)
}

function pageNumberLike(line) {
  const t = line.trim()
  if (!t) return true
  if (/^第?\s*\d{1,4}\s*[页共]/.test(t)) return true
  // 「第 1 题」这类单独成行的小标题不生成题目，也不该粘到上一题身上（纯「二、」由 isSectionHeading 处理）
  if (/^第\s*[\d一二三四五六七八九十]{1,3}\s*[题部分]\s*$/.test(t)) return true
  if (/^[-—=*~_\s]{3,}$/.test(t)) return true
  return false
}

/** 行的角色粗判：题目 / 选项 / 未知。真正的归属留给「块」去解释 */
/** 只看「这一行自己」够不够起一个新块（题干 / 元信息 / 题型声明） */
function classifyAsBlockStart(raw) {
  const t = raw.trim()
  if (!t) return 'none'
  if (/^(?:答案|正确答案|分值|分数|解析|说明|题型|类型)\s*[:：]/.test(t)) return 'meta'
  if (inlineTypePrefix(t)) return 'stem'
  if (/^[一二三四五六七八九十]{1,3}\s*、\s*\S/.test(t)) return 'stem'
  if (NUM_PREFIX.test(t) && t.replace(NUM_PREFIX, '').trim()) return 'stem'
  if (/^[①-⑳]\s*\S/.test(t)) return 'stem'
  if (/^(?:单选|多选|判断|填空|简答|问答|下拉|评分|排序)题?$/.test(t)) return 'stem'
  if (/[?？]\s*$/.test(t)) return 'stem'
  return 'none'
}

function classify(line, state) {
  const t = line.trim()
  if (/^(?:答案|正确答案|参考答案)\s*[:：]/.test(t)) return 'meta:answer'
  if (/^(?:分值|分数)\s*[:：]/.test(t)) return 'meta:score'
  if (/^(?:解析|说明|考点)\s*[:：]/.test(t)) return 'meta:analysis'
  if (/^(?:提示|备注)\s*[:：]/.test(t)) return 'meta:note'
  const typeLine = /^(?:题型|类型|题目类型)\s*[:：]\s*(.+)$/.exec(t)
  if (typeLine) return 'meta:type'

  const lead = LEAD_TAG.exec(t)
  if (lead && line.slice(lead[0].length).trim()) return 'stem'

  // 「判断题：xxx」「多选题：xxx」：行首带题型的一定是新题的开头
  if (inlineTypePrefix(t)) return 'stem'
  // 「一、xxx」「2. xxx」「(3) xxx」：序号开头的都是新题，选项用的是字母或圈号
  if (NUM_PREFIX.test(t) && t.replace(NUM_PREFIX, '').trim()) return 'stem'

  // 圈号开头：「① 题干」还是「① 选项」，看后面跟的是不是字母 / 数字选项
  if (/^[①-⑳]\s*\S/.test(t)) {
    // 「① 题目？」带问号 / 句子 / 声明了题型 → 新题；「① 选项」→ 选项
    const body = t.replace(/^[①-⑳]\s*/, '')
    return /[?？]$/.test(text) || inlineTypePrefix(body) || body.length > 20 ? 'stem' : 'option'
  }
  if (optionLine(line)) return 'option'
  if (isBulletOption(line)) return 'option'
  // 「一、xxx」是中文小标题 / 题号，不是选项（「二. 选项」这种选项序号仍按选项处理）
  if (/^[一二三四五六七八九十]{1,3}\s*、\s*\S/.test(t)) return 'stem'
  // 选项已经排开了，这一行又是「多选 / 判断」这类题型声明：那是下一题的开头
  if (state.mode === 'option') {
    const ty = inlineTypePrefix(t)
    if (ty || /^(?:单选|多选|判断|填空|简答|问答|下拉|评分|排序)题?$/.test(t)) return 'stem'
  }

  // 没有选项标记的裸文本（「H2/SQLite」「MySQL」）：是题干还是选项，交给块自己判断
  return 'unknown'
}

/**
 * 摘掉行内题型标签。
 * `简述事件循环（Event Loop）的作用` 里的括号是题干的一部分，摘了就变成病句；
 * 只有「括号贴着句尾 / 贴着已有标点」才当标签处理。
 */
function stripInlineTag(text, tag) {
  if (!tag) return text.replace(/\s+/g, ' ')
  const head = text.slice(0, tag.start)
  const tail = text.slice(tag.end)
  const atEnd = !tail.trim()
  const standalone = /[\s，。；：、,.;:]/.test(head.slice(-1)) || tag.start >= text.trimEnd().length - tag.end + head.length
  return (atEnd || standalone ? head + ' ' + tail : text).replace(/\s+/g, ' ')
}

/** 分节小标题：`第一部分`、`一、`、`（二）`、`三、填空题`、`## 单选` —— 是排版，不是题目 */
/**
 * 行首直接写题型的：`判断题：xxx`、`多选题：xxx`、`简答：xxx`。
 * 这类行一定是新题的开头，绝不能像普通文本那样续到上一题的题干里。
 */
// 「① 单选题：」「4. 判断题：」「判断题：」「五、多选题：」——题号可有可无，题型词后面必须跟冒号
const LEAD_NUMBER = /^\s*(?:[①-⑳]|\d{1,3}\s*[.、)．]|[（(]\s*\d{1,3}\s*[)）]|[一二三四五六七八九十]{1,3}\s*[、.．])?\s*/
/** 只摘标签本身，题号要留着（`2. 判断题：xxx` → `2. xxx`） */
const INLINE_TYPE_TAG = /^(\s*(?:[①-⑳]|\d{1,3}\s*[.、)．]|[（(]\s*\d{1,3}\s*[)）]|[一二三四五六七八九十]{1,3}\s*[、.．])?\s*)[\u4e00-\u9fa5]{0,4}?(?:题|单选|多选|判断|填空|简答|问答|下拉|评分|排序|量表)\s*[:：]\s*/

/** 行首的题型词：`单选题`、`判断`、`多选`……（最长匹配优先，避免「多选」吃掉「多选题」） */
const TYPE_WORD_HEADS = (() => {
  const words = new Set(['判断', '单选', '多选', '填空', '简答', '问答', '下拉', '评分', '排序', '量表'])
  const out = []
  for (const w of words) { out.push(w, w + '题') }
  return out.sort((a, b) => b.length - a.length)
})()

/** `五、多选题：xxx` / `判断题：xxx` / `判断：xxx` → { word, type, body } */
function inlineTypePrefix(line) {
  const text = String(line).replace(LEAD_NUMBER, '')
  for (const w of TYPE_WORD_HEADS) {
    if (!text.startsWith(w)) continue
    const rest = text.slice(w.length)
    if (!/^\s*[:：]/.test(rest)) continue
    const type = matchType(w)
    if (type) return { word: w, type, body: rest.replace(/^\s*[:：]\s*/, '').trim() }
  }
  return null
}

// 「一、单选题」「三、判断题」这类小标题：序号 + 短词，且词本身是题型
const SECTION_WORDS = new Set(['单选', '多选', '判断', '填空', '简答', '问答', '评分', '排序', '矩阵', '量表'])

function isSectionHeading(raw) {
  const t = raw.trim()
  if (!t) return false
  const body = t.replace(/^#{1,6}\s*/, '')
  if (/^第\s*\d{1,4}\s*[页共]/.test(body)) return true
  // 「第一部分：单选」「第三章 判断题」：分节标题常常顺手把题型也写了，但它是排版不是题目
  if (/^第\s*[\d一二三四五六七八九十]{1,3}\s*[部分章节]/.test(body)) return true
  const bare = /^(?:[一二三四五六七八九十]{1,3}\s*[、.．]|[（(]\s*[一二三四五六七八九十]{1,3}\s*[)）])\s*(.*)$/.exec(body)
  if (bare) {
    const rest = bare[1].trim()
    if (!rest) return true
    // 只要带标点、带括号、带问号，就是用户在提问，不是小标题
    if (/[?？。！!；;，,（(\[【]/.test(rest)) return false
    if (matchType(rest.replace(/题$/, ''))) return true
    return rest.length <= 6 && (SECTION_WORDS.has(rest.replace(/题$/, '')) || rest.length <= 2)
  }
  // Markdown 标题：`## 单选`、`### 判断题`
  return /^#{1,6}\s*\S+$/.test(t) && !/[?？]/.test(t)
}

/**
 * 一行题干收尾：`!` 是「这题必答」的另一种写法，写进题干会把感叹号带进卷面
 */
function finishStem(block) {
  const last = block.stems.length - 1
  if (last < 0) return
  const hadBang = /[!！]\s*$/.test(block.stems[last])
  block.stems[last] = block.stems[last].replace(/\s*[!！]+\s*$/, '').trim()
  if (hadBang) block.required = true
}

function toList(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean)
  return String(v ?? '').split(/[,，;；、\s]+/).map(x => x.trim()).filter(Boolean)
}

function addToStem(block, text) {
  const t = text.trim()
  if (!t) return
  block.stemBangs = (block.stemBangs || 0) + ((t.match(/[!！]/g) || []).length)
  block.stems.push(t)
  block.hasStem = true
}

/** 选项按序号排好：A B C 乱序、① ② ③ 断号都能还原；没有序号的按出现顺序 */
function orderOptions(opts) {
  const groups = []
  for (const o of opts) {
    const last = groups[groups.length - 1]
    const sameKind = last && last.shape === o.shape && (o.shape === 'letter' || o.shape === 'circled' || o.shape === 'number')
    if (sameKind) last.items.push(o)
    else groups.push({ shape: o.shape, items: [o] })
  }
  const ordered = groups.map(g => {
    if (g.items.every(o => o.index == null)) return g.items
    const known = g.items.filter(o => o.index != null)
    return [...known].sort((a, b) => a.index - b.index)
  })
  return ordered.some(g => g.length > 1) ? ordered.flat() : opts
}

function makeField({ type, label }) {
  return {
    id: 'f_' + Math.random().toString(36).slice(2, 9),
    // declType 记下「用户声明了什么」，type 只能放 schema 认得的类型
    type: type === 'judge' ? 'radio' : (type || 'radio'),
    declType: type || null,
    label: label || '',
    required: false,
    options: [],
    answer: [],
    score: 0,
    analysis: '',
    props: {}
  }
}

function blockToField(block) {
  const text = block.stems.map(l => l
    .replace(/^(?:\d{1,3}\s*[.、)．]\s*|[（(]\s*\d{1,3}\s*[)）]\s*)+/, '')
    // 行首的「单选题：」「判断：」只是题型声明，不是题干的一部分
    .replace(INLINE_TYPE_TAG, '$1')).join('\n').trim()
  const tag = pickTypeTag(text) || pickTypeTag(block.stems.join(' '))
  const label = stripInlineTag(text, tag).trim()

  const declaredInName = matchType(block.typeWord || '') || null
  const hasChoice = block.options.length > 0
  let type = block.declType || declaredInName || tag?.type || null

  if (!type && /判断/.test(label)) type = 'judge'
  if (!type) type = hasChoice ? 'radio' : 'text'
  // 声明了选择题却没写选项：保持用户声明的题型（多选题就落多选题，只是提示缺选项），
  // 别悄悄改成填空——填空题和选择题的作答数据没法互转
  if (!hasChoice && /^(matrix|sort|cascader|carousel)$/.test(type)) type = 'radio'

  const field = makeField({ type, label })
  field.declType = type
  field.required = block.required
  field.score = block.score
  field.analysis = block.analysis
  field.props = { ...block.props }

  const opts = orderOptions(block.options)
  field.options = opts.map(o => ({ label: o.label, value: o.label }))
  // 判断题统一成「正确 / 错误」两个选项，这样答案口径和题库、阅卷一致
  if (type === 'judge' || (type === 'radio' && /判断/.test(label) && !opts.length)) {
    field.type = 'radio'
    field.options = judgeOptions()
  }
  if (block.appended.length) field.options = [...field.options, ...block.appended.map(label => ({ label, value: label }))]
  field.type = type === 'judge' ? 'radio' : type

  field.answer = resolveAnswer(block.answerTokens, field)
  if (field.droppedAnswers?.length) field.dropped = field.droppedAnswers.slice()
  if (!field.label) field.label = field.options.length ? '未命名题目' : ''
  return field
}

/** 答案落到「当前题型的取值」上：`B` → 第 2 项的 value，`错` → 错误，`对` → 正确 */
function resolveAnswer(raw, field) {
  if (!raw || !raw.length) return []
  const opts = field.options || []
  const isJudge = field.type === 'radio' && opts.length === 2 && opts[0].value === '正确' && opts[1].value === '错误'
  const out = []
  const dropped = []
  for (const tok of raw) {
    if (/^[A-Za-z]$/.test(tok)) {
      const i = tok.toUpperCase().charCodeAt(0) - 65
      // 答案指向不存在的选项：存进去就是「这题谁答都错」，宁可丢掉并告诉调用方
      if (opts[i]) out.push(opts[i].value)
      else dropped.push(tok)
      continue
    }
    const byLabel = opts.find(o => o.label === tok || o.value === tok)
    if (byLabel) { out.push(byLabel.value); continue }
    if (isJudge && /^(对|正确|是|yes|true|√|✓|t)$/i.test(tok)) { out.push('正确'); continue }
    if (isJudge && /^(错|错误|否|no|false|×|✗|f)$/i.test(tok)) { out.push('错误'); continue }
    if (!opts.length) { out.push(tok); continue }
    dropped.push(tok)
  }
  const unique = [...new Set(out)]
  field.droppedAnswers = dropped
  return unique
}

/**
 * 把行切片 + 组块，解释成字段。
 * 返回字段列表；`warnings` 里放「答案指向不存在的选项」这类需要用户知道的事。
 */
export function parseTextToFields(text, { defaultScore = 0 } = {}) {
  const lines = String(text).replace(/\r/g, '').split('\n')
  const blocks = []
  let cur = null
  let pending = { type: null, props: {} }
  let state = { mode: 'idle' }

  const open = (firstLine = '') => {
    cur = makeField({ type: null, label: '' })
    // 行首的「!」是 Google 表单那套「必答」写法，不能留在题干里
    if (/^\s*[!！]\s*/.test(firstLine)) { cur.required = true; firstLine = firstLine.replace(/^\s*[!！]\s*/, '') }
    cur.firstLine = firstLine
    cur.hasStem = false
    cur.stems = []
    cur.appended = []
    cur.answerTokens = []
    cur.score = Number(defaultScore) || 0
    cur.typeWord = ''
    cur.stemGap = false
    blocks.push(cur)
  }

  const currentHasOptions = () => !!cur && cur.options.length > 0 && !cur.stems.length

  const lastLineKind = () => {
    if (!cur || !cur.stems.length) return 'idle'
    return state.mode
  }

  for (const raw of lines) {
    if (/^\s*$/.test(raw)) { state = { mode: 'idle', hasOptions: cur?.options.length > 0 }; continue }
    if (pageNumberLike(raw)) { state = { mode: 'idle', hasOptions: cur?.options.length > 0 }; continue }
    if (isSectionHeading(raw)) { state = { mode: 'idle', hasOptions: cur?.options.length > 0 }; continue }
    const t = raw.trim()
    state.hasOptions = !!cur && cur.options.length > 0
    const kind = classify(raw, state)
    const [head, rest] = kind.split(':')

    if (head === 'meta') {
      // 元信息只认「紧跟在题目或选项后面」；中间隔了空行，它就是下一题的题干
      if (!cur) { open() }
      if (lastLineKind() === 'idle' && currentHasOptions()) {
        // 上个「块」只有选项、没有题干：用户把题目写在选项下面了，回头认领它
        addToStem(cur, t)
        state = { mode: 'stem' }
        continue
      }
      if (rest === 'answer') {
        const tokens = toList(t.replace(/^(?:答案|正确答案|参考答案)\s*[:：]\s*/, ''))
        const type = cur.declType || matchType(cur.typeWord || '') || null
        // 填空题没有选项，答案就是那个空的空格，随手写的「答案：Docker」是猜错题意，不能当标准答案
        if (type === 'text' || (type == null && !cur.options.length && !/^[A-Za-z]$/.test(tokens[0] || ''))) {
          if (!cur.options.length) { cur.placeholderHint = tokens.join(' '); continue }
        }
        cur.answerTokens = tokens
      }
      else if (rest === 'score') cur.score = Number(/(\d+(?:\.\d+)?)/.exec(t)?.[1] || 0)
      else if (rest === 'analysis') cur.analysis = t.replace(/^(?:解析|说明|考点)\s*[:：]\s*/, '')
      else if (rest === 'note') addToStem(cur, t)
      continue
    }

    if (head === 'stem') {
      open(raw)
      const inline = inlineTypePrefix(t)
      if (inline) {
        cur.typeWord = inline.word
        cur.declType = inline.type === 'judge' ? 'judge' : inline.type
        // 摘掉「判断题：」前缀，后面的题号（4. ）留给下面统一处理
        addToStem(cur, t.replace(INLINE_TYPE_TAG, '$1'))
      } else {
        addToStem(cur, t)
      }
      finishStem(cur)
      if (pending.type) cur.declType = pending.type
      if (pending.blank) cur.blank = true
      if (pending.props) cur.props = { ...pending.props }
      pending = { type: null, props: {}, blank: false }
      if (/必填/.test(t) || /[\*＊]\s*$/.test(t)) cur.required = true
    // 「! 请填写邮箱」「七、! 请填写邮箱」：感叹号是必答标记，不属于题干
    if (/^(?:[①-⑳]|\d{1,3}\s*[.、)．]|[（(]\s*\d{1,3}\s*[)）]|[一二三四五六七八九十]{1,3}\s*[、.．])?\s*[!！]\s*/.test(cur.stems[0] || '')) {
      cur.stems[0] = cur.stems[0].replace(/^(\s*(?:[①-⑳]|\d{1,3}\s*[.、)．]|[（(]\s*\d{1,3}\s*[)）]|[一二三四五六七八九十]{1,3}\s*[、.．])?\s*)[!！]\s*/, '$1')
      cur.required = true
    }
      state = { mode: 'stem' }
      continue
    }

    if (head === 'option') {
      const inline = inlineTypePrefix(t)
      if (inline) {
        open()
        cur.typeWord = inline.word
        addToStem(cur, t.replace(INLINE_TYPE_TAG, '$1'))
        if (pending.type) cur.declType = pending.type
        pending = { type: null, props: {} }
        state = { mode: 'stem' }
        continue
      }
      // 选项区里的裸文本（H2/SQLite、MySQL）被 classify 归到 option，这里再判一次它到底是不是题干
      const askBlock = /^[-*+•·]\s/.test(t) ? 'none' : classifyAsBlockStart(raw)
      // 题干还没出现、选项已经开始：裸文本是在补选项
      const second = (cur && cur.options.length > 0 && !cur.stems.length) ? 'none' : askBlock
      if (second !== 'none') {
        // 本块已经有选项了：这一行是新题的开头，不能并进上一题
        if (cur && cur.options.length) {
          open(raw)
          addToStem(cur, cur.firstLine.trim() || t)
          finishStem(cur)
        } else {
          if (!cur) open()
          addToStem(cur, t)
        }
        state = { mode: 'stem' }
        continue
      }
      // 一个块都没有时来的「- 选项」：那是题目本身（「- 你的姓名」这种手写清单），不是孤儿选项
      if (!cur || (!cur.stems.length && !cur.options.length)) {
        open(raw)
        // 行首的「- 」是清单符号，不属于题干
        addToStem(cur, t.replace(/^[-*+•·]\s+/, ''))
        finishStem(cur)
        state = { mode: 'stem' }
        continue
      }
      const opt = optionLine(raw)
      if (opt) cur.options.push(opt)
      else cur.options.push({ shape: 'none', index: null, label: t.replace(/^[-*+•·]\s+/, '') })
      state = { mode: 'option' }
      continue
    }

    // unknown：可以起一题，可以续题干，也可以补上一个选项的说明——按上下文决定
    const prev = lastLineKind()
    // 本块有题干、还没有任何选项：裸文本是题目说明（「请只选最主要的那个」），
    // 不能因为它短就降级成选项——问卷里「只选一项」「可多选」这类说明太常见了
    // 题干后面跟着说明文字（「请只选最主要的那个。」）：块还没出现选项，说明归这一题
    if (cur && cur.stems.length && !cur.options.length && prev !== 'block') {
      // 「H2/SQLite」「MySQL」这种短词是选项（题目忘了写序号）；整句才是题目说明。
      if (state.bareOptions || (t.length <= 40 && !/[。！？!?；;]$/.test(t) && !/\s/.test(t.trim()))) {
        cur.options.push({ shape: 'none', index: null, label: t })
        state = { mode: 'option', bareOptions: true }
        continue
      }
      addToStem(cur, t)
      continue
    }
    if (prev === 'option' && cur) {
      const last = cur.options[cur.options.length - 1]
      // 没有序号的选项后面再跟一行短词：那也是选项（「Mechanical Keyboard」）
      if (state.bareOptions && t.length <= 40 && !/[。！？!?；;]$/.test(t)) {
        cur.options.push({ shape: 'none', index: null, label: t })
        continue
      }
      // 选项的补充说明：短语、没有句末标点、也没带新题号
      const looksLikeNote = last && !last.desc && t.length <= 60 && !/[。！？!?]$/.test(t) && !NUM_PREFIX.test(t)
      if (looksLikeNote) { last.desc = t; continue }
      // 一句话写完、后面紧跟选项：这是下一题的题干（「哪两个是数据库？」「判断：xxx」）
      if (/[?？]\s*$/.test(t) || inlineTypePrefix(t)) {
        open(raw)
        const prefix = inlineTypePrefix(t)
        if (prefix) { cur.typeWord = prefix.word; cur.declType = prefix.type }
        addToStem(cur, (cur.firstLine.trim() || t).replace(INLINE_TYPE_TAG, '$1'))
        finishStem(cur)
        if (pending.type) cur.declType = pending.type
        pending = { type: null, props: {} }
        state = { mode: 'stem' }
        continue
      }
      addToStem(cur, t)
      state = { mode: 'stem' }
      continue
    }
    // 上一个块的题干还没配上任何选项：这一行是它的题干，不是下一题（「① 题目？」「H2/SQLite」）
    // 上一题的题干还「没说完」（没有句末标点）时，这一行算它的续写。
    // 但圈号开头的一定是新题的题号，不能粘给上一题
    if (prev === 'stem' && cur && !/^[①-⑳]/.test(t) && !/[。？?！!；;]$/.test(cur.stems[cur.stems.length - 1] || '')) { addToStem(cur, t); continue }

    // 单独一行的「[单选]」：声明下一题的题型
    const bare = LEAD_TAG.exec(t)
    if (bare && !t.slice(bare[0].length).trim()) {
      const ty = matchType(bare[1])
      if (ty) { pending = { type: ty, props: {}, blank: true }; state = { mode: 'idle' }; continue }
    }
    if (CHOICE_WORDS.test(t) || JUDGE_WORDS.has(t.toLowerCase())) {
      const ty = matchType(t)
      if (ty) { pending = { type: ty, props: {}, blank: true }; state = { mode: 'idle' }; continue }
    }

    open(raw)
    addToStem(cur, cur.firstLine.trim() || t)
    finishStem(cur)
    if (pending.type) cur.declType = pending.type
    if (pending.props) cur.props = { ...pending.props }
    pending = { type: null, props: {} }
    state = { mode: 'stem' }
  }

  const fields = []
  const fieldDrops = new Map()
  for (const b of blocks) {
    if (!b.stems.length && !b.options.length) continue
    const f = blockToField(b)
    if (!f.label && !f.options.length) continue
    // 选项后面还挂着说明文字的，合并进 label 会毁掉整个题干，所以放进 desc
    const desc = b.options.filter(o => o.desc).map(o => `${o.label} — ${o.desc}`).join('；')
    if (desc) f.description = desc
    fieldDrops.set(f, f.dropped || [])
    delete f.dropped
    fields.push(f)
  }
  // normalizeSchema 会重建每个字段（丢掉挂上去的临时信息），剔除记录在规范化之后补回去
  const out = normalizeSchema(fields)
  out.forEach((f, i) => {
    const dropped = fieldDrops.get(fields[i])
    if (dropped?.length) f.dropped = dropped
  })
  return out
}
