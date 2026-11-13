import { h, ref, onMounted } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { navigate } from '../router.js'
import { ok, err, confirmBox, fmtDate, Empty, Modal } from '../ui.js'

export default {
  setup() {
    const list = ref([])
    const loading = ref(true)
    const showNew = ref(false)
    const creating = ref(false)
    const banks = ref([])
    const newExam = ref({ title: '', bankId: 0, count: 10, duration: 60, passScore: 60 })
    const aiPrompt = ref('')

    const load = async () => {
      try {
        const r = await api.get('/api/forms?kind=exam&pageSize=100')
        list.value = r.data
        const b = await api.get('/api/banks')
        banks.value = b.data
        if (!newExam.value.bankId && banks.value.length) newExam.value.bankId = banks.value[0].id
      } catch (e) { err(e.message) } finally { loading.value = false }
    }
    onMounted(load)

    const publish = async (f) => {
      try {
        await api.put(`/api/forms/${f.id}`, { status: f.status === 'published' ? 'draft' : 'published' })
        ok(f.status === 'published' ? '已暂停' : '已发布')
        load()
      } catch (e) { err(e.message) }
    }

    const copyLink = (f) => {
      const url = `${location.origin}/f/${f.id}`
      navigator.clipboard.writeText(url).then(() => ok('考试链接已复制')).catch(() => prompt('复制链接', url))
    }

    const createFromBank = async () => {
      if (!newExam.value.bankId) return err('请先创建题库')
      creating.value = true
      try {
        const r = await api.post(`/api/banks/${newExam.value.bankId}/paper`, {
          title: newExam.value.title || '新建考试', count: newExam.value.count, duration: newExam.value.duration
        })
        await api.put(`/api/forms/${r.id}`, { status: 'published', settings: { passScore: newExam.value.passScore, duration: newExam.value.duration } })
        ok(`已生成 ${r.count} 题并发布`)
        showNew.value = false
        navigate(`/forms/${r.id}/design`)
      } catch (e) { err(e.message) } finally { creating.value = false }
    }

    const createByAi = async () => {
      if (!aiPrompt.value.trim()) return err('请描述考试内容')
      creating.value = true
      try {
        const r = await api.post('/api/ai/generate', { prompt: aiPrompt.value, kind: 'exam' })
        const f = await api.post('/api/forms', {
          title: r.data.title || 'AI 生成考试', description: r.data.description, kind: 'exam', schema: r.data.schema, status: 'draft'
        })
        showNew.value = false
        ok('已生成，请检查题目后发布')
        navigate(`/forms/${f.id}/design`)
      } catch (e) { err(e.message) } finally { creating.value = false }
    }

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [h('h1', {}, '在线考试'), h('div', { class: 'sub' }, '题库组卷、自动评分、成绩统计与排名')]),
        h('div', { class: 'flex' }, [
          h('button', { class: 'btn', onClick: () => navigate('/banks') }, '管理题库'),
          h('button', { class: 'btn primary', onClick: () => showNew.value = true }, '+ 新建考试')
        ])
      ]),
      loading.value ? h('div', { class: 'card skeleton', style: 'height:200px' })
        : list.value.length ? h('div', { class: 'grid c3' }, list.value.map(f => h('div', { class: 'card pad' }, [
            h('div', { class: 'flex between', style: 'margin-bottom:8px' }, [
              h('b', { style: 'font-size:15px' }, f.title),
              h('span', { class: ['tag', f.status === 'published' ? 'ok' : 'warn'] }, f.status === 'published' ? '进行中' : '草稿')
            ]),
            h('div', { class: 'small muted', style: 'margin-bottom:10px' }, [
              `${f.schema.filter(x => x.score > 0).length} 道计分题`,
              f.settings?.duration ? ` · ${f.settings.duration} 分钟` : '',
              ` · ${f.submission_count || 0} 人参加`
            ].join('')),
            h('div', { class: 'small muted', style: 'margin-bottom:12px' }, '更新于 ' + fmtDate(f.updated_at)),
            h('div', { class: 'flex wrap', style: 'gap:6px' }, [
              h('button', { class: 'btn sm', onClick: () => navigate(`/forms/${f.id}/design`) }, '编辑'),
              h('button', { class: 'btn sm', onClick: () => publish(f) }, f.status === 'published' ? '暂停' : '发布'),
              h('button', { class: 'btn sm', onClick: () => copyLink(f) }, '链接'),
              h('button', { class: 'btn sm', onClick: () => navigate(`/data?formId=${f.id}`) }, '成绩'),
              h('button', { class: 'btn sm', onClick: () => navigate(`/report?formId=${f.id}`) }, '统计')
            ])
          ])))
        : h('div', { class: 'card' }, h(Empty, { text: '还没有考试，从题库组卷或让 AI 生成一份' })),

      showNew.value ? Modal({
        title: '新建考试', modelValue: true, onClose: () => showNew.value = false, wide: true,
        children: [
          h('div', { class: 'field' }, [h('label', {}, '考试名称'), h('input', {
            class: 'input', value: newExam.value.title, placeholder: '例如：2025 年度安全知识考核',
            onInput: e => newExam.value.title = e.target.value
          })]),
          h('div', { class: 'field' }, [h('label', {}, '从题库组卷'), h('select', {
            class: 'select', value: newExam.value.bankId, onChange: e => newExam.value.bankId = Number(e.target.value)
          }, banks.value.length ? banks.value.map(b => h('option', { value: b.id }, `${b.name}（${b.question_count} 题）`)) : [h('option', { value: 0 }, '暂无题库，请先创建')])]),
          h('div', { class: 'row' }, [
            h('div', { class: 'field' }, [h('label', {}, '抽题数量'), h('input', {
              class: 'input', type: 'number', value: newExam.value.count, onInput: e => newExam.value.count = Number(e.target.value)
            })]),
            h('div', { class: 'field' }, [h('label', {}, '时长（分钟）'), h('input', {
              class: 'input', type: 'number', value: newExam.value.duration, onInput: e => newExam.value.duration = Number(e.target.value)
            })]),
            h('div', { class: 'field' }, [h('label', {}, '及格分'), h('input', {
              class: 'input', type: 'number', value: newExam.value.passScore, onInput: e => newExam.value.passScore = Number(e.target.value)
            })])
          ]),
          h('div', { style: 'border-top:1px solid var(--line);margin:8px 0 14px' }),
          h('div', { class: 'field' }, [h('label', {}, '或让 AI 生成'), h('textarea', {
            class: 'textarea', style: 'min-height:70px', placeholder: '例如：生成一份关于信息安全基础的 5 道单选题考试，含答案解析',
            value: aiPrompt.value, onInput: e => aiPrompt.value = e.target.value
          })])
        ],
        footer: [
          h('button', { class: 'btn', onClick: () => showNew.value = false }, '取消'),
          h('button', { class: 'btn', onClick: createByAi, disabled: creating.value }, 'AI 生成'),
          h('button', { class: 'btn primary', onClick: createFromBank, disabled: creating.value }, '题库组卷')
        ]
      }) : null
    ])
  }
}
