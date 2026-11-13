import { h } from '/vendor/vue.esm.js'

export function toast(message, type = '') {
  const root = document.getElementById('toast-root')
  if (!root) return
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.textContent = message
  root.appendChild(el)
  setTimeout(() => {
    el.style.transition = 'opacity .25s,transform .25s'
    el.style.opacity = '0'
    el.style.transform = 'translateY(-6px)'
    setTimeout(() => el.remove(), 260)
  }, 2600)
}

export const ok = (m) => toast(m, 'ok')
export const err = (m) => toast(m || '操作失败', 'err')

export function confirmBox(message, title = '请确认') {
  return new Promise(resolve => {
    const close = (v) => { overlay.remove(); resolve(v) }
    const overlay = document.createElement('div')
    overlay.className = 'modal-mask'
    overlay.innerHTML = `<div class="modal" style="max-width:400px">
      <div class="modal-h"><h3>${escapeHtml(title)}</h3></div>
      <div class="modal-b">${escapeHtml(message)}</div>
      <div class="modal-f"><button class="btn" data-no>取消</button><button class="btn primary" data-yes>确定</button></div>
    </div>`
    overlay.querySelector('[data-no]').onclick = () => close(false)
    overlay.querySelector('[data-yes]').onclick = () => close(true)
    overlay.onclick = (e) => { if (e.target === overlay) close(false) }
    document.body.appendChild(overlay)
  })
}

export function promptBox({ title = '输入', label = '', value = '', placeholder = '', textarea = false } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-mask'
    const field = textarea
      ? `<textarea class="textarea" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`
      : `<input class="input" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}">`
    overlay.innerHTML = `<div class="modal">
      <div class="modal-h"><h3>${escapeHtml(title)}</h3></div>
      <div class="modal-b"><div class="field">${label ? `<label>${escapeHtml(label)}</label>` : ''}${field}</div></div>
      <div class="modal-f"><button class="btn" data-no>取消</button><button class="btn primary" data-yes>确定</button></div>
    </div>`
    const input = overlay.querySelector('input,textarea')
    const close = v => { overlay.remove(); resolve(v) }
    overlay.querySelector('[data-no]').onclick = () => close(null)
    overlay.querySelector('[data-yes]').onclick = () => close(input.value)
    overlay.onclick = e => { if (e.target === overlay) close(null) }
    document.body.appendChild(overlay)
    input.focus()
    if (!textarea) input.onkeydown = e => { if (e.key === 'Enter') close(input.value) }
  })
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export function fmtDate(s) {
  if (!s) return '-'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return String(s)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fmtSize(n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`
}

export function Empty({ text = '暂无数据', icon = true }) {
  return h('div', { class: 'empty' }, [
    icon ? h('div', { style: 'font-size:40px;opacity:.3;margin-bottom:6px' }, '◍') : null,
    h('div', {}, text)
  ])
}

export function Modal({ title, modelValue, onClose, wide = false, children, footer }) {
  if (!modelValue) return null
  return h('div', { class: 'modal-mask', onClick: e => { if (e.target.classList.contains('modal-mask')) onClose() } }, [
    h('div', { class: ['modal', wide ? 'wide' : ''] }, [
      h('div', { class: 'modal-h' }, [
        h('h3', {}, title),
        h('button', { class: 'btn ghost sm', onClick: onClose }, '关闭')
      ]),
      h('div', { class: 'modal-b' }, children),
      footer ? h('div', { class: 'modal-f' }, footer) : null
    ])
  ])
}

export function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null
  const btn = (p, label, disabled) => h('button', {
    class: ['btn', 'sm', p === page ? 'primary' : ''],
    disabled, onClick: () => !disabled && onChange(p)
  }, label)
  return h('div', { class: 'flex', style: 'justify-content:center;gap:6px;padding:14px' }, [
    btn(page - 1, '上一页', page <= 1),
    h('span', { class: 'small muted', style: 'padding:0 8px' }, `${page} / ${totalPages}`),
    btn(page + 1, '下一页', page >= totalPages)
  ])
}
