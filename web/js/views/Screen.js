import { h, ref, onMounted, onBeforeUnmount, nextTick, watch } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { route, navigate } from '../router.js'
import { err } from '../ui.js'

const PALETTE = ['#38e0ff', '#7c9bff', '#b388ff', '#ffd166', '#22e0a1', '#ff7ab8']

/** 数据大屏：全屏暗色可视化，适合投屏展示 */
export default {
  setup() {
    const forms = ref([])
    const formId = ref(Number(route.value.query.formId) || 0)
    const data = ref(null)
    const charts = []
    const clock = ref('')
    /*
     * 大屏布局：指标卡选哪些、题目图选哪几道、谁排前面，都由人定。
     *
     * 上一轮的大屏是「能看的图表」——指标卡写死五个、图表固定取作答最多的前三题。
     * 可投屏的场景差别很大：周会看进度（总答卷 + 今日新增 + 趋势），
     * 培训结束看成绩（平均分 + 通过率 + 分数分布），迎检看覆盖面（题目数 + 累计作答）。
     * 同一块屏要伺候这几种场合，只能让它可拼。
     *
     * 存在 localStorage、按表单各存一份：这是个人偏好，不该进数据库，
     * 也不该让「我改了布局」影响到别人投屏。
     */
    const draft = ref(null)
    const editing = ref(false)
    const layoutKey = () => 'eqs.screen.' + formId.value
    const readLayout = () => {
      try {
        const raw = JSON.parse(localStorage.getItem(layoutKey()) || 'null')
        return raw && typeof raw === 'object' ? raw : null
      } catch { return null }
    }
    const saveLayout = () => {
      try { localStorage.setItem(layoutKey(), JSON.stringify(draft.value)) } catch {}
    }

    const tick = () => {
      const d = new Date()
      const p = n => String(n).padStart(2, '0')
      clock.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    const load = async () => {
      try {
        const r = await api.get('/api/forms?pageSize=200')
        forms.value = r.data
        if (!formId.value && forms.value.length) formId.value = (forms.value.find(f => (f.submission_count || 0) > 0) || forms.value[0]).id
        if (!formId.value) return
        const rep = await api.get(`/api/forms/${formId.value}/report`)
        data.value = rep.data
        draft.value = readLayout() || { metrics: null, charts: [] }
        await nextTick()
        render()
      } catch (e) { err(e.message) }
    }

    const render = () => {
      charts.forEach(c => c.dispose())
      charts.length = 0
      if (!window.echarts || !data.value) return
      const baseOpt = {
        backgroundColor: 'transparent',
        textStyle: { color: '#a9c2e8' },
        grid: { left: 16, right: 20, top: 28, bottom: 12, containLabel: true }
      }
      const trendEl = document.getElementById('sc-trend')
      if (trendEl) {
        const c = window.echarts.init(trendEl)
        charts.push(c)
        c.setOption({
          ...baseOpt,
          tooltip: { trigger: 'axis' },
          xAxis: { type: 'category', data: data.value.trend.map(t => t.date.slice(5)), axisLine: { lineStyle: { color: '#1d3a5f' } }, axisLabel: { color: '#7fa6d0' } },
          yAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#12304d' } }, axisLabel: { color: '#7fa6d0' } },
          series: [{
            // 只有一天数据时折线只剩一个孤立点，投屏看着像没加载出来；单点改画柱状
            ...(data.value.trend.length > 1
              ? { type: 'line', smooth: true, symbolSize: 8, lineStyle: { width: 3, color: '#38e0ff' }, itemStyle: { color: '#38e0ff' },
                  areaStyle: { color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(56,224,255,.45)' }, { offset: 1, color: 'rgba(56,224,255,0)' }]) } }
              : { type: 'bar', barMaxWidth: 36, itemStyle: { borderRadius: [6, 6, 0, 0], color: '#38e0ff' } }),
            data: data.value.trend.map(t => t.count)
          }]
        })
      }
      // 只画真的有数据的题；全零的题画出来是空心圈，不如让位给其他题
      const chartable = shownQuestions()
      chartable.forEach((q, i) => {
        const el = document.getElementById('sc-q' + i)
        if (!el) return
        const c = window.echarts.init(el)
        charts.push(c)
        /*
         * 类目多的时候圆环就成了碎屑：十来个选项各占一小块，投到会议室大屏上
         * 谁也数不清哪块是哪项。所以「饼图」只在 6 项以内成立，超过就换横向条形图——
         * 和报表页同一套判断，同一个表单在两边不会长得完全不一样。
         */
        const pieCapable = q.series.filter(x => Number(x.value) > 0).length
        const isPie = ['radio', 'select', 'checkbox', 'carousel'].includes(q.type) && pieCapable <= 6
        /*
         * 投屏用的是大字号，卡片又只有一列宽：选项名一长（组织架构取人那种
         * 「技术中心 / 后端组 / 张伟（@zhangwei）」），饼图的外部标签会一圈溢到
         * 卡片外面、两条标签互相压住，环本身被挤成一小撮。
         * 所以图上只写末级名（「张伟（@zhangwei）」），完整路径留给悬停与图例 tooltip。
         */
        /*
         * 图上的名字要短，但不能短到分不清谁是谁。
         *
         * 组织架构取人摊平后 label 是「技术中心 / 后端组 / 张伟（@zhangwei）」，
         * 直接截前 12 个字只剩「技术中心 / 后端…」——两个部门各有一个张伟时，
         * 两根柱子写着一模一样的字。所以超长时从**左边**砍：
         * 「…后端组 / 张伟（@zhangwei）」，差异全在尾部，砍头才保得住差别。
         */
        // 括号里的 @username 是给「同名消歧」用的，屏幕上换部门前缀更好读
        const noHandle = (s2) => String(s2).replace(/（@[^）]*）/g, '').replace(/\(@[^)]*\)/g, '').trim()
        const rawTails = q.series.map(x => {
          const full = String(x.full || x.name)
          const parts = full.split(' / ')
          return { full, parts, leaf: noHandle(parts[parts.length - 1]) || parts[parts.length - 1] }
        })
        /*
         * 同一题里两个「张伟」不能都写成「张伟」——那样两根柱子一模一样，
         * 图上就分不清是后端组的还是前端组的。撞名时补一级父路径。
         */
        const leafCount = new Map()
        for (const t of rawTails) leafCount.set(t.leaf, (leafCount.get(t.leaf) || 0) + 1)
        const tails = rawTails.map(t => {
          const needParent = (leafCount.get(t.leaf) || 0) > 1 && t.parts.length > 1
          const cand = needParent ? `${noHandle(t.parts[t.parts.length - 2])} / ${t.leaf}` : t.leaf
          return { full: t.full, short: cand.length > 16 ? '…' + cand.slice(-15) : cand }
        })
        const shortOf = new Map(tails.map(t => [t.full, t.short]))
        // 横向条形图：类目一多（部门/人名这类选项），竖着画标签会斜成一片黑
        const horizontal = !isPie && q.series.length > 6
        c.setOption({
          color: PALETTE,
          backgroundColor: 'transparent',
          tooltip: {
            trigger: isPie ? 'item' : 'axis',
            formatter: isPie
              ? (pt) => `${pt.data?.full || pt.name}<br/>${pt.value}（${pt.percent}%）`
              : (ps) => ps.map(pt => `${pt.data?.full || pt.name}: ${pt.value}`).join('<br/>')
          },
          legend: isPie
            ? {
                bottom: 0, type: 'scroll', textStyle: { color: '#8fb4d8', fontSize: 11 },
                // 图例也跟着截断，否则一条长路径就占满整行，后面的图例被推到看不见的地方
                formatter: (name) => (String(name).length > 14 ? String(name).slice(0, 13) + '…' : String(name))
              }
            : undefined,
          grid: isPie ? undefined : { left: 12, right: 16, top: 20, bottom: 8, containLabel: true },
          xAxis: isPie ? undefined : horizontal
            ? { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#12304d' } }, axisLabel: { color: '#7fa6d0' } }
            : {
                type: 'category', data: q.series.map(x => shortOf.get(String(x.full || x.name)) || x.name),
                axisLabel: { color: '#7fa6d0', interval: 0, width: 72, overflow: 'truncate' },
                axisLine: { lineStyle: { color: '#1d3a5f' } }
              },
          yAxis: isPie ? undefined : horizontal
            ? {
                type: 'category', inverse: true, data: q.series.map(x => shortOf.get(String(x.full || x.name)) || x.name),
                axisLabel: { color: '#7fa6d0', interval: 0, width: 118, overflow: 'truncate' },
                axisLine: { lineStyle: { color: '#1d3a5f' } }
              }
            : { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#12304d' } }, axisLabel: { color: '#7fa6d0' } },
          series: [isPie
            ? {
                type: 'pie', radius: ['40%', '62%'], center: ['50%', '45%'],
                data: q.series.filter(s2 => s2.value > 0).map((s2) => ({
                  name: shortOf.get(String(s2.full || s2.name)) || s2.name,
                  full: s2.full || s2.name,
                  value: s2.value,
                  itemStyle: { color: PALETTE[q.series.indexOf(s2) % PALETTE.length] }
                })),
                // 图上不再贴一圈名字：靠图例点名 + 悬停看数值，环才画得圆、画得大
                label: { show: false },
                labelLine: { show: false }
              }
            : {
                type: 'bar', barMaxWidth: horizontal ? 16 : 30, data: q.series.map(s => s.value),
                itemStyle: {
                  color: new window.echarts.graphic.LinearGradient(...(horizontal ? [0, 0, 1, 0] : [0, 0, 0, 1]),
                    [{ offset: 0, color: '#38e0ff' }, { offset: 1, color: 'rgba(56,224,255,.18)' }]),
                  borderRadius: horizontal ? [0, 6, 6, 0] : [6, 6, 0, 0]
                }
              }
          ]
        })
      })
    }

    // 同一页面内切换 query.formId 时组件不会重建，这里手动跟随
    watch(() => route.value.query.formId, (v) => {
      const next = Number(v) || 0
      if (next && next !== formId.value) {
        formId.value = next
        load()
      }
    })

    let timer = null
    onMounted(() => {
      tick()
      timer = setInterval(tick, 1000)
      load()
      window.addEventListener('resize', render)
    })
    onBeforeUnmount(() => {
      clearInterval(timer)
      window.removeEventListener('resize', render)
      charts.forEach(c => c.dispose())
    })

    /**
     * 所有可选指标，按 key 取。
     * 考试看分数、问卷看回收：两套指标不能混，混了会出现「问卷的平均分」这种没有意义的卡片。
     */
    const metricDefs = () => {
      const d = data.value || {}
      const trend = d.trend || []
      const today = trend.length ? trend[trend.length - 1].count : 0
      const answered = (d.questions || []).reduce((a, q) => a + (q.count || 0), 0)
      const peak = trend.reduce((a, t) => Math.max(a, t.count), 0)
      const base = {
        total: ['总答卷', d.total ?? 0],
        questions: ['题目数', d.questions?.length ?? 0],
        today: ['今日新增', today],
        peak: ['单日峰值', peak],
        answered: ['累计作答', answered]
      }
      if (d.form?.kind === 'exam') {
        return {
          total: base.total,
          avgScore: ['平均分', d.avgScore ?? '—'],
          passed: ['通过人数', d.passedCount ?? 0],
          passRate: ['通过率', (d.passRate ?? 0) + '%'],
          questions: base.questions,
          today: base.today
        }
      }
      return base
    }

    /** 没存布局时的默认：考试四项分数指标，问卷五项回收指标 */
    const defaultMetrics = () => Object.keys(metricDefs()).slice(0, data.value?.form?.kind === 'exam' ? 4 : 5)

    /** 当前生效的指标 key（过滤掉表单类型变了之后不存在的那些） */
    const activeMetrics = () => {
      const defs = metricDefs()
      const want = Array.isArray(draft.value?.metrics) && draft.value.metrics.length ? draft.value.metrics : defaultMetrics()
      const kept = want.filter(k => defs[k])
      return kept.length ? kept : defaultMetrics()
    }

    const metricCards = () => {
      const defs = metricDefs()
      return activeMetrics().map(k => defs[k])
    }

    /** 有作答数据的题，按作答人数排：默认取前三道信息量最大的 */
    const chartableQuestions = () => (data.value?.questions || [])
      .filter(q => (q.series || []).length && (q.series || []).some(s2 => Number(s2.value) > 0))
      .slice()
      .sort((a, b) => (b.count || 0) - (a.count || 0))

    /**
     * 当前要画的题：布局里选了的就按选的顺序（勾选顺序就是屏上顺序），
     * 没选过就退回默认的前三题。选中的题后来没数据了，就静默跳过，
     * 屏幕上留一块空卡片比少一张更难看。
     */
    const shownQuestions = () => {
      const all = chartableQuestions()
      const chosen = Array.isArray(draft.value?.charts) ? draft.value.charts : []
      if (!chosen.length) return all.slice(0, 3)
      const byId = new Map(all.map(q => [String(q.id), q]))
      return chosen.map(id => byId.get(String(id))).filter(Boolean).slice(0, 6)
    }

    /* ---------------- 拼装 ---------------- */
    const ensureDraft = () => {
      if (!draft.value) draft.value = { metrics: null, charts: [] }
      return draft.value
    }
    const toggleMetric = (key) => {
      const d = ensureDraft()
      const cur = activeMetrics()
      d.metrics = cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]
      // 一个指标都不留，屏幕上就只剩一堆图，等于把「拼装」做成了「拆掉」
      if (!d.metrics.length) d.metrics = cur
      saveLayout()
    }
    const toggleChart = (q) => {
      const d = ensureDraft()
      const cur = shownQuestions().map(q2 => String(q2.id))
      // 在「当前显示」的基础上加减：没动过布局的人点第一道题时，
      // 期望的是「加上这道」，而不是「只剩这道」
      const next = cur.includes(String(q.id)) ? cur.filter(id => id !== String(q.id)) : [...cur, String(q.id)]
      d.charts = next.slice(0, 6)
      saveLayout()
      nextTick().then(render)
    }
    const moveChart = (q, delta) => {
      const d = ensureDraft()
      const cur = shownQuestions().map(q2 => String(q2.id))
      const at = cur.indexOf(String(q.id))
      const to = at + delta
      if (at < 0 || to < 0 || to >= cur.length) return
      const next = [...cur]
      next.splice(at, 1)
      next.splice(to, 0, String(q.id))
      d.charts = next
      saveLayout()
      nextTick().then(render)
    }
    const resetLayout = () => {
      draft.value = { metrics: null, charts: [] }
      saveLayout()
      nextTick().then(render)
    }

    const switchForm = async (e) => {
      formId.value = Number(e.target.value)
      const rep = await api.get(`/api/forms/${formId.value}/report`)
      data.value = rep.data
      // 布局是按表单存的：换了表单，指标与图表都得换成这张表自己的那一份
      draft.value = readLayout() || { metrics: null, charts: [] }
      await nextTick()
      render()
    }

    return () => h('div', {
      style: 'min-height:100vh;background:radial-gradient(1200px 600px at 50% -10%,#123a63,#050b16 60%);color:#e8f2ff;padding:22px'
    }, [
      h('div', { class: 'flex between', style: 'margin-bottom:18px;flex-wrap:wrap;gap:10px' }, [
        h('div', { class: 'flex', style: 'gap:12px' }, [
          h('img', { src: '/assets/eqs-mark.svg', style: 'width:38px;height:38px' }),
          h('div', {}, [
            h('div', { style: 'font-size:19px;font-weight:700;letter-spacing:1px' }, 'EQS 数据可视化大屏'),
            h('div', { style: 'font-size:12px;color:#7fa6d0' }, clock.value)
          ])
        ]),
        h('div', { class: 'flex', style: 'gap:8px' }, [
          h('select', {
            class: 'select', style: 'background:#0d1e33;color:#cfe6ff;border-color:#1d3a5f;max-width:230px',
            value: formId.value, onChange: switchForm
          }, forms.value.map(f => h('option', { value: f.id }, f.title))),
          h('button', {
            class: 'btn sm' + (editing.value ? ' primary' : ''),
            style: editing.value ? '' : 'background:#12283f;border-color:#1d3a5f;color:#9fc4e8',
            onClick: () => { editing.value = !editing.value }
          }, editing.value ? '完成拼装' : '拼装'),
          h('button', {
            class: 'btn sm', style: 'background:#12283f;border-color:#1d3a5f;color:#9fc4e8',
            onClick: () => navigate('/report?formId=' + formId.value)
          }, '返回报表'),
          h('button', {
            class: 'btn sm', style: 'background:#12283f;border-color:#1d3a5f;color:#9fc4e8',
            onClick: () => navigate('/')
          }, '工作台')
        ])
      ]),
      editing.value ? h('div', {
        style: 'background:rgba(8,24,42,.8);border:1px solid #1d4d75;border-radius:14px;padding:14px;margin-bottom:16px'
      }, [
        h('div', { class: 'flex between', style: 'align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px' }, [
          h('div', { style: 'font-size:14px;color:#bcd7f0;font-weight:600' }, '拼装这块屏'),
          h('button', {
            class: 'btn sm', style: 'background:#12283f;border-color:#1d3a5f;color:#9fc4e8',
            onClick: resetLayout
          }, '恢复默认')
        ]),
        h('div', { style: 'font-size:12px;color:#7fa6d0;margin-bottom:6px' }, '指标卡（点一下开关）'),
        h('div', { class: 'flex wrap', style: 'gap:8px;margin-bottom:14px' },
          Object.entries(metricDefs()).map(([key, [label]]) => h('button', {
            class: 'btn sm' + (activeMetrics().includes(key) ? ' primary' : ''),
            style: activeMetrics().includes(key) ? '' : 'background:#0d1e33;border-color:#1d3a5f;color:#9fc4e8',
            onClick: () => toggleMetric(key)
          }, label))),
        h('div', { style: 'font-size:12px;color:#7fa6d0;margin-bottom:6px' },
          '题目图表（最多 6 张，勾选顺序就是屏上顺序；没勾过则默认取作答最多的三题）'),
        h('div', { class: 'flex wrap', style: 'gap:8px' },
          chartableQuestions().length
            ? chartableQuestions().map(q => h('button', {
                class: 'btn sm' + (shownQuestions().some(x => String(x.id) === String(q.id)) ? ' primary' : ''),
                style: shownQuestions().some(x => String(x.id) === String(q.id)) ? 'max-width:280px' : 'background:#0d1e33;border-color:#1d3a5f;color:#9fc4e8;max-width:280px',
                title: q.label,
                onClick: () => toggleChart(q)
              }, h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, q.label)))
            : h('span', { style: 'font-size:12.5px;color:#7fa6d0' }, '这张表单还没有可统计的作答数据'))
      ]) : null,
      h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:16px' }, [
        ...metricCards()
      ].map(([k, v]) => h('div', {
        style: 'background:linear-gradient(160deg,rgba(56,224,255,.1),rgba(8,24,42,.6));border:1px solid #17405f;border-radius:14px;padding:16px'
      }, [
        h('div', { style: 'font-size:12px;color:#7fa6d0;letter-spacing:.1em' }, k),
        h('div', { style: 'font-size:30px;font-weight:700;color:#8ef0ff;margin-top:6px' }, String(v))
      ]))),
      h('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:14px;margin-bottom:14px' }, [
        h('div', { style: 'background:rgba(8,24,42,.62);border:1px solid #17405f;border-radius:14px;padding:14px' }, [
          h('div', { style: 'font-size:13px;color:#8fb4d8;margin-bottom:6px' }, '提交趋势'),
          h('div', { id: 'sc-trend', style: 'height:260px' })
        ]),
        h('div', { style: 'background:rgba(8,24,42,.62);border:1px solid #17405f;border-radius:14px;padding:14px' }, [
          h('div', { style: 'font-size:13px;color:#8fb4d8;margin-bottom:6px' }, '题目概览'),
          h('div', { style: 'max-height:260px;overflow:auto' }, (data.value?.questions || []).slice(0, 8).map(q => h('div', {
            style: 'display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px dashed #14304b;font-size:12.5px'
          }, [
            h('span', { style: 'color:#bcd7f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, q.label),
            h('span', { style: 'color:#38e0ff;flex:none' }, String(q.count))
          ])))
        ])
      ]),
      h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px' },
        shownQuestions().length
          ? shownQuestions().map((q, i, list) => h('div', {
              style: 'background:rgba(8,24,42,.62);border:1px solid #17405f;border-radius:14px;padding:14px'
            }, [
              h('div', { class: 'flex between', style: 'align-items:center;margin-bottom:6px;gap:6px' }, [
                h('div', { style: 'font-size:13px;color:#8fb4d8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, q.label),
                // 排序按钮只在拼装时露出来：投屏时屏幕上不该有按钮
                editing.value ? h('div', { class: 'flex', style: 'gap:4px;flex:none' }, [
                  h('button', {
                    class: 'btn sm ghost', disabled: i === 0,
                    style: 'color:#9fc4e8;border-color:#1d3a5f;padding:2px 7px',
                    onClick: () => moveChart(q, -1)
                  }, '←'),
                  h('button', {
                    class: 'btn sm ghost', disabled: i === list.length - 1,
                    style: 'color:#9fc4e8;border-color:#1d3a5f;padding:2px 7px',
                    onClick: () => moveChart(q, 1)
                  }, '→')
                ]) : null
              ]),
              h('div', { id: 'sc-q' + i, style: 'height:240px' })
            ]))
          : h('div', {
              style: 'grid-column:1/-1;background:rgba(8,24,42,.62);border:1px solid #17405f;border-radius:14px;padding:28px;text-align:center;color:#7fa6d0;font-size:13px'
            }, '还没有可统计的作答数据，收到答卷后这里会自动出图'))
    ])
  }
}
