import { h, ref, computed, onMounted } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { navigate, route } from '../router.js'
import { Icon } from '../icons.js'
import { ok, err, confirmBox, fmtDate, Empty, Modal, Pagination } from '../ui.js'
import { state } from '../store.js'

const KIND_LABEL = { survey: '问卷', exam: '考试', practice: '刷题', form: '表单' }

export default {
  setup() {
    const list = ref([])
    const loading = ref(true)
    const keyword = ref('')
    const kind = ref(route.value.query.kind || '')
    const page = ref(1)
    const total = ref(0)
    const totalPages = ref(1)
    const showNew = ref(route.value.query.new === '1')
    const newForm = ref({ title: '', kind: 'survey', description: '' })
    const aiMode = ref(false)
    const aiPrompt = ref('')
    const aiLoading = ref(false)

    const load = async () => {
      loading.value = true
      try {
        const qs = new URLSearchParams({ page: page.value, pageSize: 12 })
        if (keyword.value) qs.set('keyword', keyword.value)
        if (kind.value) qs.set('kind', kind.value)
        const r = await api.get('/api/forms?' + qs)
        list.value = r.data
        total.value = r.total
        totalPages.value = r.totalPages
      } catch (e) { err(e.message) } finally { loading.value = false }
    }
    onMounted(load)

    const create = async () => {
      if (!newForm.value.title.trim()) return err('请填写表单标题')
      try {
        let schema = []
        let title = newForm.value.title
        let description = newForm.value.description
        if (aiMode.value && aiPrompt.value.trim()) {
          aiLoading.value = true
          const r = await api.post('/api/ai/generate', { prompt: aiPrompt.value, kind: newForm.value.kind })
          schema = r.data.schema || []
          title = r.data.title || title
          description = r.data.description || description
          if (r.source === 'local') ok('AI 未配置，已用本地智能模板生成')
        }
        const r = await api.post('/api/forms', { ...newForm.value, title, description, schema })
        showNew.value = false
        ok('创建成功')
        navigate(`/forms/${r.id}/design`)
      } catch (e) { err(e.message) } finally { aiLoading.value = false }
    }

    const publish = async (f) => {
      try {
        await api.put(`/api/forms/${f.id}`, { status: f.status === 'published' ? 'draft' : 'published' })
        ok(f.status === 'published' ? '已取消发布' : '已发布')
        load()
      } catch (e) { err(e.message) }
    }

    const copyLink = (f) => {
      const url = `${location.origin}/f/${f.id}`
      navigator.clipboard.writeText(url).then(() => ok('链接已复制：' + url)).catch(() => prompt('复制此链接', url))
    }

    const remove = async (f) => {
      if (!await confirmBox(`将「${f.title}」移入回收中心？`)) return
      try { await api.del(`/api/forms/${f.id}`); ok('已移入回收中心'); load() } catch (e) { err(e.message) }
    }

    const duplicate = async (f) => {
      try { await api.post(`/api/forms/${f.id}/duplicate`); ok('已复制'); load() } catch (e) { err(e.message) }
    }

    const saveTemplate = async (f) => {
      try {
        await api.put(`/api/forms/${f.id}`, { is_template: 1, category: f.kind === 'exam' ? '考试' : '通用' })
        ok('已保存到模板中心')
      } catch (e) { err(e.message) }
    }

    const kindTabs = [['', '全部'], ['survey', '问卷'], ['exam', '考试'], ['form', '表单']]

    const card = (f) => h('div', { class: 'card', style: 'overflow:hidden;transition:.18s' }, [
      h('div', {
        style: 'height:92px;background:linear-gradient(135deg,rgba(91,124,250,.16),rgba(180,91,250,.16));display:flex;align-items:center;justify-content:space-between;padding:0 16px;cursor:pointer',
        onClick: () => navigate(`/forms/${f.id}/design`)
      }, [
        h('div', {}, [
          h('div', { style: 'font-size:12px;color:var(--brand);font-weight:600;margin-bottom:4px' }, KIND_LABEL[f.kind] || '表单'),
          h('div', { class: 'truncate', style: 'font-weight:640;font-size:15px;max-width:180px' }, f.title)
        ]),
        h('img', { src: '/assets/eqs-mark.svg', style: 'width:38px;height:38px;opacity:.85' })
      ]),
      h('div', { style: 'padding:14px 16px' }, [
        h('div', { class: 'flex between', style: 'margin-bottom:10px' }, [
          h('span', { class: ['tag', f.status === 'published' ? 'ok' : 'warn'] }, f.status === 'published' ? '已发布' : '草稿'),
          h('span', { class: 'small muted' }, `${f.submission_count || 0} 份答卷`)
        ]),
        h('div', { class: 'small muted', style: 'margin-bottom:12px' }, '更新于 ' + fmtDate(f.updated_at)),
        h('div', { class: 'flex wrap', style: 'gap:6px' }, [
          h('button', { class: 'btn sm', onClick: () => navigate(`/forms/${f.id}/design`) }, '编辑'),
          h('button', { class: 'btn sm', onClick: () => publish(f) }, f.status === 'published' ? '取消发布' : '发布'),
          h('button', { class: 'btn sm', onClick: () => copyLink(f) }, '链接'),
          h('button', { class: 'btn sm', onClick: () => navigate(`/data?formId=${f.id}`) }, '数据'),
          h('button', { class: 'btn sm', onClick: () => navigate(`/report?formId=${f.id}`) }, '报表'),
          h('button', { class: 'btn sm ghost', title: '更多', onClick: () => moreMenu(f) }, '···')
        ])
      ])
    ])

    const moreMenu = (f) => {
      const overlay = document.createElement('div')
      overlay.className = 'modal-mask'
      const actions = [
        ['预览填写', () => navigate(`/f/${f.id}?preview=1`)],
        ['复制表单', () => duplicate(f)],
        ['保存为模板', () => saveTemplate(f)],
        ['移入回收中心', () => remove(f)]
      ]
      overlay.innerHTML = `<div class="modal" style="max-width:340px"><div class="modal-h"><h3>${f.title}</h3></div><div class="modal-b" style="padding:8px"></div></div>`
      const body = overlay.querySelector('.modal-b')
      for (const [label, fn] of actions) {
        const b = document.createElement('button')
        b.className = 'nav-item'
        b.style.width = '100%'
        b.textContent = label
        b.onclick = () => { overlay.remove(); fn() }
        body.appendChild(b)
      }
      overlay.onclick = e => { if (e.target === overlay) overlay.remove() }
      document.body.appendChild(overlay)
    }

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [
          h('h1', {}, '问卷表单'),
          h('div', { class: 'sub' }, '拖拽式设计、AI 生成、发布收集一句话完成')
        ]),
        h('button', { class: 'btn primary', onClick: () => showNew.value = true }, [Icon('plus', { style: 'width:15px;height:15px' }), '新建表单'])
      ]),
      h('div', { class: 'card pad mb', style: 'display:flex;gap:12px;flex-wrap:wrap;align-items:center' }, [
        h('div', { class: 'tabs', style: 'margin:0;width:auto' }, kindTabs.map(([v, l]) => h('button', {
          class: kind.value === v ? 'on' : '', onClick: () => { kind.value = v; page.value = 1; load() }
        }, l))),
        h('div', { style: 'flex:1;min-width:180px;position:relative' }, [
          h('input', {
            class: 'input', placeholder: '搜索表单标题…', value: keyword.value,
            onInput: e => keyword.value = e.target.value,
            onKeydown: e => { if (e.key === 'Enter') { page.value = 1; load() } }
          })
        ]),
        h('button', { class: 'btn', onClick: () => { page.value = 1; load() } }, '搜索')
      ]),
      loading.value
        ? h('div', { class: 'grid c3' }, [1, 2, 3].map(() => h('div', { class: 'card skeleton', style: 'height:220px' })))
        : list.value.length
          ? h('div', { class: 'grid c3' }, list.value.map(card))
          : h('div', { class: 'card' }, h(Empty, { text: '还没有表单，点击右上角新建一个吧' })),
      h(Pagination, { page: page.value, totalPages: totalPages.value, onChange: p => { page.value = p; load() } }),
      showNew.value ? Modal({
        title: '新建表单', modelValue: true,
        onClose: () => { showNew.value = false; aiMode.value = false },
        children: [
          h('div', { class: 'tabs' }, [
            h('button', { class: !aiMode.value ? 'on' : '', onClick: () => aiMode.value = false }, '手动创建'),
            h('button', { class: aiMode.value ? 'on' : '', onClick: () => aiMode.value = true }, 'AI 创建')
          ]),
          h('div', { class: 'field' }, [h('label', {}, '表单标题'), h('input', {
            class: 'input', placeholder: '例如：2025 年客户满意度调查', value: newForm.value.title,
            onInput: e => newForm.value.title = e.target.value
          })]),
          h('div', { class: 'field' }, [h('label', {}, '类型'), h('select', {
            class: 'select', value: newForm.value.kind,
            onChange: e => newForm.value.kind = e.target.value
          }, [h('option', { value: 'survey' }, '问卷 / 收集'), h('option', { value: 'exam' }, '考试 / 测验'), h('option', { value: 'form' }, '通用表单')])]),
          h('div', { class: 'field' }, [h('label', {}, '描述（可选）'), h('textarea', {
            class: 'textarea', style: 'min-height:70px', value: newForm.value.description,
            onInput: e => newForm.value.description = e.target.value
          })]),
          aiMode.value ? h('div', { class: 'field' }, [
            h('label', {}, 'AI 描述（用一句话说明你要收集什么）'),
            h('textarea', {
              class: 'textarea', placeholder: '例如：帮我做一个新产品上线前的用户需求调研问卷，包含满意度评分和开放建议',
              value: aiPrompt.value, onInput: e => aiPrompt.value = e.target.value
            })
          ]) : null
        ],
        footer: [
          h('button', { class: 'btn', onClick: () => showNew.value = false }, '取消'),
          h('button', { class: 'btn primary', disabled: aiLoading.value, onClick: create }, aiLoading.value ? '生成中…' : '创建并设计')
        ]
      }) : null
    ])
  }
}
