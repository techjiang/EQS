import { h, ref, onMounted, onBeforeUnmount, nextTick } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { route } from '../router.js'
import { ok, err, Empty, fmtDate } from '../ui.js'
import { Icon } from '../icons.js'

const PALETTE = ['#5b7cfa', '#8b5bfa', '#22d3ee', '#f59e0b', '#10b981', '#f472b6', '#a78bfa', '#34d399']

export default {
  setup() {
    const forms = ref([])
    const formId = ref(Number(route.value.query.formId) || 0)
    const data = ref(null)
    const loading = ref(true)
    const chartType = ref('bar')
    const charts = []
    const ranking = ref(null)
    const rankLimit = ref(20)

    const loadForms = async () => {
      const r = await api.get('/api/forms?pageSize=200')
      forms.value = r.data
      if (!formId.value && forms.value.length) formId.value = (forms.value.find(f => (f.submission_count || 0) > 0) || forms.value[0]).id
    }

    const load = async () => {
      if (!formId.value) { loading.value = false; return }
      loading.value = true
      try {
        const r = await api.get(`/api/forms/${formId.value}/report`)
        data.value = r.data
        // 排名是考试才有的东西；问卷的「分数」只有人工分，排出来没有意义
        ranking.value = r.data.form?.kind === 'exam'
          ? await api.get(`/api/forms/${formId.value}/ranking?limit=${rankLimit.value}`).then(x => x.data).catch(() => null)
          : null
      } catch (e) { err(e.message) } finally {
        loading.value = false
        await nextTick()
        renderCharts()
      }
    }

    const renderCharts = () => {
      charts.forEach(c => c.dispose())
      charts.length = 0
      if (!window.echarts || !data.value) return
      const dark = document.documentElement.dataset.theme === 'dark'
      const axisColor = dark ? '#7c85a0' : '#8b93ad'
      const splitColor = dark ? '#242c46' : '#eef1f8'
      for (const q of data.value.questions) {
        if (!q.series?.length) continue
        const el = document.getElementById('chart_' + q.id)
        if (!el) continue
        // 横向条形图的高度得跟着类目数长：固定 280px 时十几项会挤成一条条线
        const rowCount = q.series.length
        const wantHorizontal = chartType.value === 'bar' && rowCount > 7
        el.style.height = wantHorizontal ? Math.max(260, rowCount * 26 + 44) + 'px' : '280px'
        const chart = window.echarts.init(el, null, { renderer: 'canvas' })
        charts.push(chart)
        // 级联这类「完整路径很长」的题，图上用短名，悬停给全路径
        const names = q.series.map(s => s.name)
        const fullNames = q.series.map(s => s.full || s.name)
        const values = q.series.map(s => s.value)
        const isPie = ['radio', 'select', 'carousel', 'checkbox'].includes(q.type) && q.series.length <= 8
        const hasData = q.series.some(s2 => Number(s2.value) > 0)
        /*
         * 类目一多，竖着画就没法看了：级联题（末级选项十几二十个）在卡片宽度里
         * 标签只能斜到 38 度，然后互相压成一团黑——「企业管」和「数据」叠在一起，
         * 谁也不知道哪根柱子是哪一项。类目多时换成横向条形图，
         * 标签横着写、从左边留出宽度，一眼就能读完。
         */
        const horizontal = chartType.value === 'bar' && names.length > 7
        // 全零时饼图画出来是空白，退回柱状图让人看出「这一题还没人选」
        const type = chartType.value === 'pie' && isPie && hasData ? 'pie' : chartType.value === 'line' ? 'line' : 'bar'
        const opt = type === 'pie'
          ? {
              color: PALETTE,
              tooltip: { trigger: 'item', formatter: (p) => `${p.name}: ${p.value} (${p.percent}%)` },
              legend: { bottom: 0, textStyle: { color: axisColor, fontSize: 11 } },
              series: [{
                type: 'pie', radius: ['42%', '68%'], center: ['50%', '44%'],
                data: q.series.filter(s2 => s2.value > 0).map(s2 => ({ name: s2.name, value: s2.value, full: s2.full || s2.name, itemStyle: { color: PALETTE[q.series.indexOf(s2) % PALETTE.length] } })),
                label: { color: axisColor, fontSize: 11 }
              }]
            }
          : horizontal
          ? {
              color: [PALETTE[0]],
              // 横向条形图的类目轴在 y 上，标签横着写不用旋：高度随类目数长，
              // 每项至少 22px，否则十几项挤在 200px 里等于没画
              grid: { left: 8, right: 28, top: 12, bottom: 8, containLabel: true },
              tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps) => ps.map(p => `${fullNames[p.dataIndex] ?? p.name}: ${p.value}`).join('<br/>') },
              xAxis: { type: 'value', minInterval: 1, axisLabel: { color: axisColor, fontSize: 11 }, splitLine: { lineStyle: { color: splitColor } } },
              yAxis: {
                type: 'category', data: names, inverse: true,
                axisLabel: { color: axisColor, fontSize: 11, interval: 0, width: 96, overflow: 'truncate' },
                axisLine: { lineStyle: { color: splitColor } }
              },
              series: [{
                type: 'bar', data: values, barMaxWidth: 16,
                itemStyle: { borderRadius: [0, 6, 6, 0], color: PALETTE[0] }
              }]
            }
          : {
              color: [PALETTE[0]],
              grid: { left: 12, right: 20, top: 24, bottom: 8, containLabel: true },
              tooltip: { trigger: 'axis', formatter: (ps) => ps.map(p => `${fullNames[p.dataIndex] ?? p.name}: ${p.value}`).join('<br/>') },
              xAxis: {
                type: 'category', data: names,
                // 长标签（级联的「杭州市·西湖区」、选项很长的单选题）斜着放，
                // 并给足底部留白：只改 rotate 的话首个标签会被裁掉左半截
                axisLabel: {
                  color: axisColor, fontSize: 11, interval: 0,
                  rotate: names.some(n => String(n).length > 6) ? 38 : 0
                },
                axisLine: { lineStyle: { color: splitColor } }
              },
              yAxis: { type: 'value', minInterval: 1, axisLabel: { color: axisColor, fontSize: 11 }, splitLine: { lineStyle: { color: splitColor } } },
              series: [{
                type, data: values, smooth: true, barMaxWidth: 34,
                itemStyle: type === 'bar' ? { borderRadius: [6, 6, 0, 0], color: PALETTE[0] } : { color: PALETTE[1] },
                areaStyle: type === 'line' ? { opacity: .12 } : undefined
              }]
            }
        chart.setOption(opt)
      }
      // 分数分布：排名不给参照系，分档才看得出「90 分在这里算不算好」
      const distEl = document.getElementById('rank_dist')
      if (distEl && ranking.value?.distribution?.buckets?.length) {
        const chart = window.echarts.init(distEl)
        charts.push(chart)
        const b = ranking.value.distribution.buckets
        chart.setOption({
          color: [PALETTE[2]],
          grid: { left: 12, right: 16, top: 24, bottom: 8, containLabel: true },
          tooltip: { trigger: 'axis' },
          xAxis: { type: 'category', data: b.map(x => `${x.from}`), axisLabel: { color: axisColor, fontSize: 11 }, axisLine: { lineStyle: { color: splitColor } } },
          yAxis: { type: 'value', minInterval: 1, axisLabel: { color: axisColor, fontSize: 11 }, splitLine: { lineStyle: { color: splitColor } } },
          series: [{ type: 'bar', data: b.map(x => x.count), barMaxWidth: 30, itemStyle: { borderRadius: [6, 6, 0, 0], color: PALETTE[2] } }]
        })
      }
      // 趋势图
      const trendEl = document.getElementById('trend_chart')
      if (trendEl && data.value.trend?.length) {
        const chart = window.echarts.init(trendEl)
        charts.push(chart)
        chart.setOption({
          color: [PALETTE[0]],
          grid: { left: 12, right: 16, top: 20, bottom: 8, containLabel: true },
          tooltip: { trigger: 'axis' },
          xAxis: { type: 'category', data: data.value.trend.map(t => t.date.slice(5)), axisLabel: { color: axisColor, fontSize: 11 }, axisLine: { lineStyle: { color: splitColor } } },
          yAxis: { type: 'value', minInterval: 1, axisLabel: { color: axisColor, fontSize: 11 }, splitLine: { lineStyle: { color: splitColor } } },
          series: [{
            type: 'line', smooth: true, areaStyle: { opacity: .14 }, lineStyle: { width: 2.5 },
            // 只有一天的数据画折线只能得到一个孤立圆点，看起来像加载失败；改成柱状至少读得出「今天 N 份」
            ...(data.value.trend.length > 1
              ? { data: data.value.trend.map(t => t.count), symbolSize: 7 }
              : { type: 'bar', barMaxWidth: 42, data: data.value.trend.map(t => t.count), itemStyle: { borderRadius: [6, 6, 0, 0] } })
          }]
        })
      }
    }

    const exportPng = (id) => {
      const el = document.getElementById(id)
      const chart = charts.find(c => c.getDom() === el)
      if (!chart) return err('图表未渲染完成')
      const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: document.documentElement.dataset.theme === 'dark' ? '#151a2e' : '#fff' })
      const a = document.createElement('a')
      a.href = url
      a.download = `chart-${id}.png`
      a.click()
      ok('已导出 PNG')
    }

    const changeType = (t) => { chartType.value = t; renderCharts() }

    onMounted(async () => {
      await loadForms()
      await load()
      window.addEventListener('resize', renderCharts)
    })
    onBeforeUnmount(() => {
      window.removeEventListener('resize', renderCharts)
      charts.forEach(c => c.dispose())
    })

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [h('h1', {}, '统计分析'), h('div', { class: 'sub' }, '实时统计每题分布，可切换柱状 / 折线 / 饼图并导出 PNG')]),
        h('div', { class: 'flex', style: 'gap:6px' }, [
          ['bar', '柱状图'], ['line', '折线图'], ['pie', '饼图']
        ].map(([v, l]) => h('button', { class: ['btn', 'sm', chartType.value === v ? 'primary' : ''], onClick: () => changeType(v) }, l)))
      ]),
      h('div', { class: 'card pad mb', style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center' }, [
        h('select', {
          class: 'select', style: 'max-width:300px', value: formId.value,
          onChange: e => { formId.value = Number(e.target.value); load() }
        }, forms.value.map(f => h('option', { value: f.id }, f.title))),
        h('div', { style: 'flex:1' }),
        data.value ? h('div', { class: 'flex', style: 'gap:10px' }, [
          h('span', { class: 'tag brand' }, `总答卷 ${data.value.total}`),
          data.value.avgScore != null ? h('span', { class: 'tag ok' }, `平均分 ${data.value.avgScore}`) : null
        ]) : null
      ]),
      loading.value ? h('div', { class: 'skeleton', style: 'height:300px' })
        : !data.value?.total ? h('div', { class: 'card' }, h(Empty, { text: '还没有答卷数据，发布表单后即可看到统计' }))
        : h('div', {}, [
            h('div', { class: 'card mb' }, [
              h('div', { class: 'card-h' }, [h('h3', {}, '提交趋势'), h('button', { class: 'btn sm ghost', onClick: () => exportPng('trend_chart') }, [Icon('download', { style: 'width:13px;height:13px' }), 'PNG'])]),
              h('div', { id: 'trend_chart', class: 'chart', style: 'height:220px;padding:8px' })
            ]),
            ranking.value ? h('div', { class: 'card mb' }, [
              h('div', { class: 'card-h' }, [
                h('div', {}, [
                  h('h3', {}, '成绩排名'),
                  h('div', { class: 'small muted' }, `共 ${ranking.value.total} 份有成绩的答卷 · 同分同名次、下一名跳号 · 前 ${ranking.value.top.length} 名${ranking.value.top.some(r => r.pending) ? ' · 带「待批」的卷子主观题还没批完，及格线按当前可判分总分算' : ''}`)
                ]),
                h('select', {
                  class: 'select', style: 'height:30px;width:auto;padding:0 8px', value: rankLimit.value,
                  onChange: async e => {
                    rankLimit.value = Number(e.target.value)
                    ranking.value = await api.get(`/api/forms/${formId.value}/ranking?limit=${rankLimit.value}`).then(x => x.data).catch(() => null)
                    await nextTick(); renderCharts()
                  }
                }, [10, 20, 50, 100].map(n => h('option', { value: n }, `前 ${n} 名`)))
              ]),
              ranking.value.top.length ? h('div', { style: 'overflow-x:auto' }, h('table', { class: 'table' }, [
                h('thead', {}, h('tr', {}, ['名次', '考生', '得分', '是否通过', '提交时间'].map(t => h('th', {}, t)))),
                h('tbody', {}, ranking.value.top.map(r => h('tr', {}, [
                  h('td', {}, h('span', {
                    class: ['tag', r.rank === 1 ? 'warn' : r.rank <= 3 ? 'brand' : ''],
                    style: 'font-variant-numeric:tabular-nums'
                  }, String(r.rank))),
                  h('td', {}, r.name || '匿名考生'),
                  h('td', {}, h('b', {}, String(r.score))),
                  // 待批阅的卷子可判分总分更低、及格线也低，所以「50 分通过、48 分未通过」不是判错
                  h('td', {}, h('div', { class: 'flex', style: 'gap:5px' }, [
                    h('span', { class: ['tag', r.passed ? 'ok' : 'danger'] }, r.passed ? '通过' : '未通过'),
                    r.pending ? h('span', { class: 'tag warn', title: '主观题未批完，及格线按当前可判分总分算' }, `待批 ${r.pending}`) : null
                  ])),
                  h('td', { class: 'small muted' }, fmtDate(r.createdAt))
                ])))
              ])) : h('div', { class: 'card-b muted small' }, '还没有可排名的成绩：需要考试类表单，且答卷已被判分')
            ]) : null,
            ranking.value?.distribution?.buckets?.length ? h('div', { class: 'card mb' }, [
              h('div', { class: 'card-h' }, [h('h3', {}, '分数分布'), h('span', { class: 'small muted' }, '排名本身不说明水平，分布才说明')]),
              h('div', { id: 'rank_dist', class: 'chart', style: 'height:200px' })
            ]) : null,
            h('div', { class: 'grid c2' }, data.value.questions.map(q => h('div', { class: 'card' }, [
              h('div', { class: 'card-h' }, [
                h('div', { style: 'min-width:0' }, [
                  h('h3', { class: 'truncate' }, q.label),
                  h('div', { class: 'small muted' }, `${q.count} 人作答${q.average != null && q.average !== 0 ? ` · 平均 ${q.average}` : ''}${q.note ? ` · ${q.note}` : ''}`)
                ]),
                h('button', { class: 'btn sm ghost', onClick: () => exportPng('chart_' + q.id) }, 'PNG')
              ]),
              q.series?.length
                ? h('div', { id: 'chart_' + q.id, class: 'chart' })
                // 数字 / 滑块这类没有「选项分布」的题，只有均值与范围可看：
                // 以前直接落到「暂无作答」，明明库里 13 份都填了数字
                : q.average != null && q.count
                  ? h('div', { class: 'card-b' }, [
                      h('div', { class: 'flex between', style: 'align-items:baseline' }, [
                        h('b', { style: 'font-size:26px;font-variant-numeric:tabular-nums' }, String(q.average)),
                        h('span', { class: 'small muted' }, '平均值')
                      ]),
                      h('div', { class: 'small muted', style: 'margin-top:6px' },
                        `范围 ${q.min ?? '-'} ~ ${q.max ?? '-'} · ${q.count} 份作答`)
                    ])
                  : h('div', { class: 'card-b' }, q.samples?.length
                      ? [
                          // 同一句话被多个人说到时给出次数：只列原文的话，
                          // 「希望需求变更少一点」重复四遍就把别的说法挤出屏幕了
                          q.distinct > 1
                            ? h('div', { class: 'small muted', style: 'margin-bottom:6px' },
                                `${q.count} 份作答，${q.distinct} 种说法${q.distinct < q.count ? '（按出现次数排）' : ''}`)
                            : null,
                          ...q.samples.map((s, i) => h('div', {
                            class: 'flex between small',
                            style: 'gap:10px;padding:6px 10px;background:var(--panel-2);border-radius:8px;margin-bottom:5px'
                          }, [
                            h('span', { style: 'word-break:break-word' }, s),
                            q.sampleCounts?.[i] > 1 ? h('span', { class: 'tag', style: 'flex:none' }, `×${q.sampleCounts[i]}`) : null
                          ]))
                        ]
                      : h('span', { class: 'muted small' }, '暂无作答'))
            ])))
          ])
    ])
  }
}
