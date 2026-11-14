export const FIELD_GROUPS = [
  {
    name: '基础输入',
    items: [
      { type: 'text', label: '单行文本', icon: 'T' },
      { type: 'textarea', label: '多行文本', icon: '¶' },
      { type: 'number', label: '数字', icon: '#' },
      { type: 'phone', label: '手机号', icon: '☎' },
      { type: 'email', label: '邮箱', icon: '@' },
      { type: 'idcard', label: '身份证', icon: 'ID' }
    ]
  },
  {
    name: '选择类',
    items: [
      { type: 'radio', label: '单选题', icon: '◉' },
      { type: 'checkbox', label: '多选题', icon: '☑' },
      { type: 'select', label: '下拉选择', icon: '▾' },
      { type: 'switch', label: '开关', icon: '⇄' },
      { type: 'cascader', label: '级联选择', icon: '⋔' },
      { type: 'sort', label: '排序题', icon: '↕' },
      { type: 'carousel', label: '轮播选择', icon: '⧉' }
    ]
  },
  {
    name: '量表评分',
    items: [
      { type: 'rate', label: '评分', icon: '★' },
      { type: 'nps', label: 'NPS 量表', icon: 'N' },
      { type: 'slider', label: '滑动条', icon: '—' },
      { type: 'matrix', label: '矩阵量表', icon: '▦' }
    ]
  },
  {
    name: '时间日期',
    items: [
      { type: 'date', label: '日期', icon: '▤' },
      { type: 'datetime', label: '日期时间', icon: '◷' },
      { type: 'time', label: '时间', icon: '◔' }
    ]
  },
  {
    name: '高级',
    items: [
      { type: 'upload', label: '文件上传', icon: '⇧' },
      { type: 'signature', label: '手写签名', icon: '✎' },
      { type: 'location', label: '一键定位', icon: '◎' },
      { type: 'qrcode', label: '扫码', icon: '▣' },
      { type: 'subform', label: '子表单', icon: '⧉+' },
      { type: 'captcha', label: '验证码', icon: '⌘' },
      { type: 'calculate', label: '计算题', icon: '=' },
      { type: 'image', label: '图片展示', icon: '▧' },
      { type: 'divider', label: '分割线', icon: '—' },
      { type: 'richtext', label: '富文本说明', icon: '§' }
    ]
  }
]

export const ALL_FIELDS = FIELD_GROUPS.flatMap(g => g.items)

export function fieldMeta(type) {
  return ALL_FIELDS.find(f => f.type === type) || { type, label: type, icon: '?' }
}

export const INPUT_TYPES = ['text', 'textarea', 'number', 'phone', 'email', 'idcard']

export function hasOptions(type) {
  return ['radio', 'checkbox', 'select', 'sort', 'cascader', 'carousel', 'matrix'].includes(type)
}

export function uid() {
  return 'f_' + Math.random().toString(36).slice(2, 9)
}

export function blankField(type) {
  const base = {
    id: uid(), type, label: fieldMeta(type).label, required: false,
    placeholder: '', description: '', options: [], defaultValue: '',
    score: 0, answer: [], analysis: '', tags: '', logic: [], props: {}
  }
  if (['radio', 'checkbox', 'select', 'sort', 'carousel', 'cascader'].includes(type)) {
    base.options = [
      { label: '选项 1', value: '选项 1' },
      { label: '选项 2', value: '选项 2' },
      { label: '选项 3', value: '选项 3' }
    ]
  }
  if (type === 'matrix') {
    base.props = { rows: ['行 1', '行 2', '行 3'] }
    base.options = [
      { label: '很满意', value: '5' },
      { label: '满意', value: '4' },
      { label: '一般', value: '3' },
      { label: '不满意', value: '2' }
    ]
  }
  if (type === 'rate') base.props = { max: 5 }
  if (type === 'nps') base.props = { max: 10 }
  if (type === 'slider') base.props = { min: 0, max: 100, step: 1 }
  if (type === 'upload') base.props = { multiple: false, maxSize: 20, accept: '' }
  if (type === 'subform') base.props = { fields: [{ id: uid(), type: 'text', label: '子项' }] }
  if (type === 'divider') base.label = ''
  if (type === 'richtext') base.props = { html: '在这里写一段说明文字。' }
  // 计算题：只读，值由公式算出来；默认给一个能直接跑的例子，省得对着空输入框猜语法
  if (type === 'calculate') base.props = { formula: '', precision: 2, unit: '' }
  return base
}

export function defaultData(schema) {
  const data = {}
  for (const f of schema) {
    // 表单里写「默认值」是一个输入框，多选/排序写的是「A,B」，不拆开就是一个不存在的选项
    const multi = String(f.defaultValue ?? '').split(/[,，]/).map(s => s.trim()).filter(Boolean)
    // 排序题不预置值：它不是「选好的答案」，预置等于白送一道必填题
    if (f.type === 'checkbox') data[f.id] = multi
    else if (f.type === 'sort') data[f.id] = []
    else if (f.type === 'matrix') data[f.id] = {}
    else if (f.type === 'switch') data[f.id] = f.defaultValue === true || f.defaultValue === 'true' || f.defaultValue === 1
    else if (f.type === 'subform') data[f.id] = []
    else if (f.type === 'calculate') data[f.id] = ''
    else data[f.id] = f.defaultValue ?? ''
  }
  return data
}
