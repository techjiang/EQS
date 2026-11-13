import { h, ref, onMounted } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { navigate } from '../router.js'
import { ok, err, confirmBox, Empty, Modal, promptBox, fmtDate } from '../ui.js'
import { renderControl } from '../renderer.js'
import { blankField, fieldMeta } from '../fields.js'

export default {
  setup() {
    const banks = ref([])
    const active = ref(null)
    const questions = ref([])
    const loading = ref(true)
    const showNew = ref(false)
    const newBank = ref({ name: '', description: '' })
    const importOpen = ref(false)
    const importText = ref('')
    const editQ = ref(null)
    const paperOpen = ref(false)
    const paper = ref({ title: '', count: 10, duration: 60 })

    const load = async () => {
      try {
        const r = await api.get('/api/banks')
        banks.value = r.data
        if (!active.value && banks.value.length) select(banks.value[0])
      } catch (e) { err(e.message) } finally { loading.value = false }
    }

    const select = async (b) => {
      active.value = b
      const r = await api.get(`/api/banks/${b.id}/questions`)
      questions.value = r.data
    }

    onMounted(load)

    const createBank = async () => {
      if (!newBank.value.name.trim()) return err('请填写题库名称')
      try {
        const r = await api.post('/api/banks', newBank.value)
        showNew.value = false
        newBank.value = { name: '', description: '' }
        ok('题库已创建')
        await load()
        const b = banks.value.find(x => x.id === r.id)
        if (b) select(b)
      } catch (e) { err(e.message) }
    }

    const delBank = async (b) => {
      if (!await confirmBox(`删除题库「${b.name}」？`)) return
      try { await api.del(`/api/banks/${b.id}`); ok('已删除'); active.value = null; questions.value = []; load() } catch (e) { err(e.message) }
    }

    const addQuestion = () => { editQ.value = blankField('radio') }

    const saveQuestion = async () => {
      try {
        const payload = { ...editQ.value, title: editQ.value.label, items: [{ ...editQ.value, title: editQ.value.label }] }
        if (editQ.value.id && !String(editQ.value.id).startsWith('f_')) await api.put(`/api/questions/${editQ.value.id}`, { ...editQ.value, title: editQ.value.label })
        else await api.post(`/api/banks/${active.value.id}/questions`, { ...editQ.value, title: editQ.value.label })
        ok('题目已保存')
        editQ.value = null
        select(active.value)
        load()
      } catch (e) { err(e.message) }
    }

    const delQuestion = async (q) => {
      if (!await confirmBox('删除这道题？')) return
      try { await api.del(`/api/questions/${q.id}`); select(active.value); load() } catch (e) { err(e.message) }
    }

    const doImport = async () => {
      try {
        const r = await api.post(`/api/banks/${active.value.id}/import-text`, { text: importText.value })
        ok(`已导入 ${r.imported} 道题`)
        importOpen.value = false
        importText.value = ''
        select(active.value)
        load()
      } catch (e) { err(e.message) }
    }

    const makePaper = async () => {
      try {
        const r = await api.post(`/api/banks/${active.value.id}/paper`, paper.value)
        ok(`组卷成功，共 ${r.count} 题`)
        paperOpen.value = false
        navigate(`/forms/${r.id}/design`)
      } catch (e) { err(e.message) }
    }

    const practice = async (mode) => {
      try {
        await api.get(`/api/banks/${active.value.id}/practice?mode=${mode}`)
        navigate(`/banks/${active.value.id}/practice?mode=${mode}`)
      } catch (e) { err(e.message) }
    }

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [h('h1', {}, '题库与刷题'), h('div', { class: 'sub' }, '统一题库，可供考试组卷与刷题练习复用')]),
        h('button', { class: 'btn primary', onClick: () => showNew.value = true }, '+ 新建题库')
      ]),
      h('div', { class: 'grid', style: 'grid-template-columns:260px 1fr;align-items:start' }, [
        h('div', { class: 'card', style: 'overflow:hidden' }, [
          h('div', { class: 'card-h' }, [h('h3', {}, '题库列表'), h('span', { class: 'small muted' }, banks.value.length + ' 个')]),
          h('div', { style: 'padding:8px' }, banks.value.length
            ? banks.value.map(b => h('div', {
                class: ['nav-item', active.value?.id === b.id ? 'active' : ''],
                style: 'justify-content:space-between',
                onClick: () => select(b)
              }, [
                h('div', { style: 'min-width:0' }, [
                  h('div', { class: 'truncate' }, b.name),
                  h('div', { class: 'small muted' }, `${b.question_count} 题`)
                ]),
                h('button', { class: 'btn ghost sm', onClick: e => { e.stopPropagation(); delBank(b) } }, '×')
              ]))
            : h(Empty, { text: '还没有题库' }))
        ]),
        h('div', {}, active.value ? [
          h('div', { class: 'card mb' }, [
            h('div', { class: 'card-h' }, [
              h('div', {}, [
                h('h3', {}, active.value.name),
                h('div', { class: 'small muted' }, active.value.description || '暂无描述')
              ]),
              h('div', { class: 'flex wrap', style: 'gap:6px' }, [
                h('button', { class: 'btn sm', onClick: () => importOpen.value = true }, '文本导入'),
                h('button', { class: 'btn sm', onClick: addQuestion }, '+ 添加题目'),
                h('button', { class: 'btn sm', onClick: () => paperOpen.value = true }, '智能组卷'),
                h('button', { class: 'btn sm primary', onClick: () => practice('sequence') }, '开始刷题')
              ])
            ]),
            h('div', { class: 'card-b', style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
              h('button', { class: 'btn sm', onClick: () => practice('sequence') }, '顺序练习'),
              h('button', { class: 'btn sm', onClick: () => practice('random') }, '随机练习'),
              h('button', { class: 'btn sm', onClick: () => practice('wrong') }, '错题练习'),
              h('button', { class: 'btn sm', onClick: () => practice('favorite') }, '收藏题目')
            ])
          ]),
          h('div', { class: 'card', style: 'overflow:hidden' }, [
            h('div', { class: 'card-h' }, [h('h3', {}, `题目 (${questions.value.length})`)]),
            questions.value.length ? h('div', { style: 'padding:8px 16px 16px' }, questions.value.map((q, i) => h('div', {
              style: 'padding:12px 0;border-bottom:1px solid var(--line-2)'
            }, [
              h('div', { class: 'flex between', style: 'align-items:flex-start;gap:10px' }, [
                h('div', { style: 'flex:1;min-width:0' }, [
                  h('div', { style: 'font-weight:540;margin-bottom:4px' }, `${i + 1}. ${q.title}`),
                  h('div', { class: 'small muted' }, [
                    fieldMeta(q.type).label,
                    q.options.length ? ` · ${q.options.length} 个选项` : '',
                    q.answer.length ? ` · 答案：${q.answer.join(',')}` : '',
                    ` · ${q.score} 分`
                  ])
                ]),
                h('div', { class: 'flex', style: 'gap:4px' }, [
                  h('button', { class: 'btn ghost sm', onClick: () => editQ.value = { ...q, label: q.title } }, '编辑'),
                  h('button', { class: 'btn ghost sm danger', onClick: () => delQuestion(q) }, '删除')
                ])
              ])
            ]))) : h(Empty, { text: '题库还没有题目，试试文本导入或手动添加' })
          ])
        ] : h('div', { class: 'card' }, h(Empty, { text: '请选择或新建一个题库' })))
      ]),

      showNew.value ? Modal({
        title: '新建题库', modelValue: true, onClose: () => showNew.value = false,
        children: [
          h('div', { class: 'field' }, [h('label', {}, '题库名称'), h('input', {
            class: 'input', value: newBank.value.name, onInput: e => newBank.value.name = e.target.value, placeholder: '例如：计算机基础'
          })]),
          h('div', { class: 'field' }, [h('label', {}, '描述'), h('textarea', {
            class: 'textarea', style: 'min-height:70px', value: newBank.value.description,
            onInput: e => newBank.value.description = e.target.value
          })])
        ],
        footer: [h('button', { class: 'btn', onClick: () => showNew.value = false }, '取消'), h('button', { class: 'btn primary', onClick: createBank }, '创建')]
      }) : null,

      importOpen.value ? Modal({
        title: '文本批量导入题目', modelValue: true, onClose: () => importOpen.value = false, wide: true,
        children: [
          h('div', { class: 'hint mb' }, '格式：每题以「1.」开头，方括号写题型，选项以「A.」开头，可写「答案：A」「分值：5」「解析：…」。'),
          h('textarea', {
            class: 'textarea mono', style: 'min-height:260px', value: importText.value,
            placeholder: '1. 下列哪个是关系型数据库？ [单选]\nA. Redis\nB. MySQL\nC. MongoDB\n答案：B\n分值：5\n解析：MySQL 是关系型数据库。',
            onInput: e => importText.value = e.target.value
          })
        ],
        footer: [h('button', { class: 'btn', onClick: () => importOpen.value = false }, '取消'), h('button', { class: 'btn primary', onClick: doImport }, '导入')]
      }) : null,

      paperOpen.value ? Modal({
        title: '智能组卷', modelValue: true, onClose: () => paperOpen.value = false,
        children: [
          h('div', { class: 'field' }, [h('label', {}, '试卷标题'), h('input', {
            class: 'input', value: paper.value.title || active.value?.name + ' - 试卷',
            onInput: e => paper.value.title = e.target.value
          })]),
          h('div', { class: 'row' }, [
            h('div', { class: 'field' }, [h('label', {}, '抽题数量'), h('input', {
              class: 'input', type: 'number', value: paper.value.count, onInput: e => paper.value.count = Number(e.target.value)
            })]),
            h('div', { class: 'field' }, [h('label', {}, '考试时长（分钟）'), h('input', {
              class: 'input', type: 'number', value: paper.value.duration, onInput: e => paper.value.duration = Number(e.target.value)
            })])
          ])
        ],
        footer: [h('button', { class: 'btn', onClick: () => paperOpen.value = false }, '取消'), h('button', { class: 'btn primary', onClick: makePaper }, '生成试卷')]
      }) : null,

      editQ.value ? Modal({
        title: editQ.value.id && !String(editQ.value.id).startsWith('f_') ? '编辑题目' : '添加题目',
        modelValue: true, onClose: () => editQ.value = null, wide: true,
        children: [
          h('div', { class: 'field' }, [h('label', {}, '题干'), h('textarea', {
            class: 'textarea', style: 'min-height:64px', value: editQ.value.label, onInput: e => editQ.value.label = e.target.value
          })]),
          h('div', { class: 'row' }, [
            h('div', { class: 'field' }, [h('label', {}, '题型'), h('select', {
              class: 'select', value: editQ.value.type,
              onChange: e => {
                const t = e.target.value
                const base = blankField(t)
                editQ.value = { ...base, id: editQ.value.id, label: editQ.value.label, score: editQ.value.score, answer: [] }
              }
            }, ['radio', 'checkbox', 'text', 'textarea', 'select'].map(t => h('option', { value: t }, fieldMeta(t).label)))]),
            h('div', { class: 'field' }, [h('label', {}, '分值'), h('input', {
              class: 'input', type: 'number', value: editQ.value.score, onInput: e => editQ.value.score = Number(e.target.value)
            })])
          ]),
          editQ.value.options.length ? h('div', { class: 'field' }, [
            h('label', { class: 'flex between' }, [
              h('span', {}, '选项'),
              h('button', { class: 'btn ghost sm', onClick: () => editQ.value.options.push({ label: `选项 ${editQ.value.options.length + 1}`, value: `选项 ${editQ.value.options.length + 1}` }) }, '+ 添加')
            ]),
            editQ.value.options.map((o, i) => h('div', { class: 'opt-row' }, [
              h('input', { class: 'input', value: o.label, onInput: e => { o.label = e.target.value; o.value = e.target.value } }),
              h('button', { onClick: () => editQ.value.options.splice(i, 1) }, '×')
            ]))
          ]) : null,
          editQ.value.options.length ? h('div', { class: 'field' }, [
            h('label', {}, '正确答案（逗号分隔）'),
            h('input', {
              class: 'input', value: (editQ.value.answer || []).join(','),
              onInput: e => editQ.value.answer = e.target.value.split(',').map(s => s.trim()).filter(Boolean)
            })
          ]) : null,
          h('div', { class: 'field' }, [h('label', {}, '答案解析'), h('textarea', {
            class: 'textarea', style: 'min-height:60px', value: editQ.value.analysis, onInput: e => editQ.value.analysis = e.target.value
          })])
        ],
        footer: [h('button', { class: 'btn', onClick: () => editQ.value = null }, '取消'), h('button', { class: 'btn primary', onClick: saveQuestion }, '保存')]
      }) : null
    ])
  }
}
