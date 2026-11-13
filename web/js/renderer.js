import { h } from '/vendor/vue.esm.js'
import { escapeHtml } from './ui.js'

const findMeta = (type) => type

function FieldLabel(f) {
  if (['divider', 'richtext', 'html', 'image'].includes(f.type)) return null
  return h('div', { class: 'q-title' }, [
    h('span', {}, f.label || '未命名题目'),
    f.required ? h('span', { class: 'req' }, '*') : null
  ])
}

export function fieldVisible(field, data) {
  const rules = field.logic || []
  if (!rules.length) return true
  return rules.every(r => {
    const v = data[r.fieldId]
    const flat = Array.isArray(v) ? v.join(',') : v
    switch (r.op) {
      case 'eq': return String(flat) === String(r.value)
      case 'ne': return String(flat) !== String(r.value)
      case 'in': return Array.isArray(r.value) ? r.value.map(String).includes(String(flat)) : String(flat) === String(r.value)
      case 'contains': return Array.isArray(v) ? v.map(String).includes(String(r.value)) : String(flat ?? '').includes(String(r.value))
      case 'gt': return Number(flat) > Number(r.value)
      case 'lt': return Number(flat) < Number(r.value)
      case 'empty': return flat === '' || flat === undefined || flat === null
      case 'notEmpty': return !(flat === '' || flat === undefined || flat === null)
      default: return true
    }
  })
}

/** 渲染单个组件的作答控件 */
export function renderControl(field, model, opts = {}) {
  const { readonly = false, onChange, onUpload } = opts
  const val = model[field.id]
  const set = (v) => { model[field.id] = v; onChange?.() }
  const dis = readonly

  switch (field.type) {
    case 'text': case 'email': case 'phone': case 'idcard': case 'number':
      return h('input', {
        class: 'input', disabled: dis,
        type: field.type === 'number' ? 'number' : 'text',
        placeholder: field.placeholder || inputHint(field.type),
        value: val ?? '',
        onInput: e => set(e.target.value)
      })
    case 'textarea':
      return h('textarea', {
        class: 'textarea', disabled: dis,
        placeholder: field.placeholder || '请输入内容',
        value: val ?? '',
        onInput: e => set(e.target.value)
      })
    case 'date': case 'datetime': case 'time': {
      const type = field.type === 'datetime' ? 'datetime-local' : field.type
      return h('input', { class: 'input', type, disabled: dis, value: val ?? '', onInput: e => set(e.target.value) })
    }
    case 'select':
      return h('select', { class: 'select', disabled: dis, value: val ?? '', onChange: e => set(e.target.value) }, [
        h('option', { value: '' }, field.placeholder || '请选择'),
        ...field.options.map(o => h('option', { value: o.value }, o.label))
      ])
    case 'radio':
      return h('div', {}, field.options.map((o, i) => h('label', {
        class: ['opt', String(val) === String(o.value) ? 'sel' : ''],
        key: o.value + i
      }, [
        h('input', {
          type: 'radio', name: field.id, checked: String(val) === String(o.value), disabled: dis,
          onChange: () => set(o.value)
        }),
        h('span', {}, o.label)
      ])))
    case 'checkbox': {
      const arr = Array.isArray(val) ? val : []
      return h('div', {}, field.options.map((o, i) => {
        const checked = arr.map(String).includes(String(o.value))
        return h('label', { class: ['opt', checked ? 'sel' : ''], key: o.value + i }, [
          h('input', {
            type: 'checkbox', checked, disabled: dis,
            onChange: e => {
              const next = new Set(arr.map(String))
              if (e.target.checked) next.add(String(o.value)); else next.delete(String(o.value))
              set([...next])
            }
          }),
          h('span', {}, o.label)
        ])
      }))
    }
    case 'switch':
      return h('div', { class: 'flex' }, [
        h('div', { class: ['switch', val ? 'on' : ''], onClick: () => !dis && set(!val) }),
        h('span', { class: 'small muted' }, val ? '已开启' : '未开启')
      ])
    case 'rate': {
      const max = Number(field.props?.max) || 5
      const cur = val === '' || val === null || val === undefined ? 0 : Number(val)
      return h('div', { class: 'flex', style: 'gap:4px;font-size:24px' }, Array.from({ length: max }, (_, i) =>
        h('span', {
          key: i, style: `cursor:pointer;color:${cur > i ? '#f59e0b' : 'var(--line)'};transition:.1s`,
          onClick: () => !dis && set(i + 1)
        }, '★')))
    }
    case 'nps': {
      const max = Number(field.props?.max) || 10
      return h('div', {}, [
        h('div', { class: 'flex wrap', style: 'gap:6px' }, Array.from({ length: max + 1 }, (_, i) =>
          h('button', {
            key: i, type: 'button',
            class: ['btn', 'sm', val !== '' && val !== null && val !== undefined && Number(val) === i ? 'primary' : ''],
            style: 'min-width:34px',
            onClick: () => !dis && set(i)
          }, String(i)))),
        h('div', { class: 'flex between small muted', style: 'margin-top:4px' }, [h('span', {}, '完全不会'), h('span', {}, '非常愿意')])
      ])
    }
    case 'slider': {
      const { min = 0, max = 100, step = 1 } = field.props || {}
      return h('div', {}, [
        h('input', {
          type: 'range', min, max, step, value: val ?? min, disabled: dis,
          style: 'width:100%;accent-color:var(--brand)',
          onInput: e => set(Number(e.target.value))
        }),
        h('div', { class: 'small muted center' }, String(val ?? min))
      ])
    }
    case 'matrix': {
      const rows = field.props?.rows || []
      const obj = (val && typeof val === 'object') ? val : {}
      return h('div', { style: 'overflow-x:auto' }, [
        h('table', { class: 'table', style: 'font-size:13px' }, [
          h('thead', {}, h('tr', {}, [
            h('th', {}, ''),
            ...field.options.map(o => h('th', { style: 'text-align:center' }, o.label))
          ])),
          h('tbody', {}, rows.map(row => h('tr', { key: row }, [
            h('td', { style: 'font-weight:520' }, row),
            ...field.options.map(o => h('td', { style: 'text-align:center' }, h('input', {
              type: 'radio', name: `${field.id}_${row}`, checked: obj[row] === o.value, disabled: dis,
              style: 'accent-color:var(--brand)',
              onChange: () => set({ ...obj, [row]: o.value })
            })))
          ])))
        ])
      ])
    }
    case 'upload': {
      const files = Array.isArray(val) ? val : (val ? [val] : [])
      return h('div', {}, [
        h('div', { class: 'flex wrap' }, files.map((f, i) => h('div', {
          class: 'tag brand', key: i, style: 'height:28px'
        }, [
          h('a', { href: f.url, target: '_blank', style: 'color:inherit' }, f.name || '附件'),
          h('span', { style: 'cursor:pointer;margin-left:4px', onClick: () => set(files.filter((_, j) => j !== i)) }, '×')
        ]))),
        readonly ? null : h('label', { class: 'btn sm', style: 'margin-top:8px' }, [
          '选择文件',
          h('input', {
            type: 'file', class: 'hide', multiple: field.props?.multiple,
            onChange: async e => {
              const fs = [...(e.target.files || [])]
              for (const file of fs) {
                const r = await onUpload?.(file, field)
                if (r) files.push({ name: r.name, url: r.url, id: r.id })
              }
              set([...files])
              e.target.value = ''
            }
          })
        ])
      ])
    }
    case 'signature':
      return h('div', {}, [
        h('canvas', {
          width: 480, height: 140,
          style: 'width:100%;max-width:480px;border:1px dashed var(--line);border-radius:10px;background:var(--panel-2);cursor:crosshair;touch-action:none',
          ref: el => { if (el && !el.dataset.init) initSignature(el, v => set(v)) }
        }),
        h('div', { class: 'small muted', style: 'margin-top:4px' }, '在框内手写签名'),
        val ? h('img', { src: val, style: 'max-height:60px;margin-top:6px;border:1px solid var(--line);border-radius:8px' }) : null
      ])
    case 'location':
      return h('div', {}, [
        h('button', {
          class: 'btn', type: 'button', disabled: dis,
          onClick: () => {
            if (!navigator.geolocation) return set('浏览器不支持定位')
            if (!navigator.geolocation) return
            navigator.geolocation.getCurrentPosition(
              p => set(`${p.coords.latitude.toFixed(6)},${p.coords.longitude.toFixed(6)}`),
              () => import('./ui.js').then(m => m.toast('定位失败，请检查浏览器定位权限', 'err')),
              { enableHighAccuracy: true, timeout: 8000 }
            )
          }
        }, '📍 获取当前位置'),
        val ? h('div', { class: 'tag brand', style: 'margin-top:8px' }, String(val)) : null
      ])
    case 'sort': {
      const arr = Array.isArray(val) && val.length ? val : field.options.map(o => o.value)
      return h('div', {}, arr.map((v, i) => {
        const opt = field.options.find(o => o.value === v) || { label: v, value: v }
        return h('div', { class: 'opt', key: v }, [
          h('span', { class: 'num' }, String(i + 1)),
          h('span', { style: 'flex:1' }, opt.label),
          !dis ? h('span', { class: 'flex', style: 'gap:2px' }, [
            h('button', { class: 'btn ghost sm', disabled: i === 0, onClick: () => move(i, i - 1) }, '↑'),
            h('button', { class: 'btn ghost sm', disabled: i === arr.length - 1, onClick: () => move(i, i + 1) }, '↓')
          ]) : null
        ])
        function move(a, b) {
          const next = [...arr]
          ;[next[a], next[b]] = [next[b], next[a]]
          set(next)
        }
      }))
    }
    case 'cascader':
      return h('select', {
        class: 'select', disabled: dis, value: val ?? '', onChange: e => set(e.target.value)
      }, [h('option', { value: '' }, '请选择'), ...field.options.map(o => h('option', { value: o.value }, o.label))])
    case 'carousel': {
      return h('div', {}, [
        h('div', { style: 'display:flex;gap:8px;overflow-x:auto;padding-bottom:4px' },
          field.options.map((o, i) => h('label', {
            class: ['opt', String(val) === String(o.value) ? 'sel' : ''],
            key: o.value + i, style: 'flex:none;min-width:120px;flex-direction:column;align-items:center;padding:14px'
          }, [
            h('input', {
              type: 'radio', name: field.id, checked: String(val) === String(o.value), disabled: dis,
              onChange: () => set(o.value)
            }),
            h('span', { style: 'margin-top:6px' }, o.label)
          ])))
      ])
    }
    case 'subform': {
      const rows = Array.isArray(val) ? val : []
      const fields = field.props?.fields || []
      return h('div', {}, [
        ...rows.map((row, ri) => h('div', { class: 'card pad', style: 'margin-bottom:8px;background:var(--panel-2)' }, [
          h('div', { class: 'flex between mb' }, [
            h('b', { class: 'small' }, `第 ${ri + 1} 项`),
            !dis ? h('button', {
              class: 'btn ghost sm', onClick: () => set(rows.filter((_, j) => j !== ri))
            }, '删除') : null
          ]),
          ...fields.map(sf => h('div', { class: 'field' }, [
            h('label', {}, sf.label),
            h('input', {
              class: 'input', value: row[sf.id] ?? '', disabled: dis,
              onInput: e => {
                const next = rows.map((r, j) => j === ri ? { ...r, [sf.id]: e.target.value } : r)
                set(next)
              }
            })
          ]))
        ])),
        !dis ? h('button', {
          class: 'btn sm', onClick: () => set([...rows, {}])
        }, '+ 添加一项') : null
      ])
    }
    case 'captcha': {
      const { a, b } = captchaChallenge(field.id)
      return h('div', {}, [
        h('div', { class: 'flex', style: 'gap:8px' }, [
          h('input', {
            class: 'input', placeholder: '请输入计算结果', value: val ?? '', disabled: dis,
            onInput: e => set(e.target.value)
          }),
          h('div', { class: 'tag brand', style: 'height:38px;font-size:14px;letter-spacing:1px;font-weight:600;padding:0 12px;flex:none' }, `${a} + ${b} = ?`)
        ])
      ])
    }
    case 'image':
      return h('div', { style: 'border-radius:12px;overflow:hidden' }, h('img', {
        src: field.props?.src || '/assets/eqs-logo.png', style: 'width:100%;max-height:240px;object-fit:cover'
      }))
    case 'divider':
      return h('hr', { style: 'border:none;border-top:1px solid var(--line);margin:6px 0' })
    case 'richtext':
      return h('div', { style: 'font-size:13.5px;color:var(--text-2);line-height:1.8', innerHTML: sanitize(field.props?.html || '') })
    case 'qrcode':
      return h('div', { class: 'flex' }, [
        h('input', { class: 'input', placeholder: '扫码或手动输入', value: val ?? '', onInput: e => set(e.target.value) }),
        h('button', { class: 'btn', type: 'button', onClick: () => toastOnce() }, '扫码')
      ])
    default:
      return h('input', { class: 'input', value: val ?? '', onInput: e => set(e.target.value) })
  }
}

function toastOnce() {
  import('./ui.js').then(m => m.toast('当前为预览模式，扫码需在浏览器中授权摄像头'))
}

/** 与服务端 lib/forms.js 中 captchaChallenge 完全一致的算式，答案由服务端校验 */
export function captchaChallenge(id) {
  const sum = String(id || '').split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) || 1
  return { a: (sum % 7) + 2, b: (sum % 5) + 2 }
}

function inputHint(type) {
  return { email: 'name@example.com', phone: '请输入 11 位手机号', idcard: '请输入 18 位身份证号', number: '请输入数字' }[type] || '请输入'
}

function sanitize(html) {
  return String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/on\w+="[^"]*"/gi, '')
}

function initSignature(canvas, onChange) {
  canvas.dataset.init = '1'
  const ctx = canvas.getContext('2d')
  ctx.lineWidth = 2.2
  ctx.lineCap = 'round'
  ctx.strokeStyle = '#1b2333'
  let drawing = false
  const pos = e => {
    const r = canvas.getBoundingClientRect()
    const t = e.touches?.[0] || e
    return { x: (t.clientX - r.left) * (canvas.width / r.width), y: (t.clientY - r.top) * (canvas.height / r.height) }
  }
  const start = e => { drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault() }
  const move = e => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault() }
  const end = () => { if (!drawing) return; drawing = false; onChange(canvas.toDataURL('image/png')) }
  canvas.addEventListener('mousedown', start)
  canvas.addEventListener('mousemove', move)
  canvas.addEventListener('mouseup', end)
  canvas.addEventListener('mouseleave', end)
  canvas.addEventListener('touchstart', start, { passive: false })
  canvas.addEventListener('touchmove', move, { passive: false })
  canvas.addEventListener('touchend', end)
}

/** 渲染整张表单（预览 / 公开填写） */
export function FormRenderer({ schema, model, readonly = false, onChange, onUpload, brand, errors = [] }) {
  const visible = schema.filter(f => fieldVisible(f, model))
  const errOf = (f) => (errors || []).find(m => m && f.label && m.startsWith(f.label))
  return h('div', {}, visible.map(f => {
    const message = errOf(f)
    return h('div', {
      class: ['q-block', message ? 'has-err' : ''],
      key: f.id,
      'data-field': f.id
    }, [
      FieldLabel(f),
      f.description ? h('div', { class: 'q-desc' }, f.description) : null,
      renderControl(f, model, { readonly, onChange, onUpload }),
      message ? h('div', { class: 'q-err' }, message) : null
    ])
  }))
}

export { findMeta, escapeHtml }
