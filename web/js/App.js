import { h, ref, computed, onMounted, watch } from '/vendor/vue.esm.js'
import { api } from './api.js'
import { state, toggleTheme, applyTheme, t } from './store.js'
import { route, initRouter, navigate } from './router.js'
import { Icon } from './icons.js'
import { toast, confirmBox } from './ui.js'

import Login from './views/Login.js'
import Dashboard from './views/Dashboard.js'
import Forms from './views/Forms.js'
import Designer from './views/Designer.js'
import Templates from './views/Templates.js'
import DataView from './views/DataView.js'
import Report from './views/Report.js'
import Banks from './views/Banks.js'
import Practice from './views/Practice.js'
import Recycle from './views/Recycle.js'
import Settings from './views/Settings.js'
import Users from './views/Users.js'
import PublicForm from './views/PublicForm.js'
import Exams from './views/Exams.js'
import Screen from './views/Screen.js'

const NAV = [
  { group: '工作', key: 'group.work', items: [
    { path: '/', name: '工作台', key: 'nav.dashboard', icon: 'dashboard' },
    { path: '/forms', name: '问卷表单', key: 'nav.forms', icon: 'form' },
    { path: '/exams', name: '在线考试', key: 'nav.exams', icon: 'exam' },
    { path: '/banks', name: '题库刷题', key: 'nav.banks', icon: 'bank' },
    { path: '/templates', name: '模板中心', key: 'nav.templates', icon: 'template' }
  ]},
  { group: '数据', key: 'group.data', items: [
    { path: '/data', name: '答卷数据', key: 'nav.data', icon: 'data' },
    { path: '/report', name: '统计分析', key: 'nav.report', icon: 'chart' },
    { path: '/screen', name: '数据大屏', key: 'nav.screen', icon: 'layers' }
  ]},
  { group: '系统', key: 'group.system', items: [
    { path: '/users', name: '用户权限', key: 'nav.users', icon: 'users', admin: true },
    { path: '/recycle', name: '回收中心', key: 'nav.recycle', icon: 'recycle' },
    { path: '/settings', name: '系统设置', key: 'nav.settings', icon: 'settings', admin: true }
  ]}
]

/**
 * 导航按权限过滤。
 * 之前「用户权限」「系统设置」对所有人可见，普通用户点进去是一片
 * 「权限不足」的 toast——菜单本身就是一份权限说明书，不该指错路。
 */
function visibleNav(user) {
  const admin = !!user?.perms?.includes('*')
  return NAV
    .map(g => ({ ...g, items: g.items.filter(it => admin || !it.admin) }))
    .filter(g => g.items.length)
}

const LANGS = { zh: '简体中文', en: 'English' }

/** 直连无权页面时的说明页：比一片「权限不足」的 toast 有用 */
const Forbidden = () => h('div', { class: 'card pad', style: 'text-align:center;padding:70px 20px' }, [
  h('div', { style: 'font-size:38px;opacity:.35;margin-bottom:10px' }, '🔒'),
  h('h3', { style: 'margin-bottom:6px' }, '这个页面需要管理员权限'),
  h('div', { class: 'small muted', style: 'margin-bottom:18px' }, '当前账号的权限由管理员分配，需要的话找管理员开。'),
  h('button', { class: 'btn primary', onClick: () => navigate('/') }, '回到工作台')
])

export default {
  setup() {
    const booted = ref(false)
    // 全站唯一的「能不能建东西」判断：只读角色（form:read 但无 form:create）不该看见新建立口
    const canWrite = computed(() => {
      const p = state.user?.perms || []
      return p.includes('*') || p.includes('form:create')
    })
    const boot = async () => {
      initRouter()
      try {
        const [me, site] = await Promise.all([
          api.get('/api/auth/me').catch(() => ({ user: null })),
          api.get('/api/settings/public').catch(() => ({ data: {} }))
        ])
        state.user = me.user
        state.site = { ...state.site, ...(site.data || {}) }
        // 站点默认语言只在用户没自己选过时生效：以前每次刷新都被服务端值覆盖，
        // 点过「English」再刷新又变回中文，看起来像没保存。
        if (!localStorage.getItem('eqs_lang') && site.data?.lang) state.lang = site.data.lang
        const dict = await api.get(`/api/i18n/${state.lang}`).catch(() => ({ data: {} }))
        state.i18n = dict.data || {}
      } catch {}
      booted.value = true
    }
    onMounted(boot)

    const isPublic = computed(() => /^\/f\/\d+/.test(route.value.path) || route.value.path === '/login')
    const view = computed(() => {
      const p = route.value.path
      if (p === '/login') return Login
      if (/^\/f\/\d+/.test(p)) return PublicForm
      if (!state.user) return Login
      if (p === '/') return Dashboard
      if (p === '/forms') return Forms
      if (/^\/forms\/\d+\/design/.test(p)) return Designer
      if (p === '/exams') return Exams
      if (p === '/templates') return Templates
      if (p === '/data') return DataView
      if (p === '/report') return Report
      if (p === '/screen') return Screen
      if (p === '/banks') return Banks
      if (/^\/banks\/\d+\/practice/.test(p)) return Practice
      if (p === '/recycle') return Recycle
      // 直接敲地址也不能进：菜单收起来了，地址栏还留着后门就白收
      if (p === '/settings') return state.user?.perms?.includes('*') ? Settings : Forbidden
      if (p === '/users') return state.user?.perms?.includes('*') ? Users : Forbidden
      return Dashboard
    })

    const activePath = computed(() => {
      const p = route.value.path
      if (p.startsWith('/forms')) return '/forms'
      if (p.startsWith('/banks')) return '/banks'
      return p
    })

    /** 中英切换：存本地 + 重新拉词典，界面立刻跟着变 */
    const switchLang = async () => {
      const order = ['zh', 'en']
      const next = order[(order.indexOf(state.lang) + 1) % order.length]
      state.lang = next
      localStorage.setItem('eqs_lang', next)
      const dict = await api.get(`/api/i18n/${next}`).catch(() => ({ data: {} }))
      state.i18n = dict.data || {}
      toast(next === 'en' ? 'Language: English' : '界面语言：简体中文')
    }

    const logout = async () => {
      if (!await confirmBox('确定退出登录？')) return
      await api.post('/api/auth/logout')
      state.user = null
      navigate('/login')
    }

    return () => {
      if (!booted.value) return h('div', { class: 'center', style: 'padding:80px;color:var(--text-3)' }, '正在加载 EQS…')

      const isFill = /^\/f\/\d+/.test(route.value.path)
      if (isFill || route.value.path === '/screen' || (route.value.path === '/login' && !state.user)) {
        return h(view.value, { key: route.value.path })
      }
      if (!state.user) return h(Login)

      return h('div', { class: 'layout' }, [
        state.sidebarOpen ? h('div', { class: 'side-backdrop', onClick: () => state.sidebarOpen = false }) : null,
        h('aside', { class: ['sidebar', state.sidebarOpen ? 'open' : ''] }, [
          h('a', { class: 'brand', href: '/', 'data-link': true, onClick: () => state.sidebarOpen = false }, [
            h('img', { src: '/assets/eqs-mark.svg', alt: 'EQS' }),
            h('div', {}, [
              h('b', {}, state.site.name || 'EQS'),
              h('small', {}, '问卷 · 考试 · 刷题')
            ])
          ]),
          h('nav', { class: 'nav' }, visibleNav(state.user).map(g => [
            h('div', { class: 'nav-group' }, t(g.key, g.group)),
            ...g.items.map(it => h('a', {
              class: ['nav-item', activePath.value === it.path ? 'active' : ''],
              href: it.path, 'data-link': true,
              onClick: () => state.sidebarOpen = false
            }, [Icon(it.icon), h('span', {}, t(it.key, it.name))]))
          ])),
          h('div', { class: 'side-foot' }, [
            // 语言切换：以前只有后台能编辑词典，界面上没有入口——「多语言」等于没开
            h('div', { class: 'nav-item', onClick: switchLang, title: 'Language / 语言' }, [
              Icon('globe', { style: 'width:16px;height:16px' }),
              h('span', {}, LANGS[state.lang] || state.lang.toUpperCase())
            ]),
            h('div', { class: 'nav-item', onClick: toggleTheme }, [
              Icon(state.theme === 'dark' ? 'sun' : 'moon'),
              h('span', {}, state.theme === 'dark' ? t('theme.light', '浅色模式') : t('theme.dark', '深色模式'))
            ])
          ])
        ]),
        h('div', { class: 'main' }, [
          h('header', { class: 'topbar' }, [
            h('button', {
              class: 'btn ghost icon sm menu-btn',
              onClick: () => state.sidebarOpen = !state.sidebarOpen
            }, Icon('menu')),
            h('div', { style: 'flex:1' }),
            // 只读访客没有 form:create，这个按钮点下去只会弹「权限不足」
            canWrite.value ? h('a', { class: 'btn sm', href: '/forms', 'data-link': true }, [Icon('plus', { style: 'width:14px;height:14px' }), t('action.newForm', '新建表单')]) : null,
            h('div', { class: 'flex', style: 'gap:10px' }, [
              h('img', {
                src: state.user.avatar || '/assets/eqs-mark.svg',
                style: 'width:32px;height:32px;border-radius:9px;object-fit:cover;background:var(--panel-2)'
              }),
              h('div', { style: 'line-height:1.25' }, [
                h('div', { style: 'font-size:13px;font-weight:600' }, state.user.nickname || state.user.username),
                h('div', { class: 'small muted' }, state.user.roleName || '用户')
              ]),
              h('button', { class: 'btn ghost icon sm', title: t('action.logout', '退出'), onClick: logout }, Icon('logout', { style: 'width:15px;height:15px' }))
            ])
          ]),
          h('main', { class: 'page' }, [h(view.value, { key: route.value.path })])
        ])
      ])
    }
  }
}
