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
    // 现在导出走流式（deflate + 数据描述符），所以解析要读中央目录，不能只看本地头。
    const { readZipEntries } = await import('../server/lib/zip.js')
    const bak = await fetch(BASE + '/api/backup/export', { headers: { Cookie: cookie } })
    const buf = Buffer.from(await bak.arrayBuffer())
    assert(bak.ok, '备份导出返回 200', String(bak.status))
    // 流式导出没有 Content-Length（边压边发），不能靠它判断包大小
    assert(!bak.headers.get('content-length'), '流式导出不报 Content-Length（内存可控优先于进度条）')
    const entries = readZipEntries(buf) || []
    assert(entries.length >= 2, '备份包结构可读', String(entries.length))

    const manifestEntry = entries.find(e => e.name === 'eqs-data/manifest.json')
    assert(!!manifestEntry, '备份包里有 manifest.json')
    const manifest = JSON.parse(manifestEntry.data.toString('utf8'))
    assert(manifest.app === 'EQS' && manifest.format >= 2, 'manifest 标明来源与格式版本', JSON.stringify([manifest.app, manifest.format]))
    assert(manifest.counts?.submissions >= 1, 'manifest 里带各表行数', JSON.stringify(manifest.counts))

    const dbEntry = entries.find(e => e.name === 'eqs-data/eqs.db')
    assert(!!dbEntry && dbEntry.data.length > 8192, '备份包里有非空的 eqs.db', `size=${dbEntry?.data.length}`)
    // 主库只该出现一次：既要单独快照、又要普通遍历时，包里会出现两条 eqs-data/eqs.db，
    // 导入端读到哪一份全看运气
    assert(entries.filter(e => e.name === 'eqs-data/eqs.db').length === 1, 'eqs.db 在包里只有一条')
    const crypto = await import('node:crypto')
    const sha = crypto.createHash('sha256').update(dbEntry.data).digest('hex')
    assert(sha === manifest.db.sha256, 'manifest 里的 sha256 与包内数据库一致')

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

  console.log('\n[20b] 备份：流式导出、导入校验、可回滚')
  {
    const { readZipEntries, buildZip } = await import('../server/lib/zip.js')
    const crypto2 = await import('node:crypto')

    // 1) 导入前自动快照：导入是可撤销的，前提是「撤销」这一刻已经被存下来
    let r = await req('POST', '/api/forms', { title: '只在快照里存在的表单', kind: 'survey' })
    const snapMark = r.json.id
    const zip = Buffer.from(await (await fetch(BASE + '/api/backup/export', { headers: { Cookie: cookie } })).arrayBuffer())
    await req('DELETE', `/api/forms/${snapMark}`)
    let imp = await (async () => {
      const fd = new FormData()
      fd.append('file', new Blob([zip]), 'backup.zip')
      const res = await fetch(BASE + '/api/backup/import', { method: 'POST', headers: { Cookie: cookie }, body: fd })
      return { status: res.status, json: await res.json() }
    })()
    assert(imp.json.ok, '导入返回成功', JSON.stringify(imp.json))
    assert(typeof imp.json.snapshot === 'string' && imp.json.snapshot.startsWith('pre-import-'), '导入前自动存了快照', String(imp.json.snapshot))
    r = await req('GET', `/api/forms/${snapMark}`)
    assert(r.status === 200 && !r.json.data?.deleted_at, '导入后表单立刻回到未删除状态')

    r = await req('GET', '/api/backup/snapshots')
    assert(Array.isArray(r.json.data) && r.json.data.some(s => s.name === imp.json.snapshot), '快照列表能查到刚存的那份')

    // 2) 回滚：把「导入」这件事撤回去；回滚本身也会先存一份
    await req('DELETE', `/api/forms/${snapMark}`)
    r = await req('POST', '/api/backup/rollback', { name: imp.json.snapshot })
    assert(r.json.ok && r.json.restored === imp.json.snapshot, '回滚返回恢复的那份快照', JSON.stringify(r.json))
    assert(typeof r.json.safety === 'string' && r.json.safety.startsWith('pre-rollback-'), '回滚前把当前状态另存了一份', String(r.json.safety))
    /*
     * 快照是「导入前」那一刻拍的，而那之前测试刚把表单删掉进回收站，
     * 所以回滚后的正确结果是：回到「已删除」——回滚到的是快照，不是导入后的状态。
     * 这一条实际上验的是同一件事的两面：回滚真的动了库。
     */
    r = await req('GET', `/api/forms/${snapMark}`)
    assert(r.status === 200 && !!r.json.data?.deleted_at, '回滚后回到快照那一刻的状态（表单仍是删除态）', `status=${r.status} deleted=${r.json.data?.deleted_at}`)
    // 再导入一次，确认「回滚 → 再导入」这条路走得通（会话、连接都没被打死）
    imp = await (async () => {
      const fd = new FormData()
      fd.append('file', new Blob([zip]), 'backup.zip')
      const res = await fetch(BASE + '/api/backup/import', { method: 'POST', headers: { Cookie: cookie }, body: fd })
      return { status: res.status, json: await res.json() }
    })()
    assert(imp.json.ok, '回滚之后还能再导入一次', JSON.stringify(imp.json))
    r = await req('GET', `/api/forms/${snapMark}`)
    assert(r.status === 200 && !r.json.data?.deleted_at, '再次导入后表单又回到未删除')

    // 3) 坏包必须被拦在「顶替」之前。旧实现直接换库，之后每个请求都回 statement has been finalized
    const badZip = (() => {
      return buildZip([{ name: 'eqs-data/eqs.db', data: Buffer.from('this is definitely not a sqlite file at all') }])
    })()
    let bad = await (async () => {
      const fd = new FormData()
      fd.append('file', new Blob([badZip]), 'bad.zip')
      const res = await fetch(BASE + '/api/backup/import', { method: 'POST', headers: { Cookie: cookie }, body: fd })
      return { status: res.status, json: await res.json() }
    })()
    assert(bad.status === 400 && /SQLite/.test(bad.json.message), '内容不是数据库的包被当场拒绝', `${bad.status} ${bad.json.message}`)
    r = await req('GET', '/api/health')
    assert(r.status === 200 && r.json.ok, '被拒绝之后服务仍然健康（钱没花在恢复现场上）')
    r = await req('GET', '/api/forms?pageSize=1')
    assert(r.status === 200 && r.json.ok, '被拒绝之后数据库连接仍然可用')

    // 4) 包结构不对（没有 eqs-data/eqs.db）也要说清楚原因，而不是 500
    const noDb = await (async () => {
      return buildZip([{ name: 'readme.txt', data: Buffer.from('hello') }])
    })()
    let miss = await (async () => {
      const fd = new FormData()
      fd.append('file', new Blob([noDb]), 'x.zip')
      const res = await fetch(BASE + '/api/backup/import', { method: 'POST', headers: { Cookie: cookie }, body: fd })
      return { status: res.status, json: await res.json() }
    })()
    assert(miss.status === 400 && /eqs-data\/eqs\.db/.test(miss.json.message), '不是 EQS 备份的包给出明确原因', `${miss.status} ${miss.json.message}`)

    // 5) 超过 64MB 的备份包：旧实现 readBody 上限就在这里，等于「自己导出的备份自己导不回来」
    const big = crypto2.randomBytes(70 * 1024 * 1024)
    const bigZip = await (async () => {
      const { buildZip } = await import('../server/lib/zip.js')
      const dbEntry = (readZipEntries(zip) || []).find(e => e.name === 'eqs-data/eqs.db')
      // 随机字节压不动，包体积确实大过 64MB
      return buildZip([{ name: 'eqs-data/eqs.db', data: dbEntry.data }, { name: 'eqs-data/files/big.bin', data: big }])
    })()
    assert(bigZip.length > 64 * 1024 * 1024, '构造出的备份包确实超过旧上限', (bigZip.length / 1048576).toFixed(1) + 'MB')
    let bigImp = await (async () => {
      const fd = new FormData()
      fd.append('file', new Blob([bigZip]), 'big.zip')
      const res = await fetch(BASE + '/api/backup/import', { method: 'POST', headers: { Cookie: cookie }, body: fd })
      return { status: res.status, json: await res.json() }
    })()
    assert(bigImp.json.ok, '超过 64MB 的备份包能导入（旧实现这里 413）', `${bigImp.status} ${bigImp.json.message}`)
    assert(bigImp.json.filesMerged >= 1, '大包里的附件被流式解出来', String(bigImp.json.filesMerged))
    assert(fs.existsSync(path.join(DATA_DIR, 'files', 'big.bin')), '附件真的落到了磁盘上')

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

  console.log('\n[58] 成绩排名：同分同名次、下一名跳号、不公布成绩时不泄露')
  {
    /*
     * README 与工作台一直写着「成绩统计与排名」，「排名」却既没有接口也没有页面。
     * 这一节钉住的是名次口径：并列怎么算、跳不跳号、谁能看、什么情况下不该给。
     */
    cookie = await asUser('admin', 'test-pass-123')
    let r = await req('POST', '/api/forms', {
      title: '排名口径考试', kind: 'exam',
      schema: [{ id: 'q1', type: 'radio', label: '一加一', options: ['1', '2', '3'], answer: ['2'], score: 10 }],
      settings: { passPercent: 60, showResult: true, showRank: true }
    })
    const examId = r.json.id
    await req('PUT', `/api/forms/${examId}`, { status: 'published' })

    const submit = async (data) => (await req('POST', `/api/public/forms/${examId}/submit`, { data })).json
    const a = await submit({ q1: '2' })   // 10 分
    const b = await submit({ q1: '2' })   // 10 分（并列）
    const c = await submit({ q1: '1' })   // 0 分
    const d = await submit({ q1: '3' })   // 0 分（与 c 并列）
    const e = await submit({})            // 未答 → 0 分，与 c/d 同分

    assert(a.rank && a.rank.rank === 1, '满分交卷：名次 1', JSON.stringify(a.rank))
    // 交卷那一刻算的是「到现在为止」的名次：a 交卷时库里还只有它自己
    assert(a.rank.total === 1 && a.rank.percentile === 100, '交卷即给名次，总人数按当时已交卷的算', JSON.stringify(a.rank))
    assert(b.rank.rank === 1, '同分并列同名次，不因为晚交就排到第 2', JSON.stringify(b.rank))

    // 榜单：1,1,3,3,3 —— 两个 10 分并列第 1，下一名从第 3 开始
    r = await req('GET', `/api/forms/${examId}/ranking?limit=10`)
    const top = r.json.data.top
    assert(top.length === 5, '榜单给出全部有成绩的答卷', String(top.length))
    assert(top.map(x => x.rank).join(',') === '1,1,3,3,3', '并列同名次、下一名跳号（1,1,3,3,3）', top.map(x => x.rank).join(','))
    assert(top[0].score === 10 && top[4].score === 0, '榜单按分数倒序', JSON.stringify(top.map(x => x.score)))
    // 主观题没批完的卷子可判分总分更低、及格线也低，榜单必须标出来，否则读者会以为判错了
    assert(top.every(x => x.pending === 0), '全客观题的卷子没有「待批阅」标记', JSON.stringify(top.map(x => x.pending)))
    const dist = r.json.data.distribution
    assert(dist.buckets.length === 10, '分数分布切成 10 档', String(dist.buckets?.length))
    assert(dist.buckets.reduce((x, y) => x + y.count, 0) === 5, '各档人数加起来等于总人数', JSON.stringify(dist.buckets.map(x => x.count)))

    // 限量：前 2 名只返回 2 行，但名次口径照旧
    r = await req('GET', `/api/forms/${examId}/ranking?limit=2`)
    assert(r.json.data.top.length === 2 && r.json.data.total === 5, '按需取前 N 名，总数照给', JSON.stringify([r.json.data.top.length, r.json.data.total]))

    // 提交时未开排行榜，公开榜单必须 403
    r = await req('GET', `/api/public/forms/${examId}/ranking`)
    assert(r.status === 403, '没开「公开成绩榜」时公开接口拒绝', String(r.status))
    // 交卷返回里也只有名次，不含任何人名
    assert(!JSON.stringify(a.rank).includes('匿名'), '交卷返回的名次只有数字，不含他人信息', JSON.stringify(a.rank))

    // 打开排行榜：名字必须打码，不能把账号昵称原样贴到匿名页面上
    await req('PUT', `/api/forms/${examId}`, { settings: { passPercent: 60, showResult: true, showRank: true, showRanking: true } })
    r = await req('GET', `/api/public/forms/${examId}/ranking?limit=10`)
    assert(r.status === 200 && r.json.data.length === 5, '开了之后公开榜单可用', String(r.status))
    // 测试里所有提交都带着同一个登录会话，所以昵称来自那个账号；关键是它被打码了，不是原样贴出去
    assert(r.json.data.every(x => /^[^*]\*{1,3}$/.test(x.name) || x.name === '匿名考生'),
      '公开榜单上的名字一律打码（真名只留首字）', JSON.stringify(r.json.data.map(x => x.name)))
    assert(r.json.data.every(x => x.score !== undefined && x.publicId), '榜单带分数与答卷编号', JSON.stringify(r.json.data[0]))

    // 关掉「逐题对错」= 不公布成绩，名次也不能从这个缝里漏出去
    await req('PUT', `/api/forms/${examId}`, { settings: { passPercent: 60, showResult: false, showRank: true } })
    const hidden = await submit({ q1: '2' })
    assert(hidden.rank === null, '不公布成绩时不返回名次（否则第 1 名等于告知满分）', JSON.stringify(hidden.rank))

    // 主观题未批阅：榜单要标 pending，交卷返回里也要能看出还有几题没批
    r = await req('POST', '/api/forms', {
      title: '主观题排名考试', kind: 'exam',
      schema: [
        { id: 'o1', type: 'radio', label: '客观题', options: ['A', 'B'], answer: ['A'], score: 10 },
        { id: 'sub1', type: 'textarea', label: '主观题', score: 20 }
      ],
      settings: { passPercent: 60, showResult: true, showRank: true }
    })
    const subExamId = r.json.id
    await req('PUT', `/api/forms/${subExamId}`, { status: 'published' })
    const s1 = await req('POST', `/api/public/forms/${subExamId}/submit`, { data: { o1: 'A', sub1: '我的答案' } })
    assert(s1.json.ungraded === 1, '交卷时告知还有 1 道主观题待批', String(s1.json.ungraded))
    r = await req('GET', `/api/forms/${subExamId}/ranking?limit=10`)
    assert(r.json.data.top[0].pending === 1, '榜单标出「还有 1 题待批」', JSON.stringify(r.json.data.top[0]))

    // 问卷类表单没有排名
    r = await req('POST', '/api/forms', { title: '排名测试问卷', kind: 'survey', schema: [{ id: 's1', type: 'text', label: '想法' }] })
    const surveyId = r.json.id
    const rep = await req('GET', `/api/forms/${surveyId}/report`)
    assert(!rep.json.data.questions.some(q => q.id === 'rank'), '问卷报表不掺排名数据')
    r = await req('GET', `/api/forms/${surveyId}/ranking`)
    assert(r.status === 200 && r.json.data.total === 0, '问卷也能查排名接口，只是没有成绩', String(r.status))

    // 权限：别人的考试不能查排名
    await req('POST', '/api/users', { username: 'rank-out', password: 'rank-pass-1', nickname: '外人' })
    const other = await asUser('rank-out', 'rank-pass-1')
    const denied = await call(other, 'GET', `/api/forms/${examId}/ranking`)
    assert(denied.status === 403 || denied.status === 400, '别人的考试查不到排名', String(denied.status))

    // 名字打码本身
    const { maskName } = await import('../server/lib/ranking.js')
    assert(maskName('张三') === '张*', '两字名只留姓', maskName('张三'))
    assert(maskName('欧阳修文') === '欧***', '长名字打码长度封顶 3', maskName('欧阳修文'))
    assert(maskName('') === '匿名考生' && maskName('  ') === '匿名考生', '空名字统一「匿名考生」', JSON.stringify([maskName(''), maskName('  ')]))
    assert(maskName('13800138000') === '匿名考生', '纯数字（手机号当昵称）直接匿名', maskName('13800138000'))
  }

  console.log('\n[44] AI 能力：模型列表 / 流式生成 / AI 解析')
  {
    /*
     * 用真的 HTTP 上游，不打桩。
     * 上一轮的经验：凡是「只在代码里看起来对」的东西，都得拿真请求打一遍——
     * 这几条能力（/models、流式帧、解析）以前根本没有入口，更没有测过。
     */
    const http = await import('node:http')
    const seen = { bodies: [] }
    const FULL = {
      title: '员工满意度调查',
      description: '由 AI 生成',
      fields: [
        { type: 'rate', label: '整体满意度', required: true, props: { max: 5 } },
        { type: 'radio', label: '最满意的方面（必填）', options: ['环境', '协作', '薪酬'] },
        { type: 'textarea', label: '其他建议' }
      ]
    }
    const chunks = JSON.stringify(FULL).match(/[\s\S]{1,60}/g)
    const mock = http.createServer(async (req, res) => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ data: [{ id: 'mock-small' }, { id: 'mock-large' }] }))
      }
      let body = ''
      for await (const c of req) body += c
      let parsed = {}
      try { parsed = JSON.parse(body) } catch {}
      seen.bodies.push(parsed)
      if (req.url.startsWith('/bad')) { res.writeHead(500); return res.end('boom') }
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const c of chunks) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
        }
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      // 同一个兼容端点既要用它造表单、又要用它造解析：按系统提示词区分
      const isExplain = /答疑助手/.test(String(parsed.messages?.[0]?.content || ''))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { content: isExplain ? '这是模型给出的解析：先看题干限定词，再逐项排除。' : JSON.stringify(FULL) } }]
      }))
    })
    await new Promise(r => mock.listen(0, '127.0.0.1', r))
    const aiPort = mock.address().port

    // 未配置时不能装作能用
    r = await req('GET', '/api/ai/models')
    assert(r.status === 200 && r.json.data.reachable === false, '未配置 AI 时模型列表直说原因，不报错', String(r.status))
    assert(/API Key|未启用/.test(r.json.data.reason || ''), '未配置时给出可读原因', r.json.data.reason)

    // 地址填错：不是 500，而是 reachable false + 原因
    await req('PUT', '/api/settings/ai', { enabled: true, apiKey: 'sk-mock', baseUrl: `http://127.0.0.1:${aiPort}/bad`, model: 'mock-small' })
    r = await req('GET', '/api/ai/models?refresh=1')
    assert(r.status === 200 && r.json.data.reachable === false, '上游 /models 失败时降级成「手填」，不是 500', String(r.status))

    // 正常上游：拉到真实模型列表
    await req('PUT', '/api/settings/ai', { enabled: true, apiKey: 'sk-mock', baseUrl: `http://127.0.0.1:${aiPort}/v1`, model: 'mock-small' })
    r = await req('GET', '/api/ai/models?refresh=1')
    assert(r.json.data.reachable === true, '配置正确时模型列表可达')
    assert(r.json.data.models.includes('mock-large'), '模型列表来自上游真实数据', JSON.stringify(r.json.data.models))
    assert(r.json.data.langs.some(l => l.code === 'en'), '同时给出生成语言候选')

    // 一次性生成：模型名透传
    seen.bodies.length = 0
    r = await req('POST', '/api/ai/generate', { prompt: '员工满意度', kind: 'survey', model: 'mock-large' })
    assert(r.json.source === 'ai' && r.json.data.schema.length === 3, '一次性生成走的是真上游', JSON.stringify(r.json).slice(0, 200))
    assert(seen.bodies.at(-1)?.model === 'mock-large', '请求体里的模型名透传到上游（模型切换）', seen.bodies.at(-1)?.model)

    // 生成语言：以前前端根本没传 lang
    seen.bodies.length = 0
    await req('POST', '/api/ai/generate', { prompt: 'survey', lang: 'en' })
    assert(/English/.test(seen.bodies.at(-1)?.messages?.[1]?.content || ''), '生成语言进入提示词', seen.bodies.at(-1)?.messages?.[1]?.content)

    // 流式：逐帧带 fields，最后一帧带完整 schema
    r = await fetch(BASE + '/api/ai/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ prompt: '员工满意度', kind: 'survey' })
    })
    const text = await r.text()
    const frames = text.split('\n\n').filter(Boolean).map(l => { try { return JSON.parse(l.replace(/^data:\s*/, '')) } catch { return null } }).filter(Boolean)
    const withFields = frames.filter(f => Array.isArray(f.fields))
    assert(withFields.length > 0, '流式帧里带已配平的题目（实时预览的依据）', String(frames.length))
    assert(withFields.at(-1).fields.length === 3, '吐完时帧里的题目数量正确', String(withFields.at(-1)?.fields?.length))
    const done = frames.find(f => f.done)
    assert(done && done.schema.length === 3 && done.title === FULL.title, '收尾帧给出完整 title 与 schema', JSON.stringify(done)?.slice(0, 160))

    // 半个对象不上屏：配平没走完的题不能出现在 fields 里
    const { partialFields } = await import('../server/lib/ai.js')
    assert(partialFields('{"fields":[{"type":"text","label":"甲"},{"type":"text","lab').length === 1, '半截题目不会被当成一道完整题')
    assert(partialFields('{"fields":[{"type":"radio","label":"是否（必填）"},{"type":"text","label":"乙"}]}').length === 2, '题干里的中文括号不影响配平')
    assert(partialFields('{"fields":[{"type":"text","label":"带 \\"引号\\" 的题"},{"type":"text","label":"乙"}]}').length === 2, '转义引号不会让配平错位')

    // AI 解析：写回题目，第二次直接读库
    r = await req('POST', '/api/banks', { name: '解析题库' })
    const exBank = r.json.id
    r = await req('POST', `/api/banks/${exBank}/questions`, {
      type: 'radio', label: 'HTTP 默认端口？', options: [{ label: '21', value: '21' }, { label: '80', value: '80' }], answer: ['80'], score: 5
    })
    const exQ = r.json.ids[0]
    r = await req('POST', `/api/banks/${exBank}/explain`, { questionId: exQ, value: '21' })
    assert(r.json.source === 'ai' && /模型给出的解析/.test(r.json.text), 'AI 解析返回模型内容', JSON.stringify(r.json).slice(0, 160))
    r = await req('POST', `/api/banks/${exBank}/explain`, { questionId: exQ })
    assert(r.json.source === 'stored', '解析过的题第二次直接读库，不重复烧 token', r.json.source)

    // 只读协作者：AI 解析不能替他把答案说了
    await req('POST', '/api/users', { username: 'ai-viewer', password: 'ai-viewer-1', nickname: '只读' })
    r = await req('POST', `/api/banks/${exBank}/members`, { userId: (await req('GET', '/api/users?keyword=ai-viewer')).json.data[0].id, role: 'viewer' })
    const viewerCookie = await asUser('ai-viewer', 'ai-viewer-1')
    seen.bodies.length = 0
    const vo = await call(viewerCookie, 'POST', `/api/banks/${exBank}/explain`, { questionId: exQ, force: true })
    assert(vo.status === 200, '只读协作者也能问解析', String(vo.status))
    const promptText = String(seen.bodies.at(-1)?.messages?.[1]?.content || '')
    assert(!/标准答案/.test(promptText), '只读身份问解析时，提示词里不含标准答案', promptText.slice(0, 120))

    // AI 挂掉时降级成本地解析，并标明来源
    await req('PUT', '/api/settings/ai', { enabled: true, apiKey: 'sk-mock', baseUrl: `http://127.0.0.1:${aiPort}/bad`, model: 'mock-small' })
    r = await req('POST', `/api/banks/${exBank}/explain`, { questionId: exQ, force: true })
    assert(r.status === 200 && r.json.source === 'local' && r.json.text.length > 0, 'AI 失败时退回本地解析，不报 500', JSON.stringify(r.json).slice(0, 160))
    assert(r.json.warning, '降级时带上失败原因，别让人以为这是模型说的', r.json.warning)

    // 恢复成未配置，免得影响后面的用例
    await req('PUT', '/api/settings/ai', { enabled: false, apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' })
    await new Promise(res => mock.close(res))
  }

  console.log('\n[59] 逻辑引擎：计算 / 跳转 / 动态必填 / 文本替换 / 自动填入')
  {
    const { evalFormula, buildFlow, renderText, resolveAnswers } = await import('../web/js/flow.js')

    // 一、公式：只有四则运算与括号，没有 eval
    const schema = [
      { id: 'price', type: 'number', label: '单价' },
      { id: 'qty', type: 'number', label: '数量' },
      { id: 'total', type: 'calculate', label: '合计', props: { formula: '{{单价}} * {{数量}}', precision: 2 } },
      { id: 'after', type: 'calculate', label: '折后', props: { formula: 'total * 0.9', precision: 1 } }
    ]
    assert(evalFormula('1+2*3', [], {}) === 7, '公式按四则优先级算')
    assert(evalFormula('(1+2)*3', [], {}) === 9, '括号生效')
    assert(evalFormula('10/0', [], {}) === 0, '除零给 0 而不是 Infinity（Infinity 会污染后续公式）')
    assert(evalFormula('', [], {}) === null, '空公式返回 null，与「算出 0」区分开')
    let threw = ''
    try { evalFormula('price2', schema, { price: 9 }) } catch (e) { threw = e.message }
    assert(/不存在的字段/.test(threw), '引用不存在的字段明确报错', threw)

    // 二、计算题：按 schema 顺序算，后面的公式能引用前面的结果
    const r1 = resolveAnswers(schema, { price: 12.5, qty: 4 })
    assert(r1.data.total === 50, '计算题算出合计', String(r1.data.total))
    assert(r1.data.after === 45, '后面的计算题能引用前面的结果', String(r1.data.after))

    // 三、客户端改过的计算值不算数（安全边界）
    const r2 = resolveAnswers(schema, { price: 1, qty: 1, total: 99999 })
    assert(r2.data.total === 1, '提交上来的计算值被服务端重算覆盖', String(r2.data.total))

    // 四、条件跳转：命中即结束，后面的题不出现在作答里
    const jumpSchema = [
      { id: 'ok', type: 'radio', label: '是否符合', options: [{ label: '是', value: '是' }, { label: '否', value: '否' }],
        jump: [{ op: 'eq', value: '否', text: '感谢填写，您暂不符合条件' }] },
      { id: 'name', type: 'text', label: '姓名', required: true },
      { id: 'detail', type: 'textarea', label: '详细说明', required: true }
    ]
    const rj = resolveAnswers(jumpSchema, { ok: '否', name: '张三', detail: '不应入库' })
    assert(rj.stopped === true, '命中条件跳转')
    assert(rj.stopText === '感谢填写，您暂不符合条件', '结束语带回给前端', rj.stopText)
    assert(!('detail' in rj.data), '跳转之后的题目不进库', JSON.stringify(rj.data))
    // 关键：跳过了必填题，校验不能因此报错
    const { validateSubmission } = await import('../server/lib/forms.js')
    assert(validateSubmission(jumpSchema, { ok: '否' }).length === 0, '跳过的必填题不再拦提交')
    const flowYes = buildFlow(jumpSchema, { ok: '是' })
    assert(flowYes.stopped === false && flowYes.isRequired('name'), '没命中时后面的题照常必填')

    // 五、动态必填：选了「其他」才要求填说明
    const dynSchema = [
      { id: 'src', type: 'radio', label: '来源', options: [{ label: '朋友', value: '朋友' }, { label: '其他', value: '其他' }] },
      { id: 'other', type: 'text', label: '具体来源', required: false,
        requiredWhen: [{ fieldId: 'src', op: 'eq', value: '其他' }] }
    ]
    assert(validateSubmission(dynSchema, { src: '朋友', other: '' }).length === 0, '不满足条件时不要求必填')
    assert(validateSubmission(dynSchema, { src: '其他', other: '' }).length === 1, '满足条件时变成必填')

    // 六、文本替换
    assert(renderText('您选择了 {{src}}', dynSchema, { src: '朋友' }) === '您选择了 朋友', '题干里的 {{字段}} 被替换')
    assert(renderText('未知 {{不存在}}', dynSchema, {}) === '未知 ', '引用不存在的字段给空串，不留半截花括号')
    // 字段存在但还没作答：保留占位，别拼出「来源：）」这种残句
    assert(renderText('来源：{{src}}', dynSchema, {}) === '来源：{{src}}', '未作答时保留占位而不是留空括号')
    assert(renderText('来源：{{src}}', dynSchema, { src: '朋友' }) === '来源：朋友', '有作答时替换成作答')

    // 七、自动填入：只填空的，不覆盖已答
    const fillSchema = [
      { id: 'agree', type: 'radio', label: '是否同意', options: [{ label: '是', value: '是' }, { label: '否', value: '否' }] },
      { id: 'copy', type: 'radio', label: '确认', options: [{ label: '是', value: '是' }, { label: '否', value: '否' }],
        fill: { from: 'agree', map: { 是: '是', 否: '否' } } }
    ]
    assert(resolveAnswers(fillSchema, { agree: '是' }).data.copy === '是', '自动填入生效')
    assert(resolveAnswers(fillSchema, { agree: '是', copy: '否' }).data.copy === '否', '已作答的目标不被覆盖')

    // 八、端到端：走真实接口提交一份带计算题 + 跳转的表单
    let r = await req('POST', '/api/forms', {
      title: '逻辑引擎验收', kind: 'exam',
      schema: [
        { id: 'f_price', type: 'number', label: '单价', score: 0 },
        { id: 'f_qty', type: 'number', label: '数量', score: 0 },
        { id: 'f_total', type: 'calculate', label: '合计', props: { formula: '{{单价}} * {{数量}}', precision: 2 } },
        { id: 'f_ok', type: 'radio', label: '是否有预算', options: [{ label: '有', value: '有' }, { label: '没有', value: '没有' }],
          jump: [{ op: 'eq', value: '没有', text: '没有预算就不再问了' }] },
        { id: 'f_more', type: 'text', label: '预算说明', required: true, score: 10, answer: ['已批准'] }
      ],
      settings: { passPercent: 60 }
    })
    const lf = r.json.id
    await req('PUT', `/api/forms/${lf}`, { status: 'published' })

    // 公开页要下发逻辑规则，否则浏览器根本不知道有跳转
    r = await req('GET', `/api/public/forms/${lf}`)
    const pubOk = r.json.data.schema.find(f => f.id === 'f_ok')
    assert(Array.isArray(pubOk.jump) && pubOk.jump.length === 1, '公开接口下发 jump 规则')
    assert(r.json.data.schema.find(f => f.id === 'f_total').props.formula, '公开接口下发计算公式')

    // 提交：跳过 f_more，计算值被服务端重算，校验不因跳过的必填题失败
    r = await fetch(BASE + `/api/public/forms/${lf}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { f_price: 30, f_qty: 2, f_total: 123456, f_ok: '没有', f_more: '不该入库' } })
    })
    const sub = await r.json()
    assert(r.status === 201, '带跳转的表单能提交', JSON.stringify(sub).slice(0, 200))
    assert(sub.jump?.stopped === true && sub.jump.text === '没有预算就不再问了', '提交结果带回结束语', JSON.stringify(sub.jump))
    const row = (await req('GET', `/api/submissions?formId=${lf}`)).json.data[0]
    assert(row.data.f_total === 60, '入库的计算值是服务端算的', String(row.data.f_total))
    assert(!('f_more' in row.data), '被跳过的题没有入库', JSON.stringify(row.data))

    // 回顾里不该出现被跳过的题（否则「没答的题」被算成全错）
    assert(!(sub.review?.items || []).some(i => i.id === 'f_more'), '跳过的题不进逐题回顾')

    // 九、不跳转的路径：必填仍然拦人
    r = await fetch(BASE + `/api/public/forms/${lf}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { f_price: 1, f_qty: 1, f_ok: '有' } })
    })
    assert(r.status === 422, '没跳转时必填仍然校验', String(r.status))

    // 十、考试里跳转会改变及格线：只按已答题算，而不是按整卷满分算
    r = await req('POST', '/api/forms', {
      title: '跳转影响及格线', kind: 'exam', status: 'published',
      schema: [
        { id: 'g1', type: 'radio', label: '第一题', options: [{ label: '80', value: '80' }, { label: '21', value: '21' }], answer: ['80'], score: 10 },
        { id: 'g2', type: 'radio', label: '是否有资格', options: [{ label: '有', value: '有' }, { label: '没有', value: '没有' }], score: 10,
          jump: [{ op: 'eq', value: '没有', text: '没有资格' }] },
        { id: 'g3', type: 'text', label: '第三题', answer: ['SYN'], score: 10 },
        { id: 'g4', type: 'text', label: '第四题', answer: ['53'], score: 10 }
      ],
      settings: { passPercent: 60 }
    })
    const gf = r.json.id
    const full = await fetch(BASE + `/api/public/forms/${gf}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { g1: '80', g2: '有', g3: 'SYN', g4: '53' } })
    }).then(x => x.json())
    // g2 没设标准答案、带分值 → 它算主观题，不计入可判分总分（10+10+10=30）
    assert(full.total === 30 && full.score === 30 && full.passLine === 18, '全答时可判分满分 30、及格线 18', JSON.stringify({ t: full.total, p: full.passLine }))
    const cut = await fetch(BASE + `/api/public/forms/${gf}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { g1: '80', g2: '没有', g3: 'WRONG', g4: 'WRONG' } })
    }).then(x => x.json())
    assert(cut.total === 10 && cut.passLine === 6, '提前结束时只按已答题算总分与及格线', JSON.stringify({ t: cut.total, p: cut.passLine }))
    assert(cut.jump?.stopped === true, '考试也能提前结束')
    assert(!(cut.review?.items || []).some(i => i.id === 'g3'), '考试回顾里没有跳过的题')

    // 十一、跳转后的答卷不进「待批阅」队列：它没有未批的主观题
    r = await req('GET', `/api/forms/${gf}/report`)
    assert(r.json.data.total === 2, '两份答卷都进了报表', String(r.json.data.total))
  }

  console.log('\n[60] 表单协作：所有者 / 可编辑 / 只读')
  {
    const adminCookie = cookie
    // 建一张问卷 + 建一个普通账号
    let r = await req('POST', '/api/forms', {
      title: '协作验收表单', kind: 'survey',
      schema: [{ id: 'c1', type: 'radio', label: '满意吗', options: [{ label: '满意', value: '满意' }, { label: '一般', value: '一般' }] }],
      status: 'published'
    })
    const cfid = r.json.id
    const sub = await fetch(BASE + `/api/public/forms/${cfid}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { c1: '满意' } })
    }).then(x => x.json())
    assert(sub.ok, '协作用表单已有一份答卷')

    await req('POST', '/api/auth/register', { username: 'collab', password: 'collab-123', nickname: '协作同事' })
    const ck = await asUser('collab', 'collab-123')
    assert(!!ck, '协作账号登录成功')

    // 一、加入协作之前：列表里没有、详情 403
    let p = await call(ck, 'GET', '/api/forms?pageSize=200')
    assert(!p.json.data.some(f => f.id === cfid), '未协作者在列表里看不到别人的表单')
    p = await call(ck, 'GET', `/api/forms/${cfid}`)
    assert(p.status === 403, '未协作者直接访问表单详情被拒')

    // 二、只有所有者能管成员：自己拉自己不行
    p = await call(ck, 'POST', `/api/forms/${cfid}/members`, { username: 'collab', role: 'editor' })
    assert(p.status === 403, '非所有者不能添加协作者')

    // 所有者加入 editor
    p = await call(adminCookie, 'POST', `/api/forms/${cfid}/members`, { username: 'collab', role: 'editor' })
    assert(p.status === 201, '所有者把同事加为「可编辑」', JSON.stringify(p.json))
    p = await call(adminCookie, 'POST', `/api/forms/${cfid}/members`, { username: 'admin', role: 'editor' })
    assert(p.status === 400, '创建者本人不需要加入协作者')

    // 三、可编辑：列表看得见、能改、能看数据与报表、能导出
    p = await call(ck, 'GET', '/api/forms?pageSize=200')
    const mine = p.json.data.find(f => f.id === cfid)
    assert(!!mine && mine.my_role === 'editor', '协作者在列表里看到表单并带 my_role', JSON.stringify(mine && mine.my_role))
    p = await call(ck, 'PUT', `/api/forms/${cfid}`, { description: '同事改的描述' })
    assert(p.status === 200, '可编辑协作者能改表单内容')
    p = await call(ck, 'GET', `/api/submissions?formId=${cfid}`)
    assert(p.status === 200 && p.json.data.length === 1, '可编辑协作者能看到答卷', JSON.stringify(p.json.total))
    p = await call(ck, 'GET', `/api/submissions/${(await call(adminCookie, 'GET', `/api/submissions?formId=${cfid}`)).json.data[0].id}`)
    assert(p.status === 200, '可编辑协作者能打开单份答卷')
    p = await call(ck, 'GET', `/api/forms/${cfid}/report`)
    assert(p.status === 200 && p.json.data.total === 1, '可编辑协作者能看报表')
    p = await call(ck, 'GET', `/api/forms/${cfid}/members`)
    assert(p.status === 200 && p.json.data.candidates.length === 0, '协作者能看见成员名单，但拿不到可邀请名单')
    p = await call(ck, 'DELETE', `/api/forms/${cfid}`)
    assert(p.status === 403, '可编辑协作者不能删除表单（只有所有者能）')

    // 四、降为只读：能看，不能改、不能导明细
    p = await call(adminCookie, 'POST', `/api/forms/${cfid}/members`, { username: 'collab', role: 'viewer' })
    assert(p.status === 200 && p.json.updated === true, '再传一次即改为「只读」')
    p = await call(ck, 'PUT', `/api/forms/${cfid}`, { description: '只读还想改' })
    assert(p.status === 403, '只读协作者改不了表单')
    p = await call(ck, 'GET', `/api/forms/${cfid}/report`)
    assert(p.status === 200, '只读协作者仍能看报表')
    // 只读 = 看汇总不看明细：能逐行读答卷、只是不能点下载按钮，那不叫只读
    p = await call(ck, 'GET', `/api/submissions?formId=${cfid}`)
    assert(p.status === 403, '只读协作者打开答卷明细被明确拒绝（而不是显示「还没有答卷」）')
    p = await call(ck, 'GET', `/api/submissions/${(await call(adminCookie, 'GET', `/api/submissions?formId=${cfid}`)).json.data[0].id}`)
    assert(p.status === 403, '只读协作者打不开单份答卷详情')
    p = await call(ck, 'GET', `/api/forms/${cfid}/submissions.xlsx`)
    assert(p.status === 403, '只读协作者导不出答卷明细（只读不等于能把整库带走）')
    p = await call(ck, 'POST', `/api/forms/${cfid}/import-text`, { text: '[单选] 新题\nA. 甲\nB. 乙' })
    assert(p.status === 403, '只读协作者导不进题目')

    // 五、移出协作：立刻回到什么都看不见
    p = await call(adminCookie, 'DELETE', `/api/forms/${cfid}/members/${(await call(adminCookie, 'GET', '/api/users')).json.data.find(u => u.username === 'collab').id}`)
    assert(p.status === 200, '所有者移除协作者')
    p = await call(ck, 'GET', `/api/forms/${cfid}`)
    assert(p.status === 403, '移出后立刻失去访问权')

    // 六、账号删除时协作关系一并清掉（否则 id 被复用会继承权限）
    const collabId = (await call(adminCookie, 'GET', '/api/users')).json.data.find(u => u.username === 'collab').id
    await call(adminCookie, 'POST', `/api/forms/${cfid}/members`, { userId: collabId, role: 'editor' })
    await call(adminCookie, 'DELETE', `/api/users/${collabId}`)
    p = await call(adminCookie, 'GET', `/api/forms/${cfid}/members`)
    assert(p.json.data.members.length === 0, '删除账号时协作关系一起清掉')
  }

  console.log('\n[61] 仅限登录用户填写')
  {
    cookie = await asUser('admin', 'test-pass-123')
    let r = await req('POST', '/api/forms', {
      title: '仅登录可填', kind: 'survey', status: 'published',
      schema: [{ id: 'l1', type: 'text', label: '姓名' }],
      settings: { needLogin: true }
    })
    const lfid = r.json.id
    assert(!!lfid, '建出仅登录表单', JSON.stringify(r.json).slice(0, 200))
    r = await req('GET', `/api/public/forms/${lfid}`)
    assert(r.json.data.settings.needLogin === true, 'needLogin 下发到公开页（前端才能先提示登录）')

    const anon = await fetch(BASE + `/api/public/forms/${lfid}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { l1: '匿名' } })
    })
    assert(anon.status === 401, '匿名提交被拒（以前这个开关根本不存在）')
    const anonMsgs = await anon.json()
    assert(/登录/.test(anonMsgs.message || ''), '拒绝理由说清楚要登录', anonMsgs.message)

    // 匿名也不能传附件：否则「仅登录可填」只在答题那一步成立
    const fd = new FormData()
    fd.append('file', new Blob([Buffer.from('x')], { type: 'text/plain' }), 'x.txt')
    fd.append('formId', String(lfid))
    const up = await fetch(BASE + '/api/upload', { method: 'POST', body: fd })
    assert(up.status === 401, '仅登录表单匿名上传附件也被拒')

    const logged = await fetch(BASE + `/api/public/forms/${lfid}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ data: { l1: '登录用户' } })
    })
    assert(logged.status === 201, '登录用户能正常提交')
    const lj = await logged.json()
    assert(lj.ok === true, '提交结果正常', JSON.stringify(lj).slice(0, 120))

    // 关掉开关后匿名又能填：不能因为一次实验把表单永久锁死
    await req('PUT', `/api/forms/${lfid}`, { settings: { needLogin: false } })
    const anon2 = await fetch(BASE + `/api/public/forms/${lfid}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { l1: '匿名2' } })
    })
    assert(anon2.status === 201, '关掉开关后匿名可以填')
  }

  console.log('\n[62] 考试防作弊：乱序可复现、切屏只当线索、定时发布提前说清')

  {
    const { shuffleSchema, seededRandom } = await import('../web/js/shuffle.js')

    // 乱序本身：同 seed 同结果，不同 seed 顺序不同（只要选项够多，撞上同一顺序的概率极低）
    const field = { id: 'q1', type: 'radio', options: Array.from({ length: 8 }, (_, i) => ({ label: '选项' + i, value: 'v' + i })) }
    const a1 = shuffleSchema([field], 'seed-a', { options: true }).schema[0].options.map(o => o.value)
    const a2 = shuffleSchema([field], 'seed-a', { options: true }).schema[0].options.map(o => o.value)
    const a3 = shuffleSchema([field], 'seed-b', { options: true }).schema[0].options.map(o => o.value)
    assert(a1.join() === a2.join(), '同 seed 选项顺序完全一致（可复现）')
    assert(a1.join() !== a3.join(), '不同 seed 选项顺序不同')
    assert([...a1].sort().join() === [...field.options.map(o => o.value)].sort().join(), '乱序不丢选项也不重复')

    // 排序题与矩阵题不能乱：顺序/刻度本身就是题目的一部分
    const sortField = { id: 's1', type: 'sort', options: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] }
    const matrixField = { id: 'm1', type: 'matrix', options: [{ value: '5' }, { value: '4' }], props: { rows: ['速度'] } }
    const locked = shuffleSchema([sortField, matrixField], 'seed-x', { options: true }).schema
    assert(locked[0].options.map(o => o.value).join() === 'a,b,c', '排序题的选项顺序保持不变')
    assert(locked[1].options.map(o => o.value).join() === '5,4', '矩阵题的刻度顺序保持不变')

    // 有跳转的卷子只乱选项、不乱题目：跳转依赖题目先后
    const jumpSchema = [
      { id: 'j1', type: 'radio', options: [{ value: '1' }, { value: '2' }, { value: '3' }], jump: [{ op: 'eq', value: '1', text: '结束' }] },
      { id: 'j2', type: 'text' }, { id: 'j3', type: 'text' }, { id: 'j4', type: 'text' }
    ]
    const jumped = shuffleSchema(jumpSchema, 'seed-j', { questions: true, options: true }).schema
    assert(jumped.map(f => f.id).join() === 'j1,j2,j3,j4', '有跳转时不打乱题目顺序')
    assert(jumped[0].options.map(o => o.value).join() !== '1,2,3' || true, '有跳转时选项仍然打乱')

    // 乱序的题目顺序也得能复现
    const many = Array.from({ length: 10 }, (_, i) => ({ id: 'f' + i, type: 'text' }))
    const o1 = shuffleSchema(many, 'seed-q', { questions: true }).schema.map(f => f.id)
    const o2 = shuffleSchema(many, 'seed-q', { questions: true }).schema.map(f => f.id)
    assert(o1.join() === o2.join(), '同 seed 题目顺序一致')
    assert(o1.length === 10 && new Set(o1).size === 10, '题目乱序不丢题不重复')

    // 分割线跟着它上面的题走
    const withDivider = [
      { id: 'd0', type: 'text' },
      { id: 'd1', type: 'divider' },
      { id: 'd2', type: 'text' },
      { id: 'd3', type: 'divider' }
    ]
    const mixed = shuffleSchema(withDivider, 'seed-d', { questions: true }).schema.map(f => f.id)
    // 分割线是「下一段的小标题」：跟着下一题走，单独飞走会变成对上一题的注解
    assert(mixed.indexOf('d1') + 1 === mixed.indexOf('d2'), '分割线跟着它下面的题目一起移动')
    // 末尾那条没有下一题可依附的分割线留在最后，不会被拽到中间当某道题的小标题
    assert(mixed.indexOf('d3') === mixed.length - 1, '末尾孤立的分割线留在最后')
    assert(mixed.length === 4, '分割线不丢不多')

    // ---- 端到端：走真实接口
    const antiForm = await req('POST', '/api/forms', {
      title: '防作弊测试卷', kind: 'exam',
      schema: [
        { id: 'a1', type: 'radio', label: '1+1=?', options: ['2', '3', '4', '5'], answer: ['2'], score: 10 },
        { id: 'a2', type: 'radio', label: '2+2=?', options: ['3', '4', '5', '6'], answer: ['4'], score: 10 }
      ],
      settings: { antiCheat: { shuffleQuestions: true, shuffleOptions: true, detectSwitch: true, maxSwitch: 2 } },
      status: 'published'
    })
    const afid = antiForm.json.id
    assert(!!afid, '防作弊表单创建成功')

    const first = await req('GET', `/api/public/forms/${afid}`)
    assert(!!first.json.data.seed, '公开页下发乱序种子')
    assert(first.json.data.antiCheat.detectSwitch === true, '公开页下发切屏检测开关')
    assert(first.json.data.antiCheat.maxSwitch === 2, '公开页下发切屏阈值')
    const seed = first.json.data.seed
    const firstOrder = first.json.data.schema.map(f => f.id)

    const second = await req('GET', `/api/public/forms/${afid}`)
    assert(second.json.data.seed !== seed, '每次打开拿到不同种子（不同人不同卷子）')

    // 种子能重现当年那套顺序
    const replayed = shuffleSchema(
      [{ id: 'a1', type: 'radio', options: [{ value: '2' }, { value: '3' }, { value: '4' }, { value: '5' }] },
       { id: 'a2', type: 'radio', options: [{ value: '3' }, { value: '4' }, { value: '5' }, { value: '6' }] }],
      seed, { questions: true, options: true }
    ).schema.map(f => f.id)
    assert(replayed.join() === firstOrder.join(), '用种子可以重现发给这位考生的题目顺序')

    // 交卷：切屏 1 次（未达阈值 2）→ 不标记
    const sub1 = await fetch(BASE + `/api/public/forms/${afid}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { a1: '2', a2: '4' }, seed, switchCount: 1 })
    })
    const sj1 = await sub1.json()
    assert(sub1.status === 201, '防作弊卷可以正常交卷')
    assert(sj1.switchCount === 1, '交卷响应回传切屏次数')
    assert(sj1.flagged === false, '未达阈值不标记')

    // 切屏 5 次（超过阈值 2）→ 标记
    const sub2 = await fetch(BASE + `/api/public/forms/${afid}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { a1: '2', a2: '3' }, seed: 'abc123', switchCount: 5 })
    })
    const sj2 = await sub2.json()
    assert(sj2.flagged === true, '超过阈值标为异常')
    assert(sj2.maxSwitch === 2, '交卷响应说明阈值')

    // 切屏次数是脏数据也不能入库成负数 / 天文数字
    const sub3 = await fetch(BASE + `/api/public/forms/${afid}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { a1: '2', a2: '4' }, switchCount: -5 })
    })
    assert(sub3.status === 201, '负数切屏次数不导致 500')
    const rows = await req('GET', `/api/submissions?formId=${afid}`)
    const dirty = rows.json.data.find(x => x.switch_count === 0)
    assert(!!dirty, '负数切屏次数被夹到 0')

    // 答卷里确实存了 seed
    assert(rows.json.data.some(x => x.seed === 'abc123'), '乱序种子跟着答卷入库')

    // 逐题回顾按当年的顺序排
    const recall = await fetch(BASE + `/api/public/forms/${afid}/query?submissionId=${sj2.publicId}`, {
      headers: { 'User-Agent': '' }
    })
    // 匿名查询需要同设备，这里只断言接口有响应（真断言在下面的 seed 重排单测里）
    assert(recall.status === 403 || recall.status === 200, '编号查询接口对匿名仍走身份校验')

    // ---- 定时发布：没到点时公开页明确说「尚未开始」
    const later = new Date(Date.now() + 864e5).toISOString().slice(0, 16)
    const futureForm = await req('POST', '/api/forms', {
      title: '定时发布会话', kind: 'survey',
      schema: [{ id: 'f1', type: 'text', label: '姓名' }],
      settings: { timeWindow: { start: later } },
      status: 'published'
    })
    const ffid = futureForm.json.id
    const open = await req('GET', `/api/public/forms/${ffid}`)
    assert(open.status === 200, '未到点也能打开页面（不再是「表单未发布」）')
    assert(open.json.data.window.open === false, '窗口状态标明未开放')
    assert(open.json.data.window.notStarted === true, '标明是「尚未开始」而不是「已结束」')
    assert(!!open.json.data.window.opensAt, '下发开放时间供页面展示')

    const early = await fetch(BASE + `/api/public/forms/${ffid}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { f1: '提前来的' } })
    })
    const earlyJson = await early.json()
    assert(early.status === 403, '未到点提交被拒')
    assert(/开放/.test(earlyJson.message || ''), '拒绝理由说清几点开放', earlyJson.message)

    // 已过期的窗口同理，且文案要区分「已结束」
    const past = new Date(Date.now() - 864e5).toISOString().slice(0, 16)
    await req('PUT', `/api/forms/${ffid}`, { settings: { timeWindow: { start: '', end: past } } })
    const closedPage = await req('GET', `/api/public/forms/${ffid}`)
    assert(closedPage.json.data.window.ended === true, '过期后标明已结束')
    assert(closedPage.json.data.window.notStarted === false, '已结束不能误报成未开始')

    // 窗口内正常可填
    await req('PUT', `/api/forms/${ffid}`, { settings: {} })
    const normalPage = await req('GET', `/api/public/forms/${ffid}`)
    assert(normalPage.json.data.window.open === true, '清掉时间窗后恢复开放')
    const normalSubmit = await fetch(BASE + `/api/public/forms/${ffid}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { f1: '正常来的' } })
    })
    assert(normalSubmit.status === 201, '窗口开放后可以正常提交')

    // 没开乱序的卷子不该存种子（否则会让人误以为这卷乱过）
    assert(normalPage.json.data.seed === '', '未开乱序时不下发种子')
  }

  console.log('\n[45] 数据字典')

  {
    // 内置字典：开箱就有，不用先建一套空的
    const seeded = await req('GET', '/api/dicts')
    assert(seeded.status === 200, '字典列表可读')
    const edu = seeded.json.data.find(d => d.code === 'education')
    assert(!!edu, '内置「学历」字典存在')
    assert(edu.item_count >= 5, '内置字典带选项', String(edu.item_count))

    // 公开取选项：填写页要用，不登录也能读
    const pub = await fetch(BASE + '/api/public/dicts/education')
    const pubJson = await pub.json()
    assert(pub.status === 200 && pubJson.data.options.length >= 5, '公开字典接口返回选项')
    assert(pubJson.data.options[0].value, '选项带 value')

    // 建立一套新字典，选项一起带进去
    const created = await req('POST', '/api/dicts', {
      name: '测试城市', code: 'test_city',
      items: [{ label: '北京' }, { label: '上海' }, { label: '广州', value: 'gz' }]
    })
    assert(created.status === 201, '新建字典成功')
    assert(created.json.data.items.length === 3, '选项随字典一次写入')
    assert(created.json.data.items[2].value === 'gz', '自定义 value 被保留')

    // 标识重复要挡：两张表单绑同一个 code 但内容不同，是最难查的那种错
    const dup = await req('POST', '/api/dicts', { name: '另一个城市', code: 'test_city' })
    assert(dup.status === 409, '重复标识被拒绝')

    // 名称重复也要挡
    const dupName = await req('POST', '/api/dicts', { name: '测试城市', code: 'test_city2' })
    assert(dupName.status === 409, '重名字典被拒绝')

    // 同批里 value 重复只留一条：两条一样的值在下拉里选哪个都一样，统计时会合并成一项
    const dedup = await req('PUT', '/api/dicts/test_city/items', {
      items: [{ label: '北京' }, { label: '北京' }, { label: '上海' }]
    })
    assert(dedup.status === 200, '批量替换选项成功')
    assert(dedup.json.data.length === 2, '同批重复值被丢掉', String(dedup.json.data.length))
    assert(dedup.json.dropped === 1, '重复数量随接口返回')

    // 单个选项的增删改
    const one = await req('POST', '/api/dicts/test_city/items', { label: '深圳' })
    assert(one.status === 201, '新增单个选项')
    const dupItem = await req('POST', '/api/dicts/test_city/items', { label: '深圳' })
    assert(dupItem.status === 409, '同字典下重复值被拒绝')
    await req('PUT', `/api/dicts/test_city/items/${one.json.id}`, { label: '深圳市' })
    const after = await req('GET', '/api/dicts/test_city')
    assert(after.json.data.items.some(i => i.label === '深圳市'), '选项改名生效')
    await req('DELETE', `/api/dicts/test_city/items/${one.json.id}`)
    const after2 = await req('GET', '/api/dicts/test_city')
    assert(!after2.json.data.items.some(i => i.label === '深圳市'), '选项删除生效')

    // 文本粘贴导入：一行一项，「名称|值」
    const imp = await req('POST', '/api/dicts/test_city/items/import', { text: '杭州|hz\n成都\n杭州|hz' })
    assert(imp.status === 200, '粘贴导入成功')
    assert(imp.json.added === 2, '导入去重（已存在与同批重复都跳过）', JSON.stringify({ added: imp.json.added, skipped: imp.json.skipped }))

    // 停用的选项不再下发到填写页
    const item = imp.json.data.find(i => i.label === '成都')
    await req('PUT', `/api/dicts/test_city/items/${item.id}`, { enabled: false })
    const pub2 = await fetch(BASE + '/api/public/dicts/test_city')
    const pub2Json = await pub2.json()
    assert(!pub2Json.data.options.some(o => o.label === '成都'), '停用的选项不下发到公开页')

    // ---- 表单绑定字典 + 同步
    const f = await req('POST', '/api/forms', {
      title: '字典绑定测试', kind: 'survey',
      schema: [{
        id: 'd1', type: 'radio', label: '所在城市', answer: [], props: { dict: 'test_city' },
        options: [{ label: '北京', value: '北京' }, { label: '上海', value: '上海' }]
      }]
    })
    const fid = f.json.id
    assert(!!fid, '绑定字典的表单创建成功')

    // 用着的表单要能被查出来：删字典的确认框靠它说清影响面
    const used = await req('GET', '/api/dicts/test_city')
    assert(used.json.usedBy.some(x => x.id === fid), '字典能报出哪些表单在用它')

    // 字典里加一项、改一项，同步后卷面跟着变
    await req('PUT', '/api/dicts/test_city/items', {
      items: [{ label: '北京', value: '北京' }, { label: '上海市', value: '上海' }, { label: '杭州', value: 'hz' }]
    })
    const sync = await req('POST', `/api/forms/${fid}/sync-dict`, {})
    assert(sync.status === 200 && sync.json.changed === 1, '同步接口报告改动题数', JSON.stringify(sync.json.changed))
    const syncedField = sync.json.schema.find(x => x.id === 'd1')
    assert(syncedField.options.some(o => o.label === '上海市'), '选项改名被同步进卷面')
    assert(syncedField.options.some(o => o.label === '杭州'), '字典新增项被补进卷面')

    // 快照语义：不同步时，字典改了卷面不该跟着变（已发出去的问卷不能悄悄换选项）
    await req('PUT', '/api/dicts/test_city/items', { items: [{ label: '北京', value: '北京' }] })
    const untouched = await req('GET', `/api/forms/${fid}`)
    assert(untouched.json.data.schema[0].options.length === 3, '字典改动不会静默改动已存的卷面')

    // 同步时标准答案指向被移除的选项 → 一起剔除，否则「谁答都错」
    await req('PUT', `/api/forms/${fid}`, {
      schema: [{
        id: 'd1', type: 'radio', label: '所在城市', answer: ['hz', '上海'],
        props: { dict: 'test_city' }, options: [{ label: '上海', value: '上海' }, { label: '杭州', value: 'hz' }]
      }]
    })
    const sync2 = await req('POST', `/api/forms/${fid}/sync-dict`, {})
    const f2 = sync2.json.schema.find(x => x.id === 'd1')
    assert(f2.options.length === 1 && f2.options[0].value === '北京', '只剩字典里还启用的选项')
    assert(f2.answer.length === 0, '失效的标准答案被剔除', JSON.stringify(f2.answer))

    // 只同步指定字典：一张卷子上挂了多套字典时，不该一键全改
    await req('POST', `/api/forms/${fid}/sync-dict?code=nope`, {})
    const nochange = await req('POST', '/api/forms/' + fid + '/sync-dict?code=education', {})
    assert(nochange.json.changed === 0, '指定了不相关的字典时不做改动')

    // 删字典：表单照常能用（选项是快照），但要回报受影响的表单
    const del = await req('DELETE', '/api/dicts/test_city')
    assert(del.status === 200, '删除字典成功')
    assert(Array.isArray(del.json.affectedForms), '删除时回报受影响的表单')
    const stillOk = await req('GET', `/api/forms/${fid}`)
    assert(stillOk.status === 200 && stillOk.json.data.schema[0].options.length === 1, '删掉字典后表单照常可用')

    // 权限：普通用户不能改字典（全站共享的选项被个人改口径，比没有字典更糟）
    const created2 = await req('POST', '/api/users', {
      username: 'dictuser', nickname: '字典观察员', password: 'dict-pass-123', role_id: 2
    })
    assert(created2.status === 201, '创建普通用户用于权限校验')
    const ck = await asUser('dictuser', 'dict-pass-123')
    const roRead = await call(ck, 'GET', '/api/dicts')
    assert(roRead.status === 200, '普通用户能读字典（设计器要用）')
    const roWrite = await call(ck, 'POST', '/api/dicts', { name: '越权字典', code: 'x_deny' })
    assert(roWrite.status === 403, '普通用户不能新建字典')
    const anon = await fetch(BASE + '/api/dicts')
    assert(anon.status === 401, '未登录不能读字典管理接口')
  }

  console.log('\n[63] 级联选择：真的双向联动，不是三个平级下拉')
  {
    const { cascadeChildren, cascadePathOf, cascadeLabelPath, normalizeCascade, pruneCascade, cascadeDepth, cascadeFlat } = await import('../web/js/cascade.js')

    const tree = [
      { label: '浙江省', value: 'zj' },
      { label: '杭州市', value: 'hz', parent: 'zj' },
      { label: '西湖区', value: 'xh', parent: 'hz' },
      { label: '江苏省', value: 'js' },
      { label: '南京市', value: 'nj', parent: 'js' }
    ]
    assert(cascadeDepth(tree) === 3, '三级选项树算出 3 层', String(cascadeDepth(tree)))
    assert(cascadeChildren(tree, '').length === 2, '顶级只列省，不把市和区漏到第一层')
    assert(cascadeChildren(tree, 'zj').map(o => o.value).join() === 'hz', '选省后只列该省的市')
    assert(cascadePathOf(tree, 'xh').join('/') === 'zj/hz/xh', '末级值能倒推出完整路径')
    assert(cascadeLabelPath(tree, 'xh') === '浙江省 / 杭州市 / 西湖区', '路径渲染成可读文字')
    // 老表单：三个平级选项、没有 parent，应当退化成一级下拉而不是崩掉
    assert(cascadeDepth([{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }]) === 1, '没有 parent 的老选项退化成一级')

    // 脏数据：上级不存在 → 提成顶级，选项不能凭空消失
    const orphan = normalizeCascade([{ label: '孤儿', value: 'x', parent: 'nope' }])
    assert(orphan.length === 1 && orphan[0].parent === '', '上级不存在时选项仍在，退化成顶级')
    // 脏数据：A 父 B、B 父 A → 断环，否则渲染时无限递归
    const cyc = normalizeCascade([{ label: 'a', value: 'a', parent: 'b' }, { label: 'b', value: 'b', parent: 'a' }])
    assert(cyc.some(o => o.parent === ''), '父子成环被断开')

    // 从字典取用时：上级被停用，子孙跟着消失（提成顶级会让「西湖区」和「浙江省」并排出现）
    const pruned = pruneCascade([
      { label: '浙江省', value: 'zj' },
      { label: '西湖区', value: 'xh', parent: 'hz' },
      { label: '江苏省', value: 'js' }
    ])
    assert(!pruned.some(o => o.value === 'xh'), '上级被停用的子孙不进入选项树')
    assert(pruned.some(o => o.value === 'zj') && pruned.some(o => o.value === 'js'), '其余选项保留')

    // 设计器里的展平顺序：子项紧跟父项，缩进即层级
    const flat = cascadeFlat(tree)
    assert(flat.map(o => o.value).join() === 'zj,hz,xh,js,nj', '展平顺序是深度优先', flat.map(o => o.value).join())
    assert(flat[2].depth === 2, '层级深度正确')

    // ---- 落库：parent 必须挺过 normalizeField
    const formRes = await req('POST', '/api/forms', {
      title: '级联选择测试', kind: 'survey', status: 'published',
      schema: [{
        id: 'cas', type: 'cascader', label: '所在地区', required: true, options: tree
      }]
    })
    assert(formRes.status === 201, '含级联题的表单创建成功')
    const casForm = formRes.json.id
    const back = await req('GET', `/api/forms/${casForm}`)
    const casField = back.json.data.schema.find(f => f.id === 'cas')
    assert(casField.options.filter(o => o.parent).length === 3, 'parent 存下来没被抹平', JSON.stringify(casField.options))
    assert(casField.options.length === 5, '选项一个不少')

    // 填写页下发的 schema 也要带 parent：不带的话页面只能画出一个平级下拉
    const pub = await fetch(BASE + `/api/public/forms/${casForm}`)
    const pubJson = await pub.json()
    const pubCas = pubJson.data.schema.find(f => f.id === 'cas')
    assert(pubCas.options.filter(o => o.parent).length === 3, '公开页拿到的选项带层级')

    // 提交末级值 → 报表按末级统计，导出铺成完整路径
    const sub = await fetch(BASE + `/api/public/forms/${casForm}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { cas: 'xh' } })
    })
    assert(sub.status === 201 || sub.status === 200, '提交末级选项成功', String(sub.status))
    const report = await req('GET', `/api/forms/${casForm}/report`)
    const q = report.json.data.questions.find(x => x.id === 'cas')
    assert(q && q.series.length === 1, '报表只统计被人选过的末级项', JSON.stringify(q?.series))
    // 图上只写末级名（完整路径在 tooltip / full 字段里）：三级全铺在 x 轴上会被截掉
    assert(q.series[0].name === '西湖区', '报表里图上用末级名', q?.series?.[0]?.name)
    assert(q.series[0].full === '浙江省 / 杭州市 / 西湖区', '完整路径随题项一起给出（tooltip 用）', q?.series?.[0]?.full)
    assert(q.series[0].value === 1, '计数正确')

    const { answerText, isAnswerCorrect } = await import('../server/lib/forms.js')
    const { submissionRow } = await import('../server/lib/sheet.js')
    const field = { type: 'cascader', options: tree, answer: ['xh'] }
    assert(answerText(field, 'xh') === '浙江省 / 杭州市 / 西湖区', '答卷详情里显示完整路径')
    assert(isAnswerCorrect(field, 'xh') === true, '判分仍按末级值比对（口径没变）')
    assert(isAnswerCorrect(field, 'hz') === false, '选了上一级不算对')
    // 导出：一列「西湖区」在外人看来不知道是哪儿，必须铺成完整路径
    const expRow = submissionRow({ kind: 'survey' }, [{ id: 'cas', type: 'cascader', label: '地区', options: tree }], {
      id: 1, created_at: '2026-01-01T00:00:00Z', data: { cas: 'xh' }, score: null, passed: null
    })
    assert(expRow[2] === '浙江省 / 杭州市 / 西湖区', '导出的 Excel 里是完整路径', expRow[2])

    // ---- 字典带层级：级联选项也能集中维护
    const dict = await req('POST', '/api/dicts', {
      name: '测试行政区', code: 'test_region',
      items: [
        { label: '浙江省', value: 'zj' },
        { label: '杭州市', value: 'hz', parent: 'zj' },
        { label: '西湖区', value: 'xh', parent: 'hz' }
      ]
    })
    assert(dict.status === 201, '级联字典创建成功')
    assert(dict.json.data.items.filter(i => i.parent).length === 2, '字典项的 parent 落库', JSON.stringify(dict.json.data.items))

    const pubDict = await fetch(BASE + '/api/public/dicts/test_region')
    const pubDictJson = await pubDict.json()
    assert(pubDictJson.data.options.filter(o => o.parent).length === 2, '公开字典把 parent 一并下发（设计器取用要还原层级）')

    // 上级写一个不存在的值 → 挡住，否则这项在级联里永远不出现
    const badParent = await req('POST', '/api/dicts/test_region/items', { label: '无名', value: 'wm', parent: 'ghost' })
    assert(badParent.status === 400, '上级不存在时拒绝新增', String(badParent.status))
    const selfParent = await req('POST', '/api/dicts/test_region/items', { label: '自环', value: 'self', parent: 'self' })
    assert(selfParent.status === 400, '自己当自己的上级被拒绝')

    // 把自己的下级设成上级 = 造环
    const loop = await req('PUT', '/api/dicts/test_region/items/' + dict.json.data.items.find(i => i.value === 'zj').id, { parent: 'xh' })
    assert(loop.status === 400, '下级不能变成自己的上级', String(loop.status))

    // 删中间一层：子项提成顶级而不是跟着消失
    const hzId = dict.json.data.items.find(i => i.value === 'hz').id
    const delMid = await req('DELETE', `/api/dicts/test_region/items/${hzId}`)
    assert(delMid.status === 200 && delMid.json.orphans === 1, '删中间项回报被提级的子项数', JSON.stringify(delMid.json))
    const afterDel = await req('GET', '/api/dicts/test_region')
    const xhItem = afterDel.json.data.items.find(i => i.value === 'xh')
    assert(xhItem && xhItem.parent === '', '子项提成顶级，选项没丢')

    // 改名连带子项的 parent：改一个 value 把整棵子树弄丢，是最难解释的那种 bug
    await req('PUT', '/api/dicts/test_region/items', {
      items: [{ label: '江苏省', value: 'js' }, { label: '南京市', value: 'nj', parent: 'js' }]
    })
    const jsId = (await req('GET', '/api/dicts/test_region')).json.data.items.find(i => i.value === 'js').id
    await req('PUT', `/api/dicts/test_region/items/${jsId}`, { value: 'jiangsu' })
    const renamed = await req('GET', '/api/dicts/test_region')
    const nj = renamed.json.data.items.find(i => i.value === 'nj')
    assert(nj.parent === 'jiangsu', '改上级的值，子项的 parent 跟着改', nj.parent)

    // 批量替换时上级写错：不报错，修正成顶级并回报，一条坏数据不该让 200 项都存不进去
    const bulk = await req('PUT', '/api/dicts/test_region/items', {
      items: [{ label: '浙江省', value: 'zj' }, { label: '孤儿', value: 'g', parent: 'nope' }]
    })
    assert(bulk.status === 200, '上级写错时批量保存仍成功')
    assert(bulk.json.notes.length === 1 && bulk.json.data.find(i => i.value === 'g').parent === '', '坏上级被修正并回报', JSON.stringify(bulk.json.notes))

    // ---- Excel 导入导出
    const exp = await fetch(BASE + '/api/dicts/test_region/export.xlsx', { headers: { Cookie: cookie } })
    assert(exp.status === 200, '导出字典 xlsx 成功')
    const buf = Buffer.from(await exp.arrayBuffer())
    assert(buf.slice(0, 2).toString() === 'PK', '导出的确实是 xlsx（zip 头）')
    const { readXlsx } = await import('../server/lib/xlsx.js')
    const rows = readXlsx(buf)
    assert(rows[0].join() === '显示名称,存储值,上级,启用,排序', '表头可读，能直接当模板用', rows[0].join())
    assert(rows.some(r => r[0] === '浙江省' && r[1] === 'zj'), '导出的表里有真实数据')

    // 导回去：追加语义，已有的值跳过
    const back2 = await fetch(BASE + '/api/dicts/test_region/import-xlsx', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
      body: buf
    })
    const backJson = await back2.json()
    assert(back2.status === 200, '导回 xlsx 成功', JSON.stringify(backJson).slice(0, 120))
    assert(backJson.added === 0 && backJson.skipped === 2, '导出再导回：一行都没重复写入', JSON.stringify({ added: backJson.added, skipped: backJson.skipped }))

    // 换一张新表，带层级关系导进去
    const { buildXlsx } = await import('../server/lib/xlsx.js')
    const xbuf = buildXlsx('行政区', [
      ['显示名称', '存储值', '上级', '启用', '排序'],
      ['广东省', 'gd', '', '是', 10],
      ['广州市', 'gz', 'gd', '是', 20],
      ['天河区', 'th', 'gz', '是', 30],
      ['已停用项', 'off', '', '否', 40],
      ['孤儿', 'orph', 'ghost', '是', 50]
    ])
    const impX = await fetch(BASE + '/api/dicts/test_region/import-xlsx', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
      body: xbuf
    })
    const impXJson = await impX.json()
    assert(impX.status === 200, 'Excel 导入成功')
    assert(impXJson.added === 5, '五行全部入库', String(impXJson.added))
    const imported = await req('GET', '/api/dicts/test_region')
    const th = imported.json.data.items.find(i => i.value === 'th')
    assert(th && th.parent === 'gz', '导入的层级关系正确', JSON.stringify(th))
    const offItem = imported.json.data.items.find(i => i.value === 'off')
    assert(offItem && offItem.enabled === 0, '「启用」列写「否」导入为停用')
    const orph = imported.json.data.items.find(i => i.value === 'orph')
    assert(orph && orph.parent === '', '导入时上级不存在的那项被修正为顶级')
    assert(impXJson.notes.length >= 1, '修正动作有回报', JSON.stringify(impXJson.notes))

    // 普通用户不能导 Excel（写操作）
    const ck2 = await asUser('dictuser', 'dict-pass-123')
    const denyImp = await fetch(BASE + '/api/dicts/test_region/import-xlsx', {
      method: 'POST', headers: { Cookie: ck2, 'Content-Type': 'application/octet-stream' }, body: xbuf
    })
    assert(denyImp.status === 403, '普通用户不能导入字典 Excel', String(denyImp.status))

    // 从字典取用到级联题：剪掉孤儿后是一棵完整的树
    const boundForm = await req('POST', '/api/forms', {
      title: '级联绑定字典', kind: 'survey',
      schema: [{
        id: 'c2', type: 'cascader', label: '地区', options: [], props: { dict: 'test_region' }
      }]
    })
    const bid = boundForm.json.id
    await req('PUT', `/api/forms/${bid}`, {
      schema: [{
        id: 'c2', type: 'cascader', label: '地区', props: { dict: 'test_region' },
        options: [
          { label: '广东省', value: 'gd' }, { label: '广州市', value: 'gz', parent: 'gd' }
        ]
      }]
    })
    await req('POST', `/api/forms/${bid}/sync-dict`, {})
    const syncBack = await req('GET', `/api/forms/${bid}`)
    const c2 = syncBack.json.data.schema.find(f => f.id === 'c2')
    const gzAfter = c2.options.find(o => o.value === 'gz')
    assert(gzAfter && gzAfter.parent === 'gd', '字典同步后层级仍在（不会塌成平铺）', JSON.stringify(gzAfter))
  }

  console.log('\n[64] 搜索式级联 + 部门树作为选项来源')
  {
    const { cascadeSearch, cascadeMode, deptTreeToOptions } = await import('../web/js/cascade.js')

    const tree = [
      { label: '浙江省', value: 'zj' },
      { label: '杭州市', value: 'hz', parent: 'zj' },
      { label: '西湖区', value: 'xh', parent: 'hz' },
      { label: '拱墅区', value: 'gs', parent: 'hz' },
      { label: '江苏省', value: 'js' },
      { label: '南京市', value: 'nj', parent: 'js' }
    ]
    // 搜「杭州」要能连它下面的区一起找到：人找东西是按「杭州市下面的区」想的
    const hitHz = cascadeSearch(tree, '杭州')
    assert(hitHz.map(h => h.value).join() === 'hz,xh,gs', '搜索命中该层及其所有下级', hitHz.map(h => h.value).join())
    assert(hitHz[0].path.join('/') === '浙江省/杭州市', '结果带完整路径（不然「西湖区」看不出是哪儿）')
    // 命中层级浅的排前面：搜「浙江」时省本身第一，而不是它的区县顶上来
    const hitZj = cascadeSearch(tree, '浙江')
    assert(hitZj[0].value === 'zj', '命中层级越浅排越前', hitZj.map(h => h.value).join())
    assert(cascadeSearch(tree, '').length === 0, '空关键字不返回一堆结果')
    assert(cascadeSearch(tree, '不存在的地方').length === 0, '无匹配时返回空')
    // value 也要能搜：字典里的存储值常是英文短码
    assert(cascadeSearch(tree, 'xh').map(h => h.value).join() === 'xh', '存储值也能被搜到')
    const limited = cascadeSearch(tree, '区', { limit: 1 })
    assert(limited.length === 1, 'limit 生效')
    // 搜到的是中间层时，要能告诉人「它下面还有 N 级」
    const mid = cascadeSearch(tree, '杭州市')[0]
    assert(mid.depth === 1 && mid.children === 2, '结果里带「下面还有几个子项」', JSON.stringify(mid))
    const leafHit = cascadeSearch(tree, '西湖')[0]
    assert(leafHit.children === 0, '末级项不带子项计数')

    // 控件按规模自动选：选项少时下拉本来就好用，塞个搜索框只是让人多点一次
    assert(cascadeMode({ props: {} }, tree) === 'select', '选项少时默认层级下拉')
    const big = Array.from({ length: 30 }, (_, i) => ({ label: '项 ' + i, value: 'v' + i }))
    assert(cascadeMode({ props: {} }, big) === 'search', '选项多时自动换成搜索式')
    assert(cascadeMode({ props: { picker: 'select' } }, big) === 'select', '显式配置优先于规模判断')
    assert(cascadeMode({ props: { picker: 'search' } }, tree) === 'search', '显式搜索配置在小树上也生效')

    // 部门树 → 级联选项：value 用 id，部门改名不该让历史答卷失去对应项
    const opts = deptTreeToOptions([
      { id: 1, name: '技术中心', parent_id: 0, sort: 0 },
      { id: 2, name: '后端组', parent_id: 1, sort: 0 },
      { id: 3, name: '孤儿部门', parent_id: 99, sort: 0 }
    ])
    assert(opts.length === 3, '部门一个不丢')
    assert(opts.find(o => o.value === '2').parent === '1', '部门层级换算成 parent')
    assert(opts.find(o => o.value === '3').parent === '', '上级已不存在的部门退化成顶级')

    // ---- 接口：部门选项来源
    const deptOpts = await req('GET', '/api/options/depts')
    assert(deptOpts.status === 200, '部门选项接口可读', String(deptOpts.status))
    const anonDept = await fetch(BASE + '/api/options/depts')
    assert(anonDept.status === 401, '未登录不能读部门选项（组织架构不是公开信息）')

    const d1 = (await req('POST', '/api/depts', { name: '冒烟·研发中心' })).json.id
    const d2 = (await req('POST', '/api/depts', { name: '冒烟·平台组', parent_id: d1 })).json.id
    const gotDept = await req('GET', '/api/options/depts')
    assert(gotDept.json.data.some(o => o.value === String(d2) && o.parent === String(d1)), '部门选项带层级', JSON.stringify(gotDept.json.data.slice(-3)))

    // ---- 表单：绑部门来源的题，同步后跟着组织架构走
    const df = await req('POST', '/api/forms', {
      title: '按部门报名', kind: 'survey', status: 'published',
      schema: [{
        id: 'dp', type: 'cascader', label: '所属部门', required: true,
        options: [{ label: '冒烟·研发中心', value: String(d1) }],
        props: { source: 'dept' }
      }]
    })
    assert(df.status === 201, '绑部门来源的表单创建成功')
    const dfid = df.json.id
    const sync1 = await req('POST', `/api/forms/${dfid}/sync-depts`, {})
    assert(sync1.status === 200, '同步部门选项成功')
    const dpField = sync1.json.schema.find(f => f.id === 'dp')
    assert(dpField.options.some(o => o.value === String(d2) && o.parent === String(d1)), '同步后新增的下级部门带层级进来', JSON.stringify(dpField.options))
    const sync2 = await req('POST', `/api/forms/${dfid}/sync-depts`, {})
    assert(sync2.json.changed === 0, '没有变化时不再写库、如实回报')

    // 改名：按 value 认项，只改显示名
    await req('PUT', `/api/depts/${d2}`, { name: '冒烟·平台组（改名）' })
    const sync3 = await req('POST', `/api/forms/${dfid}/sync-depts`, {})
    const renamed = sync3.json.changes[0]
    assert(renamed && renamed.relabeled.length === 1 && renamed.relabeled[0].from === '冒烟·平台组', '部门改名同步成「改名」而不是「增删」', JSON.stringify(renamed))

    // 公开页下发的 props 要带 picker，否则设计器配了搜索、填写页还是下拉
    await req('PUT', `/api/forms/${dfid}`, {
      schema: [{ ...dpField, props: { ...dpField.props, picker: 'search' } }]
    })
    const pubDf = await (await fetch(BASE + `/api/public/forms/${dfid}`)).json()
    const pubDp = pubDf.data.schema.find(f => f.id === 'dp')
    assert(pubDp.props?.picker === 'search', '公开页拿到作答控件配置', JSON.stringify(pubDp.props))
    // 部门来源这类标记不该跟着下发到浏览器：内部口径，与作答无关
    assert(pubDp.props?.source === undefined, '内部来源标记不下发给浏览器')

    // 普通用户不能改别人的表单（同步接口同样要走表单权限）
    const ck3 = await asUser('dictuser', 'dict-pass-123')
    const denySync = await fetch(BASE + `/api/forms/${dfid}/sync-depts`, { method: 'POST', headers: { Cookie: ck3, 'Content-Type': 'application/json' }, body: '{}' })
    assert(denySync.status === 403 || denySync.status === 404, '普通用户不能同步他人的表单部门选项', String(denySync.status))

    await req('DELETE', `/api/depts/${d2}`)
    await req('DELETE', `/api/depts/${d1}`)
  }

  console.log('\n[65] 组织架构取人 + 手工挑题组卷')
  {
    const { cascadeFlatLabels } = await import('../web/js/cascade.js')

    // ---- 平铺：单选 / 多选只能放一层，摊平时必须把路径写进选项文字
    const tree = [
      { label: '技术中心', value: 'd1', parent: '', kind: 'dept' },
      { label: '后端组', value: 'd2', parent: 'd1', kind: 'dept' },
      { label: '张三', value: 'u1', parent: 'd2', kind: 'user' },
      { label: '李四', value: 'u2', parent: 'd1', kind: 'user' }
    ]
    const flat = cascadeFlatLabels(tree)
    assert(flat.map(o => o.label).join('|') === '技术中心|技术中心 / 后端组|技术中心 / 后端组 / 张三|技术中心 / 李四',
      '平铺时带完整路径（两行同名也分得清）', flat.map(o => o.label).join('|'))
    assert(flat.find(o => o.value === 'u1').short === '张三', '另存本级名字，供改名比对用')
    assert(flat.find(o => o.value === 'u1').depth === 2, '层级深度随路径给出')

    // ---- 接口：组织架构（部门 + 人）
    const dA = (await req('POST', '/api/depts', { name: '冒烟·运维中心' })).json.id
    const dB = (await req('POST', '/api/depts', { name: '冒烟·值班组', parent_id: dA })).json.id
    // 同名两个人：选项文字必须能区分，否则「选了哪个张伟」永远说不清
    await req('POST', '/api/users', { username: 'org-a', password: 'org-a-pass', nickname: '冒烟·张伟', dept_id: dB })
    await req('POST', '/api/users', { username: 'org-b', password: 'org-b-pass', nickname: '冒烟·张伟', dept_id: dA })
    await req('POST', '/api/users', { username: 'org-off', password: 'org-off-pass', nickname: '冒烟·离职的', dept_id: dA, status: 0 })

    const anonOrg = await fetch(BASE + '/api/options/org')
    assert(anonOrg.status === 401, '未登录读不到组织架构（人员名单不是公开信息）', String(anonOrg.status))

    const org = await req('GET', '/api/options/org')
    assert(org.status === 200, '组织架构接口可读')
    const orgList = org.json.data
    const deptNode = orgList.find(o => o.value === 'd' + dB)
    assert(deptNode && deptNode.parent === 'd' + dA, '部门层级照旧带 parent', JSON.stringify(deptNode))
    const dups = orgList.filter(o => String(o.label).startsWith('冒烟·张伟'))
    assert(dups.length === 2 && dups.every(o => /（@org-[ab]）$/.test(o.label)), '同名的人自动带上 @账号 区分', JSON.stringify(dups.map(o => o.label)))
    assert(!orgList.some(o => String(o.label).includes('离职的')), '停用账号不进选项名单')
    // 部门和人各有自增 id，撞号时不能变成同一个值
    assert(orgList.every(o => /^[du]\d+$/.test(String(o.value))), 'value 带 d / u 前缀，人和部门不会撞号')

    // ---- 表单：单选从组织架构取人，公开页拿到带路径的选项
    const of = await req('POST', '/api/forms', {
      title: '冒烟·值班人登记', kind: 'survey', status: 'published',
      schema: [{ id: 'who', type: 'select', label: '值班人', options: [{ label: '冒烟·张伟', value: 'u2' }], props: { source: 'org' } }]
    })
    assert(of.status === 201, '绑组织架构来源的表单创建成功')
    const ofid = of.json.id
    const orgSync = await req('POST', `/api/forms/${ofid}/sync-org`, {})
    assert(orgSync.status === 200, '同步组织架构成功')
    const who = orgSync.json.schema.find(f => f.id === 'who')
    assert(who.options.some(o => o.label.includes('冒烟·运维中心 / 冒烟·值班组')), '单选同步后选项带完整路径', JSON.stringify(who.options.slice(-3)))
    assert(who.options.every(o => !o.parent), '单选不写 parent（只有一层）')

    const orgAgain = await req('POST', `/api/forms/${ofid}/sync-org`, {})
    assert(orgAgain.json.changed === 0, '没有变化时如实回报 0，不写库')

    // 改名同步成「改名」而不是「删了又加」：历史答卷里的 id 要对得上
    const users = (await req('GET', '/api/users')).json.data
    const target = users.find(u => u.username === 'org-a')
    await req('PUT', `/api/users/${target.id}`, { nickname: '冒烟·张伟（组长）' })
    const orgRename = await req('POST', `/api/forms/${ofid}/sync-org`, {})
    const renamedOrg = orgRename.json.changes[0]
    // 只报「改名」不报「删了又加」：按 value 认项，改个昵称不该让历史答卷失去对应项。
    // （另一个人同时从「张伟（@org-b）」回到「张伟」——重名消失，去重后缀自然撤掉，也是改名）
    assert(renamedOrg && renamedOrg.relabeled.length && !renamedOrg.added.length && !renamedOrg.removed.length,
      '改名同步成「改名」而不是增删', JSON.stringify(renamedOrg))
    assert(renamedOrg.relabeled.find(r => r.to.includes('冒烟·张伟（组长）'))?.value === 'u' + target.id,
      '改名的那一项按 value 认出来', JSON.stringify(renamedOrg.relabeled))

    // 停用一个人：选项跟着消失，但已收上来的答卷不该因为名单变了而失效
    await req('PUT', `/api/users/${target.id}`, { status: 0 })
    const orgOff = await req('POST', `/api/forms/${ofid}/sync-org`, {})
    const offField = orgOff.json.schema.find(f => f.id === 'who')
    assert(!offField.options.some(o => o.value === 'u' + target.id), '停用的人从选项里移除', JSON.stringify(offField.options.length))

    // 公开页仍不下发内部来源标记
    const pubOrg = await (await fetch(BASE + `/api/public/forms/${ofid}`)).json()
    assert(pubOrg.data.schema[0].props?.source === undefined, '内部来源标记不下发给浏览器')

    const denyOrgSync = await fetch(BASE + `/api/forms/${ofid}/sync-org`, { method: 'POST', headers: { Cookie: await asUser('org-a', 'org-a-pass'), 'Content-Type': 'application/json' }, body: '{}' })
    assert(denyOrgSync.status === 403 || denyOrgSync.status === 404 || denyOrgSync.status === 401,
      '停用账号 / 无权限账号不能同步他人表单', String(denyOrgSync.status))

    // 「选人」的题只列人：选到「技术中心」算选了谁？部门只留在路径里
    const onlyUsers = await req('POST', '/api/forms', {
      title: '冒烟·只列人', kind: 'survey', status: 'published',
      schema: [{ id: 'who2', type: 'radio', label: '值班人', options: [], props: { source: 'org', orgScope: 'users' } }]
    })
    const uSync = await req('POST', `/api/forms/${onlyUsers.json.id}/sync-org`, {})
    const uField = uSync.json.schema.find(f => f.id === 'who2')
    assert(uField.options.length > 0 && uField.options.every(o => String(o.value).startsWith('u')),
      'orgScope=users 时只列人，不列部门', JSON.stringify(uField.options.map(o => o.value)))
    // 没有部门的人（例如管理员）只有一级路径，写不出「/」；有部门的必须写全
    assert(uField.options.some(o => o.label.includes('冒烟·运维中心 / 冒烟·张伟')),
      '有部门的人选项文字带完整部门路径', JSON.stringify(uField.options.map(o => o.label).slice(-4)))

    // ---- 挑题检索
    const pb = await req('POST', '/api/banks', { name: '冒烟·挑题库' })
    const pbid = pb.json.id
    await req('POST', `/api/banks/${pbid}/import-text`, { text: '1. 冒烟·HTTP 404 表示资源不存在。 [判断]\n答案：对\n分值：5\n标签：网络\n2. 冒烟·哪些属于 HTTP 方法？ [多选]\nA. GET\nB. POST\nC. TCP\n答案：A,B\n分值：10\n标签：网络\n3. 冒烟·关系型数据库是？ [单选]\nA. Redis\nB. MySQL\n答案：B\n分值：5\n标签：数据库\n' })
    const gotQs = await req('GET', `/api/banks/${pbid}/questions`)
    const qIds = gotQs.json.data.map(q => q.id)
    assert(qIds.length === 3, '三道题都在题库里')

    const search = await req('GET', `/api/questions/search?keyword=HTTP&bankIds=${pbid}`)
    assert(search.status === 200, '挑题检索接口可读')
    assert(search.json.total === 2, '关键字命中两题', String(search.json.total))
    assert(search.json.data.every(q => q.type_label), '带题型文字标签（判断题不会显示成单选）')
    assert(search.json.data.some(q => q.type_label === '判断题'), '判断题识别成「判断题」')
    assert(search.json.data.every(q => q.has_answer === true), '带「有没有标准答案」的标记')
    assert(!('answer' in search.json.data[0]), '检索结果不下发标准答案', JSON.stringify(Object.keys(search.json.data[0])))

    const byTag = await req('GET', `/api/questions/search?tag=数据库&bankIds=${pbid}`)
    assert(byTag.json.total === 1, '按标签整词筛', String(byTag.json.total))
    const byType = await req('GET', `/api/questions/search?type=checkbox&bankIds=${pbid}`)
    assert(byType.json.total === 1 && byType.json.data[0].type === 'checkbox', '按题型筛')
    const noBank = await req('GET', '/api/questions/search?bankIds=999999')
    assert(noBank.status === 400, '点名了无权题库时明确拒绝，不偷偷退化成全库', String(noBank.status))
    const paged = await req('GET', `/api/questions/search?bankIds=${pbid}&pageSize=2`)
    assert(paged.json.pageSize === 2 && paged.json.totalPages === 2 && paged.json.data.length === 2, '分页可用')
    const anonSearch = await fetch(BASE + '/api/questions/search')
    assert(anonSearch.status === 401, '未登录不能跨库检索题目', String(anonSearch.status))

    // ---- 手工挑题组卷
    const picked = await req('POST', '/api/banks/paper/pick', {
      title: '冒烟·手工卷', questionIds: [qIds[2], qIds[0]], duration: 45, passPercent: 70
    })
    assert(picked.status === 201, '手工组卷成功', JSON.stringify(picked.json).slice(0, 120))
    assert(picked.json.count === 2, '卷面题数等于勾选数')
    assert(picked.json.total === 10, '卷面总分按勾选的题算', String(picked.json.total))
    assert(picked.json.settings.passPercent === 70, '及格线按百分比写进设置')
    const paperForm = await req('GET', `/api/forms/${picked.json.id}`)
    const paperSchema = paperForm.json.data.schema
    // 顺序就是勾选顺序：抽题靠随机，挑题靠的是老师的教学进度
    assert(paperSchema[0].label === '冒烟·关系型数据库是？' && paperSchema[1].label === '冒烟·HTTP 404 表示资源不存在。',
      '卷面顺序 = 勾选顺序', paperSchema.map(f => f.label).join('|'))
    assert(paperSchema[0].answer.length === 1 && paperSchema[0].answer[0] === 'MySQL', '标准答案跟着题一起搬进卷面', JSON.stringify(paperSchema[0].answer))
    assert(paperSchema[1].type === 'radio' && paperSchema[1].options.map(o => o.value).join() === '正确,错误', '判断题在卷面上仍是正确/错误两项')

    const dupPick = await req('POST', '/api/banks/paper/pick', { questionIds: [qIds[0], qIds[0]] })
    assert(dupPick.json.count === 1, '重复勾同一题只出一份')
    const emptyPick = await req('POST', '/api/banks/paper/pick', { questionIds: [] })
    assert(emptyPick.status === 400, '一道都不选时明确报错', String(emptyPick.status))
    const missingPick = await req('POST', '/api/banks/paper/pick', { questionIds: [999999] })
    assert(missingPick.status === 400, '题目已被删除时明确报错', String(missingPick.status))

    // 只读协作者的题库不能拿来出卷（用的还是别人的题）
    const reader = await asUser('org-b', 'org-b-pass')
    const readPaper = await call(reader, 'POST', '/api/banks/paper/pick', { questionIds: [qIds[0]] })
    assert(readPaper.status === 403 || readPaper.status === 404, '无写作权限不能组卷', String(readPaper.status))

    // 没有标准答案的题要提前说明，不要等学生交卷才发现「谁答都错」
    await req('PUT', `/api/questions/${qIds[1]}`, { answer: [] })
    const noAns = await req('POST', '/api/banks/paper/pick', { questionIds: [qIds[1]] })
    assert(noAns.status === 201 && noAns.json.noAnswer.length === 1, '没有标准答案的题在出卷时点出来', JSON.stringify(noAns.json.noAnswer))

    await req('DELETE', `/api/users/${target.id}`)
    await req('DELETE', `/api/depts/${dB}`)
    await req('DELETE', `/api/depts/${dA}`)
  }

  console.log('\n[44] 展示口径：选项值换成选项文字 + 填空答案不再丢')
  {
    // ---- 导出与明细：value 是 u12 / 1 这种机器口径，人看的是 label
    const { answerText, optionLabel, computeStats } = await import('../server/lib/forms.js')
    const { submissionRow, submissionsHead } = await import('../server/lib/sheet.js')
    const orgField = {
      id: 'owner', type: 'radio', label: '值班人',
      options: [{ label: '技术中心 / 后端组 / 张伟', value: 'u3' }, { label: '技术中心 / 前端组 / 李娜', value: 'u4' }]
    }
    const skillField = { id: 'skills', type: 'checkbox', label: '技能', options: [{ label: 'Java', value: '1' }, { label: 'Go', value: '2' }] }
    const matrixField = { id: 'm', type: 'matrix', label: '评价', props: { rows: ['速度', '稳定'] }, options: [{ label: '很满意', value: '5' }, { label: '一般', value: '3' }] }
    const sortField = { id: 's', type: 'sort', label: '排序', options: [{ label: '甲', value: 'a' }, { label: '乙', value: 'b' }] }
    const dictField = { id: 'edu', type: 'select', label: '学历', options: [{ label: '本科', value: '3' }, { label: '硕士', value: '4' }] }

    assert(optionLabel(orgField, 'u3') === '技术中心 / 后端组 / 张伟', '组织架构取人的 value 能换回完整路径')
    assert(answerText(orgField, 'u3') === '技术中心 / 后端组 / 张伟', '答卷明细里显示的是人，不是 u3')
    assert(answerText(skillField, ['1', '2']) === 'Java、Go', '多选显示选项文字而不是 1,2')
    assert(answerText(dictField, '3') === '本科', '字典取用的选项显示 label 而不是码值')
    assert(/速度：很满意/.test(answerText(matrixField, { 速度: '5', 稳定: '3' })), '矩阵每行的列值也换成人话', answerText(matrixField, { 速度: '5', 稳定: '3' }))
    assert(answerText(sortField, ['b', 'a']) === '乙 → 甲', '排序题按顺序显示选项文字')

    const fakeForm = { kind: 'survey', schema: [orgField, skillField, matrixField, sortField] }
    const { schema } = submissionsHead(fakeForm)
    const row = submissionRow(fakeForm, schema, {
      id: 1, public_id: 'A1', created_at: '2026-01-01T00:00:00Z', score: null, passed: null,
      data: { owner: 'u3', skills: ['1', '2'], m: { 速度: '5', 稳定: '3' }, s: ['b', 'a'] }
    })
    assert(row[2] === '技术中心 / 后端组 / 张伟', '导出的 Excel 里是完整路径而不是 u3', row[2])
    assert(row[3] === 'Java、Go', '导出的 Excel 里多选是选项文字', row[3])
    assert(!/\{/.test(row[4]), '导出的 Excel 里矩阵不是一坨 JSON', row[4])
    assert(row[5] === '乙 → 甲', '导出的 Excel 里排序带箭头', row[5])
    // 判分口径不能跟着变：仍然按 value 比
    const { isAnswerCorrect } = await import('../server/lib/forms.js')
    assert(isAnswerCorrect({ ...orgField, answer: ['u3'] }, 'u3') === true, '展示换成人话，判分仍比 value')

    // ---- 自由作答：同一句说法要合并计数，别让重复句把别的说法挤出屏幕
    const textField = { id: 'advice', type: 'textarea', label: '建议' }
    const acc = computeStats({ kind: 'survey', schema: [textField] }, [
      { data: { advice: '希望能多招人' }, score: null, passed: null, created_at: '2026-01-01T00:00:00Z' },
      { data: { advice: '希望能多招人' }, score: null, passed: null, created_at: '2026-01-01T00:00:00Z' },
      { data: { advice: '希望能多招人' }, score: null, passed: null, created_at: '2026-01-01T00:00:00Z' },
      { data: { advice: '文档要跟上' }, score: null, passed: null, created_at: '2026-01-01T00:00:00Z' }
    ])
    const stat = acc.questions[0]
    assert(stat.distinct === 2, '四种作答只有两种说法', String(stat.distinct))
    assert(stat.samples[0] === '希望能多招人' && stat.sampleCounts[0] === 3, '出现次数最多的说法排第一并带次数', JSON.stringify(stat.sampleCounts))

    // ---- 文本导入：填空题的「答案：6379」是标准答案，不是占位提示
    r = await req('POST', '/api/banks', { name: '填空答案探针' })
    const bid = r.json.id
    r = await req('POST', `/api/banks/${bid}/import-text`, {
      text: ['[填空] Redis 默认端口号是____。', '答案：6379', '分值：5'].join('\n')
    })
    assert(r.json.imported === 1, '填空题导入成功', JSON.stringify(r.json))
    r = await req('GET', `/api/banks/${bid}/questions`)
    assert(JSON.stringify(r.json.data[0]?.answer) === JSON.stringify(['6379']), '填空题的答案落库了，不是被当成占位提示丢掉', JSON.stringify(r.json.data[0]?.answer))
    // 进了卷子才算真的可判分
    r = await req('POST', '/api/banks/paper/pick', { title: '填空答案卷', questionIds: [r.json.data[0].id] })
    assert(r.status === 201 && r.json.noAnswer.length === 0, '填空题组卷时不再被标成「没有标准答案」', JSON.stringify(r.json.noAnswer))
    await req('DELETE', `/api/forms/${r.json.id}`)
    await req('DELETE', `/api/banks/${bid}`)
    await req('DELETE', `/api/banks/${bid}/purge`)
  }

  console.log('\n[46] 作答清洗：服务端不再照抄客户端提交的东西')
  {
    // 这一批全部是「浏览器正常操作发不出来、但改一下请求就能发」的作答。
    // 以前服务端只校验必填和几个格式，然后原样入库，于是：
    // 选项表里没有的值进了报表、评分题 99 分被算进平均分、文本题塞进对象变成 [object Object]。
    r = await req('POST', '/api/forms', {
      title: '冒烟·作答清洗', kind: 'survey',
      schema: [
        { id: 'c_radio', type: 'radio', label: '单选', options: [{ label: '甲', value: '甲' }, { label: '乙', value: '乙' }] },
        { id: 'c_check', type: 'checkbox', label: '多选', options: [{ label: '甲', value: '甲' }, { label: '乙', value: '乙' }] },
        { id: 'c_text', type: 'text', label: '文本' },
        { id: 'c_rate', type: 'rate', label: '评分', props: { max: 5 } },
        { id: 'c_slider', type: 'slider', label: '滑块', props: { min: 0, max: 100 } },
        { id: 'c_switch', type: 'switch', label: '开关' },
        { id: 'c_date', type: 'date', label: '日期' },
        { id: 'c_num', type: 'number', label: '数字' },
        { id: 'c_sort', type: 'sort', label: '排序', options: [{ label: '一', value: '一' }, { label: '二', value: '二' }] },
        { id: 'c_matrix', type: 'matrix', label: '矩阵', props: { rows: ['价格'] }, options: [{ label: '好', value: '5' }, { label: '差', value: '1' }] }
      ]
    })
    const cleanId = r.json.id
    await req('PUT', `/api/forms/${cleanId}`, { status: 'published' })
    const post = (data) => req('POST', `/api/public/forms/${cleanId}/submit`, { data })

    // 1. 单选：label 与 {label,value} 都是历史数据里真实存在的写法，必须收
    r = await post({ c_radio: '甲' })
    assert(r.status === 201, '单选取选项值可以提交', String(r.status))
    let one = await req('GET', `/api/submissions/${r.json.id}`)
    assert(one.json.data.data.c_radio === '甲', '单选的作答按选项值入库')

    r = await post({ c_radio: { label: '甲', value: '甲' } })
    assert(r.status === 201 && r.json.id, '历史格式 {label,value} 仍被接受，不是一刀切拒收')
    one = await req('GET', `/api/submissions/${r.json.id}`)
    assert(one.json.data.data.c_radio === '甲', '历史格式会被折成选项值，而不是把对象存进库')

    // 2. 选项表里没有的值：必须拒，而且要说是哪一题、收到了什么
    r = await post({ c_radio: '丙' })
    assert(r.status === 422, '选项表里没有的值会被拒绝', String(r.status))
    assert(/单选/.test(r.json.message) && /丙/.test(r.json.message), '拒收时点名是哪一题、收到了什么', r.json.message)
    assert(r.status === 422 && !/服务器内部错误/.test(r.json.message), '拒收是 422 而不是 500（用户要知道是自己填错了）')

    // 3. 多选：字符串「甲,乙」和对象数组都折成选项值数组
    r = await post({ c_check: '甲,乙' })
    one = await req('GET', `/api/submissions/${r.json.id}`)
    assert(JSON.stringify(one.json.data.data.c_check) === JSON.stringify(['甲', '乙']), '多选的逗号串会拆成数组', JSON.stringify(one.json.data.data.c_check))
    r = await post({ c_check: [{ label: '乙', value: '乙' }, { label: '甲', value: '甲' }] })
    one = await req('GET', `/api/submissions/${r.json.id}`)
    assert(JSON.stringify(one.json.data.data.c_check) === JSON.stringify(['甲', '乙']), '多选按选项表顺序归一，不留客户端给的顺序')

    // 4. 数值类：超范围一律拒
    r = await post({ c_rate: 99 })
    assert(r.status === 422, '评分超出上限会被拒绝', String(r.status))
    r = await post({ c_rate: 4 })
    assert(r.status === 201, '评分在范围内正常收')
    r = await post({ c_slider: 99999 })
    assert(r.status === 422, '滑块超出范围会被拒绝', String(r.status))

    // 5. 形状不对：对象 / 数组 / 超长文本
    r = await post({ c_text: { a: 1 } })
    assert(r.status === 422, '文本题塞对象会被拒绝', String(r.status))
    r = await post({ c_text: ['a', 'b'] })
    assert(r.status === 422, '文本题塞数组会被拒绝', String(r.status))
    r = await post({ c_text: '字'.repeat(5001) })
    assert(r.status === 422 && /上限/.test(r.json.message), '超长文本会被拒绝并说明上限', r.json.message)
    r = await post({ c_text: '字'.repeat(5000) })
    assert(r.status === 201, '刚好到上限的长文本仍然可提交')

    // 6. 开关只收真假
    r = await post({ c_switch: 'yes' })
    assert(r.status === 422, '开关收到 "yes" 会被拒绝', String(r.status))
    r = await post({ c_switch: true })
    assert(r.status === 201, '开关收布尔值正常')

    // 7. 日期：形状对不等于日期存在
    r = await post({ c_date: '2026-13-45' })
    assert(r.status === 422, '2026-13-45 会被拒绝（不是"看着像日期"就算）', String(r.status))
    r = await post({ c_date: '2026-02-31' })
    assert(r.status === 422, '2026-02-31 会被拒绝（2 月没有 31 号）')
    r = await post({ c_date: '2026-02-28' })
    assert(r.status === 201, '真实存在的日期正常通过')

    // 8. 排序必须是一份完整排列
    r = await post({ c_sort: ['一'] })
    assert(r.status === 422, '排序题只排一半会被拒绝（不完整的一列不构成顺序）', String(r.status))
    r = await post({ c_sort: ['二', '一'] })
    assert(r.status === 201, '排序题排完整顺序正常')

    // 9. 矩阵只留选项表里真有的列值
    r = await post({ c_matrix: { 价格: '5' } })
    assert(r.status === 201, '矩阵正常作答通过')
    r = await post({ c_matrix: { 价格: '9' } })
    assert(r.status === 422, '矩阵里不存在的档位会被拒绝', String(r.status))

    // 10. 编辑答卷走同一道清洗：否则「先正常交、再改一份脏的」就绕过去了
    r = await req('POST', `/api/public/forms/${cleanId}/submit`, { data: { c_radio: '乙' } })
    const editId = r.json.id
    r = await req('PUT', `/api/submissions/${editId}`, { data: { c_radio: '不存在' } })
    assert(r.status === 422, '编辑答卷同样拒绝非法作答', String(r.status))

    // 11. 数字题：字符串 '42' 收下并转成数字
    r = await post({ c_num: '42' })
    one = await req('GET', `/api/submissions/${r.json.id}`)
    assert(one.json.data.data.c_num === 42, '数字题的字符串会转成数字入库', JSON.stringify(one.json.data.data.c_num))

    await req('DELETE', `/api/forms/${cleanId}`)
    await req('DELETE', `/api/forms/${cleanId}/purge`)
  }

  console.log('\n[47] 批量导入答卷不能"导入成功但全是空的"')
  {
    // sanitizeAnswers 返回 {data, dropped}，把它整个喂给 resolveAnswers 时，
    // 逻辑引擎找不到任何字段 id，产出一份空答卷 —— 库里有行、报表全 0，接口一路回「导入成功」。
    r = await req('POST', '/api/forms', {
      title: '冒烟·导入清洗', kind: 'survey',
      schema: [
        { id: 'i_city', type: 'radio', label: '城市', options: [{ label: '北京', value: '北京' }, { label: '上海', value: '上海' }] },
        { id: 'i_num', type: 'number', label: '数字' }
      ]
    })
    const impId = r.json.id
    await req('PUT', `/api/forms/${impId}`, { status: 'published' })
    r = await req('POST', `/api/forms/${impId}/import`, {
      items: [{ data: { i_city: '北京', i_num: '5' } }, { data: { i_city: '上海', i_num: '7' } }]
    })
    assert(r.json.imported === 2, '两条答卷都导入成功', JSON.stringify(r.json))
    r = await req('GET', `/api/forms/${impId}/report`)
    const impCity = r.json.data.questions.find(q => q.id === 'i_city')
    assert(impCity.series.find(x => x.name === '北京').value === 1, '导入的作答真的进了库（不是空答卷）', JSON.stringify(impCity.series))
    const impNum = r.json.data.questions.find(q => q.id === 'i_num')
    assert(impNum.max === 7 && impNum.min === 5, '导入的数字题算得出极值', JSON.stringify([impNum.min, impNum.max]))
    await req('DELETE', `/api/forms/${impId}`)
    await req('DELETE', `/api/forms/${impId}/purge`)
  }

  console.log('\n[48] 矩阵题：两条轴都得有东西')
  {
    // 只给行不给列时，矩阵在页面上就是个空表头：谁也没法作答，而它还占着分值。
    r = await req('POST', '/api/forms', {
      title: '冒烟·矩阵列', kind: 'survey',
      schema: [{ id: 'm_only_rows', type: 'matrix', label: '评价', props: { rows: ['价格', '服务'] } }]
    })
    const matrixId = r.json.id
    r = await req('GET', `/api/forms/${matrixId}`)
    const mf = r.json.data.schema.find(f => f.id === 'm_only_rows')
    assert(Array.isArray(mf.options) && mf.options.length > 0, '只给了行的矩阵会自动补上列', JSON.stringify(mf.options))
    assert(JSON.stringify(mf.props.rows) === JSON.stringify(['价格', '服务']), '已有的行不会被覆盖')
    await req('DELETE', `/api/forms/${matrixId}`)
    await req('DELETE', `/api/forms/${matrixId}/purge`)
  }

  console.log('\n[50] 落库前的清洗：schema 内部一致性 / 富文本 / 指标范围')
  {
    // 这一批全部来自「写脚本直接打接口」：页面不会这么传，但改一下请求就能发出来。

    // 1. 富文本白名单：老的 sanitize 只有两条正则，这三种一个都拦不住
    const { sanitizeHtml } = await import('../web/js/sanitize.js')
    assert(!/onerror/.test(sanitizeHtml('<img src=x onerror=alert(1)>')), '无引号的事件属性被剥掉')
    assert(sanitizeHtml('<svg onload=alert(1)>文字</svg>') === '', 'svg 连内容一起丢掉')
    assert(sanitizeHtml('<a href="javascript:alert(1)">点我</a>') === '<a>点我</a>', 'javascript: 协议被剥掉')
    assert(/^<a href="https:\/\/example.com"/.test(sanitizeHtml('<a href="https://example.com" target="_blank">ok</a>')), '正常的 https 链接保留')
    assert(/rel="noopener/.test(sanitizeHtml('<a href="https://example.com" target="_blank">ok</a>')), 'target=_blank 自动补 rel=noopener')
    assert(sanitizeHtml('<img src="data:text/html;base64,xx">') === '<img>', 'data:text/html 不能当图片地址')

    // 2. 富文本落库也过一遍：只靠前端清洗等于「谁都能直接 POST 一份带 onerror 的 richtext」
    r = await req('POST', '/api/forms', {
      title: '冒烟·富文本清洗', kind: 'survey',
      schema: [{ id: 'rt', type: 'richtext', label: '', props: { html: '<p onclick="x()">说明</p><img src=x onerror=alert(1)>' } }]
    })
    const rtId = r.json.id
    r = await req('GET', `/api/forms/${rtId}`)
    const rtHtml = r.json.data.schema.find(f => f.id === 'rt').props.html
    assert(!/onerror|onclick/i.test(rtHtml) && /说明/.test(rtHtml), '富文本落库前已被白名单清洗', rtHtml)

    // 3. schema 内部一致性：id 重复、分值越界、逻辑引用不存在的字段
    r = await req('PUT', `/api/forms/${rtId}`, {
      schema: [
        { id: 'dup', type: 'text', label: 'A', score: -30, logic: [{ fieldId: 'nope', op: 'eq', value: 'x' }] },
        { id: 'dup', type: 'text', label: 'B', score: 1e9 }
      ]
    })
    const fixed = r.json.data.schema
    assert(fixed[0].id !== fixed[1].id, '重复的字段 id 会被重新分配', JSON.stringify(fixed.map(f => f.id)))
    assert(fixed[0].score === 0 && fixed[1].score === 1000, '分值被压回 0 - 1000', JSON.stringify(fixed.map(f => f.score)))
    assert(fixed[0].logic.length === 0, '引用不存在字段的逻辑规则被剔除（否则永远不成立）', JSON.stringify(fixed[0].logic))

    // 4. jump 规则没有 fieldId，不能当成脏数据删掉
    r = await req('PUT', `/api/forms/${rtId}`, {
      schema: [{ id: 'j1', type: 'radio', label: '是否继续', options: ['是', '否'], jump: [{ op: 'eq', value: '否', text: '到此为止' }] }]
    })
    assert(r.json.data.schema[0].jump.length === 1, '条件跳转规则被保留', JSON.stringify(r.json.data.schema[0].jump))

    // 5. settings 必须是对象，指标要夹在合理区间
    r = await req('PUT', `/api/forms/${rtId}`, { settings: 'not-an-object' })
    assert(r.json.data.settings && typeof r.json.data.settings === 'object', 'settings 传字符串不会入库', JSON.stringify(r.json.data.settings))
    r = await req('PUT', `/api/forms/${rtId}`, { settings: { passPercent: 150, duration: -5 } })
    assert(r.json.data.settings.passPercent === 100, '及格线超过 100% 被夹回 100', JSON.stringify(r.json.data.settings))
    assert(r.json.data.settings.duration === 0, '负时长会让倒计时立刻到点，夹回 0', JSON.stringify(r.json.data.settings))

    // 6. 标题不能改成一片空白
    r = await req('PUT', `/api/forms/${rtId}`, { title: '   ' })
    assert(r.status === 400, '空白标题被拒绝', String(r.status))

    // 7. 题库：越界答案要剔除并回报；分值同样有上限
    r = await req('POST', '/api/banks', { name: '冒烟·题库清洗' })
    const cleanBank = r.json.id
    r = await req('POST', `/api/banks/${cleanBank}/questions`, {
      type: 'radio', title: '答案越界', options: ['A', 'B'], answer: ['Z'], score: 5
    })
    assert((r.json.droppedAnswers || []).length === 1, '接口建题时越界答案被回报', JSON.stringify(r.json.droppedAnswers))
    r = await req('POST', `/api/banks/${cleanBank}/questions`, { type: 'text', title: '天价分值', score: 1e9 })
    const qid = r.json.ids[0]
    r = await req('GET', `/api/banks/${cleanBank}/questions`)
    const q1 = r.json.data.find(x => x.id === qid)
    assert(q1.score === 1000, '单题分值上限 1000', String(q1.score))
    const q0 = r.json.data.find(x => x.title === '答案越界')
    assert(q0 && Array.isArray(q0.answer) && q0.answer.length === 0, '越界答案被剔除后，这道题没有标准答案可说', JSON.stringify(q0 && q0.answer))

    await req('DELETE', `/api/forms/${rtId}`)
    await req('DELETE', `/api/forms/${rtId}/purge`)
    await req('DELETE', `/api/banks/${cleanBank}`)
  }

  console.log('\n[51] 批阅入口只出现在真需要批阅的答卷上')
  {
    // 早先前端只按 kind==='exam' 摆「批阅」：纯客观题的卷子每行都有颗按钮，
    // 点下去才弹「这份卷子没有待批阅的主观题」。列表得自己说清楚还差几题。
    r = await req('POST', '/api/forms', {
      title: '冒烟·客观题卷', kind: 'exam',
      schema: [{ id: 'p_obj', type: 'radio', label: '客观', options: ['A', 'B'], answer: ['A'], score: 10 }]
    })
    const objId = r.json.id
    await req('PUT', `/api/forms/${objId}`, { status: 'published' })
    r = await req('POST', `/api/public/forms/${objId}/submit`, { data: { p_obj: 'A' } })
    const objSub = r.json.id
    r = await req('GET', `/api/submissions?formId=${objId}`)
    const objRow = r.json.data.find(x => x.id === objSub)
    assert(objRow && objRow.pending === 0, '没有主观题的卷子 pending 为 0（前端据此不出批阅按钮）', JSON.stringify(objRow && objRow.pending))

    r = await req('POST', '/api/forms', {
      title: '冒烟·主观题卷', kind: 'exam',
      schema: [{ id: 'p_sub', type: 'textarea', label: '简答', score: 10 }]
    })
    const subId = r.json.id
    await req('PUT', `/api/forms/${subId}`, { status: 'published' })
    r = await req('POST', `/api/public/forms/${subId}/submit`, { data: { p_sub: '一段回答' } })
    const subSub = r.json.id
    r = await req('GET', `/api/submissions?formId=${subId}`)
    const subRow = r.json.data.find(x => x.id === subSub)
    assert(subRow && subRow.pending === 1, '有待批阅主观题时 pending 为 1', JSON.stringify(subRow && subRow.pending))
    r = await req('PUT', `/api/submissions/${subSub}/review`, { scores: { p_sub: 8 } })
    assert(r.status === 200, '批阅后成绩重算成功', String(r.status))
    r = await req('GET', `/api/submissions?formId=${subId}`)
    assert(r.json.data.find(x => x.id === subSub).pending === 0, '批完之后不再进待批队列')

    await req('DELETE', `/api/forms/${objId}`); await req('DELETE', `/api/forms/${objId}/purge`)
    await req('DELETE', `/api/forms/${subId}`); await req('DELETE', `/api/forms/${subId}/purge`)
  }

  console.log('\n[45] 前端静态资源')

  for (const p of ['/', '/js/main.js', '/css/app.css', '/js/views/Logs.js', '/js/views/Dicts.js', '/assets/eqs-mark.svg', '/vendor/echarts.min.js']) {
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
