import { all } from './db.js'
// 部门树 → 级联选项的换算只有一份：设计器取用时、同步时、导出时都按它算，
// 各写一遍的结果是「页面上看着是三级的，导出却只剩部门名」
import { deptTreeToOptions } from '../../web/js/cascade.js'

/** 全站部门（扁平），按 sort 排好——顺序本身就是展示顺序 */
export function deptRows() {
  return all('SELECT id, name, parent_id, sort FROM depts ORDER BY sort, id')
}

/**
 * 部门树转成级联选项。
 *
 * 「按部门选人 / 按部门报事」这类题以前只能手填一串部门名，而部门树早在用户管理里维护着：
 * 同一套组织架构抄两遍，迟早两份不一样——改了一边，问卷里还是旧部门。
 *
 * value 用部门 id 而不是名字：部门改名是常事，改名不该让已经收上来的答卷失去对应项
 * （字典那一轮已经因为「改个错别字」踩过一次这个坑）。
 */
export function deptOptions() {
  return deptTreeToOptions(deptRows())
}

/** 「技术中心 / 后端组」，给人看的那一行 */
export function deptLabelOf(options, value) {
  const byValue = new Map(options.map(o => [String(o.value), o]))
  const path = []
  let cur = byValue.get(String(value ?? ''))
  let guard = 0
  while (cur && guard++ < 200) {
    path.unshift(cur.label)
    cur = cur.parent ? byValue.get(String(cur.parent)) : null
  }
  return path.join(' / ')
}
