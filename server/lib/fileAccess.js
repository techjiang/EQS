import crypto from 'node:crypto'
import { SECRET } from './auth.js'

/**
 * 附件下载鉴权。
 *
 * 前几轮把「上传」这条路堵死了（不认 .html、按文件头判类型、出站强制下载 + sandbox CSP），
 * 但**读取**这一头一直是敞开的：`/api/files/raw/<key>` 不需要任何身份，谁拿到 key 谁就能取。
 * key 里有 8 字节随机数，猜不到——问题是「猜不到」不是「有权限」：
 * 一个链接贴进群里、一封邮件被转发、一次浏览器同步，key 就永久有效，且无法撤销。
 * 答卷附件里是小抄照片、身份证、薪资表，这类东西不该靠「URL 没人知道」来保护。
 *
 * 现在两条路都能进，但都得先过身份：
 *   1. 签名票据：`?e=<过期时间戳>&s=<HMAC>`。匿名填表的人刚传完文件、还没交卷，
 *      手上没有会话，只能靠这个。有效期有限，且只对这一个 key 生效。
 *   2. 登录身份：管理员、文件归属者、以及该文件所属表单的协作者。
 *      管理端页面直接点链接就是这条路——浏览器自动带 Cookie，不用在 URL 里塞票据
 *      （URL 会进历史记录、日志、Referer，能不带就不带）。
 *
 * 存量数据不受影响：库里 `files.url` 存的仍是不带参数的路径，
 * 前端在已登录状态下点开照样能取，只是匿名访问从此不再成立。
 */

/** 匿名上传后的预览窗口：够填完一份带附件的问卷，又不足以当成长期外链 */
export const ANON_FILE_TTL = 6 * 3600 * 1000
/** 匿名查回自己答卷时的窗口：看一眼就走，不需要更久 */
export const QUERY_FILE_TTL = 1 * 3600 * 1000

const RAW_PREFIX = '/api/files/raw/'

const digest = (key, exp) => crypto.createHmac('sha256', SECRET).update(`${key}\n${exp}`).digest('base64url').slice(0, 32)

/**
 * 给本地存储的文件地址签一个限期票据；不是本地地址（OSS/CDN）原样返回。
 * 先摘掉地址上原有的票据再签：设计器里存下来的头图可能已经带着上一张，
 * 直接拼会得到 `...?e=1&s=x?e=2&s=y` 这种把 key 也一起算进去的坏地址。
 */
export function signFileUrl(url, ttl = ANON_FILE_TTL) {
  const m = new RegExp(`^${RAW_PREFIX}([^?#]+)(?:\\?.*)?$`).exec(String(url || ''))
  if (!m) return url
  const key = m[1]
  const exp = Date.now() + ttl
  return `${RAW_PREFIX}${key}?e=${exp}&s=${digest(key, exp)}`
}

/** 票据是否有效（未过期、且确实是我们为这个 key 签的） */
export function verifyFileTicket(key, e, s) {
  const exp = Number(e)
  if (!Number.isFinite(exp) || exp <= 0) return false
  const want = Buffer.from(digest(key, exp))
  const got = Buffer.from(String(s || ''))
  // 长度不等时 timingSafeEqual 会抛，先比长度；这里比较的是定长摘要，不泄露信息
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false
  return Date.now() <= exp
}

/**
 * 把一份作答里的附件地址换成带票据的。
 * 只给匿名侧用（交卷后按编号查回自己的答卷），管理端统一走会话，URL 里不带凭据。
 */
export function signFileUrls(value, ttl = QUERY_FILE_TTL) {
  if (typeof value === 'string') return value.startsWith(RAW_PREFIX) ? signFileUrl(value, ttl) : value
  if (Array.isArray(value)) return value.map(v => signFileUrls(v, ttl))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = signFileUrls(v, ttl)
    return out
  }
  return value
}

/**
 * 落库前把地址上的票据摘掉。
 *
 * 票据是「此刻给这个浏览器的通行证」，有效期几小时；答卷可能几年后还有人打开。
 * 把带票据的地址存进库，等于给这份数据定了个保质期——过期之后管理端还能靠会话取到，
 * 但导出的 Excel、WebHook 推出去的 JSON 里就只剩一条打不开的链接。
 * 所以库里一律存规范路径，取的时候再按当前身份的权限现签。
 */
export function normalizeFileUrls(value) {
  if (typeof value === 'string') {
    const m = new RegExp(`^${RAW_PREFIX}([^?#]+)(?:\\?.*)?$`).exec(value)
    if (m) return RAW_PREFIX + m[1]
    // 富文本正文里的地址不是「一整条 URL」，是夹在 HTML 里的一段，得按属性抠
    return normalizeHtmlFiles(value)
  }
  if (Array.isArray(value)) return value.map(normalizeFileUrls)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = normalizeFileUrls(v)
    return out
  }
  return value
}

/**
 * 富文本里内嵌的图片同样落在 /api/files/raw 下。
 * 作者把图片传到正文里、再发给所有填写人，这些访客没有会话——
 * 不换签就是一片裂图。只改 src 属性的值，别的一个字不动。
 */
export function signHtmlFiles(html, ttl = ANON_FILE_TTL) {
  return String(html || '').replace(/(\ssrc=")(\/api\/files\/raw\/[^"]*)(")/g, (_, a, url, b) => a + signFileUrl(url, ttl) + b)
}

/**
 * 富文本正文里的地址去票据。属性里的 `&` 可能已经被写成 `&amp;`（HTML 转义），两种都认。
 */
export function normalizeHtmlFiles(html) {
  return String(html || '').replace(/(\ssrc=")(\/api\/files\/raw\/[^"]*)(")/g, (_, a, url, b) => {
    const key = /^\/api\/files\/raw\/([^?#]+)/.exec(url)?.[1]
    return key ? a + RAW_PREFIX + key + b : a + url + b
  })
}
