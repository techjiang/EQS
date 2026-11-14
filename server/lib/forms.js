import crypto from 'node:crypto'
import { get, all, run, now } from './db.js'
// 逻辑规则（显示 / 必填 / 计算 / 跳转 / 自动填入）与浏览器共用同一份实现。
// 各写一遍的下场在判分上已经演过：三个入口三套口径，同一道题三种结论。
import { buildFlow, resolveAnswers, renderText, evalFormula } from '../../web/js/flow.js'

export const FIELD_TYPES = [
  'text', 'textarea', 'number', 'date', 'datetime', 'time', 'select', 'radio', 'checkbox',
  'switch', 'rate', 'nps', 'slider', 'upload', 'file', 'sort', 'cascader', 'carousel',
  'location', 'phone', 'email', 'idcard', 'matrix', 'subform', 'signature', 'qrcode',
  'divider', 'richtext', 'image', 'html', 'captcha', 'calculate'
]

/** 只用于展示、不收作答也不参与判分的组件 */
export const DISPLAY_TYPES = new Set(['divider', 'richtext', 'html', 'image', 'calculate'])

const CHOICE = new Set(['select', 'radio', 'checkbox', 'sort', 'cascader', 'carousel', 'matrix'])

export function normalizeField(f, i = 0) {
  const type = FIELD_TYPES.includes(f.type) ? f.type : 'text'
  const out = {
    id: f.id || 'f_' + crypto.randomBytes(5).toString('hex'),
    type,
    // 题库侧的字段叫 title（`POST /api/banks/:id/questions` 的文档也是 title），
    // 表单侧叫 label。只认 label 的后果是：按文档建题，题干被静默写成「题目 1」，
    // 库里全是同名题——接口一脸 201，人却以为题干丢了。
    label: String(f.label ?? f.title ?? `题目 ${i + 1}`),
    // 空字符串要理解成「没填」：否则评分题 / NPS 的默认值 '' 会静默清空 0 分作答
    required: f.required === true || f.required === 'true' || f.required === 1,
    placeholder: f.placeholder || '',
    description: f.description || '',
    options: Array.isArray(f.options) ? f.options.map(o => (typeof o === 'string' ? { label: o, value: o } : { label: String(o.label ?? ''), value: String(o.value ?? o.label ?? '') })) : [],
    defaultValue: f.defaultValue ?? '',
    score: Number(f.score) || 0,
    answer: Array.isArray(f.answer) ? f.answer : (f.answer ? [f.answer] : []),
    analysis: f.analysis || '',
    // 标签只对题库/组卷有意义，但 schema 是前后端共用的结构，顺手带上，避免题型之外再开一条通道
    tags: typeof f.tags === 'string' ? f.tags : Array.isArray(f.tags) ? f.tags.join(',') : '',
    logic: Array.isArray(f.logic) ? f.logic : [],
    // 动态必填：满足时必填，否则可不填；为空则按 required
    requiredWhen: Array.isArray(f.requiredWhen) ? f.requiredWhen : [],
    // 条件跳转（提前结束）：命中则本题之后的题目作废，并显示 text
    jump: Array.isArray(f.jump) ? f.jump : [],
    // 自动填入：来源题有作答时，把值（可选经映射）填进空着的本题
    fill: f.fill && typeof f.fill === 'object' ? f.fill : null,
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
  if (type === 'subform') {
    // 子表单没有结构就是一段填不进去的空数组：默认给一个字段，前端也据此渲染
    const fs = Array.isArray(out.props.fields) ? out.props.fields : []
    out.props.fields = (fs.length ? fs : [{ id: 'sf_' + crypto.randomBytes(4).toString('hex'), type: 'text', label: '子项' }])
      .map((sf, i) => ({
        id: sf?.id || 'sf_' + crypto.randomBytes(4).toString('hex'),
        type: FIELD_TYPES.includes(sf?.type) ? sf.type : 'text',
        label: String(sf?.label ?? `子项 ${i + 1}`)
      }))
  }
  if (type === 'rate') out.props.max = Number(out.props.max) || 5
  if (type === 'slider') { out.props.min ??= 0; out.props.max ??= 100; out.props.step ??= 1 }
  return out
}

/** 判断类题目统一成「正确/错误」两个选项的单选题 */
export function judgeOptions() {
  return [{ label: '正确', value: '正确' }, { label: '错误', value: '错误' }]
}

/**
 * 把答案改写成「当前题型认得的写法」。
 * 题库这边存的是「正确答案：A / 正确」，卷面判分比的是选项值（多选比数组）。
 * 两条路各写各的，就会出现：卷面上明明选了 A，判分说 0 分——因为标准答案是 ['A']，选项值却是 '选项一'。
 * 所有把题库题目搬进卷面的地方都必须先过这一道，否则只修一处、另一处照旧静默出错。
 */
export function coerceAnswerToField(field) {
  if (!field || !Array.isArray(field.answer)) return field
  const type = field.type
  if (type === 'judge') field.type = 'radio'
  if (field.type === 'radio' && /判断/.test(String(field.label || '')) && !field.options.length) {
    field.options = judgeOptions()
  }
  const opts = Array.isArray(field.options) ? field.options : []
  const values = new Set(opts.map(o => String(o.value)))
  const labels = new Map(opts.map(o => [String(o.label), String(o.value)]))
  // 矩阵题的答案是「每行各选哪一列」，同一个值出现多次是常态（两行都打 5 分）。
  // 以前统一去重，两行答案塌成一条，逐行比对永远对不上——这题从此谁答都错。
  const perRow = field.type === 'matrix'
  // 判据只看选项本身：「正确/错误」两个选项就是判断题，与题干里有没有写「判断」两字无关。
  // 之前要求题干含「判断」，于是「WebSocket 是建立在 TCP 之上的。」这种题干干净的判断题
  // 写了「答案：对」也映射不到选项上，标准答案被剔除，谁答都算错。
  const isJudge = opts.length === 2 && values.has('正确') && values.has('错误')

  const mapped = []
  for (const raw of field.answer) {
    const tok = String(raw).trim()
    if (!tok) continue
    // 判断题的字母写法：A/B、T/F、对/错
    if (isJudge) {
      if (/^(A|T|true|对|正确|是)$/i.test(tok)) { mapped.push('正确'); continue }
      if (/^(B|F|false|错|错误|否)$/i.test(tok)) { mapped.push('错误'); continue }
    }
    if (values.has(tok)) { mapped.push(tok); continue }
    if (labels.has(tok)) { mapped.push(labels.get(tok)); continue }
    // 字母写法 A / B / C → 对应选项值（判断题上面已处理）
    if (/^[A-Za-z]$/.test(tok)) {
      const opt = opts[tok.toUpperCase().charCodeAt(0) - 65]
      if (opt) { mapped.push(String(opt.value)); continue }
    }
    mapped.push(tok)
  }
  // 判分逻辑对单选/多选都按数组比较，这里保持数组，只保证元素是选项值。
  // 排序题尤其不能去重后重排：数组顺序就是答案本身。
  field.answer = perRow ? mapped : [...new Set(mapped)]
  return field
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

/**
 * 提交校验。
 *
 * 口径从「按 schema 逐题看」换成「按逻辑计算出这份作答的真实范围」：
 * 隐藏的题不校验（原有行为），被条件跳转跳过的题同样不校验，
 * 动态必填只看当下满足不满足——否则「选了『无』还要填说明」这种题永远提交不上去。
 */
export function validateSubmission(schema, rawData) {
  const errors = []
  const flow = buildFlow(schema, rawData)
  const data = flow.data
  for (const f of schema) {
    // 跳过的、隐藏的都不在作答范围内
    if (!flow.active.has(f.id)) continue
    if (DISPLAY_TYPES.has(f.type)) continue
    const v = data[f.id]
    // 排序题的空数组要真正算「没作答」：它一旦被默认填满，必填就成了摆设
    // 数组：空数组是没作答；子表单还要看「每行都空」；排序/多选这类值数组本身有元素就算作答
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && (v.length === 0 ||
      (f.type === 'subform' && v.every(row => !row || typeof row !== 'object' || Object.values(row).every(x => x === undefined || x === null || String(x).trim() === '')))))
    if (flow.required.get(f.id) && empty) { errors.push(`${f.label} 为必填项`); continue }
    if (empty) continue
    if (f.type === 'phone' && !/^1[3-9]\d{9}$/.test(String(v))) errors.push(`${f.label} 手机号格式不正确`)
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) errors.push(`${f.label} 邮箱格式不正确`)
    if (f.type === 'idcard' && !/^\d{17}[\dXx]$/.test(String(v))) errors.push(`${f.label} 身份证号格式不正确`)
    if (f.type === 'number' && Number.isNaN(Number(v))) errors.push(`${f.label} 必须是数字`)
    if (f.type === 'subform') {
      // 子字段同样要按自己的规则校验，否则「必填手机号」的子项可以随便填
      const rows = Array.isArray(v) ? v : []
      rows.forEach((rf, ri) => {
        for (const sf of (f.props?.fields || [])) {
          const sv = rf?.[sf.id]
          if (sv === undefined || sv === null || String(sv).trim() === '') continue
          if (/手机|phone|mobile/i.test(sf.label) && !/^1[3-9]\d{9}$/.test(String(sv))) errors.push(`${f.label} 第 ${ri + 1} 项 ${sf.label} 格式不正确`)
        }
      })
    }
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
 * 判分口径：全站只此一份。
 *
 * 之前每个入口各写一套比较：交卷（gradeSubmission）、交卷回顾（buildReview）、
 * 刷题判题（routes/banks.js）三处各自 sort 一下数组就算「比对」。于是：
 *  - 排序题按集合比，怎么排都算对，这道题等于白送分；
 *  - 矩阵题的作答是 {行: 列}，被 String() 成 "[object Object]"，全对也判错；
 *  - 文本答案里的首尾空格、数字 3306 与 "3306.0" 各算各的。
 * 三处一起改才叫修，所以抽成这一个函数。
 */

/** 文本类题：答案的大小写不该决定对错（HTTP / http 是同一个答案） */
const TEXT_LIKE = new Set(['text', 'textarea', 'email', 'phone', 'idcard', 'qrcode', 'date', 'time', 'datetime'])

/** 答案归一：去首尾空白、内部空白压成一个；纯数字按数值（3306.0 与 3306 是同一个） */
export function answerToken(v, { ignoreCase = false } = {}) {
  let s = String(v ?? '').trim().replace(/\s+/g, ' ')
  if (s !== '' && /^-?\d+(\.\d+)?$/.test(s)) s = String(Number(s))
  return ignoreCase ? s.toLowerCase() : s
}

/** 这道题是否判对 */
export function isAnswerCorrect(field, value) {
  const right = (field?.answer || []).filter(v => v !== undefined && v !== null && String(v) !== '')
  if (!right.length) return false
  const type = field?.type
  const opts = { ignoreCase: TEXT_LIKE.has(type) }

  if (type === 'sort') {
    // 排序题问的是顺序。按集合比的话「把选项全选上」就算对，顺序这回事根本不存在
    const given = (Array.isArray(value) ? value : []).map(v => answerToken(v, opts))
    const want = right.map(v => answerToken(v, opts))
    return given.length === want.length && given.every((x, i) => x === want[i])
  }

  if (type === 'matrix') {
    // 矩阵题的作答是 {行: 列值}，答案是「每行各选哪一列」
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    const rows = Array.isArray(field.props?.rows) ? field.props.rows : []
    if (!rows.length) return false
    const want = right.map(v => answerToken(v, opts))
    // 答案逐行写了就逐行比；只写一个值时按「每行都是它」处理
    if (want.length === rows.length) return rows.every((r, i) => answerToken(obj[r], opts) === want[i])
    return want.length === 1 && rows.every(r => answerToken(obj[r], opts) === want[0])
  }

  const given = (Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value])
    .map(v => answerToken(v, opts)).sort()
  const want = right.map(v => answerToken(v, opts)).sort()
  // 多选按集合比：勾选顺序不是答案的一部分
  return given.length === want.length && given.every((x, i) => x === want[i])
}

/** 把作答 / 答案渲染成人能读的一行——回顾、刷题反馈都用它 */
export function answerText(field, value) {
  const type = field?.type
  if (value === undefined || value === null || value === '') return ''
  if (type === 'matrix') {
    const rows = Array.isArray(field.props?.rows) ? field.props.rows : []
    // 作答是 {行: 列}；标准答案是「每行各选哪一列」的数组，同样按行贴出去
    if (Array.isArray(value)) {
      return value.map((v, i) => (rows[i] ? `${rows[i]}：${v}` : String(v))).join(' · ')
    }
    const obj = value && typeof value === 'object' ? value : {}
    return (rows.length ? rows : Object.keys(obj))
      .map(r => [r, obj[r]]).filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
      .map(([r, v]) => `${r}：${v}`).join(' · ')
  }
  if (type === 'subform') {
    const labels = Object.fromEntries((field.props?.fields || []).map(sf => [sf.id, sf.label]))
    return (Array.isArray(value) ? value : []).map(row => Object.entries(row || {})
      .filter(([, x]) => x !== undefined && x !== null && String(x).trim() !== '')
      .map(([k, x]) => `${labels[k] || '字段'}：${x}`).join(' / ')).filter(Boolean).join('；')
  }
  if (Array.isArray(value)) {
    // 排序题：数组顺序就是答案，用箭头连起来才看得出「他排成了这样」
    if (type === 'sort') return value.map(String).join(' → ')
    return value.map(v => (v && typeof v === 'object' ? (v.name || v.url || JSON.stringify(v)) : String(v))).join('、')
  }
  if (typeof value === 'object') return Object.values(value).map(String).join('、')
  // 图片/定位等长值截断，别把一张 dataURL 塞进反馈框
  return String(value).length > 80 ? String(value).slice(0, 80) + '…' : String(value)
}

/**
 * 考试评分
 * 三类题分开算：有标准答案的自动判；没标准答案但有人工给分的按人工分计；
 * 既没答案也没人批的主观题，只算进卷面总分，不进可判分总分——否则「全对也永远不及格」。
 * @param manual { [fieldId]: number } 老师给的分
 */
export function gradeSubmission(schema, rawData, settings = {}, manual = {}) {
  // 判分范围与校验同一口径：隐藏的、被跳转跳过的不进总分。
  // 否则「不符合条件直接结束」的那份卷子，满分仍然按全套题算，及格线当场失真。
  const flow = buildFlow(schema, rawData)
  const data = flow.data
  let total = 0
  let got = 0
  let scored = 0
  let ungraded = 0
  let paperTotal = 0
  for (const f of schema) {
    if (!f.score || !flow.active.has(f.id)) continue
    paperTotal += f.score
    if (f.answer?.length) {
      total += f.score
      scored++
      // 判分口径统一在 isAnswerCorrect：排序看顺序、矩阵逐行比、文本忽略大小写与空格
      if (isAnswerCorrect(f, data[f.id])) got += f.score
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

/** 验证码是防机器人的，不是题目；哪怕误填了分值也不该进阅卷队列 */
const NO_GRADE_TYPES = new Set(['captcha', 'divider', 'richtext', 'html', 'image', 'calculate'])

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
  const flow = buildFlow(schema, data)
  return schema.filter(f =>
    isSubjective(f) && flow.active.has(f.id) && !Object.prototype.hasOwnProperty.call(manual, f.id)
  ).length
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

/**
 * 报表统计：流式累加。
 *
 * 旧实现是 `SELECT *` 把整个表单的答卷读进内存、逐份 JSON.parse、再逐字段 map 一遍。
 * 单看没问题，答卷一多就变成事故：实测一份问卷 93 万份答卷——
 *   `GET /api/forms/:id/report` 要 13 秒，峰值内存 2.2GB，
 *   而它返回给前端的只是一个 18KB 的 JSON。中间那 2GB 全是算完就该丢的原始数据。
 * 更糟的是这活由每个打开报表页的人各做一遍，两个人同时看报表就要 4GB。
 *
 * 现在改成一份答卷进来就丢进去、算完就扔：内存只跟「选项数 × 题目数」有关，
 * 跟答卷数量无关。同一批 93 万份数据，内存降到 40MB 量级。
 *
 * 同时把「逐字段比较」和「跨字段比较」分开：字段之间的累加彼此独立，
 * 不需要把所有字段的中间结果都留到最后。
 */
export function createStatsAccumulator(form) {
  const schema = form.schema || []
  const days = new Map()
  const answers = new Map() // fieldId -> 该题的累加器
  let total = 0
  let scoreSum = 0
  let scoreCount = 0
  let passedCount = 0

  /** 每道题一个累加器，只留「能算出最终数字」的最小状态 */
  const makeCell = (f) => {
    const base = { count: 0 }
    switch (f.type) {
      case 'sort': {
        // 排序题要的是「这个选项平均被排在第几位」：累加名次和次数就够，不必留原始顺序
        const ranks = new Map(f.options.map(o => [String(o.value), { sum: 0, n: 0 }]))
        return { ...base, kind: 'sort', ranks }
      }
      case 'radio': case 'select': case 'checkbox': case 'carousel':
      case 'rate': case 'nps': case 'switch': {
        return { ...base, kind: 'choice', counts: new Map(), sum: 0, num: 0 }
      }
      case 'matrix': {
        const counts = new Map()
        return { ...base, kind: 'matrix', counts, sum: 0, num: 0 }
      }
      case 'number': case 'slider': {
        return { ...base, kind: 'number', sum: 0, num: 0, max: 0, min: 0, seen: false }
      }
      case 'subform': {
        const labels = Object.fromEntries((f.props?.fields || []).map(sf => [sf.id, sf.label]))
        return { ...base, kind: 'subform', labels, samples: [], rows: 0 }
      }
      default:
        return { ...base, kind: 'text', samples: [] }
    }
  }

  for (const f of schema) {
    // 验证码只是防刷手段，统计它等于把「3+4」的答案摊在报表上；分割线/富文本/图片本来就没有作答
    if (['divider', 'richtext', 'html', 'image', 'captcha', 'calculate'].includes(f.type)) continue
    answers.set(f.id, makeCell(f))
  }

  const bump = (map, key) => {
    // 自由作答的题型（评分题被填成任意数字、选项被改成任意文本）键可能无限多，
    // 真让它无限长就是把「内存跟答卷数无关」这句话还回去。留 2000 个键，够报表用。
    if (map.size > 2000 && !map.has(key)) return
    map.set(key, (map.get(key) || 0) + 1)
  }

  return {
    push(s) {
      total++
      if (s.score !== null && s.score !== undefined) { scoreSum += Number(s.score) || 0; scoreCount++ }
      if (s.passed === 1) passedCount++
      const day = String(s.created_at || '').slice(0, 10)
      if (day) days.set(day, (days.get(day) || 0) + 1)
      const data = s.data || {}
      for (const [fid, cell] of answers) {
        const v = data[fid]
        if (v === undefined || v === null || v === '') continue
        cell.count++
        switch (cell.kind) {
          case 'sort': {
            if (!Array.isArray(v)) break
            v.forEach((val, i) => {
              const key = String(val)
              let r = cell.ranks.get(key)
              if (!r) { r = { sum: 0, n: 0 }; cell.ranks.set(key, r) }
              r.sum += i + 1
              r.n++
            })
            break
          }
          case 'choice': {
            for (const one of (Array.isArray(v) ? v : [v])) bump(cell.counts, String(one))
            cell.sum += Number(flat(v)) || 0
            cell.num++
            break
          }
          case 'matrix': {
            if (!v || typeof v !== 'object' || Array.isArray(v)) break
            for (const one of Object.values(v)) {
              // 矩阵题的作答是 {行: 列值}，统计的是「这一列被多少人选过」
              bump(cell.counts, String(one))
              const n = Number(one)
              if (Number.isFinite(n)) { cell.sum += n; cell.num++ }
            }
            break
          }
          case 'number': {
            const n = Number(v)
            if (!Number.isFinite(n)) break
            cell.sum += n
            cell.num++
            if (!cell.seen) { cell.max = n; cell.min = n; cell.seen = true }
            else { if (n > cell.max) cell.max = n; if (n < cell.min) cell.min = n }
            break
          }
          case 'subform': {
            const list = Array.isArray(v) ? v : []
            cell.rows += list.filter(row => row && Object.values(row).some(x => String(x ?? '').trim() !== '')).length
            if (cell.samples.length < 20) {
              const text = list
                .map(row => Object.entries(row || {}).filter(([, x]) => x !== undefined && x !== null && String(x).trim() !== '')
                  .map(([k, x]) => `${cell.labels[k] || '字段'}：${x}`).join(' / '))
                .filter(Boolean).join('；')
              if (text) cell.samples.push(text.slice(0, 120))
            }
            break
          }
          default: {
            if (cell.samples.length < 20) cell.samples.push(String(flat(v)).slice(0, 60))
          }
        }
      }
    },

    result() {
      const list = []
      for (const f of schema) {
        const cell = answers.get(f.id)
        if (!cell) continue
        const item = { id: f.id, label: f.label, type: f.type, count: cell.count }
        if (cell.kind === 'sort') {
          item.series = [...cell.ranks.entries()].map(([value, r]) => {
            const opt = f.options.find(o => String(o.value) === value)
            return {
              name: opt?.label || value,
              value: r.n ? Math.round((r.sum / r.n) * 100) / 100 : 0,
              count: r.n
            }
          })
          item.note = '平均名次（越小越靠前）'
        } else if (cell.kind === 'choice') {
          let series = f.options.map(o => ({ name: o.label, value: cell.counts.get(String(o.value)) || 0 }))
          if (f.type === 'rate' || f.type === 'nps') {
            const max = Number(f.props?.max) || (f.type === 'nps' ? 10 : 5)
            // 与前端 renderer 的 npsRange 同口径，否则 -2 这类负档位的作答在报表里凭空消失
            const from = f.type === 'nps' ? Number(f.props?.min ?? 0) : 1
            series = Array.from({ length: Math.max(0, max - from + 1) }, (_, i) => ({ name: String(from + i), value: cell.counts.get(String(from + i)) || 0 }))
          }
          item.series = series
          // 平均值只对「值本身就是分数」的题型有意义：评分 / NPS / 开关。
          // 单选题拿它求平均是荒唐的——选项写 21/80/443 的端口题会算出「平均 148.63」
          if (['rate', 'nps', 'slider', 'number', 'switch'].includes(f.type)) {
            item.average = cell.num ? Math.round((cell.sum / cell.num) * 100) / 100 : 0
          }
        } else if (cell.kind === 'matrix') {
          item.series = f.options.map(o => ({ name: o.label, value: cell.counts.get(String(o.value)) || 0 }))
          item.note = '各评分列被选中的次数'
          // 选项是数字分值时（1-5 分那种）顺手给平均分，否则不给——对文字档位求平均是假的
          const numeric = f.options.every(o => Number.isFinite(Number(o.value)) && String(o.value).trim() !== '')
          if (numeric) item.average = cell.num ? Math.round((cell.sum / cell.num) * 100) / 100 : 0
        } else if (cell.kind === 'number') {
          item.average = cell.num ? Math.round((cell.sum / cell.num) * 100) / 100 : 0
          item.max = cell.seen ? cell.max : 0
          item.min = cell.seen ? cell.min : 0
          item.count = cell.num
        } else if (cell.kind === 'subform') {
          item.samples = cell.samples
          item.rows = cell.rows
        } else {
          item.samples = cell.samples
        }
        list.push(item)
      }
      const trend = [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([date, count]) => ({ date, count }))
      return {
        total,
        trend,
        avgScore: scoreCount ? Math.round((scoreSum / scoreCount) * 100) / 100 : null,
        // 字段名写的是 Rate、放的却是人数，大屏那边只能再算一次百分比。
        // 两个都给：人数用于「通过人数」卡片，比率用于「通过率」卡片，别让调用方猜。
        passedCount,
        passRate: total ? Math.round((passedCount / total) * 1000) / 10 : 0,
        questions: list
      }
    }
  }
}

/** 保留旧签名：一次给全量数据时照样能用（测试和内部调用都走这里） */
export function computeStats(form, submissions) {
  const acc = createStatsAccumulator(form)
  for (const s of submissions) acc.push(s)
  return acc.result()
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
