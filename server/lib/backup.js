import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { db, dbFile, DATA_DIR, switchDb } from './db.js'
import { writeZipStream, openZipFile, extractZipEntryToFile } from './zip.js'

/*
 * 备份与迁移。
 *
 * 这一块以前有两个「一直存在、但没人撞上」的坑，都是拿真实体量打出来的：
 *
 * 1. 导出把整个 data 目录 readFileSync 进内存再拼成一个 Buffer。
 *    107MB 的库导出时响应 138MB、进程 RSS 从 90MB 涨到 365MB——而且这是「一个管理员点一下」
 *    的代价。真实站点里 data/files 常有几个 G，这条路走得通只是因为没人拿大盘子备过份。
 *
 * 2. 导入先 readBody(64MB)，再把整个包交给内存版解包，最后直接 switchDb 顶替。
 *    于是 138MB 的备份在导入这一步直接 413「请求体过大」——**自己导出的备份，自己导不回来**。
 *    更糟的是顶替前没有任何校验：塞一个内容不是 SQLite 的 eqs.db 进去，
 *    库被换了，进程从此每次查询都报 `statement has been finalized`，只能手工救。
 *
 * 所以这里重做成：流式导出（内存只跟单块有关）、流式落盘解包、导入前校验 + 自动快照、
 * 以及一个能把上一次导入撤回去的回滚接口。
 */

export const BACKUP_DIR = path.join(DATA_DIR, '.backups')
const SNAPSHOT_KEEP = 5
const APP_VERSION = '1.0.0'

/** 备份包里的数据库路径约定，导入端也按这个找 */
const DB_ENTRY = 'eqs-data/eqs.db'
const MANIFEST_ENTRY = 'eqs-data/manifest.json'

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir }

const pad = n => String(n).padStart(2, '0')
export function stampNow() {
  const d = new Date()
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * 一致的数据库快照。
 * WAL 模式下新数据先落在 eqs.db-wal，直接拷主文件会得到一个缺了最近写入的库。
 * `VACUUM INTO` 由 SQLite 自己在事务视图里导出，服务运行中调用也安全——
 * 而且顺带把碎片压掉，产物比原文件小。
 */
export function snapshotDb(dest) {
  ensureDir(path.dirname(dest))
  fs.rmSync(dest, { force: true })
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  } catch (e) {
    // VACUUM INTO 失败时退到 checkpoint + 拷贝：至少别让备份这一步直接没有产物
    console.error('[EQS] VACUUM INTO 失败，改用 checkpoint + 复制', e.message)
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch {}
    fs.copyFileSync(dbFile, dest)
  }
  return dest
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('data', c => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

/** 遍历数据目录，排除备份快照与 WAL 残留 */
function listDataFiles(root = DATA_DIR, prefix = '', out = []) {
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name)
    if (!prefix && name === '.backups') continue
    // 主库单独一条走快照，普通遍历里再收一次就变成包内重复条目（导入端读到哪一份全看运气）
    if (!prefix && name === 'eqs.db') continue
    if (name.endsWith('-wal') || name.endsWith('-shm')) continue
    const st = fs.statSync(full)
    const rel = prefix ? `${prefix}/${name}` : name
    if (st.isDirectory()) listDataFiles(full, rel, out)
    else out.push({ rel, full, size: st.size })
  }
  return out
}

/** 已经压过一次的格式再压没意义，白烧 CPU（照片、视频、zip） */
const ALREADY_COMPRESSED = /\.(png|jpe?g|gif|webp|mp4|mov|zip|gz|xlsx|docx|pptx|pdf|woff2?)$/i

/**
 * 流式导出：先把库做成一致快照，再把「清单 → 库 → 附件」一条条灌进 zip。
 * 整个过程内存里只有清单和写入缓冲，与数据目录大小无关。
 */
export async function exportBackupStream(out, { onProgress } = {}) {
  const tmp = path.join(ensureDir(path.join(BACKUP_DIR, 'tmp')), `export-${process.pid}-${Date.now()}.db`)
  try {
    snapshotDb(tmp)
    const dbBytes = fs.statSync(tmp).size
    const dbSha = await sha256File(tmp)
    const files = listDataFiles()
    // 附件按存储路径落在 files/ 下，db 单独一条，清单放最前面：导入端第一眼就能读到它
    const entries = []
    const manifest = {
      format: 2,
      app: 'EQS',
      version: APP_VERSION,
      createdAt: new Date().toISOString(),
      db: { entry: DB_ENTRY, bytes: dbBytes, sha256: dbSha },
      files: { count: files.length, bytes: files.reduce((a, f) => a + f.size, 0) },
      counts: (() => {
        try {
          const c = k => db.prepare(`SELECT COUNT(*) c FROM ${k}`).get().c
          return { users: c('users'), forms: c('forms'), submissions: c('submissions'), banks: c('banks'), questions: c('questions') }
        } catch { return null }
      })()
    }
    entries.push({ name: MANIFEST_ENTRY, data: JSON.stringify(manifest, null, 2), compress: true })
    entries.push({ name: DB_ENTRY, file: tmp, compress: true })
    for (const f of files) {
      entries.push({ name: `eqs-data/${f.rel}`, file: f.full, compress: !ALREADY_COMPRESSED.test(f.rel), size: f.size })
    }
    onProgress?.({ phase: 'writing', entries: entries.length, dbBytes })
    const result = await writeZipStream(entries, out)
    onProgress?.({ phase: 'done', ...result })
    return { manifest, ...result }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/* ---------------- 导入 ---------------- */

/**
 * 把一个文件流写到磁盘，而不是 readBody 进内存。
 * 备份包和「请求体」不是一回事：几 G 的备份包不该由 64MB 的上限决定能不能导回来。
 */
export async function saveRequestToFile(req, dest, limitBytes = 8 * 1024 * 1024 * 1024) {
  ensureDir(path.dirname(dest))
  let size = 0
  const ws = fs.createWriteStream(dest)
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > limitBytes) throw Object.assign(new Error('备份文件超过 8GB 上限'), { status: 413 })
      if (!ws.write(chunk)) await new Promise(r => ws.once('drain', r))
    }
    await new Promise((resolve, reject) => { ws.end(resolve); ws.on('error', reject) })
    return { size }
  } catch (e) {
    ws.destroy()
    throw e
  }
}

/** 从 multipart 里定位文件段（只要它的偏移，不要内容） */
export function locateMultipartFile(buf, boundary) {
  const txt = buf.toString('latin1')
  const marker = `--${boundary}`
  let at = txt.indexOf(marker)
  while (at >= 0) {
    const headEnd = txt.indexOf('\r\n\r\n', at)
    if (headEnd < 0) break
    const header = txt.slice(at, headEnd)
    const nextAt = txt.indexOf(marker, headEnd)
    if (nextAt < 0) break
    if (/filename="/.test(header)) {
      const start = headEnd + 4
      // 结尾是 "\r\n" + marker
      const end = nextAt - 2
      const name = /filename="([^"]*)"/.exec(header)?.[1] || 'backup.zip'
      if (end > start) return { start, end, name }
    }
    at = nextAt
  }
  return null
}

export const REQUIRED_TABLES = ['users', 'forms', 'submissions', 'settings']

let sqliteMod = null

/**
 * 校验一个候选数据库能不能顶替当前库。
 *
 * 这里少一步的代价是实测过的：塞一个内容不是 SQLite 的 eqs.db 进备份包，
 * 导入接口先 switchDb 顶替成功，然后进程里所有预编译语句全部失效，
 * 此后每个请求都回一句 `statement has been finalized`，只能手工救。
 * 所以顺序必须是「先验、后换」：文件头、integrity_check、核心表，一个都不能省。
 */
export function validateDatabase(file) {
  let conn = null
  try {
    if (!sqliteMod) throw new Error('SQLite 模块未就绪')
    const { DatabaseSync } = sqliteMod
    conn = new DatabaseSync(file, { readOnly: true })
    // 只读头 16 字节：几 G 的库不该为了看一眼 magic 就整个读进内存
    const fd = fs.openSync(file, 'r')
    const magic = Buffer.alloc(16)
    try { fs.readSync(fd, magic, 0, 16, 0) } finally { fs.closeSync(fd) }
    const header = magic.toString('latin1')
    if (header !== 'SQLite format 3\u0000') return { ok: false, reason: '备份包里的 eqs.db 不是 SQLite 数据库（文件头不对）' }
    const check = conn.prepare('PRAGMA integrity_check').get()
    const verdict = check?.integrity_check
    if (verdict && verdict !== 'ok') return { ok: false, reason: `备份里的数据库校验不通过：${verdict}` }
    const rows = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    const missing = REQUIRED_TABLES.filter(t => !rows.includes(t))
    if (missing.length) return { ok: false, reason: `备份里的数据库缺少核心表：${missing.join(', ')}` }
    return { ok: true, tables: rows.length }
  } catch (e) {
    return { ok: false, reason: `备份里的数据库无法打开：${e.message}` }
  } finally {
    try { conn?.close() } catch {}
  }
}

/** 静态 import 会和 db.js 形成环，所以第一次用的时候再加载 */
export async function sqliteReady() {
  if (!sqliteMod) sqliteMod = await import('node:sqlite')
  return sqliteMod
}

/** 导入前的自动快照：导入是可撤销的，前提是「撤销」这件事已经被存下来 */
export function createPreImportSnapshot(reason = 'import') {
  const name = `${reason}-${stampNow()}.db`
  const dest = path.join(ensureDir(BACKUP_DIR), name)
  snapshotDb(dest)
  pruneSnapshots()
  return { name, path: dest, bytes: fs.statSync(dest).size }
}

export function listSnapshots() {
  if (!fs.existsSync(BACKUP_DIR)) return []
  return fs.readdirSync(BACKUP_DIR)
    .filter(n => n.endsWith('.db'))
    .map(n => {
      const full = path.join(BACKUP_DIR, n)
      const st = fs.statSync(full)
      return { name: n, bytes: st.size, createdAt: st.mtime.toISOString(), kind: n.startsWith('pre-import') ? 'import' : n.startsWith('pre-rollback') ? 'rollback' : 'manual' }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function pruneSnapshots() {
  const list = listSnapshots().filter(s => s.kind !== 'manual')
  for (const s of list.slice(SNAPSHOT_KEEP)) fs.rmSync(path.join(BACKUP_DIR, s.name), { force: true })
}

/** 回滚到指定快照（默认最近一个）；回滚前先把当前状态也存一份，回滚本身也可撤销 */
export function rollbackToSnapshot(name) {
  const snaps = listSnapshots()
  const target = name ? snaps.find(s => s.name === name) : snaps[0]
  if (!target) {
    const e = new Error('没有可回滚的快照')
    e.status = 404
    throw e
  }
  const check = validateDatabase(path.join(BACKUP_DIR, target.name))
  if (!check.ok) {
    const e = new Error(check.reason)
    e.status = 400
    throw e
  }
  const safety = createPreImportSnapshot('pre-rollback')
  switchDb(path.join(BACKUP_DIR, target.name))
  return { restored: target.name, safety: safety.name }
}

/**
 * 从已落盘的 multipart 请求体里把文件段抠出来，得到裸 zip。
 *
 * 为什么不直接在内存里 parseMultipart：备份包是我们自己导出的东西，
 * 常驻几百 MB 到几 G，readBody 会在 64MB 处直接 413 —— 于是「自己导出的备份自己导不回来」。
 * 这里整段流式扫描：请求体先落盘，再按 boundary 找偏移，最后按字节区间搬一次。
 */
export async function extractMultipartFile(rawPath, boundary, destZip) {
  const marker = Buffer.from(`--${boundary}`)
  const crlfMarker = Buffer.from(`\r\n--${boundary}`)
  const headSep = Buffer.from('\r\n\r\n')
  const CHUNK = 4 * 1024 * 1024
  // 窗口要能跨块匹配：留两个 marker 长度的重叠
  const overlap = Math.max(crlfMarker.length, headSep.length) * 2
  const fd = fs.openSync(rawPath, 'r')
  const size = fs.fstatSync(fd).size
  let carry = Buffer.alloc(0)
  let base = 0
  let pending = null      // { start, name } 已定位到文件内容起点
  let found = null
  try {
    for (let pos = 0; pos < size && !found; pos += CHUNK) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos))
      fs.readSync(fd, buf, 0, buf.length, pos)
      const view = Buffer.concat([carry, buf])
      const viewBase = base
      if (!pending) {
        // 还没见到文件段：找 header 与正文的交界
        const headEnd = view.indexOf(headSep)
        if (headEnd >= 0) {
          // 段头可能被切在上一块里，所以从本块起点往回看一个 overlap
          const segStart = Math.max(0, view.lastIndexOf(marker, headEnd))
          const header = view.slice(segStart, headEnd).toString('utf8')
          if (/filename="/.test(header)) {
            pending = {
              start: viewBase + headEnd + headSep.length,
              name: /filename="([^"]*)"/.exec(header)?.[1] || 'backup.zip'
            }
          } else {
            // 不是文件段（比如普通字段），跳过这一段的头继续找
            carry = view.slice(headEnd)
            base = viewBase + headEnd
            continue
          }
        }
      }
      if (pending) {
        // 正文结束标记：\r\n--boundary
        const at = view.indexOf(crlfMarker)
        if (at >= 0) {
          found = { start: pending.start, end: viewBase + at, name: pending.name }
          break
        }
      }
      carry = view.slice(Math.max(0, view.length - overlap))
      base = viewBase + view.length - carry.length
    }
  } finally {
    fs.closeSync(fd)
  }
  if (!found) {
    const e = new Error('未在请求体里找到上传的备份文件')
    e.status = 400
    throw e
  }
  if (found.end <= found.start) {
    const e = new Error('备份文件是空的')
    e.status = 400
    throw e
  }
  await copyRange(rawPath, destZip, found.start, found.end)
  return { name: found.name, bytes: found.end - found.start }
}

/** 按字节区间搬一段文件，不经过内存 */
async function copyRange(src, dest, start, end) {
  ensureDir(path.dirname(dest))
  const rfd = fs.openSync(src, 'r')
  const ws = fs.createWriteStream(dest)
  try {
    const CH = 4 * 1024 * 1024
    let pos = start
    while (pos < end) {
      const len = Math.min(CH, end - pos)
      const buf = Buffer.alloc(len)
      fs.readSync(rfd, buf, 0, len, pos)
      if (!ws.write(buf)) await new Promise(r => ws.once('drain', r))
      pos += len
    }
    await new Promise((resolve, reject) => { ws.end(resolve); ws.on('error', reject) })
  } finally {
    fs.closeSync(rfd)
  }
}

/**
 * 解包一个备份 zip 到数据目录（附件按「只补不删」合并）。
 * 每个条目单独从磁盘区间解，内存里只有一块。
 */
export async function restoreFiles(zip, targetRoot = DATA_DIR) {
  let added = 0
  let skipped = 0
  let bytes = 0
  const filesDir = path.join(targetRoot, 'files')
  ensureDir(filesDir)
  for (const entry of zip.entries) {
    if (!entry.name.startsWith('eqs-data/files/')) continue
    const rel = entry.name.slice('eqs-data/files/'.length)
    const target = path.join(filesDir, rel)
    // 路径穿越一律跳过：备份包是用户上传的，不该有写库目录之外的权力
    if (!path.resolve(target).startsWith(path.resolve(filesDir))) { skipped++; continue }
    if (fs.existsSync(target)) { skipped++; continue }
    ensureDir(path.dirname(target))
    await extractZipEntryToFile(zip, entry, target)
    added++
    bytes += entry.uncompSize || 0
  }
  return { added, skipped, bytes }
}

/* ---------------- 备份包体检 ----------------
 *
 * 导入这一步现在会验库（文件头、integrity_check、核心表），但**不验附件**。
 * 于是「导入成功」这四个字仍然只是一句关于 eqs.db 的结论：
 * 备份包里的 zip 是人工拷来拷去的，断点续传中断、网盘同步失败、tar 少拿一层目录，
 * 都能做出一个「库好、附件缺一半」的包 —— 导入完照样弹「导入成功，附件补入 0 项」，
 * 而那半张答卷上的小抄照片、身份证扫描件，在没人点开之前谁都不知道它没了。
 *
 * 所以多一步只读体检：拿包里的库自述去对包里的条目，缺了哪几个、是谁的、属于哪张表单，
 * 一条条列出来。体检不改任何东西，也不顶替现有数据。
 */

const FILES_PREFIX = 'eqs-data/files/'

/** 小文件用 KB、大文件用 MB：一律报「0.0MB」等于什么都没说 */
function humanBytes(n) {
  if (n < 1024) return `${n}B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1048576).toFixed(1)}MB`
}
export { humanBytes }

/**
 * @param zipPath 已落盘的备份 zip
 * @returns {Promise<{ok:boolean, db:object, files:object, warnings:string[], errors:string[]}>}
 */
export async function inspectBackup(zipPath) {
  const warnings = []
  const errors = []
  const zip = openZipFile(zipPath)
  if (!zip) {
    return { ok: false, db: null, files: null, warnings, errors: ['无法读取压缩包目录，请用 EQS 导出的备份文件'] }
  }

  await sqliteReady()
  const dbEntry = zip.entries.find(e => e.name === DB_ENTRY)
  const mEntry = zip.entries.find(e => e.name === MANIFEST_ENTRY)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eqs-inspect-'))
  try {
    let manifest = null
    if (mEntry) {
      const mPath = path.join(tmpDir, 'manifest.json')
      await extractZipEntryToFile(zip, mEntry, mPath)
      try { manifest = JSON.parse(fs.readFileSync(mPath, 'utf8')) } catch { warnings.push('清单 manifest.json 存在但不是合法 JSON，已忽略') }
    } else {
      warnings.push('包里没有 manifest.json（老版本备份）：无法核对清单里报的文件数与数据库摘要')
    }

    /* ---------- 数据库 ---------- */
    let db = null
    const refs = []
    if (!dbEntry) {
      errors.push('备份包里没有 eqs-data/eqs.db，不是 EQS 的备份文件')
    } else {
      const incoming = path.join(tmpDir, 'eqs.db')
      await extractZipEntryToFile(zip, dbEntry, incoming)
      const check = validateDatabase(incoming)
      db = { ...check, entry: DB_ENTRY, bytes: fs.statSync(incoming).size }
      if (!check.ok) errors.push(check.reason)
      // 清单说这个库是多少字节、什么摘要，实物对不对得上
      if (check.ok && manifest?.db?.sha256) {
        const got = await sha256File(incoming)
        db.sha256Match = got === manifest.db.sha256
        if (!db.sha256Match) errors.push('库文件的 SHA-256 与清单不符（包被改过，或导出时写坏了）')
      }
      if (check.ok && manifest?.db?.bytes && manifest.db.bytes !== db.bytes) {
        warnings.push(`清单记的库大小 ${manifest.db.bytes} 字节，实际 ${db.bytes} 字节`)
      }
      if (check.ok) {
        // 拿包里这个库自己的 files 表当参照：附件应该有哪些，只有它知道
        let conn = null
        try {
          const { DatabaseSync } = sqliteMod
          conn = new DatabaseSync(incoming, { readOnly: true })
          const titles = new Map(conn.prepare('SELECT id, title FROM forms').all().map(f => [f.id, f.title]))
          for (const r of conn.prepare('SELECT id, name, stored, size, driver, form_id FROM files').all()) {
            refs.push({ ...r, formTitle: titles.get(r.form_id) || '' })
          }
        } catch (e) {
          warnings.push(`无法读取包内 files 表：${e.message}`)
        } finally {
          try { conn?.close() } catch {}
        }
      }
    }

    /* ---------- 附件 ---------- */
    const fileEntries = zip.entries.filter(e => e.name.startsWith(FILES_PREFIX))
    const inZip = new Map(fileEntries.map(e => [e.name.slice(FILES_PREFIX.length), e]))
    let unreferencedBytes = 0
    let unreferenced = 0
    const missing = []
    let present = 0
    let remote = 0
    const referencedLocal = new Set()
    for (const r of refs) {
      if (r.driver && r.driver !== 'local') { remote++; continue }
      referencedLocal.add(r.stored)
      if (inZip.has(r.stored)) present++
      else missing.push({ id: r.id, name: r.name, stored: r.stored, formId: r.form_id, formTitle: r.formTitle, size: r.size })
    }
    for (const [stored] of inZip) {
      if (!referencedLocal.has(stored)) { unreferenced++; unreferencedBytes += inZip.get(stored).uncompSize || 0 }
    }
    const zipBytes = fileEntries.reduce((a, e) => a + (e.uncompSize || 0), 0)
    const files = {
      inZip: fileEntries.length,
      bytes: zipBytes,
      referenced: refs.length,
      localReferenced: referencedLocal.size,
      present,
      missing: missing.slice(0, 50),
      missingCount: missing.length,
      missingBytes: missing.reduce((a, m) => a + (m.size || 0), 0),
      remote,
      unreferenced,
      unreferencedBytes
    }
    if (files.missingCount) {
      errors.push(`库里有 ${files.missingCount} 个本地附件在包里找不到（合计 ${humanBytes(files.missingBytes)}）`)
    }
    if (unreferenced) warnings.push(`包里有 ${unreferenced} 个文件没有任何记录引用（孤儿文件，不影响导入）`)
    if (manifest?.files?.count != null && manifest.files.count !== fileEntries.length) {
      warnings.push(`清单记的附件 ${manifest.files.count} 个，包里实际 ${fileEntries.length} 个`)
    }
    // 条目的 CRC 只在真正解出来时才算得动，这里只核长度：长度不对的一定是坏条目
    const badEntry = fileEntries.find(e => e.compSize > 0 && e.localOffset + e.compSize > zip.size)
    if (badEntry) errors.push(`附件条目越界：${badEntry.name}`)

    return {
      ok: errors.length === 0,
      manifest: manifest ? { format: manifest.format, version: manifest.version, createdAt: manifest.createdAt, counts: manifest.counts } : null,
      db,
      files,
      warnings,
      errors
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
