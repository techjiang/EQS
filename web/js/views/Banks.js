import { h, ref, onMounted } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { navigate } from '../router.js'
import { ok, err, confirmBox, Empty, Modal, promptBox, fmtDate } from '../ui.js'
import { renderControl } from '../renderer.js'
import { blankField, fieldMeta } from '../fields.js'

export default {
  setup() {
    const banks = ref([])
    const active = ref(null)
    const questions = ref([])
    const loading = ref(true)
    const showNew = ref(false)
    const newBank = ref({ name: '', description: '' })
    const importOpen = ref(false)
    const importText = ref('')
    const importTab = ref('text')
    const editQ = ref(null)
    const paperOpen = ref(false)
    const paper = ref({ title: '', count: 10, duration: 60, passPercent: 60, types: [], tags: [] })
    // 题目筛选：题干/标签关键字 + 标签点选。标签是纯文本字段，前端拆成词片展示
    const qKeyword = ref('')
    const qTag = ref('')
    const memberOpen = ref(false)
    const memberData = ref(null)
    /*
     * my_role 决定这一屏露出哪些按钮。
     * 只读协作者点了才知道不行，比按钮干脆不在更让人恼火；
     * 但也不能只藏按钮——后端同样拦，前端只是别给假希望。
     */
    const canWrite = ref(true)

    const load = async () => {
      try {
        const r = await api.get('/api/banks')
        banks.value = r.data
        if (!active.value && banks.value.length) select(banks.value[0])
      } catch (e) { err(e.message) } finally { loading.value = false }
    }

    const select = async (b) => {
      active.value = b
      canWrite.value = b?.my_role !== 'viewer'
      qKeyword.value = ''
      qTag.value = ''
      await loadQuestions()
      refreshTags()
    }

    /* ---------------- 题库协作 ---------------- */
    const openMembers = async () => {
      try {
        const r = await api.get(`/api/banks/${active.value.id}/members`)
        memberData.value = r.data
        memberOpen.value = true
      } catch (e) { err(e.message) }
    }

    const reloadMembers = async () => {
      const r = await api.get(`/api/banks/${active.value.id}/members`)
      memberData.value = r.data
    }

    const inviteMember = async (userId, role) => {
      try {
        await api.post(`/api/banks/${active.value.id}/members`, { userId, role })
        ok(role === 'viewer' ? '已加入为只读协作者' : '已加入为可编辑协作者')
        await reloadMembers()
        load()
      } catch (e) { err(e.message) }
    }

    const setMemberRole = async (m, role) => {
      if (m.role === role) return
      try {
        await api.post(`/api/banks/${active.value.id}/members`, { userId: m.user_id, role })
        ok('已调整权限')
        await reloadMembers()
      } catch (e) { err(e.message) }
    }

    const removeMember = async (m) => {
      if (!await confirmBox(`移除协作者「${m.nickname || m.username}」？`)) return
      try {
        await api.del(`/api/banks/${active.value.id}/members/${m.user_id}`)
        ok('已移除')
        await reloadMembers()
        load()
      } catch (e) { err(e.message) }
    }

    const loadQuestions = async () => {
      if (!active.value) return
      const qs = new URLSearchParams()
      if (qKeyword.value.trim()) qs.set('keyword', qKeyword.value.trim())
      if (qTag.value) qs.set('tag', qTag.value)
      const r = await api.get(`/api/banks/${active.value.id}/questions${qs.toString() ? '?' + qs : ''}`)
      questions.value = r.data
    }

    /** 全量题目里出现过的标签，按出现次数排前面，点一下就筛 */
    const allTags = ref([])
    const refreshTags = async () => {
      if (!active.value) { allTags.value = []; return }
      const r = await api.get(`/api/banks/${active.value.id}/questions`)
      const count = new Map()
      for (const q of r.data) {
        for (const t of String(q.tags || '').split(',').map(x => x.trim()).filter(Boolean)) count.set(t, (count.get(t) || 0) + 1)
      }
      allTags.value = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }))
    }

    onMounted(load)

    const createBank = async () => {
      if (!newBank.value.name.trim()) return err('请填写题库名称')
      try {
        const r = await api.post('/api/banks', newBank.value)
        showNew.value = false
        newBank.value = { name: '', description: '' }
        ok('题库已创建')
        await load()
        const b = banks.value.find(x => x.id === r.id)
        if (b) select(b)
      } catch (e) { err(e.message) }
    }

    const delBank = async (b) => {
      if (!await confirmBox(`删除题库「${b.name}」？可在「回收中心 · 题库」里恢复。`)) return
      try { await api.del(`/api/banks/${b.id}`); ok('已删除'); active.value = null; questions.value = []; load() } catch (e) { err(e.message) }
    }

    const addQuestion = () => { editQ.value = blankField('radio') }

    const saveQuestion = async () => {
      try {
        // props 必须一起提交：矩阵的行、评分的上限都在里面，漏了就等于把这题的结构清了
        const body = { ...editQ.value, title: editQ.value.label, props: editQ.value.props || {} }
        if (editQ.value.id && !String(editQ.value.id).startsWith('f_')) await api.put(`/api/questions/${editQ.value.id}`, body)
        else await api.post(`/api/banks/${active.value.id}/questions`, body)
        ok('题目已保存')
        editQ.value = null
        await loadQuestions()
        refreshTags()
        load()
      } catch (e) { err(e.message) }
    }

    const delQuestion = async (q) => {
      if (!await confirmBox('删除这道题？可在「回收中心 · 题目」里恢复。')) return
      try { await api.del(`/api/questions/${q.id}`); await loadQuestions(); refreshTags(); load() } catch (e) { err(e.message) }
    }

    const doImport = async () => {
      try {
        const r = await api.post(`/api/banks/${active.value.id}/import-text`, { text: importText.value })
        ok(`已导入 ${r.imported} 道题` + (r.droppedAnswers?.length ? `；${r.droppedAnswers.length} 道题的答案不在选项里，已清空待修正：${r.droppedAnswers.slice(0, 2).join('、')}` : ''))
        importOpen.value = false
        importText.value = ''
        await loadQuestions()
        refreshTags()
        load()
      } catch (e) { err(e.message) }
    }

    /** Excel 导入：文件直接进后端解析，前端不做表格解析（同一份逻辑只维护一处） */
    const importXlsx = async (file) => {
      if (!file) return
      try {
        const r = await api.uploadFile(`/api/banks/${active.value.id}/import-xlsx`, file)
        const skipped = r.skipped?.length ? `，跳过 ${r.skipped.length} 行（${r.skipped.slice(0, 2).map(x => `第 ${x.row} 行${x.reason}`).join('、')}）` : ''
        const unknown = r.unknownColumns?.length ? `；未识别的列已忽略：${r.unknownColumns.join('、')}` : ''
        ok(`已从 Excel 导入 ${r.imported} 道题${skipped}${unknown}` + (r.droppedAnswers?.length ? `；${r.droppedAnswers.length} 道题的答案不在选项里，已清空待修正` : ''))
        importOpen.value = false
        await loadQuestions()
        refreshTags()
        load()
      } catch (e) { err(e.message) }
    }

    const downloadTemplate = () => api.download('/api/banks/template.xlsx', 'EQS 题库导入模板.xlsx')
      .then(() => ok('模板已下载，填好后用「Excel 导入」上传'))
      .catch(e => err(e.message))

    /** 组卷筛选题型：与题库题型口径一致 */
    const paperTypes = ['radio', 'checkbox', 'text', 'textarea']
    const togglePaperType = (t) => {
      const set = new Set(paper.value.types || [])
      set.has(t) ? set.delete(t) : set.add(t)
      paper.value.types = [...set]
    }
    const togglePaperTag = (t) => {
      const set = new Set(paper.value.tags || [])
      set.has(t) ? set.delete(t) : set.add(t)
      paper.value.tags = [...set]
    }
    const tagsOf = (q) => String(q.tags || '').split(',').map(x => x.trim()).filter(Boolean)
    /** 题库把判断题存成 radio + 正确/错误，列表里照 type 显示就是「单选题」——学生看不出这是判断 */
    const isJudgeQ = (q) => {
      const vals = (q.options || []).map(o => String(o.value ?? o.label))
      return q.type === 'radio' && vals.length === 2 && vals.includes('正确') && vals.includes('错误')
    }
    const typeLabelOf = (q) => (isJudgeQ(q) ? '判断题' : fieldMeta(q.type).label)

    const makePaper = async () => {
      try {
        const r = await api.post(`/api/banks/${active.value.id}/paper`, paper.value)
        ok(`组卷成功，共 ${r.count} 题`)
        paperOpen.value = false
        navigate(`/forms/${r.id}/design`)
      } catch (e) { err(e.message) }
    }

    const practice = async (mode) => {
      try {
        await api.get(`/api/banks/${active.value.id}/practice?mode=${mode}`)
        navigate(`/banks/${active.value.id}/practice?mode=${mode}`)
      } catch (e) { err(e.message) }
    }

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [h('h1', {}, '题库与刷题'), h('div', { class: 'sub' }, '统一题库，可供考试组卷与刷题练习复用')]),
        h('button', { class: 'btn primary', onClick: () => showNew.value = true }, '+ 新建题库')
      ]),
      h('div', { class: 'grid', style: 'grid-template-columns:260px 1fr;align-items:start' }, [
        h('div', { class: 'card', style: 'overflow:hidden' }, [
          h('div', { class: 'card-h' }, [h('h3', {}, '题库列表'), h('span', { class: 'small muted' }, banks.value.length + ' 个')]),
          h('div', { style: 'padding:8px' }, banks.value.length
            ? banks.value.map(b => h('div', {
                class: ['nav-item', active.value?.id === b.id ? 'active' : ''],
                style: 'justify-content:space-between',
                onClick: () => select(b)
              }, [
                h('div', { style: 'min-width:0' }, [
                  h('div', { class: 'truncate' }, b.name),
                  h('div', { class: 'flex', style: 'gap:4px;align-items:center;margin-top:2px' }, [
                    h('span', { class: 'small muted' }, `${b.question_count} 题`),
                    // 被邀请来的题库要点明身份：不然分不清「我建的」和「别人分给我的」
                    b.my_role === 'editor' ? h('span', { class: 'tag', style: 'padding:0 5px' }, '协作') : null,
                    b.my_role === 'viewer' ? h('span', { class: 'tag warn', style: 'padding:0 5px' }, '只读') : null,
                    b.member_count ? h('span', { class: 'small muted' }, `· ${b.member_count} 人`) : null
                  ])
                ]),
                // 删除是所有者动作：协作者点了只会收到 403，按钮不该摆在那里
                b.my_role === 'owner'
                  ? h('button', { class: 'btn ghost sm', onClick: e => { e.stopPropagation(); delBank(b) } }, '×')
                  : null
              ]))
            : h(Empty, { text: '还没有题库' }))
        ]),
        h('div', {}, active.value ? [
          h('div', { class: 'card mb' }, [
            h('div', { class: 'card-h' }, [
              h('div', {}, [
                h('h3', {}, active.value.name),
                h('div', { class: 'small muted' }, active.value.description || '暂无描述')
              ]),
              h('div', { class: 'flex wrap', style: 'gap:6px' }, [
                active.value.my_role === 'owner'
                  ? h('button', { class: 'btn sm', onClick: openMembers }, `协作 · ${active.value.member_count || 0}`)
                  : null,
                canWrite.value
                  ? h('button', { class: 'btn sm', onClick: () => { importTab.value = 'text'; importOpen.value = true } }, '导入题目')
                  : null,
                // 导出文件带标准答案：只读协作者不给，否则「藏答案」只在界面上成立
                canWrite.value ? h('button', {
                  class: 'btn sm',
                  onClick: () => api.download(`/api/banks/${active.value.id}/export.xlsx`, `${active.value.name}.xlsx`)
                    .then(() => ok('已导出 Excel')).catch(e => err(e.message))
                }, '导出 Excel') : null,
                canWrite.value ? h('button', { class: 'btn sm', onClick: addQuestion }, '+ 添加题目') : null,
                canWrite.value
                  ? h('button', { class: 'btn sm', onClick: () => { paper.value = { ...paper.value, title: active.value?.name + ' - 试卷' }; paperOpen.value = true } }, '智能组卷')
                  : null,
                h('button', { class: 'btn sm primary', onClick: () => practice('sequence') }, '开始刷题')
              ])
            ]),
            active.value.my_role === 'viewer' ? h('div', {
              class: 'card-b', style: 'border-top:1px solid var(--line-2)'
            }, h('div', { class: 'hint' }, '你是这个题库的「只读」协作者：可以看题、刷题，但不能改题、也不能导出（导出文件含标准答案）。需要编辑权限请联系题库所有者。')) : null,
            h('div', { class: 'card-b', style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
              h('button', { class: 'btn sm', onClick: () => practice('sequence') }, '顺序练习'),
              h('button', { class: 'btn sm', onClick: () => practice('random') }, '随机练习'),
              h('button', { class: 'btn sm', onClick: () => practice('wrong') }, '错题练习'),
              h('button', { class: 'btn sm', onClick: () => practice('favorite') }, '收藏题目')
            ])
          ]),
          h('div', { class: 'card', style: 'overflow:hidden' }, [
            h('div', { class: 'card-h' }, [
              h('h3', {}, `题目 (${questions.value.length})`),
              h('div', { class: 'flex', style: 'gap:6px' }, [
                h('input', {
                  class: 'input', style: 'max-width:200px;height:30px',
                  placeholder: '搜题干或标签', value: qKeyword.value,
                  onInput: e => qKeyword.value = e.target.value,
                  onKeydown: e => { if (e.key === 'Enter') loadQuestions() }
                }),
                h('button', { class: 'btn sm', onClick: loadQuestions }, '搜索'),
                (qKeyword.value || qTag.value) ? h('button', {
                  class: 'btn sm ghost',
                  onClick: () => { qKeyword.value = ''; qTag.value = ''; loadQuestions() }
                }, '清空') : null
              ])
            ]),
            !canWrite.value ? h('div', { class: 'small muted', style: 'padding:0 16px 8px' }, '只读身份下不显示标准答案与解析。') : null,
            // 标签云：点一片就筛，再点取消。标签不显示出来，用户根本不知道有这东西
            allTags.value.length ? h('div', {
              class: 'flex wrap', style: 'gap:6px;padding:0 16px 10px'
            }, allTags.value.map(t => h('button', {
              class: ['btn', 'sm', qTag.value === t.name ? 'primary' : ''],
              onClick: () => { qTag.value = qTag.value === t.name ? '' : t.name; loadQuestions() }
            }, `${t.name} · ${t.n}`))) : null,
            questions.value.length ? h('div', { style: 'padding:8px 16px 16px' }, questions.value.map((q, i) => h('div', {
              style: 'padding:12px 0;border-bottom:1px solid var(--line-2)'
            }, [
              h('div', { class: 'flex between', style: 'align-items:flex-start;gap:10px' }, [
                h('div', { style: 'flex:1;min-width:0' }, [
                  h('div', { style: 'font-weight:540;margin-bottom:4px' }, `${i + 1}. ${q.title}`),
                  h('div', { class: 'small muted' }, [
                    typeLabelOf(q),
                    q.options.length ? ` · ${q.options.length} 个选项` : '',
                    q.answer.length ? ` · 答案：${q.answer.join(',')}` : '',
                    ` · ${q.score} 分`
                  ]),
                  tagsOf(q).length ? h('div', { class: 'flex wrap', style: 'gap:4px;margin-top:6px' }, tagsOf(q).map(t => h('span', {
                    class: 'tag', style: 'cursor:pointer',
                    onClick: () => { qTag.value = qTag.value === t ? '' : t; loadQuestions() }
                  }, '#' + t))) : null
                ]),
                canWrite.value ? h('div', { class: 'flex', style: 'gap:4px' }, [
                  h('button', { class: 'btn ghost sm', onClick: () => editQ.value = { ...q, label: q.title } }, '编辑'),
                  h('button', { class: 'btn ghost sm danger', onClick: () => delQuestion(q) }, '删除')
                ]) : null
              ])
            ]))) : h(Empty, { text: '题库还没有题目，试试文本导入或手动添加' })
          ])
        ] : h('div', { class: 'card' }, h(Empty, { text: '请选择或新建一个题库' })))
      ]),

      memberOpen.value ? Modal({
        title: '题库协作 · ' + (active.value?.name || ''), modelValue: true, onClose: () => memberOpen.value = false, wide: true,
        children: memberData.value ? [
          h('div', { class: 'hint mb' }, '协作者能一起维护题目：可编辑能增删改题与组卷，只读只能看题与刷题。只有所有者能管理协作者与删除题库。'),
          h('div', { class: 'field' }, [
            h('label', {}, '所有者'),
            h('div', { class: 'flex', style: 'gap:8px;align-items:center' }, [
              h('img', { src: memberData.value.owner?.avatar || '/assets/eqs-mark.svg', style: 'width:26px;height:26px;border-radius:8px' }),
              h('span', { style: 'font-weight:540' }, memberData.value.owner?.nickname || memberData.value.owner?.username || '-'),
              h('span', { class: 'tag brand' }, '所有者')
            ])
          ]),
          h('div', { class: 'field' }, [
            h('label', {}, `协作者（${memberData.value.members.length}）`),
            memberData.value.members.length
              ? memberData.value.members.map(m => h('div', {
                  class: 'flex between wrap member-row', style: 'padding:8px 0;border-bottom:1px solid var(--line-2);gap:8px'
                }, [
                  h('div', { class: 'flex', style: 'gap:8px;align-items:center;min-width:0' }, [
                    h('img', { src: m.avatar || '/assets/eqs-mark.svg', style: 'width:26px;height:26px;border-radius:8px' }),
                    h('div', { style: 'min-width:0' }, [
                      h('div', { class: 'truncate', style: 'font-weight:540' }, m.nickname || m.username),
                      h('div', { class: 'small muted' }, [m.username, m.dept_name ? ' · ' + m.dept_name : ''].join(''))
                    ])
                  ]),
                  h('div', { class: 'flex', style: 'gap:4px;align-items:center' }, [
                    h('button', {
                      class: ['btn', 'sm', m.role === 'editor' ? 'primary' : ''],
                      onClick: () => setMemberRole(m, 'editor')
                    }, '可编辑'),
                    h('button', {
                      class: ['btn', 'sm', m.role === 'viewer' ? 'primary' : ''],
                      onClick: () => setMemberRole(m, 'viewer')
                    }, '只读'),
                    h('button', { class: 'btn ghost sm danger', onClick: () => removeMember(m) }, '移除')
                  ])
                ]))
              : h(Empty, { text: '还没有协作者，别人看不到这个题库' })
          ]),
          memberData.value.candidates?.length ? h('div', { class: 'field' }, [
            h('label', {}, '添加协作者'),
            h('div', { class: 'flex wrap', style: 'gap:6px' }, memberData.value.candidates.map(u => h('div', {
              class: 'flex', style: 'gap:6px;align-items:center;border:1px solid var(--line);border-radius:9px;padding:4px 8px'
            }, [
              h('span', { class: 'small' }, u.nickname || u.username),
              h('button', { class: 'btn sm', onClick: () => inviteMember(u.id, 'editor') }, '可编辑'),
              h('button', { class: 'btn sm', onClick: () => inviteMember(u.id, 'viewer') }, '只读')
            ])))
          ]) : h('div', { class: 'hint' }, '没有可添加的人了（所有启用账号都已经是协作者）')
        ] : [h('div', { style: 'padding:20px' }, '加载中…')],
        footer: [h('button', { class: 'btn', onClick: () => memberOpen.value = false }, '关闭')]
      }) : null,

      showNew.value ? Modal({
        title: '新建题库', modelValue: true, onClose: () => showNew.value = false,
        children: [
          h('div', { class: 'field' }, [h('label', {}, '题库名称'), h('input', {
            class: 'input', value: newBank.value.name, onInput: e => newBank.value.name = e.target.value, placeholder: '例如：计算机基础'
          })]),
          h('div', { class: 'field' }, [h('label', {}, '描述'), h('textarea', {
            class: 'textarea', style: 'min-height:70px', value: newBank.value.description,
            onInput: e => newBank.value.description = e.target.value
          })])
        ],
        footer: [h('button', { class: 'btn', onClick: () => showNew.value = false }, '取消'), h('button', { class: 'btn primary', onClick: createBank }, '创建')]
      }) : null,

      importOpen.value ? Modal({
        title: '导入题目', modelValue: true, onClose: () => importOpen.value = false, wide: true,
        children: [
          h('div', { class: 'flex', style: 'gap:6px;margin-bottom:12px' }, [
            h('button', {
              class: ['btn', 'sm', importTab.value === 'text' ? 'primary' : ''],
              onClick: () => importTab.value = 'text'
            }, '文本粘贴'),
            h('button', {
              class: ['btn', 'sm', importTab.value === 'excel' ? 'primary' : ''],
              onClick: () => importTab.value = 'excel'
            }, 'Excel 表格')
          ]),
          importTab.value === 'text' ? [
            h('div', { class: 'hint mb' }, '格式：每题以「1.」「一、」开头，方括号写题型，选项以「A.」「①」开头，可写「答案：A」「分值：5」「解析：…」「标签：数据库,基础」；判断题答案写「对 / 错」即可。'),
            h('textarea', {
              class: 'textarea mono', style: 'min-height:260px', value: importText.value,
              placeholder: '1. 下列哪个是关系型数据库？ [单选]\nA. Redis\nB. MySQL\nC. MongoDB\n答案：B\n分值：5\n解析：MySQL 是关系型数据库。\n标签：数据库,基础',
              onInput: e => importText.value = e.target.value
            })
          ] : [
            h('div', { class: 'hint mb' }, '表格列依次是「题型 / 题干 / 选项 / 答案 / 分值 / 解析 / 标签」，顺序无所谓——有表头就按列名认。选项在单元格里一行一个（A.苹果 换行 B.香蕉），答案写 A、A,C 或 正确。'),
            h('div', { class: 'flex', style: 'gap:8px;align-items:center;flex-wrap:wrap' }, [
              h('label', { class: 'btn primary' }, [
                '选择 .xlsx 文件',
                h('input', {
                  type: 'file', accept: '.xlsx', class: 'hide',
                  onChange: e => { importXlsx(e.target.files?.[0]); e.target.value = '' }
                })
              ]),
              h('button', { class: 'btn', onClick: downloadTemplate }, '下载导入模板'),
              h('span', { class: 'small muted' }, '.xls / .csv 请先用 Excel 另存为 .xlsx')
            ])
          ]
        ],
        footer: importTab.value === 'text'
          ? [h('button', { class: 'btn', onClick: () => importOpen.value = false }, '取消'), h('button', { class: 'btn primary', onClick: doImport }, '导入')]
          : [h('button', { class: 'btn', onClick: () => importOpen.value = false }, '关闭')]
      }) : null,

      paperOpen.value ? Modal({
        title: '智能组卷', modelValue: true, onClose: () => paperOpen.value = false,
        children: [
          h('div', { class: 'field' }, [h('label', {}, '试卷标题'), h('input', {
            class: 'input', value: paper.value.title || active.value?.name + ' - 试卷',
            onInput: e => paper.value.title = e.target.value
          })]),
          h('div', { class: 'field' }, [
            h('label', {}, '限题型（不选则不限）'),
            h('div', { class: 'flex wrap', style: 'gap:6px' }, paperTypes.map(t => h('button', {
              class: ['btn', 'sm', (paper.value.types || []).includes(t) ? 'primary' : ''],
              onClick: () => togglePaperType(t)
            }, fieldMeta(t).label)))
          ]),
          allTags.value.length ? h('div', { class: 'field' }, [
            h('label', {}, '限标签（不选则不限，多选为「同时满足」）'),
            h('div', { class: 'flex wrap', style: 'gap:6px' }, allTags.value.map(t => h('button', {
              class: ['btn', 'sm', (paper.value.tags || []).includes(t.name) ? 'primary' : ''],
              onClick: () => togglePaperTag(t.name)
            }, `${t.name} · ${t.n}`)))
          ]) : null,
          h('div', { class: 'row' }, [
            h('div', { class: 'field' }, [h('label', {}, '抽题数量'), h('input', {
              class: 'input', type: 'number', value: paper.value.count, onInput: e => paper.value.count = Number(e.target.value)
            })]),
            h('div', { class: 'field' }, [h('label', {}, '考试时长（分钟）'), h('input', {
              class: 'input', type: 'number', value: paper.value.duration, onInput: e => paper.value.duration = Number(e.target.value)
            })]),
            h('div', { class: 'field' }, [h('label', {}, '及格线（%）'), h('input', {
              class: 'input', type: 'number', min: 1, max: 100, value: paper.value.passPercent ?? 60,
              onInput: e => paper.value.passPercent = Number(e.target.value)
            })])
          ])
        ],
        footer: [h('button', { class: 'btn', onClick: () => paperOpen.value = false }, '取消'), h('button', { class: 'btn primary', onClick: makePaper }, '生成试卷')]
      }) : null,

      editQ.value ? Modal({
        title: editQ.value.id && !String(editQ.value.id).startsWith('f_') ? '编辑题目' : '添加题目',
        modelValue: true, onClose: () => editQ.value = null, wide: true,
        children: [
          h('div', { class: 'field' }, [h('label', {}, '题干'), h('textarea', {
            class: 'textarea', style: 'min-height:64px', value: editQ.value.label, onInput: e => editQ.value.label = e.target.value
          })]),
          h('div', { class: 'row' }, [
            h('div', { class: 'field' }, [h('label', {}, '题型'), h('select', {
              class: 'select', value: editQ.value.type,
              onChange: e => {
                const t = e.target.value
                const base = blankField(t)
                // 换题型不该把已经写好的标签/解析一起清掉
                editQ.value = {
                  ...base, id: editQ.value.id, label: editQ.value.label,
                  score: editQ.value.score, analysis: editQ.value.analysis,
                  tags: editQ.value.tags || '', answer: []
                }
              }
            // 题库能导入排序题、矩阵题，编辑器却只给五种题型 —— 导进来的题没法在这里改
            }, ['radio', 'checkbox', 'text', 'textarea', 'select', 'sort', 'matrix', 'rate', 'nps'].map(t => h('option', { value: t }, fieldMeta(t).label)))]),
            h('div', { class: 'field' }, [h('label', {}, '分值'), h('input', {
              class: 'input', type: 'number', value: editQ.value.score, onInput: e => editQ.value.score = Number(e.target.value)
            })])
          ]),
          editQ.value.options.length ? h('div', { class: 'field' }, [
            h('label', { class: 'flex between' }, [
              h('span', {}, '选项'),
              h('button', { class: 'btn ghost sm', onClick: () => editQ.value.options.push({ label: `选项 ${editQ.value.options.length + 1}`, value: `选项 ${editQ.value.options.length + 1}` }) }, '+ 添加')
            ]),
            editQ.value.options.map((o, i) => h('div', { class: 'opt-row' }, [
              h('input', {
                class: 'input', value: o.label,
                onInput: e => {
                  const next = e.target.value
                  // 改选项名要同步改答案：只改 o.label 时 o.value 已是旧值，答案指着一个不存在的选项
                  editQ.value.answer = (editQ.value.answer || []).map(a => (a === o.value || a === o.label ? next : a))
                  o.label = next
                  o.value = next
                }
              }),
              h('button', { onClick: () => { editQ.value.answer = (editQ.value.answer || []).filter(a => a !== o.value); editQ.value.options.splice(i, 1) } }, '×')
            ]))
          ]) : null,
          // 矩阵题的「行」是评价对象，和列选项是两个维度；不在这里编辑，行就永远只有默认那三行
          editQ.value.type === 'matrix' ? h('div', { class: 'field' }, [
            h('label', { class: 'flex between' }, [
              h('span', {}, '矩阵行（评价对象，答案按行的顺序给）'),
              h('button', {
                class: 'btn ghost sm', onClick: () => {
                  editQ.value.props = editQ.value.props || {}
                  editQ.value.props.rows = editQ.value.props.rows || []
                  editQ.value.props.rows.push('行 ' + (editQ.value.props.rows.length + 1))
                }
              }, '+ 添加行')
            ]),
            (editQ.value.props?.rows || []).map((row, i) => h('div', { class: 'opt-row' }, [
              h('input', {
                class: 'input', value: row,
                onInput: e => editQ.value.props.rows[i] = e.target.value
              }),
              h('button', {
                onClick: () => {
                  if (editQ.value.props.rows.length <= 1) return err('矩阵至少保留一行')
                  editQ.value.props.rows.splice(i, 1)
                  editQ.value.answer = (editQ.value.answer || []).filter((_, j) => j !== i)
                }
              }, '×')
            ]))
          ]) : null,
          // 矩阵：每行各选一列，答案是「按行的顺序」一串列值，不能按集合勾选
          editQ.value.type === 'matrix' ? h('div', { class: 'field' }, [
            h('label', {}, '每行的正确答案'),
            (editQ.value.props?.rows || []).map((row, i) => h('div', { class: 'flex', style: 'gap:6px;align-items:center;margin-bottom:6px' }, [
              h('span', { class: 'small muted', style: 'min-width:96px' }, row || `第 ${i + 1} 行`),
              h('select', {
                class: 'select', style: 'height:32px',
                value: editQ.value.answer?.[i] ?? '',
                onChange: e => {
                  const ans = [...(editQ.value.answer || [])]
                  while (ans.length < i) ans.push('')
                  ans[i] = e.target.value
                  editQ.value.answer = ans.filter((v, j) => j === i || v !== undefined)
                }
              }, [h('option', { value: '' }, '不计分'), ...editQ.value.options.map(o => h('option', { value: o.value }, o.label))])
            ])),
            h('div', { class: 'hint' }, '每行选一个；留空表示该行不判分')
          ]) : null,
          // 排序：答案是顺序本身，必须按顺序点；这里复用「点选」按钮，点几次就是第几位
          editQ.value.type === 'sort' ? h('div', { class: 'field' }, [
            h('label', {}, '正确顺序（按顺序点选，再点一次取消）'),
            h('div', { class: 'flex wrap', style: 'gap:6px' }, editQ.value.options.map((o, i) => {
              const at = (editQ.value.answer || []).indexOf(o.value)
              return h('button', {
                class: ['btn', 'sm', at >= 0 ? 'primary' : ''],
                onClick: () => {
                  const ans = [...(editQ.value.answer || [])]
                  const pos = ans.indexOf(o.value)
                  if (pos >= 0) ans.splice(pos, 1); else ans.push(o.value)
                  editQ.value.answer = ans
                }
              }, at >= 0 ? `${at + 1}. ${o.label}` : `${String.fromCharCode(65 + i)}. ${o.label}`)
            })),
            h('div', { class: 'hint' }, editQ.value.answer?.length === editQ.value.options.length
              ? '已排完整顺序'
              : `还有 ${editQ.value.options.length - (editQ.value.answer?.length || 0)} 个选项没排进去，不完整的答案会造成「谁答都错」`)
          ]) : null,
          editQ.value.options.length && !['matrix', 'sort'].includes(editQ.value.type) ? h('div', { class: 'field' }, [
            h('label', {}, editQ.value.type === 'checkbox' ? '正确答案（可勾选多个）' : '正确答案（点选，也可直接写 A/B）'),
            h('div', { class: 'flex wrap', style: 'gap:6px' },
              editQ.value.options.map((o, i) => h('label', {
                class: ['btn', 'sm', (editQ.value.answer || []).includes(o.value) ? 'primary' : ''],
                style: 'cursor:pointer'
              }, [
                h('input', {
                  type: editQ.value.type === 'checkbox' ? 'checkbox' : 'radio',
                  name: 'q-answer', class: 'hide',
                  checked: (editQ.value.answer || []).includes(o.value),
                  onChange: () => {
                    const cur = new Set(editQ.value.answer || [])
                    if (editQ.value.type === 'checkbox') { cur.has(o.value) ? cur.delete(o.value) : cur.add(o.value) }
                    else { cur.clear(); cur.add(o.value) }
                    editQ.value.answer = [...cur]
                  }
                }),
                `${String.fromCharCode(65 + i)}. ${o.label}`
              ]))),
            h('input', {
              class: 'input', style: 'margin-top:8px', placeholder: '也可以手写，例如 A,C',
              value: (editQ.value.answer || []).join(','),
              onInput: e => {
                const tokens = e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean)
                // 手写的字母要翻成选项值，否则存下一个 'A' 而选项值叫「选项一」，从此永远判错
                editQ.value.answer = tokens.map(t => {
                  if (/^[A-Za-z]$/.test(t)) {
                    const opt = editQ.value.options[t.toUpperCase().charCodeAt(0) - 65]
                    return opt ? opt.value : t
                  }
                  return t
                })
              }
            })
          ]) : null,
          h('div', { class: 'row' }, [
            h('div', { class: 'field' }, [h('label', {}, '标签（逗号分隔，用于筛题组卷）'), h('input', {
              class: 'input', placeholder: '例如：数据库,基础', value: editQ.value.tags || '',
              onInput: e => editQ.value.tags = e.target.value
            })]),
            h('div', { class: 'field' }, [h('label', {}, '答案解析'), h('textarea', {
              class: 'textarea', style: 'min-height:60px', value: editQ.value.analysis, onInput: e => editQ.value.analysis = e.target.value
            })])
          ])
        ],
        footer: [h('button', { class: 'btn', onClick: () => editQ.value = null }, '取消'), h('button', { class: 'btn primary', onClick: saveQuestion }, '保存')]
      }) : null
    ])
  }
}
