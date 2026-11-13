import { get, all, run, now, db } from '../lib/db.js'
import { readJson, fail, sendJson } from '../lib/http.js'
import { requireUser, requirePerm, currentUser, can } from '../lib/auth.js'
import { normalizeSchema, parseForm, pickForm, paginate, safeJson } from '../lib/forms.js'
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
    run('DELETE FROM submissions WHERE form_id = ?', form.id)
    run('DELETE FROM forms WHERE id = ?', form.id)
    log(user, '彻底删除表单', `${form.title} #${form.id}`)
    sendJson(res, 200, { ok: true })
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
    const schema = [...form.schema, ...fields]
    run('UPDATE forms SET schema = ?, updated_at = ? WHERE id = ?', JSON.stringify(schema), now(), form.id)
    sendJson(res, 200, { ok: true, added: fields.length, schema })
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
    const own = can(user, '*') ? '' : `WHERE created_by = ${user.id}`
    const forms = get(`SELECT COUNT(*) c FROM forms ${own ? own + ' AND' : 'WHERE'} deleted_at IS NULL`).c
    const published = get(`SELECT COUNT(*) c FROM forms ${own ? own + ' AND' : 'WHERE'} deleted_at IS NULL AND status = 'published'`).c
    const submissions = get(`SELECT COUNT(*) c FROM submissions WHERE deleted_at IS NULL`).c
    const today = get(`SELECT COUNT(*) c FROM submissions WHERE deleted_at IS NULL AND created_at >= ?`, new Date().toISOString().slice(0, 10)).c
    const trend = all(`SELECT substr(created_at,1,10) AS date, COUNT(*) AS count FROM submissions WHERE deleted_at IS NULL GROUP BY date ORDER BY date DESC LIMIT 14`).reverse()
    const recent = all(`SELECT s.id, s.form_id, s.created_at, f.title FROM submissions s JOIN forms f ON f.id = s.form_id WHERE s.deleted_at IS NULL ORDER BY s.id DESC LIMIT 8`)
    const users = get('SELECT COUNT(*) c FROM users').c
    sendJson(res, 200, { ok: true, data: { forms, published, submissions, today, users, trend, recent } })
  })
}

/** 文本题干解析：支持 “1. 标题 [单选]”、“[多选] 标题”、“A. 选项”、“- 选项”、“答案: A”、“分值: 5” 等写法 */
const TYPE_WORDS = [
  ['单选', 'radio'], ['多选', 'checkbox'], ['下拉', 'select'], ['判断', 'judge'],
  ['填空', 'text'], ['单行', 'text'], ['简答', 'textarea'], ['问答', 'textarea'], ['多行', 'textarea'],
  ['日期时间', 'datetime'], ['日期', 'date'], ['时间', 'time'], ['评分', 'rate'], ['量表', 'nps'],
  ['上传', 'upload'], ['手机', 'phone'], ['邮箱', 'email'], ['身份证', 'idcard'], ['矩阵', 'matrix'],
  ['排序', 'sort'], ['定位', 'location'], ['签名', 'signature'], ['级联', 'cascader'],
  ['轮播', 'carousel'], ['开关', 'switch'], ['数字', 'number'],
  ['single choice', 'radio'], ['multiple choice', 'checkbox'], ['choose one', 'radio'],
  ['true/false', 'judge'], ['true or false', 'judge'], ['judge', 'judge'], ['dropdown', 'select'],
  ['radio', 'radio'], ['checkbox', 'checkbox'], ['textarea', 'textarea'], ['text', 'text'],
  ['number', 'number'], ['date', 'date'], ['rating', 'rate'], ['upload', 'upload']
]

const CHOICE_TYPES = ['radio', 'checkbox', 'select', 'sort', 'carousel', 'cascader']

function matchType(word = '') {
  const w = String(word).trim()
  if (!w) return null
  const lower = w.toLowerCase()
  for (const [key, type] of TYPE_WORDS) {
    if (w.includes(key) || (key.length > 2 && lower.includes(key))) return type
  }
  return null
}

const TAG_AT = /[\[【(（]\s*([^\]】)）]{1,20})\s*[\]】)）]/
const TAG_START = /^\s*[\[【(（]\s*([^\]】)）]{1,20})\s*[\]】)）]\s*/

export function parseTextToFields(text) {
  const lines = String(text).replace(/\r/g, '').split('\n')
  const fields = []
  let cur = null
  let pendingType = null

  const isJudge = (label, type) => type === 'judge' || (!type && /判断/.test(label))

  const flush = () => {
    if (cur && cur.label) {
      if (isJudge(cur.label, cur.type)) {
        cur.type = 'radio'
        if (!cur.options.length) cur.options = [{ label: '正确', value: '正确' }, { label: '错误', value: '错误' }]
      } else if (!cur.options.length && CHOICE_TYPES.includes(cur.type)) {
        // 未显式声明题型且没有任何选项：按填空题处理，避免凭空造出选项
        cur.type = cur.explicit ? 'radio' : 'text'
        if (cur.explicit && cur.type === 'radio') cur.options = [{ label: '选项 1', value: '选项 1' }, { label: '选项 2', value: '选项 2' }]
      }
      delete cur.explicit
      fields.push(cur)
    }
    cur = null
  }

  const startField = (title, type, required) => {
    flush()
    cur = {
      explicit: type !== 'radio' ? true : false,
      id: 'f_' + Math.random().toString(36).slice(2, 9),
      type, label: title, required,
      options: [], placeholder: '', description: '', defaultValue: '', score: 0,
      answer: [], analysis: '', logic: [], props: {}
    }
  }

  const pushOption = (label) => {
    const v = String(label).trim()
    if (!v) return
    cur.options.push({ label: v, value: v })
  }

  const canTakeOption = () => !!cur && (cur.options.length > 0 || CHOICE_TYPES.includes(cur.type) || isJudge(cur.label, cur.type))

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { pendingType = null; continue }

    // 元信息行
    const answerMatch = /^(?:答案|正确答案)[:：]\s*(.*)$/.exec(line)
    if (answerMatch && cur) {
      cur.answer = answerMatch[1]
        .split(/[,，;；、\s]+/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(tok => {
          const letter = /^[A-Za-z]$/.test(tok) ? tok.toUpperCase().charCodeAt(0) - 65 : -1
          if (letter >= 0 && cur.options[letter]) return cur.options[letter].value
          const byLabel = cur.options.find(o => o.label === tok)
          return byLabel ? byLabel.value : tok
        })
      continue
    }
    const scoreMatch = /^(?:分值|分数)[:：]\s*(\d+(?:\.\d+)?)/.exec(line)
    if (scoreMatch && cur) { cur.score = Number(scoreMatch[1]); continue }
    const analysisMatch = /^(?:解析|说明)[:：]\s*(.+)$/.exec(line)
    if (analysisMatch && cur) { cur.analysis = analysisMatch[1]; continue }
    const prefixType = /^(单选|多选|判断|填空|简答|问答|下拉|评分|排序|矩阵)(?:题)?\s*[:：]\s*(.+)$/.exec(line)
    const typeLine = prefixType || /^(?:题型|类型)[:：]\s*(.+)$/.exec(line)
    if (typeLine) {
      if (prefixType) {
        // 「判断题：xxx」这类前缀，题型与题干在同一行
        const declared = matchType(prefixType[1])
        startField(prefixType[2].trim(), declared || 'radio')
        cur.explicit = !!declared
        if (isJudge(cur.label, declared)) {
          cur.type = 'radio'
          cur.options = [{ label: '正确', value: '正确' }, { label: '错误', value: '错误' }]
          cur.judgePreset = true
        }
      } else pendingType = matchType(typeLine[1]) || pendingType
      continue
    }

    // 只有题型标签的独立行：声明下一题（或当前题）的题型
    const bareTag = TAG_START.exec(line) && line.slice(TAG_START.exec(line)[0].length).trim() === ''
    if (bareTag) {
      const t = matchType(TAG_START.exec(line)[1])
      if (t) {
        if (cur) { cur.type = t === 'judge' ? 'radio' : t; cur.explicit = true }
        else pendingType = t
      }
      continue
    }

    // 选项行
    const letterOpt = /^[A-Za-z][.、)．]\s*(.+)$/.exec(line)
    if (letterOpt && cur) {
      if (cur.judgePreset) { cur.options = []; cur.judgePreset = false }
      pushOption(letterOpt[1])
      continue
    }
    const bulletOpt = /^[-*+]\s+(.+)$/.exec(line)
    if (bulletOpt) {
      if (canTakeOption()) pushOption(bulletOpt[1])
      else { startField(bulletOpt[1], pendingType || 'radio'); pendingType = null }
      continue
    }

    // 题目标题
    const startTag = TAG_START.exec(line)
    const endTag = !startTag ? TAG_AT.exec(line) : null
    const tagged = startTag ? matchType(startTag[1]) : (endTag ? matchType(endTag[1]) : null)
    let body = line
    if (startTag && tagged) body = line.slice(startTag[0].length).trim()
    else if (endTag && tagged) body = (line.slice(0, endTag.index) + line.slice(endTag.index + endTag[0].length)).trim()

    let title = body.replace(/^#{1,4}\s*/, '').replace(/^(?:\d+[.、)．]|[（(]\d+[)）])\s*/, '').trim()
    const numbered = /^(?:\d+[.、)．]|[（(]\d+[)）])\s*/.test(body)
    const heading = /^#{1,4}\s/.test(body)
    const asks = /[?？]\s*$/.test(title)
    const hasTag = !!tagged

    // Markdown 分节标题（无序号、无题型、非提问）当分节，不生成题目
    if (heading && !numbered && !hasTag && !asks) continue

    if (hasTag || numbered || asks || !cur) {
      const required = /[\*＊]\s*$/.test(title) || /必填/.test(line)
      title = title.replace(/[\*＊]\s*$/, '').trim()
      const declared = tagged || pendingType
      startField(title, declared || 'radio', required)
      cur.explicit = !!declared
      pendingType = null
      // 判断题立刻补上对错选项，后续「答案：A」才能正确映射为「正确」
      if (isJudge(title, declared)) {
        cur.type = 'radio'
        cur.options = [{ label: '正确', value: '正确' }, { label: '错误', value: '错误' }]
        cur.judgePreset = true
      }
      continue
    }

    // 其余：有选项就当选项，否则续到题干
    if (canTakeOption()) pushOption(line)
    else cur.label = (cur.label + ' ' + line).trim()
  }
  flush()
  return normalizeSchema(fields.filter(f => f.label))
}
