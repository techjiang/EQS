import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = process.env.EQS_DATA_DIR || path.join(process.cwd(), 'data')
fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true })

export const dbFile = process.env.EQS_DB_FILE || path.join(DATA_DIR, 'eqs.db')
export let db = new DatabaseSync(dbFile)

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`)

const now = () => new Date().toISOString()

db.exec(`
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  perms TEXT NOT NULL DEFAULT '[]',
  builtin INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS depts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  role_id INTEGER NOT NULL DEFAULT 2,
  dept_id INTEGER DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'survey',
  schema TEXT NOT NULL DEFAULT '[]',
  settings TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  is_template INTEGER NOT NULL DEFAULT 0,
  category TEXT DEFAULT '',
  created_by INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  score REAL,
  passed INTEGER,
  duration INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER DEFAULT 0,
  ip TEXT DEFAULT '',
  device TEXT DEFAULT '',
  openid TEXT DEFAULT '',
  wx_nickname TEXT DEFAULT '',
  wx_avatar TEXT DEFAULT '',
  marked INTEGER NOT NULL DEFAULT 0,
  manual_scores TEXT NOT NULL DEFAULT '{}',
  reviewed_at TEXT,
  reviewed_by INTEGER NOT NULL DEFAULT 0,
  review_note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS banks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  owner_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'radio',
  title TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  answer TEXT NOT NULL DEFAULT '[]',
  analysis TEXT DEFAULT '',
  score REAL NOT NULL DEFAULT 5,
  tags TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS practice_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'sequence',
  progress INTEGER NOT NULL DEFAULT 0,
  right_ids TEXT NOT NULL DEFAULT '[]',
  wrong_ids TEXT NOT NULL DEFAULT '[]',
  favorite_ids TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  UNIQUE(bank_id, user_id)
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  stored TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT DEFAULT '',
  form_id INTEGER DEFAULT 0,
  submission_id INTEGER DEFAULT 0,
  driver TEXT NOT NULL DEFAULT 'local',
  url TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["create"]',
  secret TEXT DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER DEFAULT 0,
  username TEXT DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS i18n (
  lang TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (lang, key)
);
CREATE INDEX IF NOT EXISTS idx_sub_form ON submissions(form_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_q_bank ON questions(bank_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_forms_kind ON forms(kind, deleted_at);
`)

// 老库补列：SQLite 没有 ADD COLUMN IF NOT EXISTS，先查再补
function ensureColumns(table, columns) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name))
  for (const [name, ddl] of Object.entries(columns)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`)
  }
}

ensureColumns('submissions', {
  manual_scores: "TEXT NOT NULL DEFAULT '{}'",
  reviewed_at: 'TEXT',
  reviewed_by: 'INTEGER NOT NULL DEFAULT 0',
  review_note: "TEXT DEFAULT ''"
})

/**
 * 换库：checkpoint → 关闭 → 用新文件顶替 → 重新打开。
 * 运行中的进程不能直接覆盖正在读的库文件（WAL 还开着，覆盖会得到半新半旧的库）。
 */
export function switchDb(nextFile) {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch {}
  db.close()
  for (const ext of ['-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true })
  fs.copyFileSync(nextFile, dbFile)
  db = new DatabaseSync(dbFile)
  db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`)
  return db
}

export const get = (sql, ...params) => db.prepare(sql).get(...params)
export const all = (sql, ...params) => db.prepare(sql).all(...params)
export const run = (sql, ...params) => db.prepare(sql).run(...params)

export function setting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key)
  if (!row) return fallback
  try { return JSON.parse(row.value) } catch { return row.value }
}

export function setSetting(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value)
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, v)
}

export function log(user, action, detail = '', ip = '') {
  run('INSERT INTO logs(user_id, username, action, detail, ip, created_at) VALUES(?,?,?,?,?,?)',
    user?.id || 0, user?.username || '-', action, String(detail).slice(0, 500), ip, now())
}

export { now, DATA_DIR }
