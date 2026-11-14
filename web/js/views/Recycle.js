import { h, ref, onMounted, computed } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { ok, err, confirmBox, fmtDate, Empty } from '../ui.js'

export default {
  setup() {
    const tab = ref('form')
    const forms = ref([])
    const subs = ref({ self: [], byForm: [] })
    const banks = ref([])
    const questions = ref([])
    const loading = ref(true)

    const load = async () => {
      loading.value = true
      try {
        const [f, s, b, q] = await Promise.all([
          api.get('/api/forms?recycle=1&pageSize=100'),
          api.get('/api/recycle/submissions'),
          api.get('/api/banks/recycle'),
          api.get('/api/questions/recycle')
        ])
        forms.value = f.data
        subs.value = s.data
        banks.value = b.data
        questions.value = q.data
      } catch (e) { err(e.message) } finally { loading.value = false }
    }
    onMounted(load)

    const restore = async (f) => {
      try { await api.post(`/api/forms/${f.id}/restore`); ok('已恢复'); load() } catch (e) { err(e.message) }
    }
    const purge = async (f) => {
      const count = f.submission_count || 0
      if (!await confirmBox(`彻底删除「${f.title}」？${count ? `它的 ${count} 份答卷和全部附件会一并删除，` : ''}此操作不可恢复！`)) return
      try {
        const r = await api.del(`/api/forms/${f.id}/purge`)
        ok(`已彻底删除${r.files ? `，清理 ${r.files} 个附件` : ''}`)
        load()
      } catch (e) { err(e.message) }
    }

    const restoreSub = async (s) => {
      try { await api.post(`/api/submissions/${s.id}/restore`); ok('已恢复'); load() } catch (e) { err(e.message) }
    }
    const restoreFormOf = async (s) => {
      try { await api.post(`/api/forms/${s.form_id}/restore`); ok('表单已恢复，答卷也随之回来'); load() } catch (e) { err(e.message) }
    }

    const restoreBank = async (b) => {
      try { await api.post(`/api/banks/${b.id}/restore`); ok('题库已恢复'); load() } catch (e) { err(e.message) }
    }
    const purgeBank = async (b) => {
      if (!await confirmBox(`彻底删除题库「${b.name}」？其中 ${b.question_count || 0} 道题会一并删除，不可恢复！`)) return
      try {
        const r = await api.del(`/api/banks/${b.id}/purge`)
        ok(`已彻底删除，清理 ${r.questions || 0} 道题`)
        load()
      } catch (e) { err(e.message) }
    }
    const restoreQuestion = async (q) => {
      try { await api.post(`/api/questions/${q.id}/restore`); ok('题目已恢复'); load() } catch (e) { err(e.message) }
    }

    const subCount = computed(() => subs.value.self.length + subs.value.byForm.length)

    // 必须是个函数：写成常量会在 setup 里求值一次，计数被冻在「加载中」那一刻的 0，
    // 数据回来以后表格有内容、标签上却一直是「表单（0）」。
    const tabs = () => h('div', { class: 'tabs' }, [
      h('button', { class: tab.value === 'form' ? 'on' : '', onClick: () => tab.value = 'form' }, `表单（${forms.value.length}）`),
      h('button', { class: tab.value === 'sub' ? 'on' : '', onClick: () => tab.value = 'sub' }, `答卷（${subCount.value}）`),
      h('button', { class: tab.value === 'bank' ? 'on' : '', onClick: () => tab.value = 'bank' }, `题库（${banks.value.length}）`),
      h('button', { class: tab.value === 'question' ? 'on' : '', onClick: () => tab.value = 'question' }, `题目（${questions.value.length}）`)
    ])

    // 表格必须包一层横向滚动：390px 屏幕上直接把 table 塞进 overflow:hidden 的卡片，
    // 中文标题会被压成一行一个字，「彻底删除」按钮还会被裁掉右半边。
    const scroll = (child) => h('div', { class: 'card', style: 'overflow:hidden' }, [
      // 横滚在窄屏上不给提示等于没做：用户只看到前两列，不知道右边还有「恢复 / 彻底删除」
      h('div', { class: 'scroll-hint' }, '表格可左右滑动查看全部列'),
      h('div', { style: 'overflow-x:auto' }, child)
    ])

    const formTable = () => scroll(forms.value.length ? h('table', { class: 'table' }, [
      h('thead', {}, h('tr', {}, [h('th', {}, '标题'), h('th', {}, '类型'), h('th', {}, '答卷'), h('th', {}, '删除时间'), h('th', {}, '操作')])),
      h('tbody', {}, forms.value.map(f => h('tr', {}, [
        h('td', { style: 'font-weight:540' }, f.title),
        h('td', { class: 'nowrap' }, h('span', { class: 'tag', style: 'white-space:nowrap' }, { survey: '问卷', exam: '考试', form: '表单' }[f.kind] || '表单')),
        h('td', { class: 'small muted nowrap' }, `${f.submission_count || 0} 份`),
        h('td', { class: 'small muted nowrap' }, fmtDate(f.deleted_at)),
        h('td', { class: 'nowrap' }, h('div', { class: 'flex', style: 'gap:6px' }, [
          h('button', { class: 'btn sm', onClick: () => restore(f) }, '恢复'),
          h('button', { class: 'btn sm danger', onClick: () => purge(f) }, '彻底删除')
        ]))
      ])))
    ]) : Empty({ text: '回收中心没有待恢复的表单' }))

    const subTable = () => {
      const rows = [
        ...subs.value.self.map(s => ({ ...s, why: '已删除' })),
        ...subs.value.byForm.map(s => ({ ...s, why: '表单在回收站' }))
      ]
      return scroll(rows.length ? h('table', { class: 'table' }, [
        h('thead', {}, h('tr', {}, [h('th', {}, '编号'), h('th', {}, '所属表单'), h('th', {}, '提交时间'), h('th', {}, '原因'), h('th', {}, '操作')])),
        h('tbody', {}, rows.map(s => h('tr', {}, [
          h('td', { class: 'mono' }, '#' + s.id),
          h('td', {}, s.form_title || '-'),
          h('td', { class: 'nowrap small muted' }, fmtDate(s.created_at)),
          h('td', { class: 'nowrap' }, h('span', { class: ['tag', s.why === '已删除' ? 'warn' : ''], style: 'white-space:nowrap' }, s.why)),
          h('td', { class: 'nowrap' }, h('div', { class: 'flex', style: 'gap:6px' }, [
            s.why === '已删除'
              ? h('button', { class: 'btn sm', onClick: () => restoreSub(s) }, '恢复答卷')
              : h('button', { class: 'btn sm', onClick: () => restoreFormOf(s) }, '恢复所属表单')
          ]))
        ])))
      ]) : Empty({ text: '没有待恢复的答卷' }))
    }

    const bankTable = () => scroll(banks.value.length ? h('table', { class: 'table' }, [
      h('thead', {}, h('tr', {}, [h('th', {}, '题库'), h('th', {}, '题目数'), h('th', {}, '删除时间'), h('th', {}, '操作')])),
      h('tbody', {}, banks.value.map(b => h('tr', {}, [
        h('td', { style: 'font-weight:540' }, [b.name, b.description ? h('div', { class: 'small muted' }, b.description) : null]),
        h('td', { class: 'small muted nowrap' }, `${b.question_count || 0} 道`),
        h('td', { class: 'small muted nowrap' }, fmtDate(b.deleted_at)),
        h('td', { class: 'nowrap' }, h('div', { class: 'flex', style: 'gap:6px' }, [
          h('button', { class: 'btn sm', onClick: () => restoreBank(b) }, '恢复'),
          h('button', { class: 'btn sm danger', onClick: () => purgeBank(b) }, '彻底删除')
        ]))
      ])))
    ]) : Empty({ text: '回收中心没有待恢复的题库' }))

    const questionTable = () => scroll(questions.value.length ? h('table', { class: 'table' }, [
      h('thead', {}, h('tr', {}, [h('th', {}, '题目'), h('th', {}, '所属题库'), h('th', {}, '分值'), h('th', {}, '删除时间'), h('th', {}, '操作')])),
      h('tbody', {}, questions.value.map(q => h('tr', {}, [
        h('td', {}, q.title),
        h('td', { class: 'small muted nowrap' }, q.bank_name || '-'),
        h('td', { class: 'small muted nowrap' }, String(q.score ?? '-')),
        h('td', { class: 'small muted nowrap' }, fmtDate(q.deleted_at)),
        h('td', { class: 'nowrap' }, h('button', { class: 'btn sm', onClick: () => restoreQuestion(q) }, '恢复'))
      ])))
    ]) : Empty({ text: '回收中心没有待恢复的题目' }))

    const body = () => {
      if (tab.value === 'form') return formTable()
      if (tab.value === 'sub') return subTable()
      if (tab.value === 'bank') return bankTable()
      return questionTable()
    }

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [h('h1', {}, '回收中心'), h('div', { class: 'sub' }, '删除的表单、答卷、题库与题目都会保留在这里，可随时恢复')])
      ]),
      tabs(),
      loading.value ? h('div', { class: 'card', style: 'padding:30px' }, '加载中…') : body()
    ])
  }
}
