import { h, ref, onMounted, onBeforeUnmount, computed, nextTick, watch } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { route } from '../router.js'
import { ok, err, confirmBox, fmtDate, Empty, Modal, Pagination, escapeHtml } from '../ui.js'
import { Icon } from '../icons.js'
import { renderControl, answerDisplay } from '../renderer.js'
import { buildFlow } from '../flow.js'
import { batchPayload, nextIndex } from '../review.js'

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
    // 只读协作者打开明细会被服务端 403。以前这里只弹一句 toast，页面照样显示
    // 「该表单还没有答卷」——那句话的意思是「没人填过」，跟真实原因完全不是一回事。
    // 所以把拒绝理由留在页面上，而不是让它随 toast 一起消失。
    const denied = ref('')

    // 与服务端同一份实现（flow.js）：这里曾经自己抄了一遍 fieldVisible 的分支，
    // 于是「条件跳转跳过的题」在这一页仍然算「答过」，批阅清单和报表对不上
    const visible = (q, data) => buildFlow([q], data).visible.get(q.id) !== false

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
      denied.value = ''
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
      } catch (e) {
        // 403 与「没有数据」必须区分开：一个是没权限，一个是真没有
        if (/只读|无权/.test(e.message || '')) denied.value = e.message
        else err(e.message)
      } finally { loading.value = false }
    }

    /**
     * 吸右侧的两列要按实测宽度对齐：操作列多一个按钮就宽一截，
     * CSS 里写死 298px 时它会盖住「得分」列，只剩半截数字。
     */
    const syncOpsWidth = () => {
      const ops = document.querySelector('.table th.stick-ops')
      if (!ops) return
      const w = Math.ceil(ops.getBoundingClientRect().width)
      if (w > 0) document.documentElement.style.setProperty('--ops-w', w + 'px')
    }
    watch([rows, allMode], async () => { await nextTick(); syncOpsWidth() })

    onMounted(async () => {
      await loadForms()
      await load()
      window.addEventListener('resize', syncOpsWidth)
      await nextTick()
      syncOpsWidth()
    })
    onBeforeUnmount(() => window.removeEventListener('resize', syncOpsWidth))

    const switchForm = async () => {
      page.value = 1
      await loadForm()
      await load()
    }

    const labelOf = (id) => {
      const f = form.value?.schema?.find(x => x.id === id)
      return f?.label || id
    }

    const cell = (row, f) => {
      const text = answerDisplay(f, row.data[f.id])
      if (!text) return '-'
      // 表格一行放不下长答案：截断但保留「有多条」这件事，别让人以为只填了一行
      const lines = text.split('\n')
      const head = lines.slice(0, 3).join('；')
      return (lines.length > 3 ? `${head} 等 ${lines.length} 条` : head).slice(0, 60)
    }

    const remove = async (row) => {
      if (!await confirmBox(`删除答卷 #${row.id}？删除后可在「回收中心 · 答卷」里恢复。`)) return
      try { await api.del(`/api/submissions/${row.id}`); ok('已删除'); load() } catch (e) { err(e.message) }
    }

    const batchDelete = async () => {
      if (!selected.value.length) return err('请先勾选答卷')
      if (!await confirmBox(`删除选中的 ${selected.value.length} 份答卷？删除后可在「回收中心 · 答卷」里恢复。`)) return
      try {
        const r = await api.post('/api/submissions/batch-delete', { ids: selected.value })
        // 之前不管删没删掉都报「已删除 N 份」，其中不存在的 id、无权的答卷其实原样躺在库里
        ok(r.skipped ? `已删除 ${r.count} 份，${r.skipped} 份无权限或已不存在` : `已删除 ${r.count} 份`)
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

    /**
     * 服务端导出：当前筛选条件下的全部答卷，不受分页影响。
     *
     * 导出走流式，几万份答卷也要几十秒——按钮必须当场变成「导出中」，
     * 否则用户看到的是一次点击毫无反应，然后连点五次，服务器同时开五个导出。
     */
    const exporting = ref(false)
    const exportXlsx = async () => {
      if (!needForm() || exporting.value) return
      exporting.value = true
      try {
        const qs = new URLSearchParams()
        if (keyword.value) qs.set('keyword', keyword.value)
        if (marked.value) qs.set('marked', '1')
        await api.download(`/api/forms/${formId.value}/submissions.xlsx?${qs}`, `${form.value.title}-答卷.xlsx`)
        ok('已导出 Excel（当前筛选条件下的全部答卷）')
      } catch (e) { err(e.message) } finally { exporting.value = false }
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

    /**
     * 打印预览是一段手拼的 HTML —— 里面每一个字都来自答卷内容。
     * 以前直接 `${r.data[f.id]}` 塞进 document.write，等于把匿名填写者写的东西当成页面代码执行：
     * 往填空题里填 `<img src=x onerror=alert(1)>`，「打印」那一刻就在本域执行了。
     * 现在整段（表单标题、题目标题、单元格内容）统一过 escapeHtml。
     */
    const printRows = () => {
      if (!needForm()) return
      const w = window.open('', '_blank')
      const schema = form.value.schema.filter(f => !['divider', 'richtext', 'html', 'image'].includes(f.type))
      const title = escapeHtml(form.value.title)
      w.document.write(`<html><head><meta charset="utf-8"><title>${title}</title><style>
        body{font-family:-apple-system,"PingFang SC",sans-serif;padding:24px;color:#141a2e}
        h1{font-size:19px;margin-bottom:4px} p{color:#666;font-size:12px}
        table{width:100%;border-collapse:collapse;font-size:12px;margin-top:14px}
        th,td{border:1px solid #ddd;padding:7px 9px;text-align:left}
        th{background:#f5f7fb}
      </style></head><body>
      <h1>${title}</h1><p>导出时间：${new Date().toLocaleString()} · 共 ${rows.value.length} 份</p>
      <table><thead><tr><th>编号</th><th>提交时间</th>${schema.map(f => `<th>${escapeHtml(f.label)}</th>`).join('')}<th>得分</th></tr></thead>
      <tbody>${rows.value.map(r => `<tr><td>${escapeHtml(r.id)}</td><td>${escapeHtml(fmtDate(r.created_at))}</td>${schema.map(f => `<td>${escapeHtml(cell({ data: r.data }, f))}</td>`).join('')}<td>${escapeHtml(r.score ?? '')}</td></tr>`).join('')}</tbody></table>
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
    /* ---------------- 批量阅卷 ----------------
     *
     * 以前批一份卷子要五步：点开 → 给分 → 保存 → 等列表刷新 → 点开下一份。
     * 一个班 40 人就 200 次点击，中间还夹着 40 次整页重新加载。
     * 这里把「一页待批答卷」一次取回来，逐份给分，最后一起保存：
     * 队列顺序按交卷时间，批过的自动从这里消失（服务端 pendingLeft 归零）。
     */
    const batch = ref(null)
    const batchBusy = ref(false)
    const BATCH_LIMIT = 10

    /**
     * 键盘直填：批量阅卷把「打开/关闭」的成本压掉了，剩下的瓶颈全在打字。
     * 所以这一页的打分框按 DOM 顺序排成一条队列：数字键直接输入（聚焦时全选，敲了就替换），
     * ↑↓ 上下题，Enter 下一题，最后一题再 Enter 就是存本页。
     * 不做「输入即跳」——两位数的分刚敲下第一位就跳走，反而要回头改。
     */
    const batchRoot = ref(null)
    const scoreInputs = () => [...(batchRoot.value?.querySelectorAll('[data-batch-score]') || [])]
    const focusScore = (i) => {
      const el = scoreInputs()[i]
      if (!el) return false
      el.focus()
      el.select?.()
      return true
    }

    // 单份批阅走同一套键位：十几道题也要能一路敲下来。两个弹窗各自一个根节点，
    // 打分框在各自弹窗内按 DOM 顺序排成队列，互不串
    const reviewRoot = ref(null)
    const reviewInputs = () => [...(reviewRoot.value?.querySelectorAll('[data-review-score]') || [])]

    /**
     * 打分框上的键盘：Enter 下一题（最后一题再按一次就是保存），↑↓ 上下题。
     * 只认打分框自己的按键，不管别的输入框——批阅备注里按 Enter 不该跳走。
     */
    const scoreKeys = (els, onSubmit) => (e) => {
      const list = els()
      const idx = list.indexOf(e.target)
      if (idx < 0) return
      if (e.key === 'Enter') {
        e.preventDefault()
        const next = nextIndex(idx, list.length)
        if (next < 0) return onSubmit()
        list[next].focus()
        list[next].select?.()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const next = e.key === 'ArrowDown' ? Math.min(idx + 1, list.length - 1) : Math.max(idx - 1, 0)
        list[next]?.focus()
        list[next]?.select?.()
      }
    }

    const openBatch = async () => {
      if (!form.value) return err('请先在左上角选择一个具体表单')
      if (form.value.kind !== 'exam') return err('只有考试需要批阅')
      try {
        await loadBatch(0)
      } catch (e) { err(e.message) }
    }

    const loadBatch = async (offset, { silent = false } = {}) => {
      const r = await api.get(`/api/forms/${formId.value}/review-queue?limit=${BATCH_LIMIT}&offset=${offset || 0}`)
      const items = (r.data || []).map(x => ({
        ...x,
        // 输入框里存字符串更方便：空串表示「还没给分」，0 是有效的 0 分
        draft: Object.fromEntries(x.items.map(it => [it.id, it.current == null ? '' : String(it.current)])),
        // 「撤掉已给的分，退回待批」要单记一笔：空串表示「本来就没批」，
        // 两者混成一个状态的话，撤分这份永远赖在队列里
        revoke: new Set(),
        noteDraft: x.note || ''
      }))
      batch.value = { formId: formId.value, title: form.value.title, total: r.total, scanned: r.scanned, offset: offset || 0, limit: BATCH_LIMIT, items }
      // 保存之后队列清空是正常结果，不该再弹一句「没有待批阅」——那句提示是说给「点进来才发现空」的人
      if (!items.length && !r.total && !silent) return ok('这张卷子没有待批阅的答卷了')
    }

    /**
     * 只提交填过分的那几题：没填的题保持「待批」，不会因为看了一眼就被判 0 分。
     * 越界的分数在这里就拦下来并跳到那一题——交给服务端拒，回来的是一句
     * 「已保存 7 份，1 份被拒」，还得自己回头找是哪一份哪一题。
     */
    const saveBatch = async () => {
      if (!batch.value || batchBusy.value) return
      const { items: payload, error } = batchPayload(batch.value.items)
      if (error) {
        const label = String(error.label || '')
        err(`「${label.length > 14 ? label.slice(0, 14) + '…' : label}」的分数${error.message}`)
        const idx = batch.value.items.slice(0, error.row).reduce((n, x) => n + x.items.length, 0) + error.item
        return focusScore(idx)
      }
      if (!payload.length) return err('还没有给任何一份卷子打分')
      batchBusy.value = true
      try {
        const r = await api.put('/api/submissions/review-batch', { items: payload })
        if (r.rejected?.length) {
          err(`已保存 ${r.saved} 份，${r.rejected.length} 份被拒：${r.rejected[0].reason}`)
        } else {
          ok(`已保存 ${r.saved} 份，成绩已重算`)
        }
        // 批完就从队列里消失，所以重新拉这一页（不是往下翻，前面被清掉的位置要补上来）
        await loadBatch(batch.value.offset, { silent: true })
        await load()
      } catch (e) { err(e.message) } finally { batchBusy.value = false }
    }

    const batchPage = async (dir) => {
      const offset = Math.max((batch.value?.offset || 0) + dir * (batch.value?.limit || BATCH_LIMIT), 0)
      try { await loadBatch(offset) } catch (e) { err(e.message) }
    }

    const fillBatch = (x, value) => {
      for (const it of x.items) x.draft[it.id] = String(value === 'full' ? it.score : 0)
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
      // 被拒绝时整页只留说明：工具条上一排「导出 / 导入 / 批量删除」点了全是 403，
      // 摆在那里等于把人往错误上引
      denied.value ? h('div', {}, [
        h('div', { class: 'page-head' }, h('div', {}, [
          h('h1', {}, '答卷数据'),
          h('div', { class: 'sub' }, '只读协作者看不到逐份答卷，请查看统计分析')
        ])),
        h('div', { class: 'card pad' }, h('div', { class: 'center', style: 'padding:56px 20px' }, [
          h('div', { style: 'font-size:38px;opacity:.3;margin-bottom:10px' }, '🔒'),
          h('h3', { style: 'margin-bottom:6px' }, '这份表单的答卷明细对你不可见'),
          h('div', { class: 'small muted', style: 'margin-bottom:16px;max-width:430px' }, denied.value + '。需要看逐份作答的话，请表单所有者把你改成「可编辑」。'),
          h('a', { class: 'btn primary', href: '/report?formId=' + formId.value, 'data-link': true }, '去看统计分析')
        ]))
      ]) : h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [h('h1', {}, '答卷数据'), h('div', { class: 'sub' }, '新增、编辑、筛选、导入导出、打印与附件打包')]),
        h('div', { class: 'flex wrap' }, [
          h('button', { class: 'btn sm', onClick: printRows }, [Icon('printer', { style: 'width:14px;height:14px' }), '打印']),
          h('button', {
            class: 'btn sm', disabled: exporting.value, onClick: exportXlsx,
            title: `${total.value} 份答卷，导出不只是一页`
          }, [Icon('download', { style: 'width:14px;height:14px' }), exporting.value ? '导出中…' : 'Excel']),
          h('button', { class: 'btn sm', onClick: exportCsv }, 'CSV（当前页）'),
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
        // 批量阅卷和「待批阅」是同一件事的两面，摆在一起才不会有人问「批阅入口在哪」
        form.value?.kind === 'exam'
          ? h('button', { class: 'btn sm primary', onClick: openBatch, title: '一页十份一起批，不用一份一份点开' }, '批量阅卷')
          : null,
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
                  r.marked ? h('span', { class: 'tag warn', style: 'margin-left:6px' }, '标记') : null,
                  // 切屏标记：阅卷人扫一眼列表就该知道哪几份值得先看，
                  // 而不是逐份点开详情去找这个数字
                  r.flagged ? h('span', { class: 'tag danger', style: 'margin-left:6px', title: `切屏 ${r.switch_count} 次` }, '切屏异常') : null
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
                  // 只有「真的有待批阅主观题」的考试答卷才需要批阅按钮。
                  // 早先按 kind==='exam' 全摆上，纯客观题的卷子点下去只弹一句
                  // 「这份卷子没有待批阅的主观题」——白点一次，还得多读一句否定。
                  // 已批阅过的行保留入口：老师要能回头调整分数。
                  r.form_kind === 'exam' && (r.pending > 0 || r.reviewed_at)
                    ? h('button', {
                        class: 'btn ghost sm',
                        title: r.pending > 0 ? `还有 ${r.pending} 道主观题待批阅` : `已批阅 ${r.score ?? '-'} 分，可再调整`,
                        onClick: () => openReview(r)
                      }, '批阅')
                    : null,
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
        children: h('div', {}, [
          // 作答环境先摆出来：切屏次数、耗时、IP 是「这份卷子可不可信」的第一手线索
          h('div', { class: 'flex wrap small muted mb', style: 'gap:14px' }, [
            h('span', {}, `提交时间 ${fmtDate(detail.value.created_at)}`),
            detail.value.duration ? h('span', {}, `耗时 ${Math.round(detail.value.duration / 60)} 分钟`) : null,
            detail.value.switch_count !== null && detail.value.switch_count !== undefined
              ? h('span', { style: detail.value.flagged ? 'color:var(--danger)' : '' }, `切屏 ${detail.value.switch_count} 次${detail.value.flagged ? '（异常）' : ''}`)
              : h('span', {}, '切屏 未记录'),
            detail.value.ip ? h('span', {}, `IP ${detail.value.ip}`) : null
          ]),
          ...(form.value?.schema || []).filter(f => detail.value.data[f.id] !== undefined).map(f => h('div', { class: 'mb' }, [
          h('div', { class: 'small muted' }, f.label),
          h('div', { style: 'font-weight:520;word-break:break-word;white-space:pre-wrap' },
            // 排序题的顺序、矩阵题的行列、子表单的多行，都得按各自的样子摊开：
            // 一律 join 出来的是「丙、乙、甲」和「[object Object]」
            answerDisplay(f, detail.value.data[f.id]) || '-')
          ]))
        ])
      }) : null,

      review.value ? Modal({
        title: `批阅答卷 #${review.value.id} · ${review.value.title}`, modelValue: true,
        onClose: () => review.value = null, wide: true,
        children: h('div', {
          ref: el => { reviewRoot.value = el },
          onKeydown: e => { if (e.key === 'Escape') review.value = null }
        }, [
          h('div', { class: 'small muted mb' }, review.value.reviewedAt
            ? `上次批阅：${fmtDate(review.value.reviewedAt)}，可再次调整`
            : '主观题没有标准答案，需要人工给分；给完分系统会重算总分与及格判定'),
          h('div', { class: 'kbd-bar' }, [
            h('span', {}, [h('kbd', {}, '数字'), ' 直接填分']),
            h('span', {}, [h('kbd', {}, 'Enter'), ' 下一题，最后一题再按一次 = 保存']),
            h('span', {}, [h('kbd', {}, '↑ ↓'), ' 上下题']),
            h('span', {}, [h('kbd', {}, 'Esc'), ' 退出']),
            h('button', { class: 'btn sm', style: 'margin-left:auto', onClick: () => { reviewInputs()[0]?.focus(); reviewInputs()[0]?.select?.() } }, '从第一题开始')
          ]),
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
                'data-review-score': String(it.id),
                style: 'max-width:110px', value: review.value.scores[it.id] ?? '',
                placeholder: '0',
                // 同一套键盘：单份批阅也常常是十几道题一路敲下来，凭什么要回去点鼠标
                onFocus: e => e.target.select?.(),
                onKeydown: scoreKeys(reviewInputs, saveReview),
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

      batch.value ? Modal({
        title: `批量阅卷 · ${batch.value.title}`, modelValue: true,
        onClose: () => batch.value = null, wide: true,
        children: h('div', {
          ref: el => { batchRoot.value = el },
          onKeydown: e => { if (e.key === 'Escape') batch.value = null }
        }, [
          h('div', { class: 'flex between wrap mb', style: 'gap:8px' }, [
            h('span', { class: 'small muted' },
              `待批阅 ${batch.value.total} 份 · 第 ${batch.value.offset + 1} – ${batch.value.offset + batch.value.items.length} 份`),
            h('span', { class: 'small muted' }, '只有填了分的题会被提交，留空表示「还没批」')
          ]),
          // 键盘提示摆在最上面而不是藏进 tooltip：这一页的意义就是把打字速度顶上去，
          // 而「按了 Enter 会不会直接存」是老师最不敢试的一件事
          h('div', { class: 'kbd-bar' }, [
            h('span', {}, [h('kbd', {}, '数字'), ' 直接填分（聚焦即全选，敲了就替换）']),
            h('span', {}, [h('kbd', {}, 'Enter'), ' 下一题，最后一题再按一次 = 保存本页']),
            h('span', {}, [h('kbd', {}, '↑ ↓'), ' 上下题']),
            h('span', {}, [h('kbd', {}, 'Esc'), ' 退出']),
            h('button', {
              class: 'btn sm', style: 'margin-left:auto',
              onClick: () => focusScore(0)
            }, '从第一题开始')
          ]),
          ...batch.value.items.map((x, xi) => h('div', {
            style: 'padding:14px;border:1px solid var(--line);border-radius:10px;margin-bottom:12px'
          }, [
            h('div', { class: 'flex between wrap', style: 'gap:8px;align-items:center;margin-bottom:4px' }, [
              // 用 gap 而不是给每个元素挂 margin：#3、编号、时间三段挤在一起时，
              // 少写一个 margin 就变成「#3v7qu2-m3k4u2026-11-14」这种读不出来的串
              h('div', { class: 'flex wrap', style: 'gap:8px;align-items:center' }, [
                h('b', {}, `#${x.id}`),
                x.publicId ? h('span', { class: 'mono small muted' }, x.publicId) : null,
                h('span', { class: 'small muted' }, fmtDate(x.createdAt)),
                h('span', { class: 'tag' }, `客观题 ${x.score ?? '-'} 分`)
              ]),
              h('div', { class: 'flex', style: 'gap:4px' }, [
                h('button', { class: 'btn ghost sm', onClick: () => fillBatch(x, 'zero') }, '全 0 分'),
                h('button', { class: 'btn ghost sm', onClick: () => fillBatch(x, 'full') }, '全满分')
              ])
            ]),
            ...x.items.map(it => h('div', { style: 'padding:10px 0;border-top:1px dashed var(--line)' }, [
              h('div', { class: 'flex between', style: 'gap:10px;align-items:flex-start' }, [
                h('div', { style: 'font-size:13.5px;line-height:1.5' }, it.label),
                h('span', { class: 'tag', style: 'flex:none' }, `满分 ${it.score}`)
              ]),
              h('div', {
                style: 'white-space:pre-wrap;word-break:break-word;margin:6px 0 8px;font-size:13px;color:var(--text-2)'
              }, it.given ? it.given : h('span', { class: 'muted' }, '（未作答）')),
              h('div', { class: 'flex', style: 'gap:6px;align-items:center;flex-wrap:wrap' }, [
                h('input', {
                  class: 'input', type: 'number', min: 0, max: it.score, step: '0.5',
                  'data-batch-score': String(it.id),
                  style: 'max-width:96px', value: x.draft[it.id],
                  placeholder: '未批',
                  onFocus: e => e.target.select?.(),
                  onKeydown: scoreKeys(scoreInputs, saveBatch),
                  onInput: e => {
                    x.revoke.delete(it.id)
                    x.draft[it.id] = e.target.value
                  }
                }),
                h('button', { class: 'btn sm', onClick: () => { x.revoke.delete(it.id); x.draft[it.id] = String(it.score) } }, '满分'),
                h('button', { class: 'btn sm', onClick: () => { x.revoke.delete(it.id); x.draft[it.id] = '0' } }, '0 分'),
                // 服务端早就支持 null = 撤分回队列，界面上一直没有入口；
                // 给过分之后又把「还没批」写回来的通道，只能靠这一颗
                it.current !== null && it.current !== undefined
                  ? h('button', {
                      class: 'btn ghost sm', title: '撤掉这道题的分，让它回到待批队列',
                      onClick: () => { x.revoke.add(it.id); x.draft[it.id] = '' }
                    }, x.revoke.has(it.id) ? '已撤分' : '撤分')
                  : null,
                it.analysis ? h('span', { class: 'small muted', style: 'margin-left:4px' }, '解析：' + it.analysis.slice(0, 40)) : null
              ])
            ])),
            h('input', {
              class: 'input', style: 'margin-top:8px', placeholder: '这份卷子的批阅备注（可选）',
              value: x.noteDraft, onInput: e => { x.noteDraft = e.target.value }
            })
          ])),
          batch.value.items.length ? null : Empty({ text: '这一页已经没有待批阅的答卷了' })
        ]),
        footer: [
          h('button', { class: 'btn', disabled: batch.value.offset === 0, onClick: () => batchPage(-1) }, '上一页'),
          h('button', {
            class: 'btn',
            disabled: batch.value.offset + batch.value.limit >= batch.value.total,
            onClick: () => batchPage(1)
          }, '下一页'),
          h('button', { class: 'btn', onClick: () => batch.value = null }, '关闭'),
          h('button', { class: 'btn primary', disabled: batchBusy.value, onClick: saveBatch }, batchBusy.value ? '保存中…' : '保存本页分数')
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
    ])
  }
}
