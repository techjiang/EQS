import { h, ref, onMounted, computed } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { route } from '../router.js'
import { ok, err, confirmBox, fmtDate, Empty, Modal, Pagination } from '../ui.js'
import { Icon } from '../icons.js'
import { renderControl } from '../renderer.js'

export default {
  setup() {
    const forms = ref([])
    const formId = ref(Number(route.value.query.formId) || 0)
    const rows = ref([])
    const total = ref(0)
    const page = ref(1)
    const totalPages = ref(1)
    const keyword = ref('')
    const marked = ref(false)
    const loading = ref(true)
    const detail = ref(null)
    const editing = ref(null)
    const form = ref(null)
    const selected = ref([])
    const importing = ref(false)

    const loadForms = async () => {
      const r = await api.get('/api/forms?pageSize=200')
      forms.value = r.data
      if (!formId.value && forms.value.length) formId.value = forms.value[0].id
      if (formId.value) await loadForm()
    }

    const loadForm = async () => {
      if (!formId.value) return
      const r = await api.get(`/api/forms/${formId.value}`)
      form.value = r.data
    }

    const load = async () => {
      if (!formId.value) { loading.value = false; return }
      loading.value = true
      try {
        const qs = new URLSearchParams({ formId: formId.value, page: page.value, pageSize: 20 })
        if (keyword.value) qs.set('keyword', keyword.value)
        if (marked.value) qs.set('marked', '1')
        const r = await api.get('/api/submissions?' + qs)
        rows.value = r.data
        total.value = r.total
        totalPages.value = r.totalPages
      } catch (e) { err(e.message) } finally { loading.value = false }
    }

    onMounted(async () => { await loadForms(); await load() })

    const switchForm = async () => {
      page.value = 1
      await loadForm()
      await load()
    }

    const labelOf = (id) => {
      const f = form.value?.schema.find(x => x.id === id)
      return f?.label || id
    }

    const cell = (row, f) => {
      const v = row.data[f.id]
      if (v == null || v === '') return '-'
      if (Array.isArray(v)) return v.map(x => (typeof x === 'object' ? (x.name || x.url || JSON.stringify(x)) : x)).join(', ')
      if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}：${typeof x === 'object' ? JSON.stringify(x) : x}`).join(' / ')
      return String(v).slice(0, 40)
    }

    const remove = async (row) => {
      if (!await confirmBox(`删除答卷 #${row.id}？可在回收中心恢复的记录不会保留（仅表单可恢复）。`)) return
      try { await api.del(`/api/submissions/${row.id}`); ok('已删除'); load() } catch (e) { err(e.message) }
    }

    const batchDelete = async () => {
      if (!selected.value.length) return err('请先勾选答卷')
      if (!await confirmBox(`删除选中的 ${selected.value.length} 份答卷？`)) return
      try {
        await api.post('/api/submissions/batch-delete', { ids: selected.value })
        ok('已删除')
        selected.value = []
        load()
      } catch (e) { err(e.message) }
    }

    const toggleMark = async (row) => {
      try {
        await api.put(`/api/submissions/${row.id}`, { data: row.data, marked: !row.marked })
        load()
      } catch (e) { err(e.message) }
    }

    const exportCsv = () => {
      if (!form.value) return
      const schema = form.value.schema.filter(f => !['divider', 'richtext', 'html', 'image'].includes(f.type))
      const head = ['编号', '提交时间', ...schema.map(f => f.label), '得分', 'IP']
      const lines = [head.map(csvCell).join(',')]
      for (const r of rows.value) {
        lines.push([r.id, fmtDate(r.created_at), ...schema.map(f => cell({ data: r.data }, f)), r.score ?? '', r.ip].map(csvCell).join(','))
      }
      const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${form.value.title}-答卷.csv`
      a.click()
      ok('已导出 CSV')
    }

    const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\n/g, ' ')}"`

    const exportJson = () => {
      const blob = new Blob([JSON.stringify(rows.value.map(r => ({ id: r.id, createdAt: r.created_at, score: r.score, data: r.data })), null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${form.value.title}-答卷.json`
      a.click()
      ok('已导出 JSON')
    }

    const importFile = async (file) => {
      if (!file) return
      try {
        const text = await file.text()
        const items = JSON.parse(text)
        const r = await api.post(`/api/forms/${formId.value}/import`, { items: Array.isArray(items) ? items : [] })
        ok(`导入成功 ${r.imported} 条${r.skipped ? `，跳过 ${r.skipped} 条` : ''}`)
        load()
      } catch (e) { err('导入失败：' + e.message) }
    }

    const printRows = () => {
      const w = window.open('', '_blank')
      const schema = form.value.schema.filter(f => !['divider', 'richtext', 'html', 'image'].includes(f.type))
      w.document.write(`<html><head><title>${form.value.title}</title><style>
        body{font-family:-apple-system,"PingFang SC",sans-serif;padding:24px;color:#141a2e}
        h1{font-size:19px;margin-bottom:4px} p{color:#666;font-size:12px}
        table{width:100%;border-collapse:collapse;font-size:12px;margin-top:14px}
        th,td{border:1px solid #ddd;padding:7px 9px;text-align:left}
        th{background:#f5f7fb}
      </style></head><body>
      <h1>${form.value.title}</h1><p>导出时间：${new Date().toLocaleString()} · 共 ${rows.value.length} 份</p>
      <table><thead><tr><th>编号</th><th>提交时间</th>${schema.map(f => `<th>${f.label}</th>`).join('')}<th>得分</th></tr></thead>
      <tbody>${rows.value.map(r => `<tr><td>${r.id}</td><td>${fmtDate(r.created_at)}</td>${schema.map(f => `<td>${cell({ data: r.data }, f)}</td>`).join('')}<td>${r.score ?? ''}</td></tr>`).join('')}</tbody></table>
      </body></html>`)
      w.document.close()
      w.print()
    }

    const openDetail = (row) => { detail.value = row }
    const openEdit = (row) => { editing.value = { id: row.id, data: JSON.parse(JSON.stringify(row.data || {})), marked: row.marked } }

    const saveEdit = async () => {
      try {
        await api.put(`/api/submissions/${editing.value.id}`, { data: editing.value.data, marked: editing.value.marked })
        ok('已保存')
        editing.value = null
        load()
      } catch (e) { err(e.message) }
    }

    const cols = computed(() => (form.value?.schema || []).filter(f => !['divider', 'richtext', 'html', 'image'].includes(f.type)).slice(0, 4))

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [h('h1', {}, '答卷数据'), h('div', { class: 'sub' }, '新增、编辑、筛选、导入导出、打印与附件打包')]),
        h('div', { class: 'flex wrap' }, [
          h('button', { class: 'btn sm', onClick: printRows }, [Icon('printer', { style: 'width:14px;height:14px' }), '打印']),
          h('button', { class: 'btn sm', onClick: exportCsv }, [Icon('download', { style: 'width:14px;height:14px' }), 'CSV']),
          h('button', { class: 'btn sm', onClick: exportJson }, 'JSON'),
          h('label', { class: 'btn sm' }, ['导入', h('input', {
            type: 'file', accept: '.json', class: 'hide',
            onChange: e => { importFile(e.target.files?.[0]); e.target.value = '' }
          })]),
          h('button', {
            class: 'btn sm',
            onClick: () => api.download(`/api/forms/${formId.value}/attachments.zip`, `${form.value?.title || 'form'}-附件.zip`).catch(e => err(e.message))
          }, '打包附件')
        ])
      ]),
      h('div', { class: 'card pad mb', style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center' }, [
        h('select', {
          class: 'select', style: 'max-width:280px', value: formId.value,
          onChange: e => { formId.value = Number(e.target.value); switchForm() }
        }, forms.value.map(f => h('option', { value: f.id }, f.title))),
        h('input', {
          class: 'input', style: 'max-width:200px', placeholder: '搜索答卷内容…', value: keyword.value,
          onInput: e => keyword.value = e.target.value,
          onKeydown: e => { if (e.key === 'Enter') { page.value = 1; load() } }
        }),
        h('button', { class: 'btn sm', onClick: () => { page.value = 1; load() } }, [Icon('search', { style: 'width:14px;height:14px' }), '搜索']),
        h('label', { class: 'flex small' }, [h('input', {
          type: 'checkbox', checked: marked.value, style: 'accent-color:var(--brand)',
          onChange: e => { marked.value = e.target.checked; page.value = 1; load() }
        }), '仅看标记']),
        h('div', { style: 'flex:1' }),
        h('span', { class: 'small muted' }, `共 ${total.value} 份`),
        h('button', { class: 'btn sm danger', onClick: batchDelete }, '批量删除'),
        h('button', { class: 'btn sm primary', onClick: () => openEdit({ id: 0, data: {}, marked: 0 }) }, '+ 新增答卷')
      ]),
      h('div', { class: 'card', style: 'overflow:hidden' }, [
        loading.value ? h('div', { style: 'padding:30px' }, '加载中…')
          : rows.value.length ? h('div', { style: 'overflow-x:auto' }, h('table', { class: 'table' }, [
              h('thead', {}, h('tr', {}, [
                h('th', {}, h('input', {
                  type: 'checkbox', style: 'accent-color:var(--brand)',
                  onChange: e => selected.value = e.target.checked ? rows.value.map(r => r.id) : []
                })),
                h('th', {}, '编号'), h('th', {}, '提交时间'),
                ...cols.value.map(f => h('th', {}, f.label)),
                h('th', {}, '得分'), h('th', {}, '操作')
              ])),
              h('tbody', {}, rows.value.map(r => h('tr', {}, [
                h('td', {}, h('input', {
                  type: 'checkbox', style: 'accent-color:var(--brand)',
                  checked: selected.value.includes(r.id),
                  onChange: e => {
                    const s = new Set(selected.value)
                    e.target.checked ? s.add(r.id) : s.delete(r.id)
                    selected.value = [...s]
                  }
                })),
                h('td', {}, [
                  h('span', { class: 'mono' }, '#' + r.id),
                  r.marked ? h('span', { class: 'tag warn', style: 'margin-left:6px' }, '标记') : null
                ]),
                h('td', { class: 'nowrap' }, fmtDate(r.created_at)),
                ...cols.value.map(f => h('td', {}, cell(r, f))),
                h('td', {}, r.score != null ? h('span', { class: ['tag', r.passed ? 'ok' : 'warn'] }, String(r.score)) : '-'),
                h('td', { class: 'nowrap' }, h('div', { class: 'flex', style: 'gap:4px' }, [
                  h('button', { class: 'btn ghost sm', onClick: () => openDetail(r) }, '查看'),
                  h('button', { class: 'btn ghost sm', onClick: () => openEdit(r) }, '编辑'),
                  h('button', { class: 'btn ghost sm', onClick: () => toggleMark(r) }, r.marked ? '取消标记' : '标记'),
                  h('button', { class: 'btn ghost sm danger', onClick: () => remove(r) }, '删除')
                ]))
              ])))
            ]))
          : h(Empty, { text: '该表单还没有答卷' })
      ]),
      h(Pagination, { page: page.value, totalPages: totalPages.value, onChange: p => { page.value = p; load() } }),

      detail.value ? Modal({
        title: `答卷 #${detail.value.id}`, modelValue: true,
        onClose: () => detail.value = null, wide: true,
        children: h('div', {}, form.value.schema.filter(f => detail.value.data[f.id] !== undefined).map(f => h('div', { class: 'mb' }, [
          h('div', { class: 'small muted' }, f.label),
          h('div', { style: 'font-weight:520;word-break:break-word' },
            Array.isArray(detail.value.data[f.id]) ? detail.value.data[f.id].join('、')
              : typeof detail.value.data[f.id] === 'object'
                ? Object.entries(detail.value.data[f.id]).map(([k, v]) => `${k}：${v}`).join('；')
                : String(detail.value.data[f.id] || '-'))
        ])))
      }) : null,

      editing.value ? Modal({
        title: editing.value.id ? `编辑答卷 #${editing.value.id}` : '新增答卷',
        modelValue: true, onClose: () => editing.value = null, wide: true,
        children: h('div', {}, form.value.schema
          .filter(f => !['divider', 'richtext', 'html', 'image'].includes(f.type))
          .map(f => h('div', { class: 'field' }, [
            h('label', {}, f.label),
            h('div', { style: 'pointer-events:auto' }, renderControl(f, editing.value.data))
          ]))),
        footer: [
          h('button', { class: 'btn', onClick: () => editing.value = null }, '取消'),
          h('button', {
            class: 'btn primary', onClick: async () => {
              try {
                if (editing.value.id) await api.put(`/api/submissions/${editing.value.id}`, { data: editing.value.data })
                else await api.post('/api/submissions', { formId: formId.value, data: editing.value.data })
                ok('已保存')
                editing.value = null
                load()
              } catch (e) { err(e.message) }
            }
          }, '保存')
        ]
      }) : null
    ])
  }
}
