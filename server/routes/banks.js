import { get, all, run, now, log } from '../lib/db.js'
import { readJson, fail, sendJson } from '../lib/http.js'
import { requireUser, requirePerm, can } from '../lib/auth.js'
import { normalizeField, paginate, safeJson, gradeSubmission } from '../lib/forms.js'
import { parseTextToFields } from './forms.js'

const parseQ = q => ({ ...q, options: safeJson(q.options, []), answer: safeJson(q.answer, []) })

export default function register(r) {
  r.get('/api/banks', async (req, res) => {
    const user = requireUser(req)
    const url = new URL(req.url, 'http://x')
    const keyword = url.searchParams.get('keyword')
    const where = ['b.deleted_at IS NULL']
    const args = []
    if (!can(user, '*')) { where.push('b.owner_id = ?'); args.push(user.id) }
    if (keyword) { where.push('b.name LIKE ?'); args.push(`%${keyword}%`) }
    const rows = all(`SELECT b.*, (SELECT COUNT(*) FROM questions q WHERE q.bank_id = b.id AND q.deleted_at IS NULL) AS question_count
      FROM banks b WHERE ${where.join(' AND ')} ORDER BY b.id DESC`, ...args)
    sendJson(res, 200, { ok: true, data: rows })
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
    const bank = get('SELECT * FROM banks WHERE id = ? AND deleted_at IS NULL', Number(params.id))
    if (!bank) fail(404, '题库不存在')
    if (!can(user, '*') && bank.owner_id !== user.id) fail(403, '无权修改')
    const body = await readJson(req)
    run('UPDATE banks SET name = ?, description = ? WHERE id = ?', body.name ?? bank.name, body.description ?? bank.description, bank.id)
    sendJson(res, 200, { ok: true })
  })

  r.delete('/api/banks/:id', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const bank = get('SELECT * FROM banks WHERE id = ? AND deleted_at IS NULL', Number(params.id))
    if (!bank) fail(404, '题库不存在')
    if (!can(user, '*') && bank.owner_id !== user.id) fail(403, '无权删除')
    run('UPDATE banks SET deleted_at = ? WHERE id = ?', now(), bank.id)
    sendJson(res, 200, { ok: true })
  })

  r.get('/api/banks/:id/questions', async (req, res, { params }) => {
    const user = requireUser(req)
    const bank = get('SELECT * FROM banks WHERE id = ? AND deleted_at IS NULL', Number(params.id))
    if (!bank) fail(404, '题库不存在')
    const url = new URL(req.url, 'http://x')
    const keyword = url.searchParams.get('keyword')
    const type = url.searchParams.get('type')
    const where = ['bank_id = ?', 'deleted_at IS NULL']
    const args = [bank.id]
    if (keyword) { where.push('title LIKE ?'); args.push(`%${keyword}%`) }
    if (type) { where.push('type = ?'); args.push(type) }
    const rows = all(`SELECT * FROM questions WHERE ${where.join(' AND ')} ORDER BY id ASC`, ...args).map(parseQ)
    sendJson(res, 200, { ok: true, data: rows, total: rows.length })
  })

  r.post('/api/banks/:id/questions', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const bank = get('SELECT * FROM banks WHERE id = ? AND deleted_at IS NULL', Number(params.id))
    if (!bank) fail(404, '题库不存在')
    const body = await readJson(req)
    const items = Array.isArray(body.items) ? body.items : [body]
    const ids = []
    for (const item of items) {
      const f = normalizeField(item)
      if (!f.label) continue
      const result = run('INSERT INTO questions(bank_id, type, title, options, answer, analysis, score, tags, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        bank.id, f.type, f.label, JSON.stringify(f.options), JSON.stringify(f.answer), f.analysis, f.score || 5, body.tags || '', now())
      ids.push(Number(result.lastInsertRowid))
    }
    sendJson(res, 201, { ok: true, ids })
  })

  r.put('/api/questions/:id', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const q = get('SELECT * FROM questions WHERE id = ? AND deleted_at IS NULL', Number(params.id))
    if (!q) fail(404, '题目不存在')
    const body = await readJson(req)
    const f = normalizeField({ ...parseQ(q), ...body })
    run('UPDATE questions SET type = ?, title = ?, options = ?, answer = ?, analysis = ?, score = ?, tags = ? WHERE id = ?',
      f.type, f.label, JSON.stringify(f.options), JSON.stringify(f.answer), f.analysis, f.score, body.tags ?? q.tags, q.id)
    sendJson(res, 200, { ok: true })
  })

  r.delete('/api/questions/:id', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const q = get('SELECT * FROM questions WHERE id = ?', Number(params.id))
    if (!q) fail(404, '题目不存在')
    run('UPDATE questions SET deleted_at = ? WHERE id = ?', now(), q.id)
    sendJson(res, 200, { ok: true })
  })

  /** 批量导入题目（文本） */
  r.post('/api/banks/:id/import-text', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const bank = get('SELECT * FROM banks WHERE id = ? AND deleted_at IS NULL', Number(params.id))
    if (!bank) fail(404, '题库不存在')
    const { text } = await readJson(req)
    const fields = parseTextToFields(String(text || ''))
    if (!fields.length) fail(400, '未识别到题目')
    for (const f of fields) {
      run('INSERT INTO questions(bank_id, type, title, options, answer, analysis, score, created_at) VALUES(?,?,?,?,?,?,?,?)',
        bank.id, f.type, f.label, JSON.stringify(f.options), JSON.stringify(f.answer), f.analysis, f.score || 5, now())
    }
    sendJson(res, 200, { ok: true, imported: fields.length })
  })

  /** 组卷：按题库随机抽题生成考试 */
  r.post('/api/banks/:id/paper', async (req, res, { params }) => {
    const user = requirePerm(req, 'bank:write')
    const bank = get('SELECT * FROM banks WHERE id = ? AND deleted_at IS NULL', Number(params.id))
    if (!bank) fail(404, '题库不存在')
    const body = await readJson(req)
    const count = Math.max(1, Number(body.count) || 10)
    const rows = all('SELECT * FROM questions WHERE bank_id = ? AND deleted_at IS NULL ORDER BY RANDOM() LIMIT ?', bank.id, count).map(parseQ)
    if (!rows.length) fail(400, '题库中没有题目')
    const schema = rows.map(q => normalizeField({
      type: q.type, label: q.title, options: q.options, answer: q.answer,
      analysis: q.analysis, score: q.score
    }))
    const ts = now()
    const settings = {
      passPercent: Number(body.passPercent) > 0 ? Number(body.passPercent) : 60,
      duration: Number(body.duration) || 60
    }
    const result = run('INSERT INTO forms(title, description, kind, schema, settings, status, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      body.title || `${bank.name} - 试卷`, body.description || '由题库智能组卷生成', 'exam', JSON.stringify(schema),
      JSON.stringify(settings), 'draft', user.id, ts, ts)
    sendJson(res, 201, { ok: true, id: Number(result.lastInsertRowid), count: schema.length, settings })
  })

  /** 刷题：拉取题目（不返回答案） */
  r.get('/api/banks/:id/practice', async (req, res, { params }) => {
    const user = requireUser(req)
    const bank = get('SELECT * FROM banks WHERE id = ? AND deleted_at IS NULL', Number(params.id))
    if (!bank) fail(404, '题库不存在')
    const url = new URL(req.url, 'http://x')
    const mode = url.searchParams.get('mode') || 'sequence'
    const rows = all('SELECT * FROM questions WHERE bank_id = ? AND deleted_at IS NULL ORDER BY id ASC', bank.id).map(parseQ)
    if (!rows.length) fail(400, '题库暂无题目')
    const record = get('SELECT * FROM practice_records WHERE bank_id = ? AND user_id = ?', bank.id, user.id)
    const wrongIds = record ? safeJson(record.wrong_ids, []) : []
    const favoriteIds = record ? safeJson(record.favorite_ids, []) : []
    const notes = record ? safeJson(record.notes, {}) : {}
    let list = rows
    if (mode === 'random') list = [...rows].sort(() => Math.random() - 0.5)
    if (mode === 'wrong') list = rows.filter(q => wrongIds.includes(q.id))
    if (mode === 'favorite') list = rows.filter(q => favoriteIds.includes(q.id))
    const safeList = list.map(q => ({
      id: q.id, type: q.type, title: q.title, options: q.options, analysis: '',
      score: q.score, favorite: favoriteIds.includes(q.id), note: notes[q.id] || ''
    }))
    sendJson(res, 200, {
      ok: true,
      data: { bank: { id: bank.id, name: bank.name }, mode, questions: safeList, progress: record?.progress || 0, wrongCount: wrongIds.length, favoriteCount: favoriteIds.length }
    })
  })

  /** 刷题判题 + 记录进度 */
  r.post('/api/banks/:id/practice/answer', async (req, res, { params }) => {
    const user = requireUser(req)
    const bank = get('SELECT * FROM banks WHERE id = ? AND deleted_at IS NULL', Number(params.id))
    if (!bank) fail(404, '题库不存在')
    const body = await readJson(req)
    const q = get('SELECT * FROM questions WHERE id = ? AND bank_id = ? AND deleted_at IS NULL', Number(body.questionId), bank.id)
    if (!q) fail(404, '题目不存在')
    const parsed = parseQ(q)
    const raw = (Array.isArray(body.value) ? body.value : [body.value]).filter(v => v !== undefined && v !== null && v !== '')
    // 允许前端直接传选项字母（A/B/…），统一归一化为选项值
    const given = raw.map(v => {
      const tok = String(v).trim()
      if (/^[A-Za-z]$/.test(tok)) {
        const opt = parsed.options[tok.toUpperCase().charCodeAt(0) - 65]
        if (opt) return String(opt.value)
      }
      return tok
    }).sort()
    const right = parsed.answer.map(String).sort()
    const correct = given.length === right.length && given.every((x, i) => x === right[i])
    let record = get('SELECT * FROM practice_records WHERE bank_id = ? AND user_id = ?', bank.id, user.id)
    if (!record) {
      run('INSERT INTO practice_records(bank_id, user_id, mode, progress, right_ids, wrong_ids, favorite_ids, notes, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        bank.id, user.id, 'sequence', 0, '[]', '[]', '[]', '{}', now())
      record = get('SELECT * FROM practice_records WHERE bank_id = ? AND user_id = ?', bank.id, user.id)
    }
    const rightIds = new Set(safeJson(record.right_ids, []))
    const wrongIds = new Set(safeJson(record.wrong_ids, []))
    const streak = safeJson(record.notes, {}).__streak || {}
    const req2 = Number(body.streakToClear) || 0
    if (correct) {
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
      correct,
      answer: parsed.answer,
      analysis: parsed.analysis,
      wrongCount: wrongIds.size,
      favorite: favoriteIds.has(q.id)
    })
  })

  r.get('/api/banks/:id/progress', async (req, res, { params }) => {
    const user = requireUser(req)
    const record = get('SELECT * FROM practice_records WHERE bank_id = ? AND user_id = ?', Number(params.id), user.id)
    if (!record) return sendJson(res, 200, { ok: true, data: null })
    const notes = safeJson(record.notes, {})
    sendJson(res, 200, {
      ok: true,
      data: {
        progress: record.progress,
        right: safeJson(record.right_ids, []).length,
        wrong: safeJson(record.wrong_ids, []).length,
        favorite: safeJson(record.favorite_ids, []).length,
        notes: Object.fromEntries(Object.entries(notes).filter(([k]) => k !== '__streak'))
      }
    })
  })
}
