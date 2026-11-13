import { h, ref, onMounted, onBeforeUnmount, nextTick } from '/vendor/vue.esm.js'
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

    const tick = () => {
      const d = new Date()
      const p = n => String(n).padStart(2, '0')
      clock.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    const load = async () => {
      try {
        const r = await api.get('/api/forms?pageSize=200')
        forms.value = r.data
        if (!formId.value && forms.value.length) formId.value = forms.value[0].id
        if (!formId.value) return
        const rep = await api.get(`/api/forms/${formId.value}/report`)
        data.value = rep.data
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
            type: 'line', smooth: true, symbolSize: 8,
            data: data.value.trend.map(t => t.count),
            lineStyle: { width: 3, color: '#38e0ff' },
            itemStyle: { color: '#38e0ff' },
            areaStyle: { color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(56,224,255,.45)' }, { offset: 1, color: 'rgba(56,224,255,0)' }]) }
          }]
        })
      }
      const chartable = data.value.questions.filter(q => q.series?.length).slice(0, 3)
      chartable.forEach((q, i) => {
        const el = document.getElementById('sc-q' + i)
        if (!el) return
        const c = window.echarts.init(el)
        charts.push(c)
        const isPie = ['radio', 'select', 'checkbox', 'carousel'].includes(q.type)
        c.setOption({
          color: PALETTE,
          backgroundColor: 'transparent',
          tooltip: { trigger: isPie ? 'item' : 'axis' },
          legend: isPie ? { bottom: 0, type: 'scroll', textStyle: { color: '#8fb4d8', fontSize: 11 } } : undefined,
          grid: isPie ? undefined : { left: 12, right: 16, top: 20, bottom: 8, containLabel: true },
          xAxis: isPie ? undefined : { type: 'category', data: q.series.map(s => s.name), axisLabel: { color: '#7fa6d0', interval: 0 }, axisLine: { lineStyle: { color: '#1d3a5f' } } },
          yAxis: isPie ? undefined : { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#12304d' } }, axisLabel: { color: '#7fa6d0' } },
          series: [isPie
            ? { type: 'pie', radius: ['40%', '62%'], center: ['50%', '45%'], data: q.series.map((s, k) => ({ name: s.name, value: s.value, itemStyle: { color: PALETTE[k % PALETTE.length] } })), label: { color: '#bcd7f0', fontSize: 11, formatter: '{b} {c}' }, labelLine: { length: 8, length2: 8 } }
            : { type: 'bar', barMaxWidth: 30, data: q.series.map(s => s.value), itemStyle: { borderRadius: [6, 6, 0, 0], color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#38e0ff' }, { offset: 1, color: 'rgba(56,224,255,.18)' }]) } }
          ]
        })
      })
    }

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

    const switchForm = async (e) => {
      formId.value = Number(e.target.value)
      const rep = await api.get(`/api/forms/${formId.value}/report`)
      data.value = rep.data
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
            class: 'btn sm', style: 'background:#12283f;border-color:#1d3a5f;color:#9fc4e8',
            onClick: () => navigate('/report?formId=' + formId.value)
          }, '返回报表'),
          h('button', {
            class: 'btn sm', style: 'background:#12283f;border-color:#1d3a5f;color:#9fc4e8',
            onClick: () => navigate('/')
          }, '工作台')
        ])
      ]),
      h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:16px' }, [
        ['总答卷', data.value?.total ?? 0],
        ['题目数', data.value?.questions?.length ?? 0],
        ['平均分', data.value?.avgScore ?? '—'],
        ['通过数', data.value?.passRate ?? 0]
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
        (data.value?.questions || []).filter(q => q.series?.length).slice(0, 3).map((q, i) => h('div', {
          style: 'background:rgba(8,24,42,.62);border:1px solid #17405f;border-radius:14px;padding:14px'
        }, [
          h('div', { style: 'font-size:13px;color:#8fb4d8;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, q.label),
          h('div', { id: 'sc-q' + i, style: 'height:240px' })
        ])))
    ])
  }
}
