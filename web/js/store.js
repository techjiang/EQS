import { reactive } from '/vendor/vue.esm.js'

export const state = reactive({
  user: null,
  site: { name: 'EQS' },
  loading: false,
  sidebarOpen: false,
  theme: localStorage.getItem('eqs_theme') || 'light',
  lang: localStorage.getItem('eqs_lang') || 'zh',
  i18n: {}
})

export function applyTheme() {
  document.documentElement.dataset.theme = state.theme
  localStorage.setItem('eqs_theme', state.theme)
}

export function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark'
  applyTheme()
}

export function t(key, fallback) {
  return state.i18n[key] || fallback || key
}
