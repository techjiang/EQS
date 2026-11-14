/**
 * 条件逻辑引擎：显示隐藏 / 动态必填 / 计算 / 文本替换 / 自动勾选 / 条件跳转（提前结束）。
 *
 * 为什么放在 web/js 而不是各写一份：
 * 判分曾经被写三遍（交卷、回顾、刷题），三处各错在不同的地方。逻辑规则如果也这么写，
 * 结果会是「页面上算出来 88 分、服务端判 0 分」，而用户完全不知道该信哪个。
 * 所以这一份文件被两侧同时 import：浏览器走 `/js/flow.js`，服务端 `import '../../web/js/flow.js'`。
 *
 * 数据形状（都挂在字段上，跟着 schema 一起存）：
 *   field.logic        [{fieldId, op, value}]        全部满足才显示（原有能力）
 *   field.requiredWhen [{fieldId, op, value}]        满足才必填；为空=按 field.required
 *   field.jump         [{op, value, text}]           命中则提前结束，剩余题目作废
 *   field.fill         {from, map:{来源值: 目标值}}   来源题作答后自动填入本题（仅在本题为空时）
 *   field.type==='calculate' + props.formula         `{{f_a}} * {{f_b}}` 这类算式，只读
 *
 * 这里没有任何 eval：公式走自带的递归下降解析，只认数字、括号、四则运算与字段引用。
 */

const OPS = new Set(['eq', 'ne', 'in', 'contains', 'gt', 'lt', 'empty', 'notEmpty'])
export const OP_LABELS = {
  eq: '等于', ne: '不等于', in: '任意等于', contains: '包含',
  gt: '大于', lt: '小于', empty: '为空', notEmpty: '不为空'
}

const flat = v => (Array.isArray(v) ? v.join(',') : v)

/** 单条条件是否成立 */
export function matchRule(rule, data, selfId) {
  if (!rule || typeof rule !== 'object') return true
  const raw = data[rule.fieldId] ?? data[selfId]
  const v = flat(raw)
  const target = rule.value
  switch (rule.op) {
    case 'eq': return String(v) === String(target)
    case 'ne': return String(v) !== String(target)
    case 'in': return Array.isArray(target) ? target.map(String).includes(String(v)) : String(v) === String(target)
    case 'contains': return Array.isArray(raw) ? raw.map(String).includes(String(target)) : String(v ?? '').includes(String(target))
    case 'gt': return Number(v) > Number(target)
    case 'lt': return Number(v) < Number(target)
    case 'empty': return v === '' || v === undefined || v === null
    case 'notEmpty': return !(v === '' || v === undefined || v === null)
    default: return true
  }
}

const allMatch = (rules, data) => !rules?.length || rules.every(r => matchRule(r, data))

/* ------------------------------------------------------------------ *
 * 公式求值：`{{f_total}} * 0.9 + 10`
 * ------------------------------------------------------------------ */

/** 从 schema 里按 id 或题干找字段（题干引用比 id 好写，但只做全等匹配，避免歧义） */
export function resolveField(schema, name) {
  const key = String(name || '').trim()
  if (!key) return null
  return schema.find(f => f.id === key) || schema.find(f => f.label === key) || null
}

/** 引用值 → 数字：空值按 0，非数字按 0（公式不是校验器，别因为一格没填就整题变 NaN） */
function num(v) {
  if (Array.isArray(v)) v = v.length === 1 ? v[0] : v.join('')
  if (v === undefined || v === null || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function tokenize(expr) {
  const out = []
  const s = String(expr ?? '')
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) { i++; continue }
    if (s.startsWith('{{', i)) {
      const end = s.indexOf('}}', i + 2)
      if (end < 0) throw new Error('公式里的 {{ 没有闭合')
      out.push({ t: 'ref', v: s.slice(i + 2, end).trim() })
      i = end + 2
      continue
    }
    if (/[0-9.]/.test(c)) {
      let j = i
      while (j < s.length && /[0-9.]/.test(s[j])) j++
      const text = s.slice(i, j)
      if ((text.match(/\./g) || []).length > 1) throw new Error(`数字写法不对：${text}`)
      out.push({ t: 'num', v: Number(text) })
      i = j
      continue
    }
    if ('+-*/()%'.includes(c)) { out.push({ t: c }); i++; continue }
    // 裸标识符也当成字段引用：手写 f_abc 比 {{f_abc}} 省事，且不会和乘号混淆
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++
      out.push({ t: 'ref', v: s.slice(i, j) })
      i = j
      continue
    }
    throw new Error(`公式里有不认识的字符：${c}`)
  }
  return out
}

/**
 * 计算一个表达式。返回 number；公式为空返回 null（表示「这题没有公式」）。
 * 除零返回 0 而不是 Infinity：把 Infinity 写进作答里，后面的公式会一路污染成 NaN。
 */
export function evalFormula(expr, schema, data) {
  const src = String(expr ?? '').trim()
  if (!src) return null
  const tokens = tokenize(src)
  if (!tokens.length) return null
  let pos = 0
  const peek = () => tokens[pos]
  const eat = (t) => (peek()?.t === t ? tokens[pos++] : null)

  function factor() {
    const tk = peek()
    if (!tk) throw new Error('公式不完整')
    if (tk.t === '-' || tk.t === '+') {
      pos++
      const v = factor()
      return tk.t === '-' ? -v : v
    }
    if (tk.t === 'num') { pos++; return tk.v }
    if (tk.t === 'ref') {
      pos++
      const f = resolveField(schema, tk.v)
      if (!f) throw new Error(`公式引用了不存在的字段：${tk.v}`)
      return num(data[f.id])
    }
    if (tk.t === '(') {
      pos++
      const v = sum()
      if (!eat(')')) throw new Error('括号没有闭合')
      return v
    }
    throw new Error(`公式里多了一个符号：${tk.t}`)
  }
  function term() {
    let v = factor()
    for (;;) {
      if (eat('*')) v *= factor()
      else if (eat('/')) { const d = factor(); v = d === 0 ? 0 : v / d }
      else if (eat('%')) { const d = factor(); v = d === 0 ? 0 : v % d }
      else return v
    }
  }
  function sum() {
    let v = term()
    for (;;) {
      if (eat('+')) v += term()
      else if (eat('-')) v -= term()
      else return v
    }
  }
  const value = sum()
  if (pos < tokens.length) throw new Error(`公式没写完：多出 ${tokens[pos].t}`)
  if (!Number.isFinite(value)) return 0
  return value
}

/** 公式结果按 precision 取舍（默认 2 位，最多 6 位） */
export function roundTo(value, precision) {
  if (value === null || value === undefined) return ''
  const p = Math.min(6, Math.max(0, Number(precision ?? 2) || 0))
  const f = 10 ** p
  return Math.round(value * f) / f
}

/* ------------------------------------------------------------------ *
 * 文本替换：题干 / 说明里的 {{字段}} 换成作答
 * ------------------------------------------------------------------ */
/**
 * 文本替换：题干 / 说明 / 表单描述里的 {{字段}} 换成作答。
 *
 * 三种情况分开处理，别混成一种：
 *  - 字段名写错（schema 里没有）→ 空串，别把半截 {{xxx}} 摊给用户看
 *  - 字段存在但还没作答       → 保留 {{xxx}} 原样。换成空串会得到「备注（当前来源：）」
 *                                这种残句，而保留占位至少说明「这里会填上你选的值」
 *  - 有作答                   → 换成作答（多选顿号连接，矩阵/子表单取可读值）
 */
export function renderText(text, schema, data) {
  const s = String(text ?? '')
  if (!s.includes('{{')) return s
  return s.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, name) => {
    const f = resolveField(schema, name)
    if (!f) return ''
    const v = data?.[f.id]
    if (v === undefined || v === null || v === '') return whole
    if (Array.isArray(v)) {
      const parts = v.map(x => (x && typeof x === 'object' ? (x.name || x.label || '') : String(x))).filter(Boolean)
      return parts.length ? parts.join('、') : whole
    }
    if (typeof v === 'object') {
      const parts = Object.values(v).map(String).filter(Boolean)
      return parts.length ? parts.join('、') : whole
    }
    return String(v)
  })
}

/* ------------------------------------------------------------------ *
 * 自动勾选 / 自动填入
 * ------------------------------------------------------------------ */
const asList = v => (Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === '' ? [] : [String(v)])

/** 只填空着的目标题：用户已经答过的，不能被一条规则悄悄改掉 */
function applyFill(field, data) {
  const fill = field?.fill
  if (!fill || typeof fill !== 'object' || !fill.from) return false
  const srcField = fill.from
  const src = data[srcField]
  const cur = data[field.id]
  const curList = asList(cur)
  if (curList.length) return false
  const key = String(flat(src) ?? '')
  const map = fill.map && typeof fill.map === 'object' ? fill.map : {}
  /*
   * 没写映射就整值搬过来（单选→单选、多选→多选这种最常见）；
   * 写了映射但没命中，说明作者刻意只搬几个值，这时不搬，
   * 否则「只把『是』映射成『已同意』」的规则会顺手把所有别的值也带过去。
   */
  const hasMap = Object.keys(map).length > 0
  const pick = Object.prototype.hasOwnProperty.call(map, key)
    ? map[key]
    : (hasMap ? (fill.any ? map['*'] : '') : src)
  const list = asList(pick)
  if (!list.length) return false
  if (field.type === 'checkbox' || field.type === 'sort') data[field.id] = list
  else data[field.id] = list[0]
  return true
}

/* ------------------------------------------------------------------ *
 * 汇总：一次算出「哪些题在、哪些必填、计算题值是多少、有没有提前结束」
 * ------------------------------------------------------------------ */
export function buildFlow(schema, rawData) {
  const data = { ...(rawData && typeof rawData === 'object' && !Array.isArray(rawData) ? rawData : {}) }
  const list = Array.isArray(schema) ? schema : []

  // 计算题可能被前面的公式引用，所以按 schema 顺序算；两遍是为了让「后定义的计算题」
  // 也能影响「先定义的题的显隐」这种反向依赖，不至于让人为了顺序重新排题
  for (let pass = 0; pass < 2; pass++) {
    for (const f of list) {
      if (f.type !== 'calculate') continue
      const v = evalFormula(f.props?.formula, list, data)
      data[f.id] = v === null ? '' : roundTo(v, f.props?.precision)
    }
  }
  for (const f of list) applyFill(f, data)

  const visible = new Map()
  for (const f of list) visible.set(f.id, allMatch(f.logic, data))

  // 条件必填：写了 requiredWhen 就以它为准（更具体的那条说了算）
  const required = new Map()
  for (const f of list) {
    required.set(f.id, f.requiredWhen?.length ? allMatch(f.requiredWhen, data) : !!f.required)
  }

  // 跳转：按顺序走，第一道命中「提前结束」的题决定终点，它之后的题全部作废
  let stoppedAt = null
  const active = new Set()
  for (const f of list) {
    if (stoppedAt) break
    if (!visible.get(f.id)) continue
    active.add(f.id)
    const jump = Array.isArray(f.jump) ? f.jump.find(r => matchRule(r, data, f.id)) : null
    if (jump) { stoppedAt = { field: f, text: jump.text || '' }; break }
  }

  return {
    data,
    visible,
    required,
    active,
    stopped: !!stoppedAt,
    stopText: stoppedAt?.text || '',
    stopFieldId: stoppedAt?.field?.id || '',
    /** 这道题此刻是否在作答范围内（可见且没被跳转跳过） */
    isActive: id => active.has(id),
    isRequired: id => active.has(id) && !!required.get(id)
  }
}

/**
 * 把「作答」按逻辑规则整理成可以入库的形状：
 * 计算题用服务端的值覆盖（客户端算的只是给用户看的），跳过的题直接丢掉。
 *
 * 这一步是安全边界：客户端提交的 data 完全不可信，一个被改过的 calc 值能直接影响判分。
 */
export function resolveAnswers(schema, rawData) {
  const flow = buildFlow(schema, rawData)
  const out = {}
  for (const f of schema || []) {
    if (!flow.active.has(f.id)) continue
    if (flow.data[f.id] !== undefined) out[f.id] = flow.data[f.id]
  }
  return { data: out, stopped: flow.stopped, stopText: flow.stopText, stopFieldId: flow.stopFieldId }
}
