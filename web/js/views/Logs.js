import { h, ref, onMounted, computed } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { ok, err, confirmBox, fmtDate, Empty } from '../ui.js'

/**
 * 审计日志。
 *
 * 系统一直在往 logs 表里记东西——建表单、删答卷、改权限、踢设备都有——
 * 但只有一个「最近 200 条全部混在一起」的接口，还挂在一个没人点得到的地方。
 * 于是「上周那份问卷是谁删的」这种问题，答案明明在库里，却查不出来。
 */

/** 动作按「动词」归类：一眼分出「看」「改」「删」「登录」 */
const KIND = [
  [/(失败|锁定|异常)/, 'danger'],
  [/(删除|彻底删除|清理|停用)/, 'warn'],
  [/(登录|退出|下线)/, 'brand'],
  [/(导出|备份|导入)/, '']
]
const classify = (action) => (KIND.find(([rx]) => rx.test(action || '')) || [])[1] ?? 'ok'

/** 只保留「谁 · 做了什么 · 在哪台机器上」这三件事，detail 里塞长的东西截断 */
const shorten = (s, n = 70) => {
  const v = String(s ?? '')
  return v.length > n ? v.slice(0, n) + '…' : v
}

/** 窄屏（<=640px）走卡片布局：5 列表格在 390px 上只能横向滚动，详情和 IP 永远看不见 */
function useNarrow() {
  const narrow = ref(typeof window !== 'undefined' && window.innerWidth <= 640)
  const onResize = () => { narrow.value = window.innerWidth <= 640 }
  onMounted(() => window.addEventListener('resize', onResize))
  return narrow
}

export default {
  setup() {
    const rows = ref([])
    const actions = ref([])
    const total = ref(0)
    const page = ref(1)
    const pageSize = 30
    const loading = ref(true)
    const action = ref('')
    const keyword = ref('')
    const pruning = ref(false)
    const narrow = useNarrow()

    const load = async () => {
      loading.value = true
      try {
        const q = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize) })
        if (action.value) q.set('action', action.value)
        if (keyword.value.trim()) q.set('keyword', keyword.value.trim())
        const r = await api.get('/api/logs?' + q)
        rows.value = r.data || []
        actions.value = r.actions || []
        total.value = r.total || 0
      } catch (e) { err(e.message) } finally { loading.value = false }
    }
    onMounted(load)

    const search = () => { page.value = 1; load() }
    const pick = (a) => { action.value = action.value === a ? '' : a; page.value = 1; load() }

    const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
    const goto = (n) => {
      const next = Math.min(totalPages.value, Math.max(1, n))
      if (next === page.value) return
      page.value = next
      load()
    }

    const prune = async () => {
      if (!await confirmBox('清理 90 天前的审计记录？近 90 天的会全部保留。')) return
      pruning.value = true
      try {
        const r = await api.del('/api/logs?days=90')
        ok(`已清理 ${r.removed} 条 90 天前的记录`)
        page.value = 1
        load()
      } catch (e) { err(e.message) } finally { pruning.value = false }
    }

    // 只看「今天」这类常见诉求：点了就填进关键词里，不额外造一个查询维度
    const today = () => {
      const d = new Date()
      const p = n => String(n).padStart(2, '0')
      keyword.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      search()
    }

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [
          h('h1', {}, '审计日志'),
          h('div', { class: 'sub' }, '谁在什么时候、从哪台机器上，做了什么')
        ]),
        h('div', { class: 'flex' }, [
          h('button', { class: 'btn', onClick: load, disabled: loading.value }, '刷新'),
          h('button', { class: 'btn', onClick: prune, disabled: pruning.value }, '清理 90 天前')
        ])
      ]),

      h('div', { class: 'card pad', style: 'margin-bottom:14px' }, [
        h('div', { class: 'flex wrap', style: 'gap:8px' }, [
          h('input', {
            class: 'input', style: 'flex:1;min-width:200px', placeholder: '搜账号 / 详情 / IP',
            value: keyword.value,
            onInput: e => keyword.value = e.target.value,
            onKeydown: e => { if (e.key === 'Enter') search() }
          }),
          h('button', { class: 'btn primary', onClick: search }, '搜索'),
          h('button', { class: 'btn ghost', onClick: today }, '只看今天'),
          action.value ? h('button', { class: 'btn ghost', onClick: () => { action.value = ''; search() } }, '清除筛选') : null
        ]),
        // 动作云：比下拉框快，而且顺带告诉你「这个系统到底记录了什么」
        actions.value.length ? h('div', { class: 'flex wrap', style: 'gap:6px;margin-top:12px' }, actions.value.map(a => h('button', {
          class: ['tag', action.value === a.action ? 'brand' : ''],
          style: 'cursor:pointer;height:24px',
          onClick: () => pick(a.action)
        }, `${a.action} ${a.c}`))) : null
      ]),

      h('div', { class: 'card', style: 'overflow:hidden' }, loading.value
        ? h('div', { style: 'padding:30px' }, '加载中…')
        : !rows.value.length ? Empty({ text: keyword.value || action.value ? '没有符合条件的记录' : '还没有任何操作记录' })
        // 窄屏：一条记录一张卡。5 列表格在 390px 上只会被裁成「时间 + 账号 + 动作」，
        // 而详情（删了哪张问卷、改了谁的权限）恰恰是要看的东西。
        : narrow.value
          ? h('div', {}, rows.value.map(x => h('div', {
              style: 'padding:12px 14px;border-bottom:1px solid var(--line-2)'
            }, [
              h('div', { class: 'flex between', style: 'gap:8px;align-items:flex-start' }, [
                h('span', { class: ['tag', classify(x.action)] }, x.action),
                h('span', { class: 'small muted nowrap' }, fmtDate(x.created_at))
              ]),
              x.detail ? h('div', { class: 'small', style: 'margin-top:6px;word-break:break-all' }, shorten(x.detail, 120)) : null,
              h('div', { class: 'small muted', style: 'margin-top:4px' }, `${x.username || '-'}${x.ip ? ' · ' + x.ip : ''}`)
            ])))
          : h('div', { style: 'overflow-x:auto' }, h('table', { class: 'table' }, [
              h('thead', {}, h('tr', {}, ['时间', '账号', '动作', '详情', 'IP'].map(t => h('th', {}, t)))),
              h('tbody', {}, rows.value.map(x => h('tr', {}, [
                h('td', { class: 'small muted nowrap' }, fmtDate(x.created_at)),
                h('td', {}, h('span', { style: 'font-weight:540' }, x.username || '-')),
                h('td', {}, h('span', { class: ['tag', classify(x.action)] }, x.action)),
                h('td', { class: 'small muted', style: 'max-width:420px' }, shorten(x.detail) || '-'),
                h('td', { class: 'mono small muted nowrap' }, x.ip || '-')
              ])))
            ]))),

      total.value ? h('div', { class: 'flex between', style: 'margin-top:14px;align-items:center' }, [
        h('div', { class: 'small muted' }, `共 ${total.value} 条 · 第 ${page.value} / ${totalPages.value} 页`),
        h('div', { class: 'flex' }, [
          h('button', { class: 'btn sm', disabled: page.value <= 1, onClick: () => goto(page.value - 1) }, '上一页'),
          h('button', { class: 'btn sm', disabled: page.value >= totalPages.value, onClick: () => goto(page.value + 1) }, '下一页')
        ])
      ]) : null,

      h('div', { class: 'card pad', style: 'margin-top:14px' }, [
        h('b', { class: 'small' }, '记了什么，没记什么'),
        h('div', { class: 'small muted', style: 'margin-top:6px;line-height:1.7' }, [
          '记：登录 / 登录失败 / 账号停用后登录、表单与题库的增删改、答卷的新增编辑删除与批阅、',
          '用户与角色变更、设备下线、API Key 签发、设置修改、备份导入导出、服务端异常。', h('br'),
          '不记：答卷的作答内容（那属于数据，在「答卷数据」里），也不记任何密码或密钥。'
        ])
      ])
    ])
  }
}
