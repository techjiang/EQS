import { h } from '/vendor/vue.esm.js'
import { escapeHtml } from './ui.js'
// 逻辑规则的唯一实现，服务端 import 的是同一个文件
import { buildFlow, renderText, OP_LABELS, evalFormula, roundTo } from './flow.js'
// 级联的层级计算也放在共享文件里：渲染、判分、统计、导出必须是同一套父子关系
import { cascadeChildren, cascadePathOf, cascadeLabelPath, normalizeCascade } from './cascade.js'

const findMeta = (type) => type

function FieldLabel(f) {
  if (['divider', 'richtext', 'html', 'image'].includes(f.type)) return null
  return h('div', { class: 'q-title' }, [
    h('span', {}, f.label || '未命名题目'),
    f.required ? h('span', { class: 'req' }, '*') : null
  ])
}

/**
 * 条件显隐。真正实现搬到 flow.js：那份文件服务端也会 import，
 * 这样「页面上能提交」和「服务端认为能提交」不可能出现两种答案。
 */
export function fieldVisible(field, data) {
  const flow = buildFlow([field], data)
  return flow.visible.get(field.id) !== false
}

/** 题干 / 说明里的 {{字段}} 换成作答；不认识的引用给空串而不是把 {{xxx}} 原样留着 */
export { renderText, OP_LABELS }

/**
 * 输入控件的值绑定。
 * textarea 的 value 是内容而不是 attribute：在 h() 里写 value 只会写进 attribute，
 * 用户敲字后 Vue 重渲染，内容会被属性里的旧值顶掉——看起来像「输入框吞字」「已填内容变回空白」。
 * 表单填写区一律走这里：值是属性，内容靠 DOM property 同步，再加上 onInput 写回 model。
 */
function modelValue(props) {
  return {
    value: props.value,
    onVnodeMounted: (vnode) => {
      const el = vnode.el
      if (el && el.tagName === 'TEXTAREA' && el.value !== String(props.value ?? '')) el.value = props.value ?? ''
    },
    onVnodeUpdated: (vnode) => {
      const el = vnode.el
      if (!el || el.tagName !== 'TEXTAREA') return
      // 只在内容真的不一致时写，避免打断光标位置
      if (el.value !== String(props.value ?? '')) el.value = props.value ?? ''
    }
  }
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
        onInput: e => set(e.target.value),
        ...modelValue({ value: val ?? '' })
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
              // 从 model 取当前值，而不是闭包里渲染时的快照：
              // 连点几下时快照是旧的，会把前几项的选择覆盖掉
              const cur = Array.isArray(model[field.id]) ? model[field.id] : []
              const next = new Set(cur.map(String))
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
      // 没作答时星星要显示「未评分」，不能默认点亮 cur>i 的第一颗：
      // 默认值模型里是 ''，静默点亮星星会让用户以为已经答完了，考试里等于白送一分
      const cur = val === '' || val === null || val === undefined ? 0 : Number(val)
      return h('div', { class: 'flex', style: 'gap:4px;font-size:26px;line-height:1.2' }, Array.from({ length: max }, (_, i) =>
        h('span', {
          key: i, role: 'button', 'aria-label': `${i + 1} 分`,
          // 未选中的星星用浅灰描边而不是描边字符：☆ 在部分字体里会淡到看不见，整题像空白
          style: `cursor:${dis ? 'default' : 'pointer'};color:${cur > i ? '#f59e0b' : 'var(--text-3)'};opacity:${cur > i ? 1 : .45};transition:.1s`,
          onClick: () => !dis && set(i + 1)
        }, '★')))
    }
    case 'nps': {
      const max = Number(field.props?.max) || 10
      const [from, to] = npsRange(field)
      return h('div', {}, [
        h('div', { class: 'flex wrap', style: 'gap:6px' }, Array.from({ length: to - from + 1 }, (_, i) =>
          h('button', {
            key: i, type: 'button',
            class: ['btn', 'sm', val !== '' && val !== null && val !== undefined && Number(val) === from + i ? 'primary' : ''],
            style: 'min-width:34px',
            onClick: () => !dis && set(from + i)
          }, String(from + i)))),
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
      // 用自带样式的矩阵表，不要复用 .table：那张表在窄屏有 620px 的 min-width，
      // 于是 390px 的手机上矩阵题只能看见「行名 + 第一列」，剩下的列要横滚才找得到
      return h('div', { class: 'matrix-wrap' }, [
        h('table', { class: 'matrix-tbl' }, [
          h('thead', {}, h('tr', {}, [
            h('th', {}, ''),
            ...field.options.map(o => h('th', { style: 'text-align:center' }, o.label))
          ])),
          h('tbody', {}, rows.map(row => h('tr', { key: row }, [
            h('td', { style: 'font-weight:520' }, row),
            ...field.options.map(o => h('td', { style: 'text-align:center' }, h('input', {
              type: 'radio', name: `${field.id}_${row}`, checked: obj[row] === o.value, disabled: dis,
              style: 'accent-color:var(--brand)',
              // 必须从 model 取当前值再合并：obj 是渲染那一刻的快照，
              // 连点几行时每一行都拿旧快照覆盖，最后只剩最后点的那一行——
              // 「请评价这几个方面」变成只答了一个方面，必填校验和判分都跟着错
              onChange: () => set({ ...(model[field.id] && typeof model[field.id] === 'object' ? model[field.id] : {}), [row]: o.value })
            })))
          ])))
        ])
      ])
    }
    case 'file': case 'upload': {
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
      /*
       * 排序题的默认值是「题目里的全部选项」，可它不是选出来的答案：
       * 只要一个人碰了这一题，就必须留下一个明确而且能被校验的作答。
       * 以前默认就填好、直接提交也能过，服务端的必填校验同样认为「数组非空 = 已作答」——
       * 于是「请把下列选项按重要性排序」这道题，一个字没动也算填完了。
       * 现在未作答时数组为空，展示用初始顺序，动一下才把顺序写入作答。
       */
      const picked = Array.isArray(val) && val.length ? val : []
      const arr = picked.length ? picked : field.options.map(o => o.value)
      return h('div', {}, [
        !picked.length ? h('div', { class: 'small muted', style: 'margin-bottom:6px' }, '用上下箭头调整顺序，调整后才算作答') : null,
        ...arr.map((v, i) => {
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
        })
      ])
    }
    case 'cascader': {
      /*
       * 真的级联：按层级渲染 N 个下拉，第 N 个只列「上一个已选项的子项」。
       * 以前这里和普通下拉完全一样，三个选项目的地 / 省份 / 城市并排放着，
       * 「级联」两个字只存在于题型名称里。
       *
       * 作答仍然只存**最末一级的值**（不是整条路径）：这样一道老问卷的数据、
       * 一个标准答案、一次判分比对都不用改口径，路径需要时按父子关系从值倒推出来。
       */
      const opts = normalizeCascade(field.options)
      const path = cascadePathOf(opts, val)
      const levels = []
      let parent = ''
      // 最多渲染到「当前已选路径的下一层」或选项树的最大深度，10 层是防止脏数据把页面拖死
      for (let i = 0; i < 10; i++) {
        const kids = cascadeChildren(opts, parent)
        if (!kids.length) break
        levels.push({ parent, kids, picked: path[i] || '' })
        const picked = path[i]
        if (!picked) break
        parent = picked
      }
      if (!levels.length) return h('div', { class: 'hint' }, '这道题还没有设置级联选项')
      return h('div', {}, [
        h('div', { class: 'flex wrap', style: 'gap:8px;align-items:center' },
          levels.map((lv, i) => h('select', {
            key: 'lv' + i,
            class: 'select',
            style: 'flex:1;min-width:130px',
            disabled: dis,
            value: lv.picked,
            onChange: e => {
              // 改上层就把下层一起丢掉：留着「江苏省 / 杭州市」这种组合比空着更糟
              set(e.target.value)
            }
          }, [
            h('option', { value: '' }, i === 0 ? '请选择' : '请选择' + (i > 1 ? '下级' : '下级')),
            ...lv.kids.map(o => h('option', { value: o.value }, o.label))
          ]))),
        // 选完把整条路径贴出来：三级下拉里只看最后一格，人容易忘了自己上面选的是哪个省
        val ? h('div', { class: 'small muted', style: 'margin-top:6px' }, '已选：' + (cascadeLabelPath(opts, val) || String(val))) : null
      ])
    }
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
              type: sf.type === 'number' ? 'number' : sf.type === 'date' ? 'date' : sf.type === 'email' ? 'email' : 'text',
              placeholder: sf.type === 'phone' ? '手机号' : '',
              onInput: e => {
                const next = rows.map((r, j) => j === ri ? { ...r, [sf.id]: e.target.value } : r)
                set(next)
              }
            })
          ]))
        ])),
        !dis ? h('button', {
          // 新行要带上字段的空值：只塞 {} 会让「填了又删空」和「从没填过」看起来一样
          class: 'btn sm', onClick: () => set([...rows, Object.fromEntries(fields.map(sf => [sf.id, '']))])
        }, '+ 添加一项') : null
      ])
    }
    case 'captcha': {
      // 优先用服务端下发的题面（公开填写页），预览态没有就本地按同一算式算
      const { a, b } = field.challenge || captchaChallenge(field.id)
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
    case 'calculate': {
      // 单独用 renderControl 的地方（答卷详情、批阅面板）也要能画出这道题
      const v = evalFormula(field.props?.formula, opts.schema || [field], model)
      const shown = v === null ? (val ?? '') : roundTo(v, field.props?.precision)
      return h('div', { class: 'flex', style: 'gap:8px;align-items:center' }, [
        h('span', { class: 'calc-value' }, String(shown === '' ? 0 : shown)),
        field.props?.unit ? h('span', { class: 'small muted' }, field.props.unit) : null,
        h('span', { class: 'small muted' }, '自动计算')
      ])
    }
    case 'image':
      if (!field.props?.src) return h('div', { class: 'hint' }, '未设置图片地址')
      return h('div', { style: 'border-radius:12px;overflow:hidden' }, h('img', {
        src: field.props.src, style: 'width:100%;max-height:240px;object-fit:cover'
      }))
    case 'html':
      return h('div', { style: 'font-size:13.5px;color:var(--text-2);line-height:1.8', innerHTML: sanitize(field.props?.html || '') })
    case 'divider':
      return h('hr', { style: 'border:none;border-top:1px solid var(--line);margin:6px 0' })
    case 'richtext':
      return h('div', { style: 'font-size:13.5px;color:var(--text-2);line-height:1.8', innerHTML: sanitize(field.props?.html || '') })
    case 'qrcode':
      return h('div', {}, [
        h('div', { class: 'flex' }, [
          h('input', {
            class: 'input', placeholder: '扫码或手动输入', value: val ?? '', disabled: dis,
            onInput: e => set(e.target.value)
          }),
          h('button', {
            class: 'btn', type: 'button', disabled: dis,
            onClick: () => scanCode(set)
          }, '扫码')
        ])
      ])
    default:
      return h('input', { class: 'input', value: val ?? '', onInput: e => set(e.target.value) })
  }
}

/**
 * 扫码：浏览器支持 BarcodeDetector 且拿得到摄像头就真扫，否则老实说清楚。
 * 以前这个按钮固定弹「预览模式」，正式填写页点它也是同一句话——等于没做这个组件。
 */
async function scanCode(set) {
  const { toast } = await import('./ui.js')
  const Detector = globalThis.BarcodeDetector
  if (!Detector) {
    toast('当前浏览器不支持摄像头扫码，请手动输入或换用 Chrome / Edge / 安卓浏览器')
    return
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('当前环境不支持摄像头（需要 HTTPS 或 localhost）')
    return
  }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
  } catch {
    toast('没有拿到摄像头权限，请允许后重试，或手动输入')
    return
  }
  const wrap = document.createElement('div')
  wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.82);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px'
  const video = document.createElement('video')
  video.setAttribute('playsinline', 'true')
  video.style.cssText = 'width:min(86vw,460px);border-radius:16px;background:#000'
  video.srcObject = stream
  const tip = document.createElement('div')
  tip.textContent = '把二维码放进画面里'
  tip.style.cssText = 'color:#fff;font-size:13px;opacity:.85'
  const cancel = document.createElement('button')
  cancel.textContent = '取消'
  cancel.className = 'btn'
  const stop = () => {
    stream.getTracks().forEach(t => t.stop())
    wrap.remove()
    clearInterval(timer)
  }
  cancel.onclick = stop
  wrap.append(video, tip, cancel)
  document.body.appendChild(wrap)
  await video.play().catch(() => {})
  const detector = new Detector({ formats: ['qr_code', 'code_128', 'ean_13'] })
  const timer = setInterval(async () => {
    if (video.readyState < 2) return
    try {
      const codes = await detector.detect(video)
      if (codes?.length) {
        set(codes[0].rawValue)
        stop()
        toast('已识别：' + codes[0].rawValue.slice(0, 40))
      }
    } catch {}
  }, 350)
}

/** 与服务端 lib/forms.js 中 captchaChallenge 完全一致的算式，答案由服务端校验 */
export function captchaChallenge(id) {
  const sum = String(id || '').split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) || 1
  return { a: (sum % 7) + 2, b: (sum % 5) + 2 }
}

/** NPS 区间：默认 0-10，props.min 可下探到负数（比如 -2 到 2 的意愿度） */
export function npsRange(field) {
  const from = field?.props?.min === undefined ? 0 : Number(field.props.min)
  const to = Number(field.props?.max ?? 10)
  return [from, Math.max(from, Number.isFinite(to) ? to : 10)]
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

/**
 * 作答 → 人能读的一行。与服务端 lib/forms.js 的 answerText 同一口径：
 * 排序题的数组顺序就是答案，用 → 连起来才看得出「他排成了这样」；
 * 矩阵题是 {行: 列}，join('、') 出来是「5、5」，看不出哪行是哪行；
 * 子表单是对象数组，直接 join 是一串 [object Object]。
 */
export function answerDisplay(field, value) {
  const type = field?.type
  if (value === undefined || value === null || value === '') return ''
  // 级联只存末级值：表格里必须铺成完整路径，否则一列「西湖区」谁也认不出是哪儿
  if (type === 'cascader') {
    const path = cascadeLabelPath(field.options, Array.isArray(value) ? value[value.length - 1] : value)
    return path || String(value)
  }
  if (type === 'matrix') {
    const rows = Array.isArray(field?.props?.rows) ? field.props.rows : []
    if (Array.isArray(value)) return value.map((v, i) => (rows[i] ? `${rows[i]}：${v}` : String(v))).join(' · ')
    const obj = value && typeof value === 'object' ? value : {}
    const keys = rows.length ? rows : Object.keys(obj)
    return keys.map(r => [r, obj[r]]).filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
      .map(([r, v]) => `${r}：${v}`).join(' · ')
  }
  if (type === 'subform') {
    const labels = Object.fromEntries((field.props?.fields || []).map(sf => [sf.id, sf.label]))
    return (Array.isArray(value) ? value : []).map((row, i) => {
      const text = Object.entries(row || {}).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
        .map(([k, v]) => `${labels[k] || k}：${v}`).join(' / ')
      return text ? `${i + 1}. ${text}` : ''
    }).filter(Boolean).join('\n')
  }
  if (Array.isArray(value)) {
    if (type === 'sort') return value.map(String).join(' → ')
    return value.map(v => (v && typeof v === 'object' ? (v.name || v.url || JSON.stringify(v)) : String(v))).join('、')
  }
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}：${v}`).join('；')
  return String(value).length > 200 ? String(value).slice(0, 200) + '…' : String(value)
}

/**
 * 渲染整张表单（预览 / 公开填写）。
 *
 * 这里不再是「filter 一下显隐就把剩下的画出来」，而是先跑一遍逻辑：
 *  - 显隐       隐藏的不画
 *  - 动态必填   星号跟着当前作答变（选了「其他」才必填，而不是从头到尾都标红）
 *  - 计算       calculate 渲染成只读、带公式说明
 *  - 自动填入   fill 规则算出来的值直接体现在值上
 *  - 条件跳转   命中就停下，并在那个位置说明「为什么到此为止」
 *  - 文本替换   题干、说明里的 {{字段}} 换成作答（"您选择了 {{q1}}"）
 */
export function FormRenderer({ schema, model, readonly = false, onChange, onUpload, brand, errors = [] }) {
  /*
   * 计算 / 自动填入的值要写回 model，而且只能用 model 当渲染源。
   * 曾经试过「另建一份 flow.data 传下去渲染」：那份是普通对象，不参与 Vue 的依赖追踪，
   * 于是填了单价、合计金额仍然是 0——看起来像公式没生效，其实是渲染根本不重算。
   */
  const flow = buildFlow(schema, model)
  for (const f of schema) {
    if (!(f.type === 'calculate' || f.fill)) continue
    const v = flow.data[f.id]
    if (v !== undefined && model[f.id] !== v) model[f.id] = v
  }
  const errOf = (f) => (errors || []).find(m => m && f.label && m.startsWith(f.label))
  const blocks = []
  for (const f of schema) {
    if (!flow.active.has(f.id)) continue
    const message = errOf(f)
    const required = flow.required.get(f.id)
    const label = renderText(f.label, schema, flow.data)
    const desc = f.description ? renderText(f.description, schema, flow.data) : ''
    blocks.push(h('div', {
      class: ['q-block', message ? 'has-err' : ''],
      key: f.id,
      'data-field': f.id
    }, [
      FieldLabel({ ...f, label, required }),
      desc ? h('div', { class: 'q-desc' }, desc) : null,
      renderControl(f, model, { readonly, onChange, onUpload, schema }),
      message ? h('div', { class: 'q-err' }, message) : null
    ]))
    // 跳转提示放在触发题下面，而不是页面顶部：用户要知道「是这道题把我送走了」
    if (flow.stopped && flow.stopFieldId === f.id) {
      blocks.push(h('div', { class: 'q-stop', key: f.id + '_stop' }, flow.stopText || '根据您的作答，后面的题目无需填写。'))
    }
  }
  return h('div', {}, blocks)
}

export { findMeta, escapeHtml }
