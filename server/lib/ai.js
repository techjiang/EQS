import { setting, all, run, now } from './db.js'
import { normalizeSchema, normalizeField } from './forms.js'
import crypto from 'node:crypto'

export function aiConfig() {
  const cfg = setting('ai', {})
  return {
    enabled: !!cfg.enabled,
    baseUrl: (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: cfg.apiKey || '',
    model: cfg.model || 'gpt-4o-mini',
    temperature: Number(cfg.temperature ?? 0.7)
  }
}

const SYSTEM_PROMPT = `你是 EQS 问卷平台的表单设计助手。请根据用户描述，生成 JSON 表单结构。
只输出 JSON，不要 Markdown 代码块，不要解释。结构如下：
{"title":"表单标题","description":"简介","fields":[{"type":"radio|text|textarea|checkbox|select|date|number|rate|nps|upload|matrix|phone|email|location|signature|slider|switch|time|datetime|sort|cascader","label":"题目标题","required":true,"options":[{"label":"选项","value":"选项"}],"score":0,"answer":[],"analysis":"","props":{}}]}
题型选择规则：满意度/评价用 rate 或 nps，选择用 radio/checkbox，开放题用 textarea，短答用 text。选项 2-6 个。`

export async function chat(messages, { stream = false, signal } = {}) {
  const cfg = aiConfig()
  if (!cfg.enabled || !cfg.apiKey) throw new Error('AI 未启用或未配置 API Key')
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature: cfg.temperature, stream }),
    signal
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`AI 接口错误 ${res.status}: ${text.slice(0, 200)}`)
  }
  return res
}

export async function generateForm(prompt, { lang = 'zh', kind = 'survey' } = {}) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `请用${lang === 'zh' ? '简体中文' : lang}生成一个${kind === 'exam' ? '考试试卷（含正确答案与分值）' : '问卷'}：${prompt}` }
  ]
  const res = await chat(messages)
  const json = await res.json()
  const content = json.choices?.[0]?.message?.content || ''
  const parsed = extractJson(content)
  if (!parsed) throw new Error('AI 返回内容无法解析为表单结构')
  return {
    title: parsed.title || prompt.slice(0, 30),
    description: parsed.description || '',
    schema: normalizeSchema(parsed.fields || [])
  }
}

export function extractJson(text) {
  const trimmed = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try { return JSON.parse(trimmed) } catch {}
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)) } catch {}
  }
  return null
}

export async function* streamForm(prompt, { lang = 'zh', kind = 'survey' } = {}) {
  const res = await chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `请生成${kind === 'exam' ? '考试试卷' : '问卷'}：${prompt}` }
  ], { stream: true })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let acc = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const j = JSON.parse(payload)
        const delta = j.choices?.[0]?.delta?.content
        if (delta) { acc += delta; yield { delta, acc } }
      } catch {}
    }
  }
}

/** 离线降级：无 AI 时按关键词生成合理表单，保证功能可用 */
export function localGenerate(prompt, kind = 'survey') {
  const p = String(prompt || '')
  const title = p.slice(0, 24) || '新建表单'
  const fields = []
  const add = (f) => fields.push(normalizeField(f, fields.length))
  add({ type: 'text', label: '姓名', required: true })
  add({ type: 'phone', label: '手机号', required: true })
  if (/满意|评价|评分|反馈/.test(p)) {
    add({ type: 'rate', label: '整体满意度', required: true, props: { max: 5 } })
    add({ type: 'nps', label: '推荐意愿（0-10）' })
    add({ type: 'radio', label: '最满意的方面', options: ['产品质量', '服务态度', '交付速度', '性价比'] })
    add({ type: 'textarea', label: '还有什么建议？' })
  } else if (/考试|测验|测试|刷题/.test(p) || kind === 'exam') {
    add({ type: 'radio', label: '示例单选题', options: ['选项 A', '选项 B', '选项 C'], answer: ['选项 A'], score: 5, analysis: '正确答案为 A。' })
    add({ type: 'checkbox', label: '示例多选题', options: ['甲', '乙', '丙'], answer: ['甲', '乙'], score: 5 })
    add({ type: 'textarea', label: '简答题' , score: 10 })
  } else if (/报名|登记|预约/.test(p)) {
    add({ type: 'select', label: '参与场次', options: ['上午场', '下午场'] })
    add({ type: 'number', label: '参与人数', props: { min: 1 } })
    add({ type: 'date', label: '期望日期' })
    add({ type: 'textarea', label: '备注' })
  } else {
    add({ type: 'radio', label: '您的身份', options: ['学生', '企业员工', '自由职业', '其他'] })
    add({ type: 'checkbox', label: '关注的内容', options: ['功能', '价格', '服务', '生态'] })
    add({ type: 'textarea', label: '想对我们说的话' })
  }
  return { title, description: `由「${p.slice(0, 40)}」生成`, schema: fields }
}
