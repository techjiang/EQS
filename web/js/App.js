import { h, ref, computed, onMounted, watch } from '/vendor/vue.esm.js'
import { api } from './api.js'
import { state, toggleTheme, applyTheme } from './store.js'
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
  { group: '工作', items: [
    { path: '/', name: '工作台', icon: 'dashboard' },
    { path: '/forms', name: '问卷表单', icon: 'form' },
    { path: '/exams', name: '在线考试', icon: 'exam' },
    { path: '/banks', name: '题库刷题', icon: 'bank' },
    { path: '/templates', name: '模板中心', icon: 'template' }
  ]},
  { group: '数据', items: [
    { path: '/data', name: '答卷数据', icon: 'data' },
    { path: '/report', name: '统计分析', icon: 'chart' },
    { path: '/screen', name: '数据大屏', icon: 'layers' }
  ]},
  { group: '系统', items: [
    { path: '/users', name: '用户权限', icon: 'users' },
    { path: '/recycle', name: '回收中心', icon: 'recycle' },
    { path: '/settings', name: '系统设置', icon: 'settings' }
  ]}
]

export default {
  setup() {
    const booted = ref(false)
    const boot = async () => {
      initRouter()
      try {
        const [me, site] = await Promise.all([
          api.get('/api/auth/me').catch(() => ({ user: null })),
          api.get('/api/settings/public').catch(() => ({ data: {} }))
        ])
        state.user = me.user
        state.site = { ...state.site, ...(site.data || {}) }
        if (site.data?.lang) state.lang = site.data.lang
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
      if (p === '/settings') return Settings
      if (p === '/users') return Users
      return Dashboard
    })

    const activePath = computed(() => {
      const p = route.value.path
      if (p.startsWith('/forms')) return '/forms'
      if (p.startsWith('/banks')) return '/banks'
      return p
    })

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
          h('nav', { class: 'nav' }, NAV.map(g => [
            h('div', { class: 'nav-group' }, g.group),
            ...g.items.map(it => h('a', {
              class: ['nav-item', activePath.value === it.path ? 'active' : ''],
              href: it.path, 'data-link': true,
              onClick: () => state.sidebarOpen = false
            }, [Icon(it.icon), h('span', {}, it.name)]))
          ])),
          h('div', { class: 'side-foot' }, [
            h('div', { class: 'nav-item', onClick: toggleTheme }, [
              Icon(state.theme === 'dark' ? 'sun' : 'moon'),
              h('span', {}, state.theme === 'dark' ? '浅色模式' : '深色模式')
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
            h('a', { class: 'btn sm', href: '/forms', 'data-link': true }, [Icon('plus', { style: 'width:14px;height:14px' }), '新建表单']),
            h('div', { class: 'flex', style: 'gap:10px' }, [
              h('img', {
                src: state.user.avatar || '/assets/eqs-mark.svg',
                style: 'width:32px;height:32px;border-radius:9px;object-fit:cover;background:var(--panel-2)'
              }),
              h('div', { style: 'line-height:1.25' }, [
                h('div', { style: 'font-size:13px;font-weight:600' }, state.user.nickname || state.user.username),
                h('div', { class: 'small muted' }, state.user.roleName || '用户')
              ]),
              h('button', { class: 'btn ghost icon sm', title: '退出', onClick: logout }, Icon('logout', { style: 'width:15px;height:15px' }))
            ])
          ]),
          h('main', { class: 'page' }, [h(view.value, { key: route.value.path })])
        ])
      ])
    }
  }
}
