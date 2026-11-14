import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { all, setting, get } from './db.js'

/** ---------------- SMTP（纯 net/tls 实现，无第三方依赖） ---------------- */
function encodeHeader(s) { return `=?UTF-8?B?${Buffer.from(String(s)).toString('base64')}?=` }

async function smtpSend(cfg, { to, subject, html }) {
  const host = cfg.host
  const port = Number(cfg.port || (cfg.secure ? 465 : 25))
  const useSSL = cfg.secure !== false && port === 465
  const socket = useSSL ? tls.connect({ host, port, servername: host }) : net.connect({ host, port })
  socket.setEncoding('utf8')

  let buffer = ''
  let waiters = []
  const onData = d => {
    buffer += d
    if (/\r?\n$/.test(buffer)) {
      const lines = buffer
      buffer = ''
      const w = waiters.shift()
      if (w) w(lines)
    }
  }
  socket.on('data', onData)
  const next = (timeout = 12000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SMTP 超时')), timeout)
    waiters.push(lines => { clearTimeout(timer); resolve(lines) })
  })
  const cmd = async (line, expect = 2) => {
    if (line) socket.write(line + '\r\n')
    const lines = await next()
    const code = Number(lines.slice(0, 3))
    if (Math.floor(code / 100) !== expect && !(expect === 2 && Math.floor(code / 100) === 3)) {
      throw new Error(`SMTP 错误: ${lines.trim()}`)
    }
    return lines
  }

  await new Promise((res, rej) => socket.once(useSSL ? 'secureConnect' : 'connect', res).once('error', rej))
  await next()
  let info = await cmd(`EHLO ${cfg.helo || 'eqs.local'}`)
  if (/STARTTLS/i.test(info) && !useSSL) {
    await cmd('STARTTLS', 2)
    const secured = tls.connect({ socket, servername: host })
    await new Promise((res, rej) => secured.once('secureConnect', res).once('error', rej))
    socket.removeListener('data', onData)
    return sendOverTls(secured, cfg, { to, subject, html })
  }
  if (cfg.user) {
    await cmd('AUTH LOGIN', 3)
    await cmd(Buffer.from(cfg.user).toString('base64'), 3)
    await cmd(Buffer.from(cfg.pass || '').toString('base64'), 2)
  }
  await deliver(cmd, cfg, { to, subject, html })
  socket.end()
  return true
}

async function sendOverTls(socket, cfg, mail) {
  socket.setEncoding('utf8')
  let buffer = ''
  let waiters = []
  socket.on('data', d => {
    buffer += d
    if (/\r?\n$/.test(buffer)) { const l = buffer; buffer = ''; const w = waiters.shift(); if (w) w(l) }
  })
  const next = (timeout = 12000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('SMTP 超时')), timeout)
    waiters.push(lines => { clearTimeout(t); res(lines) })
  })
  const cmd = async (line, expect = 2) => {
    if (line) socket.write(line + '\r\n')
    const lines = await next()
    const code = Number(lines.slice(0, 3))
    if (Math.floor(code / 100) !== expect && !(expect === 2 && Math.floor(code / 100) === 3)) throw new Error(`SMTP 错误: ${lines.trim()}`)
    return lines
  }
  await cmd(`EHLO ${cfg.helo || 'eqs.local'}`)
  if (cfg.user) {
    await cmd('AUTH LOGIN', 3)
    await cmd(Buffer.from(cfg.user).toString('base64'), 3)
    await cmd(Buffer.from(cfg.pass || '').toString('base64'), 2)
  }
  await deliver(cmd, cfg, mail)
  socket.end()
  return true
}

async function deliver(cmd, cfg, { to, subject, html }) {
  const from = cfg.from || cfg.user
  await cmd(`MAIL FROM:<${from}>`)
  for (const one of [].concat(to)) await cmd(`RCPT TO:<${one}>`)
  await cmd('DATA', 3)
  const body = [
    `From: ${encodeHeader(cfg.fromName || 'EQS')} <${from}>`,
    `To: ${[].concat(to).join(',')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html).toString('base64').replace(/.{76}/g, '$&\r\n'),
    '.'
  ].join('\r\n')
  await cmd(body)
}

/** ---------------- 短信 ---------------- */
function smsSign(params, secret, method = 'HMAC-SHA1') {
  const q = Object.keys(params).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&')
  const str = `POST&${encodeURIComponent('/')}&${encodeURIComponent(q)}`
  return crypto.createHmac('sha1', secret + '&').update(str).digest('base64')
}

export async function sendSms(cfg, { phone, text, templateCode, params = {} }) {
  const provider = cfg.provider || 'aliyun'
  if (provider === 'aliyun') {
    const common = {
      AccessKeyId: cfg.accessKey, Action: 'SendSms', Format: 'JSON', PhoneNumbers: phone,
      RegionId: cfg.region || 'cn-hangzhou', SignName: cfg.signName, SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: crypto.randomUUID(), SignatureVersion: '1.0', TemplateCode: templateCode || cfg.templateCode,
      TemplateParam: JSON.stringify(params), Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), Version: '2017-05-25'
    }
    const Signature = smsSign(common, cfg.secretKey)
    const qs = new URLSearchParams({ ...common, Signature }).toString()
    const res = await fetch(`https://dysmsapi.aliyuncs.com/?${qs}`, { method: 'POST' })
    const json = await res.json()
    if (json.Code !== 'OK') throw new Error(`阿里云短信失败: ${json.Message || json.Code}`)
    return json
  }
  if (provider === 'tencent') {
    const host = 'sms.tencentcloudapi.com'
    const payload = JSON.stringify({
      PhoneNumberSet: [`+86${phone}`], SmsSdkAppId: cfg.sdkAppId, SignName: cfg.signName,
      TemplateId: templateCode || cfg.templateId, TemplateParamSet: Object.values(params)
    })
    const ts = Math.floor(Date.now() / 1000)
    const date = new Date(ts * 1000).toISOString().slice(0, 10)
    const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\n\ncontent-type;host\n${crypto.createHash('sha256').update(payload).digest('hex')}`
    const scope = `${date}/sms/tc3_request`
    const sts = `TC3-HMAC-SHA256\n${ts}\n${scope}\n${crypto.createHash('sha256').update(canonical).digest('hex')}`
    const kD = crypto.createHmac('sha256', 'TC3' + cfg.secretKey).update(date).digest()
    const kS = crypto.createHmac('sha256', kD).update('sms').digest()
    const kSign = crypto.createHmac('sha256', kS).update('tc3_request').digest()
    const sig = crypto.createHmac('sha256', kSign).update(sts).digest('hex')
    const res = await fetch(`https://${host}`, {
      method: 'POST',
      headers: {
        Authorization: `TC3-HMAC-SHA256 Credential=${cfg.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${sig}`,
        'Content-Type': 'application/json; charset=utf-8', Host: host, 'X-TC-Action': 'SendSms', 'X-TC-Timestamp': String(ts), 'X-TC-Version': '2021-01-11'
      },
      body: payload
    })
    const json = await res.json()
    if (json.Response?.Error) throw new Error(`腾讯云短信失败: ${json.Response.Error.Message}`)
    return json
  }
  if (provider === 'zhongyu') {
    const res = await fetch(`${cfg.endpoint || 'https://api.zhongyu.com'}/sms/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey || cfg.secretKey}` },
      body: JSON.stringify({ mobile: phone, content: text, templateId: templateCode, params })
    })
    if (!res.ok) throw new Error(`中昱维信短信失败 ${res.status}`)
    return res.json()
  }
  throw new Error('未知短信服务商')
}

/** ---------------- 微信公众号模板消息 ---------------- */
let wxTokenCache = { token: '', exp: 0 }
export async function wxAccessToken(cfg) {
  if (wxTokenCache.token && wxTokenCache.exp > Date.now() + 60000) return wxTokenCache.token
  const qs = new URLSearchParams({ grant_type: 'client_credential', appid: cfg.appId, secret: cfg.appSecret })
  const res = await fetch(`https://api.weixin.qq.com/cgi-bin/token?${qs}`)
  const json = await res.json()
  if (!json.access_token) throw new Error(`获取微信 access_token 失败: ${json.errmsg || json.errcode}`)
  wxTokenCache = { token: json.access_token, exp: Date.now() + (json.expires_in || 7200) * 1000 }
  return wxTokenCache.token
}

export async function sendWechatTemplate(cfg, { openid, templateId, url, data }) {
  const token = await wxAccessToken(cfg)
  const res = await fetch(`https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${token}`, {
    method: 'POST',
    body: JSON.stringify({ touser: openid, template_id: templateId || cfg.templateId, url, data })
  })
  const json = await res.json()
  if (json.errcode) throw new Error(`微信模板消息失败: ${json.errmsg}`)
  return json
}

/** ---------------- WebHook ---------------- */
export function hookSignature(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret || '').update(body).digest('hex')
}

export async function dispatchWebhooks(event, payload) {
  const hooks = all('SELECT * FROM webhooks WHERE enabled = 1')
  const results = []
  for (const h of hooks) {
    let events = []
    try { events = JSON.parse(h.events) } catch {}
    if (!events.includes(event) && !events.includes('*')) continue
    const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data: payload })
    try {
      const res = await fetch(h.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-EQS-Event': event, 'X-EQS-Signature': hookSignature(h.secret, body) },
        body,
        signal: AbortSignal.timeout(10000)
      })
      results.push({ id: h.id, ok: res.ok, status: res.status })
    } catch (e) {
      results.push({ id: h.id, ok: false, error: e.message })
    }
  }
  return results
}

/** 提交后的通知：邮件 + 模板消息，异步不阻塞 */
export async function notifySubmission(form, submission) {
  const mail = setting('mail')
  const wx = setting('wechat')
  const notifyTo = form.settings?.notifyEmail
  const tasks = []
  if (mail?.enabled && mail.host && notifyTo) {
    const rows = Object.entries(submission.data).map(([k, v]) => {
      const f = form.schema.find(x => x.id === k)
      return `<tr><td style="padding:6px 10px;border:1px solid #eee">${escapeHtml(f?.label || k)}</td><td style="padding:6px 10px;border:1px solid #eee">${escapeHtml(String(Array.isArray(v) ? v.join(', ') : v ?? ''))}</td></tr>`
    }).join('')
    tasks.push(smtpSend(mail, { to: notifyTo, subject: `新答卷：${form.title}`, html: `<h3>${escapeHtml(form.title)}</h3><table style="border-collapse:collapse;font-size:13px">${rows}</table>` }))
  }
  if (wx?.enabled && wx.appId && wx.appSecret && (submission.openid || wx.notifyOpenid) && form.settings?.notifyWx) {
    tasks.push(sendWechatTemplate(wx, {
      openid: submission.openid || wx.notifyOpenid,
      templateId: form.settings?.wxTemplateId || wx.templateId,
      url: form.settings?.wxNotifyUrl || '',
      data: { first: { value: `新答卷：${form.title}` }, keyword1: { value: String(submission.id) }, remark: { value: 'EQS 自动提醒' } }
    }))
  }
  if (!tasks.length) return []
  const settled = await Promise.allSettled(tasks)
  return settled.map(s => ({ ok: s.status === 'fulfilled', error: s.reason?.message }))
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export { smtpSend }
