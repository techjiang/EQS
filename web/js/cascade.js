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

/* ------------------------------------------------------------------
 * 搜索式选择。
 *
 * 三级下拉（省 / 市 / 区）翻起来还行，四级以上就不好用了：行业分类动辄几百个节点，
 * 用户知道自己要「西湖区」，却得先在下拉里翻到浙江省、再翻到杭州市——
 * 也就是说，他把答案打在输入框里的那两秒，比在下拉里翻三层快得多。
 *
 * 所以搜索在这里不是「加个过滤框」，而是另一条完整的作答路径：
 * 输入关键字 → 直接给出可点的完整路径 → 一次点击选中末级值。
 * 作答仍然只存末级那个 value，判分、必填、条件逻辑、统计口径一个字没变。
 * ------------------------------------------------------------------ */

/** 关键字归一：全角空格、大小写都不该影响搜索 */
const normKw = (s) => String(s ?? '').trim().toLowerCase()

/**
 * 在选项树里搜。
 *
 * 命中范围包括**路径上的任何一层**：搜「杭州」要能找到「杭州市 / 西湖区」，
 * 因为「杭州市下面的区」正是人找东西的方式。命中的那一级用 hit 标出来，
 * 前端据此把人搜的那个词高亮，否则一屏都是完整路径，看不出为什么这条会出现。
 *
 * 结果按「匹配层级浅的在前、同层按原顺序」排：搜「浙江」时省本身排第一，
 * 而不是把它的二十个区县顶到前面。
 */
export function cascadeSearch(options, keyword, { limit = 20 } = {}) {
  const kw = normKw(keyword)
  if (!kw) return []
  const list = normalizeCascade(options)
  const byValue = new Map(list.map(o => [o.value, o]))
  const hits = []
  for (const o of list) {
    const path = cascadePathOf(list, o.value)
    if (!path.length) continue
    const nodes = path.map(v => byValue.get(v)).filter(Boolean)
    const at = nodes.findIndex(n => String(n.label || '').toLowerCase().includes(kw))
    // 也认 value：从字典导入时 value 往往是英文短码（zhejiang / xihu），
    // 只认 label 的话「xihu」一个字都搜不到
    if (at < 0 && !String(o.value).toLowerCase().includes(kw)) continue
    hits.push({
      value: o.value,
      label: o.label,
      path: nodes.map(n => n.label || n.value),
      depth: nodes.length - 1,
      // 这条下面还有几个子项：命中的是「杭州市」而不是「西湖区」时，
      // 界面上要说一句「含 2 个下级」，否则人以为自己选到了区
      children: cascadeChildren(list, o.value).length,
      hit: at >= 0 ? at : nodes.length - 1,
      // 命中越浅排越前：搜「浙江」时省本身第一，而不是它的区县
      rank: at >= 0 ? at : nodes.length
    })
  }
  hits.sort((a, b) => (a.rank - b.rank) || (a.depth - b.depth))
  return limit > 0 ? hits.slice(0, limit) : hits
}

/**
 * 部门树 → 级联选项。
 *
 * 「按部门选人」这件事以前只能手填，而部门树早就在系统里维护着了：
 * 一份组织架构既要在用户管理里管，又要在问卷里再抄一遍，迟早两份不一样。
 *
 * value 用部门 id 的字符串：部门改名不该让历史答卷里的值失去对应项，
 * 而 id 是唯一稳定的东西（改名在字典那一轮已经踩过一次「改个错别字把答卷弄丢」）。
 */
export function deptTreeToOptions(depts) {
  const rows = (depts || []).filter(d => d && d.id !== undefined && d.id !== null)
  const ids = new Set(rows.map(d => String(d.id)))
  const options = rows.map(d => {
    const parent = String(d.parent_id ?? d.parentId ?? 0)
    // 上级已经不在列表里（部门被删了）就落到顶级：宁可少一层缩进，不能让部门在选择器里消失
    return { label: String(d.name ?? d.label ?? d.id), value: String(d.id), parent: parent === '0' || !ids.has(parent) ? '' : parent }
  })
  return normalizeCascade(options)
}

/** 一个值在部门树里的完整路径（导出、详情里给人看） */
export function deptLabelPath(depts, value) {
  return cascadeLabelPath(deptTreeToOptions(depts), value)
}

/**
 * 这道题该用哪种作答控件。
 *
 * 不是「新功能默认打开」：选项很少时（性别、学历三级）下拉本来就好用，
 * 硬塞一个搜索框只会让人多点一次。所以按规模走：
 *   - 显式配了 picker 就听配置（设计器里的开关）；
 *   - 否则节点数到 24 就换搜索——24 是一屏下拉翻到底的临界点，
 *     再多就得靠输入关键字，而不是靠往下滚。
 */
export function cascadeMode(field, options) {
  const want = field?.props?.picker
  if (want === 'search' || want === 'select') return want
  const list = options || normalizeCascade(field?.options)
  return list.length >= 24 ? 'search' : 'select'
}

/**
 * 把一棵选项树摊成「一行一个完整路径」的平铺列表。
 *
 * 单选 / 多选 / 下拉这类只能放一层选项的组件，也要能「从组织架构取人」——
 * 但直接把树的节点摊平，选项字面上只剩「张三」，两行同名就分不清是哪个部门的张三。
 * 所以平铺时把路径写进 label：「技术中心 / 后端组 / 张三」。
 * value 仍是末级值，判分与统计口径不变。
 */
export function cascadeFlatLabels(options, sep = ' / ') {
  const list = normalizeCascade(options)
  const byValue = new Map(list.map(o => [o.value, o]))
  const out = []
  for (const o of cascadeFlatLabelsOrder(list)) {
    const node = byValue.get(o.value)
    if (!node) continue
    const path = cascadePathOf(list, node.value).map(v => byValue.get(v)?.label || v)
    out.push({ ...node, label: path.join(sep), short: node.label, depth: path.length - 1 })
  }
  return out
}

/** 深度优先的稳定顺序：父级在前、同级按原顺序，和设计器里看到的一致 */
function cascadeFlatLabelsOrder(list) {
  const out = []
  const used = new Set()
  const walk = (parent, guard) => {
    if (guard > 20) return
    for (const o of cascadeChildren(list, parent)) {
      if (used.has(o.value)) continue
      used.add(o.value)
      out.push(o)
      walk(o.value, guard + 1)
    }
  }
  walk('', 0)
  for (const o of list) if (!used.has(o.value)) out.push(o)
  return out
}
