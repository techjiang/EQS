/**
 * EQS 冒烟测试：不依赖任何测试框架，直接 node tests/smoke.test.js
 * 覆盖：鉴权、表单 CRUD、文本导入、公开提交、条件校验、自动评分、报表、题库刷题、WebHook、备份
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'

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

/** 用指定账号登录，拿到它自己的 cookie —— 多身份测试用，不污染全局会话 */
async function asUser(username, password) {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  const sc = res.headers.get('set-cookie')
  return sc ? sc.split(';')[0] : ''
}

/** 用给定 cookie 发请求 */
async function call(ck, method, url, body) {
  const res = await fetch(BASE + url, {
    method, headers: { 'Content-Type': 'application/json', Cookie: ck },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const ct = res.headers.get('content-type') || ''
  return { status: res.status, json: ct.includes('json') ? await res.json() : null, res }
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

  // 自助注册默认关闭：私域问卷系统里「谁都能注册」等于谁都能建卷看数据
  r = await req('POST', '/api/auth/register', { username: 'noswitch', password: 'noswitch-1' })
  assert(r.status === 403, '默认不允许自助注册', String(r.status))
  r = await req('PUT', '/api/settings/site', { allowRegister: true })
  assert(r.json.ok, '管理员可以打开自助注册开关')
  r = await req('GET', '/api/settings/public')
  assert(r.json.data.allowRegister === true, '公开设置里带出注册开关（登录页据此决定显不显示入口）')

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

  // 退出登录现在会吊销服务端那条会话（以前只删浏览器 Cookie），
  // 所以后面继续用管理员身份，必须重新登录拿一条新的。
  await req('POST', '/api/auth/logout')
  cookie = ''
  r = await req('POST', '/api/auth/login', { username: 'tester', password: 'tester123' })
  assert(r.status === 200, '普通用户登录成功')
  r = await req('GET', '/api/settings')
  assert(r.status === 403, '普通用户无权读取系统设置')
  const adminCookie = await asUser('admin', 'test-pass-123')
  assert(!!adminCookie, '退出后用密码重新登录拿到新会话')
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
    assert(r.json.data.every(x => 'form_kind' in x), '答卷列表带上表单类型，前端才知道该不该出「批阅」')
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

  console.log('\n[34] 文本导入：圈号选项、括号序号选项、判断题标签')
  {
    r = await req('POST', '/api/forms', { title: '导入选项写法探针', schema: [] })
    const fId = r.json.id
    // ① ② 是文档里写着的选项写法，但 NUM_PREFIX 也认它，导致整题被拆成两道填空
    r = await req('POST', `/api/forms/${fId}/import-text`, {
      text: ['1. 下面哪些属于水果 [多选]', '① 苹果', '② 香蕉', '答案：①'].join('\n')
    })
    let schema = r.json.schema || []
    assert(schema.length === 1, '「① 苹果」被当成选项而不是新题', JSON.stringify(schema.map(f => f.label)))
    assert(schema[0]?.type === 'checkbox' && schema[0].options.length === 2, '圈号选项全部落库', JSON.stringify(schema[0]?.options))
    assert(JSON.stringify(schema[0]?.answer) === JSON.stringify(['苹果']), '「答案：①」落到第一个选项值上', JSON.stringify(schema[0]?.answer))

    // 全角括号序号选项：和「(1) 新题」字面一样，只能靠「这题明说了要选项」判断
    r = await req('POST', `/api/forms/${fId}/import-text`, {
      text: ['2. 你的职业 [单选]', '（1）工程师', '（2）设计师', '答案：（2）'].join('\n')
    })
    schema = r.json.schema || []
    const job = schema.find(f => String(f.label).includes('职业'))
    assert(job && job.options.length === 2, '「（1）工程师」被当成选项', JSON.stringify(job?.options))
    assert(JSON.stringify(job?.answer) === JSON.stringify(['设计师']), '「答案：（2）」落到第二个选项', JSON.stringify(job?.answer))

    // 题干用 [判断] 标签声明题型，答案「正确」不能被当填空题提示丢掉
    r = await req('POST', `/api/forms/${fId}/import-text`, {
      text: ['3. 缓存能减少数据库压力 [判断]', '答案：正确'].join('\n')
    })
    schema = r.json.schema || []
    const judge = schema.find(f => String(f.label).includes('缓存'))
    assert(JSON.stringify(judge?.answer) === JSON.stringify(['正确']), '判断题「答案：正确」在有 [判断] 标签时也落库', JSON.stringify(judge?.answer))
    await req('DELETE', `/api/forms/${fId}`)
    await req('DELETE', `/api/forms/${fId}/purge`)
  }

  console.log('\n[35] 系统设置：脱敏后的密钥不能被保存动作抹掉')
  {
    // 直接读库确认落盘的是真密钥，而不是被回写的 ****
    const stored = (key) => {
      const db = new DatabaseSync(path.join(DATA_DIR, 'eqs.db'))
      try {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
        return row ? JSON.parse(row.value) : null
      } finally { db.close() }
    }

    r = await req('PUT', '/api/settings/oauth', { google: { clientId: 'gid.apps.googleusercontent.com', clientSecret: 'REAL_GOOGLE_SECRET' }, wechatMp: { appId: 'wx123', appSecret: 'REAL_WX_SECRET' } })
    assert(r.status === 200, '保存第三方登录配置')
    r = await req('GET', '/api/settings')
    const shown = r.json.data.oauth
    assert(!JSON.stringify(shown).includes('REAL_'), '嵌套层的密钥下发时也脱敏', JSON.stringify(shown))
    // 前端点「保存」提交的就是这份脱敏对象，只改了 clientId
    r = await req('PUT', '/api/settings/oauth', { ...shown, google: { ...shown.google, clientId: 'gid2.apps.googleusercontent.com' } })
    assert(r.status === 200, '保存带脱敏串的配置')
    const after = stored('oauth')
    assert(after?.google?.clientSecret === 'REAL_GOOGLE_SECRET', '嵌套的 clientSecret 没被星号覆盖', JSON.stringify(after))
    assert(after?.google?.clientId === 'gid2.apps.googleusercontent.com', '改动的字段照常生效', JSON.stringify(after?.google))
    assert(after?.wechatMp?.appSecret === 'REAL_WX_SECRET', '同一份配置里另一层的密钥也保住了', JSON.stringify(after?.wechatMp))

    r = await req('PUT', '/api/settings/mail', { host: 'smtp.example.com', user: 'a@b.com', pass: 'REAL_MAIL_PASS' })
    r = await req('GET', '/api/settings')
    assert(!String(r.json.data.mail.pass).includes('REAL'), '邮件密码不下发明文', JSON.stringify(r.json.data.mail.pass))
    await req('PUT', '/api/settings/mail', { ...r.json.data.mail, from: 'noreply@example.com' })
    const mail = stored('mail')
    assert(mail?.pass === 'REAL_MAIL_PASS' && mail?.from === 'noreply@example.com', '保存邮件配置时密码原样保留', JSON.stringify(mail?.pass))
  }

  console.log('\n[36] 题库是私有资源：别人的题库连题都读不到')
  {
    r = await req('POST', '/api/banks', { name: '私有题库探针' })
    const bId = r.json.id
    await req('POST', `/api/banks/${bId}/questions`, { type: 'radio', title: '秘密题', options: ['A', 'B'], answer: ['A'], score: 5 })

    // 普通用户
    const adminCookie = cookie
    cookie = ''
    r = await req('POST', '/api/auth/register', { username: `probe${Date.now()}`, password: 'probe-pass-1' })
    assert(r.status === 200 || r.status === 201, '注册普通用户')
    r = await req('GET', `/api/banks/${bId}/questions`)
    assert(r.status === 404, '读不到别人的题库题目（含标准答案）', String(r.status))
    r = await req('GET', `/api/banks/${bId}/practice?mode=sequence`)
    assert(r.status === 404, '不能刷别人的题库', String(r.status))
    r = await req('GET', `/api/banks/${bId}/progress`)
    assert(r.status === 404, '看不到别人题库的进度', String(r.status))
    r = await req('GET', '/api/banks')
    assert(!(r.json.data || []).some(b => b.id === bId), '别人的题库不出现在我的列表里')

    cookie = adminCookie
    await req('DELETE', `/api/banks/${bId}`)
    await req('DELETE', `/api/banks/${bId}/purge`)
  }

  console.log('\n[37] WebHook 的签名密钥不下发给普通用户')
  {
    r = await req('POST', '/api/webhooks', { name: '探针钩子', url: 'https://hook.example.com/x', secret: 'HOOK-SECRET-VALUE' })
    r = await req('GET', '/api/webhooks')
    const hook = (r.json.data || [])[0]
    assert(hook && !String(hook.secret).includes('SECRET'), '管理员看到的签名密钥已脱敏', JSON.stringify(hook?.secret))

    const adminCookie = cookie
    cookie = ''
    r = await req('POST', '/api/auth/register', { username: `hook${Date.now()}`, password: 'probe-pass-1' })
    r = await req('GET', '/api/webhooks')
    assert(r.status === 200 && (r.json.data || []).length === 0, '普通用户拿不到 WebHook 列表', JSON.stringify(r.json.data))
    cookie = adminCookie
  }

  console.log('\n[38] Excel 导入导出')
  {
    // 模板能下下来，且能被自己的解析器读回——这是「导出→改→导入」闭环的前提
    let res = await fetch(BASE + '/api/banks/template.xlsx', { headers: { Cookie: cookie } })
    const tplBuf = Buffer.from(await res.arrayBuffer())
    assert(res.ok && tplBuf.length > 1000, '题库导入模板可下载')
    const [readXlsx, sheet, zip] = await Promise.all([
      import('../server/lib/xlsx.js'), import('../server/lib/sheet.js'), import('../server/lib/zip.js')
    ])
    const tplRows = readXlsx.readXlsx(tplBuf)
    assert(Array.isArray(tplRows) && tplRows[0]?.[0] === '题型', '模板的表头是「题型」开头的六列', JSON.stringify(tplRows?.[0]))
    assert(tplRows.length === 6, '模板含 1 行表头 + 5 行示例（含一行矩阵）', String(tplRows.length))

    // 导入：模板原样传回题库
    r = await req('POST', '/api/banks', { name: 'Excel 导入题库' })
    const bankId = r.json.id
    const fd = new FormData()
    fd.append('file', new Blob([tplBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'tpl.xlsx')
    res = await fetch(BASE + `/api/banks/${bankId}/import-xlsx`, { method: 'POST', headers: { Cookie: cookie }, body: fd })
    const imported = await res.json()
    assert(res.ok && imported.imported === 5, 'Excel 导入 5 道题', JSON.stringify(imported))
    r = await req('GET', `/api/banks/${bankId}/questions`)
    const qs = r.json.data
    assert(qs[0].type === 'radio' && qs[0].answer[0] === 'SQLite 内嵌', '单选的字母答案映射成选项值', JSON.stringify([qs[0].type, qs[0].answer]))
    assert(qs[1].type === 'checkbox' && qs[1].answer.length === 3, '多选的 A,B,C 落成三个选项值', JSON.stringify(qs[1].answer))
    assert(qs[2].options.map(o => o.value).join('/') === '正确/错误', '判断题自动补上正确/错误两个选项')
    assert(qs[2].answer[0] === '正确', '判断题的「正确」落成选项值', JSON.stringify(qs[2].answer))
    assert(qs[3].type === 'textarea' && qs[3].answer.length === 0, '简答题没有标准答案（进人工批阅）', JSON.stringify([qs[3].type, qs[3].answer]))
    assert(qs[0].score === 5 && qs[3].score === 10, '分值按行落库', JSON.stringify([qs[0].score, qs[3].score]))
    // 矩阵题：行与列是两个维度。行没进库，导入的矩阵在卷面上就没有行可填
    assert(qs[4].type === 'matrix' && (qs[4].props?.rows || []).join('/') === '速度/稳定', '矩阵题的行跟着表格落库', JSON.stringify([qs[4].type, qs[4].props]))

    // 题干里没有「判断」二字时，「答案：对」同样要落到「正确」选项上
    {
      const xlsxMod = await import('../server/lib/xlsx.js')
      const judgeXlsx = xlsxMod.buildXlsx('题目', [
        ['题型', '题干', '选项', '答案', '分值'],
        ['判断', 'WebSocket 是建立在 TCP 之上的。', '', '对', 5],
        ['判断', '浏览器里 localStorage 没有容量上限。', '', '错误', 5]
      ])
      const fdj = new FormData()
      fdj.append('file', new Blob([judgeXlsx]), 'judge.xlsx')
      const rj = await fetch(BASE + `/api/banks/${bankId}/import-xlsx`, { method: 'POST', headers: { Cookie: cookie }, body: fdj })
      const rjJson = await rj.json()
      assert(rj.ok && !rjJson.droppedAnswers?.length, '题干不含「判断」时答案不被剔除', JSON.stringify(rjJson))
      const back = await req('GET', `/api/banks/${bankId}/questions?keyword=WebSocket`)
      assert(back.json.data?.[0]?.answer?.[0] === '正确', '「答案：对」映射成「正确」选项值', JSON.stringify(back.json.data?.[0]?.answer))
      const back2 = await req('GET', `/api/banks/${bankId}/questions?keyword=localStorage`)
      assert(back2.json.data?.[0]?.answer?.[0] === '错误', '「答案：错误」映射成「错误」选项值', JSON.stringify(back2.json.data?.[0]?.answer))
    }

    // 导出后能读回同样的题目
    res = await fetch(BASE + `/api/banks/${bankId}/export.xlsx`, { headers: { Cookie: cookie } })
    const exportBuf = Buffer.from(await res.arrayBuffer())
    assert(res.ok && exportBuf.length > 1000, '题库可导出 xlsx')
    const exported = readXlsx.readXlsx(exportBuf)
    // 导出时题库里已经有了后面补的判断题，所以拿当前题目数比，而不是导入那一刻的份数
    const nowCount = (await req('GET', `/api/banks/${bankId}/questions`)).json.data.length
    assert(exported[0][1] === '题干' && exported.length === nowCount + 1, '导出的行数等于题库题目数 + 1 行表头', JSON.stringify([exported.length, nowCount]))
    assert(exported[1][1] === qs[0].title, '导出的第一道题就是题库第一题', JSON.stringify(exported?.[1]?.slice(0, 2)))

    // 表头顺序打乱 / 用别名，也要认得出来
    const xlsx = (await import('../server/lib/xlsx.js')).buildXlsx
    const odd = xlsx('题目', [
      ['答案', '题目', '分', '选项', '类型'],
      ['B', '下列哪个是 HTTP 状态码？', 5, 'A.404\nB.OK\nC.GET', '单选']
    ])
    const fd2 = new FormData()
    fd2.append('file', new Blob([odd]), 'odd.xlsx')
    res = await fetch(BASE + `/api/banks/${bankId}/import-xlsx`, { method: 'POST', headers: { Cookie: cookie }, body: fd2 })
    const oddRes = await res.json()
    assert(res.ok && oddRes.imported === 1, '列顺序打乱 + 别名表头也能导入', JSON.stringify(oddRes))

    // 坏行要报出来，而不是静默少几道题
    const bad = xlsx('题目', [
      ['题型', '题干', '选项', '答案', '分值', '备注'],
      ['单选', '', 'A.x\nB.y', 'A', 5, '空题干'],
      ['单选', '只有一个选项的题', 'A.x', 'A', 5, ''],
      ['单选', '答案越界的题', 'A.x\nB.y', 'D', 5, ''],
      ['单选题', '备注列不该进题目', 'A.x\nB.y', 'A', 5, '忽略我']
    ])
    const fd3 = new FormData()
    fd3.append('file', new Blob([bad]), 'bad.xlsx')
    res = await fetch(BASE + `/api/banks/${bankId}/import-xlsx`, { method: 'POST', headers: { Cookie: cookie }, body: fd3 })
    const badRes = await res.json()
    // 4 行里 2 行是坏的（空题干 / 选项不足），剩下 2 行要照常落库
    assert(res.ok && badRes.imported === 2, '坏行被跳过，好行照常导入', JSON.stringify([badRes.imported, badRes.skipped]))
    assert((badRes.skipped || []).length === 2, '两道坏行各自给出原因', JSON.stringify(badRes.skipped))
    assert((badRes.droppedAnswers || []).length === 1, '越界答案被剔除并回报', JSON.stringify(badRes.droppedAnswers))
    assert((badRes.unknownColumns || []).includes('备注'), '未识别的列被明确告知而不是静默忽略', JSON.stringify(badRes.unknownColumns))

    // 非 xlsx 文件：给人话，不要静默 500
    const fd4 = new FormData()
    fd4.append('file', new Blob([Buffer.from('这不是表格')]), 'x.txt')
    res = await fetch(BASE + `/api/banks/${bankId}/import-xlsx`, { method: 'POST', headers: { Cookie: cookie }, body: fd4 })
    assert(res.status === 400 && /xlsx/.test((await res.json()).message), '上传非 xlsx 文件时提示改用 xlsx', String(res.status))

    await req('DELETE', `/api/banks/${bankId}`)
    await req('DELETE', `/api/banks/${bankId}/purge`)
  }

  console.log('\n[39] 答卷导出 Excel')
  {
    r = await req('POST', '/api/forms', {
      title: 'Excel 导出探针', kind: 'exam', status: 'published',
      schema: [
        { type: 'radio', label: '单选题', options: ['甲', '乙'], answer: ['甲'], score: 5 },
        { type: 'checkbox', label: '多选题', options: ['A', 'B'], answer: ['A'], score: 5 },
        { type: 'textarea', label: '简答题', score: 10 }
      ],
      settings: { passPercent: 60 }
    })
    const formId = r.json.id
    const sch = r.json.data.schema
    const publicForm = await (await fetch(BASE + `/api/public/forms/${formId}`)).json()
    await fetch(BASE + `/api/public/forms/${formId}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { [sch[0].id]: '甲', [sch[1].id]: ['A'], [sch[2].id]: '我的答案' } })
    })
    const res = await fetch(BASE + `/api/forms/${formId}/submissions.xlsx`, { headers: { Cookie: cookie } })
    const buf = Buffer.from(await res.arrayBuffer())
    assert(res.ok && buf.length > 1000, '答卷可导出 xlsx')
    assert(/filename\*=UTF-8''/.test(res.headers.get('content-disposition') || ''), '中文文件名按 RFC 5987 编码')
    const { readXlsx } = await import('../server/lib/xlsx.js')
    const rows = readXlsx(buf)
    assert(rows[0][0] === '答卷编号' && rows[0].includes('单选题'), '表头含答卷编号与题目标题', JSON.stringify(rows[0]))
    assert(rows.length === 2 && String(rows[1][1]).length >= 10, '数据行带提交时间与作答', JSON.stringify(rows[1]?.slice(0, 3)))
    assert(rows[1].includes('我的答案'), '文本作答原样导出')
    assert(rows[1].includes('待批阅'), '主观题未批阅时标注待批阅', String(rows[1][rows[1].length - 1]))
  }

  console.log('\n[40] ZIP 读写：deflate 包也能解')
  {
    const { buildZip, readZipEntries } = await import('../server/lib/zip.js')
    const plain = buildZip([{ name: 'a.txt', data: 'hello' }])
    assert(readZipEntries(plain)?.[0]?.data?.toString() === 'hello', 'store 模式的包可读回')
    // Python 产出的 deflate 包（模拟外部工具打的备份）
    const zlib = await import('node:zlib')
    const payload = Buffer.from('deflated-content')
    const comp = zlib.deflateRawSync(payload)
    // 手工拼一个 method=8 的条目，验证解包不限 store
    const crc = 0
    const name = Buffer.from('d.txt')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(payload.length, 22)
    local.writeUInt16LE(name.length, 26)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10)
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(payload.length, 24)
    cd.writeUInt16LE(name.length, 28)
    const body = Buffer.concat([local, name, comp])
    cd.writeUInt32LE(0, 42)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
    end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(body.length, 16)
    const zipBuf = Buffer.concat([body, cd, name, end])
    const entries = readZipEntries(zipBuf)
    assert(entries?.[0]?.data?.toString() === 'deflated-content', 'deflate 压缩的条目能解开', entries?.[0]?.data?.toString())
  }

  console.log('\n[42] 题库标签：写入、筛选、组卷')
  {
    r = await req('POST', '/api/banks', { name: '标签题库' })
    const bankId = r.json.id
    // 标签从文本导入里来：「标签：」这一行不该变成题干或选项
    await req('POST', `/api/banks/${bankId}/import-text`, {
      text: '1. 下列哪个是关系型数据库？ [单选]\nA. Redis\nB. MySQL\n答案：B\n分值：5\n标签：数据库,基础\n\n' +
            '2. HTTP 404 表示资源不存在。 [判断]\n答案：正确\n分值：5\n标签：网络\n\n' +
            '3. 下列哪些是水果 [多选]\n① 苹果\n② 香蕉\n③ 铁\n答案：①②\n分值：10\n标签：常识\n\n' +
            '4. 简述事件循环的作用 [简答]\n分值：0\n标签：JavaScript'
    })
    let qs = (await req('GET', `/api/banks/${bankId}/questions`)).json.data
    assert(qs.length === 4, '文本导入 4 题全部落库', String(qs.length))
    assert(qs[0].tags === '数据库,基础', '「标签：」行落成标签，且不进题干', JSON.stringify(qs[0]?.tags))
    assert(qs[1].tags === '网络', '判断题也能带标签', JSON.stringify(qs[1]?.tags))
    assert(qs[3].score === 0, '分值 0 不再被兜底成 5', String(qs[3]?.score))
    assert(qs[2].answer.length === 2, '「答案：①②」这类连写答案被拆开', JSON.stringify(qs[2]?.answer))

    qs = (await req('GET', `/api/banks/${bankId}/questions?tag=${encodeURIComponent('网络')}`)).json.data
    assert(qs.length === 1 && qs[0].tags === '网络', '按标签筛题只出命中标签的题', JSON.stringify(qs.map(q => q.title)))

    qs = (await req('GET', `/api/banks/${bankId}/questions?keyword=${encodeURIComponent('数据库')}`)).json.data
    assert(qs.some(q => q.tags.includes('数据库')), '题干搜索也能命中标签')

    // item 级 tags 之前被整批丢掉，只剩 body.tags 生效
    await req('POST', `/api/banks/${bankId}/questions`, {
      items: [{ label: '带标签的手写题', type: 'radio', options: ['x', 'y'], answer: ['x'], score: 5, tags: '手写' }]
    })
    qs = (await req('GET', `/api/banks/${bankId}/questions?tag=${encodeURIComponent('手写')}`)).json.data
    assert(qs.length === 1, 'items 里每条自带的标签能落库', JSON.stringify(qs.length))

    // 组卷按题型 / 标签，筛不到就明确报错，不静默退回全库
    r = await req('POST', `/api/banks/${bankId}/paper`, { title: '只有多选', count: 5, types: ['checkbox'] })
    assert(r.status === 201 && r.json.count === 1, '按题型组卷只抽到该题型', JSON.stringify(r.json))
    r = await req('POST', `/api/banks/${bankId}/paper`, { title: '只要标签', count: 5, tags: ['网络'] })
    assert(r.status === 201 && r.json.count === 1, '按标签组卷只抽到命中标签的题', JSON.stringify(r.json))
    r = await req('POST', `/api/banks/${bankId}/paper`, { title: 'x', count: 5, types: ['signature'] })
    assert(r.status === 400 && /没有/.test(r.json?.message || ''), '筛不到题型时明确报错，不静默退回全库', String(r.json?.message))

    // 及格线百分比夹在 1..100：180 会让满分也不及格
    r = await req('POST', `/api/banks/${bankId}/paper`, { title: '及格线', count: 2, passPercent: 180 })
    assert(r.json.settings.passPercent === 100, '及格线越界被夹到 100', String(r.json.settings?.passPercent))

    // Excel 导出带标签列，判断题如实体现在「题型」列
    const res = await fetch(BASE + `/api/banks/${bankId}/export.xlsx`, { headers: { Cookie: cookie } })
    const { readXlsx } = await import('../server/lib/xlsx.js')
    const rows = readXlsx(Buffer.from(await res.arrayBuffer()))
    assert(rows[0].includes('标签'), '题库导出带标签列', JSON.stringify(rows[0]))
    assert(rows.some(row => row[0] === '判断'), '判断题在「题型」列标注为判断，不再是单选', JSON.stringify(rows.map(r2 => r2[0])))
    assert(rows.some(row => row.includes('数据库,基础')), '标签值原样导出', JSON.stringify(rows.find(r2 => r2.includes('数据库,基础'))))

    // 导出的表能被自己的解析器读回：标签不丢，判断题不退化
    const { rowsToFields } = await import('../server/lib/sheet.js')
    const back = rowsToFields(rows)
    const judgeRow = back.fields.find(f => f.label.includes('HTTP 404'))
    assert(judgeRow?.declType === 'judge', '导出再导入，判断题仍是判断题', JSON.stringify(judgeRow?.declType))
    assert(back.fields.some(f => f.tags === '数据库,基础'), '导出再导入，标签不丢', JSON.stringify(back.fields.map(f => f.tags)))
  }

  console.log('\n[43] 报表：平均值只对分数类题型出现')
  {
    const { computeStats } = await import('../server/lib/forms.js')
    const schema = [
      { id: 'a', type: 'radio', label: '端口', options: [{ label: '21', value: '21' }, { label: '80', value: '80' }], answer: ['80'], score: 5 },
      { id: 'b', type: 'nps', label: '推荐意愿', options: [], answer: [], score: 0, props: { max: 10, min: 0 } }
    ]
    const stats = computeStats({ schema }, [
      { data: { a: '21', b: '9' }, score: 0, passed: 0, created_at: '2026-01-01T00:00:00Z' },
      { data: { a: '80', b: '10' }, score: 5, passed: 1, created_at: '2026-01-01T00:00:00Z' }
    ])
    const radio = stats.questions.find(q => q.id === 'a')
    assert(radio.average === undefined, '单选题不再给出「平均 148.63」这种荒唐平均值', JSON.stringify(radio.average))
    assert(radio.series.length === 2, '单选题的选项分布仍在', JSON.stringify(radio.series))
    const nps = stats.questions.find(q => q.id === 'b')
    assert(nps.average === 9.5, 'NPS 仍然算平均分', String(nps.average))
  }

  console.log('\n[45] 权限边界：普通用户不该摸到别人的东西')
  {
    const saved = cookie

    // 管理员建一张私有问卷 + 挂一个附件
    cookie = saved
    const mine = await req('POST', '/api/forms', { title: '只有管理员能看的问卷', schema: [] })
    const myForm = mine.json.id
    const fd5 = new FormData()
    fd5.append('file', new Blob([Buffer.from('机密内容')], { type: 'text/plain' }), '机密.txt')
    fd5.append('formId', String(myForm))
    const upMe = await fetch(BASE + '/api/upload', { method: 'POST', body: fd5, headers: { Cookie: cookie } })
    const myFile = (await upMe.json()).id
    await req('PUT', '/api/forms/' + myForm, { status: 'published' })
    const mySub = (await req('POST', '/api/submissions', { formId: myForm, data: {} })).json.id
    const fd6 = new FormData()
    fd6.append('file', new Blob([Buffer.from('答卷附件')], { type: 'text/plain' }), '答卷附件.txt')
    fd6.append('formId', String(myForm))
    fd6.append('submissionId', String(mySub))
    await fetch(BASE + '/api/upload', { method: 'POST', body: fd6, headers: { Cookie: cookie } })

    // 普通用户
    await req('POST', '/api/auth/register', { username: 'peeker', password: 'peeker-123', nickname: '偷看的人' })
    const ck = await asUser('peeker', 'peeker-123')

    let p = await call(ck, 'GET', '/api/users')
    assert(p.json.data.length === 1 && p.json.data[0].username === 'peeker', '用户列表只回自己，不外泄邮箱手机号', JSON.stringify(p.json.data))
    p = await call(ck, 'GET', '/api/roles')
    assert(p.json.data.length === 1, '角色表只回自己的角色，不下发权限模型', JSON.stringify(p.json.data.map(x => x.code)))
    p = await call(ck, 'GET', '/api/files')
    assert(!p.json.data.some(f => f.id === myFile), '附件列表看不到别人的文件', JSON.stringify(p.json.data))
    p = await call(ck, 'DELETE', '/api/files/' + myFile)
    assert(p.status === 403, '删不掉别人的附件（磁盘文件删了回收中心接不住）', p.status + ' ' + JSON.stringify(p.json))
    p = await call(ck, 'GET', '/api/forms/' + myForm + '/attachments.zip')
    assert(p.status === 403, '打不了别人表单的附件包', p.status + ' ' + JSON.stringify(p.json))
    p = await call(ck, 'POST', '/api/forms/' + myForm + '/import-text', { text: '1. 入侵 [单选]\nA. 是\nB. 否\n答案：A' })
    assert(p.status === 403, '不能往别人表单里灌题', p.status + ' ' + JSON.stringify(p.json))
    p = await call(ck, 'POST', '/api/forms/' + myForm + '/duplicate', {})
    assert(p.status === 403, '不能复制别人表单（等于抄走题目连答案）', p.status + ' ' + JSON.stringify(p.json))
    await req('DELETE', '/api/forms/' + myForm)
    p = await call(ck, 'POST', '/api/forms/' + myForm + '/restore', {})
    assert(p.status === 403, '不能把别人回收站里的问卷捞回来', p.status + ' ' + JSON.stringify(p.json))
    p = await call(ck, 'DELETE', '/api/forms/' + myForm + '/purge', {})
    assert(p.status === 403, '不能彻底删除别人的问卷', p.status + ' ' + JSON.stringify(p.json))
    await req('POST', '/api/forms/' + myForm + '/restore', {})
    cookie = saved
    const kept = await req('GET', '/api/forms/' + myForm)
    assert(kept.json.data?.title === '只有管理员能看的问卷', '越权的几次尝试都没动到问卷本体')

    // 管理员自锁：内置 admin 权限位不许清空
    p = await req('PUT', '/api/roles/1', { name: '超级管理员', perms: [] })
    assert(p.status === 400, '内置超级管理员的权限不可被移除（否则没人能改回来）', p.status + ' ' + JSON.stringify(p.json))
    p = await req('GET', '/api/roles')
    assert(p.json.data.find(x => x.code === 'admin').perms.includes('*'), '清空请求被拒后，admin 权限位原样还在')

    // 删角色先检查占用
    await req('POST', '/api/roles', { name: '临时角色', code: 'tmp_role', perms: ['form:read'] })
    const tmpRole = (await req('GET', '/api/roles')).json.data.find(x => x.code === 'tmp_role')
    await req('POST', '/api/users', { username: 'hangon', password: 'hangon-123', role_id: tmpRole.id })
    p = await req('DELETE', '/api/roles/' + tmpRole.id)
    assert(p.status === 400, '有人在用的角色不允许删（否则用户挂在不存在的角色上）', p.status + ' ' + JSON.stringify(p.json))
    const hangon = (await req('GET', '/api/users')).json.data.find(u => u.username === 'hangon')
    await req('PUT', '/api/users/' + hangon.id, { role_id: 2 })
    p = await req('DELETE', '/api/roles/' + tmpRole.id)
    assert(p.status === 200, '角色空出来之后可以正常删除')
  }

  console.log('\n[46] 账号与凭证：Key 不等于提权、改密要验旧密码、登录要限速')
  {
    const adminCookie = cookie

    // —— API Key 只应有签发人本人的权限 ——
    await req('PUT', '/api/settings/site', { allowRegister: true })
    await req('POST', '/api/auth/register', { username: 'keyless', password: 'keyless-123' })
    const userCk = await asUser('keyless', 'keyless-123')
    let p = await call(userCk, 'POST', '/api/auth/api-key', {})
    assert(p.status === 403, '普通用户不能自助签发 API Key（那是给自己发管理员）', String(p.status))

    cookie = adminCookie
    const adminKey = (await req('POST', '/api/api-keys', { name: '管理员集成' })).json.key
    const kUsers = await fetch(BASE + '/api/users', { headers: { 'X-API-Key': adminKey } })
    assert(kUsers.ok, '管理员签的 Key 仍可调用接口', String(kUsers.status))

    // 老数据里的 Key（没有 owner_id）一律不再生效
    const legacy = new DatabaseSync(path.join(DATA_DIR, 'eqs.db'))
    legacy.prepare("INSERT INTO api_keys(name, key, enabled, created_at) VALUES('遗留密钥', 'eqs_legacy_should_be_dead', 1, ?)").run(new Date().toISOString())
    legacy.close()
    const legacyRes = await fetch(BASE + '/api/users', { headers: { 'X-API-Key': 'eqs_legacy_should_be_dead' } })
    assert(legacyRes.status === 401, '签发人未知的历史 Key 不再被当成管理员', String(legacyRes.status))

    // —— 改密码必须验旧密码、守长度，并让旧会话失效 ——
    p = await call(userCk, 'PUT', '/api/auth/me', { password: '1' })
    assert(p.status === 400 && /当前密码/.test(p.json.message), '改密码不给旧密码直接拒绝', p.status + ' ' + JSON.stringify(p.json))
    p = await call(userCk, 'PUT', '/api/auth/me', { oldPassword: 'wrong-old', password: 'newpass-123' })
    assert(p.status === 403, '旧密码不对时拒绝改密', String(p.status))
    p = await call(userCk, 'PUT', '/api/auth/me', { oldPassword: 'keyless-123', password: '12345' })
    assert(p.status === 400, '新密码太短被拒绝', String(p.status))
    p = await call(userCk, 'PUT', '/api/auth/me', { oldPassword: 'keyless-123', password: 'newpass-123' })
    assert(p.status === 200 && p.json.relogin, '改密成功后要求重新登录', JSON.stringify(p.json))
    p = await call(userCk, 'GET', '/api/forms')
    assert(p.status === 401, '改密后旧会话立即失效（否则密码泄露改了也没用）', String(p.status))
    p = await req('POST', '/api/auth/login', { username: 'keyless', password: 'keyless-123' })
    assert(p.status === 401, '旧密码不能再用')
    const newCk = await asUser('keyless', 'newpass-123')
    assert(!!newCk, '新密码可以登录')

    // 后台接口不能绕开「验证旧密码」
    p = await call(newCk, 'PUT', '/api/users/' + (await call(newCk, 'GET', '/api/users')).json.data[0].id, { password: 'bypass-123' })
    assert(p.status === 403 || p.status === 400, '普通用户改自己密码绕不开旧密码校验', p.status + ' ' + JSON.stringify(p.json))

    // —— 登录失败限速 ——
    let limited = false
    for (let i = 0; i < 12; i++) {
      const res = await req('POST', '/api/auth/login', { username: 'keyless', password: 'bad-' + i })
      if (res.status === 429) { limited = true; break }
    }
    assert(limited, '连续输错密码后开始拒绝（否则六位密码一夜跑完）')

    // —— 模板中心不被普通用户污染 ——
    cookie = adminCookie
    p = await call(newCk, 'POST', '/api/forms', { title: '广告模板', is_template: 1, schema: [] })
    assert(p.status === 403, '普通用户不能把表单存为公共模板', String(p.status))
    p = await call(newCk, 'POST', '/api/templates/1/use', {})
    if (p.status === 201) {
      const copied = await call(newCk, 'GET', '/api/forms/' + p.json.id)
      assert(copied.json.data?.is_template === 0, '套用模板复制出来的表单不再进模板中心')
    }
  }

  console.log('\n[47] 别人的东西不该能写：题目、答卷导入、组卷')
  {
    const adminCookie = cookie
    await req('POST', '/api/banks', { name: '管理员私有题库' })
    const banks = (await req('GET', '/api/banks')).json.data
    const bId = banks.find(b => b.name === '管理员私有题库').id
    const q = await req('POST', `/api/banks/${bId}/questions`, { type: 'radio', label: '不能被你删的题', options: ['A', 'B'], answer: ['A'], score: 5 })
    const qId = q.json.ids[0]

    await req('POST', '/api/auth/register', { username: 'intruder', password: 'intruder-123' })
    const ck = await asUser('intruder', 'intruder-123')

    let p = await call(ck, 'POST', `/api/banks/${bId}/questions`, { type: 'radio', label: '塞进来的题', options: ['A', 'B'], answer: ['A'] })
    assert(p.status === 404 || p.status === 403, '不能往别人的题库里塞题', p.status + ' ' + JSON.stringify(p.json))
    p = await call(ck, 'PUT', '/api/questions/' + qId, { label: '被改掉的题' })
    assert(p.status === 403, '不能改别人题库里的题目', String(p.status))
    p = await call(ck, 'DELETE', '/api/questions/' + qId, {})
    assert(p.status === 403, '不能删别人题库里的题目（写比读更该守门）', String(p.status))
    p = await call(ck, 'POST', `/api/banks/${bId}/import-text`, { text: '[单选] 灌进来的\nA. 甲\nB. 乙\n答案：A' })
    assert(p.status === 404 || p.status === 403, '不能往别人题库导入题目', String(p.status))
    p = await call(ck, 'POST', `/api/banks/${bId}/paper`, { count: 1 })
    assert(p.status === 404 || p.status === 403, '不能用别人的题库组卷（等于连答案一起拿走）', String(p.status))

    cookie = adminCookie
    const still = (await req('GET', `/api/banks/${bId}/questions`)).json
    assert(still.total === 1 && still.data[0].title === '不能被你删的题', '几次越权尝试后题目原样还在', JSON.stringify(still.data.map(x => x.title)))

    // 别人的表单：不能灌答卷
    await req('POST', '/api/forms', { title: '管理员的卷', kind: 'survey', schema: [{ type: 'text', label: '姓名', required: true }] })
    const forms = (await req('GET', '/api/forms')).json.data
    const fId = forms.find(f => f.title === '管理员的卷').id
    await req('PUT', '/api/forms/' + fId, { status: 'published' })
    cookie = ''
    p = await call(ck, 'POST', '/api/submissions', { formId: fId, data: { [Object.keys({})[0] || 'x']: 'y' } })
    assert(p.status === 403 || p.status === 422, '普通用户不能往别人的表单后台新增答卷', p.status + ' ' + JSON.stringify(p.json))
    p = await call(ck, 'POST', `/api/forms/${fId}/import`, { items: [{ data: {} }] })
    assert(p.status === 403, '普通用户不能往别人的表单导入答卷', String(p.status))

    cookie = adminCookie
    const subs = (await req('GET', `/api/submissions?formId=${fId}`)).json
    assert(subs.total === 0, '越权写入全部没落库', JSON.stringify(subs.total))
  }

  console.log('\n[48] 登录会话：服务端可撤销、按设备踢人')
  {
    const adminCookie = cookie

    // 三条会话，各自来自不同「设备」
    const uaA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1'
    const uaB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36'
    const login = async (ua) => {
      const res = await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
        body: JSON.stringify({ username: 'admin', password: 'test-pass-123' })
      })
      const sc = res.headers.get('set-cookie') || ''
      return sc.split(';')[0]
    }
    const ckA = await login(uaA)
    const ckB = await login(uaB)
    assert(!!ckA && !!ckB && ckA !== ckB, '同一账号在两台设备登录，拿到两条不同的会话')

    let p = await call(ckA, 'GET', '/api/auth/sessions')
    assert(p.status === 200 && p.json.data.length >= 2, '能看到自己的会话列表', String(p.status))
    const list = p.json.data
    assert(list.filter(x => x.current).length === 1, '列表里只有一条标着「当前登录」')
    assert(list.some(x => /iPhone/.test(x.device)) && list.some(x => /Windows/.test(x.device)), 'User-Agent 被翻译成可读设备名', JSON.stringify(list.map(x => x.device)))
    assert(!JSON.stringify(list).includes('token_hash'), '会话列表不下发 token 哈希')

    // 踢掉 Windows 那台
    const target = list.find(x => /Windows/.test(x.device))
    p = await call(ckA, 'DELETE', '/api/auth/sessions/' + target.id)
    assert(p.status === 200 && p.json.self === false, '能踢掉指定设备', String(p.status))
    p = await call(ckB, 'GET', '/api/forms')
    assert(p.status === 401, '被踢的那条会话立刻失效（不用等 7 天）', String(p.status))
    p = await call(ckA, 'GET', '/api/forms')
    assert(p.status === 200, '当前这台设备不受影响', String(p.status))

    // 退出登录必须吊销服务端那一条：只删浏览器 Cookie，抓到的 Cookie 还能用满 7 天
    const ckLogout = await login(uaB)
    p = await call(ckLogout, 'POST', '/api/auth/logout')
    assert(p.status === 200, '退出登录成功')
    p = await call(ckLogout, 'GET', '/api/forms')
    assert(p.status === 401, '退出后的旧 Cookie 在服务端已作废', String(p.status))

    // 别人家的会话不能被我踢
    await req('PUT', '/api/settings/site', { allowRegister: true })
    await req('POST', '/api/auth/register', { username: 'sessionuser', password: 'session-123' })
    const otherCk = await asUser('sessionuser', 'session-123')
    const otherSid = (await call(otherCk, 'GET', '/api/auth/sessions')).json.data[0].id
    p = await call(ckA, 'DELETE', '/api/auth/sessions/' + otherSid)
    assert(p.status === 200 || p.status === 403, '管理员可以清理他人会话但不报错', String(p.status))
    p = await call(otherCk, 'GET', '/api/forms')
    assert(p.status === 401, '被管理员清掉的他人会话也立即失效', String(p.status))

    // 「退出其它设备」保留当前这条
    const ck1 = await login(uaA)
    const ck2 = await login(uaB)
    p = await call(ck1, 'POST', '/api/auth/sessions/revoke-others', {})
    assert(p.status === 200, '一键退出其它设备')
    assert((await call(ck2, 'GET', '/api/forms')).status === 401, '其它设备被踢掉')
    assert((await call(ck1, 'GET', '/api/forms')).status === 200, '当前设备保持登录')

    // 伪造 / 篡改的 Cookie 一律无效（以前是 HMAC 签名串，现在是库里的随机串）
    p = await call('eqs_token=deadbeef', 'GET', '/api/forms')
    assert(p.status === 401, '伪造的会话串无效')

    // 停用账号后，手里那条 Cookie 立刻不再通行
    // 「退出其它设备」把此前的 adminCookie 也吊销了，这里改用 ck1
    cookie = ck1
    await req('PUT', '/api/settings/site', { allowRegister: true })
    await req('POST', '/api/auth/register', { username: 'tobedisabled', password: 'disabled-123' })
    const disabledCk = await asUser('tobedisabled', 'disabled-123')
    const du = (await req('GET', '/api/users')).json.data.find(u => u.username === 'tobedisabled')
    // 注意：注册接口会下发新 Cookie，把全局身份顶掉——这里显式用管理员那条
    const dp = await call(ck1, 'PUT', '/api/users/' + du.id, { status: 0 })
    assert(dp.status === 200, '停用账号成功', dp.status + ' ' + JSON.stringify(dp.json))
    p = await call(disabledCk, 'GET', '/api/forms')
    assert(p.status === 401 || p.status === 403, '停用账号后旧会话不再通行', String(p.status))
  }

  console.log('\n[49] 伪造的 X-Forwarded-For 不该改变身份与计数')
  {
    /*
     * X-Forwarded-For 是客户端自己发的头。无条件信任它，等于把三道防线一起送掉：
     * 登录失败限速、每个 IP 限填一次的答卷限制、答卷里记的 IP。
     * 这里直接用一个来自「新 IP」的请求去撞锁定，确认它并没有换到一个新的计数器。
     */
    cookie = await asUser('admin', 'test-pass-123')
    await req('PUT', '/api/settings/site', { trustProxy: 'off' })
    const fakeIps = []
    for (let i = 0; i < 12; i++) {
      const res = await fetch(BASE + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.9.${i}.${i}` },
        body: JSON.stringify({ username: 'lockme', password: 'definitely-wrong' })
      })
      fakeIps.push(res.status)
    }
    assert(fakeIps.includes(429), '换 X-Forwarded-For 无法绕过登录失败锁定', fakeIps.join(','))

    /*
     * 但也不能一刀切成「永远不信」：README 推荐的部署就是 Nginx 反代，
     * 那样所有人对端都是 127.0.0.1，「每 IP 限填一次」会变成「全站只能填一次」。
     * 所以留了显式开关：打开后按层数从右往左取（最右段才是紧邻我们的代理亲手写的）。
     */
    await req('PUT', '/api/settings/site', { trustProxy: 'on', trustHops: 1 })
    const mk = async (xff) => (await req('POST', '/api/forms', {
      title: 'IP 口径测试', kind: 'survey',
      schema: [{ id: 'q1', type: 'radio', label: '选一个', options: ['A', 'B'] }],
      settings: { limit: { perIp: true, maxTimes: 1 } }
    }))
    const ipForm = (await mk()).json.id
    await req('PUT', `/api/forms/${ipForm}`, { status: 'published' })
    const submitWith = async (xff) => {
      const res = await fetch(BASE + `/api/public/forms/${ipForm}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
        body: JSON.stringify({ data: { q1: 'A' } })
      })
      return res.status
    }
    // 打开信任代理后，最右段就是「代理说的真实来源」：换一个就换了一个访客，这条是设计如此
    const a = await submitWith('203.0.113.7')
    const b = await submitWith('198.51.100.9')
    assert(a === 201 && b === 201, '显式信任代理时按最右段识别真实来源（Nginx 后面的正常形态）', `${a},${b}`)

    const r1 = await req('POST', '/api/auth/login', { username: 'nobody-here', password: 'x' })
    assert(r1.status === 401, '信任代理模式下登录照常校验')
    await req('PUT', '/api/settings/site', { trustProxy: 'off' })
  }

  console.log('\n[50] 审计日志：看得见，查得到')
  {
    cookie = await asUser('admin', 'test-pass-123')
    // 造一个普通账号，用来确认日志页不是谁都能开
    await req('POST', '/api/users', { username: 'audituser', password: 'audit-pass-1', nickname: '审计测试', role_id: 2 })
    let r = await req('GET', '/api/logs?keyword=' + encodeURIComponent('登录失败'))
    assert(r.status === 200 && r.json.total > 0, '按关键词搜得到登录失败记录', JSON.stringify(r.json?.total))
    const failed = r.json.data.find(x => /登录失败/.test(x.action))
    assert(!!failed && failed.ip, '失败记录带来源 IP', JSON.stringify(failed))
    assert(!JSON.stringify(r.json.data).includes('definitely-wrong'), '日志不记录明文密码')

    r = await req('GET', '/api/logs?action=' + encodeURIComponent('登录失败'))
    assert(r.status === 200 && r.json.data.every(x => x.action === '登录失败'), '按动作筛选生效')
    assert(Array.isArray(r.json.actions) && r.json.actions.length > 0, '动作清单可用于筛选面板')

    r = await req('GET', '/api/logs?pageSize=5')
    assert(r.json.data.length <= 5 && r.json.totalPages >= 1, '日志分页生效', `len=${r.json.data.length}`)

    const ckUser = await asUser('audituser', 'audit-pass-1')
    r = await call(ckUser, 'GET', '/api/logs')
    assert(r.status === 403, '普通用户看不到审计日志', String(r.status))
  }

  console.log('\n[51] 会话上限：一个账号不该堆出无限多条')
  {
    const cks = []
    for (let i = 0; i < 14; i++) cks.push(await asUser('audituser', 'audit-pass-1'))
    const last = cks[cks.length - 1]
    const r = await call(last, 'GET', '/api/auth/sessions')
    assert(r.status === 200 && r.json.data.length <= 10, '同账号活跃会话数被压在上限内', `len=${r.json.data.length}`)
    const first = await call(cks[0], 'GET', '/api/forms')
    assert(first.status === 401, '最老的会话被自动踢掉（新设备照常能登）', String(first.status))
    const newest = await call(last, 'GET', '/api/forms')
    assert(newest.status === 200, '最新登录的会话仍然有效', String(newest.status))
  }

  console.log('\n[52] 判分口径：排序看顺序、矩阵逐行、文本忽略大小写')
  {
    /*
     * 三个入口各写一套「sort 一下再比」，于是同一道题在交卷、回顾、刷题里
     * 可能得出三种结论。这里把容易判错的三类题一起过一遍。
     */
    cookie = await asUser('admin', 'test-pass-123')
    let r = await req('POST', '/api/banks', { name: '判分口径题库' })
    const bankId = r.json.id
    r = await req('POST', `/api/banks/${bankId}/questions`, { items: [
      { type: 'sort', title: '按重要性排序', label: '按重要性排序', options: ['甲', '乙', '丙'], answer: ['甲', '乙', '丙'], score: 10 },
      { type: 'matrix', title: '满意度', label: '满意度', props: { rows: ['速度', '稳定'] }, options: [{ label: '好', value: '5' }, { label: '差', value: '1' }], answer: ['5', '5'], score: 10 },
      { type: 'text', title: '数据库名', label: '数据库名', answer: ['MySQL'], score: 5 }
    ] })
    const qs = (await req('GET', `/api/banks/${bankId}/questions`)).json.data
    const [qSort, qMatrix, qText] = qs
    assert((qMatrix.props?.rows || []).join('/') === '速度/稳定', '矩阵题的行存进了题库（以前这一层直接丢了）', JSON.stringify(qMatrix.props))
    assert(qMatrix.answer.length === 2, '矩阵题每行的答案都留着（以前去重塌成一条）', JSON.stringify(qMatrix.answer))

    const play = async (id, value) => (await req('POST', `/api/banks/${bankId}/practice/answer`, { questionId: id, value, judge: true })).json
    assert((await play(qSort.id, ['丙', '甲', '乙'])).correct === false, '排序题：打乱顺序算错')
    assert((await play(qSort.id, ['甲', '乙', '丙'])).correct === true, '排序题：正确顺序才算对')
    assert((await play(qMatrix.id, { 速度: '5', 稳定: '5' })).correct === true, '矩阵题：每行都对就判对')
    assert((await play(qMatrix.id, { 速度: '5', 稳定: '1' })).correct === false, '矩阵题：错一行就判错')
    const textRes = await play(qText.id, '  mysql  ')
    assert(textRes.correct === true, '文本题：大小写与首尾空格不影响判定', JSON.stringify(textRes))
    assert(/MySQL/.test(textRes.answerText || ''), '刷题反馈给出人能读的答案', JSON.stringify(textRes.answerText))

    // 交卷与回顾必须与刷题同口径
    r = await req('POST', `/api/forms`, {
      title: '判分口径考试', kind: 'exam',
      schema: [
        { id: 's1', type: 'sort', label: '按重要性排序', options: ['甲', '乙', '丙'], answer: ['甲', '乙', '丙'], score: 10 },
        { id: 'm1', type: 'matrix', label: '满意度', props: { rows: ['速度', '稳定'] }, options: [{ label: '好', value: '5' }, { label: '差', value: '1' }], answer: ['5', '5'], score: 10 },
        { id: 't1', type: 'text', label: '数据库名', answer: ['MySQL'], score: 5 }
      ],
      settings: { passPercent: 60 }
    })
    const examId = r.json.id
    await req('PUT', `/api/forms/${examId}`, { status: 'published' })

    const submit = async (data) => (await req('POST', `/api/public/forms/${examId}/submit`, { data })).json
    const allRight = await submit({ s1: ['甲', '乙', '丙'], m1: { 速度: '5', 稳定: '5' }, t1: 'mysql' })
    assert(allRight.score === 25, '交卷：排序对 + 矩阵全对 + 文本忽略大小写 = 满分', String(allRight.score))
    const mixed = await submit({ s1: ['丙', '乙', '甲'], m1: { 速度: '5', 稳定: '1' }, t1: 'MySQL' })
    assert(mixed.score === 5, '交卷：排序错、矩阵错一行，只剩填空题的分', String(mixed.score))
    const sortItem = mixed.review.items.find(i => i.id === 's1')
    assert(/→/.test(sortItem.given[0]), '回顾：排序作答按顺序展示，不是逗号拼接', JSON.stringify(sortItem.given))
    assert(sortItem.correct === false, '回顾：排序错的题在逐题回顾里也判错')
    const matrixItem = mixed.review.items.find(i => i.id === 'm1')
    assert(/速度/.test(matrixItem.answerText || ''), '回顾：矩阵答案逐行给出，不是一串 "5、5"', JSON.stringify(matrixItem.answerText))

    // 报表口径：矩阵题的作答是「满意/一般」这类文字，拿 Number() 求平均会全成 0
    r = await req('GET', `/api/forms/${examId}/report`)
    const statQ = r.json.data.questions
    const mStat = statQ.find(x => x.type === 'matrix')
    assert(mStat && mStat.series.some(s2 => s2.value > 0), '报表：矩阵题按列统计人数，不是一排零', JSON.stringify(mStat?.series))
    const sStat = statQ.find(x => x.type === 'sort')
    assert(sStat && sStat.series.every(s2 => s2.value > 0) && /名次/.test(sStat.note || ''),
      '报表：排序题给平均名次，而不是「每个选项都一样多」', JSON.stringify([sStat?.series, sStat?.note]))
  }

  console.log('\n[53] 题库协作：多人维护一个题库，权限按角色分档')
  {
    /*
     * 以前题库只有 owner_id 一个身份，「两个人一起维护一个题库」没有表达方式。
     * 这一节约的是「谁能看、谁能改、谁能让别人进来」这三条边界。
     */
    cookie = await asUser('admin', 'test-pass-123')
    await req('POST', '/api/users', { username: 'collab-a', password: 'collab-pass-1', nickname: '甲' })
    await req('POST', '/api/users', { username: 'collab-b', password: 'collab-pass-1', nickname: '乙' })
    await req('POST', '/api/users', { username: 'collab-c', password: 'collab-pass-1', nickname: '丙' })
    const ckA = await asUser('collab-a', 'collab-pass-1')
    const ckB = await asUser('collab-b', 'collab-pass-1')

    let r = await call(ckA, 'POST', '/api/banks', { name: '协作测试库' })
    const bid = r.json.id

    r = await call(ckB, 'GET', `/api/banks/${bid}/questions`)
    assert(r.status === 404, '未被邀请的人看不到这个题库')

    r = await call(ckA, 'POST', `/api/banks/${bid}/members`, { username: 'collab-b', role: 'editor' })
    assert(r.status === 201 && r.json.role === 'editor', '所有者可以把人加成可编辑协作者', JSON.stringify(r.json))

    r = await call(ckB, 'GET', '/api/banks')
    const shared = r.json.data.find(b => b.id === bid)
    assert(shared?.my_role === 'editor', '协作者的题库列表里带出 my_role=editor', JSON.stringify(shared))

    r = await call(ckB, 'POST', `/api/banks/${bid}/questions`, { type: 'radio', title: '协作添加的题', options: ['A', 'B'], answer: ['A'] })
    assert(r.status === 201, '可编辑协作者能往题库里加题', String(r.status))

    // 调成只读
    r = await call(ckA, 'POST', `/api/banks/${bid}/members`, { username: 'collab-b', role: 'viewer' })
    assert(r.json.role === 'viewer' && r.json.updated === true, '角色可以从可编辑改成只读', JSON.stringify(r.json))
    r = await call(ckB, 'POST', `/api/banks/${bid}/questions`, { type: 'radio', title: '只读还想加题', options: ['A', 'B'], answer: ['A'] })
    assert(r.status === 403, '只读协作者加题被拒', String(r.status))
    r = await call(ckB, 'DELETE', `/api/banks/${bid}`)
    assert(r.status === 403, '只读协作者不能删题库', String(r.status))
    r = await call(ckB, 'POST', `/api/banks/${bid}/members`, { username: 'collab-c', role: 'editor' })
    assert(r.status === 403, '协作者不能自己拉人（只有所有者能管成员）', String(r.status))

    // 只读身份不该读到标准答案，也不能导出带答案的表
    r = await call(ckB, 'GET', `/api/banks/${bid}/questions`)
    assert(r.json.redacted === true && r.json.data.every(q => q.answer.length === 0 && !q.analysis),
      '只读协作者看题时不带标准答案与解析', JSON.stringify(r.json).slice(0, 200))
    const exp = await fetch(BASE + `/api/banks/${bid}/export.xlsx`, { headers: { Cookie: ckB } })
    assert(exp.status === 403, '只读协作者不能导出含答案的 Excel', String(exp.status))

    r = await call(ckB, 'GET', `/api/banks/${bid}/practice?mode=sequence`)
    assert(r.status === 200, '只读协作者照样可以刷题', String(r.status))

    r = await call(ckA, 'GET', `/api/banks/${bid}/members`)
    assert(r.json.data.members.length === 1 && r.json.data.my_role === 'owner', '成员列表带出所有者与协作者', JSON.stringify(r.json.data.members))
    assert(Array.isArray(r.json.data.candidates) && r.json.data.candidates.some(u => u.username === 'collab-c'),
      '所有者能看到可邀请的人', JSON.stringify(r.json.data.candidates?.map(u => u.username)))

    const uB = (await req('GET', '/api/users?keyword=collab-b')).json.data.find(u => u.username === 'collab-b')
    r = await call(ckA, 'DELETE', `/api/banks/${bid}/members/${uB.id}`)
    assert(r.json.ok, '所有者可以移除协作者')
    r = await call(ckB, 'GET', `/api/banks/${bid}/questions`)
    assert(r.status === 404, '移除后立刻失去访问权', String(r.status))

    // 删除账号时协作关系要跟着清掉：留着就是一个指向空气的权限位
    await call(ckA, 'POST', `/api/banks/${bid}/members`, { username: 'collab-c', role: 'editor' })
    const uC = (await req('GET', '/api/users?keyword=collab-c')).json.data.find(u => u.username === 'collab-c')
    await req('DELETE', `/api/users/${uC.id}`)
    r = await call(ckA, 'GET', `/api/banks/${bid}/members`)
    assert(!r.json.data.members.some(m => m.username === 'collab-c'), '账号被删除后协作关系一并清理')
  }

  console.log('\n[54] 组织架构：部门树可维护，职位挂在部门下')
  {
    cookie = await asUser('admin', 'test-pass-123')
    let r = await req('POST', '/api/depts', { name: '冒烟·技术中心' })
    const d1 = r.json.id
    r = await req('POST', '/api/depts', { name: '冒烟·后端组', parent_id: d1 })
    const d2 = r.json.id
    r = await req('POST', '/api/depts', { name: '冒烟·后端组', parent_id: d1 })
    assert(r.status === 409, '同一上级下的同名部门被拒', String(r.status))

    r = await req('PUT', `/api/depts/${d1}`, { parent_id: d2 })
    assert(r.status === 400, '不能把部门挂到自己的下级下面（会成环）', r.json?.message)
    r = await req('PUT', `/api/depts/${d1}`, { parent_id: d1 })
    assert(r.status === 400, '上级不能是自己', r.json?.message)
    r = await req('PUT', `/api/depts/${d2}`, { name: '冒烟·服务端组' })
    assert(r.json.ok, '部门可以改名')

    r = await req('GET', '/api/depts')
    const tree = r.json.tree.find(t => t.id === d1)
    assert(tree && tree.children.length === 1 && tree.children[0].name === '冒烟·服务端组', '部门接口返回树结构', JSON.stringify(tree))
    assert(tree.children[0].depth === 1, '树节点带层级，前端不用自己算')

    r = await req('DELETE', `/api/depts/${d1}`)
    assert(r.status === 400 && /子部门/.test(r.json.message), '有子部门时不能直接删', r.json?.message)

    r = await req('POST', '/api/positions', { name: '冒烟·服务端工程师', dept_id: d2 })
    const pid = r.json.id
    r = await req('POST', '/api/positions', { name: '冒烟·服务端工程师', dept_id: d2 })
    assert(r.status === 409, '同部门下职位重名被拒', String(r.status))

    r = await req('POST', '/api/users', { username: 'org-user', password: 'org-pass-123', nickname: '组织人', dept_id: d2, position_id: pid })
    assert(r.status === 201, '建用户时可同时指定部门与职位')
    r = await req('GET', '/api/users?keyword=org-user')
    const orgUser = r.json.data.find(u => u.username === 'org-user')
    assert(orgUser.dept_name === '冒烟·服务端组' && orgUser.position_name === '冒烟·服务端工程师',
      '用户列表带出部门名与职位名', JSON.stringify([orgUser?.dept_name, orgUser?.position_name]))

    r = await req('DELETE', `/api/depts/${d2}`)
    assert(r.status === 400 && /用户/.test(r.json.message), '部门里还有人时不能删', r.json?.message)
    r = await req('DELETE', `/api/positions/${pid}`)
    assert(r.status === 400 && /用户/.test(r.json.message), '职位还有人占着时不能删', r.json?.message)

    // 收尾：把人挪走再删，避免留下脏数据影响后续断言
    await req('PUT', `/api/users/${orgUser.id}`, { dept_id: 0, position_id: 0 })
    r = await req('DELETE', `/api/depts/${d2}`)
    assert(r.json.ok, '清空占用后部门可以删除')
    r = await req('DELETE', `/api/depts/${d1}`)
    assert(r.json.ok, '父部门跟着可以删除')
  }

  console.log('\n[55] 大数据量：报表/导出/同步不再把整表搬进内存')
  {
    // 造一份「答卷有几千份」的表单：不是压测，是为了让「全表读进内存」这类实现暴露出来
    r = await req('POST', '/api/forms', {
      title: '冒烟·大体量报表', kind: 'survey',
      schema: [
        { id: 'big_city', type: 'radio', label: '城市', options: [{ label: '北京', value: '北京' }, { label: '上海', value: '上海' }] },
        { id: 'big_nps', type: 'nps', label: '推荐意愿', props: { max: 10, min: 0 } },
        { id: 'big_tags', type: 'checkbox', label: '标签', options: [{ label: '甲', value: '甲' }, { label: '乙', value: '乙' }] },
        { id: 'big_num', type: 'number', label: '数字' }
      ]
    })
    const bigId = r.json.id
    const bigSchema = r.json.data.schema
    await req('PUT', `/api/forms/${bigId}`, { status: 'published' })

    // 直接走批量导入：一条一条提交几千次太慢，而且这里要验的是读，不是写
    const N = 3000
    const items = []
    for (let i = 0; i < N; i++) {
      items.push({ data: {
        [bigSchema[0].id]: i % 2 ? '北京' : '上海',
        [bigSchema[1].id]: String(i % 11),
        [bigSchema[2].id]: i % 3 === 0 ? ['甲', '乙'] : ['甲'],
        [bigSchema[3].id]: String(i % 100)
      } })
    }
    r = await req('POST', `/api/forms/${bigId}/import`, { items })
    assert(r.json.imported === N, `${N} 份答卷导入成功`, JSON.stringify(r.json))

    // 报表：数字要对得上（不是「跑得快就行」）
    r = await req('GET', `/api/forms/${bigId}/report`)
    assert(r.status === 200 && r.json.data.total === N, '大体量表单的报表条数正确', String(r.json?.data?.total))
    const city = r.json.data.questions.find(q => q.id === bigSchema[0].id)
    assert(city.series.find(x => x.name === '北京').value === N / 2, '单选分布在全量数据下仍然准确', JSON.stringify(city.series))
    const nps = r.json.data.questions.find(q => q.id === bigSchema[1].id)
    assert(nps.series.length === 11 && nps.series[0].name === '0', 'NPS 的 0 档在流式聚合里没丢', JSON.stringify(nps.series.map(x => x.name)))
    const num = r.json.data.questions.find(q => q.id === bigSchema[3].id)
    assert(num.min === 0 && num.max === 99, '数值题的极值正确', JSON.stringify([num.min, num.max]))

    // 缓存：同样的数据第二次应该直接命中（不改数据的情况下结果必须完全一致）
    r = await req('GET', `/api/forms/${bigId}/report`)
    const city2 = r.json.data.questions.find(q => q.id === bigSchema[0].id)
    assert(JSON.stringify(city2.series) === JSON.stringify(city.series), '缓存命中的结果与现算一致')

    // 数据一变，缓存必须失效 —— 否则「刚提交的答卷报表里没有」
    await req('POST', `/api/public/forms/${bigId}/submit`, { data: { [bigSchema[0].id]: '北京', [bigSchema[1].id]: '10' } })
    r = await req('GET', `/api/forms/${bigId}/report`)
    assert(r.json.data.total === N + 1, '新增答卷后报表缓存自动失效', String(r.json?.data?.total))

    // 导出：必须是一次能读完的、结构完整的 xlsx
    const dl = await fetch(BASE + `/api/forms/${bigId}/submissions.xlsx`, { headers: { Cookie: cookie } })
    assert(dl.ok, '大体量答卷可以导出 Excel', String(dl.status))
    const buf = Buffer.from(await dl.arrayBuffer())
    assert(buf.length > 1000, '导出的 Excel 非空', String(buf.length))
    // 校验是合法 zip：读得出中央目录与工作表
    const { readZipEntries } = await import('../server/lib/zip.js')
    const entries = readZipEntries(buf)
    assert(!!entries, '导出的 xlsx 是结构完整的 zip')
    const sheet = entries.find(e => e.name === 'xl/worksheets/sheet1.xml')?.data?.toString('utf8') || ''
    assert(sheet.includes('big_city') === false, '工作表里是题目文字而不是字段 id')
    assert((sheet.match(/<row /g) || []).length === N + 2, '导出行数 = 表头 + 全部答卷 + 新提交的那份', String((sheet.match(/<row /g) || []).length))
    assert(sheet.trimEnd().endsWith('</worksheet>'), '工作表 XML 正常收尾（流式写出没有截断）')

    // 同步 API：第一次不给游标，一次最多 limit 条
    r = await req('GET', `/api/sync/export?formId=${bigId}&limit=100`)
    assert(r.json.data.length === 100, '同步 API 按 limit 分批返回', String(r.json?.data?.length))
    assert(r.json.hasMore === true && r.json.sinceId > 0, '同步 API 给出继续拉取的游标', JSON.stringify([r.json?.hasMore, r.json?.sinceId]))
    const firstId = r.json.sinceId
    r = await req('GET', `/api/sync/export?formId=${bigId}&sinceId=${firstId}&limit=100`)
    assert(r.json.data.length === 100 && r.json.data[0].id > firstId, '用游标可以继续拉到下一批', JSON.stringify([r.json?.data?.[0]?.id, firstId]))

    // 待批阅筛选：调查问卷没有主观题，不该把这 3000 份全扫进阅卷队列判一遍
    r = await req('GET', '/api/submissions?pending=1&formId=' + bigId)
    assert(r.status === 200 && r.json.total === 0, '问卷答卷不进阅卷队列', JSON.stringify(r.json?.total))

    // 收尾
    await req('DELETE', `/api/forms/${bigId}`)
  }

  console.log('\n[56] 底层：语句复用、流式 zip、报表累加器')
  {
    const { writeZipStream, readZipEntries } = await import('../server/lib/zip.js')
    const { writeXlsxStream, readXlsx } = await import('../server/lib/xlsx.js')
    const { Writable } = await import('node:stream')

    // 流式 zip：内容能被自己的解析器读回（说明中央目录、CRC、数据描述符都对）
    const collect = () => {
      const chunks = []
      const w = new Writable({ write(c, _e, cb) { chunks.push(c); cb() } })
      return { w, done: async () => { await new Promise(r => w.end(r)); return Buffer.concat(chunks) } }
    }
    let box = collect()
    await writeZipStream([{ name: 'a.txt', data: '你好 EQS' }, { name: 'b.bin', data: Buffer.alloc(2000, 7), compress: false }], box.w)
    let zipped = await box.done()
    let back = readZipEntries(zipped)
    assert(!!back, '流式 zip 能被 readZipEntries 读回（中央目录正确）')
    assert(back.find(e => e.name === 'a.txt')?.data?.toString() === '你好 EQS', '流式 zip 的中文内容无损')
    assert(back.find(e => e.name === 'b.bin')?.data?.length === 2000, 'store 模式的条目长度正确')

    // 流式 xlsx：几千行也走这条路径，读回来行数与内容都要对
    box = collect()
    async function* bigRows() {
      yield ['城市', '分数']
      for (let i = 0; i < 5000; i++) yield [`城市${i}`, String(i)]
    }
    await writeXlsxStream('大数据', bigRows(), box.w)
    zipped = await box.done()
    const rows = readXlsx(zipped)
    assert(rows?.length === 5001, '流式写出的 xlsx 行数正确', String(rows?.length))
    assert(rows?.[1]?.[0] === '城市0' && rows?.[5000]?.[1] === '4999', '流式写出的 xlsx 首尾内容正确', JSON.stringify(rows?.[5000]))

    // 语句缓存：同一个 SQL 反复用，准备好的语句是同一个对象
    const dbm = await import('../server/lib/db.js')
    const t0 = Date.now()
    for (let i = 0; i < 3000; i++) dbm.get('SELECT COUNT(*) c FROM users')
    const reused = Date.now() - t0
    assert(reused < 5000, '复用预编译语句后 3000 次查询仍在毫秒级', reused + 'ms')

    // 报表累加器：自由作答的键不能无限增长（否则「内存与答卷数无关」就成了空话）
    const { createStatsAccumulator } = await import('../server/lib/forms.js')
    const acc = createStatsAccumulator({ schema: [{ id: 'free', type: 'text', label: '自由填写' }] })
    for (let i = 0; i < 6000; i++) acc.push({ data: { free: '答案' + i }, created_at: '2026-01-01T00:00:00Z' })
    const out = acc.result()
    assert(out.total === 6000, '累加器统计到的条数正确')
    assert(out.questions[0].count === 6000, '自由作答的计数不受键上限影响')
    assert(out.questions[0].samples.length <= 20, '自由作答只留 20 个样本，不会越攒越多', String(out.questions[0].samples.length))
  }

  console.log('\n[57] 文本导入：题型标签写在行首时不该留在题干里')
  {
    const { parseTextToFields } = await import('../server/routes/forms.js')
    const fields = parseTextToFields([
      '[单选] 下列哪个不是 HTTP 方法？',
      'A. GET',
      'B. POST',
      'C. FETCH',
      '答案：C',
      '分值：5',
      '',
      '【多选】以下哪些是关系型数据库？',
      'A. MySQL',
      'B. Redis',
      '答案：A',
      '分值：10',
      '',
      '（判断）HTTP 404 表示资源不存在。',
      '答案：正确',
      '分值：5',
      '',
      '[简答] 简述事件循环（Event Loop）的作用。',
      '分值：10'
    ].join('\n'), { defaultScore: 5 })
    assert(fields.length === 4, '行首标签的四种写法都能各起一道题', String(fields.length))
    assert(fields.every(f => !/^[\s\[【（(]/.test(f.label)), '题干不再顶着 [单选] / 【多选】 这类标签', JSON.stringify(fields.map(f => f.label)))
    assert(fields[0].label === '下列哪个不是 HTTP 方法？' && fields[0].type === 'radio', '行首 [单选] 仍被识别成单选', JSON.stringify([fields[0].label, fields[0].type]))
    assert(fields[1].type === 'checkbox', '行首【多选】识别成多选', fields[1].type)
    assert(fields[2].type === 'radio' && JSON.stringify(fields[2].answer) === '["正确"]', '行首（判断）仍然拿到「正确答案：正确」', JSON.stringify(fields[2].answer))
    assert(fields[3].type === 'textarea', '行首 [简答] 识别成多行文本', fields[3].type)
    assert(fields[3].label.includes('（Event Loop）'), '题干里的英文括号没有被误当题型标签摘掉', fields[3].label)
    assert(JSON.stringify(fields[0].answer) === '["FETCH"]', '答案字母仍然折成了选项值', JSON.stringify(fields[0].answer))
  }

  console.log('\n[44] 前端静态资源')

  for (const p of ['/', '/js/main.js', '/css/app.css', '/js/views/Logs.js', '/assets/eqs-mark.svg', '/vendor/echarts.min.js']) {
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
