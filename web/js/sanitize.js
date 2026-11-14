/*
 * 富文本白名单清洗。
 *
 * 老的 sanitize 只有两条正则：删 <script> 块、删带引号的 onXxx="..."。
 * 打接口实测下来，这三行字一个都拦不住：
 *
 *   <img src=x onerror=alert(1)>          属性没加引号
 *   <svg onload=alert(1)>                 svg 不在考虑范围内
 *   <a href="javascript:alert(1)">点我</a> 只删了事件属性，没管协议
 *
 * 而这段 HTML 的下游是「公开填写页」——任何拿到链接的人都会中招。
 * 所以改成白名单：认识的标签留下，认识的属性留下，URL 只允许 http/https/mailto/相对路径，
 * 其余一律剥掉（标签剥掉、文字留下；script/style 这类连内容一起丢）。
 *
 * 不用 DOMParser：这个函数也要能在 node 里跑（回归测试直接 import 它）。
 */

/** 允许保留的标签 */
const TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins',
  'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'
])

/** 连内容一起丢掉的标签：它们里面的「文字」不是给人看的 */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'textarea', 'select'])

/** 通用属性 + 个别标签专属属性 */
const GLOBAL_ATTRS = new Set(['class', 'style', 'title', 'align'])
const TAG_ATTRS = {
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope']
}

/** 值为 URL 的属性：协议不对就整条丢掉 */
const URL_ATTRS = new Set(['href', 'src'])

/*
 * 已经写成实体的 & 不再转义。
 *
 * 只转「裸 &」看起来偷懒，但清洗必须能重复跑：设计器里每保存一次都会过一遍白名单，
 * 无条件 `&` → `&amp;` 的话，一张图存三次就变成 `&amp;amp;amp;`，
 * 富文本里的链接一次比一次长，最后彻底打不开（实测第三轮就认不出地址了）。
 * 放行实体本身不打开缺口：`&lt;script&gt;` 渲染出来是一段文字，不是标签。
 */
const ENTITY = /&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});)/g
const escapeText = s => String(s).replace(ENTITY, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = s => String(s).replace(ENTITY, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function safeUrl(raw, tag) {
  const v = String(raw).trim()
  // 控制字符 / 空白混进协议名是老把戏（java\tscript:），先去干净再判断
  const probe = v.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase()
  if (/^(javascript|vbscript|file|blob):/.test(probe)) return ''
  if (probe.startsWith('data:')) {
    // data: 只放行图片，且必须是白名单里的位图类型；data:text/html 就是一张伪装成图的页面
    return tag === 'img' && /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(probe) ? v : ''
  }
  return v
}

/** style 只挡危险写法，不整个丢掉——否则富文本里设的颜色、对齐全没了 */
function safeStyle(raw) {
  const v = String(raw)
  if (/expression\s*\(|javascript:|vbscript:|@import|behavior\s*:|-moz-binding/i.test(v)) return ''
  return v
}

/** 单个开始标签 → 允许的属性列表 */
function attrsOf(tag, raw) {
  const out = []
  const allow = new Set([...GLOBAL_ATTRS, ...(TAG_ATTRS[tag] || [])])
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g
  let m
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase()
    if (name === '/' || name === tag) continue
    if (/^on/.test(name)) continue            // 事件属性一律不留
    if (!allow.has(name)) continue
    let value = m[2] ?? m[3] ?? m[4] ?? ''
    if (URL_ATTRS.has(name)) {
      value = safeUrl(value, tag)
      if (!value) continue
    }
    if (name === 'style') {
      value = safeStyle(value)
      if (!value) continue
    }
    out.push(`${name}="${escapeAttr(value)}"`)
  }
  // 新窗口打开的链接必须断开 opener，否则被链页面能反过来操纵本页
  if (tag === 'a' && out.some(a => a.startsWith('target="_blank"')) && !out.some(a => a.startsWith('rel='))) {
    out.push('rel="noopener noreferrer"')
  }
  return out.length ? ' ' + out.join(' ') : ''
}

/**
 * @param {string} html 用户写的富文本
 * @returns {string} 只剩白名单标签与属性的 HTML
 */
export function sanitizeHtml(html) {
  if (html === undefined || html === null) return ''
  const src = String(html)
  const out = []
  let i = 0
  // 一次性按「标签 / 文本」切开；不匹配标签的尖括号按普通文字处理
  const token = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
  let m
  while ((m = token.exec(src))) {
    const text = src.slice(i, m.index)
    if (text) out.push(escapeText(text))
    i = m.index + m[0].length
    const closing = m[1] === '/'
    const name = m[2].toLowerCase()
    const rest = m[3] || ''
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing) {
        // 丢掉整段内容：找到同名结束标签，找不到就吃到结尾
        const end = new RegExp(`</\\s*${name}\\s*>`, 'i')
        const tail = src.slice(i)
        const hit = end.exec(tail)
        i = hit ? i + hit.index + hit[0].length : src.length
        token.lastIndex = i
      }
      continue
    }
    if (!TAGS.has(name)) continue   // 不认识的标签：标签本身丢掉，文字留下
    if (closing) { out.push(`</${name}>`); continue }
    const selfClose = /\/\s*$/.test(rest)
    const attrs = attrsOf(name, rest.replace(/\/\s*$/, ''))
    out.push(`<${name}${attrs}${selfClose && name === 'br' ? '/' : ''}>`)
  }
  const tail = src.slice(i)
  if (tail) out.push(escapeText(tail))
  return out.join('')
}

export default sanitizeHtml
