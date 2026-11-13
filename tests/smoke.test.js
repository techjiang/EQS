/**
 * EQS 冒烟测试：不依赖任何测试框架，直接 node tests/smoke.test.js
 * 覆盖：鉴权、表单 CRUD、文本导入、公开提交、条件校验、自动评分、报表、题库刷题、WebHook、备份
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const PORT = 8199
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eqs-test-'))

let passed = 0
let failed = 0
const failures = []

function assert(cond, name, extra = '') {
  if (cond) { passed++; console.log('  ✓', name) }
  else { failed++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  ✗', name, extra) }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health')
      if (r.ok) return true
    } catch {}
    await sleep(250)
  }
  throw new Error('服务启动超时')
}

let cookie = ''
async function req(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const ct = res.headers.get('content-type') || ''
  const json = ct.includes('json') ? await res.json() : null
  return { status: res.status, json, res }
}

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), EQS_DATA_DIR: DATA_DIR, EQS_ADMIN_PASSWORD: 'test-pass-123' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let serverLog = ''
server.stdout.on('data', d => { serverLog += d })
server.stderr.on('data', d => { serverLog += d })

const cleanup = () => {
  server.kill()
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
}

try {
  await waitServer()
  console.log('\n[1] 鉴权')
  let r = await req('GET', '/api/forms')
  assert(r.status === 401, '未登录访问受保护接口返回 401')

  r = await req('POST', '/api/auth/login', { username: 'admin', password: 'wrong' })
  assert(r.status === 401, '错误密码登录失败')

  r = await req('POST', '/api/auth/login', { username: 'admin', password: 'test-pass-123' })
  assert(r.status === 200 && r.json.ok, '管理员登录成功')
  assert(!!cookie, '登录后下发会话 Cookie')

  r = await req('GET', '/api/auth/me')
  assert(r.json.user?.username === 'admin', '会话可识别当前用户')

  console.log('\n[2] 模板与表单')
  r = await req('GET', '/api/templates')
  assert(r.json.data.length >= 6, '内置模板已初始化（≥6 套）')

  const tplId = r.json.data[0].id
  r = await req('POST', `/api/templates/${tplId}/use`)
  const fromTplId = r.json.id
  assert(r.status === 201 && fromTplId > 0, '从模板创建表单成功')

  r = await req('POST', '/api/forms', {
    title: '冒烟测试问卷', kind: 'survey', description: '自动化测试',
    schema: [
      { type: 'radio', label: '性别', required: true, options: ['男', '女'] },
      { type: 'text', label: '姓名', required: true },
      { type: 'text', label: '仅女性可见', logic: [{ fieldId: 'PLACEHOLDER', op: 'eq', value: '女' }] }
    ]
  })
  const formId = r.json.id
  const schema = r.json.data.schema
  assert(r.status === 201 && formId > 0, '创建表单成功')
  const genderId = schema[0].id
  const nameId = schema[1].id
  const logicId = schema[2].id

  await req('PUT', `/api/forms/${formId}`, {
    schema: [
      { ...schema[0] },
      { ...schema[1] },
      { ...schema[2], logic: [{ fieldId: genderId, op: 'eq', value: '女' }] }
    ],
    status: 'published'
  })
  r = await req('GET', `/api/forms/${formId}`)
  assert(r.json.data.status === 'published', '表单可发布')
  assert(r.json.data.schema[2].logic[0].fieldId === genderId, '显隐逻辑已保存')

  console.log('\n[3] 文本批量导入')
  r = await req('POST', `/api/forms/${formId}/import-text`, {
    text: '1. 你如何评价本次服务？ [单选]\nA. 很好\nB. 一般\nC. 很差\n答案：A\n分值：5\n\n2. 补充建议 [多行]'
  })
  assert(r.json.added === 2, '文本导入识别 2 道题', JSON.stringify(r.json))
  const imported = r.json.schema.slice(-2)
  assert(imported[0].options.length === 3, '导入时正确解析选项')
  assert(JSON.stringify(imported[0].answer) === JSON.stringify(['很好']), '导入时答案解析为选项值')
  assert(imported[1].type === 'textarea', '导入时识别多行文本类型')

  console.log('\n[4] 公开填写与校验')
  r = await req('GET', `/api/public/forms/${formId}`)
  assert(r.json.data.title === '冒烟测试问卷', '公开读取表单成功')
  assert(r.json.data.schema.every(f => f.answer.length === 0), '公开接口不泄露正确答案')

  r = await req('POST', `/api/public/forms/${formId}/submit`, { data: { [genderId]: '男' } })
  assert(r.status === 422, '缺少必填项被拒绝', r.json?.message)

  r = await req('POST', `/api/public/forms/${formId}/submit`, { data: { [genderId]: '男', [nameId]: '张三' } })
  assert(r.status === 201, '合法答卷提交成功', r.json?.message)
  const sub1 = r.json.id
  assert(typeof r.json.message === 'string' && r.json.message.length > 0, '返回提交后自定义文案')

  r = await req('GET', '/api/submissions?formId=' + formId)
  assert(r.json.total === 1, '答卷已入库')

  console.log('\n[5] 答卷编辑与统计')
  r = await req('PUT', `/api/submissions/${sub1}`, { data: { [genderId]: '女', [nameId]: '李四', [logicId]: '可见了' } })
  assert(r.json.ok, '答卷可编辑')
  r = await req('GET', `/api/submissions/${sub1}`)
  assert(r.json.data.data[nameId] === '李四', '编辑后数据已更新')

  r = await req('GET', `/api/forms/${formId}/report`)
  assert(r.json.data.total === 1, '报表统计答卷数正确')
  const genderStat = r.json.data.questions.find(q => q.id === genderId)
  assert(genderStat.series.find(s => s.name === '女').value === 1, '单选题统计正确')

  console.log('\n[6] 考试自动评分')
  r = await req('POST', '/api/forms', {
    title: '冒烟考试', kind: 'exam',
    settings: { passScore: 5 },
    schema: [
      { type: 'radio', label: '1+1=?', required: true, options: ['1', '2', '3'], answer: ['2'], score: 5 },
      { type: 'checkbox', label: '偶数有？', required: true, options: ['2', '3', '4'], answer: ['2', '4'], score: 5 }
    ]
  })
  const examId = r.json.id
  const examSchema = r.json.data.schema
  await req('PUT', `/api/forms/${examId}`, { status: 'published' })

  r = await req('POST', `/api/public/forms/${examId}/submit`, {
    data: { [examSchema[0].id]: '2', [examSchema[1].id]: ['2', '4'] }
  })
  assert(r.json.score === 10, '全对得满分 10', String(r.json.score))
  assert(r.json.passed === true, '达到及格线判定通过')

  r = await req('POST', `/api/public/forms/${examId}/submit`, {
    data: { [examSchema[0].id]: '1', [examSchema[1].id]: ['2'] }
  })
  assert(r.json.score === 0, '全错得 0 分', String(r.json.score))
  assert(r.json.passed === false, '未达及格线判定不通过')

  console.log('\n[7] 题库与刷题')
  r = await req('POST', '/api/banks', { name: '冒烟题库' })
  const bankId = r.json.id
  assert(bankId > 0, '创建题库成功')

  r = await req('POST', `/api/banks/${bankId}/import-text`, {
    text: '1. HTTP 默认端口？ [单选]\nA. 21\nB. 80\n答案：B\n分值：5'
  })
  assert(r.json.imported === 1, '题库文本导入成功')

  r = await req('GET', `/api/banks/${bankId}/practice?mode=sequence`)
  const q1 = r.json.data.questions[0]
  assert(!('answer' in q1) || q1.answer === undefined, '刷题接口不返回答案')
  assert(q1.analysis === '', '刷题接口不返回解析')

  r = await req('POST', `/api/banks/${bankId}/practice/answer`, { questionId: q1.id, value: 'B' })
  assert(r.json.correct === true, '刷题判题正确')
  assert(JSON.stringify(r.json.answer) === JSON.stringify(['80']), '判题后返回正确答案（字母已归一为选项值）')

  r = await req('POST', `/api/banks/${bankId}/practice/answer`, { questionId: q1.id, value: 'A' })
  assert(r.json.correct === false, '答错判题正确')
  assert(r.json.wrongCount === 1, '错题记录已更新')

  r = await req('GET', `/api/banks/${bankId}/practice?mode=wrong`)
  assert(r.json.data.questions.length === 1, '错题练习返回错题')

  r = await req('POST', `/api/banks/${bankId}/paper`, { title: '组卷考试', count: 1 })
  assert(r.json.count === 1, '智能组卷成功')

  console.log('\n[8] WebHook 与通知')
  r = await req('POST', '/api/webhooks', { name: '测试钩子', url: 'http://127.0.0.1:1/none', events: ['create'] })
  assert(r.json.ok, 'WebHook 创建成功')
  r = await req('GET', '/api/webhooks')
  assert(r.json.data.length === 1, 'WebHook 列表正确')
  assert(r.json.data[0].events.includes('create'), 'WebHook 事件配置正确')

  r = await req('POST', '/api/api-keys', { name: '集成' })
  assert(r.json.key?.startsWith('eqs_'), 'API Key 生成成功')

  console.log('\n[9] 用户与权限')
  r = await req('POST', '/api/users', { username: 'tester', password: 'tester123', nickname: '测试员', role_id: 2 })
  assert(r.status === 201, '新增用户成功')
  r = await req('POST', '/api/users', { username: 'tester', password: 'tester123' })
  assert(r.status === 409, '重复账号被拒绝')

  const adminCookie = cookie
  await req('POST', '/api/auth/logout')
  cookie = ''
  r = await req('POST', '/api/auth/login', { username: 'tester', password: 'tester123' })
  assert(r.status === 200, '普通用户登录成功')
  r = await req('GET', '/api/settings')
  assert(r.status === 403, '普通用户无权读取系统设置')
  cookie = adminCookie

  console.log('\n[10] 回收中心与备份')
  r = await req('DELETE', `/api/forms/${formId}`)
  assert(r.json.ok, '表单移入回收中心')
  r = await req('GET', '/api/forms?recycle=1')
  assert(r.json.data.some(f => f.id === formId), '回收中心可查到已删表单')
  r = await req('POST', `/api/forms/${formId}/restore`)
  assert(r.json.ok, '表单可恢复')
  r = await req('GET', `/api/forms/${formId}`)
  assert(r.json.data.deleted_at === null, '恢复后状态正确')

  const backup = await fetch(BASE + '/api/backup/export', { headers: { Cookie: adminCookie } })
  const buf = Buffer.from(await backup.arrayBuffer())
  assert(backup.ok && buf.length > 100, '备份导出成功')
  assert(buf.slice(0, 2).toString() === 'PK', '备份为合法 ZIP 包')

  console.log('\n[11] 文件上传与下载')
  const fd = new FormData()
  fd.append('file', new Blob([Buffer.from('EQS 附件内容')], { type: 'text/plain' }), '附件.txt')
  fd.append('formId', String(formId))
  let up = await fetch(BASE + '/api/upload', { method: 'POST', body: fd, headers: { Cookie: adminCookie } })
  const upJson = await up.json()
  assert(up.ok && upJson.url?.startsWith('/api/files/raw/'), '文件上传成功')
  const raw = await fetch(BASE + upJson.url)
  const rawText = await raw.text()
  assert(raw.ok, '上传后可访问原始文件', 'status=' + raw.status)
  assert(rawText === 'EQS 附件内容', '文件内容一致', rawText.slice(0, 40))

  const zip = await fetch(BASE + `/api/forms/${formId}/attachments.zip`, { headers: { Cookie: adminCookie } })
  const zipBuf = Buffer.from(await zip.arrayBuffer())
  assert(zip.ok && zipBuf.slice(0, 2).toString() === 'PK', '附件打包为合法 ZIP')

  console.log('\n[12] 文本导入健壮性与交卷回顾')
  r = await req('POST', `/api/banks/${bankId}/import-text`, {
    text: [
      '[单选] HTML 中表示段落的标签是？',
      'A. <p>',
      'B. <div>',
      '答案：A',
      '分值：5',
      '',
      '[多选] 下列属于 CSS 预处理器的是？',
      'A. Sass',
      'B. Less',
      'C. jQuery',
      '答案：A,B',
      '分值：5',
      '',
      '[判断] HTTP 404 表示资源不存在。',
      '答案：A',
      ''
    ].join('\n')
  })
  assert(r.json.imported === 3, '三题连续导入不串题（判断题不再被吞）', String(r.json.imported))
  const bankQs = (await req('GET', `/api/banks/${bankId}/questions`)).json.data
  const judge = bankQs.find(q => q.title.includes('404'))
  assert(!!judge, '判断题被识别为独立题目')
  assert(judge.options.length === 2 && judge.options[0].label === '正确', '判断题自动补全对错选项')
  const multi = bankQs.find(q => q.type === 'checkbox' && q.title.includes('预处理器'))
  assert(multi && multi.options.length === 3, '多选题选项未混入下一题内容', JSON.stringify(multi?.options))

  r = await req('POST', '/api/forms', {
    title: '及格线测试', kind: 'exam',
    schema: [
      { type: 'radio', label: 'A 题', options: ['对', '错'], answer: ['对'], score: 40 },
      { type: 'radio', label: 'B 题', options: ['对', '错'], answer: ['对'], score: 60 }
    ]
  })
  const pctId = r.json.id
  const pctSchema = r.json.data.schema
  await req('PUT', `/api/forms/${pctId}`, { status: 'published', settings: { passPercent: 60 } })
  r = await req('POST', `/api/public/forms/${pctId}/submit`, { data: { [pctSchema[0].id]: '对', [pctSchema[1].id]: '错' } })
  assert(r.json.score === 40, '按分值计分 40', String(r.json.score))
  assert(r.json.passLine === 60, '及格线按总分百分比折算为 60', String(r.json.passLine))
  assert(r.json.passed === false, '40 分未达 60 及格线')
  assert(r.json.total === 100, '返回卷面总分')
  assert(Array.isArray(r.json.review?.items) && r.json.review.items.length === 2, '交卷后返回逐题回顾')
  assert(r.json.review.items[0].correct === true && r.json.review.items[1].correct === false, '逐题对错判定正确')

  r = await req('POST', '/api/forms', {
    title: '验证码测试', kind: 'survey',
    schema: [{ type: 'captcha', label: '人机校验', required: true }]
  })
  const capId = r.json.id
  const capField = r.json.data.schema[0]
  await req('PUT', `/api/forms/${capId}`, { status: 'published' })
  r = await req('POST', `/api/public/forms/${capId}/submit`, { data: { [capField.id]: '0' } })
  assert(r.status === 422, '验证码错误被拒绝', JSON.stringify(r.json))
  const sum = capField.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const expect = (sum % 7) + 2 + ((sum % 5) + 2)
  r = await req('POST', `/api/public/forms/${capId}/submit`, { data: { [capField.id]: String(expect) } })
  assert(r.status === 201, '验证码正确可通过（服务端真实校验）', JSON.stringify(r.json))

  console.log('\n[13] 刷题：收藏与笔记不应判错')
  r = await req('GET', `/api/banks/${bankId}/practice?mode=sequence`)
  const practiceQ = r.json.data.questions[0]
  const wrongBefore = r.json.data.wrongCount
  r = await req('POST', `/api/banks/${bankId}/practice/answer`, { questionId: practiceQ.id, value: '', judge: false, favorite: true })
  assert(r.json.judged === false && r.json.correct === null, '收藏不算一次作答', JSON.stringify(r.json))
  r = await req('GET', `/api/banks/${bankId}/practice?mode=sequence`)
  assert(r.json.data.wrongCount === wrongBefore, '收藏后错题数不变', `${wrongBefore} → ${r.json.data.wrongCount}`)
  assert(r.json.data.questions.find(q => q.id === practiceQ.id).favorite === true, '收藏状态已保存')
  r = await req('POST', `/api/banks/${bankId}/practice/answer`, { questionId: practiceQ.id, value: '', judge: false, note: '记一笔' })
  r = await req('GET', `/api/banks/${bankId}/practice?mode=sequence`)
  assert(r.json.data.wrongCount === wrongBefore, '写笔记后错题数不变')
  // 真作答仍能正常判题
  const correctAnswer = (await req('GET', `/api/banks/${bankId}/questions`)).json.data.find(q => q.id === practiceQ.id).answer
  r = await req('POST', `/api/banks/${bankId}/practice/answer`, { questionId: practiceQ.id, value: correctAnswer, judge: true })
  assert(r.json.judged === true && r.json.correct === true, '显式作答仍正确判题', JSON.stringify(r.json))

  console.log('\n[14] 主观题不计入自动判分')
  r = await req('POST', '/api/forms', {
    title: '主观题口径', kind: 'exam',
    schema: [
      { type: 'radio', label: '客观题', options: ['对', '错'], answer: ['对'], score: 50 },
      { type: 'textarea', label: '主观题', score: 50 }
    ]
  })
  const mixId = r.json.id
  const mixSchema = r.json.data.schema
  await req('PUT', `/api/forms/${mixId}`, { status: 'published', settings: { passPercent: 60 } })
  r = await req('POST', `/api/public/forms/${mixId}/submit`, { data: { [mixSchema[0].id]: '对', [mixSchema[1].id]: '写了很多' } })
  assert(r.json.total === 50, '可判分总分只算客观题', String(r.json.total))
  assert(r.json.paperTotal === 100, '卷面总分仍为 100', String(r.json.paperTotal))
  assert(r.json.passed === true, '客观题全对即通过（不再被主观题拖成永远不及格）', JSON.stringify({ score: r.json.score, passLine: r.json.passLine }))
  assert(r.json.ungraded === 1, '返回待人工批阅题数')

  console.log('\n[15] 导入答案越界保护与答卷查询')
  r = await req('POST', `/api/banks/${bankId}/import-text`, {
    text: ['[单选] 只有两个选项的题', 'A. 甲', 'B. 乙', '答案：D', '分值：5'].join('\n')
  })
  assert(r.json.droppedAnswers?.length === 1, '越界答案被标记', JSON.stringify(r.json))
  const badQ = (await req('GET', `/api/banks/${bankId}/questions`)).json.data.find(q => q.title.includes('两个选项'))
  assert(badQ && badQ.answer.length === 0, '越界答案被剔除，题目不会永远答错')

  await req('PUT', `/api/forms/${formId}`, { settings: { allowQuery: true } })
  r = await req('GET', `/api/public/forms/${formId}/query?submissionId=${sub1}`)
  assert(r.status === 200 && r.json.data.id === sub1, '开放查询后可按编号取回答卷', JSON.stringify(r.json))
  await req('PUT', `/api/forms/${formId}`, { settings: { allowQuery: false } })
  r = await req('GET', `/api/public/forms/${formId}/query?submissionId=${sub1}`)
  assert(r.status === 403, '未开放查询时拒绝访问')

  console.log('\n[16] API Key 鉴权与公开页信息边界')
  r = await req('POST', '/api/api-keys', { name: '集成测试' })
  const apiKey = r.json.key
  assert(!!apiKey, 'API Key 创建成功')
  let kres = await fetch(BASE + '/api/submissions', { headers: { 'X-API-Key': apiKey } })
  assert(kres.ok, 'X-API-Key 可调用受保护接口（文档承诺与实际一致）', 'status=' + kres.status)
  kres = await fetch(BASE + '/api/submissions', { headers: { 'X-API-Key': 'eqs_bogus' } })
  assert(kres.status === 401, '错误的 API Key 被拒绝')
  const keyList = (await req('GET', '/api/api-keys')).json.data
  await req('DELETE', `/api/api-keys/${keyList[0].id}`)
  kres = await fetch(BASE + '/api/submissions', { headers: { 'X-API-Key': apiKey } })
  assert(kres.status === 401, '停用后 API Key 立即失效')

  await req('PUT', `/api/forms/${formId}`, { settings: { needPassword: true, password: 'p@ss', whitelist: ['1.2.3.4'], notifyEmail: 'a@b.com', allowQuery: true } })
  const pub = await (await fetch(BASE + `/api/public/forms/${formId}`)).json()
  assert(pub.data.settings.password === undefined, '公开表单不下发访问密码')
  assert(pub.data.settings.whitelist === undefined, '公开表单不下发白名单')
  assert(pub.data.settings.notifyEmail === undefined, '公开表单不下发通知邮箱')
  assert(pub.data.settings.needPassword === true, '公开表单仍保留「需要密码」开关')
  await req('PUT', `/api/forms/${formId}`, { settings: { allowQuery: true } })

  let anonUp = await fetch(BASE + '/api/upload?name=x.txt', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'xx' })
  assert(anonUp.status === 401, '匿名无表单上下文时不能上传（不做公共图床）')
  anonUp = await fetch(BASE + `/api/upload?name=x.txt&formId=${formId}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'xx' })
  assert(anonUp.status === 201, '已发布表单的匿名作答可上传附件', 'status=' + anonUp.status)

  console.log('\n[17] 文本导入括号题型识别')
  r = await req('POST', '/api/forms', { title: '括号题型', schema: [] })
  const bracketId = r.json.id
  r = await req('POST', `/api/forms/${bracketId}/import-text`, {
    text: [
      '1. 简述事件循环（Event Loop）的作用 [简答]',
      '2. 打分（1-5）[评分]',
      '3. 请填写你的邮箱（工作邮箱）[邮箱]',
      '4. 请写下你的建议（可选）[多行]'
    ].join('\n')
  })
  const bs = r.json.schema
  assert(bs.length === 4, '括号内含括号的题干不会被拆错', String(bs.length))
  assert(bs[0].type === 'textarea' && bs[0].label === '简述事件循环（Event Loop）的作用', '题干内括号不干扰题型识别', JSON.stringify(bs[0]))
  assert(bs[1].type === 'rate' && bs[1].label === '打分（1-5）', '题干尾部括号保留、题型正确', JSON.stringify(bs[1]))
  assert(bs[2].type === 'email', '邮箱题型识别正确', bs[2].type)
  assert(bs[3].type === 'textarea', '多行题型识别正确', bs[3].type)


  console.log('\n[19] 主观题人工批阅')
  // 建一份「客观题 20 分 + 主观题 20 分」的卷子
  r = await req('POST', '/api/forms', {
    title: '批阅测试卷', kind: 'exam',
    schema: [
      { id: 'q1', type: 'radio', label: 'HTTP 404 表示？', options: [{ label: '未找到', value: 'A' }, { label: '成功', value: 'B' }], answer: ['A'], score: 20, required: true },
      { id: 'q2', type: 'textarea', label: '简述事件循环', answer: [], score: 20 },
      { id: 'q3', type: 'text', label: '附加题', answer: [], score: 0 }
    ],
    settings: { passPercent: 60 }
  })
  const reviewFormId = r.json.id
  await req('PUT', `/api/forms/${reviewFormId}`, { status: 'published' })

  r = await req('POST', `/api/public/forms/${reviewFormId}/submit`, { data: { q1: 'A', q2: '宏任务与微任务交替执行' } })
  const subId = r.json.id
  assert(r.json.graded === true, '客观题有答案 → 已有可自动判分题目')
  assert(r.json.score === 20, '自动判分只算客观题：20 分', String(r.json.score))
  assert(r.json.total === 20, '可判分总分 20（主观题暂不计入）', String(r.json.total))
  assert(r.json.paperTotal === 40, '卷面总分 40 分单独回传', String(r.json.paperTotal))
  assert(r.json.ungraded === 1, '待批阅题目数 1', String(r.json.ungraded))
  assert(r.json.passed === true, '客观题全对即按 20 分口径通过（不再被主观题拖成永久不及格）')

  r = await req('PUT', `/api/submissions/${subId}/review`, { scores: { q2: 15 }, note: '思路正确' })
  assert(r.status === 200 && r.json.ok, '批阅接口可用', 'status=' + r.status)
  assert(r.json.data.score === 35, '批阅后重算总分 20 + 15 = 35', String(r.json.data?.score))
  assert(r.json.data.passed === 1, '批阅后仍通过（35/40 ≥ 60%）', String(r.json.data?.passed))
  assert(r.json.data.manual_scores?.q2 === 15, '人工分被持久化')
  assert(!!r.json.data.reviewed_at, '记录批阅时间')

  r = await req('GET', `/api/submissions/${subId}`)
  assert(r.json.data.score === 35, '详情接口读到重算后的成绩')

  r = await req('PUT', `/api/submissions/${subId}/review`, { scores: { q2: 99 } })
  assert(r.status === 400, '给分超过题目分值被拒绝', 'status=' + r.status)
  r = await req('PUT', `/api/submissions/${subId}/review`, { scores: { q1: 20 } })
  assert(r.status === 200 && r.json.data.score === 20, '客观题不接受人工加分（只认主观题）', String(r.json.data?.score))
  r = await req('PUT', `/api/submissions/${subId}/review`, { scores: { q2: -5 } })
  assert(r.status === 400, '负分被拒绝')

  r = await req('PUT', `/api/submissions/${subId}/review`, { scores: { q2: 0 } })
  assert(r.json.data.score === 20, '主观题给 0 分时总分回落到客观题得分', String(r.json.data?.score))
  assert(r.json.data.passed === 0, '主观题 0 分 → 20/40 未达 60% 及格线', String(r.json.data?.passed))

  // 全主观题的卷子：交卷时显示待批阅，批阅后才有成绩口径
  r = await req('POST', '/api/forms', {
    title: '全主观卷', kind: 'exam',
    schema: [{ id: 's1', type: 'textarea', label: '谈谈你的理解', answer: [], score: 30 }],
    settings: { passPercent: 60 }
  })
  const essayFormId = r.json.id
  await req('PUT', `/api/forms/${essayFormId}`, { status: 'published' })
  r = await req('POST', `/api/public/forms/${essayFormId}/submit`, { data: { s1: '我的理解是……' } })
  const essaySubId = r.json.id
  assert(r.json.graded === false, '全主观卷交卷时标记为「待批阅」而非 0 分')
  r = await req('PUT', `/api/submissions/${essaySubId}/review`, { scores: { s1: 24 } })
  assert(r.json.data.score === 24 && r.json.data.passed === 1, '全主观卷批阅后按 24/30 判定通过', String(r.json.data?.score))

  // 待批阅筛选
  r = await req('GET', `/api/submissions?pending=1&pageSize=100`)
  assert(Array.isArray(r.json.data), '待批阅筛选可查询')

  console.log('\n[20] 多题库混合组卷')
  r = await req('POST', '/api/banks', { name: '组卷库 A' })
  const bankA = r.json.id
  r = await req('POST', '/api/banks', { name: '组卷库 B' })
  const bankB = r.json.id
  for (let i = 1; i <= 6; i++) {
    await req('POST', `/api/banks/${bankA}/questions`, {
      type: 'radio', label: `A 库题 ${i}`, options: [{ label: '对', value: 'Y' }, { label: '错', value: 'N' }], answer: ['Y'], score: 5
    })
  }
  for (let i = 1; i <= 2; i++) {
    await req('POST', `/api/banks/${bankB}/questions`, {
      type: 'text', label: `B 库题 ${i}`, score: 10
    })
  }
  r = await req('POST', '/api/banks/paper', { title: '混合卷', bankIds: [bankA, bankB], count: 4, duration: 30, passPercent: 70 })
  assert(r.status === 201 && r.json.count === 4, '按数量抽题成功', String(r.json.count))
  assert(r.json.banks?.length === 2, '两个孩子题库都被抽到（轮转均摊）', JSON.stringify(r.json.banks))
  const mixedId = r.json.id
  r = await req('GET', `/api/forms/${mixedId}`)
  assert(r.json.data.kind === 'exam', '生成的表单是考试类型')
  assert(r.json.data.schema.length === 4, '卷面题目数与请求一致', String(r.json.data.schema.length))
  assert(r.json.data.settings.passPercent === 70, '及格线按百分比写入', String(r.json.data.settings?.passPercent))

  r = await req('POST', '/api/banks/paper', { bankIds: [bankA], count: 100 })
  assert(r.json.count === 6, '抽题数量超过题库容量时取全部', String(r.json.count))
  r = await req('POST', '/api/banks/paper', { bankIds: [999999], count: 3 })
  assert(r.status === 400, '非法题库 id 被拒绝', 'status=' + r.status)

  console.log('\n[18] 前端静态资源')
  for (const p of ['/', '/js/main.js', '/css/app.css', '/assets/eqs-mark.svg', '/vendor/echarts.min.js']) {
    const res = await fetch(BASE + p)
    assert(res.ok, `静态资源可访问：${p}`)
  }
} catch (e) {
  failed++
  failures.push('测试执行异常：' + e.message)
  console.error('\n测试执行异常：', e)
  if (serverLog) console.error('--- 服务日志 ---\n' + serverLog.slice(-2000))
} finally {
  console.log(`\n结果：通过 ${passed}，失败 ${failed}`)
  if (failures.length) console.log('失败项：\n' + failures.map(f => ' - ' + f).join('\n'))
  cleanup()
  process.exit(failed ? 1 : 0)
}
