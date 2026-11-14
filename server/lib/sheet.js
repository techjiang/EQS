import { normalizeField, coerceAnswerToField } from './forms.js'
import { buildXlsx, readXlsx } from './xlsx.js'

/* 表格 ↔ 题目：Excel 导入导出。
 *
 * 「Excel 导入」在 Issue 里是和 AI 创建、文本导入并列的一等功能，
 * 一直只有文本导入，用户拿着题库表格过来只能自己改成一坨纯文本。
 * 这里定义一张最小的表：题型 / 题干 / 选项 / 答案 / 分值 / 解析。
 * 列可以按表头名认（不要求顺序），也可以没有表头（按上面的顺序读）。
 */

const HEADERS = ['题型', '题干', '选项', '答案', '分值', '解析', '标签']

/** 中英文表头别名，兼容用户自己攒的模板 */
const ALIAS = {
  type: ['题型', '类型', 'type', '题目类型'],
  label: ['题干', '题目', '题目内容', 'title', 'label', 'question'],
  options: ['选项', '选项内容', 'options', 'option'],
  answer: ['答案', '正确答案', 'answer'],
  score: ['分值', '分数', '分', '得分', 'score', 'point', 'points'],
  analysis: ['解析', '答案解析', 'analysis', 'explain'],
  // 标签放最后：老表格没有这一列照样能导，新表格多一列也不会顶掉前六列的位置
  tags: ['标签', '分类', '知识点', 'tags', 'tag']
}

const TYPE_ALIAS = {
  单选: 'radio', 单选题: 'radio', radio: 'radio', single: 'radio',
  多选: 'checkbox', 多选题: 'checkbox', checkbox: 'checkbox', multiple: 'checkbox',
  判断: 'judge', 判断题: 'judge', 是非题: 'judge', truefalse: 'judge',
  填空: 'text', 填空题: 'text', 单行: 'text', 单行文本: 'text', text: 'text',
  简答: 'textarea', 简答题: 'textarea', 问答: 'textarea', 多行: 'textarea', 多行文本: 'textarea', textarea: 'textarea',
  下拉: 'select', 下拉框: 'select', select: 'select',
  评分: 'rate', 评分题: 'rate', 星级: 'rate', rate: 'rate',
  量表: 'nps', 量表题: 'nps', nps: 'nps',
  日期: 'date', date: 'date',
  数字: 'number', 数值: 'number', number: 'number',
  上传: 'upload', 附件: 'upload', upload: 'upload',
  手机: 'phone', 手机号: 'phone', phone: 'phone',
  邮箱: 'email', email: 'email',
  排序: 'sort', sort: 'sort',
  矩阵: 'matrix', 矩阵量表: 'matrix', matrix: 'matrix',
  滑动: 'slider', 滑动条: 'slider', slider: 'slider',
  签名: 'signature', signature: 'signature'
}

export function matchTypeWord(word) {
  const w = String(word || '').trim().toLowerCase().replace(/\s+/g, '')
  if (!w) return null
  return TYPE_ALIAS[w] || TYPE_ALIAS[w.replace(/题$/, '')] || null
}

/** 一行表头 → 列索引；认不出任何一列就返回 null（说明这张表没有表头） */
function headerMap(row) {
  const map = {}
  for (const [key, names] of Object.entries(ALIAS)) {
    const at = row.findIndex(v => {
      const s = String(v ?? '').trim().toLowerCase()
      return names.some(n => n === s)
    })
    if (at >= 0) map[key] = at
  }
  // 至少得认出「题干」，否则谈不上是题目表
  return map.label !== undefined ? map : null
}

/** 选项单元格 → 选项数组。支持「A.苹果 换行 B.香蕉」「①苹果」「苹果|香蕉」 */
export function splitOptions(raw) {
  const text = String(raw ?? '')
  if (!text.trim()) return []
  // 分隔符：换行优先；单行时用 | 或 ；
  const parts = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const list = parts.length > 1 ? parts : text.split(/[|｜;；]/).map(s => s.trim()).filter(Boolean)
  return list.map(p => {
    // 去掉序号前缀：A. A、 ① （1） 1) 1、
    const m = /^(?:[A-Za-z][.、)）:：]|[①②③④⑤⑥⑦⑧⑨⑩]|[（(]\d+[）)]|\d+[.、)）])\s*/.exec(p)
    return m ? p.slice(m[0].length).trim() : p
  }).filter(s => s !== '')
}

/** 把一个值解析成「题型」字段类型 */
function toType(word) {
  const t = matchTypeWord(word)
  if (t) return t
  const raw = String(word ?? '').trim()
  return raw ? null : null
}

/**
 * 表格 → 字段数组。
 * @returns {{ fields: Array, skipped: Array<{row:number, reason:string}> }}
 */
export function rowsToFields(rows) {
  if (!rows?.length) return { fields: [], skipped: [], unknownColumns: [] }
  let map = headerMap(rows[0])
  let start = 0
  if (map) start = 1
  else map = { type: 0, label: 1, options: 2, answer: 3, score: 4, analysis: 5, tags: 6 }

  const fields = []
  const skipped = []
  // 有表头但某一列既不是已知字段、又有内容：静默忽略它，用户会以为「这列导进去了」
  const known = new Set(Object.values(map))
  const unknownColumns = map.label !== undefined || start === 1
    ? (rows[0] || []).map((v, i) => ({ name: String(v ?? '').trim(), at: i }))
        .filter(c => c.name && !known.has(c.at) && rows.slice(1).some(r => String(r[c.at] ?? '').trim() !== ''))
        .map(c => c.name)
    : []
  for (let i = start; i < rows.length; i++) {
    const row = rows[i]
    const at = (k) => (map[k] === undefined ? '' : String(row[map[k]] ?? '').trim())
    const label = at('label')
    if (!label) { skipped.push({ row: i + 1, reason: '题干为空' }); continue }
    const declared = at('type')
    let type = toType(declared)
    const options = splitOptions(at('options'))
    const answerRaw = at('answer')
    const scoreRaw = at('score')

    // 没写题型时按内容推断：有选项且答案只有一个 → 单选；多个 → 多选；答案是正确/错误 → 判断
    if (!type) {
      const ansList = splitAnswer(answerRaw)
      if (options.length && /^(正确|错误|对|错|是|否|true|false|t|f)$/i.test(ansList.join(''))) type = 'judge'
      else if (options.length) type = ansList.length > 1 ? 'checkbox' : 'radio'
      else type = answerRaw ? 'text' : 'textarea'
    }
    // 声明了题型但没给出能落地的选项：选择题至少要有两个选项，否则这题永远答不了
    if (type === 'radio' || type === 'checkbox' || type === 'select') {
      if (options.length < 2) { skipped.push({ row: i + 1, reason: '选择题至少需要两个选项' }); continue }
    }

    const field = normalizeField({
      type,
      label,
      options: options.map(o => ({ label: o, value: o })),
      score: scoreRaw === '' ? 0 : Number(scoreRaw),
      analysis: at('analysis'),
      tags: at('tags')
    })
    // 表里写「单选」、选项却是「正确/错误」，本质就是判断题；
    // 不认这层，导出来再导回去题型会一路显示成「单选」，判断和单选就分不开了
    if (type === 'judge' || isJudgeOptions(field.options)) {
      field.type = 'radio'
      field.options = [{ label: '正确', value: '正确' }, { label: '错误', value: '错误' }]
      field.declType = 'judge'
    }
    field.answer = splitAnswer(answerRaw)
    if (field.score < 0 || !Number.isFinite(field.score)) field.score = 0
    coerceAnswerToField(field)
    // 答案必须落在选项上：指向不存在的选项等于这题谁答都错
    if (field.answer.length && field.options.length) {
      const values = new Set(field.options.map(o => String(o.value)))
      const kept = field.answer.filter(a => values.has(String(a)))
      if (kept.length !== field.answer.length) {
        const lost = field.answer.filter(a => !values.has(String(a)))
        field.answer = kept
        field.dropped = lost
      }
    }
    fields.push(field)
  }
  return { fields, skipped, unknownColumns }
}

/** 答案单元格 → 字符串数组。支持 A、A,C、A、B、正确、多行 */
export function splitAnswer(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return []
  return text
    .split(/[\s,，、;；|\/]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/** 解析上传的 xlsx（Buffer）。读不出来返回 null */
export function parseXlsx(buf) {
  return readXlsx(buf)
}

/** 题库题目 → 导出表格的行（含表头） */
export function questionsToRows(questions) {
  const rows = [HEADERS]
  for (const q of questions) {
    const opts = (q.options || []).map(o => String(o.label ?? o.value))
    rows.push([
      // 题库把判断题存成 radio + 正确/错误，导出照 type 写就是「单选」，
      // 人看着像自己写错了题型，导回去也再没有人认得出这是判断
      q.type === 'judge' || isJudgeOptions(opts) ? '判断' : typeName(q.type),
      q.title,
      (q.options || []).map((o, i) => `${String.fromCharCode(65 + i)}.${o.label ?? o.value}`).join('\n'),
      (q.answer || []).join(','),
      Number(q.score) || 0,
      q.analysis || '',
      q.tags || ''
    ])
  }
  return rows
}

/** 选项恰好是「正确/错误」两个：这就是判断题 */
export function isJudgeOptions(options) {
  const list = (options || []).map(o => String(o?.value ?? o?.label ?? o))
  return list.length === 2 && list.includes('正确') && list.includes('错误')
}

const TYPE_NAME = {
  radio: '单选', checkbox: '多选', select: '下拉', text: '填空', textarea: '简答',
  rate: '评分', nps: '量表', date: '日期', number: '数字', upload: '上传',
  phone: '手机', email: '邮箱', sort: '排序', matrix: '矩阵', slider: '滑动', signature: '签名'
}
function typeName(t) { return TYPE_NAME[t] || t }

/** 生成题库导入模板（含一行示例，用户照着改） */
export function templateXlsx() {
  return buildXlsx('题目', [
    HEADERS,
    ['单选', 'EQS 内置的数据库是？', 'A.MySQL\nB.SQLite 内嵌\nC.Oracle', 'B', 5, '内置 SQLite，开箱即用', '数据库,基础'],
    ['多选', '以下哪些是 EQS 的题型？', 'A.单选\nB.矩阵量表\nC.子表单', 'A,B,C', 10, '', '题型'],
    ['判断', 'EQS 支持私有化部署。', '', '正确', 5, '', '部署'],
    ['简答', '简述你对条件显隐的理解。', '', '', 10, '主观题，交卷后人工批阅', '表单逻辑']
  ])
}

/** 导出题目为 xlsx */
export function questionsXlsx(questions, sheetName = '题目') {
  return buildXlsx(sheetName, questionsToRows(questions))
}

/** 答卷导出：列来自表单 schema */
export function submissionsXlsx(form, rows) {
  const schema = (form.schema || []).filter(f => !['divider', 'richtext', 'html', 'image'].includes(f.type))
  const head = ['答卷编号', '提交时间', ...schema.map(f => f.label), '得分', '是否通过', '批阅状态']
  const cell = (v, f) => {
    if (v === undefined || v === null || v === '') return ''
    if (Array.isArray(v)) {
      if (v.some(x => x && typeof x === 'object')) {
        const labels = Object.fromEntries((f.props?.fields || []).map(sf => [sf.id, sf.label]))
        return v.map(r => Object.entries(r || {})
          .filter(([, x]) => x !== undefined && x !== null && String(x).trim() !== '')
          .map(([k, x]) => `${labels[k] || k}：${x}`).join(' / ')).filter(Boolean).join('\n')
      }
      return v.join(',')
    }
    if (typeof v === 'object') return JSON.stringify(v)
    return v
  }
  const out = [head]
  for (const r of rows) {
    out.push([
      r.public_id || String(r.id),
      String(r.created_at || '').replace('T', ' ').slice(0, 19),
      ...schema.map(f => cell(r.data?.[f.id], f)),
      r.score ?? '',
      form.kind === 'exam' ? (r.passed === 1 ? '通过' : r.passed === 0 ? '未通过' : '') : '',
      r.reviewed_at ? '已批阅' : (form.kind === 'exam' ? '待批阅' : '')
    ])
  }
  return buildXlsx(form.title || '答卷', out)
}
