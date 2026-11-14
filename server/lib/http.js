import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { setting } from './db.js'

const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', txt: 'text/plain; charset=utf-8',
  woff2: 'font/woff2', map: 'application/json', csv: 'text/csv; charset=utf-8'
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export const fail = (status, msg) => { throw new HttpError(status, msg) }

export async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) fail(413, '请求体过大')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

export async function readJson(req) {
  const buf = await readBody(req)
  if (!buf.length) return {}
  try { return JSON.parse(buf.toString('utf8')) } catch { fail(400, 'JSON 格式错误') }
}

export function parseCookies(req) {
  const out = {}
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
  res.writeHead(status, { 'Content-Length': buf.length, ...headers })
  res.end(buf)
}

export function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', ...headers
  })
}

/**
 * 取客户端 IP。
 *
 * 以前无条件信任 `X-Forwarded-For`，取最左边那一段 —— 而这个头是**客户端自己发的**，
 * 想写什么写什么。后果不是「日志里 IP 不准」这么轻：
 *   1. 登录失败限速按「账号 + IP」计数，换个头就换了个计数器 —— 实测连打 12 次全是 401，一次不锁；
 *   2. 问卷的「每个 IP 限填 1 次」同理，换 3 个头就交了 3 份；
 *   3. 匿名答卷里记的 IP 是谁都能指定的字符串，出了事根本追不回来。
 *
 * 默认只认 socket 的对端地址。反向代理后面（Nginx / 容器网关）才需要在
 * 系统设置 → 站点 里显式打开「信任代理头」，并指定代理层数：
 * 右边第 N 段才是可信代理追加的，左边全是调用方自己填的。
 */
let ipCfg = { at: 0, trust: false, hops: 1 }
function ipTrust() {
  const now = Date.now()
  if (now - ipCfg.at > 5000) {
    const s = setting('site', {}) || {}
    ipCfg = { at: now, trust: s.trustProxy === true, hops: Math.min(5, Math.max(1, Number(s.trustHops) || 1)) }
  }
  return ipCfg
}

export function clientIp(req) {
  const direct = String(req.socket?.remoteAddress || '').replace('::ffff:', '')
  const cfg = ipTrust()
  if (!cfg.trust) return direct
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean)
  if (!chain.length) return direct
  return chain[Math.max(0, chain.length - cfg.hops)] || direct
}

/** 静态文件目录服务，带 etag 与 gzip */
export function serveStatic(root, req, res, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0])
  let rel = clean.replace(/^\/+/, '')
  if (!rel || rel.endsWith('/')) rel += 'index.html'
  const file = path.resolve(root, rel)
  if (!file.startsWith(path.resolve(root)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false
  const ext = path.extname(file).slice(1).toLowerCase()
  const stat = fs.statSync(file)
  const etag = `W/"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`
  /*
   * 前端是没有构建步骤的 ESM：js/css 一改，文件名不变。
   * 给它们 max-age=86400，等于「升级完还要等一天才生效」——用户看到的是
   * 改好的后端配旧的前端，报的错一个都对不上。所以代码类资源一律 no-cache，
   * 靠 ETag 走 304，代价只是几十字节的往返；图片、字体、vendor 才长缓存。
   */
  const LONG_CACHE = ['svg', 'png', 'jpg', 'jpeg', 'webp', 'ico', 'woff', 'woff2', 'ttf', 'gif']
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    ETag: etag,
    // vendor 是第三方库，本项目从不改它，可以放心长缓存
    'Cache-Control': rel.startsWith('vendor/') || LONG_CACHE.includes(ext)
      ? 'public, max-age=86400'
      : 'no-cache'
  }
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true }
  const accept = req.headers['accept-encoding'] || ''
  const compressible = ['html', 'js', 'css', 'json', 'svg', 'txt', 'map'].includes(ext) && stat.size > 1024
  if (compressible && accept.includes('gzip')) {
    const buf = zlib.gzipSync(fs.readFileSync(file))
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': buf.length, Vary: 'Accept-Encoding' })
    res.end(buf)
    return true
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size })
  fs.createReadStream(file).pipe(res)
  return true
}

/** 极简路由：支持 /api/forms/:id 形式 */
export function createRouter() {
  const routes = []
  const add = (method, pattern, handler) => {
    const keys = []
    const src = pattern
      .replace(/:[a-zA-Z0-9_]+/g, m => { keys.push(m.slice(1)); return '([^/]+)' })
      .replace(/\*/g, () => { keys.push('*'); return '(.*)' })
    const rx = new RegExp('^' + src + '/?$')
    routes.push({ method, rx, keys, handler })
  }
  const router = {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    patch: (p, h) => add('PATCH', p, h),
    delete: (p, h) => add('DELETE', p, h),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue
        const m = r.rx.exec(pathname)
        if (m) {
          const params = {}
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]) })
          return { handler: r.handler, params }
        }
      }
      return null
    }
  }
  return router
}

export function createServer() {
  return http.createServer()
}
