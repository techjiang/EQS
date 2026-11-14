import { all } from './db.js'
// 部门树 → 级联选项的换算只有一份：设计器取用时、同步时、导出时都按它算，
// 各写一遍的结果是「页面上看着是三级的，导出却只剩部门名」
import { deptTreeToOptions, cascadeLabelPath } from '../../web/js/cascade.js'

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

/**
 * 组织架构 → 级联选项：部门是层级，人是叶子。
 *
 * 「按部门取人」和「按部门报事」是两件事。上一轮只做到了前者的一半——
 * 题目里能选到「技术中心 / 后端组」，却选不到具体是谁；要选人只能另开一个手填姓名的题。
 * 而人早就挂在部门树下了（用户管理里维护着 dept_id）。
 *
 * value 用 `d<id>` / `u<id>` 两种前缀：部门和人各有一张自增 id 表，
 * 只写数字的话「部门 2」和「用户 2」在同一个选项树里会撞成同一个值，
 * 答题人选中的人统计出来变成部门。
 *
 * 只用启用账号：选项来源是给人挑的名单，停用账号摆在名单里，
 * 只会让「选了他，他却登录不了」成为一次事故。已停用的人仍认得历史答卷里的值——
 * 答卷存的是 id，不依赖选项还在不在。
 */
export function orgOptions() {
  const depts = deptRows()
  const users = all(`SELECT id, username, nickname, dept_id, status FROM users
    WHERE status = 1 ORDER BY dept_id, id`)
  const deptIds = new Set(depts.map(d => String(d.id)))
  // 同名的人不止一个：只写昵称，选项列表里会出现两行一模一样的「张伟」，选谁都说不清
  const nameCount = new Map()
  for (const u of users) {
    const name = String(u.nickname || u.username || ('用户 ' + u.id))
    nameCount.set(name, (nameCount.get(name) || 0) + 1)
  }
  const options = depts.map(d => {
    const parent = String(d.parent_id ?? 0)
    return {
      label: String(d.name), value: 'd' + d.id,
      parent: parent === '0' || !deptIds.has(parent) ? '' : 'd' + parent,
      // dept 标记只用于前端把「部门」和「人」分开显示，不参与作答口径
      kind: 'dept'
    }
  })
  for (const u of users) {
    const name = String(u.nickname || u.username || ('用户 ' + u.id))
    const dup = (nameCount.get(name) || 0) > 1
    options.push({
      label: dup ? `${name}（@${u.username}）` : name,
      value: 'u' + u.id,
      // 部门被删掉的人落到顶级：宁可少一层缩进，不能让人在名单里消失
      parent: deptIds.has(String(u.dept_id)) ? 'd' + u.dept_id : '',
      kind: 'user',
      username: u.username
    })
  }
  return options
}

/** 人 / 部门在组织架构里的完整路径，「技术中心 / 后端组 / 张三」 */
export function orgLabelOf(value) {
  return cascadeLabelPath(orgOptions(), value)
}
