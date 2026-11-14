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
    const deptTreeData = ref([])
    const positions = ref([])
    const tab = ref('users')
    const loading = ref(true)
    const editing = ref(null)
    const roleEditing = ref(null)
    const deptName = ref('')
    const deptParent = ref(0)
    const deptEditing = ref(null)
    const positionName = ref('')
    const positionDept = ref(0)
    const positionEditing = ref(null)

    const isAdmin = computed(() => state.user?.perms?.includes('*'))

    const load = async () => {
      loading.value = true
      try {
        const [u, r, d, p] = await Promise.all([
          api.get('/api/users'),
          api.get('/api/roles'),
          api.get('/api/depts').catch(() => ({ data: [] })),
          api.get('/api/positions').catch(() => ({ data: [] }))
        ])
        users.value = u.data
        roles.value = r.data
        depts.value = d.data
        deptTreeData.value = d.tree || []
        positions.value = p.data
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

    /* ---------------- 组织架构：部门树 + 职位 ---------------- */
    const addDept = async () => {
      if (!deptName.value.trim()) return err('请填写部门名称')
      try {
        await api.post('/api/depts', { name: deptName.value.trim(), parent_id: deptParent.value || 0 })
        deptName.value = ''
        ok('已添加')
        load()
      } catch (e) { err(e.message) }
    }

    const saveDept = async () => {
      const d = deptEditing.value
      try {
        await api.put(`/api/depts/${d.id}`, { name: d.name, parent_id: d.parent_id, sort: d.sort })
        ok('部门已更新')
        deptEditing.value = null
        load()
      } catch (e) { err(e.message) }
    }

    const removeDept = async (d) => {
      if (!await confirmBox(`删除部门「${d.name}」？`)) return
      try { await api.del(`/api/depts/${d.id}`); ok('已删除'); load() } catch (e) { err(e.message) }
    }

    const addPosition = async () => {
      if (!positionName.value.trim()) return err('请填写职位名称')
      try {
        await api.post('/api/positions', { name: positionName.value.trim(), dept_id: positionDept.value || 0 })
        positionName.value = ''
        ok('已添加')
        load()
      } catch (e) { err(e.message) }
    }

    const savePosition = async () => {
      const p = positionEditing.value
      try {
        await api.put(`/api/positions/${p.id}`, { name: p.name, dept_id: p.dept_id, sort: p.sort })
        ok('职位已更新')
        positionEditing.value = null
        load()
      } catch (e) { err(e.message) }
    }

    const removePosition = async (p) => {
      if (!await confirmBox(`删除职位「${p.name}」？`)) return
      try { await api.del(`/api/positions/${p.id}`); ok('已删除'); load() } catch (e) { err(e.message) }
    }

    /** 扁平带 depth 的部门列表，用于「上级部门」下拉 */
    const flatDepts = computed(() => {
      const out = []
      const walk = (nodes) => nodes.forEach(n => { out.push(n); walk(n.children || []) })
      walk(deptTreeData.value)
      return out
    })

    /** 用户表里的部门名带上级路径，重名部门（比如两个「后端组」）才分得清 */
    const deptPath = (id) => {
      const map = new Map(depts.value.map(d => [d.id, d]))
      const parts = []
      let cur = Number(id) || 0
      let guard = 0
      while (cur && map.has(cur) && guard++ < 20) {
        parts.unshift(map.get(cur).name)
        cur = Number(map.get(cur).parent_id) || 0
      }
      return parts.join(' / ')
    }

    /**
     * 改自己的密码必须验旧密码（后端也这么要求），所以走 /api/auth/me；
     * 改别人的才是「管理员重置」，走 /api/users/:id。
     * 之前两条路合成一条、都不验旧密码：借到一台没锁屏的电脑就能把账号密码改成 1 位。
     */
    const setPwd = async (u) => {
      const self = u.id === state.user?.id
      const oldPwd = self ? prompt(`请输入 ${u.username} 的当前密码`) : null
      if (self && !oldPwd) return
      const pwd = prompt(`为 ${u.username} 设置新密码（至少 6 位）`)
      if (!pwd) return
      try {
        if (self) {
          const r = await api.put('/api/auth/me', { oldPassword: oldPwd, password: pwd })
          ok('密码已修改，请用新密码重新登录')
          if (r?.relogin) { state.user = null; location.href = '/login' }
        } else {
          await api.put(`/api/users/${u.id}`, { password: pwd })
          ok('密码已重置')
        }
      } catch (e) { err(e.message) }
    }

    // 内置 admin 角色只允许改名：权限位锁死
    const locked = computed(() => roleEditing.value?.code === 'admin')

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [h('h1', {}, '用户与权限'), h('div', { class: 'sub' }, '用户、角色、部门与 RBAC 权限控制')]),
        h('div', { class: 'flex' }, isAdmin.value
          ? h('button', { class: 'btn primary', onClick: () => editing.value = { username: '', password: '', nickname: '', email: '', role_id: 2, dept_id: 0, position_id: 0, status: 1 } }, '+ 新增用户')
          : null)
      ]),
      h('div', { class: 'tabs', style: 'width:fit-content;margin-bottom:16px' }, [
        ['users', '用户'], ['roles', '角色权限'], ['depts', '部门']
      ].map(([v, l]) => h('button', { class: tab.value === v ? 'on' : '', onClick: () => tab.value = v }, l))),

      tab.value === 'users' ? h('div', { class: 'card', style: 'overflow:hidden' }, loading.value
        ? h('div', { style: 'padding:30px' }, '加载中…')
        : users.value.length ? h('div', { style: 'overflow-x:auto' }, h('table', { class: 'table' }, [
            h('thead', {}, h('tr', {}, ['用户', '账号', '邮箱', '角色', '部门 / 职位', '状态', '最后登录', '操作'].map(t => h('th', {}, t)))),
            h('tbody', {}, users.value.map(u => h('tr', {}, [
              h('td', {}, h('div', { class: 'flex' }, [
                h('img', { src: u.avatar || '/assets/eqs-mark.svg', style: 'width:26px;height:26px;border-radius:8px;object-fit:cover' }),
                h('span', { style: 'font-weight:540' }, u.nickname || u.username)
              ])),
              h('td', { class: 'mono' }, u.username),
              h('td', { class: 'small muted' }, u.email || '-'),
              h('td', {}, h('span', { class: 'tag brand' }, u.role_name || '-')),
              h('td', { class: 'small' }, [
                h('div', {}, deptPath(u.dept_id) || '-'),
                u.position_name ? h('div', { class: 'small muted' }, u.position_name) : null
              ]),
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

      tab.value === 'depts' ? h('div', { class: 'grid', style: 'grid-template-columns:1.4fr 1fr;align-items:start' }, [
        h('div', { class: 'card', style: 'overflow:hidden' }, [
          h('div', { class: 'card-h' }, [h('h3', {}, '部门'), h('span', { class: 'small muted' }, depts.value.length + ' 个')]),
          h('div', { class: 'card-b' }, [
            h('div', { class: 'flex mb', style: 'gap:6px;flex-wrap:wrap' }, [
              h('input', {
                class: 'input', style: 'max-width:200px', placeholder: '部门名称',
                value: deptName.value, onInput: e => deptName.value = e.target.value
              }),
              h('select', {
                class: 'select', style: 'max-width:180px', value: deptParent.value,
                onChange: e => deptParent.value = Number(e.target.value)
              }, [h('option', { value: 0 }, '作为顶级部门'), ...flatDepts.value.map(d => h('option', { value: d.id }, '　'.repeat(d.depth) + d.name))]),
              h('button', { class: 'btn primary', onClick: addDept }, '添加')
            ]),
            // 递归画树：层级靠左缩进表达，父部门不会被画成同级
            (function renderTree(nodes) {
              return nodes.length
                ? nodes.map(d => h('div', {}, [
                    h('div', {
                      class: 'flex between', style: 'padding:8px 0;border-bottom:1px solid var(--line-2);gap:8px'
                    }, [
                      h('div', {
                        class: 'flex', style: `gap:6px;align-items:center;padding-left:${d.depth * 18}px;min-width:0`
                      }, [
                        h('span', { class: 'small muted' }, d.children.length ? '▾' : '·'),
                        h('span', { style: 'font-weight:540' }, d.name),
                        h('span', { class: 'tag' }, `${d.user_count} 人`),
                        d.position_count ? h('span', { class: 'tag' }, `${d.position_count} 职位`) : null
                      ]),
                      h('div', { class: 'flex', style: 'gap:4px' }, [
                        h('button', { class: 'btn ghost sm', onClick: () => deptEditing.value = { ...d } }, '编辑'),
                        h('button', { class: 'btn ghost sm danger', onClick: () => removeDept(d) }, '删除')
                      ])
                    ]),
                    d.children.length ? renderTree(d.children) : null
                  ]))
                : h(Empty, { text: '暂无部门' })
            })(deptTreeData.value)
          ])
        ]),
        h('div', { class: 'card', style: 'overflow:hidden' }, [
          h('div', { class: 'card-h' }, [h('h3', {}, '职位'), h('span', { class: 'small muted' }, positions.value.length + ' 个')]),
          h('div', { class: 'card-b' }, [
            h('div', { class: 'flex mb', style: 'gap:6px;flex-wrap:wrap' }, [
              h('input', {
                class: 'input', style: 'max-width:170px', placeholder: '职位名称',
                value: positionName.value, onInput: e => positionName.value = e.target.value
              }),
              h('select', {
                class: 'select', style: 'max-width:150px', value: positionDept.value,
                onChange: e => positionDept.value = Number(e.target.value)
              }, [h('option', { value: 0 }, '不限部门'), ...flatDepts.value.map(d => h('option', { value: d.id }, '　'.repeat(d.depth) + d.name))]),
              h('button', { class: 'btn primary', onClick: addPosition }, '添加')
            ]),
            positions.value.length ? positions.value.map(p => h('div', {
              class: 'flex between', style: 'padding:8px 0;border-bottom:1px solid var(--line-2);gap:8px'
            }, [
              h('div', { style: 'min-width:0' }, [
                h('div', { style: 'font-weight:540' }, p.name),
                h('div', { class: 'small muted' }, [p.dept_name || '不限部门', `${p.user_count} 人`].join(' · '))
              ]),
              h('div', { class: 'flex', style: 'gap:4px' }, [
                h('button', { class: 'btn ghost sm', onClick: () => positionEditing.value = { ...p } }, '编辑'),
                h('button', { class: 'btn ghost sm danger', onClick: () => removePosition(p) }, '删除')
              ])
            ])) : h(Empty, { text: '暂无职位' })
          ])
        ])
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
              class: 'select', value: editing.value.dept_id,
              onChange: e => {
                editing.value.dept_id = Number(e.target.value)
                // 换了部门，原职位多半不属于新部门：不自动清掉就会留下「后端工程师 @ 市场部」这种数据
                const pos = positions.value.find(p => p.id === editing.value.position_id)
                if (pos && Number(pos.dept_id) !== Number(editing.value.dept_id)) editing.value.position_id = 0
              }
            }, [h('option', { value: 0 }, '未分配'), ...flatDepts.value.map(d => h('option', { value: d.id }, '　'.repeat(d.depth) + d.name))])])
          ]),
          h('div', { class: 'field' }, [h('label', {}, '职位'), h('select', {
            class: 'select', value: editing.value.position_id || 0, onChange: e => editing.value.position_id = Number(e.target.value)
          }, [h('option', { value: 0 }, '未分配'),
            // 列出该部门的职位 + 不限部门的职位；跨部门职位不给选，免得配出「市场部的后端工程师」
            ...positions.value
              .filter(p => !Number(p.dept_id) || Number(p.dept_id) === Number(editing.value.dept_id))
              .map(p => h('option', { value: p.id }, p.dept_name ? `${p.name}（${p.dept_name}）` : p.name))])]),
          h('div', { class: 'field' }, h('label', { class: 'flex between' }, [
            h('span', {}, '账号启用'),
            h('div', { class: ['switch', editing.value.status ? 'on' : ''], onClick: () => editing.value.status = editing.value.status ? 0 : 1 })
          ]))
        ],
        footer: [h('button', { class: 'btn', onClick: () => editing.value = null }, '取消'), h('button', { class: 'btn primary', onClick: save }, '保存')]
      }) : null,

      deptEditing.value ? Modal({
        title: '编辑部门', modelValue: true, onClose: () => deptEditing.value = null,
        children: [
          h('div', { class: 'field' }, [h('label', {}, '部门名称'), h('input', {
            class: 'input', value: deptEditing.value.name, onInput: e => deptEditing.value.name = e.target.value
          })]),
          h('div', { class: 'field' }, [h('label', {}, '上级部门'), h('select', {
            class: 'select', value: deptEditing.value.parent_id,
            onChange: e => deptEditing.value.parent_id = Number(e.target.value)
          }, [
            h('option', { value: 0 }, '顶级部门'),
            // 自己和自己的下级不能当上级：后端也拦，这里先不摆出来
            ...flatDepts.value.filter(d => d.id !== deptEditing.value.id).map(d => h('option', { value: d.id }, '　'.repeat(d.depth) + d.name))
          ])]),
          h('div', { class: 'field' }, [h('label', {}, '排序（小的在前）'), h('input', {
            class: 'input', type: 'number', value: deptEditing.value.sort,
            onInput: e => deptEditing.value.sort = Number(e.target.value)
          })])
        ],
        footer: [h('button', { class: 'btn', onClick: () => deptEditing.value = null }, '取消'), h('button', { class: 'btn primary', onClick: saveDept }, '保存')]
      }) : null,

      positionEditing.value ? Modal({
        title: '编辑职位', modelValue: true, onClose: () => positionEditing.value = null,
        children: [
          h('div', { class: 'field' }, [h('label', {}, '职位名称'), h('input', {
            class: 'input', value: positionEditing.value.name, onInput: e => positionEditing.value.name = e.target.value
          })]),
          h('div', { class: 'field' }, [h('label', {}, '所属部门'), h('select', {
            class: 'select', value: positionEditing.value.dept_id,
            onChange: e => positionEditing.value.dept_id = Number(e.target.value)
          }, [h('option', { value: 0 }, '不限部门'), ...flatDepts.value.map(d => h('option', { value: d.id }, '　'.repeat(d.depth) + d.name))])])
        ],
        footer: [h('button', { class: 'btn', onClick: () => positionEditing.value = null }, '取消'), h('button', { class: 'btn primary', onClick: savePosition }, '保存')]
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
