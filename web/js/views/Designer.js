import { h, ref, computed, onMounted, watch } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { navigate, route } from '../router.js'
import { Icon } from '../icons.js'
import { ok, err, confirmBox, promptBox } from '../ui.js'
import { FIELD_GROUPS, blankField, fieldMeta, hasOptions, defaultData, uid } from '../fields.js'
import { renderControl, FormRenderer, fieldVisible } from '../renderer.js'
import { state } from '../store.js'


/** textarea 的值同步：属性里的 value 不等于内容，直接在 h() 里传 value 会被 DOM 忽略 */
function bindTextarea(value) {
  const sync = (vnode) => {
    const el = vnode.el
    if (el && el.tagName === 'TEXTAREA' && el.value !== String(value ?? '')) el.value = value ?? ''
  }
  return { value, onVnodeMounted: sync, onVnodeUpdated: sync }
}
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
    // 流式生成：边吐边画，liveFields 是「已经完整吐出来的题」
    const aiStreaming = ref(false)
    const aiLiveFields = ref([])
    const aiChars = ref(0)
    const aiModel = ref('')
    const aiLang = ref('zh')
    const aiModels = ref([])
    const aiLangOpts = ref([{ code: 'zh', label: '简体中文' }, { code: 'en', label: 'English' }])
    const aiModelReason = ref('')
    const importOpen = ref(false)
    const importText = ref('')
    const importTab = ref('text')

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

    /**
     * 加载可选模型与语言。
     * 之前「模型」只有一个手填输入框：填错一个字要等到生成时才报 404，还报得看不懂。
     * 现在从 OpenAI Compatible 的 /models 拉真实列表；拿不到就退回手填并说明原因，
     * 不凭空编一串模型名让人挑。
     */
    const loadAiMeta = async () => {
      try {
        const r = await api.get('/api/ai/models')
        aiModels.value = r.data.models || []
        aiLangOpts.value = r.data.langs || aiLangOpts.value
        if (!aiModel.value) aiModel.value = r.data.current || ''
        aiModelReason.value = r.data.reachable ? '' : (r.data.reason || '')
      } catch (e) { aiModelReason.value = e.message }
    }

    /**
     * AI 生成：走流式，边收边画。
     * 原来是一次性 POST，几秒里界面只有「生成中…」。Issue 写的是「流式生成实时预览」，
     * 那这句话就得能看见：每来一帧，已经完整的题直接画到画布上。
     * 生成仍会整体替换现有题目，所以先确认；确认后才把画布清空。
     */
    const doAi = async () => {
      if (!aiPrompt.value.trim()) return err('请先描述你想要的表单')
      if (form.value.schema?.length) {
        const yes = await confirmBox(`AI 生成会替换当前 ${form.value.schema.length} 道题，确定继续？`)
        if (!yes) return
      }
      aiBusy.value = true
      aiStreaming.value = true
      aiLiveFields.value = []
      aiChars.value = 0
      let done = null
      let failure = ''
      try {
        await api.stream('/api/ai/stream', { prompt: aiPrompt.value, kind: form.value.kind, model: aiModel.value || undefined, lang: aiLang.value }, (msg) => {
          if (msg.error) { failure = msg.error; return }
          if (msg.done) { done = msg; return }
          if (Array.isArray(msg.fields)) aiLiveFields.value = msg.fields
          if (msg.delta) aiChars.value += String(msg.delta).length
        })
        const schema = done?.schema?.length ? done.schema : aiLiveFields.value
        if (!schema.length) throw new Error(failure || 'AI 没有返回可用的题目')
        form.value.schema = schema
        if (done?.title) form.value.title = done.title
        if (!form.value.description && done?.description) form.value.description = done.description
        await save(true)
        aiOpen.value = false
        ok(failure ? `AI 未配置，已用本地模板生成（${failure}）` : `AI 已生成 ${schema.length} 道题`)
      } catch (e) { err(e.message) } finally {
        aiBusy.value = false
        aiStreaming.value = false
      }
    }

    const doImport = async () => {
      try {
        const r = await api.post(`/api/forms/${id}/import-text`, { text: importText.value })
        form.value.schema = r.schema
        importOpen.value = false
        importText.value = ''
        ok(`已导入 ${r.added} 道题` + (r.droppedAnswers?.length ? `；${r.droppedAnswers.length} 道题的答案不在选项里，已清空待修正` : ''))
      } catch (e) { err(e.message) }
    }

    /** Excel 导入：解析放在后端，前端只负责把文件递过去 */
    const importXlsx = async (file) => {
      if (!file) return
      try {
        const r = await api.uploadFile(`/api/forms/${id}/import-xlsx`, file)
        form.value.schema = r.schema
        importOpen.value = false
        const skipped = r.skipped?.length ? `，跳过 ${r.skipped.length} 行` : ''
        const unknown = r.unknownColumns?.length ? `；未识别的列已忽略：${r.unknownColumns.join('、')}` : ''
        ok(`已从 Excel 导入 ${r.added} 道题${skipped}${unknown}` + (r.droppedAnswers?.length ? `；${r.droppedAnswers.length} 道题的答案不在选项里，已清空` : ''))
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
        f.type === 'subform' ? h('div', { class: 'field' }, [
          h('label', { class: 'flex between' }, [
            h('span', {}, '子表单字段'),
            h('button', {
              class: 'btn ghost sm', onClick: () => {
                f.props = f.props || {}
                f.props.fields = f.props.fields || []
                f.props.fields.push({ id: uid(), type: 'text', label: '子项 ' + (f.props.fields.length + 1) })
              }
            }, '+ 添加')
          ]),
          (f.props?.fields || []).map((sf, i) => h('div', { class: 'opt-row' }, [
            h('input', {
              class: 'input', value: sf.label,
              onInput: e => { f.props.fields[i] = { ...sf, label: e.target.value } }
            }),
            h('button', {
              onClick: () => {
                if (f.props.fields.length <= 1) return err('子表单至少要保留一个字段')
                f.props.fields.splice(i, 1)
              }
            }, '×')
          ])),
          h('div', { class: 'hint' }, '每行数据按这些字段填写，可随时增删；数据以数组形式保存')
        ]) : null,
        ['richtext', 'html'].includes(f.type) ? row('内容（支持 HTML）', h('textarea', {
          class: 'textarea mono', style: 'min-height:90px', value: f.props?.html || '',
          onInput: e => f.props.html = e.target.value
        })) : null,
        f.type === 'image' ? row('图片地址', h('input', {
          class: 'input', value: f.props?.src || '', placeholder: 'https://…',
          onInput: e => f.props.src = e.target.value
        })) : null,
        /*
         * 计分面板必须覆盖「能计分」的全部题型。
         * 以前这张清单里没有 sort / matrix，于是排序题、矩阵题在设计器里连分值都设不了——
         * 而它们恰恰是最需要按顺序/按行判分的两类。
         */
        ['radio', 'checkbox', 'select', 'rate', 'nps', 'text', 'textarea', 'number', 'date', 'subform', 'sort', 'matrix', 'judge'].includes(f.type) ? h('div', {}, [
          f.type !== 'subform' ? h('div', { class: 'field' }, [h('label', {}, '默认值'), h('input', {
            class: 'input', value: f.defaultValue,
            onInput: e => f.defaultValue = e.target.value
          })]) : null,
          h('div', { class: 'row' }, [
            row('分值（考试用）', h('input', {
              class: 'input', type: 'number', value: f.score || 0,
              onInput: e => f.score = Number(e.target.value)
            }))
          ]),
          // 排序：答案是顺序本身，逗号分隔的输入框写不出「第几位」，只能按顺序点
          f.type === 'sort' ? h('div', { class: 'field' }, [
            h('label', {}, '正确顺序（按顺序点选，再点一次取消）'),
            h('div', { class: 'flex wrap', style: 'gap:6px' }, f.options.map((o, i) => {
              const at = (f.answer || []).indexOf(o.value)
              return h('button', {
                class: ['btn', 'sm', at >= 0 ? 'primary' : ''],
                onClick: () => {
                  const ans = [...(f.answer || [])]
                  const pos = ans.indexOf(o.value)
                  if (pos >= 0) ans.splice(pos, 1); else ans.push(o.value)
                  f.answer = ans
                }
              }, at >= 0 ? `${at + 1}. ${o.label}` : `${String.fromCharCode(65 + i)}. ${o.label}`)
            })),
            h('div', { class: 'hint' }, (f.answer || []).length === f.options.length
              ? '已排完整顺序，判分按这个顺序逐位比'
              : `还有 ${f.options.length - (f.answer || []).length} 个选项没排，答案不完整会让所有人都答错`)
          ]) : f.type === 'matrix' ? h('div', { class: 'field' }, [
            // 矩阵的答案是「每行各选哪一列」，必须逐行给，一个逗号串表达不了
            h('label', {}, '每行的正确答案'),
            (f.props?.rows || []).map((row, i) => h('div', { class: 'flex', style: 'gap:6px;align-items:center;margin-bottom:6px' }, [
              h('span', { class: 'small muted', style: 'min-width:90px' }, row || `第 ${i + 1} 行`),
              h('select', {
                class: 'select', style: 'height:32px',
                value: f.answer?.[i] ?? '',
                onChange: e => {
                  const ans = [...(f.answer || [])]
                  while (ans.length < i) ans.push('')
                  ans[i] = e.target.value
                  f.answer = ans
                }
              }, [h('option', { value: '' }, '不计分'), ...f.options.map(o => h('option', { value: o.value }, o.label))])
            ])),
            h('div', { class: 'hint' }, '每行选一个；留空的行不参与判分')
          ]) : hasOptions(f.type) ? h('div', { class: 'field' }, [
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
          sw('showResult', '交卷后显示逐题对错与解析', true),
          sw('showRank', '交卷后显示我的名次', true),
          sw('showRanking', '公开成绩榜（填写页显示前 10 名）'),
          h('div', { class: 'hint' }, '成绩榜是匿名入口：只公布名次、打码后的昵称和分数，不公开答卷内容。关掉「逐题对错」时名次也不下发。')
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
            h('button', { class: 'btn sm', style: 'flex:1', onClick: () => { aiOpen.value = true; loadAiMeta() } }, '🤖 AI'),
            h('button', { class: 'btn sm', style: 'flex:1', onClick: () => { importTab.value = 'text'; importOpen.value = true } }, '📥 导入')
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
                class: 'textarea', style: 'border-radius:0;border:none;border-bottom:1px dashed var(--line);min-height:40px;padding:6px 0 0;background:transparent;font-size:13px',
                placeholder: '添加一段描述（可选）',
                onInput: e => form.value.description = e.target.value,
                // textarea 的 value 只是属性，内容得单独同步，否则输入会被旧属性顶掉
                ...bindTextarea(form.value.description)
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
        aiOpen.value ? h('div', { class: 'modal-mask', onClick: e => { if (e.target.classList.contains('modal-mask') && !aiBusy.value) aiOpen.value = false } },
          h('div', { class: 'modal wide' }, [
            h('div', { class: 'modal-h' }, [
              h('h3', {}, '🤖 AI 生成表单'),
              h('div', { class: 'flex', style: 'gap:6px;align-items:center' }, [
                aiStreaming.value ? h('span', { class: 'tag brand' }, `流式接收中 · ${aiChars.value} 字`) : null,
                h('button', { class: 'btn ghost sm', disabled: aiBusy.value, onClick: () => aiOpen.value = false }, '关闭')
              ])
            ]),
            h('div', { class: 'modal-b' }, [
              h('div', { class: 'field' }, [
                h('label', {}, '描述你想要的表单'),
                h('textarea', {
                  class: 'textarea', style: 'min-height:96px', placeholder: '例如：做一份员工满意度调查，包含对办公环境、团队协作、薪酬福利的评分，以及开放建议',
                  value: aiPrompt.value, onInput: e => aiPrompt.value = e.target.value
                })
              ]),
              // 模型与语言并排：模型来自服务端 /models 的真实列表，拿不到就退回手填
              h('div', { class: 'flex', style: 'gap:10px;flex-wrap:wrap' }, [
                h('div', { class: 'field', style: 'flex:1;min-width:200px' }, [
                  h('label', {}, '模型'),
                  aiModels.value.length
                    ? h('select', { class: 'select', value: aiModel.value, onChange: e => aiModel.value = e.target.value },
                        aiModels.value.map(m => h('option', { value: m }, m)))
                    : h('input', {
                        class: 'input', value: aiModel.value, placeholder: 'gpt-4o-mini',
                        onInput: e => aiModel.value = e.target.value
                      })
                ]),
                h('div', { class: 'field', style: 'width:150px' }, [
                  h('label', {}, '生成语言'),
                  h('select', { class: 'select', value: aiLang.value, onChange: e => aiLang.value = e.target.value },
                    aiLangOpts.value.map(l => h('option', { value: l.code }, l.label)))
                ])
              ]),
              aiModelReason.value ? h('div', { class: 'hint' }, `模型列表没取到：${aiModelReason.value}；手填模型名同样可用。`) : null,
              // 实时预览：已经完整吐出来的题直接画出来，而不是等全部完成
              aiLiveFields.value.length ? h('div', { style: 'margin-top:6px' }, [
                h('div', { class: 'hint mb' }, `实时预览：已生成 ${aiLiveFields.value.length} 道题`),
                h('div', { style: 'max-height:240px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:10px' },
                  aiLiveFields.value.map((f, i) => h('div', { style: 'padding:6px 0;border-bottom:1px solid var(--line)' }, [
                    h('div', { class: 'small muted' }, `${i + 1}. ${fieldMeta(f.type).label}${f.required ? ' · 必填' : ''}`),
                    h('div', { style: 'font-size:13.5px' }, f.label),
                    f.options?.length ? h('div', { class: 'small muted' }, f.options.map(o => o.label).join(' / ')) : null
                  ])))
              ]) : null,
              h('div', { class: 'hint' }, '需要先在系统设置 → AI 中配置 OpenAI Compatible API；未配置时会使用本地模板生成，并在结果里标明来源。')
            ]),
            h('div', { class: 'modal-f' }, [
              h('button', { class: 'btn', disabled: aiBusy.value, onClick: () => aiOpen.value = false }, '取消'),
              h('button', { class: 'btn primary', disabled: aiBusy.value, onClick: doAi }, aiBusy.value ? (aiStreaming.value ? '生成中…（实时预览）' : '生成中…') : '生成题目')
            ])
          ])) : null,
        // 导入弹窗（文本 / Excel）
        importOpen.value ? h('div', { class: 'modal-mask', onClick: e => { if (e.target.classList.contains('modal-mask')) importOpen.value = false } },
          h('div', { class: 'modal wide' }, [
            h('div', { class: 'modal-h' }, [h('h3', {}, '批量导入题目'), h('button', { class: 'btn ghost sm', onClick: () => importOpen.value = false }, '关闭')]),
            h('div', { class: 'modal-b' }, [
              h('div', { class: 'flex', style: 'gap:6px;margin-bottom:12px' }, [
                h('button', { class: ['btn', 'sm', importTab.value === 'text' ? 'primary' : ''], onClick: () => importTab.value = 'text' }, '文本粘贴'),
                h('button', { class: ['btn', 'sm', importTab.value === 'excel' ? 'primary' : ''], onClick: () => importTab.value = 'excel' }, 'Excel 表格')
              ]),
              importTab.value === 'text' ? [
                h('div', { class: 'hint mb' }, '格式：每题以「1.」「一、」或「- 」开头，方括号内写题型（单选/多选/填空/日期/评分…），选项以「A.」「①」开头，可写「答案：A」「分值：5」「解析：…」；行首写「!」表示必答。'),
                h('textarea', {
                  class: 'textarea mono', style: 'min-height:240px', value: importText.value,
                  placeholder: '1. 你的性别 [单选]\nA. 男\nB. 女\n答案：A\n\n2. 请描述你的建议 [多行]',
                  onInput: e => importText.value = e.target.value
                })
              ] : [
                h('div', { class: 'hint mb' }, '表格列依次是「题型 / 题干 / 选项 / 答案 / 分值 / 解析」，有表头就按列名认，顺序无所谓。选项在单元格内一行一个，答案写 A、A,C 或 正确。'),
                h('div', { class: 'flex', style: 'gap:8px;align-items:center;flex-wrap:wrap' }, [
                  h('label', { class: 'btn primary' }, [
                    '选择 .xlsx 文件',
                    h('input', { type: 'file', accept: '.xlsx', class: 'hide', onChange: e => { importXlsx(e.target.files?.[0]); e.target.value = '' } })
                  ]),
                  h('button', { class: 'btn', onClick: () => api.download('/api/banks/template.xlsx', 'EQS 题库导入模板.xlsx').then(() => ok('模板已下载')).catch(e => err(e.message)) }, '下载导入模板')
                ])
              ]
            ]),
            h('div', { class: 'modal-f' }, importTab.value === 'text'
              ? [
                  h('button', { class: 'btn', onClick: () => importOpen.value = false }, '取消'),
                  h('button', { class: 'btn primary', onClick: doImport }, '导入')
                ]
              : [h('button', { class: 'btn', onClick: () => importOpen.value = false }, '关闭')])
          ])) : null
      ])
    }
  }
}
