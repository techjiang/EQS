import { setting, all, run, now } from './db.js'
import { normalizeSchema, normalizeField, answerText } from './forms.js'
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

/**
 * 单次请求用的模型名。
 * 以前模型只能来自系统设置，而「模型切换」在 Issue 与 README 里都写着——
 * 一个团队想临时换更便宜的模型试一次，只能去改动全站配置，试完还得改回来。
 * 现在允许请求体里点明模型，配置仍然是默认值。
 */
function modelOf(override) {
  const m = String(override || '').trim()
  return m && m.length <= 120 ? m : aiConfig().model
}

export async function chat(messages, { stream = false, signal, model } = {}) {
  const cfg = aiConfig()
  if (!cfg.enabled || !cfg.apiKey) throw new Error('AI 未启用或未配置 API Key')
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: modelOf(model), messages, temperature: cfg.temperature, stream }),
    signal
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`AI 接口错误 ${res.status}: ${text.slice(0, 200)}`)
  }
  return res
}

/**
 * 模型列表。
 * Issue 原文写的是「模型列表与默认模型配置」，可界面上一直只有一个手填的输入框——
 * 填错一个字（gpt-4o-mini 写成 gpt4o-mini）要等到真正生成时才报 404，还报得看不懂。
 * OpenAI Compatible 的 /models 是标准接口，接得上就列出真名的，接不上就老实说原因，
 * 不要凭空编一串模型名让用户挑。
 */
let modelCache = { at: 0, key: '', list: [] }
export async function listModels({ force = false } = {}) {
  const cfg = aiConfig()
  if (!cfg.enabled || !cfg.apiKey) throw new Error('AI 未启用或未配置 API Key')
  const cacheKey = `${cfg.baseUrl}|${cfg.model}|${crypto.createHash('sha256').update(cfg.apiKey).digest('hex').slice(0, 12)}`
  if (!force && modelCache.key === cacheKey && Date.now() - modelCache.at < 60_000) return modelCache.list
  const res = await fetch(`${cfg.baseUrl}/models`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } })
  if (!res.ok) throw new Error(`取模型列表失败 ${res.status}（该服务可能不支持 /models，可直接手填模型名）`)
  const json = await res.json()
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []
  const list = rows.map(m => String(m?.id || m?.name || '')).filter(Boolean).slice(0, 400)
  if (!list.length) throw new Error('该服务返回的模型列表是空的，可直接手填模型名')
  modelCache = { at: Date.now(), key: cacheKey, list }
  return list
}

export async function generateForm(prompt, { lang = 'zh', kind = 'survey', model } = {}) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `请用${langName(lang)}生成一个${kind === 'exam' ? '考试试卷（含正确答案与分值）' : '问卷'}：${prompt}` }
  ]
  const res = await chat(messages, { model })
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

function langName(lang) {
  return ({ zh: '简体中文', en: 'English', ja: '日本語', ko: '한국어', zhtw: '繁體中文' })[lang] || String(lang || '简体中文')
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

/**
 * 从「流式吐了一半的 JSON」里挖出已经完整的题目。
 *
 * 这是「实时预览」不骗人的那个点：AI 边说边吐 JSON，用户要看到的是「题一道一道长出来」，
 * 而不是一个转圈的菊花配一行「生成中…」。做法是找 fields 数组，按花括号配平切断，
 * 每凑齐一个完整对象就 parse 一次——半个对象（{"type":"radio","la}) 直接跳过，不上屏。
 * 字符串里的括号与转义要跳过，否则题干写「（必填）」就能让配平算错。
 */
export function partialFields(text) {
  const src = String(text || '')
  const key = src.search(/"fields"\s*:\s*\[/)
  if (key < 0) return []
  let i = src.indexOf('[', key) + 1
  const out = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue }
    if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        try {
          const obj = JSON.parse(src.slice(start, i + 1))
          out.push(normalizeField(obj, out.length))
        } catch {}
        start = -1
      }
      if (depth < 0) break
      continue
    }
    if (ch === ']' && depth === 0) break
  }
  return out
}

export async function* streamForm(prompt, { lang = 'zh', kind = 'survey', model } = {}) {
  const res = await chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `请用${langName(lang)}生成${kind === 'exam' ? '考试试卷（含正确答案与分值）' : '问卷'}：${prompt}` }
  ], { stream: true, model })
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
        if (delta) {
          acc += delta
          // fields 一起带上：前端据此把题目一道一道画出来，而不是等全部吐完
          yield { delta, acc, fields: partialFields(acc) }
        }
      } catch {}
    }
  }
}

/* ---------------- 刷题「AI 解析」 ---------------- */

const EXPLAIN_PROMPT = `你是 EQS 题库的答疑助手。用户刚做完一道题，请用 3-6 句话讲清楚：
1. 为什么这个是标准答案（关键概念是什么）；
2. 常见错误选项错在哪；
3. 一句话记忆点或延伸。
只输出正文，不要 Markdown 标题，不要重复题目原文。若题目本身没有标准答案（主观题），就讲答题思路。`

export function explainQuestionLocal(q, given) {
  const ans = answerText(q, (q.answer || []).map(String)) || (q.answer || []).map(String).join('、')
  const mine = answerText(q, given) || '（未作答）'
  const lines = []
  if (ans) lines.push(`标准答案是「${ans}」，你的作答是「${mine}」。`)
  if (q.analysis) lines.push(q.analysis)
  lines.push(`这题考查的是「${q.title}」里的关键概念，把题干中的限制条件逐条对一遍再选，比凭印象更稳。`)
  if (/^(A|B|C|D|正确|错误|对|错)$/i.test(String((q.answer || [])[0] ?? ''))) {
    lines.push('选项题的通用做法：先把明显与题干矛盾的选项划掉，再用剩下的两三个逐字比对题干里的限定词。')
  }
  return lines.join('\n')
}

/**
 * 生成解析。AI 未配置 / 调用失败时退回本地解析，并且**明确标注来源**：
 * 不能让人以为一段模板化的话是模型推出来的结论。
 * withAnswers 由调用方决定（只读协作者、还没作答的人不该拿到答案）。
 */
export async function explainQuestion(q, given, { model, lang = 'zh', withAnswers = true } = {}) {
  const answer = withAnswers ? answerText(q, (q.answer || []).map(String)) : ''
  const user = [
    `题目：${q.title}`,
    Array.isArray(q.options) && q.options.length ? `选项：${q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o.label}`).join(' / ')}` : '',
    withAnswers && answer ? `标准答案：${answer}` : '',
    withAnswers && q.analysis ? `已有解析：${q.analysis}` : '',
    `用户作答：${answerText(q, given) || '（未作答）'}`
  ].filter(Boolean).join('\n')
  try {
    const res = await chat([
      { role: 'system', content: `${EXPLAIN_PROMPT}\n请用${langName(lang)}作答。` },
      { role: 'user', content: user }
    ], { model })
    const json = await res.json()
    const text = String(json.choices?.[0]?.message?.content || '').trim()
    if (!text) throw new Error('AI 返回了空内容')
    return { text, source: 'ai' }
  } catch (e) {
    return { text: explainQuestionLocal({ ...q, analysis: withAnswers ? q.analysis : '' }, given), source: 'local', warning: e.message }
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
