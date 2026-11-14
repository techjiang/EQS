import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

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

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (fwd) return String(fwd).split(',')[0].trim()
  return (req.socket.remoteAddress || '').replace('::ffff:', '')
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
