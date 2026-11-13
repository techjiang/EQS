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
  // 公开接口按白名单下发字段，answer 干脆不存在——不是「返回了空数组」
  assert(r.json.data.schema.every(f => f.answer === undefined), '公开接口不下发正确答案字段')
  assert(r.json.data.schema.every(f => Object.keys(f).every(k => !/answer|analysis/i.test(k))), '公开接口不下发任何含 answer 的键')

  r = await req('POST', `/api/public/forms/${formId}/submit`, { data: { [genderId]: '男' } })
  assert(r.status === 422, '缺少必填项被拒绝', r.json?.message)

  r = await req('POST', `/api/public/forms/${formId}/submit`, { data: { [genderId]: '男', [nameId]: '张三' } })
  assert(r.status === 201, '合法答卷提交成功', r.json?.message)
  const sub1 = r.json.id
  const sub1Code = r.json.publicId
  assert(/^[0-9a-z]{5}-[0-9a-z]{5}$/.test(String(sub1Code)), '提交后返回不可猜的答卷编号', String(sub1Code))
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
  r = await req('GET', `/api/public/forms/${formId}/query?submissionId=${sub1Code}`)
  assert(r.status === 200 && r.json.data.id === sub1, '开放查询后可按编号取回答卷', JSON.stringify(r.json))
  // 自增 id 不再能当编号用：编号一旦可猜，NAT 后面的陌生访客就能把全站答卷翻一遍
  r = await req('GET', `/api/public/forms/${formId}/query?submissionId=${sub1}`, undefined, { 'User-Agent': 'someone-else-browser' })
  assert(r.status === 404, '自增 id 不能再当代替编号查别人的答卷', JSON.stringify(r.json))
  r = await req('GET', `/api/public/forms/${formId}/query?submissionId=00000-00000`, undefined, { 'User-Agent': 'stranger-device', 'X-Forwarded-For': '203.0.113.9' })
  assert(r.status === 404, '随便编号查不到任何东西')
  await req('PUT', `/api/forms/${formId}`, { settings: { allowQuery: false } })
  r = await req('GET', `/api/public/forms/${formId}/query?submissionId=${sub1Code}`)
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


  console.log('\n[18] 主观题人工批阅')
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

  console.log('\n[19] 多题库混合组卷')
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

  console.log('\n[20] 备份包必须能恢复出完整数据库')
  {
    // WAL 模式下新数据先落 eqs.db-wal，eqs.db 主文件可能还是空的。
    // 之前导出不做 checkpoint，备份包里的 eqs.db 是个没有表的空壳——「备份成功，恢复全空」。
    const bak = await fetch(BASE + '/api/backup/export', { headers: { Cookie: cookie } })
    const buf = Buffer.from(await bak.arrayBuffer())
    const entries = []
    let off = 0
    while (off < buf.length - 4) {
      if (buf.readUInt32LE(off) !== 0x04034b50) break
      const size = buf.readUInt32LE(off + 18)
      const nl = buf.readUInt16LE(off + 26)
      const el = buf.readUInt16LE(off + 28)
      entries.push({ name: buf.slice(off + 30, off + 30 + nl).toString('utf8'), data: buf.slice(off + 30 + nl + el, off + 30 + nl + el + size) })
      off = off + 30 + nl + el + size
    }
    const dbEntry = entries.find(e => e.name === 'eqs-data/eqs.db')
    assert(!!dbEntry && dbEntry.data.length > 8192, '备份包里有非空的 eqs.db', `size=${dbEntry?.data.length}`)
    const restored = path.join(DATA_DIR, 'restored-check.db')
    fs.writeFileSync(restored, dbEntry.data)
    const { DatabaseSync } = await import('node:sqlite')
    const rdb = new DatabaseSync(restored)
    const userCount = rdb.prepare('SELECT COUNT(*) c FROM users').get().c
    const formCount = rdb.prepare('SELECT COUNT(*) c FROM forms').get().c
    rdb.close()
    assert(userCount >= 1, '从备份的 eqs.db 能读出用户表', String(userCount))
    assert(formCount >= 1, '从备份的 eqs.db 能读出表单表', String(formCount))
  }

  console.log('\n[21] 备份导入当场生效')
  {
    // 之前导入只写一个 eqs.db.next 等重启，但面板已经显示「导入成功」，
    // 用户看到的是一个空站。现在要求导入后立刻能读到备份里的数据。
    let r = await req('POST', '/api/forms', { title: '只有备份里才有的表单', kind: 'survey' })
    const markId = r.json.id
    const zip2 = Buffer.from(await (await fetch(BASE + '/api/backup/export', { headers: { Cookie: cookie } })).arrayBuffer())
    await req('DELETE', `/api/forms/${markId}`)
    r = await req('GET', `/api/forms/${markId}`)
    assert(!!r.json.data?.deleted_at, '删除后表单进入回收站')

    const fd = new FormData()
    fd.append('file', new Blob([zip2]), 'backup.zip')
    const imp = await fetch(BASE + '/api/backup/import', { method: 'POST', headers: { Cookie: cookie }, body: fd })
    const impJson = await imp.json()
    assert(imp.ok && impJson.ok, '备份导入接口返回成功', JSON.stringify(impJson))
    assert(impJson.restartRequired === false, '导入后无需重启即生效', String(impJson.restartRequired))
    r = await req('GET', `/api/forms/${markId}`)
    assert(r.status === 200 && !r.json.data?.deleted_at, '导入后立刻能读到备份里的表单', `status=${r.status}`)
    assert(zip2.length > 8000, '备份包不是空壳', String(zip2.length))
  }

  console.log('\n[22] 隐藏题残留作答与验证码题面')
  {
    const schema = [
      { id: 'logic_base', type: 'radio', label: '是否有过敏史', required: true, options: [{ label: '是', value: 'y' }, { label: '否', value: 'n' }] },
      { id: 'logic_follow', type: 'text', label: '过敏原', required: true, logic: [{ fieldId: 'logic_base', op: 'eq', value: 'y' }] },
      { id: 'captcha_x', type: 'captcha', label: '安全校验', required: true },
      { id: 'nps_x', type: 'nps', label: '推荐意愿', required: true, score: 5, answer: ['0'], props: { min: -2, max: 2 } }
    ]
    let r = await req('POST', '/api/forms', { title: '逻辑探针', kind: 'exam', schema, settings: { passPercent: 60 } })
    const fid = r.json.id
    await req('PUT', `/api/forms/${fid}`, { status: 'published' })
    r = await req('GET', `/api/public/forms/${fid}`)
    const cap = r.json.data.schema.find(f => f.type === 'captcha')
    assert(!!cap.challenge && typeof cap.challenge.a === 'number', '公开页下发了验证码题面', JSON.stringify(cap.challenge))
    assert(!cap.answer?.length, '验证码答案仍未下发')
    const nps = r.json.data.schema.find(f => f.type === 'nps')
    assert(nps.props.min === -2 && nps.props.max === 2, 'NPS 负数下限被保留', JSON.stringify(nps.props))

    // 选「否」时追问隐藏，但请求里仍带着追问的值：必须被丢弃，不能入库
    r = await req('POST', `/api/public/forms/${fid}/submit`, {
      data: { logic_base: 'n', logic_follow: '残留的过敏原', captcha_x: String(cap.challenge.a + cap.challenge.b), nps_x: 0 }
    })
    assert(r.status === 201, '隐藏题的必填不再拦截', `status=${r.status} ${r.json.message || ''}`)
    const sid = r.json.id
    r = await req('GET', `/api/submissions/${sid}`)
    assert(r.json.data.data.logic_follow === undefined, '隐藏题的残留作答被丢弃', JSON.stringify(r.json.data.data))
    assert(String(r.json.data.data.nps_x) === '0', 'NPS 选 0 分被保存', String(r.json.data.data.nps_x))

    // 隐藏题不填也能提交；显示出来就必须填
    r = await req('POST', `/api/public/forms/${fid}/submit`, {
      data: { logic_base: 'y', captcha_x: String(cap.challenge.a + cap.challenge.b), nps_x: 0 }
    })
    assert(r.status === 422 && /过敏原/.test(r.json.message), '显示出来的必填题仍然拦截', r.json.message)

    // 待批阅筛选：纯客观题的交卷不该进阅卷队列
    r = await req('GET', '/api/submissions?pending=1&pageSize=200')
    const pendingIds = (r.json.data || []).map(x => x.id)
    const own = await req('GET', `/api/forms/${fid}`)
    const subjIds = (own.json.data.schema || []).filter(f => Number(f.score) > 0 && !(f.answer || []).length).map(f => f.id)
    // 队列里有别的卷子时，确认这份纯客观卷不在其中
    assert(sid > 0 && subjIds.length === 0, '这份卷子确实没有主观题', JSON.stringify(subjIds))
    const queued = await req('GET', `/api/submissions?formId=${fid}&pending=1&pageSize=200`)
    assert(!(queued.json.data || []).some(x => x.id === sid), '没有主观题的交卷不进待批阅队列',
      JSON.stringify((queued.json.data || []).map(x => x.id)))

    // 只批了一部分主观题：剩下那道还应该留在队列里
    let rb = await req('POST', '/api/forms', { title: '部分批阅探针', kind: 'exam', schema: [
      { id: 'subj_a', type: 'textarea', label: '简答一', score: 10 },
      { id: 'subj_b', type: 'textarea', label: '简答二', score: 10 }
    ], settings: { passPercent: 60 } })
    const bid = rb.json.id
    await req('PUT', `/api/forms/${bid}`, { status: 'published' })
    rb = await req('POST', '/api/forms', { title: '占位' }) // 触发一次写，确保 WAL 里也有新数据
    rb = await req('POST', `/api/public/forms/${bid}/submit`, { data: { subj_a: '甲', subj_b: '乙' } })
    const partId = rb.json.id
    await req('PUT', `/api/submissions/${partId}/review`, { scores: { subj_a: 8 } })
    r = await req('GET', '/api/submissions?pending=1&pageSize=200')
    assert((r.json.data || []).some(x => x.id === partId), '只批了一部分的主观题仍留在待批阅队列')
    await req('PUT', `/api/submissions/${partId}/review`, { scores: { subj_a: 8, subj_b: 9 } })
    r = await req('GET', '/api/submissions?pending=1&pageSize=200')
    assert(!(r.json.data || []).some(x => x.id === partId), '全部批完后移出待批阅队列')
  }

  console.log('\n[23] 公开页不夹带答案、备份可往返、附件可打包')
  {
    // 标准答案能藏进任意自定义属性：只删顶层 answer 是不够的
    r = await req('POST', '/api/forms', {
      title: '答案走私探针', kind: 'exam', status: 'published',
      schema: [
        { id: 'q1', type: 'radio', label: '地球是圆的', options: ['对', '错'], answer: ['对'], score: 5,
          props: { answers: ['对'], tip: '答案是「对」', min: 1 } }
      ]
    })
    const secretForm = r.json.id
    r = await req('GET', `/api/public/forms/${secretForm}`)
    const probe = r.json.data.schema[0]
    assert(!JSON.stringify(probe).includes('答案'), '公开页不下发藏在 props 里的答案', JSON.stringify(probe))
    assert(probe.props?.answers === undefined, '未登记的自定义属性一律不下发')
    assert(probe.props?.min === 1, '作答需要的 props 仍然下发')

    // 匿名提交必须拿到不可猜编号；换 UA 猜自增 id 猜不到东西
    r = await req('POST', `/api/public/forms/${secretForm}/submit`, { data: { q1: '对' } })
    const ownId = r.json.id
    const ownCode = r.json.publicId
    assert(r.status === 201 && !!ownCode, '匿名提交返回答卷编号', JSON.stringify(r.json))
    await req('PUT', `/api/forms/${secretForm}`, { settings: { allowQuery: true } })
    r = await req('GET', `/api/public/forms/${secretForm}/query?submissionId=${ownCode}`, undefined, { 'User-Agent': 'someone-else' })
    assert(r.status === 200 && r.json.data.id === ownId, '本人凭编号可查回自己的答卷', JSON.stringify(r.json))
    r = await req('GET', `/api/public/forms/${secretForm}/query?submissionId=${ownId}`, undefined, { 'User-Agent': 'someone-else' })
    assert(r.status === 404, '换设备猜自增 id 查不到答卷', JSON.stringify(r.json))

    // 备份 → 导入：附件要合并进来，而不是被无视或者反向覆盖
    const fAz = new FormData()
    fAz.append('file', new Blob([Buffer.from('备份前的附件')], { type: 'text/plain' }), 'a.txt')
    fAz.append('formId', String(secretForm))
    let up2 = await fetch(BASE + '/api/upload', { method: 'POST', body: fAz, headers: { Cookie: adminCookie } })
    const upAz = await up2.json()
    assert(up2.ok, '登录用户上传附件成功', JSON.stringify(upAz))

    const bak = await fetch(BASE + '/api/backup/export', { headers: { Cookie: adminCookie } })
    const bakBuf = Buffer.from(await bak.arrayBuffer())
    assert(bakBuf.slice(0, 2).toString() === 'PK', '备份包可导出')
    const before = await req('GET', '/api/files')
    const beforeNames = (before.json.data || []).map(x => x.name)
    assert(beforeNames.includes('a.txt'), '附件已入库', JSON.stringify(beforeNames))

    const imp = new FormData()
    imp.append('file', new Blob([bakBuf], { type: 'application/zip' }), 'backup.zip')
    const impRes = await fetch(BASE + '/api/backup/import', { method: 'POST', body: imp, headers: { Cookie: adminCookie } })
    const impJson = await impRes.json()
    assert(impJson.ok, '备份可导入', JSON.stringify(impJson))
    const after = await req('GET', '/api/files')
    assert((after.json.data || []).some(x => x.name === 'a.txt'), '导入后附件仍在（不会被反向清空）')
    assert(typeof impJson.note === 'string' && impJson.note.includes('合并'), '导入结果说明附件的处理方式')

    // multipart 解析：字段顺序不固定 + 首段前面没有 CRLF
    const form3 = new FormData()
    form3.append('formId', String(secretForm))
    form3.append('file', new Blob([Buffer.from('顺序测试')], { type: 'text/plain' }), 'b.txt')
    const up3 = await fetch(BASE + '/api/upload', { method: 'POST', body: form3, headers: { Cookie: adminCookie } })
    const up3Json = await up3.json()
    assert(up3.ok && up3Json.size === Buffer.from('顺序测试').length, '文件大小准确（首段不被吞掉）', JSON.stringify(up3Json))
    const raw3 = await fetch(BASE + up3Json.url)
    assert((await raw3.text()) === '顺序测试', '上传内容逐字节一致')

    // 打包附件：给一份答卷认领两个同名文件，不能互相覆盖
    const formZ = await req('POST', '/api/forms', { title: '附件打包探针', status: 'published',
      schema: [{ id: 'fz', type: 'upload', label: '截图' }] })
    const zid = formZ.json.id
    const uploadOnes = async (txt, name) => {
      const fd2 = new FormData()
      fd2.append('file', new Blob([Buffer.from(txt)], { type: 'text/plain' }), name)
      fd2.append('formId', String(zid))
      const res = await fetch(BASE + '/api/upload', { method: 'POST', body: fd2, headers: { Cookie: adminCookie } })
      return res.json()
    }
    const f1 = await uploadOnes('第一张', '截图.png')
    const f2 = await uploadOnes('第二张', '截图.png')
    const subZ = await req('POST', `/api/public/forms/${zid}/submit`, { data: { fz: [f1, f2] } })
    assert(subZ.status === 201, '带附件的答卷提交成功', JSON.stringify(subZ.json))
    const zipRes = await fetch(BASE + `/api/forms/${zid}/attachments.zip`, { headers: { Cookie: adminCookie } })
    const zipData = Buffer.from(await zipRes.arrayBuffer())
    assert(zipRes.ok && zipData.slice(0, 2).toString() === 'PK', '附件打包成功')
    assert(Number(zipRes.headers.get('x-eqs-files')) === 2, '同名附件不互相覆盖', zipRes.headers.get('x-eqs-files'))
    // ZIP 里的文件名带 UTF-8 标志位，直接按 UTF-8 搜同名副本
    assert(zipData.includes(Buffer.from('截图(1).png', 'utf8')), '同名附件被重命名保留')
  }

  console.log('\n[24] 题库与卷面的答案口径一致')
  {
    r = await req('POST', '/api/banks', { name: '口径探针题库' })
    const bid2 = r.json.id
    r = await req('POST', `/api/banks/${bid2}/import-text`, {
      text: ['[多选] 哪些是水果？', 'A. 苹果', 'B. 白菜', '答案：A', '分值：5',
        '', '[判断] 地球是圆的。', '答案：A', '分值：5'].join('\n')
    })
    assert(r.json.imported === 2, '题库导入多选与判断', JSON.stringify(r.json))
    r = await req('POST', `/api/banks/${bid2}/paper`, { title: '口径探针试卷', count: 10 })
    const pid = r.json.id
    const paper = await req('GET', `/api/forms/${pid}`)
    const paperSchema = paper.json.data.schema
    const judge = paperSchema.find(f => f.label.includes('地球'))
    const multi = paperSchema.find(f => f.label.includes('水果'))
    assert(judge && JSON.stringify(judge.answer) === JSON.stringify(['正确']), '判断题答案落到卷面是「正确」', JSON.stringify(judge?.answer))
    assert(multi && JSON.stringify(multi.answer) === JSON.stringify(['苹果']), '多选题答案落到卷面是选项值', JSON.stringify(multi?.answer))

    // 真正答对，必须判满分：以前答案对不上选项值，全对也是 0 分
    await req('PUT', `/api/forms/${pid}`, { status: 'published' })
    r = await req('POST', `/api/public/forms/${pid}/submit`, {
      data: { [judge.id]: '正确', [multi.id]: ['苹果'] }
    })
    assert(r.json.score === 10 && r.json.passed === true, '从题库组的卷子答对就是满分', JSON.stringify({ score: r.json.score, total: r.json.total }))
    r = await req('POST', `/api/public/forms/${pid}/submit`, {
      data: { [judge.id]: '错误', [multi.id]: ['苹果'] }
    })
    assert(r.json.score === 5, '答错一题扣掉对应分', String(r.json.score))
  }

  console.log('\n[25] 排序题的「没动过」要算没作答')
  {
    r = await req('POST', '/api/forms', {
      title: '排序必填探针', status: 'published',
      schema: [{ id: 's1', type: 'sort', label: '请按重要性排序', required: true,
        options: [{ label: '快', value: '快' }, { label: '稳', value: '稳' }] }]
    })
    const sidX = r.json.id
    r = await req('POST', `/api/public/forms/${sidX}/submit`, { data: { s1: [] } })
    assert(r.status === 422, '排序题没动过就提交被拦下', JSON.stringify(r.json))
    r = await req('POST', `/api/public/forms/${sidX}/submit`, { data: { s1: ['稳', '快'] } })
    assert(r.status === 201, '真的排了序就能提交', JSON.stringify(r.json))
  }

  console.log('\n[26] 子表单：结构、必填与子字段校验')
  {
    r = await req('POST', '/api/forms', {
      title: '子表单探针', status: 'published',
      schema: [{ type: 'subform', label: '家庭成员', required: true, props: { fields: [{ label: '姓名' }, { label: '手机号' }] } }]
    })
    const sfField = r.json.data.schema[0]
    assert(Array.isArray(sfField.props.fields) && sfField.props.fields.length === 2, '子表单字段结构被保住', JSON.stringify(sfField.props))
    assert(sfField.props.fields.every(x => x.id), '子字段自动补齐 id', JSON.stringify(sfField.props.fields))

    const sfForm = r.json.id
    r = await req('POST', `/api/public/forms/${sfForm}/submit`, { data: { [sfField.id]: [] } })
    assert(r.status === 422, '子表单为空时必填拦下', JSON.stringify(r.json))
    r = await req('POST', `/api/public/forms/${sfForm}/submit`, { data: { [sfField.id]: [{ [sfField.props.fields[0].id]: '' }] } })
    assert(r.status === 422, '子表单只加了一行空记录也算没填', JSON.stringify(r.json))
    r = await req('POST', `/api/public/forms/${sfForm}/submit`, {
      data: { [sfField.id]: [{ [sfField.props.fields[0].id]: '张三', [sfField.props.fields[1].id]: '13800138000' }] }
    })
    assert(r.status === 201, '子表单填对了就能提交', JSON.stringify(r.json))
    r = await req('POST', `/api/public/forms/${sfForm}/submit`, {
      data: { [sfField.id]: [{ [sfField.props.fields[0].id]: '张三', [sfField.props.fields[1].id]: '123' }] }
    })
    assert(r.status === 422 && /手机号/.test(r.json.message || ''), '子字段手机号也会校验', JSON.stringify(r.json))
  }

  console.log('\n[27] 刷题记录不虚高、错题模式不空转')
  {
    r = await req('POST', '/api/banks', { name: '刷题记录探针' })
    const bid3 = r.json.id
    r = await req('POST', `/api/banks/${bid3}/import-text`, { text: '1. 1+1=? [单选]\nA. 1\nB. 2\n答案：B' })
    r = await req('GET', `/api/banks/${bid3}/practice?mode=sequence`)
    const one = r.json.data.questions[0]
    await req('POST', `/api/banks/${bid3}/practice/answer`, { questionId: one.id, value: 'A' })
    r = await req('GET', `/api/banks/${bid3}/practice?mode=wrong`)
    assert(r.json.data.questions.length === 1, '答错后进错题集', JSON.stringify(r.json.data.questions))
    // 把进度推到题库末尾：错题模式不能因此给出空列表
    await req('POST', `/api/banks/${bid3}/practice/answer`, { questionId: one.id, value: 'B', progress: 1, judge: true, streakToClear: 1 })
    r = await req('GET', `/api/banks/${bid3}/practice?mode=wrong`)
    assert(r.json.data.questions.length === 0, '答对后按阈值移出错题集')
    await req('POST', `/api/banks/${bid3}/practice/answer`, { questionId: one.id, value: 'A', progress: 1, judge: true })
    r = await req('GET', `/api/banks/${bid3}/practice?mode=wrong`)
    assert(r.json.data.questions.length === 1 && r.json.data.resumeAt === 0, '进度到末尾后错题模式仍从第一题开始', JSON.stringify({ n: r.json.data.questions.length, at: r.json.data.resumeAt }))
    // 删掉题目后，错题数不能还挂着那个已消失的 id
    r = await req('DELETE', `/api/questions/${one.id}`)
    r = await req('GET', `/api/banks/${bid3}/progress`)
    assert(r.json.data === null || r.json.data.wrong === 0, '题目删除后错题数同步归零', JSON.stringify(r.json.data))
  }

  console.log('\n[28] 统计口径：子表单可读、验证码不进报表')
  {
    r = await req('POST', '/api/forms', { title: '报表口径探针', status: 'published', schema: [
      { type: 'subform', label: '重点事项', props: { fields: [{ label: '事项' }, { label: '负责人' }] } },
      { type: 'captcha', label: '人机校验' }
    ] })
    const repForm = r.json.data.schema
    const sfRep = repForm[0]
    const capId = repForm[1].id
    const sumRep = String(capId).split('').reduce((a, c) => a + c.charCodeAt(0), 0) || 1
    const capAns = String((sumRep % 7) + 2 + (sumRep % 5) + 2)
    const subRep = await req('POST', `/api/public/forms/${r.json.id}/submit`, {
      data: { [sfRep.id]: [{ [sfRep.props.fields[0].id]: '季度复盘', [sfRep.props.fields[1].id]: '张三' }], [repForm[1].id]: capAns }
    })
    assert(subRep.status === 201, '子表单 + 验证码的答卷提交成功', JSON.stringify(subRep.json))
    r = await req('GET', `/api/forms/${r.json.id}/report`)
    const sfStat = r.json.data.questions.find(q => q.id === sfRep.id)
    assert(sfStat && !JSON.stringify(sfStat.samples || []).includes('object Object'), '子表单在报表里给出可读文本', JSON.stringify(sfStat?.samples))
    assert((sfStat?.samples || []).some(x => x.includes('季度复盘') && x.includes('张三')), '子表单样本带上字段名', JSON.stringify(sfStat?.samples))
    assert(!r.json.data.questions.some(q => q.type === 'captcha'), '验证码不进统计报表', JSON.stringify(r.json.data.questions.map(q => q.type)))
  }

  console.log('\n[29] 文本导入：题干说明不被吞成选项、圈号选项、跨题声明')
  {
    r = await req('POST', '/api/forms', { title: '导入口径探针', schema: [] })
    const tId = r.json.id
    r = await req('POST', `/api/forms/${tId}/import-text`, {
      text: [
        '一、以下哪些是数据库？（多选）',
        'A. MySQL',
        'B. Redis',
        '答案：A、B',
        '二、部署时需要执行 npm install 吗？',
        'A. 需要',
        'B. 不需要',
        '答案：B'
      ].join('\n')
    })
    const two = r.json.schema || []
    assert(two.length === 2, '「一、」「二、」起新题，不并进上一题的选项', JSON.stringify(two.map(f => f.label)))
    assert(two[0]?.type === 'checkbox' && two[0].options.length === 2, '多选答案不越界、选项只有两项', JSON.stringify(two[0]))
    assert(JSON.stringify(two[0]?.answer) === JSON.stringify(['MySQL', 'Redis']), '多选答案按选项值落库', JSON.stringify(two[0]?.answer))
    assert(two[1]?.type === 'radio' && JSON.stringify(two[1]?.answer) === JSON.stringify(['不需要']), '第二题的答案归第二题', JSON.stringify(two[1]))

    r = await req('POST', '/api/forms', { title: '导入口径探针二', schema: [] })
    const t2Id = r.json.id
    r = await req('POST', `/api/forms/${t2Id}/import-text`, {
      text: [
        '1. 你最常用的通勤方式是？',
        '请只选最主要的那个。',
        'A. 步行',
        'B. 自驾',
        '答案：B',
        '2. 判断题：EQS 内置数据库，开箱即用。',
        '答案：对',
        '3. 请上传一张截图 [上传]',
        '① 上传失败的截图可以先跳过',
        '答案：D'
      ].join('\n')
    })
    const three = r.json.schema || []
    const first = three.find(f => String(f.label).includes('通勤'))
    assert(first && first.options.length === 2, '题干下的说明不被当成选项', JSON.stringify(first?.options))
    const judge = three.find(f => String(f.label).includes('内置数据库'))
    assert(judge?.type === 'radio' && JSON.stringify(judge.answer) === JSON.stringify(['正确']), '判断题「答案：对」映射到「正确」', JSON.stringify(judge))
    const last = three.find(f => String(f.label).includes('截图'))
    assert(last && last.type === 'upload', '「[上传]」题型识别正确', JSON.stringify(last?.type))

    // 「一、」「五、」+ 题型声明要落到对应题型上；「!」是必答标记
    r = await req('POST', '/api/forms', { title: '导入口径探针三', schema: [] })
    const t3Id = r.json.id
    r = await req('POST', `/api/forms/${t3Id}/import-text`, {
      text: [
        '一、你最常用的通勤方式是？',
        '请只选最主要的那个。',
        'A. 步行',
        'B. 自驾',
        '答案：B',
        '二、多选题：哪些因素影响通勤？',
        'A. 距离',
        'B. 天气',
        '答案：A、B',
        '三、! 请填写你的工号 [单行]'
      ].join('\n')
    })
    const four = r.json.schema || []
    assert(four.length === 3, '题干下的说明不粘连到下一题，也不新增题目', String(four.length))
    assert(four[0]?.type === 'radio' && four[0].options.length === 2, '第一题只有两项、题型为单选', JSON.stringify(four[0]))
    assert(four[1]?.type === 'checkbox', '「二、多选题：」声明落成多选', JSON.stringify(four[1]?.type))
    assert(JSON.stringify(four[1]?.answer) === JSON.stringify(['距离', '天气']), '多选答案按选项值落库（第二题）', JSON.stringify(four[1]?.answer))
    assert(four[2]?.required === true && four[2]?.type === 'text', '「!」标记落成必填，感叹号不留在题干里', JSON.stringify(four[2]))
  }

  console.log('\n[30] 删除与回收：彻底删除要连附件、统计口径跟着表单')
  {
    // 造一张带附件的问卷，公开提交一份（附件先上传后交卷）
    r = await req('POST', '/api/forms', { title: '回收链路探针', schema: [{ type: 'text', label: '名字' }, { type: 'upload', label: '附件' }] })
    const fId = r.json.id
    await req('PUT', `/api/forms/${fId}`, { status: 'published' })
    const fd = new FormData()
    fd.append('formId', String(fId))
    fd.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'a.txt')
    const upRes = await fetch(BASE + '/api/upload', { method: 'POST', body: fd })
    const up = await upRes.json()
    assert(upRes.status === 201 && !!up.url, '匿名可向已发布表单上传附件', JSON.stringify(up))
    r = await req('POST', `/api/public/forms/${fId}/submit`, { data: {} })
    const subId = r.json.id
    assert(!!subId, '提交答卷成功')

    // 未进回收站的表单不允许直接彻底删除
    r = await req('DELETE', `/api/forms/${fId}/purge`)
    assert(r.status === 400, '在用的表单不能直接彻底删除，必须先入回收站', String(r.status))

    // 答卷删除后可恢复
    r = await req('DELETE', `/api/submissions/${subId}`)
    assert(r.status === 200, '答卷可删除')
    r = await req('GET', '/api/recycle/submissions')
    assert(r.json.data.self.some(x => x.id === subId), '删除的答卷出现在回收中心')
    r = await req('POST', `/api/submissions/${subId}/restore`)
    assert(r.status === 200, '答卷可从回收中心恢复')
    r = await req('GET', '/api/recycle/submissions')
    assert(!r.json.data.self.some(x => x.id === subId), '恢复后不再停留在回收中心')

    // 批量删除要报真实删除数，而不是「勾了几个就是几个」
    r = await req('POST', '/api/submissions/batch-delete', { ids: [99999999] })
    assert(r.json.count === 0 && r.json.skipped === 1, '批量删除回报真实条数，不存在的 id 计入跳过', JSON.stringify(r.json))

    // 表单进回收站后，它的答卷不该继续出现在答卷列表与工作台统计里
    await req('DELETE', `/api/forms/${fId}`)
    r = await req('GET', '/api/submissions?pageSize=200')
    assert(!r.json.data.some(x => x.form_id === fId), '表单进回收站后，其答卷不再出现在答卷列表')
    r = await req('GET', '/api/recycle/submissions')
    assert(r.json.data.byForm.some(x => x.id === subId), '表单在回收站时，其答卷归在「待恢复表单」下')

    // 彻底删除：附件记录与磁盘文件一起清掉
    r = await req('DELETE', `/api/forms/${fId}/purge`)
    assert(r.status === 200 && r.json.files === 1, '彻底删除表单时连带清理附件', JSON.stringify(r.json))
    r = await req('GET', `/api/files?formId=${fId}`)
    assert(r.json.data.length === 0, '彻底删除后 files 表不留残记录')
    const raw = await fetch(BASE + up.url)
    assert(raw.status === 404, '彻底删除后附件地址立刻失效（文件真的从磁盘上没了）')
  }

  console.log('\n[31] 工作台统计不把模板和被删表单算进去')
  {
    r = await req('GET', '/api/stats/overview')
    const d = r.json.data
    r = await req('GET', '/api/forms?pageSize=200')
    const mine = r.json.data.filter(f => !f.is_template)
    assert(d.forms === mine.length, '表单总数不包含内置模板', `${d.forms} vs ${mine.length}`)
    assert(d.submissions === d.trend.reduce((a, b) => a + b.count, 0), '总答卷数与趋势图口径一致', `${d.submissions} vs ${d.trend.reduce((a, b) => a + b.count, 0)}`)
    const visibleIds = new Set(mine.map(f => f.id))
    assert(d.recent.every(x => visibleIds.has(x.form_id)), '「最近提交」不出现已删表单的答卷', JSON.stringify(d.recent.map(x => x.form_id)))
  }

  console.log('\n[32] 题库接口按文档用 title 建题，题干不会被写成「题目 1」')
  {
    r = await req('POST', '/api/banks', { name: '题干口径探针' })
    const bId = r.json.id
    r = await req('POST', `/api/banks/${bId}/questions`, { type: 'radio', title: 'HTTP 404 表示什么？', options: ['A', 'B'], answer: ['A'], score: 5 })
    r = await req('GET', `/api/banks/${bId}/questions`)
    assert(r.json.data[0]?.title === 'HTTP 404 表示什么？', '按文档传 title，题干原样落库', JSON.stringify(r.json.data[0]?.title))
    const qid = r.json.data[0].id
    await req('PUT', `/api/questions/${qid}`, { title: 'HTTP 404 的语义是？' })
    r = await req('GET', `/api/banks/${bId}/questions`)
    assert(r.json.data[0]?.title === 'HTTP 404 的语义是？', '用 title 更新题干也生效', JSON.stringify(r.json.data[0]?.title))
    await req('DELETE', `/api/banks/${bId}`)
    await req('DELETE', `/api/banks/${bId}/purge`)
  }

  console.log('\n[33] 题库与题目的删除同样可回收')
  {
    r = await req('POST', '/api/banks', { name: '回收探针题库' })
    const bId = r.json.id
    r = await req('POST', `/api/banks/${bId}/questions`, { type: 'radio', title: '探针题一', options: ['A', 'B'], answer: ['A'], score: 5 })
    const qId = r.json.ids[0]

    await req('DELETE', `/api/banks/${bId}`)
    r = await req('GET', '/api/banks/recycle')
    assert(r.json.data.some(x => x.id === bId), '删除的题库出现在回收中心')
    r = await req('POST', `/api/banks/${bId}/restore`)
    assert(r.status === 200, '题库可恢复')
    r = await req('GET', `/api/banks/${bId}/questions`)
    assert(r.json.data.some(q => q.id === qId), '恢复题库后题目跟着回来')

    // 单题删除 → 回收中心可见 → 可恢复
    await req('DELETE', `/api/questions/${qId}`)
    r = await req('GET', '/api/questions/recycle')
    assert(r.json.data.some(q => q.id === qId), '删除的题目出现在回收中心')
    r = await req('POST', `/api/questions/${qId}/restore`)
    assert(r.status === 200, '题目可恢复')

    // 题库没进回收站时不允许直接彻底删除
    r = await req('DELETE', `/api/banks/${bId}/purge`)
    assert(r.status === 400, '在用题库不能直接彻底删除', String(r.status))
    await req('DELETE', `/api/banks/${bId}`)
    r = await req('DELETE', `/api/banks/${bId}/purge`)
    assert(r.status === 200 && r.json.questions === 1, '彻底删除题库连带删掉题目', JSON.stringify(r.json))
    r = await req('GET', '/api/banks/recycle')
    assert(!r.json.data.some(x => x.id === bId), '彻底删除后回收中心不再有它')
  }

  console.log('\n[34] 前端静态资源')
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
