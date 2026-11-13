import { h, ref, onMounted } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { navigate } from '../router.js'
import { ok, err, Empty } from '../ui.js'

export default {
  setup() {
    const list = ref([])
    const loading = ref(true)
    const cats = ref(['全部'])

    const load = async () => {
      try {
        const r = await api.get('/api/templates')
        list.value = r.data
        cats.value = ['全部', ...new Set(r.data.map(t => t.category || '其他'))]
      } catch (e) { err(e.message) } finally { loading.value = false }
    }
    onMounted(load)

    const cat = ref('全部')

    const use = async (t) => {
      try {
        const r = await api.post(`/api/templates/${t.id}/use`)
        ok('已基于模板创建')
        navigate(`/forms/${r.id}/design`)
      } catch (e) { err(e.message) }
    }

    const filtered = () => cat.value === '全部' ? list.value : list.value.filter(t => (t.category || '其他') === cat.value)

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [h('h1', {}, '模板中心'), h('div', { class: 'sub' }, '6 套开箱即用模板，一键套用后自由修改')]),
        h('button', { class: 'btn', onClick: () => navigate('/forms?new=1') }, '从空白开始')
      ]),
      h('div', { class: 'tabs', style: 'width:fit-content;margin-bottom:16px' }, cats.value.map(c => h('button', {
        class: cat.value === c ? 'on' : '', onClick: () => cat.value = c
      }, c))),
      loading.value ? h('div', { class: 'grid c3' }, [1, 2, 3].map(() => h('div', { class: 'card skeleton', style: 'height:200px' })))
        : filtered().length ? h('div', { class: 'grid c3' }, filtered().map(t => h('div', { class: 'card', style: 'overflow:hidden' }, [
            h('div', {
              style: 'height:104px;background:linear-gradient(135deg,rgba(91,124,250,.14),rgba(180,91,250,.2));display:grid;place-items:center'
            }, h('img', { src: '/assets/eqs-mark.svg', style: 'width:44px;height:44px;opacity:.9' })),
            h('div', { style: 'padding:16px' }, [
              h('div', { class: 'flex between', style: 'margin-bottom:6px' }, [
                h('b', { style: 'font-size:15px' }, t.title),
                h('span', { class: 'tag brand' }, t.category || '通用')
              ]),
              h('div', { class: 'small muted', style: 'min-height:36px' }, t.description || '无描述'),
              h('button', { class: 'btn primary sm', style: 'width:100%;margin-top:10px', onClick: () => use(t) }, '使用此模板')
            ])
          ])))
        : h('div', { class: 'card' }, h(Empty, { text: '该分类暂无模板' }))
    ])
  }
}
