import crypto from 'node:crypto'
import { get, all, run, now } from './db.js'
// 逻辑规则（显示 / 必填 / 计算 / 跳转 / 自动填入）与浏览器共用同一份实现。
// 各写一遍的下场在判分上已经演过：三个入口三套口径，同一道题三种结论。
import { buildFlow, resolveAnswers, renderText, evalFormula } from '../../web/js/flow.js'
// 级联的父子关系同样只有一份：渲染、判分、统计、导出都按它算路径
import { cascadeLabelPath, cascadeLabelTail, cascadeValuePath, normalizeCascade } from '../../web/js/cascade.js'
import { normalizeFileUrls } from './fileAccess.js'

/** 单题分值上限：不设上限时，一道题填 1e9 就能把整份卷子的平均分和排名彻底搅乱 */
export const MAX_SCORE = 1000

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
    // parent 只有级联选择用得到（父项 value，顶层空），但它必须在这里保住：
    // 之前这个映射把每个选项重建成「label + value」两个键，层级关系一进 normalizeField 就被抹平，
    // 于是「级联」在存储层就已经是平的，渲染层再怎么改也级不起来。
    options: Array.isArray(f.options) ? f.options.map(o => {
      const base = typeof o === 'string' ? { label: o, value: o } : { label: String(o.label ?? ''), value: String(o.value ?? o.label ?? '') }
      const parent = typeof o === 'object' && o && o.parent !== undefined && o.parent !== null ? String(o.parent) : ''
      return parent ? { ...base, parent } : base
    }) : [],
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
  if (type === 'cascader') {
    // 脏数据兜底：parent 指向不存在的值、父子成环，都会让选项在页面上凭空消失或渲染死循环
    out.options = normalizeCascade(out.options)
  }
  if (CHOICE.has(type) && out.options.length === 0 && type !== 'matrix') {
    out.options = [{ label: '选项 1', value: '选项 1' }, { label: '选项 2', value: '选项 2' }]
  }
  /*
   * 矩阵题的两条轴都要有东西，否则这题在页面上就是一个空表：只有行没有列。
   * 以前只在 rows 缺失时才补列，于是「给了行、没给列」的矩阵（接口建的、Excel 导入的
   * 都可能这样）渲染出来表头空着，谁也没法作答，而它还照样占着分值和必填。
   */
  if (type === 'matrix') {
    if (!Array.isArray(out.props.rows) || !out.props.rows.length) out.props.rows = ['行 1', '行 2']
    out.props.rows = out.props.rows.map((r, i) => String(r ?? `行 ${i + 1}`))
    if (!out.options.length) {
      out.options = [{ label: '很满意', value: '5' }, { label: '满意', value: '4' }, { label: '一般', value: '3' }]
    }
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
  // 折算不了的值单独记下来：调用方（导入、建题接口）要能告诉用户「哪个答案被丢掉了」，
  // 而折算本身会把 'A' 变成选项值 'A.x'，事后比前后集合分不清「被折算」和「被丢掉」
  const unmatched = []
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
    // 走到这里说明既不是选项值、也不是选项文字、也不是序号：选择题里它就是越界答案
    if (CHOICE.has(field.type) && opts.length) unmatched.push(tok)
    mapped.push(tok)
  }
  // 判分逻辑对单选/多选都按数组比较，这里保持数组，只保证元素是选项值。
  // 排序题尤其不能去重后重排：数组顺序就是答案本身。
  field.answer = perRow ? mapped : [...new Set(mapped)]
  // 剔除的越界答案回传出去，导入接口才有依据提示「这几题的答案不在选项里」
  field.unmatched = unmatched
  // 剔除「指向不存在的选项」的标准答案。
  // 以前只清理文本/Excel 导入那条路，接口直接建题时 `答案：Z` 而选项只有 A/B 照样入库 ——
  // 这题从此谁答都算错，而且页面上看不出来。选择题的答案必须是选项表里的值（矩阵按行容忍重复）。
  if (CHOICE.has(field.type) && field.answer.length && field.options.length) {
    const values = new Set(field.options.map(o => String(o.value)))
    const labels = new Set(field.options.map(o => String(o.label)))
    field.answer = field.answer.filter(a => values.has(String(a)) || labels.has(String(a)))
  }
  return field
}

/**
 * 卷面 schema 的规范化。
 *
 * 除了逐题 normalizeField，还要管「题与题之间」的关系，这些都是打接口才看得见的：
 *  - 字段 id 重复：两份「同名」作答，逻辑规则和统计全指不确定的那一个。重复的直接重发新 id。
 *  - 分值：负数、Infinity、1e9 一律压回 [0, MAX_SCORE]。
 *  - 逻辑 / 跳转引用了不存在的字段：规则永远不成立，看起来像「条件逻辑没生效」。
 */
export function normalizeSchema(schema) {
  if (!Array.isArray(schema)) return []
  const out = schema.map(normalizeField)
  const seen = new Set()
  for (const f of out) {
    if (seen.has(f.id)) f.id = 'f_' + crypto.randomBytes(5).toString('hex')
    seen.add(f.id)
  }
  for (const f of out) {
    // 标准答案必须是这道题真有的选项：`答案：Z` 而选项只有 A/B 时，这题从此谁答都错，
    // 页面上还看不出来。矩阵按行允许重复值，判断题的「正确/错误」本身就是选项。
    if (CHOICE.has(f.type) && f.answer.length && f.options.length) {
      const values = new Set(f.options.map(o => String(o.value)))
      const labels = new Set(f.options.map(o => String(o.label)))
      f.answer = f.answer.filter(a => values.has(String(a)) || labels.has(String(a)))
    }
    const n = Number(f.score)
    f.score = Number.isFinite(n) ? Math.min(MAX_SCORE, Math.max(0, n)) : 0
    // 三种规则形状不一样：logic/requiredWhen 指向别的字段（fieldId），
    // jump 是「本题命中就结束」（没有 fieldId，只有 op/value/text），
    // fill 的来源键叫 from。以前一律按 fieldId 判，jump 规则被整批当成脏数据删掉，
    // 表现为「条件跳转配了没反应」。
    const refs = (r) => r && typeof r === 'object' && seen.has(String(r.fieldId))
    f.logic = f.logic.filter(refs)
    f.requiredWhen = f.requiredWhen.filter(refs)
    f.jump = f.jump.filter(r => r && typeof r === 'object')
    if (f.fill && !(f.fill && typeof f.fill === 'object' && seen.has(String(f.fill.from)))) f.fill = null
  }
  return out
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
/** 真实存在的日期（2026-13-45 / 2026-02-31 都算假） */
function isRealDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim())
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

/** 真实存在的日期时间：日期部分照上面判，时间部分按 HH:mm(:ss) */
function isRealDateTime(v) {
  const s2 = String(v).trim().replace(' ', 'T')
  const i = s2.indexOf('T')
  if (i < 0) return false
  return isRealDate(s2.slice(0, i)) && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s2.slice(i + 1))
}

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
    // 日期形状对不等于日期存在：2026-13-45、2026-02-31 都能通过"看着像日期"的判断，
    // 但它们会被原样存进答卷、原样进报表和导出，事后没人说得清这一天到底发生过什么
    if (f.type === 'date' && !isRealDate(String(v))) errors.push(`${f.label} 不是有效日期`)
    if (f.type === 'datetime' && !isRealDateTime(String(v))) errors.push(`${f.label} 不是有效的日期时间`)
    if (f.type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(v))) errors.push(`${f.label} 不是有效时间`)
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

/* ------------------------------------------------------------------ *
 * 作答清洗：把「客户端提交的东西」折成这个题型收得下的形状。
 *
 * 之前服务端对作答内容完全不设防，只做必填/格式校验，然后原样入库。实测：
 *   - 单选题可以提交 {label:'甲',value:'甲'} 这个对象，库里就存了个对象；
 *   - 可以提交一个根本没出现在选项里的值（「完全不存在」），报表里多出一根没人认识
 *     的柱子，判分时它和任何标准答案都不相等；
 *   - 评分题提交 99、滑块提交 99999，报表平均分直接被一个人拉爆；
 *   - 文本题塞对象 / 数组，导出 Excel 时变成 "[object Object]"；
 *   - 文本题提交 50 万字，一条答卷撑出半个 MB。
 * 这些都不是「用户手滑」——手滑的人是改地址栏、写脚本、或者拿着 API Key 直接打接口。
 * 校验只拦必填是不够的，收上来的值必须先变成「这个题型能表达的值」，再谈判分和统计。
 *
 * 原则：能确定的脏值就地纠正（选项值对不上 label 就映射），确定不了的宁可清空也不入库。
 * ------------------------------------------------------------------ */

/** 「看起来填了东西」：空串、空数组、空对象都算没填 */
function isBlankLike(v) {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.filter(x => !isBlankLike(x)).length === 0
  if (typeof v === 'object') return Object.values(v).every(isBlankLike)
  return false
}

/** 单题文本上限：一份问卷的答案不会比这更长，超了就是灌数据 */
const MAX_TEXT = 5000

/** 干净的标量：字符串去空白，其余（对象/数组）一律视为空。超长的原样返回，由调用方报错 */
function scalar(v) {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') return ''
  return String(v).trim()
}

/** 超长文本单列出来：截断等于替用户改答案，宁可拒收并说清楚上限 */
function tooLong(v) {
  const s = scalar(v)
  return s.length > MAX_TEXT
}

/** 一个值都没有的题不算「被丢掉」，只有真提交了内容才需要解释 */
function droppedReason(field, raw) {
  const type = field.type
  const opts = Array.isArray(field.options) ? field.options : []
  if (['radio', 'select', 'carousel', 'checkbox', 'sort', 'matrix', 'cascader'].includes(type)) {
    const pick = Array.isArray(raw) ? raw : typeof raw === 'object' && raw ? Object.values(raw) : [raw]
    // 把「收到的值」原样回给提交方：说「作答不完整」等于让人回去猜，
    // 而标准答案与选项表的对不齐，恰恰是最需要看见具体值的那类问题
    const shown = pick.map(x => scalar(x) || (x === null || x === undefined ? '' : JSON.stringify(x))).filter(Boolean)
    if (shown.some(x => !opts.some(o => String(o.value) === x || String(o.label) === x))) {
      return `「${String(shown.find(x => !opts.some(o => String(o.value) === x || String(o.label) === x))).slice(0, 20)}」不在选项里`
    }
    if (type === 'sort' && shown.length !== opts.length) return '排序要把每个选项都排进去'
    if (type === 'matrix' && shown.length === 0) return '没有有效的行作答'
    return '作答不完整'
  }
  if (type === 'rate' || type === 'nps' || type === 'slider' || type === 'number') return '不是有效数字或超出范围'
  if (type === 'switch') return '只能是开或关'
  if (type === 'upload' || type === 'file') return '附件缺少地址'
  if (type === 'location') return '坐标格式不对'
  if (type === 'signature') return '签名不是有效的图片'
  if (type === 'date' || type === 'datetime' || type === 'time') return '不是有效的时间'
  if (tooLong(raw)) return `超过 ${MAX_TEXT} 字上限`
  if (typeof raw === 'object') return '答案只能是一段文本'
  return '作答格式不对'
}

/** 把客户端给的值按选项表折成「选项值」：认 value、认 label、也认 A/B/C 序号 */
function toOptionValue(field, raw) {
  const opts = Array.isArray(field.options) ? field.options : []
  // {label, value} 这种形状是早期版本自己写进库里的作答格式，历史数据和
  // 从旧库导入的答卷里都还是它。直接当非法值退回去，等于把老答卷一起判成脏数据。
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  const key = scalar(obj ? (obj.value ?? obj.label) : raw)
  if (!key) return ''
  const hit = opts.find(o => String(o.value) === key) || opts.find(o => String(o.label) === key)
  if (hit) return String(hit.value)
  // 「答案写 A」这类字母序号：只在一个字母、且选项数够时才算，避免把真值 'A' 误伤
  const letters = /^[A-Za-z]$/.test(key) ? opts[key.toUpperCase().charCodeAt(0) - 65] : null
  return letters ? String(letters.value) : ''
}

/** 级联存最末一级，且必须是选项表里真有的节点 */
function toCascadeValue(field, raw) {
  const opts = Array.isArray(field.options) ? field.options : []
  const list = Array.isArray(raw) ? raw : [raw]
  for (let i = list.length - 1; i >= 0; i--) {
    const key = scalar(list[i])
    if (!key) continue
    const hit = opts.find(o => String(o.value) === key) || opts.find(o => String(o.label) === key)
    if (hit) return String(hit.value)
  }
  return ''
}

/**
 * 按题型清洗一份作答。返回新对象，不改入参。
 * 被清空的值等价于「这题没答」——必填校验随即生效，这是对的：
 * 「提交了一个选项表里没有的值」本来就不该算答过。
 */
export function sanitizeAnswers(schema, rawData) {
  const src = rawData && typeof rawData === 'object' && !Array.isArray(rawData) ? rawData : {}
  const out = {}
  /** 提交里有值、但这题型收不下（选项表里没有、超出范围、形状不对）的题 */
  const dropped = []
  for (const f of Array.isArray(schema) ? schema : []) {
    if (DISPLAY_TYPES.has(f.type)) continue
    if (!Object.prototype.hasOwnProperty.call(src, f.id)) continue
    const v = src[f.id]
    const type = f.type
    switch (type) {
      case 'radio': case 'select': case 'carousel': {
        const one = toOptionValue(f, v)
        if (one) out[f.id] = one
        break
      }
      case 'checkbox': {
        const list = (Array.isArray(v) ? v : scalar(v) ? String(v).split(/[,，、]/) : [])
        const picked = [...new Set(list.map(x => toOptionValue(f, x)).filter(Boolean))]
        // 顺序按选项表来，不留客户端给的顺序：多选是集合，不是序列
        const order = (Array.isArray(f.options) ? f.options : []).map(o => String(o.value))
        picked.sort((a, b) => order.indexOf(a) - order.indexOf(b))
        if (picked.length) out[f.id] = picked
        break
      }
      case 'sort': {
        const opts = Array.isArray(f.options) ? f.options : []
        const list = Array.isArray(v) ? v : []
        const picked = list.map(x => toOptionValue(f, x)).filter(Boolean)
        // 排序必须是「全部选项的一次排列」：少一个、多一个都不构成有效顺序
        if (picked.length === opts.length && new Set(picked).size === opts.length) out[f.id] = picked
        break
      }
      case 'cascader': {
        const one = toCascadeValue(f, v)
        if (one) out[f.id] = one
        break
      }
      case 'rate': case 'nps': {
        const n = Number(scalar(v))
        if (!Number.isFinite(n) || n === 0 && type === 'rate' && scalar(v) === '') break
        const max = Number(f.props?.max) || (type === 'nps' ? 10 : 5)
        const min = type === 'nps' ? (f.props?.min === undefined ? 0 : Number(f.props.min) || 0) : 1
        if (n >= min && n <= max) out[f.id] = n
        break
      }
      case 'slider': {
        const n = Number(scalar(v))
        const min = Number(f.props?.min ?? 0)
        const max = Number(f.props?.max ?? 100)
        if (Number.isFinite(n) && n >= Math.min(min, max) && n <= Math.max(min, max)) out[f.id] = n
        break
      }
      case 'switch': {
        // 开关只收真假：'yes'/'no'/'随便一段话' 都不是开关的答案
        if (v === true || v === 1 || v === '1' || v === 'true') out[f.id] = true
        else if (v === false || v === 0 || v === '0' || v === 'false') out[f.id] = false
        break
      }
      case 'matrix': {
        const obj = v && typeof v === 'object' && !Array.isArray(v) ? v : {}
        const rows = Array.isArray(f.props?.rows) ? f.props.rows : []
        const clean = {}
        for (const r of rows) {
          const one = toOptionValue(f, obj[r])
          if (one) clean[r] = one
        }
        if (Object.keys(clean).length) out[f.id] = clean
        break
      }
      case 'subform': {
        const fields = Array.isArray(f.props?.fields) ? f.props.fields : []
        const rows = (Array.isArray(v) ? v : []).map(row => {
          const clean = {}
          for (const sf of fields) {
            const sv = scalar(row?.[sf.id])
            if (sv) clean[sf.id] = sv
          }
          return clean
        }).filter(row => Object.keys(row).length)
        if (rows.length) out[f.id] = rows
        break
      }
      case 'upload': case 'file': {
        // 只留「有 url 的文件描述」，其余键一律不进库：这是唯一允许对象形状的作答
        const list = (Array.isArray(v) ? v : [v]).map(x => {
          if (!x || typeof x !== 'object') return null
          // 上传接口回的是带限期票据的地址，票据不能入库：
          // 答卷可能几年后还有人打开，存进来的票据那时早过期，导出/推送出去的链接全是死的
          const url = normalizeFileUrls(scalar(x.url))
          if (!url) return null
          return { id: Number(x.id) || 0, name: scalar(x.name).slice(0, 200), url }
        }).filter(Boolean)
        if (list.length) out[f.id] = list
        break
      }
      case 'location': {
        // 定位只认「纬度,经度」；「定位失败，请检查权限」这句话不该被当成坐标存起来
        const s2 = scalar(v)
        if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(s2)) out[f.id] = s2
        break
      }
      case 'signature': {
        const s2 = scalar(v)
        // 签名是 dataURL 图片；别的一律不收（最长 200KB，超了就是拿它当图床）
        if (/^data:image\/[a-z+]+;base64,/i.test(s2) && s2.length <= 200 * 1024) out[f.id] = s2
        break
      }
      case 'number': {
        const n = Number(scalar(v))
        if (scalar(v) !== '' && Number.isFinite(n)) out[f.id] = n
        break
      }
      case 'calculate': {
        // 计算题的值由服务端算，客户端传什么都会被覆盖；这里不留客户端值
        break
      }
      default: {
        const s2 = scalar(v)
        // 超长不收：这不是「用户手滑多打几个字」，而是有人拿答卷当备忘录用
        if (s2 && s2.length <= MAX_TEXT) out[f.id] = s2
      }
    }
    // 有值进来、没有值出去 —— 记下是哪一题、为什么，交给调用方原样告诉提交方
    if (!Object.prototype.hasOwnProperty.call(out, f.id) && !isBlankLike(v)) {
      dropped.push({ id: f.id, label: f.label, reason: droppedReason(f, v) })
    }
  }
  return { data: out, dropped }
}

/**
 * 提交入口用这一个：清洗 + 把「被丢掉的值」翻译成人能看的话。
 *
 * 直接静默丢弃是最坏的处理方式——用户选了一个选项（哪怕是被改过的请求），
 * 页面上写着「提交成功」，而库里这题是空的，谁也不知道发生了什么。
 * 所以这里不吞：告诉提交方哪一题的作答不合法。
 */
export function sanitizeSubmission(schema, rawData) {
  const { data, dropped } = sanitizeAnswers(schema, rawData)
  if (dropped.length) {
    // 最多列三题：一份问卷里连着报十句，读的人只会关掉页面
    const shown = dropped.slice(0, 3).map(f => `「${f.label}」${f.reason}`)
    const more = dropped.length > 3 ? ` 等 ${dropped.length} 题` : ''
    const e = new Error(shown.join('；') + more)
    // 与 http.js 的 HttpError 同一个约定：状态码挂在 err.status 上
    e.status = 422
    e.dropped = dropped.map(f => f.id)
    throw e
  }
  return data
}


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

/**
 * 选项值 → 选项文字。
 *
 * 选项的 value 是「存进库里的口径」：字典里可能是 1/2/3，组织架构取人是 u12/d3。
 * 这些都是给机器看的，人看到的是 label（「技术中心 / 后端组 / 张伟」）。
 * 少这层映射，答卷明细、Excel 导出、交卷回顾里就全是 u12 和 1 —— 前几轮一直如此。
 */
export function optionLabel(field, value) {
  const opts = Array.isArray(field?.options) ? field.options : []
  const hit = opts.find(o => String(o?.value) === String(value))
  return hit ? String(hit.label ?? hit.value ?? '') : String(value ?? '')
}

/** 这些题的作答存的是选项值，展示时必须换成选项文字 */
const LABELED = new Set(['radio', 'select', 'checkbox', 'carousel', 'sort', 'matrix'])

/**
 * 把作答 / 答案渲染成人能读的一行——回顾、刷题反馈、导出、明细都用它。
 * @param opts.max 单值最大长度；0 表示不截断（导出要完整数据，反馈框要短）
 */
export function answerText(field, value, opts = {}) {
  const type = field?.type
  const max = opts.max === undefined ? 80 : Number(opts.max)
  const cut = (s) => (max > 0 && String(s).length > max ? String(s).slice(0, max) + '…' : s)
  if (value === undefined || value === null || value === '') return ''
  // 级联存的是最末一级的值：「西湖区」三个字看不出它是哪个省的，
  // 复核、阅卷、导出附件清单都需要「浙江省 / 杭州市 / 西湖区」这条完整路径
  if (type === 'cascader') return cascadeLabelPath(field.options, value) || String(value)
  if (type === 'matrix') {
    const rows = Array.isArray(field.props?.rows) ? field.props.rows : []
    const show = (v) => (LABELED.has(type) ? optionLabel(field, v) : String(v))
    // 作答是 {行: 列}；标准答案是「每行各选哪一列」的数组，同样按行贴出去
    if (Array.isArray(value)) {
      return value.map((v, i) => (rows[i] ? `${rows[i]}：${show(v)}` : String(v))).join(' · ')
    }
    const obj = value && typeof value === 'object' ? value : {}
    return (rows.length ? rows : Object.keys(obj))
      .map(r => [r, obj[r]]).filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
      .map(([r, v]) => `${r}：${show(v)}`).join(' · ')
  }
  if (type === 'subform') {
    const labels = Object.fromEntries((field.props?.fields || []).map(sf => [sf.id, sf.label]))
    return (Array.isArray(value) ? value : []).map(row => Object.entries(row || {})
      .filter(([, x]) => x !== undefined && x !== null && String(x).trim() !== '')
      .map(([k, x]) => `${labels[k] || '字段'}：${x}`).join(' / ')).filter(Boolean).join('；')
  }
  if (Array.isArray(value)) {
    // 排序题：数组顺序就是答案，用箭头连起来才看得出「他排成了这样」
    if (type === 'sort') return value.map(v => optionLabel(field, v)).join(' → ')
    return value.map(v => (v && typeof v === 'object'
      ? (v.name || v.url || JSON.stringify(v))
      : LABELED.has(type) ? optionLabel(field, v) : String(v))).join('、')
  }
  if (typeof value === 'object') return Object.values(value).map(v => (LABELED.has(type) ? optionLabel(field, v) : String(v))).join('、')
  return cut(LABELED.has(type) ? optionLabel(field, value) : String(value))
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
  return reviewTally(form, row).pending
}

/**
 * 这份答卷有几道要人工给分的题、其中几道还没给分。
 *
 * 单看 pending 分不清「这份卷子没有主观题」和「这份卷子已经批完了」——两者都是 0。
 * 而阅卷进度恰恰要区分这两件事：没有主观题的卷子根本不该进「本次共 N 份」的分母，
 * 混进去的话进度条永远到不了头（82 份里 40 份是纯客观题，批完 42 份显示 51%）。
 */
export function reviewTally(form, row) {
  if (!form || form.kind !== 'exam') return { subjective: 0, pending: 0 }
  const data = safeJson(row.data, {})
  const manual = manualScoresOf(row)
  // 直接查库拿到的是未解析的行，schema 还是 JSON 字符串
  const schema = Array.isArray(form.schema) ? form.schema : safeJson(form.schema, [])
  const flow = buildFlow(schema, data)
  let subjective = 0
  let pending = 0
  for (const f of schema) {
    if (!isSubjective(f) || !flow.active.has(f.id)) continue
    subjective++
    if (!Object.prototype.hasOwnProperty.call(manual, f.id)) pending++
  }
  return { subjective, pending }
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
      case 'cascader': {
        // 按「最末一级」统计：级联的每一层都是筛选项，把省份和区县混在一张图里没法读
        return { ...base, kind: 'cascade', counts: new Map(), labels: new Map(normalizeCascade(f.options).map(o => [o.value, o])) }
      }
      case 'number': case 'slider': {
        return { ...base, kind: 'number', sum: 0, num: 0, max: 0, min: 0, seen: false }
      }
      case 'subform': {
        const labels = Object.fromEntries((f.props?.fields || []).map(sf => [sf.id, sf.label]))
        return { ...base, kind: 'subform', labels, samples: [], rows: 0 }
      }
      default:
        return { ...base, kind: 'text', samples: [], textCounts: new Map() }
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
          case 'cascade': {
            // 老数据可能是数组（有人自己存过路径），取最后一格；否则按单个值算
            const leaf = cascadeValuePath(v).pop()
            if (leaf !== undefined && leaf !== '') bump(cell.counts, leaf)
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
            /*
             * 自由作答的样本要能看出「哪句话被说得最多」。
             *
             * 以前是「前 20 条原样列出来」：26 份答卷里 6 种说法，屏幕上就是同一句
             * 重复四遍——真正要看的分布被稀释掉了。现在按出现次数合并，
             * 次数多的排前面；只列不同的说法，样本数上限也改成「不同说法的条数」。
             */
            const text = String(flat(v)).slice(0, 60).trim()
            if (!text) break
            const hit = cell.textCounts.get(text)
            if (hit) hit.n++
            else if (cell.textCounts.size < 20) cell.textCounts.set(text, { text, n: 1 })
            break
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
        } else if (cell.kind === 'cascade') {
          // 只列「真被人选到过的末级项」：把 200 个区县全画成柱子等于没统计。
          // 名字带完整路径，否则图表上会并排出现三个「其他」。
          item.series = [...cell.counts.entries()]
            .map(([value, n]) => ({
              // 图上默认只写末级名（「西湖区」），完整路径放进 tooltip：
              // 三级全铺在 x 轴上，即使斜着放也会被截掉前半截
              name: cascadeLabelTail(f.options, value, 1) || value,
              full: cascadeLabelPath(f.options, value) || value,
              value: n,
              key: value
            }))
          /*
           * 末级名撞车时（两个省都有「朝阳区」）退回「市·区」：
           * 图上两根同名柱子，谁也看不出差在哪。
           */
          const dup = new Set(item.series.map(x => x.name).filter((n, i, arr) => arr.indexOf(n) !== i))
          for (const x of item.series) {
            if (dup.has(x.name)) x.name = cascadeLabelTail(f.options, x.key, 2, '·') || x.name
          }
          item.series.sort((a, b) => b.value - a.value)
          item.note = '按最末一级统计（悬停可看完整路径）'
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
          // 说法多的排前面：同一句被 10 个人说到，比 10 句各说一次更该占第一行
          const ranked = [...cell.textCounts.values()].sort((a, b) => b.n - a.n)
          item.samples = ranked.map(x => x.text)
          item.sampleCounts = ranked.map(x => x.n)
          item.distinct = ranked.length
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

/**
 * 表单此刻能不能填：已发布 + 在开放时间窗内。
 *
 * 以前这条判据只写在「提交」那一处（而且是在 checkLimit 里，靠 settings.timeWindow 判断），
 * 「打开发表单」这一处只看 status。后果是：定时发布的问卷，当天还没到点，
 * 页面能正常打开、能认真填二十分钟，点提交才吃一句「问卷尚未开始」——填的那二十分钟白费。
 * 现在打页面和提交都走这一个函数，前端还能拿到 inWindow/opensAt 提前把入口换掉。
 */
export function formWindow(settings = {}) {
  const w = settings.timeWindow || {}
  const nowMs = Date.now()
  const startMs = w.start ? new Date(w.start).getTime() : 0
  const endMs = w.end ? new Date(w.end).getTime() : 0
  const notStarted = !!(startMs && nowMs < startMs)
  const ended = !!(endMs && nowMs > endMs)
  return {
    open: !notStarted && !ended,
    notStarted, ended,
    opensAt: w.start || '', closesAt: w.end || ''
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
