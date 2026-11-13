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
    const pending = ref(false)
    const loading = ref(true)
    const detail = ref(null)
    const editing = ref(null)
    const form = ref(null)
    const selected = ref([])
    const importing = ref(false)
    const review = ref(null)

    /** 与服务端 fieldVisible 同口径：隐藏的题不该出现在批阅清单里 */
    const flat = v => (Array.isArray(v) ? v.join(',') : v)
    const visible = (q, data) => {
      const rules = q.logic || []
      if (!rules.length) return true
      return rules.every(rule => {
        const v = flat(data[rule.fieldId])
        switch (rule.op) {
          case 'eq': return String(v) === String(rule.value)
          case 'ne': return String(v) !== String(rule.value)
          case 'in': return Array.isArray(rule.value) ? rule.value.map(String).includes(String(v)) : String(v) === String(rule.value)
          case 'contains': return Array.isArray(data[rule.fieldId]) ? data[rule.fieldId].map(String).includes(String(rule.value)) : String(v ?? '').includes(String(rule.value))
          case 'gt': return Number(v) > Number(rule.value)
          case 'lt': return Number(v) < Number(rule.value)
          case 'empty': return v === '' || v === undefined || v === null
          case 'notEmpty': return !(v === '' || v === undefined || v === null)
          default: return true
        }
      })
    }

    const loadForms = async () => {
      const r = await api.get('/api/forms?pageSize=200')
      forms.value = r.data
      if (!formId.value && forms.value.length) {
        // 优先落到真的有答卷的表单，避免一进来就是空表
        const withData = forms.value.find(f => (f.submission_count || 0) > 0)
        formId.value = (withData || forms.value[0]).id
      }
      if (formId.value) await loadForm()
    }
    const allMode = computed(() => !formId.value)

    const loadForm = async () => {
      if (!formId.value) { form.value = null; return }
      const r = await api.get(`/api/forms/${formId.value}`)
      form.value = r.data
    }

    const load = async () => {
      loading.value = true
      try {
        const qs = new URLSearchParams({ page: page.value, pageSize: 20 })
        if (formId.value) qs.set('formId', formId.value)
        if (keyword.value) qs.set('keyword', keyword.value)
        if (marked.value) qs.set('marked', '1')
        if (pending.value) qs.set('pending', '1')
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
      const f = form.value?.schema?.find(x => x.id === id)
      return f?.label || id
    }

    /** 子表单一行数据 → 「事项：季度复盘 / 负责人：张三」；对象 key 是随机字段 id，直接摆出来没人看得懂 */
    const subRowText = (row, f) => {
      const labels = Object.fromEntries((f.props?.fields || []).map(sf => [sf.id, sf.label]))
      return Object.entries(row || {})
        .filter(([, x]) => x !== undefined && x !== null && String(x).trim() !== '')
        .map(([k, x]) => `${labels[k] || '字段'}：${x}`).join(' / ')
    }

    const cell = (row, f) => {
      const v = row.data[f.id]
      if (v == null || v === '') return '-'
      if (Array.isArray(v)) {
        if (v.some(x => x && typeof x === 'object')) {
          const lines = v.map(x => subRowText(x, f)).filter(Boolean)
          return lines.length ? lines.slice(0, 3).join('；') + (lines.length > 3 ? ` 等 ${lines.length} 条` : '') : '-'
        }
        return v.join(', ')
      }
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

    const needForm = () => {
      if (form.value) return true
      err('请先在左上角选择一个具体表单')
      return false
    }

    const exportCsv = () => {
      if (!needForm()) return
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
      if (!needForm()) return
      const blob = new Blob([JSON.stringify(rows.value.map(r => ({ id: r.id, createdAt: r.created_at, score: r.score, data: r.data })), null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${form.value.title}-答卷.json`
      a.click()
      ok('已导出 JSON')
    }

    const importFile = async (file) => {
      if (!file || !needForm()) return
      try {
        const text = await file.text()
        const items = JSON.parse(text)
        const r = await api.post(`/api/forms/${formId.value}/import`, { items: Array.isArray(items) ? items : [] })
        ok(`导入成功 ${r.imported} 条${r.skipped ? `，跳过 ${r.skipped} 条` : ''}`)
        load()
      } catch (e) { err('导入失败：' + e.message) }
    }

    const printRows = () => {
      if (!needForm()) return
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

    /**
     * 打开批阅：拉最新答卷，把主观题与人工分摊成表单。
     * 判据必须和后台 pendingLeft 一致：有分值、无标准答案、当前可见、不是说明类组件。
     * 之前这里只看「有分值无答案」，隐藏起来的主观题也列出来，老师给完分提交，
     * 后台过滤掉隐藏题后队列里还剩它——批了也不消失。
     */
    const NO_GRADE = ['divider', 'richtext', 'html', 'image', 'captcha']
    const isSubjective = (q, data) => Number(q.score) > 0 && !(q.answer || []).length &&
      !NO_GRADE.includes(q.type) && visible(q, data)

    const openReview = async (row) => {
      try {
        // 全部表单视图下 form.value 可能是别的表单，批阅必须用这条答卷自己的卷子
        const r = await api.get(`/api/submissions/${row.id}`)
        const sub = r.data
        const f = sub.form
        if (!f || f.kind !== 'exam') return err('只有考试答卷需要批阅')
        const data = sub.data || {}
        const subjective = (f.schema || []).filter(q => isSubjective(q, data))
        if (!subjective.length) return err('这份卷子没有待批阅的主观题')
        review.value = {
          id: row.id,
          title: f.title,
          note: sub.review_note || '',
          reviewedAt: sub.reviewed_at || '',
          scores: { ...(sub.manual_scores || {}) },
          items: subjective.map(q => ({
            id: q.id, label: q.label, score: Number(q.score) || 0,
            given: data[q.id], analysis: q.analysis || ''
          }))
        }
      } catch (e) { err(e.message) }
    }

    /** 默认把「还没给过分」的题按 0 分填上：卷面分先落地，避免整张卷子永远停在待批阅 */
    const fillZero = () => {
      for (const it of review.value.items) {
        if (review.value.scores[it.id] === undefined || review.value.scores[it.id] === '') review.value.scores[it.id] = 0
      }
    }

    const saveReview = async () => {
      try {
        const r = await api.put(`/api/submissions/${review.value.id}/review`, {
          scores: review.value.scores, note: review.value.note
        })
        const total = r.data.review ? `${r.data.review.total} 分` : ''
        ok(`批阅完成${total ? `，重新计算成绩 ${total}` : ''}`)
        review.value = null
        load()
      } catch (e) { err(e.message) }
    }
    const openEdit = async (row) => {
      // 编辑弹窗用的是这条答卷自己的卷子。之前直接改 form.value，
      // 结果「全部表单」视图下点一行，左上角选中的表单也跟着变了，关掉弹窗列表就换了一批数据
      let schema = form.value?.schema || []
      const targetForm = row.form_id || formId.value
      if (!targetForm) return err('请先在左上角选择一个具体表单')
      if (targetForm !== formId.value) {
        try {
          const r = await api.get(`/api/forms/${targetForm}`)
          schema = r.data?.schema || []
        } catch (e) { return err(e.message) }
      }
      editing.value = { id: row.id || 0, data: JSON.parse(JSON.stringify(row.data || {})), marked: row.marked || 0, formId: targetForm, schema }
    }

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
            onClick: () => {
              if (!needForm()) return
              api.download(`/api/forms/${formId.value}/attachments.zip`, `${form.value?.title || 'form'}-附件.zip`)
                .then(r => {
                  if (!r.files && !r.missing) return ok('该表单还没有答卷附件')
                  ok(`已打包 ${r.files} 个文件` + (r.missing ? `，另有 ${r.missing} 个文件已从磁盘丢失，已跳过` : ''))
                })
                .catch(e => err(e.message))
            }
          }, '打包附件')
        ])
      ]),
      h('div', { class: 'card pad mb', style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center' }, [
        h('select', {
          class: 'select', style: 'max-width:280px', value: formId.value,
          onChange: e => { formId.value = Number(e.target.value); switchForm() }
        }, [
          h('option', { value: 0 }, '全部表单'),
          ...forms.value.map(f => h('option', { value: f.id }, `${f.title}（${f.submission_count || 0}）`))
        ]),
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
        h('label', { class: 'flex small' }, [h('input', {
          type: 'checkbox', checked: pending.value, style: 'accent-color:var(--brand)',
          onChange: e => { pending.value = e.target.checked; page.value = 1; load() }
        }), '待批阅']),
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
                h('th', { class: 'stick-id' }, '编号'), h('th', { class: 'stick-time' }, '提交时间'),
                allMode.value ? h('th', {}, '来源表单') : null,
                ...cols.value.map(f => h('th', {}, f.label)),
                h('th', { class: 'stick-score' }, '得分'),
                h('th', { class: 'stick-ops' }, '操作')
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
                h('td', { class: 'stick-id' }, [
                  // 编号是给人抄的，折成两行既难读又把整张表撑高
                  h('div', { style: 'white-space:nowrap;line-height:1.35' }, [
                    h('span', { class: 'mono' }, '#' + r.id),
                    r.public_id ? h('div', { class: 'mono', style: 'font-size:11px;color:var(--text-3)' }, r.public_id) : null
                  ]),
                  r.marked ? h('span', { class: 'tag warn', style: 'margin-left:6px' }, '标记') : null
                ]),
                h('td', { class: 'nowrap stick-time' }, fmtDate(r.created_at)),
                allMode.value ? h('td', {}, r.form_title || '-') : null,
                ...cols.value.map(f => h('td', {}, cell(r, f))),
                h('td', { class: 'nowrap stick-score' }, r.score != null
                  ? h('span', {}, [
                      h('span', { class: ['tag', r.passed ? 'ok' : 'warn'] }, String(r.score)),
                      r.reviewed_at ? h('span', { class: 'tag', style: 'margin-left:4px' }, '已批阅') : null
                    ])
                  : '-'),
                h('td', { class: 'nowrap stick-ops' }, h('div', { class: 'flex', style: 'gap:4px' }, [
                  h('button', { class: 'btn ghost sm', onClick: () => openDetail(r) }, '查看'),
                  h('button', { class: 'btn ghost sm', onClick: () => openReview(r) }, '批阅'),
                  h('button', { class: 'btn ghost sm', onClick: () => openEdit(r) }, '编辑'),
                  h('button', { class: 'btn ghost sm', onClick: () => toggleMark(r) }, r.marked ? '取消标记' : '标记'),
                  h('button', { class: 'btn ghost sm danger', onClick: () => remove(r) }, '删除')
                ]))
              ])))
            ]))
          : h(Empty, { text: allMode.value ? '还没有任何答卷' : '该表单还没有答卷' })
      ]),
      h(Pagination, { page: page.value, totalPages: totalPages.value, onChange: p => { page.value = p; load() } }),

      detail.value ? Modal({
        title: `答卷 #${detail.value.id}`, modelValue: true,
        onClose: () => detail.value = null, wide: true,
        children: h('div', {}, (form.value?.schema || []).filter(f => detail.value.data[f.id] !== undefined).map(f => h('div', { class: 'mb' }, [
          h('div', { class: 'small muted' }, f.label),
          h('div', { style: 'font-weight:520;word-break:break-word;white-space:pre-wrap' },
            // 子表单是对象数组，join 出来是一串 [object Object]，得逐行拼出来
            Array.isArray(detail.value.data[f.id]) && detail.value.data[f.id].some(x => x && typeof x === 'object')
              ? detail.value.data[f.id].map((row, i) => {
                  const labels = Object.fromEntries((f.props?.fields || []).map(sf => [sf.id, sf.label]))
                  const text = Object.entries(row || {}).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
                    .map(([k, v]) => `${labels[k] || k}：${v}`).join(' / ')
                  return text ? `${i + 1}. ${text}` : ''
                }).filter(Boolean).join('\n')
              : Array.isArray(detail.value.data[f.id]) ? detail.value.data[f.id].join('、')
              : typeof detail.value.data[f.id] === 'object'
                ? Object.entries(detail.value.data[f.id]).map(([k, v]) => `${k}：${v}`).join('；')
                : String(detail.value.data[f.id] || '-'))
        ])))
      }) : null,

      review.value ? Modal({
        title: `批阅答卷 #${review.value.id} · ${review.value.title}`, modelValue: true,
        onClose: () => review.value = null, wide: true,
        children: h('div', {}, [
          h('div', { class: 'small muted mb' }, review.value.reviewedAt
            ? `上次批阅：${fmtDate(review.value.reviewedAt)}，可再次调整`
            : '主观题没有标准答案，需要人工给分；给完分系统会重算总分与及格判定'),
          review.value.items.length > 1 ? h('div', { class: 'flex between mb' }, [
            h('span', { class: 'small muted' }, `共 ${review.value.items.length} 道主观题，未填的按 0 分算`),
            h('button', { class: 'btn sm', onClick: fillZero }, '未填的按 0 分')
          ]) : null,
          ...review.value.items.map(it => h('div', { class: 'mb', style: 'padding:12px 14px;border:1px solid var(--line);border-radius:10px' }, [
            h('div', { class: 'flex between', style: 'gap:10px;align-items:flex-start' }, [
              h('b', { style: 'font-size:14px;line-height:1.5' }, it.label),
              h('span', { class: 'tag', style: 'white-space:nowrap;flex:none' }, `满分 ${it.score}`)
            ]),
            h('div', { class: 'small muted', style: 'margin:8px 0 4px' }, '作答'),
            h('div', { style: 'white-space:pre-wrap;word-break:break-word;margin-bottom:8px' },
              it.given == null || it.given === '' ? h('span', { class: 'muted' }, '（未作答）') : String(it.given)),
            h('div', { class: 'flex', style: 'gap:8px;align-items:center' }, [
              h('span', { class: 'small muted' }, '给分'),
              h('input', {
                class: 'input', type: 'number', min: 0, max: it.score, step: '0.5',
                style: 'max-width:110px', value: review.value.scores[it.id] ?? '',
                placeholder: '0',
                onInput: e => {
                  const v = e.target.value
                  if (v === '') delete review.value.scores[it.id]
                  else review.value.scores[it.id] = Number(v)
                }
              }),
              h('button', {
                class: 'btn sm', onClick: () => review.value.scores[it.id] = it.score
              }, '满分'),
              h('button', {
                class: 'btn sm', onClick: () => review.value.scores[it.id] = 0
              }, '0 分')
            ])
          ])),
          h('div', { class: 'field' }, [
            h('label', {}, '批阅备注（可选）'),
            h('textarea', {
              class: 'textarea', style: 'min-height:60px', placeholder: '例如：观点完整，但缺少示例',
              value: review.value.note, onInput: e => review.value.note = e.target.value
            })
          ])
        ]),
        footer: [
          h('button', { class: 'btn', onClick: () => review.value = null }, '取消'),
          h('button', { class: 'btn primary', onClick: saveReview }, '保存并重算成绩')
        ]
      }) : null,

      editing.value ? Modal({
        title: editing.value.id ? `编辑答卷 #${editing.value.id}` : '新增答卷',
        modelValue: true, onClose: () => editing.value = null, wide: true,
        children: h('div', {}, (editing.value.schema || [])
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
                if (editing.value.id) await api.put(`/api/submissions/${editing.value.id}`, { data: editing.value.data, marked: editing.value.marked })
                else await api.post('/api/submissions', { formId: editing.value.formId || formId.value, data: editing.value.data })
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
