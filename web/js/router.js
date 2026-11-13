import { ref } from '/vendor/vue.esm.js'

export const route = ref({ path: '/', query: {} })
const listeners = new Set()

export function parse(path) {
  const [p, qs] = path.split('?')
  return { path: p || '/', query: Object.fromEntries(new URLSearchParams(qs || '')) }
}

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path)
  else history.pushState({}, '', path)
  route.value = parse(path)
  listeners.forEach(fn => fn(route.value))
  window.scrollTo({ top: 0 })
}

export function onRoute(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function initRouter() {
  route.value = parse(location.pathname + location.search)
  window.addEventListener('popstate', () => {
    route.value = parse(location.pathname + location.search)
    listeners.forEach(fn => fn(route.value))
  })
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-link]')
    if (!a) return
    if (a.target === '_blank' || e.metaKey || e.ctrlKey) return
    e.preventDefault()
    navigate(a.getAttribute('href'))
  })
}
