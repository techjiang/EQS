import { h, ref, onMounted, computed } from '/vendor/vue.esm.js'
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

    // 第 5 位是所需权限；写 'admin' 表示只有管理员能进
    const canCreate = computed(() => {
      const p = state.user?.perms || []
      return p.includes('*') || p.includes('form:create')
    })

    const ALLOW = q => {
      const need = q[4]
      const perms = state.user?.perms || []
      if (perms.includes('*')) return true
      if (!need) return true
      return need === 'admin' ? false : perms.includes(need)
    }
    const quicks = () => [
      ['创建问卷', '拖拽 30 种组件，或让 AI 帮你写', '/forms?new=1', 'form', 'form:create'],
      ['发起考试', '题库组卷、自动评分、成绩排名', '/exams', 'exam', 'form:create'],
      ['模板中心', '6 套精选模板，一键套用', '/templates', 'template', 'form:create'],
      ['统计分析', '实时图表，支持导出 PNG', '/report', 'chart', 'report:read'],
      ['题库刷题', '顺序/随机/错题练习', '/banks', 'bank', 'bank:read'],
      ['系统设置', '存储、邮件、短信、AI、备份', '/settings', 'settings', 'admin']
    ].filter(ALLOW)

    const quick = (label, desc, path, icon) => h('div', {
      class: 'card pad', style: 'cursor:pointer;transition:.18s;min-width:260px;flex:1',
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
        canCreate.value ? h('div', { class: 'flex' }, [
          h('button', { class: 'btn', onClick: () => navigate('/templates') }, '从模板开始'),
          h('button', { class: 'btn primary', onClick: () => navigate('/forms?new=1') }, [Icon('plus', { style: 'width:15px;height:15px' }), '新建表单'])
        ]) : null
      ]),
      h('div', { class: 'grid c4 mb' }, statCards().map(s => h('div', { class: 'stat' }, [
        h('div', { class: 'k' }, s.k),
        h('div', { class: 'v' }, String(s.v)),
        h('div', { class: 'ic' }, Icon(s.ic, { style: 'width:18px;height:18px' }))
      ]))),
      // 快捷入口跟导航同一套口径：只读访客点「系统设置」「创建问卷」只会撞一堵 403 的墙。
      // 菜单都已经按权限收起，这里还留着一排「进不去的门」就自相矛盾了。
      // 权限收掉几项之后，剩一张卡孤零零占一格很难看——按数量换排布
      h('div', {
        class: quicks().length >= 3 ? 'grid c3 mt2' : 'flex wrap mt2',
        style: 'margin-bottom:16px;gap:16px'
      }, quicks().map(q => quick(q[0], q[1], q[2], q[3]))),
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
