import { h, ref, onMounted } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { ok, err, confirmBox, fmtDate, Empty } from '../ui.js'

export default {
  setup() {
    const list = ref([])
    const loading = ref(true)

    const load = async () => {
      loading.value = true
      try {
        const r = await api.get('/api/forms?recycle=1&pageSize=100')
        list.value = r.data
      } catch (e) { err(e.message) } finally { loading.value = false }
    }
    onMounted(load)

    const restore = async (f) => {
      try { await api.post(`/api/forms/${f.id}/restore`); ok('已恢复'); load() } catch (e) { err(e.message) }
    }
    const purge = async (f) => {
      if (!await confirmBox(`彻底删除「${f.title}」及其全部答卷？此操作不可恢复！`)) return
      try { await api.del(`/api/forms/${f.id}/purge`); ok('已彻底删除'); load() } catch (e) { err(e.message) }
    }

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [h('h1', {}, '回收中心'), h('div', { class: 'sub' }, '删除的表单会保留在这里，可随时恢复')])
      ]),
      h('div', { class: 'card', style: 'overflow:hidden' }, loading.value
        ? h('div', { style: 'padding:30px' }, '加载中…')
        : list.value.length ? h('table', { class: 'table' }, [
            h('thead', {}, h('tr', {}, [h('th', {}, '标题'), h('th', {}, '类型'), h('th', {}, '删除时间'), h('th', {}, '操作')])),
            h('tbody', {}, list.value.map(f => h('tr', {}, [
              h('td', { style: 'font-weight:540' }, f.title),
              h('td', {}, h('span', { class: 'tag' }, { survey: '问卷', exam: '考试', form: '表单' }[f.kind] || '表单')),
              h('td', { class: 'small muted' }, fmtDate(f.deleted_at)),
              h('td', {}, h('div', { class: 'flex', style: 'gap:6px' }, [
                h('button', { class: 'btn sm', onClick: () => restore(f) }, '恢复'),
                h('button', { class: 'btn sm danger', onClick: () => purge(f) }, '彻底删除')
              ]))
            ])))
          ])
        : h(Empty, { text: '回收中心是空的' }))
    ])
  }
}
