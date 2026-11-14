import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { setting, DATA_DIR } from './db.js'

const LOCAL_DIR = path.join(DATA_DIR, 'files')

export const DRIVERS = ['local', 'aliyun', 'qiniu', 'upyun', 's3']

export function storageConfig() {
  return setting('storage', { driver: 'local', publicBase: '/api/files/raw' })
}

function bodyHash(payload, secret) {
  return crypto.createHmac('sha1', secret).update(payload).digest('base64')
}

async function putAliyun(buf, key, cfg) {
  const date = new Date().toUTCString()
  const contentType = cfg.contentType || 'application/octet-stream'
  const md5 = crypto.createHash('md5').update(buf).digest('base64')
  const stringToSign = `PUT\n${md5}\n${contentType}\n${date}\n/${cfg.bucket}/${key}`
  const signature = crypto.createHmac('sha1', cfg.secretKey).update(stringToSign).digest('base64')
  const endpoint = cfg.endpoint || `${cfg.bucket}.${cfg.region || 'oss-cn-hangzhou'}.aliyuncs.com`
  const url = `${cfg.protocol || 'https'}://${endpoint}/${key}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Date: date, 'Content-Type': contentType, 'Content-MD5': md5, Authorization: `OSS ${cfg.accessKey}:${signature}` },
    body: buf
  })
  if (!res.ok) throw new Error(`阿里云 OSS 上传失败 ${res.status}`)
  return (cfg.domain || url).replace(/\/$/, '') + '/' + key
}

function qiniuToken(cfg, key) {
  const putPolicy = JSON.stringify({ scope: `${cfg.bucket}:${key}`, deadline: Math.floor(Date.now() / 1000) + 3600 })
  const encoded = Buffer.from(putPolicy).toString('base64url')
  const sign = crypto.createHmac('sha1', cfg.secretKey).update(encoded).digest('base64url')
  return `${cfg.accessKey}:${sign}:${encoded}`
}

async function putQiniu(buf, key, cfg) {
  const form = new FormData()
  form.append('token', qiniuToken(cfg, key))
  form.append('key', key)
  form.append('file', new Blob([buf]), key)
  const res = await fetch(cfg.uploadUrl || 'https://upload.qiniup.com', { method: 'POST', body: form })
  if (!res.ok) throw new Error(`七牛云上传失败 ${res.status}`)
  return (cfg.domain || '').replace(/\/$/, '') + '/' + key
}

async function putUpyun(buf, key, cfg) {
  const uri = `/${cfg.bucket}/${key}`
  const date = new Date().toUTCString()
  const passwordMd5 = crypto.createHash('md5').update(cfg.password).digest('hex')
  const sign = crypto.createHmac('sha1', passwordMd5).update(`PUT&${uri}&${date}`).digest('base64')
  const res = await fetch(`https://v0.api.upyun.com${uri}`, {
    method: 'PUT',
    headers: { Authorization: `UPYUN ${cfg.operator}:${sign}`, Date: date },
    body: buf
  })
  if (!res.ok) throw new Error(`又拍云上传失败 ${res.status}`)
  return (cfg.domain || '').replace(/\/$/, '') + '/' + key
}

function s3Sign(cfg, method, key, buf) {
  const region = cfg.region || 'us-east-1'
  const service = 's3'
  const host = cfg.endpoint ? new URL(cfg.endpoint).host : `${cfg.bucket}.s3.${region}.amazonaws.com`
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = crypto.createHash('sha256').update(buf || '').digest('hex')
  const canonicalUri = `/${cfg.bucket ? '' : ''}${encodeURIComponent(key).replace(/%2F/g, '/')}`
  const canonicalRequest = [method, canonicalUri, '', `host:${host}`, `x-amz-content-sha256:${payloadHash}`, `x-amz-date:${amzDate}`, '', 'host;x-amz-content-sha256;x-amz-date', payloadHash].join('\n')
  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')
  const kDate = crypto.createHmac('sha256', 'AWS4' + cfg.secretKey).update(dateStamp).digest()
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest()
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest()
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest()
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  return {
    url: `${cfg.endpoint || `https://${host}`}/${key}`,
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate
    }
  }
}

async function putS3(buf, key, cfg) {
  const { url, headers } = s3Sign(cfg, 'PUT', key, buf)
  const res = await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': cfg.contentType || 'application/octet-stream' }, body: buf })
  if (!res.ok) throw new Error(`S3 上传失败 ${res.status}`)
  if (cfg.domain) return cfg.domain.replace(/\/$/, '') + '/' + key
  return url
}

export async function upload({ name, buf, mime = '', formId = 0, submissionId = 0 }) {
  const cfg = storageConfig()
  const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomBytes(8).toString('hex')}${path.extname(name) || ''}`
  const driver = DRIVERS.includes(cfg.driver) ? cfg.driver : 'local'
  if (driver === 'local') {
    const target = path.join(LOCAL_DIR, key)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, buf)
    return { stored: key, driver, url: `/api/files/raw/${key}`, size: buf.length, mime, name, formId, submissionId }
  }
  const withType = { ...cfg, contentType: mime }
  const fn = { aliyun: putAliyun, qiniu: putQiniu, upyun: putUpyun, s3: putS3 }[driver]
  const url = await fn(buf, key, withType)
  return { stored: key, driver, url, size: buf.length, mime, name, formId, submissionId }
}

export function localPath(key) {
  const file = path.resolve(LOCAL_DIR, key)
  if (!file.startsWith(path.resolve(LOCAL_DIR))) return null
  return fs.existsSync(file) ? file : null
}

export { LOCAL_DIR }
