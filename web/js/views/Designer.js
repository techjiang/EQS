import { h, ref, computed, onMounted, watch } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { navigate, route } from '../router.js'
import { Icon } from '../icons.js'
import { ok, err, confirmBox, promptBox } from '../ui.js'
import { FIELD_GROUPS, blankField, fieldMeta, hasOptions, defaultData, uid } from '../fields.js'
import { renderControl, FormRenderer, fieldVisible } from '../renderer.js'
import { state } from '../store.js'

export default {
  setup() {
    const id = Number(route.value.path.split('/')[2])
    const form = ref({ title: '', description: '', kind: 'survey', schema: [], settings: {}, status: 'draft' })
    const activeIdx = ref(-1)
    const tab = ref('field')
    const saving = ref(false)
    const dragType = ref(null)
    const loading = ref(true)
    const preview = ref(false)
    const aiOpen = ref(false)
    const aiPrompt = ref('')
    const aiBusy = ref(false)
    const importOpen = ref(false)
    const importText = ref('')

    const load = async () => {
      try {
        const r = await api.get(`/api/forms/${id}`)
        form.value = r.data
        if (!form.value.settings) form.value.settings = {}
      } catch (e) { err(e.message) } finally { loading.value = false }
    }
    onMounted(load)

    const active = computed(() => form.value.schema[activeIdx.value] || null)

    const save = async (silent = false) => {
      if (saving.value) return
      saving.value = true
      try {
        await api.put(`/api/forms/${id}`, {
          title: form.value.title,
          description: form.value.description,
          kind: form.value.kind,
          schema: form.value.schema,
          settings: form.value.settings,
          status: form.value.status
        })
        if (!silent) ok('已保存')
      } catch (e) { err(e.message) } finally { saving.value = false }
    }

    let timer = null
    watch(() => [form.value.title, form.value.description, form.value.schema, form.value.settings], () => {
      clearTimeout(timer)
      timer = setTimeout(() => save(true), 1500)
    }, { deep: true })

    const addField = (type, index = null) => {
      const f = blankField(type)
      const at = index === null ? form.value.schema.length : index
      form.value.schema.splice(at, 0, f)
      activeIdx.value = at
      tab.value = 'field'
    }

    const onDrop = (e, index) => {
      e.preventDefault()
      const type = dragType.value || e.dataTransfer.getData('text/plain')
      if (type) addField(type, index)
      dragType.value = null
    }

    const move = (from, to) => {
      if (to < 0 || to >= form.value.schema.length) return
      const arr = form.value.schema
      const [item] = arr.splice(from, 1)
      arr.splice(to, 0, item)
      activeIdx.value = to
    }

    const del = (i) => {
      form.value.schema.splice(i, 1)
      activeIdx.value = Math.min(i, form.value.schema.length - 1)
    }

    const duplicate = (i) => {
      const copy = JSON.parse(JSON.stringify(form.value.schema[i]))
      copy.id = uid()
      form.value.schema.splice(i + 1, 0, copy)
      activeIdx.value = i + 1
    }

    const addOption = () => {
      const f = active.value
      if (!f) return
      f.options.push({ label: `选项 ${f.options.length + 1}`, value: `选项 ${f.options.length + 1}` })
    }

    const removeOption = (i) => {
      active.value.options.splice(i, 1)
    }

    const syncOptionValue = (o) => { o.value = o.label }

    const addLogic = () => {
      if (!active.value) return
      const others = form.value.schema.filter(f => f.id !== active.value.id)
      if (!others.length) return err('至少需要其他题目才能设置逻辑')
      active.value.logic.push({ fieldId: others[0].id, op: 'eq', value: '' })
    }

    const publishToggle = async () => {
      await save(true)
      form.value.status = form.value.status === 'published' ? 'draft' : 'published'
      await save(true)
      ok(form.value.status === 'published' ? '已发布，可以对外收集了' : '已取消发布')
    }

    const copyLink = () => {
      const url = `${location.origin}/f/${id}`
      navigator.clipboard.writeText(url).then(() => ok('填写链接已复制')).catch(() => prompt('复制链接', url))
    }

    const doAi = async () => {
      if (!aiPrompt.value.trim()) return err('请先描述你想要的表单')
      aiBusy.value = true
      try {
        const r = await api.post('/api/ai/generate', { prompt: aiPrompt.value, kind: form.value.kind })
        form.value.schema = r.data.schema
        if (!form.value.description) form.value.description = r.data.description
        aiOpen.value = false
        await save(true)
        ok(r.source === 'ai' ? 'AI 已生成题目' : 'AI 未配置，已用本地模板生成')
      } catch (e) { err(e.message) } finally { aiBusy.value = false }
    }

    const doImport = async () => {
      try {
        const r = await api.post(`/api/forms/${id}/import-text`, { text: importText.value })
        form.value.schema = r.schema
        importOpen.value = false
        importText.value = ''
        ok(`已导入 ${r.added} 道题`)
      } catch (e) { err(e.message) }
    }

    const set = (key, val) => { form.value.settings[key] = val }
    const sget = (key, dft) => form.value.settings[key] ?? dft

    const previewData = computed(() => defaultData(form.value.schema))
    const previewModel = ref({})
    watch(previewData, v => previewModel.value = v, { immediate: true })

    /* ---------- 右侧检查器 ---------- */
    const fieldInspector = () => {
      const f = active.value
      if (!f) return h('div', { class: 'muted small center', style: 'padding:30px 0' }, '选中左侧题目后可编辑属性')
      const row = (label, node, hint) => h('div', { class: 'field' }, [h('label', {}, label), node, hint ? h('div', { class: 'hint' }, hint) : null])
      return h('div', {}, [
        h('h4', {}, [h('span', {}, '组件属性'), h('span', { class: 'tag brand' }, fieldMeta(f.type).label)]),
        row('标题', h('input', { class: 'input', value: f.label, onInput: e => f.label = e.target.value })),
        h('div', { class: 'field' }, h('label', { class: 'flex between' }, [
          h('span', {}, '必填'),
          h('div', { class: ['switch', f.required ? 'on' : ''], onClick: () => f.required = !f.required })
        ])),
        row('提示文字', h('input', { class: 'input', value: f.placeholder, placeholder: '输入框占位符', onInput: e => f.placeholder = e.target.value })),
        row('说明', h('input', { class: 'input', value: f.description, placeholder: '题目下方的说明', onInput: e => f.description = e.target.value })),
        hasOptions(f.type) ? h('div', { class: 'field' }, [
          h('label', { class: 'flex between' }, [
            h('span', {}, f.type === 'matrix' ? '评分列' : '选项'),
            h('button', { class: 'btn ghost sm', onClick: addOption }, '+ 添加')
          ]),
          f.options.map((o, i) => h('div', { class: 'opt-row' }, [
            h('input', { class: 'input', value: o.label, onInput: e => { o.label = e.target.value; o.value = e.target.value } }),
            h('button', { onClick: () => removeOption(i) }, '×')
          ]))
        ]) : null,
        f.type === 'matrix' ? h('div', { class: 'field' }, [
          h('label', { class: 'flex between' }, [
            h('span', {}, '矩阵行'),
            h('button', {
              class: 'btn ghost sm', onClick: () => {
                f.props.rows = f.props.rows || []
                f.props.rows.push('新行 ' + (f.props.rows.length + 1))
              }
            }, '+ 添加')
          ]),
          (f.props.rows || []).map((rowName, i) => h('div', { class: 'opt-row' }, [
            h('input', {
              class: 'input', value: rowName,
              onInput: e => f.props.rows[i] = e.target.value
            }),
            h('button', { onClick: () => f.props.rows.splice(i, 1) }, '×')
          ]))
        ]) : null,
        ['rate', 'nps', 'slider'].includes(f.type) ? h('div', { class: 'row' }, [
          row('最大/上限', h('input', {
            class: 'input', type: 'number', value: f.props?.max ?? '',
            onInput: e => { f.props = { ...f.props, max: Number(e.target.value) } }
          })),
          f.type === 'slider' ? row('最小值', h('input', {
            class: 'input', type: 'number', value: f.props?.min ?? 0,
            onInput: e => { f.props = { ...f.props, min: Number(e.target.value) } }
          })) : null
        ]) : null,
        ['upload', 'file'].includes(f.type) ? h('div', {}, [
          h('div', { class: 'field' }, h('label', { class: 'flex between' }, [
            h('span', {}, '允许多选'),
            h('div', { class: ['switch', f.props?.multiple ? 'on' : ''], onClick: () => f.props.multiple = !f.props.multiple })
          ])),
          row('大小限制 (MB)', h('input', {
            class: 'input', type: 'number', value: f.props?.maxSize ?? 20,
            onInput: e => f.props.maxSize = Number(e.target.value)
          }))
        ]) : null,
        ['richtext', 'html'].includes(f.type) ? row('内容（支持 HTML）', h('textarea', {
          class: 'textarea mono', style: 'min-height:90px', value: f.props?.html || '',
          onInput: e => f.props.html = e.target.value
        })) : null,
        f.type === 'image' ? row('图片地址', h('input', {
          class: 'input', value: f.props?.src || '', placeholder: 'https://…',
          onInput: e => f.props.src = e.target.value
        })) : null,
        ['radio', 'checkbox', 'select', 'rate', 'nps', 'text', 'textarea', 'number', 'date'].includes(f.type) ? h('div', {}, [
          h('div', { class: 'field' }, [h('label', {}, '默认值'), h('input', {
            class: 'input', value: f.defaultValue,
            onInput: e => f.defaultValue = e.target.value
          })]),
          h('div', { class: 'row' }, [
            row('分值（考试用）', h('input', {
              class: 'input', type: 'number', value: f.score || 0,
              onInput: e => f.score = Number(e.target.value)
            }))
          ]),
          hasOptions(f.type) ? h('div', { class: 'field' }, [
            h('label', {}, '正确答案（逗号分隔，用于自动评分）'),
            h('input', {
              class: 'input', value: (f.answer || []).join(','),
              onInput: e => f.answer = e.target.value.split(',').map(s => s.trim()).filter(Boolean)
            })
          ]) : null,
          row('答案解析', h('textarea', {
            class: 'textarea', style: 'min-height:64px', value: f.analysis,
            onInput: e => f.analysis = e.target.value
          }))
        ]) : null,
        h('div', { class: 'field' }, [
          h('label', { class: 'flex between' }, [
            h('span', {}, '显示逻辑'),
            h('button', { class: 'btn ghost sm', onClick: addLogic }, '+ 条件')
          ]),
          (f.logic || []).length === 0
            ? h('div', { class: 'hint' }, '无条件下始终显示')
            : f.logic.map((rule, i) => h('div', { style: 'border:1px solid var(--line);border-radius:9px;padding:8px;margin-bottom:6px' }, [
              h('select', {
                class: 'select', style: 'height:30px;margin-bottom:5px', value: rule.fieldId,
                onChange: e => rule.fieldId = e.target.value
              }, form.value.schema.filter(x => x.id !== f.id).map(x => h('option', { value: x.id }, x.label || x.type))),
              h('div', { class: 'flex', style: 'gap:5px' }, [
                h('select', {
                  class: 'select', style: 'height:30px;width:96px', value: rule.op,
                  onChange: e => rule.op = e.target.value
                }, [['eq', '等于'], ['ne', '不等于'], ['contains', '包含'], ['in', '任意等于'], ['gt', '大于'], ['lt', '小于'], ['empty', '为空'], ['notEmpty', '不为空']]
                  .map(([v, l]) => h('option', { value: v }, l))),
                h('input', {
                  class: 'input', style: 'height:30px;flex:1', value: rule.value, placeholder: '比较值',
                  onInput: e => rule.value = e.target.value
                }),
                h('button', { class: 'btn ghost sm', onClick: () => f.logic.splice(i, 1) }, '×')
              ])
            ]))
        ])
      ])
    }

    const settingsInspector = () => {
      const s = form.value.settings
      const row = (label, node, hint) => h('div', { class: 'field' }, [h('label', {}, label), node, hint ? h('div', { class: 'hint' }, hint) : null])
      const sw = (key, label, dft = false) => h('div', { class: 'field' }, h('label', { class: 'flex between' }, [
        h('span', {}, label),
        h('div', { class: ['switch', sget(key, dft) ? 'on' : ''], onClick: () => set(key, !sget(key, dft)) })
      ]))
      return h('div', {}, [
        h('h4', {}, [h('span', {}, '表单设置'), h('span', { class: 'tag', style: 'cursor:pointer', onClick: () => tab.value = 'field' }, '回属性')]),
        row('按钮文字', h('input', {
          class: 'input', value: sget('buttonText', '提交'), onInput: e => set('buttonText', e.target.value)
        })),
        row('提交后文案', h('textarea', {
          class: 'textarea', style: 'min-height:64px', value: sget('submitText', '提交成功，感谢您的参与！'),
          onInput: e => set('submitText', e.target.value)
        })),
        row('提交后跳转网址', h('input', {
          class: 'input', value: sget('redirectUrl', ''), placeholder: 'https://…（留空则不跳转）',
          onInput: e => set('redirectUrl', e.target.value)
        })),
        form.value.kind === 'exam' ? h('div', {}, [
          h('div', { style: 'border-top:1px solid var(--line);margin:14px 0' }),
          h('h4', {}, '考试评分'),
          h('div', { class: 'row' }, [
            row('及格线（%）', h('input', {
              class: 'input', type: 'number', min: 1, max: 100, value: sget('passPercent', 60),
              onInput: e => set('passPercent', Number(e.target.value))
            }), '按卷面总分百分比计算'),
            row('限时（分钟）', h('input', {
              class: 'input', type: 'number', min: 0, value: sget('duration', 0),
              onInput: e => set('duration', Number(e.target.value))
            }), '0 表示不限时')
          ]),
          sw('showResult', '交卷后显示逐题对错与解析', true)
        ]) : null,
        h('div', { style: 'border-top:1px solid var(--line);margin:14px 0' }),
        h('h4', {}, '外观'),
        row('头图 URL', h('input', {
          class: 'input', value: sget('headerImage', ''), placeholder: '头图图片地址',
          onInput: e => set('headerImage', e.target.value)
        })),
        row('背景图 URL', h('input', {
          class: 'input', value: sget('bgImage', ''), placeholder: '页面背景图',
          onInput: e => set('bgImage', e.target.value)
        })),
        row('背景颜色', h('input', {
          class: 'input', type: 'color', style: 'height:38px;padding:4px',
          value: sget('bgColor', '#f6f7fb'), onInput: e => set('bgColor', e.target.value)
        })),
        row('按钮颜色', h('input', {
          class: 'input', type: 'color', style: 'height:38px;padding:4px',
          value: sget('buttonColor', '#5b7cfa'), onInput: e => set('buttonColor', e.target.value)
        })),
        h('div', { style: 'border-top:1px solid var(--line);margin:14px 0' }),
        h('h4', {}, '发布控制'),
        sw('needPassword', '需要访问密码'),
        sget('needPassword') ? row('密码', h('input', {
          class: 'input', value: sget('password', ''), onInput: e => set('password', e.target.value)
        })) : null,
        sw('onlyWechat', '仅限微信内填写'),
        sw('allowQuery', '允许答卷编号查询'),
        sw('recordWechat', '记录微信昵称头像'),
        h('div', { class: 'row' }, [
          row('开始时间', h('input', {
            class: 'input', type: 'datetime-local', value: sget('timeWindow')?.start || '',
            onInput: e => set('timeWindow', { ...(sget('timeWindow') || {}), start: e.target.value })
          })),
          row('结束时间', h('input', {
            class: 'input', type: 'datetime-local', value: sget('timeWindow')?.end || '',
            onInput: e => set('timeWindow', { ...(sget('timeWindow') || {}), end: e.target.value })
          }))
        ]),
        h('div', { style: 'border-top:1px solid var(--line);margin:14px 0' }),
        h('h4', {}, '填写限制'),
        row('最大提交次数', h('input', {
          class: 'input', type: 'number', min: 0, value: sget('limit')?.maxTimes ?? 0,
          onInput: e => set('limit', { ...(sget('limit') || {}), maxTimes: Number(e.target.value) })
        }), '0 表示不限制'),
        row('白名单（每行一个 IP / OpenID / 手机号）', h('textarea', {
          class: 'textarea mono', style: 'min-height:64px',
          value: (sget('whitelist') || []).join('\n'),
          placeholder: '留空表示不限制',
          onInput: e => set('whitelist', e.target.value.split('\n').map(x => x.trim()).filter(Boolean))
        })),
        ...['perWechat', 'perIp', 'perDevice', 'perUser'].map(k => h('div', { class: 'field' }, h('label', { class: 'flex between' }, [
          h('span', {}, { perWechat: '按微信限次', perIp: '按 IP 限次', perDevice: '按设备限次', perUser: '按账号限次' }[k]),
          h('div', {
            class: ['switch', sget('limit')?.[k] ? 'on' : ''],
            onClick: () => set('limit', { ...(sget('limit') || {}), [k]: !sget('limit')?.[k] })
          })
        ]))),
        h('div', { style: 'border-top:1px solid var(--line);margin:14px 0' }),
        h('h4', {}, '通知'),
        row('新答卷通知邮箱', h('input', {
          class: 'input', value: sget('notifyEmail', ''), placeholder: '需要先在系统设置配置 SMTP',
          onInput: e => set('notifyEmail', e.target.value)
        })),
        sw('notifyWx', '微信模板消息提醒')
      ])
    }

    return () => {
      if (loading.value) return h('div', { style: 'padding:60px' }, '加载中…')
      if (preview.value) {
        return h('div', { class: 'fill-page', style: `background:${sget('bgColor', '#f6f7fb')}` }, [
          h('div', {
            class: 'fill-hero',
            style: sget('headerImage') ? `background-image:url(${sget('headerImage')})` : ''
          }, h('h1', {}, form.value.title)),
          h('div', { class: 'fill-card' }, [
            form.value.description ? h('p', { class: 'mb', style: 'color:var(--text-2)' }, form.value.description) : null,
            FormRenderer({ schema: form.value.schema, model: previewModel.value }),
            h('button', {
              class: 'btn primary', style: `width:100%;margin-top:18px;${sget('buttonColor') ? `background:${sget('buttonColor')}` : ''}`
            }, sget('buttonText', '提交')),
            h('div', { class: 'flex between mt' }, [
              h('button', { class: 'btn ghost sm', onClick: () => preview.value = false }, '返回编辑'),
              h('span', { class: 'small muted' }, '预览模式（不会真实提交）')
            ])
          ])
        ])
      }

      return h('div', { class: 'designer' }, [
        // 左侧组件库
        h('div', { class: 'palette' }, [
          h('div', { class: 'flex between', style: 'margin-bottom:10px' }, [
            h('b', { style: 'font-size:14px' }, '组件库'),
            h('button', { class: 'btn ghost sm', onClick: () => navigate('/forms') }, '← 返回')
          ]),
          h('div', { class: 'flex', style: 'gap:6px;margin-bottom:10px' }, [
            h('button', { class: 'btn sm', style: 'flex:1', onClick: () => aiOpen.value = true }, '🤖 AI'),
            h('button', { class: 'btn sm', style: 'flex:1', onClick: () => importOpen.value = true }, '📥 导入')
          ]),
          FIELD_GROUPS.map(g => [
            h('h4', {}, g.name),
            ...g.items.map(it => h('div', {
              class: 'palette-item', draggable: true,
              onDragstart: e => { dragType.value = it.type; e.dataTransfer.setData('text/plain', it.type) },
              onClick: () => addField(it.type)
            }, [h('i', {}, it.icon), h('span', {}, it.label)]))
          ])
        ]),
        // 中间画布
        h('div', { class: 'canvas', onClick: e => { if (e.target.classList.contains('canvas')) activeIdx.value = -1 } }, [
          h('div', { class: 'canvas-inner' }, [
            h('div', { class: 'flex between', style: 'margin-bottom:12px;gap:8px;flex-wrap:wrap' }, [
              h('div', { class: 'flex', style: 'gap:6px' }, [
                h('span', { class: ['tag', form.value.status === 'published' ? 'ok' : 'warn'] }, form.value.status === 'published' ? '已发布' : '草稿'),
                h('span', { class: 'small muted' }, `${form.value.schema.length} 个组件 · 自动保存${saving.value ? '中…' : ''}`)
              ]),
              h('div', { class: 'flex', style: 'gap:6px' }, [
                h('button', { class: 'btn sm', onClick: () => save() }, '保存'),
                h('button', { class: 'btn sm', onClick: () => preview.value = true }, [Icon('eye', { style: 'width:14px;height:14px' }), '预览']),
                h('button', { class: 'btn sm', onClick: copyLink }, '链接'),
                h('button', { class: 'btn sm primary', onClick: publishToggle }, form.value.status === 'published' ? '取消发布' : '发布')
              ])
            ]),
            h('div', { class: 'canvas-head' }, [
              h('input', {
                class: 'input', style: 'border:none;font-size:20px;font-weight:680;padding:0;height:auto;background:transparent',
                value: form.value.title, placeholder: '未命名表单',
                onInput: e => form.value.title = e.target.value
              }),
              h('textarea', {
                class: 'textarea', style: 'border:none;min-height:40px;padding:6px 0 0;background:transparent;font-size:13px',
                value: form.value.description, placeholder: '添加一段描述（可选）',
                onInput: e => form.value.description = e.target.value
              })
            ]),
            h('div', {
              class: 'canvas-body',
              onDragover: e => e.preventDefault(),
              onDrop: e => onDrop(e, form.value.schema.length)
            }, form.value.schema.length === 0
              ? h('div', { class: 'empty' }, [h('div', { style: 'font-size:34px;opacity:.3' }, '⊞'), h('div', {}, '从左侧拖入组件，或点击组件快速添加')])
              : form.value.schema.map((f, i) => h('div', {
                class: ['fs-item', activeIdx.value === i ? 'active' : ''],
                onClick: e => { e.stopPropagation(); activeIdx.value = i; tab.value = 'field' },
                onDragover: e => { e.preventDefault(); e.currentTarget.classList.add('dragover') },
                onDragleave: e => e.currentTarget.classList.remove('dragover'),
                onDrop: e => { e.stopPropagation(); e.currentTarget.classList.remove('dragover'); onDrop(e, i) }
              }, [
                h('div', { class: 'fs-badge' }, `${i + 1} · ${fieldMeta(f.type).label}`),
                h('div', { class: 'fs-tools' }, [
                  h('button', { title: '上移', onClick: e => { e.stopPropagation(); move(i, i - 1) } }, '↑'),
                  h('button', { title: '下移', onClick: e => { e.stopPropagation(); move(i, i + 1) } }, '↓'),
                  h('button', { title: '复制', onClick: e => { e.stopPropagation(); duplicate(i) } }, '⧉'),
                  h('button', { title: '删除', onClick: e => { e.stopPropagation(); del(i) } }, '×')
                ]),
                ['divider', 'richtext', 'html', 'image'].includes(f.type) ? null : h('div', { class: 'fs-label' }, [
                  h('span', {}, f.label || '未命名题目'),
                  f.required ? h('span', { class: 'req' }, '*') : null
                ]),
                f.description ? h('div', { class: 'fs-desc' }, f.description) : null,
                h('div', { style: 'pointer-events:none' }, renderControl(f, previewModel.value))
              ])))
          ])
        ]),
        // 右侧属性
        h('div', { class: 'inspector' }, [
          h('div', { class: 'tabs' }, [
            h('button', { class: tab.value === 'field' ? 'on' : '', onClick: () => tab.value = 'field' }, '组件'),
            h('button', { class: tab.value === 'form' ? 'on' : '', onClick: () => tab.value = 'form' }, '表单设置')
          ]),
          tab.value === 'field' ? fieldInspector() : settingsInspector()
        ]),
        // AI 弹窗
        aiOpen.value ? h('div', { class: 'modal-mask', onClick: e => { if (e.target.classList.contains('modal-mask')) aiOpen.value = false } },
          h('div', { class: 'modal' }, [
            h('div', { class: 'modal-h' }, [h('h3', {}, '🤖 AI 生成表单'), h('button', { class: 'btn ghost sm', onClick: () => aiOpen.value = false }, '关闭')]),
            h('div', { class: 'modal-b' }, [
              h('div', { class: 'field' }, [
                h('label', {}, '描述你想要的表单'),
                h('textarea', {
                  class: 'textarea', style: 'min-height:110px', placeholder: '例如：做一份员工满意度调查，包含对办公环境、团队协作、薪酬福利的评分，以及开放建议',
                  value: aiPrompt.value, onInput: e => aiPrompt.value = e.target.value
                })
              ]),
              h('div', { class: 'hint' }, '需要先在系统设置 → AI 中配置 OpenAI Compatible API；未配置时会使用本地模板生成。')
            ]),
            h('div', { class: 'modal-f' }, [
              h('button', { class: 'btn', onClick: () => aiOpen.value = false }, '取消'),
              h('button', { class: 'btn primary', disabled: aiBusy.value, onClick: doAi }, aiBusy.value ? '生成中…' : '生成题目')
            ])
          ])) : null,
        // 文本导入弹窗
        importOpen.value ? h('div', { class: 'modal-mask', onClick: e => { if (e.target.classList.contains('modal-mask')) importOpen.value = false } },
          h('div', { class: 'modal wide' }, [
            h('div', { class: 'modal-h' }, [h('h3', {}, '批量文本导入'), h('button', { class: 'btn ghost sm', onClick: () => importOpen.value = false }, '关闭')]),
            h('div', { class: 'modal-b' }, [
              h('div', { class: 'hint mb' }, '格式：每题以「1.」或「- 」开头，方括号内写题型（单选/多选/填空/日期/评分…），选项以「A.」开头，可写「答案：A」「分值：5」「解析：…」。'),
              h('textarea', {
                class: 'textarea mono', style: 'min-height:240px', value: importText.value,
                placeholder: '1. 你的性别 [单选]\nA. 男\nB. 女\n答案：A\n\n2. 请描述你的建议 [多行]',
                onInput: e => importText.value = e.target.value
              })
            ]),
            h('div', { class: 'modal-f' }, [
              h('button', { class: 'btn', onClick: () => importOpen.value = false }, '取消'),
              h('button', { class: 'btn primary', onClick: doImport }, '导入')
            ])
          ])) : null
      ])
    }
  }
}
