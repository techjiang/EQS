import { h, ref, onMounted, computed } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { route, navigate } from '../router.js'
import { ok, err, Empty } from '../ui.js'
import { renderControl } from '../renderer.js'

export default {
  setup() {
    const bankId = Number(route.value.path.split('/')[2])
    const mode = ref(route.value.query.mode || 'sequence')
    const data = ref(null)
    const idx = ref(0)
    const model = ref({})
    const feedback = ref(null)
    const loading = ref(true)
    const noteOpen = ref(false)
    const noteText = ref('')
    const streakToClear = ref(Number(localStorage.getItem('eqs-streak-clear') || 0))

    const load = async () => {
      loading.value = true
      try {
        const r = await api.get(`/api/banks/${bankId}/practice?mode=${mode.value}`)
        data.value = r.data
        // 用服务端给的 resumeAt：顺序模式接着上次练，错题/收藏模式从第一题开始（进度可能已越过它们的长度）
        idx.value = Math.min(r.data.resumeAt ?? 0, Math.max(0, r.data.questions.length - 1))
        feedback.value = null
        model.value = {}
      } catch (e) { err(e.message) } finally { loading.value = false }
    }
    onMounted(load)

    const q = computed(() => data.value?.questions[idx.value] || null)

    const answered = ref({})
    const correctMap = ref({})

    const submit = async () => {
      const cur = q.value
      if (!cur) return
      try {
        const r = await api.post(`/api/banks/${bankId}/practice/answer`, {
          questionId: cur.id,
          value: model.value[cur.id],
          judge: true,
          progress: idx.value + 1,
          mode: mode.value,
          streakToClear: streakToClear.value
        })
        feedback.value = r
        answered.value = { ...answered.value, [cur.id]: true }
        correctMap.value = { ...correctMap.value, [cur.id]: r.correct === true }
      } catch (e) { err(e.message) }
    }

    const next = () => {
      if (idx.value < (data.value?.questions.length || 0) - 1) {
        idx.value++
        feedback.value = null
      } else ok('已经是最后一题了')
    }
    const prev = () => { if (idx.value > 0) { idx.value--; feedback.value = null } }

    const jump = (i) => { idx.value = i; feedback.value = null }

    const toggleFav = async () => {
      const cur = q.value
      if (!cur) return
      try {
        const r = await api.post(`/api/banks/${bankId}/practice/answer`, {
          questionId: cur.id, value: '', judge: false, favorite: !cur.favorite
        })
        cur.favorite = r.favorite
        ok(r.favorite ? '已收藏' : '已取消收藏')
      } catch (e) { err(e.message) }
    }

    const saveNote = async () => {
      const cur = q.value
      try {
        await api.post(`/api/banks/${bankId}/practice/answer`, { questionId: cur.id, value: '', judge: false, note: noteText.value })
        cur.note = noteText.value
        noteOpen.value = false
        ok('笔记已保存')
      } catch (e) { err(e.message) }
    }

    return () => {
      if (loading.value) return h('div', { style: 'padding:60px' }, '加载中…')
      if (!q.value) return h('div', { class: 'card' }, h(Empty, {
        text: mode.value === 'wrong' ? '错题集是空的：连续答对后题目会自动移出，或你还没答错过'
          : mode.value === 'favorite' ? '还没有收藏的题目，答题时点「☆ 收藏」即可加入'
            : '该模式下暂时没有题目'
      }))

      const totalCount = data.value.questions.length
      return h('div', {}, [
        h('div', { class: 'page-head' }, [
          h('div', {}, [
            h('h1', {}, data.value.bank.name),
            h('div', { class: 'sub' }, `${{ sequence: '顺序练习', random: '随机练习', wrong: '错题练习', favorite: '收藏练习' }[mode.value]} · 共 ${totalCount} 题`),
            h('div', { class: 'flex wrap', style: 'gap:6px;margin-top:10px;align-items:center' }, [
              ...['sequence', 'random', 'wrong', 'favorite'].map((v, i) => h('button', {
                class: ['btn', 'sm', mode.value === v ? 'primary' : ''],
                onClick: () => { mode.value = v; load() }
              }, ['顺序', '随机', '错题', '收藏'][i])),
              h('span', { class: 'small muted', style: 'margin-left:6px' }, '错题连续答对'),
              h('select', {
                class: 'select', style: 'height:30px;width:auto;padding:0 8px',
                value: streakToClear.value,
                onChange: e => {
                  streakToClear.value = Number(e.target.value)
                  localStorage.setItem('eqs-streak-clear', String(streakToClear.value))
                }
              }, [0, 1, 2, 3, 5].map(n => h('option', { value: n }, n ? `${n} 次后移出` : '不自动移出'))),
              h('span', { class: 'small muted' }, '(错题集)')
            ])
          ]),
          h('button', { class: 'btn', onClick: () => navigate('/banks') }, '返回题库')
        ]),
        h('div', { class: 'practice-card' }, [
          h('div', { class: 'card mb' }, [
            h('div', { class: 'card-h' }, [
              h('div', { class: 'flex', style: 'gap:8px' }, [
                h('span', { class: 'tag brand' }, `第 ${idx.value + 1} / ${totalCount} 题`),
                q.value.favorite ? h('span', { class: 'tag warn' }, '已收藏') : null,
                correctMap.value[q.value.id] === true ? h('span', { class: 'tag ok' }, '答对') : null,
                correctMap.value[q.value.id] === false ? h('span', { class: 'tag danger' }, '答错') : null
              ]),
              h('button', { class: 'btn sm ghost', onClick: toggleFav }, q.value.favorite ? '★ 取消收藏' : '☆ 收藏')
            ]),
            h('div', { class: 'card-b' }, [
              h('div', { style: 'font-weight:600;font-size:15.5px;margin-bottom:14px' }, q.value.title),
              h('div', { style: 'pointer-events:auto' }, renderControl(q.value, model.value)),
              noteOpen.value ? h('div', { class: 'mt2' }, [
                h('textarea', {
                  class: 'textarea', placeholder: '记录你的学习笔记…', value: noteText.value,
                  onInput: e => noteText.value = e.target.value
                }),
                h('div', { class: 'flex', style: 'gap:8px;margin-top:8px' }, [
                  h('button', { class: 'btn sm primary', onClick: saveNote }, '保存笔记'),
                  h('button', { class: 'btn sm', onClick: () => noteOpen.value = false }, '取消')
                ])
              ]) : null,
              feedback.value ? h('div', {
                class: 'mt2',
                style: `padding:12px 14px;border-radius:11px;background:${feedback.value.correct ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.08)'}`
              }, [
                h('div', { style: 'font-weight:600;margin-bottom:4px' }, feedback.value.correct ? '✓ 回答正确' : '✕ 回答错误'),
                h('div', { class: 'small' }, '正确答案：' + (feedback.value.answer.join(', ') || '—')),
                feedback.value.analysis ? h('div', { class: 'small muted', style: 'margin-top:4px' }, '解析：' + feedback.value.analysis) : null
              ]) : null,
              h('div', { class: 'flex between mt2' }, [
                h('div', { class: 'flex', style: 'gap:6px' }, [
                  h('button', { class: 'btn ghost sm', onClick: () => {
                    noteText.value = q.value.note || ''
                    noteOpen.value = true
                  } }, q.value.note ? '编辑笔记' : '写笔记'),
                  h('button', { class: 'btn ghost sm', onClick: next }, '跳过')
                ]),
                h('div', { class: 'flex', style: 'gap:6px' }, [
                  h('button', { class: 'btn sm', onClick: prev, disabled: idx.value === 0 }, '上一题'),
                  feedback.value
                    ? h('button', { class: 'btn sm primary', onClick: next }, '下一题')
                    : h('button', { class: 'btn sm primary', onClick: submit }, '提交答案')
                ])
              ])
            ])
          ]),
          h('div', { class: 'card' }, [
            h('div', { class: 'card-h' }, [
              h('h3', {}, '答题卡'),
              h('div', { class: 'flex small muted', style: 'gap:10px' }, [
                h('span', {}, `错题 ${data.value.wrongCount}`),
                h('span', {}, `收藏 ${data.value.favoriteCount}`)
              ])
            ]),
            h('div', { class: 'card-b' }, h('div', { class: 'answer-sheet' }, data.value.questions.map((qq, i) => h('div', {
              class: ['as-cell',
                correctMap.value[qq.id] === true ? 'ok' : '',
                correctMap.value[qq.id] === false ? 'wrong' : '',
                i === idx.value ? 'cur' : ''],
              onClick: () => jump(i)
            }, String(i + 1)))))
          ])
        ])
      ])
    }
  }
}
