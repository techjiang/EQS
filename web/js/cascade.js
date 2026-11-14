/**
 * 级联选择（cascader）的层级计算。
 *
 * 这个组件此前名不副实：字段类型叫「级联选择」，渲染出来是一个普通下拉，
 * 三个选项目的地、省份、城市并排放着，谁都能选「城市 = 杭州」而省份空着——
 * 「级联」这件事从头到尾没有发生过。
 *
 * 也不另开一套数据结构：选项仍是 `{label, value}`，只是多一个 `parent`（父项 value，顶层为空）。
 * 这样老表单（三个平级选项、没有 parent）自动退化成「一级下拉」，不需要迁移，也不会有半新半旧的库。
 *
 * 这个文件被浏览器与服务端共用（renderer.js 渲染、lib/forms.js 判分与统计），
 * 各写一遍的下场在判分上已经演过：页面算一套、服务端算另一套。
 */

/** 规范成字符串，避免 1 与 '1' 被当成两个父级 */
const S = (v) => (v === undefined || v === null ? '' : String(v))

/** 某个父级下的直属子项（按 schema 里的原顺序，顺序本身就是展示顺序） */
export function cascadeChildren(options, parent = '') {
  const p = S(parent)
  return (options || []).filter(o => S(o.parent) === p)
}

/**
 * 修正父子关系里的两种坏数据：
 *  - parent 指向一个不存在的值（字典同步、Excel 导入、手工改值都可能留下）——
 *    这一项会永远不出现在任何下拉里，等于被静默删了；
 *  - 父子成环（A 的父是 B、B 的父是 A）——渲染时无限循环。
 * 两种都退化成顶层：宁可少一层缩进，也不能让选项消失或页面卡死。
 */
export function normalizeCascade(options) {
  const list = (options || []).map(o => ({ ...o, value: S(o.value), parent: S(o.parent) }))
  const byValue = new Map()
  for (const o of list) if (o.value && !byValue.has(o.value)) byValue.set(o.value, o)
  for (const o of list) {
    if (o.parent && !byValue.has(o.parent)) o.parent = ''
  }
  // 顺着 parent 往上走，走不出根（成环）的就提到顶层
  for (const o of list) {
    const seen = new Set([o.value])
    let cur = o
    let guard = 0
    while (cur.parent && guard++ < 1000) {
      if (seen.has(cur.parent)) { o.parent = ''; break }
      seen.add(cur.parent)
      cur = byValue.get(cur.parent) || { parent: '' }
    }
  }
  return list
}

/** 从根到该项的 value 路径；找不到该项返回 [] */
export function cascadePathOf(options, value) {
  const list = normalizeCascade(options)
  const byValue = new Map(list.map(o => [o.value, o]))
  const path = []
  let cur = byValue.get(S(value))
  let guard = 0
  while (cur && guard++ < 1000) {
    path.unshift(cur.value)
    cur = cur.parent ? byValue.get(cur.parent) : null
  }
  return path
}

/** 「浙江省 / 杭州市 / 西湖区」这样的一行文字 */
export function cascadeLabelPath(options, value, sep = ' / ') {
  const list = normalizeCascade(options)
  const byValue = new Map(list.map(o => [o.value, o]))
  return cascadePathOf(list, value).map(v => byValue.get(v)?.label || v).join(sep)
}

/**
 * 只留最后 N 级：「浙江省 / 杭州市 / 西湖区」在报表 x 轴上会转 45 度还被截断成
 * 「省 / 杭州市 / 西湖区」。末两级（杭州市 / 西湖区）已经足够区分，完整路径另给一份。
 */
export function cascadeLabelTail(options, value, levels = 2, sep = ' / ') {
  const list = normalizeCascade(options)
  const byValue = new Map(list.map(o => [o.value, o]))
  const path = cascadePathOf(list, value)
  const tail = levels > 0 ? path.slice(-levels) : path
  return tail.map(v => byValue.get(v)?.label || v).join(sep)
}

/** 作答 → 路径数组。老数据存的是单个值（字符串），统一包成一级路径 */
export function cascadeValuePath(value) {
  if (Array.isArray(value)) return value.map(S).filter(v => v !== '')
  if (value === undefined || value === null || value === '') return []
  return [S(value)]
}

/**
 * 选项树里一共有几层。用来决定渲染几个下拉框，
 * 也是「这题到底有没有配出层级」的判断依据。
 */
export function cascadeDepth(options) {
  const list = normalizeCascade(options)
  if (!list.length) return 0
  const byValue = new Map(list.map(o => [o.value, o]))
  let max = 1
  for (const o of list) {
    let depth = 1
    let cur = o
    let guard = 0
    while (cur.parent && guard++ < 1000) {
      depth++
      cur = byValue.get(cur.parent)
      if (!cur) break
    }
    if (depth > max) max = depth
  }
  return max
}

/**
 * 展平成「深度优先顺序 + 层级」，设计器的选项编辑器按这个顺序画：
 * 缩进就是层级，比在每行上再挂一个「父级下拉」直观得多。
 * 找不到父项的孤儿（父级值被改过）会在 normalizeCascade 里退化成顶层，所以不会漏项。
 */
export function cascadeFlat(options) {
  const list = normalizeCascade(options)
  const out = []
  const used = new Set()
  const walk = (parent, depth, guard) => {
    if (guard > 20) return
    for (const o of cascadeChildren(list, parent)) {
      if (used.has(o)) continue
      used.add(o)
      out.push({ ...o, depth })
      walk(o.value, depth + 1, guard + 1)
    }
  }
  walk('', 0, 0)
  // 重复 value 会让某个分支摘不到父项而走不到，这里按顶层兜回来，选项一个都不丢
  for (const o of list) if (!used.has(o)) out.push({ ...o, depth: 0 })
  return out
}

/**
 * 剪掉「祖先不在列表里」的项。
 *
 * 和 normalizeCascade 的兜底方向相反，这里是有意为之：字典里停用了「杭州市」，
 * 它的子项「西湖区」在选项树里就没有落脚点了。normalizeCascade 会把孤儿提到顶级，
 * 那会让「西湖区」突然和「浙江省」并列出现在第一个下拉里——比直接不显示更糟。
 * 所以「从字典取用」这条路先剪干净，剩下的就是一棵完整的树。
 */
export function pruneCascade(options) {
  // 先按原始 parent 判断，再交给 normalizeCascade：
  // 顺序反过来就晚了——normalizeCascade 已经把孤儿提成顶级，此时所有项都「有落脚点」
  const raw = (options || []).map(o => ({
    ...o,
    value: o.value === undefined || o.value === null ? '' : String(o.value),
    parent: o.parent === undefined || o.parent === null ? '' : String(o.parent)
  }))
  const byValue = new Map(raw.filter(o => o.value).map(o => [o.value, o]))
  const ok = new Set()
  const survives = (o, guard = 0) => {
    if (ok.has(o.value)) return true
    if (!o.parent) return true
    const up = byValue.get(o.parent)
    if (!up || guard > 500) return false
    return survives(up, guard + 1)
  }
  const kept = raw.filter(o => {
    const good = survives(o)
    if (good) ok.add(o.value)
    return good
  })
  return normalizeCascade(kept)
}
