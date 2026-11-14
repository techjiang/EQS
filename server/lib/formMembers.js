import { get, all, run, now } from './db.js'
import { can } from './auth.js'
import { fail } from './http.js'

/**
 * 表单（问卷 / 考试）协作。
 *
 * Issue 原文那句「用户、角色、部门、职位、组织架构、**项目协作**、题库协作和 RBAC 权限控制」，
 * 前 20 轮把题库协作做完了，表单协作一直是空的：forms 只有 created_by 一个身份，
 * 「两个人一起做一份问卷」没法表达——要么共用管理员账号（审计日志里全是一个人），
 * 要么把表单复制一份各改一份，最后两份都不是最终版。
 *
 * 这里的判断必须收敛成一处，因为 created_by 的硬校验散在 form / submission / file 三个
 * 路由里 29 处。只加一张成员表而不改这些判断，结果会是「协作者在列表里看得见表单，
 * 点进去每一页都是 403」——比完全没有协作更让人恼火。
 *
 * 三档身份与题库保持一致，避免同一个词在两种资源里意思不同：
 *   owner  创建者（或管理员）：改、删、发布、管成员
 *   editor 可编辑：改内容、发布、看数据、导出、批阅
 *   viewer 只读：看表单与报表，不改内容、不导答卷明细
 */
export const FORM_MEMBER_ROLES = ['editor', 'viewer']

export const ROLE_LABEL = { owner: '所有者', editor: '可编辑', viewer: '只读' }

/** 我和这个表单是什么关系；看不出关系返回 null */
export function formRole(user, form) {
  if (!form || !user) return null
  if (can(user, '*')) return 'owner'
  if (Number(form.created_by) === Number(user.id)) return 'owner'
  const m = get('SELECT role FROM form_members WHERE form_id = ? AND user_id = ?', form.id, user.id)
  return m?.role || null
}

/**
 * 「我能看到哪些表单」的 SQL 片段。
 * 用子查询而不是先取 id 列表：表单可能上万张，把 id 全捞进内存再拼 IN 是另一种坑。
 */
export function formVisibleScope(user, alias = 'f') {
  if (can(user, '*')) return { sql: '1 = 1', args: [] }
  return {
    sql: `(${alias}.created_by = ? OR ${alias}.id IN (SELECT form_id FROM form_members WHERE user_id = ?))`,
    args: [user.id, user.id]
  }
}

/**
 * 答卷明细的可见范围。
 *
 * 注意这里只放 editor，不放 viewer：v1 的实现把两者一起放进去，于是「只读」协作者
 * 在数据页能看到每一份答卷的逐题作答、也能点删除，而导出接口又拦着他——同一个身份
 * 在一页里既算有权限又算没权限，是最难解释的一种。现在口径统一：
 *   viewer = 看表单结构 + 看报表汇总；明细（逐份答卷）属于 editor 及以上。
 * 不能导出却能在页面上逐行读，等于「只读」只是防了个下载按钮。
 */
export function submissionVisibleScope(user, subAlias = 's') {
  if (can(user, '*')) return { sql: '1 = 1', args: [] }
  return {
    sql: `(${subAlias}.form_id IN (SELECT id FROM forms WHERE created_by = ?) OR ${subAlias}.form_id IN (SELECT form_id FROM form_members WHERE user_id = ? AND role = 'editor'))`,
    args: [user.id, user.id]
  }
}

/**
 * 校验身份并按需要抛错。
 * need: 'view' 看得到就行 / 'edit' 改内容、发布、看数据 / 'own' 只有所有者
 */
export function requireFormRole(user, form, need = 'view') {
  const role = formRole(user, form)
  if (!role) fail(403, '无权访问该表单')
  if (need === 'edit' && role === 'viewer') fail(403, '你在该表单中是「只读」协作者，无法修改')
  if (need === 'own' && role !== 'owner') fail(403, '只有表单所有者可以执行该操作')
  return role
}

/** 可邀请的人：账号启用、还不是成员、不是创建者本人 */
export function memberCandidates(form) {
  return all(`SELECT u.id, u.username, u.nickname, u.avatar, d.name AS dept_name
    FROM users u LEFT JOIN depts d ON d.id = u.dept_id
    WHERE u.status = 1 AND u.id <> ?
      AND u.id NOT IN (SELECT user_id FROM form_members WHERE form_id = ?)
    ORDER BY u.id ASC`, form.created_by, form.id)
}

export function listMembers(form) {
  return all(`SELECT m.user_id, m.role, m.created_at, u.username, u.nickname, u.avatar, d.name AS dept_name
    FROM form_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN depts d ON d.id = u.dept_id
    WHERE m.form_id = ? ORDER BY m.rowid ASC`, form.id)
}

export function addMember(form, target, role, by) {
  run('INSERT INTO form_members(form_id, user_id, role, created_by, created_at) VALUES(?,?,?,?,?)',
    form.id, target.id, role, by.id, now())
}

export { now }
