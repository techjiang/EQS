import crypto from 'node:crypto'
import { get, all, run, now } from './db.js'

export const FIELD_TYPES = [
  'text', 'textarea', 'number', 'date', 'datetime', 'time', 'select', 'radio', 'checkbox',
  'switch', 'rate', 'nps', 'slider', 'upload', 'file', 'sort', 'cascader', 'carousel',
  'location', 'phone', 'email', 'idcard', 'matrix', 'subform', 'signature', 'qrcode',
  'divider', 'richtext', 'image', 'html', 'captcha'
]

const CHOICE = new Set(['select', 'radio', 'checkbox', 'sort', 'cascader', 'carousel', 'matrix'])

export function normalizeField(f, i = 0) {
  const type = FIELD_TYPES.includes(f.type) ? f.type : 'text'
  const out = {
    id: f.id || 'f_' + crypto.randomBytes(5).toString('hex'),
    type,
    label: String(f.label ?? `题目 ${i + 1}`),
    // 空字符串要理解成「没填」：否则评分题 / NPS 的默认值 '' 会静默清空 0 分作答
    required: f.required === true || f.required === 'true' || f.required === 1,
    placeholder: f.placeholder || '',
    description: f.description || '',
    options: Array.isArray(f.options) ? f.options.map(o => (typeof o === 'string' ? { label: o, value: o } : { label: String(o.label ?? ''), value: String(o.value ?? o.label ?? '') })) : [],
    defaultValue: f.defaultValue ?? '',
    score: Number(f.score) || 0,
    answer: Array.isArray(f.answer) ? f.answer : (f.answer ? [f.answer] : []),
    analysis: f.analysis || '',
    logic: Array.isArray(f.logic) ? f.logic : [],
    props: typeof f.props === 'object' && f.props ? f.props : {}
  }
  if (CHOICE.has(type) && out.options.length === 0 && type !== 'matrix') {
    out.options = [{ label: '选项 1', value: '选项 1' }, { label: '选项 2', value: '选项 2' }]
  }
  if (type === 'matrix' && !out.props.rows) {
    out.props.rows = ['行 1', '行 2']
    out.options = [{ label: '很满意', value: '5' }, { label: '满意', value: '4' }, { label: '一般', value: '3' }]
  }
  if (type === 'nps') {
    out.props.max = Number(out.props.max) || 10
    // 0 是合法下限，不能用 || 兜底
    out.props.min = out.props.min === undefined || out.props.min === null || out.props.min === '' ? 0 : Number(out.props.min)
  }
  if (type === 'rate') out.props.max = Number(out.props.max) || 5
  if (type === 'slider') { out.props.min ??= 0; out.props.max ??= 100; out.props.step ??= 1 }
  return out
}

export function normalizeSchema(schema) {
  if (!Array.isArray(schema)) return []
  return schema.map(normalizeField)
}

export function parseForm(row) {
  if (!row) return null
  return {
    ...row,
    schema: safeJson(row.schema, []),
    settings: safeJson(row.settings, {})
  }
}

export function safeJson(str, fallback) {
  try { const v = JSON.parse(str); return v ?? fallback } catch { return fallback }
}

/** 条件显隐：{fieldId, op, value} 全部满足才显示；logic 为空=总是显示 */
export function fieldVisible(field, data) {
  const rules = field.logic || []
  if (!rules.length) return true
  return rules.every(r => {
    const v = data[r.fieldId]
    const target = r.value
    switch (r.op) {
      case 'eq': return String(flat(v)) === String(target)
      case 'ne': return String(flat(v)) !== String(target)
      case 'in': return Array.isArray(target) ? target.map(String).includes(String(flat(v))) : String(flat(v)) === String(target)
      case 'gt': return Number(flat(v)) > Number(target)
      case 'lt': return Number(flat(v)) < Number(target)
      case 'contains': return Array.isArray(v) ? v.map(String).includes(String(target)) : String(flat(v)).includes(String(target))
      case 'empty': return flat(v) === '' || flat(v) == null
      case 'notEmpty': return !(flat(v) === '' || flat(v) == null)
      default: return true
    }
  })
}

const flat = v => (Array.isArray(v) ? v.join(',') : v)

/** 算式验证码的题面（与前端 renderer.js 中 captchaChallenge 保持一致） */
export function captchaChallenge(id) {
  const sum = String(id || '').split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) || 1
  return { a: (sum % 7) + 2, b: (sum % 5) + 2 }
}

export function validateSubmission(schema, data) {
  const errors = []
  for (const f of schema) {
    if (!fieldVisible(f, data)) continue
    if (['divider', 'richtext', 'image', 'html'].includes(f.type)) continue
    const v = data[f.id]
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
    if (f.required && empty) { errors.push(`${f.label} 为必填项`); continue }
    if (empty) continue
    if (f.type === 'phone' && !/^1[3-9]\d{9}$/.test(String(v))) errors.push(`${f.label} 手机号格式不正确`)
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) errors.push(`${f.label} 邮箱格式不正确`)
    if (f.type === 'idcard' && !/^\d{17}[\dXx]$/.test(String(v))) errors.push(`${f.label} 身份证号格式不正确`)
    if (f.type === 'number' && Number.isNaN(Number(v))) errors.push(`${f.label} 必须是数字`)
    if (f.type === 'captcha') {
      const { a, b } = captchaChallenge(f.id)
      if (String(v).trim() !== String(a + b)) errors.push(`${f.label} 校验不通过，请重新计算`)
    }
    const min = Number(f.props?.minLength)
    if (min && String(v).length < min) errors.push(`${f.label} 至少 ${min} 个字符`)
    const max = Number(f.props?.maxLength)
    if (max && String(v).length > max) errors.push(`${f.label} 最多 ${max} 个字符`)
  }
  return errors
}

const isBlank = v => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/**
 * 考试评分
 * 三类题分开算：有标准答案的自动判；没标准答案但有人工给分的按人工分计；
 * 既没答案也没人批的主观题，只算进卷面总分，不进可判分总分——否则「全对也永远不及格」。
 * @param manual { [fieldId]: number } 老师给的分
 */
export function gradeSubmission(schema, data, settings = {}, manual = {}) {
  let total = 0
  let got = 0
  let scored = 0
  let ungraded = 0
  let paperTotal = 0
  for (const f of schema) {
    if (!f.score || !fieldVisible(f, data)) continue
    paperTotal += f.score
    if (f.answer?.length) {
      total += f.score
      scored++
      const v = data[f.id]
      const given = (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).map(String).sort()
      const right = f.answer.map(String).sort()
      if (given.length === right.length && given.every((x, i) => x === right[i])) got += f.score
      continue
    }
    const m = manual?.[f.id]
    if (m === undefined || m === null || m === '') { ungraded++; continue }
    // 人工分约束在 [0, 该题分值] 之间，防止手抖填出超纲分数
    total += f.score
    scored++
    got += Math.min(f.score, Math.max(0, Number(m) || 0))
  }
  const score = Math.round(got * 100) / 100
  const passLine = passLineOf(settings, total)
  return { score, total, paperTotal, ungraded, passLine, passed: score >= passLine, graded: scored > 0 }
}

/** 从答卷记录里取人工批阅分：{ [fieldId]: number } */
export function manualScoresOf(row) {
  if (!row?.manual_scores) return {}
  try {
    const v = JSON.parse(row.manual_scores)
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}

/** 需要在及格线之外单独告知的提示，避免「满分 40 却显示 75」这类口径误会 */
export function passHintOf(settings = {}, total = 0, paperTotal = 0) {
  const passLine = passLineOf(settings, total)
  if (paperTotal > total) return `及格线按可判分题目总分 ${total} 分计算，卷面总分 ${paperTotal} 分，另有主观题待人工批阅`
  return `满分 ${total} 分 · 及格线 ${passLine} 分`
}

/** 及格线：优先按总分百分比（passPercent），否则回退到绝对分（passScore），默认 60% */
export function passLineOf(settings = {}, total = 0) {
  const percent = Number(settings.passPercent)
  if (Number.isFinite(percent) && percent > 0) return Math.round(total * Math.min(percent, 100)) / 100
  const abs = Number(settings.passScore)
  if (Number.isFinite(abs) && abs > 0) return abs
  return Math.ceil(total * 0.6 * 100) / 100
}

export function computeStats(form, submissions) {
  const schema = form.schema
  const list = []
  for (const f of schema) {
    if (['divider', 'richtext', 'html', 'image'].includes(f.type)) continue
    const values = submissions.map(s => s.data[f.id]).filter(v => v !== undefined && v !== null && v !== '')
    const item = { id: f.id, label: f.label, type: f.type, count: values.length }
    if (['radio', 'select', 'checkbox', 'sort', 'carousel', 'rate', 'nps', 'switch'].includes(f.type)) {
      const counts = {}
      for (const v of values) {
        for (const one of (Array.isArray(v) ? v : [v])) counts[String(one)] = (counts[String(one)] || 0) + 1
      }
      let optionPairs = f.options.map(o => ({ name: o.label, value: counts[o.value] || 0 }))
      if (f.type === 'rate' || f.type === 'nps') {
        const max = Number(f.props?.max) || (f.type === 'nps' ? 10 : 5)
        // 与前端 renderer 的 npsRange 同口径，否则 -2 这类负档位的作答在报表里凭空消失
        const from = f.type === 'nps' ? Number(f.props?.min ?? 0) : 1
        optionPairs = Array.from({ length: Math.max(0, max - from + 1) }, (_, i) => ({ name: String(from + i), value: counts[String(from + i)] || 0 }))
      }
      item.series = optionPairs
      item.average = values.length ? Math.round((values.reduce((a, b) => a + (Number(flat(b)) || 0), 0) / values.length) * 100) / 100 : 0
    } else if (f.type === 'matrix') {
      item.series = (f.props?.rows || []).map(row => {
        const rowVals = values.map(v => v?.[row]).filter(Boolean)
        const avg = rowVals.length ? rowVals.reduce((a, b) => a + (Number(b) || 0), 0) / rowVals.length : 0
        return { name: row, value: Math.round(avg * 100) / 100 }
      })
    } else if (f.type === 'number' || f.type === 'slider') {
      const nums = values.map(Number).filter(n => !Number.isNaN(n))
      item.average = nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : 0
      item.max = nums.length ? Math.max(...nums) : 0
      item.min = nums.length ? Math.min(...nums) : 0
      item.count = nums.length
    } else {
      item.samples = values.slice(0, 20).map(v => String(flat(v)).slice(0, 60))
    }
    list.push(item)
  }
  const byDay = {}
  for (const s of submissions) {
    const d = String(s.created_at).slice(0, 10)
    byDay[d] = (byDay[d] || 0) + 1
  }
  const trend = Object.keys(byDay).sort().map(d => ({ date: d, count: byDay[d] }))
  const scores = submissions.map(s => s.score).filter(v => v != null)
  return {
    total: submissions.length,
    trend,
    avgScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null,
    passRate: submissions.filter(s => s.passed === 1).length,
    questions: list
  }
}

export function pickForm(id, { withDeleted = false } = {}) {
  const row = get(`SELECT * FROM forms WHERE id = ? ${withDeleted ? '' : 'AND deleted_at IS NULL'}`, Number(id))
  return parseForm(row)
}

export function submissionData(row) {
  return { ...row, data: safeJson(row.data, {}) }
}

export function paginate(req, total) {
  const url = new URL(req.url, 'http://x')
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
  const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize')) || 20))
  return { page, pageSize, offset: (page - 1) * pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 }
}

export { now }
