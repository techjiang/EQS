import { h, ref, onMounted, computed } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { state } from '../store.js'
import { ok, err, confirmBox, Empty, Modal } from '../ui.js'
import { Icon } from '../icons.js'

/**
 * 数据字典管理。
 *
 * 界面就两栏：左边字典清单，右边选项明细。
 * 一个刻意的设计——选项是「表格里直接改、点保存一次提交」，不是逐条弹窗。
 * 维护字典的人手上有的是从 Excel 抄来的一列清单，一次改五条的才是常态。
 */
export default {
  setup() {
    const types = ref([])
    const activeCode = ref('')
    const detail = ref(null)
    const loading = ref(true)
    const saving = ref(false)
    const draft = ref([])          // 正在编辑的选项副本
    const editingType = ref(null)  // 新建 / 编辑字典本身
    const importOpen = ref(false)
    const importText = ref('')
    const dirty = ref(false)

    const isAdmin = computed(() => state.user?.perms?.includes('*'))
    const active = computed(() => types.value.find(t => t.code === activeCode.value) || null)

    const load = async () => {
      loading.value = true
      try {
        const r = await api.get('/api/dicts')
        types.value = r.data
        if (!activeCode.value || !r.data.some(t => t.code === activeCode.value)) {
          activeCode.value = r.data[0]?.code || ''
        }
        await loadDetail()
      } catch (e) { err(e.message) } finally { loading.value = false }
    }

    const loadDetail = async () => {
      if (!activeCode.value) { detail.value = null; draft.value = []; return }
      const r = await api.get(`/api/dicts/${encodeURIComponent(activeCode.value)}`)
      detail.value = r.data
      usedBy.value = r.usedBy || []
      draft.value = (r.data.items || []).map(i => ({ ...i }))
      dirty.value = false
    }
    const usedBy = ref([])
    onMounted(load)

    const pick = (code) => {
      if (dirty.value && !confirm('当前字典有未保存的修改，切换会丢掉，继续？')) return
      activeCode.value = code
      loadDetail().catch(e => err(e.message))
    }

    const touch = () => { dirty.value = true }

    const addRow = () => {
      draft.value.push({ id: 0, label: '', value: '', enabled: 1, sort: (draft.value.length + 1) * 10 })
      touch()
    }
    const removeRow = (i) => {
      draft.value.splice(i, 1)
      touch()
    }
    const move = (i, delta) => {
      const j = i + delta
      if (j < 0 || j >= draft.value.length) return
      const [x] = draft.value.splice(i, 1)
      draft.value.splice(j, 0, x)
      draft.value.forEach((it, k) => it.sort = (k + 1) * 10)
      touch()
    }

    const saveItems = async () => {
      saving.value = true
      try {
        // 空行直接丢掉：点了一次「+ 添加」又没填，不该报错也不该存进一条空选项
        const items = draft.value.filter(i => String(i.label || '').trim())
        const r = await api.put(`/api/dicts/${encodeURIComponent(activeCode.value)}/items`, { items })
        draft.value = (r.data || []).map(i => ({ ...i }))
        dirty.value = false
        ok(r.dropped ? `已保存，重复值的 ${r.dropped} 项被忽略` : '已保存')
        load()
      } catch (e) { err(e.message) } finally { saving.value = false }
    }

    const saveType = async () => {
      const t = editingType.value
      try {
        if (t.id) await api.put(`/api/dicts/${encodeURIComponent(t.code)}`, { name: t.name, description: t.description, sort: t.sort })
        else {
          const r = await api.post('/api/dicts', { code: t.code, name: t.name, description: t.description, items: [] })
          activeCode.value = r.code
        }
        ok('已保存')
        editingType.value = null
        load()
      } catch (e) { err(e.message) }
    }

    const removeType = async () => {
      const t = active.value
      const n = usedBy.value.length
      const msg = n
        ? `删除字典「${t.name}」？有 ${n} 张表单绑定了它（${usedBy.value.map(f => f.title).slice(0, 3).join('、')}${n > 3 ? ' 等' : ''}）。表单里的选项是快照，删了照样能填，但这些表单从此无法再「从字典同步」。`
        : `删除字典「${t.name}」？`
      if (!await confirmBox(msg)) return
      try {
        await api.del(`/api/dicts/${encodeURIComponent(t.code)}`)
        ok('已删除')
        activeCode.value = ''
        load()
      } catch (e) { err(e.message) }
    }

    const doImport = async () => {
      if (!importText.value.trim()) return err('请粘贴选项文本')
      try {
        const r = await api.post(`/api/dicts/${encodeURIComponent(activeCode.value)}/items/import`, { text: importText.value })
        ok(`新增 ${r.added} 项${r.skipped ? `，跳过已有 ${r.skipped} 项` : ''}`)
        importOpen.value = false
        importText.value = ''
        loadDetail()
        load()
      } catch (e) { err(e.message) }
    }

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [
          h('h1', {}, '数据字典'),
          h('div', { class: 'sub' }, '学历、行业、部门这类固定选项集中维护一份，表单绑定后一键同步')
        ]),
        isAdmin.value ? h('button', {
          class: 'btn primary',
          onClick: () => editingType.value = { code: '', name: '', description: '', sort: (types.value.length + 1) * 10 }
        }, [Icon('plus', { style: 'width:14px;height:14px' }), ' 新建字典']) : null
      ]),

      loading.value ? h('div', { class: 'card skeleton', style: 'height:280px' })
        : !types.value.length ? h('div', { class: 'card' }, h(Empty, { text: '还没有字典，点右上角新建一套' }))
        : h('div', { class: 'dict-grid' }, [
            /* 左：字典清单 */
            h('div', { class: 'card', style: 'overflow:hidden;align-self:start' }, [
              h('div', { class: 'card-h' }, [h('h3', {}, '字典'), h('span', { class: 'small muted' }, types.value.length + ' 套')]),
              h('div', { class: 'dict-list' }, types.value.map(t => h('div', {
                class: ['dict-item', t.code === activeCode.value ? 'on' : ''],
                onClick: () => pick(t.code)
              }, [
                h('div', { style: 'min-width:0' }, [
                  h('div', { class: 'dict-name' }, t.name),
                  h('div', { class: 'small muted mono', style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, t.code)
                ]),
                h('span', { class: 'tag' }, `${t.enabled_count}/${t.item_count}`)
              ])))
            ]),

            /* 右：选项明细 */
            active.value ? h('div', { class: 'card', style: 'overflow:hidden' }, [
              h('div', { class: 'card-h', style: 'align-items:flex-start' }, [
                h('div', { style: 'min-width:0' }, [
                  h('h3', {}, active.value.name),
                  h('div', { class: 'small muted', style: 'margin-top:2px' }, active.value.description || '无说明')
                ]),
                h('div', { class: 'flex', style: 'gap:6px;flex-wrap:wrap' }, isAdmin.value ? [
                  dirty.value ? h('span', { class: 'tag warn' }, '有未保存的修改') : null,
                  h('button', { class: 'btn sm', onClick: () => editingType.value = { ...active.value } }, '改名'),
                  h('button', { class: 'btn sm', onClick: () => importOpen.value = true }, '粘贴导入'),
                  h('button', { class: 'btn sm', onClick: addRow }, '+ 添加选项'),
                  h('button', { class: 'btn primary sm', disabled: saving.value, onClick: saveItems }, saving.value ? '保存中…' : '保存选项'),
                  h('button', { class: 'btn sm danger', onClick: removeType }, '删除')
                ] : null)
              ]),

              // 哪些表单在用：只报告，不做「一键全同步」——同步会改动已经发出去的表，得逐张确认
              usedBy.value.length ? h('div', { class: 'dict-used' }, [
                h('span', { class: 'small muted' }, `被 ${usedBy.value.length} 张表单绑定：`),
                ...usedBy.value.slice(0, 6).map(f => h('a', {
                  class: 'tag', href: `/forms/${f.id}/design`, 'data-link': true
                }, f.title)),
                usedBy.value.length > 6 ? h('span', { class: 'small muted' }, `等 ${usedBy.value.length} 张`) : null
              ]) : h('div', { class: 'dict-used' }, h('span', { class: 'small muted' }, '还没有表单绑定这套字典')),

              draft.value.length ? h('div', { style: 'overflow-x:auto' }, h('table', { class: 'table dict-table' }, [
                h('thead', {}, h('tr', {}, ['#', '显示名称', '存储值', '启用', '排序', '操作'].map(t => h('th', {}, t)))),
                h('tbody', {}, draft.value.map((it, i) => h('tr', {}, [
                  h('td', { class: 'small muted' }, String(i + 1)),
                  h('td', {}, h('input', {
                    class: 'input sm', value: it.label, placeholder: '例如：本科',
                    onInput: e => { it.label = e.target.value; if (!it.value || it.value === it.label) it.value = e.target.value; touch() }
                  })),
                  h('td', {}, h('input', {
                    class: 'input sm mono', value: it.value, placeholder: '留空＝同名',
                    onInput: e => { it.value = e.target.value; touch() }
                  })),
                  h('td', {}, h('div', {
                    class: ['switch', it.enabled ? 'on' : ''],
                    title: it.enabled ? '停用后不再下发给表单' : '启用',
                    onClick: () => { it.enabled = it.enabled ? 0 : 1; touch() }
                  })),
                  h('td', { class: 'nowrap' }, h('div', { class: 'flex', style: 'gap:2px' }, [
                    h('button', { class: 'btn ghost sm', onClick: () => move(i, -1) }, '↑'),
                    h('button', { class: 'btn ghost sm', onClick: () => move(i, 1) }, '↓')
                  ])),
                  h('td', {}, h('button', { class: 'btn ghost sm danger', onClick: () => removeRow(i) }, '删除'))
                ])))
              ])) : h('div', { class: 'card-b' }, h(Empty, { text: '这套字典还没有选项' }))
            ]) : null
          ]),

      /* 新建 / 改名 */
      editingType.value ? Modal({
        title: editingType.value.id ? '编辑字典' : '新建字典', modelValue: true, onClose: () => editingType.value = null,
        children: [
          h('div', { class: 'field' }, [h('label', {}, '名称'), h('input', {
            class: 'input', value: editingType.value.name, placeholder: '例如：学历',
            onInput: e => editingType.value.name = e.target.value
          })]),
          h('div', { class: 'field' }, [
            h('label', {}, '标识（代码里引用、表单存的就是它）'),
            h('input', {
              class: 'input mono', value: editingType.value.code, disabled: !!editingType.value.id,
              placeholder: 'education（留空则用名称）',
              onInput: e => editingType.value.code = e.target.value
            }),
            h('div', { class: 'hint' }, editingType.value.id ? '标识是表单里存的值，建立之后不能再改' : '建议用英文短标识；中文也能用，会被编码进地址')
          ]),
          h('div', { class: 'field' }, [h('label', {}, '说明'), h('input', {
            class: 'input', value: editingType.value.description || '',
            onInput: e => editingType.value.description = e.target.value
          })])
        ],
        footer: [
          h('button', { class: 'btn', onClick: () => editingType.value = null }, '取消'),
          h('button', { class: 'btn primary', onClick: saveType }, '保存')
        ]
      }) : null,

      /* 粘贴导入 */
      importOpen.value ? Modal({
        title: '粘贴导入选项', modelValue: true, onClose: () => importOpen.value = false,
        children: [
          h('div', { class: 'hint mb' }, '一行一项。只有名称就写名称；需要单独的存储值时写成「名称|值」（也认逗号和制表符分隔）。已有的值会自动跳过。'),
          h('textarea', {
            class: 'textarea mono', style: 'min-height:220px',
            placeholder: '初中及以下\n高中 / 中专\n本科|bachelor\n硕士',
            value: importText.value, onInput: e => importText.value = e.target.value
          })
        ],
        footer: [
          h('button', { class: 'btn', onClick: () => importOpen.value = false }, '取消'),
          h('button', { class: 'btn primary', onClick: doImport }, '导入')
        ]
      }) : null
    ])
  }
}
