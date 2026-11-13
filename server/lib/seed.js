import { get, run, now, setSetting, all } from './db.js'
import { normalizeSchema } from './forms.js'

const TPL = [
  {
    title: '客户满意度调查', category: '满意度', kind: 'survey',
    description: '了解客户对产品与服务的真实感受，5 分钟完成。',
    settings: { submitText: '感谢您的反馈，我们会持续改进！', buttonText: '提交问卷', theme: { bgColor: '#f5f7ff', buttonColor: '#4f6ef7' } },
    schema: [
      { type: 'rate', label: '整体满意度', required: true, props: { max: 5 } },
      { type: 'nps', label: '您向朋友推荐我们的可能性（0-10 分）' },
      { type: 'radio', label: '您最满意的方面', options: ['产品质量', '服务态度', '交付速度', '性价比'] },
      { type: 'checkbox', label: '您希望我们改进哪些方面', options: ['功能完整度', '界面设计', '响应速度', '文档说明', '价格'] },
      { type: 'textarea', label: '还有什么想告诉我们的？' }
    ]
  },
  {
    title: '活动报名表', category: '报名', kind: 'survey',
    description: '填写信息即可完成活动报名，我们会通过短信通知。',
    settings: { submitText: '报名成功，请留意短信通知。', buttonText: '立即报名' },
    schema: [
      { type: 'text', label: '姓名', required: true },
      { type: 'phone', label: '手机号', required: true },
      { type: 'select', label: '参与场次', required: true, options: ['上午场 09:30', '下午场 14:30'] },
      { type: 'number', label: '同行人数', props: { min: 0 } },
      { type: 'date', label: '期望参与日期' },
      { type: 'textarea', label: '备注说明' }
    ]
  },
  {
    title: '员工入职登记', category: '人事', kind: 'survey',
    description: '新同事请填写入职信息，用于档案建立。',
    schema: [
      { type: 'text', label: '姓名', required: true },
      { type: 'idcard', label: '身份证号', required: true },
      { type: 'phone', label: '手机号', required: true },
      { type: 'email', label: '邮箱' },
      { type: 'date', label: '入职日期', required: true },
      { type: 'cascader', label: '所属部门', options: [{ label: '技术中心', value: 'tech' }, { label: '市场部', value: 'market' }, { label: '财务部', value: 'finance' }] },
      { type: 'upload', label: '证件照 / 学历证明', props: { multiple: true } }
    ]
  },
  {
    title: '在线考试模板（含答案）', category: '考试', kind: 'exam',
    description: '示例试卷，含单选、多选、判断与简答，可自动评分。',
    settings: { submitText: '已提交，成绩已自动计算。', passScore: 60, duration: 30 },
    schema: [
      { type: 'radio', label: 'EQS 默认内置的数据库是？', required: true, options: ['MySQL', 'PostgreSQL', 'H2/SQLite 内嵌', 'Oracle'], answer: ['H2/SQLite 内嵌'], score: 10, analysis: 'EQS 内置内嵌数据库，开箱即用。' },
      { type: 'checkbox', label: '以下哪些属于 EQS 的题型？（多选）', required: true, options: ['单选', '矩阵量表', '子表单', '二维码'], answer: ['单选', '矩阵量表', '子表单'], score: 20, analysis: '二维码题型用于跳转与扫码场景，均属内置题型。' },
      { type: 'radio', label: 'EQS 支持私有化部署。', required: true, options: ['正确', '错误'], answer: ['正确'], score: 10 },
      { type: 'textarea', label: '简述你对条件显隐逻辑的理解。', score: 20 }
    ]
  },
  {
    title: 'NPS 推荐意愿调研', category: '满意度', kind: 'survey',
    description: '一句话版本的核心指标调研。',
    schema: [
      { type: 'nps', label: '您有多大可能把我们推荐给朋友？' },
      { type: 'textarea', label: '主要原因是什么？' }
    ]
  },
  {
    title: '产品需求收集', category: '产品', kind: 'survey',
    description: '帮助我们排定下一步产品路线。',
    schema: [
      { type: 'text', label: '你的称呼', required: true },
      { type: 'checkbox', label: '你希望优先级最高的功能', options: ['AI 生成', '考试与刷题', '数据大屏', '多语言', '第三方登录'] },
      { type: 'rate', label: '当前版本满意度' },
      { type: 'textarea', label: '详细描述' }
    ]
  }
]

export function seedTemplates() {
  const count = get('SELECT COUNT(*) c FROM forms WHERE is_template = 1').c
  if (count > 0) return
  const admin = get(`SELECT id FROM users ORDER BY id LIMIT 1`)
  const ts = now()
  for (const t of TPL) {
    run('INSERT INTO forms(title, description, kind, schema, settings, status, is_template, category, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,1,?,?,?,?)',
      t.title, t.description || '', t.kind || 'survey', JSON.stringify(normalizeSchema(t.schema)),
      JSON.stringify(t.settings || {}), 'published', t.category || '', admin?.id || 0, ts, ts)
  }
}

export function seedSettings() {
  if (!all('SELECT key FROM settings').length) {
    setSetting('site', { name: 'EQS', slogan: '一体化问卷 · 考试 · 刷题平台', icp: '' })
    setSetting('i18n', { defaultLang: 'zh', enabled: ['zh', 'en'] })
  }
  const i18nCount = get('SELECT COUNT(*) c FROM i18n').c
  if (!i18nCount) {
    const zh = {
      'app.name': 'EQS', 'nav.dashboard': '工作台', 'nav.forms': '表单', 'nav.templates': '模板中心',
      'nav.exams': '考试', 'nav.banks': '题库', 'nav.data': '数据', 'nav.reports': '报表',
      'nav.recycle': '回收站', 'nav.settings': '系统设置', 'action.save': '保存', 'action.publish': '发布',
      'action.preview': '预览', 'action.export': '导出', 'action.delete': '删除', 'action.edit': '编辑',
      'action.create': '新建', 'common.submit': '提交', 'common.cancel': '取消'
    }
    const en = {
      'app.name': 'EQS', 'nav.dashboard': 'Dashboard', 'nav.forms': 'Forms', 'nav.templates': 'Templates',
      'nav.exams': 'Exams', 'nav.banks': 'Question Banks', 'nav.data': 'Data', 'nav.reports': 'Reports',
      'nav.recycle': 'Recycle Bin', 'nav.settings': 'Settings', 'action.save': 'Save', 'action.publish': 'Publish',
      'action.preview': 'Preview', 'action.export': 'Export', 'action.delete': 'Delete', 'action.edit': 'Edit',
      'action.create': 'Create', 'common.submit': 'Submit', 'common.cancel': 'Cancel'
    }
    for (const [k, v] of Object.entries(zh)) run('INSERT INTO i18n(lang, key, value) VALUES(?,?,?)', 'zh', k, v)
    for (const [k, v] of Object.entries(en)) run('INSERT INTO i18n(lang, key, value) VALUES(?,?,?)', 'en', k, v)
  }
}
