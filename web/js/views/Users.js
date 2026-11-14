import { h, ref, onMounted, computed } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { state } from '../store.js'
import { ok, err, confirmBox, fmtDate, Empty, Modal } from '../ui.js'

const PERMS = [
  ['form:create', '创建表单'], ['form:read', '查看表单'], ['form:update', '编辑表单'], ['form:delete', '删除表单'],
  ['data:read', '查看数据'], ['data:write', '编辑数据'], ['bank:read', '查看题库'], ['bank:write', '编辑题库'], ['report:read', '查看报表']
]

export default {
  setup() {
    const users = ref([])
    const roles = ref([])
    const depts = ref([])
    const tab = ref('users')
    const loading = ref(true)
    const editing = ref(null)
    const roleEditing = ref(null)
    const deptName = ref('')

    const isAdmin = computed(() => state.user?.perms?.includes('*'))

    const load = async () => {
      loading.value = true
      try {
        const [u, r, d] = await Promise.all([
          api.get('/api/users'),
          api.get('/api/roles'),
          api.get('/api/depts').catch(() => ({ data: [] }))
        ])
        users.value = u.data
        roles.value = r.data
        depts.value = d.data
      } catch (e) { err(e.message) } finally { loading.value = false }
    }
    onMounted(load)

    const save = async () => {
      const u = editing.value
      try {
        if (u.id) await api.put(`/api/users/${u.id}`, u)
        else await api.post('/api/users', u)
        ok('已保存')
        editing.value = null
        load()
      } catch (e) { err(e.message) }
    }

    const remove = async (u) => {
      if (!await confirmBox(`删除用户「${u.username}」？`)) return
      try { await api.del(`/api/users/${u.id}`); ok('已删除'); load() } catch (e) { err(e.message) }
    }

    const saveRole = async () => {
      try {
        await api.put(`/api/roles/${roleEditing.value.id}`, { name: roleEditing.value.name, perms: roleEditing.value.perms })
        ok('角色已更新')
        roleEditing.value = null
        load()
      } catch (e) { err(e.message) }
    }

    const addDept = async () => {
      if (!deptName.value.trim()) return
      try { await api.post('/api/depts', { name: deptName.value }); deptName.value = ''; ok('已添加'); load() } catch (e) { err(e.message) }
    }

    const setPwd = async (u) => {
      const pwd = prompt(`为 ${u.username} 设置新密码（至少 6 位）`)
      if (!pwd) return
      try { await api.put(`/api/users/${u.id}`, { password: pwd }); ok('密码已重置') } catch (e) { err(e.message) }
    }

    // 内置 admin 角色只允许改名：权限位锁死
    const locked = computed(() => roleEditing.value?.code === 'admin')

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [h('h1', {}, '用户与权限'), h('div', { class: 'sub' }, '用户、角色、部门与 RBAC 权限控制')]),
        h('div', { class: 'flex' }, isAdmin.value
          ? h('button', { class: 'btn primary', onClick: () => editing.value = { username: '', password: '', nickname: '', email: '', role_id: 2, dept_id: 0, status: 1 } }, '+ 新增用户')
          : null)
      ]),
      h('div', { class: 'tabs', style: 'width:fit-content;margin-bottom:16px' }, [
        ['users', '用户'], ['roles', '角色权限'], ['depts', '部门']
      ].map(([v, l]) => h('button', { class: tab.value === v ? 'on' : '', onClick: () => tab.value = v }, l))),

      tab.value === 'users' ? h('div', { class: 'card', style: 'overflow:hidden' }, loading.value
        ? h('div', { style: 'padding:30px' }, '加载中…')
        : users.value.length ? h('div', { style: 'overflow-x:auto' }, h('table', { class: 'table' }, [
            h('thead', {}, h('tr', {}, ['用户', '账号', '邮箱', '角色', '部门', '状态', '最后登录', '操作'].map(t => h('th', {}, t)))),
            h('tbody', {}, users.value.map(u => h('tr', {}, [
              h('td', {}, h('div', { class: 'flex' }, [
                h('img', { src: u.avatar || '/assets/eqs-mark.svg', style: 'width:26px;height:26px;border-radius:8px;object-fit:cover' }),
                h('span', { style: 'font-weight:540' }, u.nickname || u.username)
              ])),
              h('td', { class: 'mono' }, u.username),
              h('td', { class: 'small muted' }, u.email || '-'),
              h('td', {}, h('span', { class: 'tag brand' }, u.role_name || '-')),
              h('td', { class: 'small' }, u.dept_name || '-'),
              h('td', {}, h('span', { class: ['tag', u.status ? 'ok' : 'danger'] }, u.status ? '正常' : '禁用')),
              h('td', { class: 'small muted nowrap' }, fmtDate(u.last_login_at)),
              h('td', { class: 'nowrap' }, h('div', { class: 'flex', style: 'gap:4px' }, [
                h('button', { class: 'btn ghost sm', onClick: () => editing.value = { ...u } }, '编辑'),
                h('button', { class: 'btn ghost sm', onClick: () => setPwd(u) }, '改密'),
                isAdmin.value && u.username !== 'admin' ? h('button', { class: 'btn ghost sm danger', onClick: () => remove(u) }, '删除') : null
              ]))
            ])))
          ])) : h(Empty, { text: '暂无用户' })) : null,

      tab.value === 'roles' ? h('div', { class: 'card', style: 'overflow:hidden' }, h('table', { class: 'table' }, [
        h('thead', {}, h('tr', {}, ['角色', '标识', '权限', '使用中', '操作'].map(t => h('th', {}, t)))),
        h('tbody', {}, roles.value.map(r => h('tr', {}, [
          h('td', { style: 'font-weight:540' }, r.name),
          h('td', { class: 'mono' }, r.code),
          h('td', {}, h('div', { class: 'flex wrap', style: 'gap:4px' }, r.perms.includes('*')
            ? [h('span', { class: 'tag ok' }, '全部权限')]
            : r.perms.map(p => h('span', { class: 'tag' }, PERMS.find(x => x[0] === p)?.[1] || p)))),
          // 有人在用的角色不能删：删完这些用户会挂在一个不存在的 role_id 上，
          // 权限全空，登录后每个按钮都「权限不足」，而他自己的资料页看不出原因。
          h('td', {}, h('span', { class: 'tag' }, r.user_count ? `${r.user_count} 人` : '未使用')),
          h('td', {}, isAdmin.value ? h('button', { class: 'btn ghost sm', onClick: () => roleEditing.value = { ...r, perms: [...r.perms] } }, '编辑') : null)
        ])))
      ])) : null,

      tab.value === 'depts' ? h('div', { class: 'card pad' }, [
        h('div', { class: 'flex mb' }, [
          h('input', { class: 'input', style: 'max-width:260px', placeholder: '部门名称', value: deptName.value, onInput: e => deptName.value = e.target.value }),
          h('button', { class: 'btn primary', onClick: addDept }, '添加部门')
        ]),
        depts.value.length ? depts.value.map(d => h('div', {
          class: 'flex between', style: 'padding:10px 0;border-bottom:1px solid var(--line-2)'
        }, [h('span', {}, d.name), h('span', { class: 'small muted' }, '#' + d.id)])) : h(Empty, { text: '暂无部门' })
      ]) : null,

      editing.value ? Modal({
        title: editing.value.id ? '编辑用户' : '新增用户', modelValue: true, onClose: () => editing.value = null,
        children: [
          h('div', { class: 'field' }, [h('label', {}, '账号'), h('input', {
            class: 'input', value: editing.value.username, disabled: !!editing.value.id,
            onInput: e => editing.value.username = e.target.value
          })]),
          h('div', { class: 'field' }, [h('label', {}, editing.value.id ? '新密码（留空不改）' : '密码'), h('input', {
            class: 'input', type: 'password', value: editing.value.password || '', onInput: e => editing.value.password = e.target.value
          })]),
          h('div', { class: 'field' }, [h('label', {}, '昵称'), h('input', {
            class: 'input', value: editing.value.nickname || '', onInput: e => editing.value.nickname = e.target.value
          })]),
          h('div', { class: 'field' }, [h('label', {}, '邮箱'), h('input', {
            class: 'input', value: editing.value.email || '', onInput: e => editing.value.email = e.target.value
          })]),
          h('div', { class: 'row' }, [
            h('div', { class: 'field' }, [h('label', {}, '角色'), h('select', {
              class: 'select', value: editing.value.role_id, onChange: e => editing.value.role_id = Number(e.target.value)
            }, roles.value.map(r => h('option', { value: r.id }, r.name)))]),
            h('div', { class: 'field' }, [h('label', {}, '部门'), h('select', {
              class: 'select', value: editing.value.dept_id, onChange: e => editing.value.dept_id = Number(e.target.value)
            }, [h('option', { value: 0 }, '未分配'), ...depts.value.map(d => h('option', { value: d.id }, d.name))])])
          ]),
          h('div', { class: 'field' }, h('label', { class: 'flex between' }, [
            h('span', {}, '账号启用'),
            h('div', { class: ['switch', editing.value.status ? 'on' : ''], onClick: () => editing.value.status = editing.value.status ? 0 : 1 })
          ]))
        ],
        footer: [h('button', { class: 'btn', onClick: () => editing.value = null }, '取消'), h('button', { class: 'btn primary', onClick: save }, '保存')]
      }) : null,

      roleEditing.value ? Modal({
        title: '编辑角色 · ' + roleEditing.value.name, modelValue: true, onClose: () => roleEditing.value = null,
        children: [
          h('div', { class: 'field' }, [h('label', {}, '角色名称'), h('input', {
            class: 'input', value: roleEditing.value.name, onInput: e => roleEditing.value.name = e.target.value
          })]),
          locked ? h('div', { class: 'hint' }, '内置「超级管理员」的权限位不可修改——勾掉它，就再没有人能改回来了。') : null,
          locked
            // 锁死的角色不摆一长串禁用勾选框（看着像「勾了但点不动」，比「不给你碰」更让人困惑），
            // 直接说明它就是全部权限。
            ? h('div', { class: 'field' }, [h('label', {}, '权限'), h('div', { class: 'flex wrap', style: 'gap:6px' }, [
                h('span', { class: 'tag ok' }, '全部权限'),
                h('span', { class: 'tag' }, '含用户、角色、设置、日志')
              ])])
            : h('div', { class: 'field' }, [h('label', {}, '权限'), h('div', { class: 'grid c2' }, PERMS.map(([p, l]) => h('label', {
                class: 'flex small', style: 'cursor:pointer'
              }, [
                h('input', {
                  type: 'checkbox', style: 'accent-color:var(--brand)',
                  checked: roleEditing.value.perms.includes(p) || roleEditing.value.perms.includes('*'),
                  onChange: e => {
                    const set = new Set(roleEditing.value.perms.filter(x => x !== '*'))
                    e.target.checked ? set.add(p) : set.delete(p)
                    roleEditing.value.perms = [...set]
                  }
                }),
                h('span', {}, l)
              ])))])
        ],
        footer: [h('button', { class: 'btn', onClick: () => roleEditing.value = null }, '取消'), h('button', { class: 'btn primary', onClick: saveRole }, '保存')]
      }) : null
    ])
  }
}
