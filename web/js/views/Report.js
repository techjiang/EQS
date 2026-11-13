import { h, ref, onMounted, onBeforeUnmount, nextTick } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { route } from '../router.js'
import { ok, err, Empty } from '../ui.js'
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

    const loadForms = async () => {
      const r = await api.get('/api/forms?pageSize=200')
      forms.value = r.data
      if (!formId.value && forms.value.length) formId.value = forms.value[0].id
    }

    const load = async () => {
      if (!formId.value) { loading.value = false; return }
      loading.value = true
      try {
        const r = await api.get(`/api/forms/${formId.value}/report`)
        data.value = r.data
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
        const chart = window.echarts.init(el, null, { renderer: 'canvas' })
        charts.push(chart)
        const names = q.series.map(s => s.name)
        const values = q.series.map(s => s.value)
        const isPie = ['radio', 'select', 'carousel', 'checkbox'].includes(q.type) && q.series.length <= 8
        const type = chartType.value === 'pie' && isPie ? 'pie' : chartType.value === 'line' ? 'line' : 'bar'
        const opt = type === 'pie'
          ? {
              color: PALETTE,
              tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
              legend: { bottom: 0, textStyle: { color: axisColor, fontSize: 11 } },
              series: [{
                type: 'pie', radius: ['42%', '68%'], center: ['50%', '44%'],
                data: q.series.map((s, i) => ({ name: s.name, value: s.value, itemStyle: { color: PALETTE[i % PALETTE.length] } })),
                label: { color: axisColor, fontSize: 11 }
              }]
            }
          : {
              color: [PALETTE[0]],
              grid: { left: 12, right: 16, top: 24, bottom: 8, containLabel: true },
              tooltip: { trigger: 'axis' },
              xAxis: { type: 'category', data: names, axisLabel: { color: axisColor, fontSize: 11, interval: 0, rotate: names.join('').length > 24 ? 30 : 0 }, axisLine: { lineStyle: { color: splitColor } } },
              yAxis: { type: 'value', minInterval: 1, axisLabel: { color: axisColor, fontSize: 11 }, splitLine: { lineStyle: { color: splitColor } } },
              series: [{
                type, data: values, smooth: true, barMaxWidth: 34,
                itemStyle: type === 'bar' ? { borderRadius: [6, 6, 0, 0], color: PALETTE[0] } : { color: PALETTE[1] },
                areaStyle: type === 'line' ? { opacity: .12 } : undefined
              }]
            }
        chart.setOption(opt)
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
          series: [{ type: 'line', data: data.value.trend.map(t => t.count), smooth: true, areaStyle: { opacity: .14 }, symbolSize: 7, lineStyle: { width: 2.5 } }]
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
            h('div', { class: 'grid c2' }, data.value.questions.map(q => h('div', { class: 'card' }, [
              h('div', { class: 'card-h' }, [
                h('div', { style: 'min-width:0' }, [
                  h('h3', { class: 'truncate' }, q.label),
                  h('div', { class: 'small muted' }, `${q.count} 人作答${q.average ? ` · 平均 ${q.average}` : ''}`)
                ]),
                h('button', { class: 'btn sm ghost', onClick: () => exportPng('chart_' + q.id) }, 'PNG')
              ]),
              q.series?.length
                ? h('div', { id: 'chart_' + q.id, class: 'chart' })
                : h('div', { class: 'card-b' }, q.samples?.length
                    ? q.samples.map(s => h('div', { class: 'small', style: 'padding:6px 10px;background:var(--panel-2);border-radius:8px;margin-bottom:5px' }, s))
                    : h('span', { class: 'muted small' }, '暂无作答'))
            ])))
          ])
    ])
  }
}
