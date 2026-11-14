import { h, ref, onMounted, onBeforeUnmount, computed, nextTick, watch } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { route } from '../router.js'
import { ok, err, confirmBox, fmtDate, Empty, Modal, Pagination, escapeHtml } from '../ui.js'
import { Icon } from '../icons.js'
import { renderControl, answerDisplay } from '../renderer.js'
import { buildFlow } from '../flow.js'
import { batchPayload, nextIndex, reviewProgress, afterSave, elapsedSeconds, changeText, changeLine, humanSeconds, gapLevel, bandText, biasText } from '../review.js'

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
          // 上次是谁批的、这之前改过几次：一份卷子两个人先后批过，
          // 分差得离谱时要能一眼看出不是同一个人给的
          reviewer: sub.reviewer || '',
          logs: sub.review_logs || [],
          // 这一次从什么时候开始下手：留痕里的「耗时」不该从弹窗打开算起
          startedAt: 0,
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
      touchReview()
      for (const it of review.value.items) {
        if (review.value.scores[it.id] === undefined || review.value.scores[it.id] === '') review.value.scores[it.id] = 0
      }
    }

    const saveReview = async () => {
      try {
        const r = await api.put(`/api/submissions/${review.value.id}/review`, {
          scores: review.value.scores, note: review.value.note,
          // 只记「真的动手」的那一段：打开看一眼就关掉，不该在留痕里多出一次耗时
          seconds: elapsedSeconds(review.value.startedAt, Date.now())
        })
        const total = r.data.review ? `${r.data.review.total} 分` : ''
        ok(`批阅完成${total ? `，重新计算成绩 ${total}` : ''}`)
        review.value = null
        load()
      } catch (e) { err(e.message) }
    }

    /** 单份批阅里第一次动分数的那一刻，用来算这一份批了多久 */
    const touchReview = () => { if (review.value && !review.value.startedAt) review.value.startedAt = Date.now() }
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

    /* ---------------- 评分尺度 ----------------
     *
     * 留痕能追到「谁批的、改了什么」，但两个人对同一题给出 4 分和 18 分时，
     * 系统只是把两条并排摆着，成绩单照旧只有一个总分。教研组真做的事是
     * 「同一道题先各自批 10 份，对一遍尺子再开工」——这件事现在能看了。
     */
    /**
     * 尺子的时间走向：一排偏移柱。
     *
     * 纵轴是「同一格上这位老师与同格其他人的平均分之差」，零线以上是给得偏高、以下是偏低。
     * 不用 SVG 折线：一条 viewBox 220×44 的线塞进 800px 的卡片里，等比缩放后只能挤在中间，
     * 而横向拉伸会把描边和圆点一起压扁。柱子用 CSS 百分比画，宽度跟着容器走，不需要换算。
     *
     * 刻度由整张表共用（driftScale）：每位老师各用各的刻度，+0.5 和 +9 会长成一样高，
     * 而这张表存在的意义正是「谁松得多」。
     */
    const driftScale = (drift) => {
      const values = drift.buckets.flatMap(b => b.teachers.map(t => t.bias))
      if (!values.length) return { lo: -1, hi: 1 }
      const lo = Math.min(0, ...values)
      const hi = Math.max(0, ...values)
      // 上下各留 12% 余量：最矮的那根柱若顶到边框，柱上的读数就得压在柱子里，读不出来
      const pad = (hi - lo || 1) * 0.12
      return { lo: lo - pad, hi: hi + pad }
    }
    const driftBars = (drift, key, scale) => {
      const span = scale.hi - scale.lo || 1
      const zero = (scale.hi / span) * 100
      return h('div', { class: 'drift-chart' }, [
        // 零线：偏移 0 分的意思是「和同格其他人给的一样」，这条线才是基准，不是中间那条
        h('div', { class: 'drift-zero', style: `top:${zero}%` }),
        ...drift.buckets.map(b => {
          const t = b.teachers.find(x => x.key === key)
          if (!t) {
            // 这个时间段里没有可比的一格：空着，不补一个 0 分进去——
            // 补 0 会长成一根「他和别人给得一样」的柱子，而事实是那段时间没有证据
            return h('div', { class: 'drift-col' }, [h('i', { class: 'drift-gap', title: `${b.label} 没有可比的一格` })])
          }
          const top = (scale.hi - Math.max(t.bias, 0)) / span * 100
          const height = (Math.abs(t.bias) / span) * 100
          return h('div', { class: 'drift-col' }, [
            h('i', {
              class: ['drift-bar', t.bias < 0 ? 'neg' : ''],
              style: `top:${top}%;height:${Math.max(height, 0.6)}%`,
              title: `${b.label}：${biasText(t.bias)} 分（${t.n} 处对比）`
            }),
            // 数值写在柱子那一侧：光看柱高只能读「涨了还是跌了」，具体几分还得靠这行字
            h('span', {
              class: 'drift-val',
              // 负值写在柱下方、正值写在柱上方：标的始终是「这一根柱的读数」，不飘到零线另一侧。
              // 偏移用 px 而不是百分比：柱子最矮时（不到 1 分）百分比偏移会贴着柱子，读数看不清
              style: t.bias < 0 ? `top:calc(${top + height}% + 3px)` : `bottom:calc(${100 - top}% + 3px)`
            }, biasText(t.bias))
          ])
        })
      ])
    }

    const calibration = ref(null)
    const openCalibration = async () => {
      if (!form.value) return err('请先在左上角选择一个具体表单')
      if (form.value.kind !== 'exam') return err('只有考试需要批阅')
      try {
        calibration.value = { title: form.value.title, loading: true }
        const r = await api.get(`/api/forms/${formId.value}/review-calibration`)
        calibration.value = { title: form.value.title, loading: false, ...r.data }
      } catch (e) {
        calibration.value = null
        err(e.message)
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
      let r = await api.get(`/api/forms/${formId.value}/review-queue?limit=${BATCH_LIMIT}&offset=${offset || 0}`)
      // 批完最后一页的几份之后，队列变短了，原来的 offset 可能已经越过队尾。
      // 这时回落到队尾那一页，而不是给一张空页让人以为「批完了」（其实前面还有没批的）
      if (!r.data?.length && r.total > 0 && offset > 0) {
        offset = Math.max(Math.floor((r.total - 1) / BATCH_LIMIT) * BATCH_LIMIT, 0)
        r = await api.get(`/api/forms/${formId.value}/review-queue?limit=${BATCH_LIMIT}&offset=${offset}`)
      }
      const items = (r.data || []).map(x => ({
        ...x,
        // 输入框里存字符串更方便：空串表示「还没给分」，0 是有效的 0 分
        draft: Object.fromEntries(x.items.map(it => [it.id, it.current == null ? '' : String(it.current)])),
        // 「撤掉已给的分，退回待批」要单记一笔：空串表示「本来就没批」，
        // 两者混成一个状态的话，撤分这份永远赖在队列里
        revoke: new Set(),
        // 这一份第一次动手的时间：耗时按份算，不按整页算
        startedAt: 0,
        noteDraft: x.note || ''
      }))
      batch.value = {
        formId: formId.value, title: form.value.title,
        // need/done 是整场考试的进度锚：total 只是「这一页还剩几份待批」，
        // 拿它当分子分母都会说错话（批到第 6 页时它一直是 10）
        need: r.need, done: r.done, scanned: r.scanned,
        total: r.total, offset: offset || 0, limit: BATCH_LIMIT, items
      }
      // 保存之后队列清空是正常结果，不该再弹一句「没有待批阅」——那句提示是说给「点进来才发现空」的人
      /*
       * 空队列有两种说法，混成一句会让人以为点错了地方：
       * ① 这场考试的卷子一份都还没交（或压根没有主观题）→「没有待批阅的答卷」；
       * ② 本来有，而且现在全批完了 → 直接说批完了、共几份。
       */
      if (!items.length && !r.total && !silent) {
        return r.done > 0
          ? ok(`这场考试 ${r.done} 份有主观题的卷子都批完了`)
          : ok('这张卷子没有待批阅的答卷了')
      }
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
        // 批完就从队列里消失，所以重新拉这一页而不是往下翻：往下翻会跳过被清掉的位置，
        // 一页 10 份只批了 3 份时，剩下的 7 份就被翻页翻过去了
        await loadBatch(batch.value.offset, { silent: true })
        await load()
        // 存完把焦点交回第一题：批一整页时手不用离开键盘，接着敲下一批
        if (batch.value?.items.length) nextTick(() => focusScore(0))
        if (r.rejected?.length) {
          err(`已保存 ${r.saved} 份，${r.rejected.length} 份被拒：${r.rejected[0].reason}`)
        } else {
          const p = reviewProgress(batch.value?.need, batch.value?.done)
          const next = afterSave({ offset: batch.value?.offset, left: p.left })
          ok(next.action === 'done'
            ? `已保存 ${r.saved} 份，这场考试的卷子批完了`
            : `已保存 ${r.saved} 份，还剩 ${p.left} 份待批`)
        }
      } catch (e) { err(e.message) } finally { batchBusy.value = false }
    }

    const batchPage = async (dir) => {
      const offset = Math.max((batch.value?.offset || 0) + dir * (batch.value?.limit || BATCH_LIMIT), 0)
      try { await loadBatch(offset) } catch (e) { err(e.message) }
    }

    const fillBatch = (x, value) => {
      if (!x.startedAt) x.startedAt = Date.now()
      for (const it of x.items) x.draft[it.id] = String(value === 'full' ? it.score : 0)
    }

    /** 这一份第一次动手的时间：耗时按份算，不按整页算 */
    const touchRow = (x) => { if (!x.startedAt) x.startedAt = Date.now() }

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

    /**
   * 进度锚：批到第 6 页时，得知道自己在整场考试的哪儿。
   * 只显示「待批阅 10 份」是不够的——那个 10 是这一页的，不是这场考试的。
   */
  const progressBar = (b) => {
    const p = reviewProgress(b.need, b.done)
    return h('div', { class: 'review-progress' }, [
      h('div', { class: 'flex between wrap', style: 'gap:8px;align-items:baseline' }, [
        h('span', { class: 'small', style: 'font-weight:600' },
          p.complete
            ? `这场考试 ${p.total} 份有主观题的卷子都批完了`
            : `本次共 ${p.total} 份 · 已批 ${p.done} · 还剩 ${p.left}`),
        // 队列空了就别再说「这一页第 1 – 0 份」——那是把内部页码漏到人眼前
        h('span', { class: 'small muted' },
          b.items.length
            ? `这一页第 ${b.offset + 1} – ${b.offset + b.items.length} 份 · 只有填了分的题会被提交`
            : '只有填了分的题会被提交，留空表示「还没批」')
      ]),
      h('div', { class: 'bar-line', style: 'margin-top:6px' }, [
        h('i', { style: `width:${p.percent}%` })
      ])
    ])
  }

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
        // 尺度对账跟批量阅卷是同一件事的两端：一个往前批，一个回头对尺子
        form.value?.kind === 'exam'
          ? h('button', { class: 'btn sm', onClick: openCalibration, title: '同一道题两个人给了差多远的分' }, '评分尺度')
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
                      /*
                       * 分数区间挨着分数写。尺度对账已经把「谁偏松」摆出来了，
                       * 但列表里那个 71 看着还是一个精确的数字——读者不知道该信几成。
                       * 只有真的被两位老师给出过不同的分才有区间，没有就不占这一格。
                       */
                      r.band && r.band.spread > 0
                        ? h('span', {
                            class: 'tag', style: 'margin-left:4px',
                            title: `有题目被两位老师给出不同分数，换个尺子总分会在 ${r.band.low} ~ ${r.band.high} 之间`
                          }, `≈${r.band.low}~${r.band.high}`)
                        : null,
                      // 「谁批的」比「批过了」更重要：一封卷子两道题分差得离谱时，
                      // 先要知道这是不是一个人给的
                      r.reviewed_at
                        ? h('span', {
                            class: 'tag', style: 'margin-left:4px',
                            title: `批阅人：${r.reviewer || '未知账号'}`
                          }, r.reviewer ? `批：${r.reviewer}` : '已批阅')
                        : null
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
            // 详情页要跟列表说同一句话：列表里写「71 ≈59~71」，这里只写 71，两处数字对不上最伤信任
            detail.value.band && detail.value.band.spread > 0
              ? h('span', {}, `得分 ${bandText(detail.value.band)}`)
              : null,
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
            ? `上次批阅：${fmtDate(review.value.reviewedAt)}${review.value.reviewer ? ` · ${review.value.reviewer}` : ''}，可再次调整`
            : '主观题没有标准答案，需要人工给分；给完分系统会重算总分与及格判定'),
          // 批阅历史摊在打开就能看到的位置：一份卷子两个人先后批过，
          // 两道题的分差得离谱时，第一眼要看的是「是不是同一个人给的」
          review.value.logs?.length ? h('details', { class: 'review-logs mb' }, [
            h('summary', {}, `批阅记录 ${review.value.logs.length} 次`,
              h('span', { class: 'small muted', style: 'margin-left:8px' },
                changeText(review.value.logs[0].changes || []))),
            ...review.value.logs.map(lg => h('div', { class: 'review-log-item' }, [
              h('div', { class: 'flex between wrap', style: 'gap:8px' }, [
                h('span', { class: 'small', style: 'font-weight:600' },
                  `${lg.username || '未知账号'} · ${fmtDate(lg.createdAt)}`),
                h('span', { class: 'small muted' },
                  [lg.source === 'batch' ? '批量阅卷' : '单份批阅',
                    humanSeconds(lg.seconds) ? `用时 ${humanSeconds(lg.seconds)}` : '',
                    lg.scoreBefore !== null && lg.scoreBefore !== undefined && lg.scoreAfter !== null
                      ? `${lg.scoreBefore} → ${lg.scoreAfter} 分` : ''].filter(Boolean).join(' · '))
              ]),
              h('div', { class: 'small', style: 'margin-top:2px;color:var(--text-2)' },
                (lg.changes || []).map(c => `${c.label}：${changeLine(c)}`).join('；') || '没有改动'),
              lg.note ? h('div', { class: 'small muted', style: 'margin-top:2px' }, '备注：' + lg.note) : null
            ]))
          ]) : null,
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
            /*
             * 这题被别人给过别的分，就在这里说清楚。
             * 不然老师只看到「当前 17 分」，回头在尺度页上发现同题有人给 5 分，
             * 想改又不知道改多少——分叉的口径必须在给分的那一刻就摆在眼前。
             */
            (() => {
              const row = review.value.band?.items?.find(x => x.id === it.id)
              if (!row) return null
              return h('div', { class: 'small', style: 'margin-top:6px;color:var(--text-2)' }, [
                h('span', { class: 'tag warn' }, '尺子不一'),
                h('span', { style: 'margin-left:6px' },
                  row.by.map(p2 => `${p2.name || '未知账号'} ${p2.value} 分`).join(' · ') +
                  `，换成另一位老师是 ${row.low} ~ ${row.high} 分`)
              ])
            })(),
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
                  touchReview()
                  if (v === '') delete review.value.scores[it.id]
                  else review.value.scores[it.id] = Number(v)
                }
              }),
              h('button', {
                class: 'btn sm', onClick: () => { touchReview(); review.value.scores[it.id] = it.score }
              }, '满分'),
              h('button', {
                class: 'btn sm', onClick: () => { touchReview(); review.value.scores[it.id] = 0 }
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

      calibration.value ? Modal({
        title: `评分尺度 · ${calibration.value.title}`, modelValue: true,
        onClose: () => calibration.value = null, wide: true,
        children: h('div', {}, calibration.value.loading
          ? h('div', { style: 'padding:20px' }, '正在回放批阅留痕…')
          : [
            /*
             * 头一句只说两件事：对过多少格、其中有几格不一致。
             * 「同一道题被两个人给过不同的分」才是证据，「两个人平均分不同」不是——
             * 他们批的可能是不同考生的答案，考生水平本来就有差。
             */
            h('div', { class: 'flex between wrap', style: 'gap:8px;align-items:baseline' }, [
              h('span', { class: 'small', style: 'font-weight:600' },
                calibration.value.conflicts
                  ? `两位老师对同一道题给出不同分数的地方：${calibration.value.conflicts} 处`
                  : (calibration.value.note || '还没有同一道题被两位老师给出不同的分')),
              h('span', { class: 'small muted' }, `回放 ${calibration.value.logs || 0} 条批阅留痕`)
            ]),
            /*
             * 分母看不见这件事得说出来：同分不留痕，所以「对过几处」只能算个下限。
             * 摆一个假分母上去（比如「共对过 20 处，其中 18 处不一致」）比不摆更糟。
             */
            h('div', { class: 'small muted', style: 'margin-top:6px' },
              '同一个人给的分没被人改过就不会留痕，所以这里只统计「被后一位老师改过」的地方——它是下限，不是全部。'),
            /*
             * 把「18 处分歧」换算成成绩单上的话：几份卷子的总分因此带上了区间、最大浮动多少。
             * 抽象的分歧数读者得自己换算成「所以呢」，而这两句是直接可读的结论。
             */
            calibration.value.bands?.submissions
              ? h('div', { class: 'small', style: 'margin-top:8px;padding:8px 12px;background:var(--panel-2);border-radius:8px' }, [
                  h('b', {}, `${calibration.value.bands.submissions} 份卷子`),
                  `的成绩单因此带了区间，最大浮动 ${calibration.value.bands.maxSpread} 分——`,
                  '答卷列表与导出里，这些卷子会写成「71 ≈59~71」，表示换另一位老师批会是这个范围。'
                ])
              : null,
            calibration.value.questions?.length ? h('div', { style: 'margin-top:12px' }, [
              ...calibration.value.questions.map(q => h('div', {
                class: 'calib-row', style: 'padding:12px 14px;border:1px solid var(--line);border-radius:10px;margin-bottom:10px'
              }, [
                h('div', { class: 'flex between wrap', style: 'gap:8px;align-items:flex-start' }, [
                  h('div', { style: 'font-size:13.5px;line-height:1.5;font-weight:520' }, q.label),
                  h('div', { class: 'flex', style: 'gap:6px;align-items:center;flex:none' }, [
                    h('span', { class: 'tag' }, `满分 ${q.max}`),
                    // 差 1 分不值得开会，差 10 分才值得：门槛按比例算，不按绝对分算
                    gapLevel(q.worst?.gap, q.max)
                      ? h('span', { class: ['tag', gapLevel(q.worst?.gap, q.max) === '明显' ? 'danger' : 'warn'] },
                          gapLevel(q.worst?.gap, q.max))
                      : null
                  ])
                ]),
                // 每一处并排写清楚是谁给了几分：平均成一句「平均差 7 分」就看不出是 4 和 18
                ...q.cells.slice(0, 4).map(c => h('div', {
                  class: 'small', style: 'margin-top:6px;color:var(--text-2)'
                }, [
                  h('span', { class: 'mono muted', style: 'margin-right:6px' }, `#${c.submissionId}`),
                  ...c.by.map((p2, i) => h('span', {}, [
                    i ? h('span', { class: 'muted', style: 'margin:0 5px' }, 'vs') : null,
                    h('b', {}, p2.name || '未知账号'),
                    h('span', {}, ` ${p2.value} 分`)
                  ])),
                  h('span', { class: 'muted', style: 'margin-left:8px' }, `差 ${c.gap} 分`)
                ])),
                q.cells.length > 4
                  ? h('div', { class: 'small muted', style: 'margin-top:4px' }, `另有 ${q.cells.length - 4} 处不一致未展开`)
                  : null
              ]))
            ]) : null,
            /*
             * 两两对账。人数 >2 的教研组真正要问的是「谁的标准偏松」，
             * 而这只有两两之间对过同一批格子才说得清。
             */
            calibration.value.pairs?.length ? h('div', { style: 'margin-top:14px' }, [
              h('div', { class: 'small', style: 'font-weight:600;margin-bottom:6px' }, '两两对账'),
              ...calibration.value.pairs.map(p2 => h('div', {
                class: 'small', style: 'padding:8px 0;border-top:1px dashed var(--line);color:var(--text-2)'
              }, [
                h('b', {}, p2.a || '未知账号'), h('span', { class: 'muted', style: 'margin:0 6px' }, 'vs'),
                h('b', {}, p2.b || '未知账号'),
                // 说的只能是「被改过 N 处」：同分不留痕，两人意见一致的地方在库里不存在
                h('span', { style: 'margin-left:8px' }, `被改过 ${p2.count} 处 · 平均差 ${p2.avgGap} 分`),
                // 偏松/偏紧写在后半句，结论要能一句话读完
                p2.bias ? h('span', { style: 'margin-left:8px' },
                  `（${p2.bias > 0 ? p2.a : p2.b} 平均高 ${Math.abs(p2.bias)} 分）`) : h('span', { style: 'margin-left:8px' }, '（没有系统性偏向）')
              ]))
            ]) : null,
            /*
             * 尺子随时间的走向。
             *
             * 「李老师平均高 4.61 分」是所有制摞在一起的平均值：如果他前 20 份偏松 9 分、
             * 被教研组长谈过之后后 40 份收紧到 -1 分，平均下来是 +2 分——两极互相抵消，
             * 于是「谈过之后确实收了」这件事在旧口径里永远既不能被证实也不能被证伪。
             */
            calibration.value.drift?.teachers?.length ? h('div', { style: 'margin-top:18px' }, [
              h('div', { class: 'small', style: 'font-weight:600;margin-bottom:4px' }, '尺子随时间的走向'),
              h('div', { class: 'small muted', style: 'margin-bottom:10px' },
                `按${{ day: '天', week: '周', month: '月' }[calibration.value.drift.unit] || '时间'}切分：每个点是「同一格上，这位老师与同格其他人的平均分之差」。`
                + '绝对分不进这条线——后面那批考生可能就是答得更差，那不叫放宽。'),
              ...calibration.value.drift.teachers.slice(0, 4).map(t => h('div', { class: 'drift-row' }, [
                h('div', { class: 'flex between wrap', style: 'gap:8px;align-items:baseline' }, [
                  h('div', { class: 'flex', style: 'gap:8px;align-items:baseline;min-width:0' }, [
                    h('b', { class: 'small' }, t.name),
                    h('span', { class: 'small muted' }, `整体 ${biasText(t.bias)} 分 · ${t.samples} 处对比`)
                  ]),
                  // 结论只在首末两段样本都够时才给：一个桶里一格数据说「他收紧了」，那只是运气
                  t.verdict === '收紧' || t.verdict === '放松'
                    ? h('span', { class: ['tag', t.verdict === '收紧' ? 'ok' : 'warn'] },
                        `${t.verdict} ${Math.abs(Math.round(t.delta * 10) / 10)} 分`)
                    : h('span', { class: 'tag' }, t.verdict)
                ]),
                t.first && t.last
                  ? h('div', { class: 'small muted', style: 'margin-top:2px' },
                      `${t.first.label}：${biasText(t.first.bias)} → ${t.last.label}：${biasText(t.last.bias)}`)
                  : null,
                driftBars(calibration.value.drift, t.key, driftScale(calibration.value.drift))
              ])),
              // X 轴只在整张表底部画一次：三行图各带一份桶标签，读起来全是重复的字
              h('div', { class: 'drift-axis' },
                calibration.value.drift.buckets.map(b => h('span', {}, b.label))),
              /*
               * 零和的实话得说出来：每个人的偏移都相对「同格其他人的均值」，
               * 所以两个人的走向必然互为镜像。张老师收紧 4.5 分，同格那位就是放松 4.5 分——
               * 这不是两条独立证据，是一件事的两个方向。
               */
              calibration.value.drift.teachers.length > 1
                ? h('div', { class: 'small muted', style: 'margin-top:4px' },
                    '同一格里所有人的偏移加起来是 0，所以两个人的走向互为镜像：一个人收紧多少，同格那位就是放松多少。')
                : null
            ]) : (calibration.value.drift?.note
              // 空的时候也要有个小标题：只甩一句灰字，读者不知道这块本来该长什么样
              ? h('div', { style: 'margin-top:18px' }, [
                  h('div', { class: 'small', style: 'font-weight:600;margin-bottom:4px' }, '尺子随时间的走向'),
                  h('div', { class: 'small muted' }, calibration.value.drift.note)
                ])
              : null),
            calibration.value.teachers?.length > 1
              ? h('div', { class: 'small muted', style: 'margin-top:12px' },
                  '参与批阅的账号：' + calibration.value.teachers.map(t => `${t.name || '未知账号'}（${t.gradings} 次）`).join(' · '))
              : null
          ]),
        footer: [h('button', { class: 'btn', onClick: () => calibration.value = null }, '关闭')]
      }) : null,

      batch.value ? Modal({
        title: `批量阅卷 · ${batch.value.title}`, modelValue: true,
        onClose: () => batch.value = null, wide: true,
        children: h('div', {
          ref: el => { batchRoot.value = el },
          onKeydown: e => { if (e.key === 'Escape') batch.value = null }
        }, [
          progressBar(batch.value),
          // 键盘提示摆在最上面而不是藏进 tooltip：这一页的意义就是把打字速度顶上去，
          // 而「按了 Enter 会不会直接存」是老师最不敢试的一件事
          batch.value.items.length ? h('div', { class: 'kbd-bar' }, [
            h('span', {}, [h('kbd', {}, '数字'), ' 直接填分（聚焦即全选，敲了就替换）']),
            h('span', {}, [h('kbd', {}, 'Enter'), ' 下一题，最后一题再按一次 = 保存本页']),
            h('span', {}, [h('kbd', {}, '↑ ↓'), ' 上下题']),
            h('span', {}, [h('kbd', {}, 'Esc'), ' 退出']),
            h('button', {
              class: 'btn sm', style: 'margin-left:auto',
              onClick: () => focusScore(0)
            }, '从第一题开始')
          ]) : null,
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
                h('span', { class: 'tag' }, `客观题 ${x.score ?? '-'} 分`),
                // 这一份别人已经批过一部分：两口子/两位老师同时批同一场时，
                // 谁给了多少分必须一眼看得见，否则两份分差得离谱也没人知道是两个人干的
                x.reviewedAt
                  ? h('span', {
                      class: 'tag warn',
                      title: `${x.reviewer || '未知账号'} 于 ${fmtDate(x.reviewedAt)} 批阅过，这次是接着改`
                    }, `上次由 ${x.reviewer || '未知账号'} 批`)
                  : null
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
              /*
               * 这题别人给过别的分，就在敲键盘之前说清楚。
               * 尺度页上说「李老师偏松 4.61 分」是回头看的结论；批到第 6 页时，
               * 老师要的是「这一份、这一题，之前有人给了几」——不然第三个口径又是随手定的。
               */
              it.others?.length ? h('div', { class: 'small', style: 'margin-top:4px' }, [
                h('span', { class: 'tag warn' }, '尺子不一'),
                h('span', { style: 'margin-left:6px;color:var(--text-2)' },
                  it.others.map(p2 => `${p2.name || '未知账号'} ${p2.value} 分`).join(' · '))
              ]) : null,
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
                    touchRow(x)
                    x.revoke.delete(it.id)
                    x.draft[it.id] = e.target.value
                  }
                }),
                h('button', { class: 'btn sm', onClick: () => { touchRow(x); x.revoke.delete(it.id); x.draft[it.id] = String(it.score) } }, '满分'),
                h('button', { class: 'btn sm', onClick: () => { touchRow(x); x.revoke.delete(it.id); x.draft[it.id] = '0' } }, '0 分'),
                // 服务端早就支持 null = 撤分回队列，界面上一直没有入口；
                // 给过分之后又把「还没批」写回来的通道，只能靠这一颗
                it.current !== null && it.current !== undefined
                  ? h('button', {
                      class: 'btn ghost sm', title: '撤掉这道题的分，让它回到待批队列',
                      onClick: () => { touchRow(x); x.revoke.add(it.id); x.draft[it.id] = '' }
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
          batch.value.items.length ? null : Empty({
            text: reviewProgress(batch.value.need, batch.value.done).complete
              ? '这场考试的卷子都批完了'
              : '这一页已经没有待批阅的答卷了'
          })
        ]),
        footer: [
          h('button', { class: 'btn', disabled: batch.value.offset === 0, onClick: () => batchPage(-1) }, '上一页'),
          h('button', {
            class: 'btn',
            disabled: reviewProgress(batch.value.need, batch.value.done).complete
              || batch.value.offset + batch.value.limit >= batch.value.total,
            onClick: () => batchPage(1)
          }, '下一页'),
          h('button', { class: 'btn', onClick: () => batch.value = null }, '关闭'),
          // 队列空了就不摆一颗点了会报错的保存按钮：这时候该做的是关掉它
          batch.value.items.length
            ? h('button', { class: 'btn primary', disabled: batchBusy.value, onClick: saveBatch }, batchBusy.value ? '保存中…' : '保存本页分数')
            : null
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
