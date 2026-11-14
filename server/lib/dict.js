import { get, all, run, now } from './db.js'

/**
 * 数据字典。
 *
 * 存在的理由很朴素：「学历」「行业」「部门」这类选项在十几张表单里各写一遍，
 * 改一个说法就要改十几处，且一定会漏。字典让它们只有一份来源。
 *
 * 一个刻意的取舍：表单绑定字典时存的是**快照**，不是引用。
 * 引用看起来更"先进"，但它的代价是——改一次字典，「上个月已经发出去、已经收回来 3000 份答卷」
 * 那张表的选项跟着变，历史答卷里的值突然对不上任何选项，报表里全成「其他」。
 * 所以字典改动只影响「以后主动同步」的表单，同步时把增删项摊开给人看。
 */

/** 把 code 规范成能当键用的形状：中文名可以直接当 code（URL 里会编码），但不许有空格和斜杠 */
export function normalizeCode(raw, fallbackName = '') {
  const src = String(raw || fallbackName || '').trim()
  if (!src) return ''
  return src.replace(/\s+/g, '_').replace(/[/\\?#%&]/g, '').slice(0, 40)
}

export function listTypes({ withItems = false } = {}) {
  const rows = all(`SELECT t.*, (SELECT COUNT(*) FROM dict_items i WHERE i.type_code = t.code) AS item_count,
      (SELECT COUNT(*) FROM dict_items i WHERE i.type_code = t.code AND i.enabled = 1) AS enabled_count
    FROM dict_types t ORDER BY t.sort, t.id`)
  if (!withItems) return rows
  return rows.map(t => ({ ...t, items: listItems(t.code) }))
}

export function listItems(code, { onlyEnabled = false } = {}) {
  return all(`SELECT * FROM dict_items WHERE type_code = ? ${onlyEnabled ? 'AND enabled = 1' : ''} ORDER BY sort, id`, code)
}

/** 字典项转成表单选项：value 空着就用 label，与设计器手写选项的行为保持一致 */
export function itemsToOptions(items) {
  return items.map(i => ({ label: i.label, value: String(i.value || i.label) }))
}

/**
 * 哪些表单绑定了这个字典。
 * 快照式绑定的副作用：字典删了，表单照常能用（选项已经抄进 schema），
 * 但「同步」按钮从此没了来源——所以删除前要告诉人有多少张表单挂着它。
 */
export function formsUsing(code) {
  // SQL 里只做粗筛（schema 里出现过 dict 字样），真正的判断在 JSON 上做：
  // 用 LIKE 拼 `"dict":"code"` 依赖 JSON 序列化的键序和空格，改一次序列化就静默漏判。
  const rows = all("SELECT id, title, schema FROM forms WHERE deleted_at IS NULL AND schema LIKE '%\"dict\"%' ORDER BY id")
  const hit = []
  for (const r of rows) {
    let schema = []
    try { schema = JSON.parse(r.schema) } catch { continue }
    if (Array.isArray(schema) && schema.some(f => f && f.props && f.props.dict === code)) hit.push({ id: r.id, title: r.title })
  }
  return hit
}

export function touchType(code) {
  // 类型本身没有 updated_at 列，这里只是留一个统一入口，将来要加审计时改一处
  return code
}

export const dictNow = now
export { get, all, run }
