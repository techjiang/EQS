import { get, all, run, now, log } from '../lib/db.js'
import { readJson, fail, sendJson } from '../lib/http.js'
import { requireUser, requirePerm, can } from '../lib/auth.js'
import { normalizeField, paginate, safeJson, gradeSubmission, coerceAnswerToField } from '../lib/forms.js'
import { parseTextToFields } from './forms.js'

const parseQ = q => ({ ...q, options: safeJson(q.options, []), answer: safeJson(q.answer, []) })

/**
 * 题库是「我的」资源：列表、组卷、删除都按 owner 过滤，
 * 但读题、刷题、看进度三处漏了同一道校验——任何登录用户换一个 id 就能读到别人题库的
 * 全部题目和标准答案（连做题都不需要），私有题库等于公开。
 */
function readableBank(user, id) {
  const bank = get('SELECT * FROM banks WHERE id = ? AND deleted_at IS NULL', Number(id))
  if (!bank) return null
  if (!can(user, '*') && bank.owner_id !== user.id) return null
  return bank
}

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

  /** 回收中心：题库列表（含被删题库下的题目数） */
  r.get('/api/banks/recycle', async (req, res) => {
    const user = requireUser(req)
    const where = ['b.deleted_at IS NOT NULL']
    const args = []
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
    if (!can(user, '*') && bank?.owner_id !== user.id) fail(403, '无权恢复')
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
    if (!can(user, '*') && bank.owner_id !== user.id) fail(403, '无权删除')
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
      coerceAnswerToField(f)
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
    coerceAnswerToField(f)
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
      run('INSERT INTO questions(bank_id, type, title, options, answer, analysis, score, created_at) VALUES(?,?,?,?,?,?,?,?)',
        bank.id, f.type, f.label, JSON.stringify(f.options), JSON.stringify(f.answer), f.analysis, f.score ?? 5, now())
    }
    sendJson(res, 200, { ok: true, imported: fields.length, droppedAnswers: dropped })
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
    const schema = rows.map(q => {
      // 题库认「正确答案：A」「正确」，卷面上的多选认 ['选项值']、判断认「正确/错误」。
      // 直接把题库里的答案搬进卷面，会出现「卷面显示作答 A 却判 0 分」——所以入库前统一口径。
      const f = normalizeField({
        type: q.type, label: q.title, options: q.options, answer: q.answer,
        analysis: q.analysis, score: q.score
      })
      if (!f.answer.length && q.answer?.length) f.answer = q.answer
      coerceAnswerToField(f)
      return f
    })
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

  /** 跨题库组卷：多个题库按比例抽题，或全库随机 */
  r.post('/api/banks/paper', async (req, res) => {
    const user = requirePerm(req, 'bank:write')
    const body = await readJson(req)
    const count = Math.max(1, Math.min(200, Number(body.count) || 10))
    const visible = can(user, '*')
      ? all('SELECT * FROM banks WHERE deleted_at IS NULL')
      : all('SELECT * FROM banks WHERE deleted_at IS NULL AND owner_id = ?', user.id)
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
    if (body.typeFilter) {
      const tf = pool.filter(q => q.type === body.typeFilter)
      if (tf.length) picked = tf
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
      const f = normalizeField({ type: p.type, label: p.title, options: p.options, answer: p.answer, analysis: p.analysis, score: p.score })
      if (!f.answer.length && p.answer?.length) f.answer = p.answer
      coerceAnswerToField(f)
      return f
    })
    const settings = {
      passPercent: Number(body.passPercent) > 0 ? Math.min(100, Number(body.passPercent)) : 60,
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
    const safeList = list.map(q => ({
      id: q.id, type: q.type, title: q.title, options: q.options, analysis: '',
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
    const raw = judging ? (Array.isArray(body.value) ? body.value : [body.value]).filter(v => v !== undefined && v !== null && v !== '') : []
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
    const correct = judging && given.length === right.length && given.every((x, i) => x === right[i])
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
