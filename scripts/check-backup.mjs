#!/usr/bin/env node
/**
 * 备份包体检（只读）。
 *
 * 导入会验库（文件头、integrity_check、核心表），但**不验附件**。
 * 备份包是人工拷来拷去的东西：断点续传一断、网盘同步失败、tar 少拿一层目录，
 * 都能做出一个「库好、附件缺一半」的包——导入时照样显示「导入成功」，
 * 而那些照片在没人点开之前谁都不知道它没了。
 *
 * 用法：
 *   node scripts/check-backup.mjs eqs-backup-20260101-120000.zip
 *   node scripts/check-backup.mjs backup.zip --json     # 机器可读
 *
 * 只读：不写库、不覆盖任何东西，可以在生产机上直接跑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const target = argv.find(a => !a.startsWith('--'))
if (!target) {
  console.error('用法：node scripts/check-backup.mjs <备份.zip> [--json]')
  process.exit(2)
}
if (!fs.existsSync(target)) {
  console.error(`找不到备份文件：${target}`)
  process.exit(2)
}

// backup.js 会顺带拉起 db.js（它要 DATA_DIR）；体检不需要真实数据目录，别在用户机器上建出 ./data
process.env.EQS_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'eqs-check-'))
const { inspectBackup, humanBytes } = await import('../server/lib/backup.js')

const r = await inspectBackup(target)

if (asJson) {
  console.log(JSON.stringify(r, null, 2))
  process.exit(r.ok ? 0 : 1)
}

const mb = n => humanBytes(n)
console.log(`备份包：${target}（${mb(fs.statSync(target).size)}）`)
if (r.manifest) {
  console.log(`清单：format ${r.manifest.format} · 版本 ${r.manifest.version || '-'} · 导出于 ${r.manifest.createdAt || '-'}`)
  const c = r.manifest.counts
  if (c) console.log(`      表单 ${c.forms} · 答卷 ${c.submissions} · 用户 ${c.users} · 题库 ${c.banks} · 题目 ${c.questions}`)
}
if (r.db) {
  console.log(`数据库：${r.db.ok ? '可用' : '有问题'} · ${(r.db.bytes / 1048576).toFixed(1)}MB`)
}
const f = r.files
if (f) {
  console.log(`附件：包里 ${f.inZip} 个（${mb(f.bytes)}）· 库里有记录 ${f.referenced} 个 · 对得上 ${f.present} 个`)
  if (f.remote) console.log(`      另有 ${f.remote} 个存在对象存储，不属于本地文件`)
  if (f.missingCount) console.log(`      缺 ${f.missingCount} 个（${mb(f.missingBytes)}）`)
  if (f.unreferenced) console.log(`      孤儿文件 ${f.unreferenced} 个（${mb(f.unreferencedBytes)}，没记录引用，不影响导入）`)
}
for (const w of r.warnings) console.log(`  提醒：${w}`)
for (const e of r.errors) console.log(`  问题：${e}`)

if (f?.missing?.length) {
  console.log('\n缺失明细（前 50 条）：')
  for (const m of f.missing) {
    console.log(`  #${m.id} ${m.name} · ${m.formTitle || '表单 #' + (m.formId || '-')} · ${mb(m.size || 0)} · ${m.stored}`)
  }
}

console.log(r.ok ? '\n结论：这个包可以导入。' : '\n结论：不建议直接导入，先处理上面的问题。')
process.exit(r.ok ? 0 : 1)
