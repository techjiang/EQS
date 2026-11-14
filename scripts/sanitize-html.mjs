#!/usr/bin/env node
/**
 * 存量富文本清洗。
 *
 * 白名单（web/js/sanitize.js）是第 29 轮才有的，只在**写入时**生效。
 * 升级前落库的 richtext / html 正文没经过它——那些 HTML 至今仍被
 * 「公开填写页」innerHTML 渲染，也就是任何拿到链接的人都会中招。
 * 代码改了不等于旧数据干净了，这个脚本负责把历史那一批补齐。
 *
 * 用法：
 *   node scripts/sanitize-html.mjs            # 只体检，不写库（默认）
 *   node scripts/sanitize-html.mjs --apply    # 真的写回
 *   node scripts/sanitize-html.mjs --db /path/to/eqs.db [--apply]
 *
 * 默认不写库是有意的：这是批量改写用户内容，得先看清它要动什么。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sanitizeHtml } from '../web/js/sanitize.js'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const dbArg = argv.indexOf('--db')
const dataDir = process.env.EQS_DATA_DIR || path.join(process.cwd(), 'data')
const dbPath = dbArg >= 0 ? argv[dbArg + 1] : (process.env.EQS_DB_FILE || path.join(dataDir, 'eqs.db'))

if (!fs.existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}`)
  console.error('请在 EQS 的根目录下运行，或用 --db 指定 eqs.db 的位置。')
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
const rows = db.prepare('SELECT id, title, schema FROM forms').all()

let scanned = 0      // 查过的富文本字段数
let dirty = 0        // 需要改的字段数
let changedForms = 0 // 受影响的表单数
const samples = []

const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript'])

/** 说清楚「它到底脏在哪」：只报「已清洗」的话，用户没法判断该不该 apply */
function reasonOf(before, after) {
  const tags = []
  if (/\son[a-z]+\s*=/i.test(before)) tags.push('事件属性 on*')
  if (/javascript:/i.test(before)) tags.push('javascript: 协议')
  if (/data:text\/html/i.test(before)) tags.push('data:text/html')
  if (/<(script|iframe|object|embed|svg|math|style|noscript)[\s>]/i.test(before)) tags.push('可执行标签')
  for (const m of before.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    if (DROP.has(m[1].toLowerCase())) { if (!tags.includes('可执行标签')) tags.push('可执行标签'); break }
  }
  if (before.length !== after.length && !tags.length) tags.push('不规范标签/属性')
  return tags.length ? tags.join(' / ') : '细节差异'
}

for (const row of rows) {
  let schema
  try { schema = JSON.parse(row.schema) } catch { continue }
  if (!Array.isArray(schema)) continue
  let touched = false
  schema.forEach((f, i) => {
    if (!f || (f.type !== 'richtext' && f.type !== 'html')) return
    const before = f.props?.html
    if (typeof before !== 'string' || !before) return
    scanned++
    const after = sanitizeHtml(before)
    if (after === before) return
    dirty++
    touched = true
    if (samples.length < 5) {
      samples.push({ form: `#${row.id} ${row.title}`, index: i + 1, reason: reasonOf(before, after), before, after })
    }
    if (apply) f.props.html = after
  })
  if (apply && touched) {
    db.prepare('UPDATE forms SET schema = ? WHERE id = ?').run(JSON.stringify(schema), row.id)
    changedForms++
  }
}

console.log(`数据库：${dbPath}`)
console.log(`扫过 ${rows.length} 张表单的 ${scanned} 段富文本，其中 ${dirty} 段需要清洗${apply ? '（已写回）' : ''}`)
if (apply) console.log(`改动落在 ${changedForms} 张表单上`)

for (const s of samples) {
  console.log(`\n— ${s.form} 第 ${s.index} 个富文本组件 · ${s.reason}`)
  console.log('  原：' + s.before.replace(/\s+/g, ' ').slice(0, 160))
  console.log('  新：' + s.after.replace(/\s+/g, ' ').slice(0, 160))
}
if (dirty > samples.length) console.log(`\n（另有 ${dirty - samples.length} 段未列出）`)

db.close()

if (dirty && !apply) {
  console.log('\n这是体检结果，库没有改动。确认无误后加 --apply 执行清洗：')
  console.log('  node scripts/sanitize-html.mjs --apply')
  console.log('提示：先跑一次 bash scripts/backup.sh，回滚更省事。')
}
if (!dirty) console.log('\n存量数据没有问题，无需清洗。')
