import { h, ref, onMounted } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { state } from '../store.js'
import { Icon } from '../icons.js'
import { navigate } from '../router.js'
import { fmtDate, Empty } from '../ui.js'

export default {
  setup() {
    const data = ref(null)
    const loading = ref(true)

    const load = async () => {
      try {
        const r = await api.get('/api/stats/overview')
        data.value = r.data
      } catch {} finally { loading.value = false }
    }
    onMounted(load)

    const statCards = () => {
      const d = data.value || {}
      return [
        { k: '表单总数', v: d.forms ?? 0, ic: 'form' },
        { k: '已发布', v: d.published ?? 0, ic: 'link' },
        { k: '答卷总数', v: d.submissions ?? 0, ic: 'data' },
        { k: '今日新增', v: d.today ?? 0, ic: 'sparkles' }
      ]
    }

    const bars = () => {
      const trend = data.value?.trend || []
      const max = Math.max(1, ...trend.map(t => t.count))
      return trend.map(t => ({ ...t, pct: Math.round(t.count / max * 100) }))
    }

    const quick = (label, desc, path, icon) => h('div', {
      class: 'card pad', style: 'cursor:pointer;transition:.18s',
      onClick: () => navigate(path),
      onMouseenter: e => e.currentTarget.style.transform = 'translateY(-2px)',
      onMouseleave: e => e.currentTarget.style.transform = ''
    }, [
      h('div', { class: 'flex', style: 'gap:10px;margin-bottom:8px' }, [
        h('div', { class: 'stat', style: 'padding:8px;border:none;background:rgba(91,124,250,.1);color:var(--brand);border-radius:10px;width:36px;height:36px;display:grid;place-items:center' }, Icon(icon, { style: 'width:18px;height:18px' })),
        h('b', {}, label)
      ]),
      h('div', { class: 'small muted' }, desc)
    ])

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [
          h('h1', {}, `你好，${state.user?.nickname || state.user?.username} 👋`),
          h('div', { class: 'sub' }, '今天也来把想法变成一份好问卷吧')
        ]),
        h('div', { class: 'flex' }, [
          h('button', { class: 'btn', onClick: () => navigate('/templates') }, '从模板开始'),
          h('button', { class: 'btn primary', onClick: () => navigate('/forms?new=1') }, [Icon('plus', { style: 'width:15px;height:15px' }), '新建表单'])
        ])
      ]),
      h('div', { class: 'grid c4 mb' }, statCards().map(s => h('div', { class: 'stat' }, [
        h('div', { class: 'k' }, s.k),
        h('div', { class: 'v' }, String(s.v)),
        h('div', { class: 'ic' }, Icon(s.ic, { style: 'width:18px;height:18px' }))
      ]))),
      h('div', { class: 'grid c3 mt2', style: 'margin-bottom:16px' }, [
        quick('创建问卷', '拖拽 27+ 组件，或让 AI 帮你写', '/forms?new=1', 'form'),
        quick('发起考试', '题库组卷、自动评分、成绩排名', '/exams', 'exam'),
        quick('模板中心', '6 套精选模板，一键套用', '/templates', 'template'),
        quick('统计分析', '实时图表，支持导出 PNG', '/report', 'chart'),
        quick('题库刷题', '顺序/随机/错题练习', '/banks', 'bank'),
        quick('系统设置', '存储、邮件、短信、AI、备份', '/settings', 'settings')
      ]),
      h('div', { class: 'grid', style: 'grid-template-columns:1.4fr 1fr' }, [
        h('div', { class: 'card' }, [
          h('div', { class: 'card-h' }, [h('h3', {}, '近 14 天答卷趋势'), h('span', { class: 'small muted' }, '共 ' + (data.value?.submissions ?? 0) + ' 份')]),
          h('div', { class: 'card-b' }, bars().length ? bars().map(b => h('div', { class: 'mb', style: 'display:grid;grid-template-columns:64px 1fr 42px;gap:10px;align-items:center' }, [
            h('span', { class: 'small muted' }, b.date.slice(5)),
            h('div', { class: 'bar-line' }, h('i', { style: `width:${b.pct}%` })),
            h('span', { class: 'small', style: 'text-align:right' }, String(b.count))
          ])) : h(Empty, { text: '还没有答卷数据' }))
        ]),
        h('div', { class: 'card' }, [
          h('div', { class: 'card-h' }, [h('h3', {}, '最近提交')]),
          h('div', { class: 'card-b', style: 'padding:8px 18px 18px' }, (data.value?.recent || []).length
            ? data.value.recent.map(r => h('div', {
                class: 'flex between', style: 'padding:9px 0;border-bottom:1px solid var(--line-2);cursor:pointer',
                onClick: () => navigate(`/data?formId=${r.form_id}`)
              }, [
                h('div', { style: 'min-width:0' }, [
                  h('div', { class: 'truncate', style: 'font-weight:540;font-size:13px' }, r.title),
                  h('div', { class: 'small muted' }, fmtDate(r.created_at))
                ]),
                h('span', { class: 'tag brand' }, `#${r.id}`)
              ]))
            : h(Empty, { text: '暂无提交' }))
        ])
      ])
    ])
  }
}
