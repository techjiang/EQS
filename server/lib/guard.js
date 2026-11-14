import fs from 'node:fs'
import path from 'node:path'
import { setting } from './db.js'

/**
 * 外围三道闸：跨站、上传、频率。
 *
 * 这三件事的共同点是「功能全都正常，出事的只是没被想到的用法」：
 * 接口对同源浏览器一一正常工作，但同一个接口在别人的网页里、在被塞了 HTML 的
 * 上传文件里、在被脚本按毫秒打的时候，行为完全不同。所以集中放在这里，
 * 让 routes 里只关心业务。
 */

/* ------------------------------------------------------------------ *
 * 一、跨站：不再反射任意 Origin
 * ------------------------------------------------------------------ */

/**
 * API 的跨域策略。
 *
 * 之前是 `Access-Control-Allow-Origin: req.headers.origin || '*'` 加
 * `Allow-Credentials: true` —— 这个组合等于「任何网页都能带着访客的 Cookie
 * 读我们所有的接口」。受害者只要在登录状态下打开一个恶意页面，那个页面就能
 * `fetch('https://你的EQS/api/submissions', {credentials:'include'})`，
 * 把整库答卷连同用户列表一起读走。同源策略被这一行彻底关掉了。
 *
 * 现在三档：
 *   - 同源请求（浏览器不发 Origin，或 Origin 与 Host 一致）：不写任何 CORS 头，天然准入；
 *   - 白名单来源（设置里填的，给「前端单独部署」「对接自有系统」用）：回显该来源 + 允许凭证；
 *   - 其余来源：不写 ACAO。请求照常到达服务端（CORS 是浏览器侧的限制，不是鉴权），
 *     但对方页面读不到响应——这正是我们要的。
 *
 * 注意 X-API-Key 那条路不依赖 Cookie，所以即便是第三方来源，服务端也照常处理；
 * 只是浏览器读不读得到，由白名单决定。
 */
export function corsOrigin(req) {
  const origin = String(req.headers.origin || '')
  if (!origin) return ''
  const host = String(req.headers.host || '')
  // 同源：浏览器一般不发 Origin，发了也说明是同一个站点（含 http/https 混用的一层代理）
  try {
    if (host && new URL(origin).host === host) return origin
  } catch { return '' }
  const list = corsWhitelist()
  return list.includes(origin) ? origin : ''
}

export function corsWhitelist() {
  const s = setting('site', {}) || {}
  const raw = Array.isArray(s.corsOrigins) ? s.corsOrigins : String(s.corsOrigins || '').split(/[\s,]+/)
  return raw.map(x => String(x).trim().replace(/\/$/, '')).filter(Boolean)
}

/** 给响应挂上 CORS 头；返回本次是否允许。不允许时一个头都不写。 */
export function applyCors(req, res) {
  const allow = corsOrigin(req)
  if (!allow) return false
  res.setHeader('Access-Control-Allow-Origin', allow)
  // 白名单里的来源是真要带 Cookie 用的，同源那个分支本来就带得上
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Vary', 'Origin')
  return true
}

/* ------------------------------------------------------------------ *
 * 二、上传：按真实内容判断类型
 * ------------------------------------------------------------------ */

/**
 * 危险类型：能被浏览器当页面/脚本解释的。
 *
 * 「上传功能只收图片和附件」是产品说法，服务端以前一个字都没查：谁都能往
 * `/api/upload` POST 一段 `Content-Type: text/html` 的 `<script>`，拿到
 * `/api/files/raw/<key>` 这个**同源**地址，发给管理员——点开就在你的域里执行，
 * 会话、CSRF、后续所有接口都归它。PDF 里挂 JS、SVG 里写 onload 是同一类。
 *
 * 所以收的时候挡（这里），发的时候再挡一层（见 files.js 的 raw 路由）。
 */
const DANGEROUS_EXT = new Set(['html', 'htm', 'xhtml', 'svg', 'svgz', 'xml', 'xsl', 'js', 'mjs', 'css', 'swf', 'htc'])
const DANGEROUS_MIME = /^(text\/html|application\/xhtml|image\/svg|application\/xml|text\/xml|application\/javascript|text\/javascript|application\/x-shockwave)/i

/** 只认这几种「一看就是文件」的开头，其余按二进制处理 */
function sniff(buf) {
  const b = buf
  const hex = (n) => b.slice(0, n).toString('hex').toLowerCase()
  if (b.length >= 8 && hex(8) === '89504e470d0a1a0a') return 'image/png'
  if (b.length >= 3 && hex(3) === 'ffd8ff') return 'image/jpeg'
  if (b.length >= 4 && hex(4) === '47494638') return 'image/gif'
  if (b.length >= 12 && hex(4) === '52494646' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp'
  if (b.length >= 5 && b.slice(0, 5).toString() === '%PDF-') return 'application/pdf'
  if (b.length >= 4 && hex(4) === '504b0304') return 'application/zip'
  if (b.length >= 2 && hex(2) === 'ffd8') return 'image/jpeg'
  // tar / gzip 这类备份包也走上传（导入备份用的是另一个接口，这里只做兼容）
  if (b.length >= 2 && hex(2) === '1f8b') return 'application/gzip'
  return ''
}

/** 文本里像不像 HTML/SVG：没有扩展名时靠这个兜底 */
function looksLikeMarkup(buf) {
  const head = buf.slice(0, 512).toString('utf8').trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<svg') ||
    head.startsWith('<?xml') || /<script[\s>]/.test(head)
}

/**
 * 校验一次上传。返回 { ok, mime, name, reason }。
 *
 * 判定顺序：先看声明的扩展名与 MIME（明确的坏名字直接拒），再看文件头
 * （图片声称是图片但头不对，说明是被改名的东西），最后看文本内容
 * （没扩展名的裸上传也得挡住 HTML）。
 */
export function checkUpload({ name, buf, mime }) {
  const safeName = path.basename(String(name || 'file')).replace(/[\u0000-\u001f]/g, '')
  const ext = path.extname(safeName).slice(1).toLowerCase()
  if (!safeName || safeName === '.' || safeName === '..') return { ok: false, reason: '文件名不合法' }
  if (DANGEROUS_EXT.has(ext)) return { ok: false, reason: `出于安全考虑不接受 .${ext} 文件（浏览器会把它当页面执行）` }
  if (DANGEROUS_MIME.test(String(mime || ''))) return { ok: false, reason: '出于安全考虑不接受网页 / 脚本类文件' }
  const real = sniff(buf)
  if (real) {
    // 声明成图片却拿别的格式来充数：不是「用户不懂」，是把可执行内容伪装成图片
    if (/^image\//i.test(mime || '') && !real.startsWith('image/')) return { ok: false, reason: '文件内容与声明的类型不符' }
    return { ok: true, mime: real.startsWith('image/') ? real : (mime || real), name: safeName }
  }
  if (looksLikeMarkup(buf)) return { ok: false, reason: '文件内容像网页，出于安全考虑不接受' }
  return { ok: true, mime: mime && !DANGEROUS_MIME.test(mime) ? mime : 'application/octet-stream', name: safeName }
}

/**
 * 读取已落盘文件时用什么 Content-Type、要不要强制下载。
 *
 * 与 checkUpload 是两个方向：那边管「进来」，这里管「出去」。
 * 存量文件可能早于这套校验（比如升级前传上去的 .html），所以出去这一层不能省。
 * 一律加 Content-Security-Policy: sandbox —— 万一同源地址被当成页面打开，
 * 它也没有脚本执行权、没有同源权限。
 */
const INLINE_OK = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|text\/plain|audio\/|video\/)/i

export function dispositionFor({ name, mime }) {
  const ext = path.extname(String(name || '')).slice(1).toLowerCase()
  const inline = INLINE_OK.test(String(mime || '')) && !DANGEROUS_EXT.has(ext)
  const ascii = String(name || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(name || 'file'))}`
}

export const RAW_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // sandbox 同时去掉脚本与同源身份；allow-popups 只是让「在新窗口打开」不至于连图片都看不了
  'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox allow-popups"
}

/* ------------------------------------------------------------------ *
 * 三、频率：按 IP + 路由桶的滑动窗口
 * ------------------------------------------------------------------ */

/**
 * 匿名接口的限流。
 *
 * 公开填写、上传、答卷查询这三类不需要登录，也就没有任何天然的成本：
 * 一个 `while true; do curl ...; done` 就能把库灌满、把磁盘塞满、把 CPU 吃光。
 * 登录接口早就有失败锁定，公开接口此前一个都没有。
 *
 * 用固定窗口而不是精确滑动：目的是「让脚本变慢」，不是「精确计费」。
 * 计数只留最近两个窗口，内存不会随攻击时长增长。
 */
const buckets = new Map()

export function rateLimit({ key, limit, windowMs }) {
  const now = Date.now()
  let b = buckets.get(key)
  if (!b) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b) }
  if (now > b.reset) { b.count = 0; b.reset = now + windowMs }
  b.count++
  // 桶按「IP + 用途」铺开，攻击者换 IP 就会长；超过一定规模先清掉过期的，
  // 保证内存不随攻击时长无限增长
  if (buckets.size > 20000) for (const [k2, v2] of buckets) if (v2.reset < now) buckets.delete(k2)
  if (b.count > limit) {
    const sec = Math.ceil((b.reset - now) / 1000)
    return { ok: false, retryAfter: sec }
  }
  return { ok: true }
}

/** 测试与「改配置立即生效」用：清空所有计数 */
export function resetRateLimits() { buckets.clear() }

export function publicLimit(name) {
  const s = setting('site', {}) || {}
  const cfg = s.rateLimit || {}
  // 每分钟每 IP 的默认额度。submit 给到 120：一个班里 40 个人连同一台 NAT 出口
  // 在同一分钟交卷是正常场面；而脚本灌库是每秒几十上百次，120 仍然拦得住。
  const defaults = { submit: 120, upload: 60, query: 120 }
  const n = Number(cfg[name] ?? defaults[name] ?? 60)
  return Number.isFinite(n) && n > 0 ? n : defaults[name]
}
