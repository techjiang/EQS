import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { currentRequestIp } from './ctx.js'

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

/*
 * 批阅留痕。
 *
 * submissions 上的 reviewed_at / reviewed_by 只记得「最后一次」，而且改一次就覆盖一次：
 * 「这份卷子两道题的分差得离谱，是谁批的、什么时候批的」在真学校里是会被追问的，
 * 而库里的答复永远是同一个人的同一个时间点。这里按「次」记：谁、什么时候、动了哪几题、
 * 从几分改到几分、这份卷子花了多久，以及是最新一次还是历史。
 *
 * 单独抽成一段 SQL 是有原因的：导入老备份时 switchDb 直接顶替库文件，
 * 老库里没有这张表——不补的话，第一次批阅就会撞一句 no such table。
 */
const REVIEW_LOG_DDL = `
CREATE TABLE IF NOT EXISTS review_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  form_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 0,
  username TEXT DEFAULT '',
  source TEXT NOT NULL DEFAULT 'single',
  seconds INTEGER NOT NULL DEFAULT 0,
  score_before REAL,
  score_after REAL,
  changes TEXT NOT NULL DEFAULT '[]',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_logs_sub ON review_logs(submission_id, id);
CREATE INDEX IF NOT EXISTS idx_review_logs_form ON review_logs(form_id, id);
`

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
  owner_id INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  ip TEXT DEFAULT '',
  ua TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked_at);
/*
 * 题库协作：一个题库可以有多个维护人。
 * 以前题库只有 owner_id 一个身份，「两个人一起维护一个题库」这件事没有表达方式，
 * 只能互相知道对方账号密码，或者干脆各建一个题库然后把题复制一遍。
 * role: editor 可增删改题与组卷，viewer 只能读（刷题、导出）。
 */
CREATE TABLE IF NOT EXISTS bank_members (
  bank_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  created_by INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (bank_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_members_user ON bank_members(user_id);
/*
 * 表单协作：一份问卷 / 考试可以有多个维护人。
 * 与 bank_members 同形，理由也一样——「两个人一起做一份问卷」以前没有表达方式。
 * role: editor 可改内容与发布、看数据、批阅；viewer 只能看跟报表，不改不导明细。
 */
CREATE TABLE IF NOT EXISTS form_members (
  form_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  created_by INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (form_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_form_members_user ON form_members(user_id);
/* 组织架构：职位挂在部门下（0 = 直属公司），用户带一个 position_id */
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  dept_id INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
/*
 * 数据字典：下拉/单选/多选这类「一批固定选项」的东西，以前只能在每张表单里各写一遍。
 * 「学历」在 12 张表里各有一份，改一个说法就要改 12 处，还会漏。
 * 绑定字典的表单存的是**快照**（见设计器 props.dict），不是引用：
 * 字典改了不会静默改动一张已经发出去的问卷，什么时候同步由人点。
 */
CREATE TABLE IF NOT EXISTS dict_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dict_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_code TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dict_items_type ON dict_items(type_code, sort);
CREATE TABLE IF NOT EXISTS i18n (
  lang TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (lang, key)
);
CREATE INDEX IF NOT EXISTS idx_sub_form ON submissions(form_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_q_bank ON questions(bank_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_forms_kind ON forms(kind, deleted_at);
/*
 * 时间范围是答卷列表、同步导出、报表趋势都在用的过滤条件。
 * 没有这个索引时「最近 14 天趋势」要对 90 万行全表扫一遍再分组，
 * 而加上索引之后 group by 可以直接顺着索引走。
 */
CREATE INDEX IF NOT EXISTS idx_sub_created ON submissions(created_at);
/* 按表单 + 时间取数（时间范围筛选）走这条，省掉回表 */
CREATE INDEX IF NOT EXISTS idx_sub_form_created ON submissions(form_id, created_at);
${REVIEW_LOG_DDL}
/*
 * 成绩排名按 (表单, 分数倒序) 取前 N 名。
 * 没有这条索引时，SQLite 要把这个表单的全部答卷读出来排一遍才能给出前 20 名——
 * 一份 10 万人的考试，每刷一次排行榜就是一次全量排序。
 */
CREATE INDEX IF NOT EXISTS idx_sub_form_score ON submissions(form_id, score);
`)

// 老库补列：SQLite 没有 ADD COLUMN IF NOT EXISTS，先查再补
function ensureColumns(table, columns) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name))
  for (const [name, ddl] of Object.entries(columns)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`)
  }
}

// 附件归属：设计器里传的头图、背景图并不挂在答卷上（form_id / submission_id 都是 0），
// 没有 owner 就只能所有人可见或者所有人不可见，两种都不对。
ensureColumns('files', { owner_id: 'INTEGER NOT NULL DEFAULT 0' })

// API Key 必须记「是谁签的」：以前所有 Key 一律按管理员解析，
// 于是任何登录用户自己签一把 Key 就等于拿到全站管理员权限（实测能读全站备份、建管理员账号）。
ensureColumns('api_keys', { owner_id: 'INTEGER NOT NULL DEFAULT 0' })

/*
 * 题库题目也要能带 props。
 * 矩阵量表的「行」= props.rows、评分题的满分 = props.max、子表单的字段 = props.fields：
 * 这些都不在 questions 的列里，以前入库时被整个丢掉——矩阵题从题库搬进卷面就只剩选项，
 * 卷面上连行都没有，答题框渲染不出来。
 */
ensureColumns('questions', { props: "TEXT NOT NULL DEFAULT '{}'" })

/*
 * 字典项也要能带层级。
 * 级联选择（省 / 市 / 区）和字典本来是同一件事的两种说法：都是「一批固定选项」，
 * 区别只是前者有父子关系。字典没有 parent，级联选项就只能一张表里手工敲一遍，
 * 「学历」「行业」能集中维护、「行政区」却不能——这说不过去。
 */
ensureColumns('dict_items', { parent: "TEXT NOT NULL DEFAULT ''" })

// 改密码之后旧会话必须失效：以前换了密码，别人手里那条 7 天有效的 Cookie 照用不误。
ensureColumns('users', { pwd_changed_at: 'TEXT', position_id: 'INTEGER NOT NULL DEFAULT 0' })

/*
 * 考试防作弊三列。
 *  seed        —— 本次作答用的乱序种子。乱序只有能重现才有意义：老师问「第 3 题」，
 *                 而每个人卷子的第 3 题都不一样，没有种子就永远对不上。
 *  switch_count—— 作答期间切走窗口的次数（前端 visibilitychange 计数，交卷时上报）。
 *  flagged     —— 切屏次数超过阈值的卷子，给阅卷人一眼能看见的标记。
 * 三列都可空/默认 0：老答卷没有这些信息，显示成「-」而不是 0 次。
 */
ensureColumns('submissions', {
  seed: "TEXT DEFAULT ''",
  switch_count: 'INTEGER',
  flagged: 'INTEGER NOT NULL DEFAULT 0',
  manual_scores: "TEXT NOT NULL DEFAULT '{}'",
  reviewed_at: 'TEXT',
  reviewed_by: 'INTEGER NOT NULL DEFAULT 0',
  review_note: "TEXT DEFAULT ''",
  // 对外可见的答卷编号。自增 id 是连续可猜的，而「凭编号查询」天然是匿名入口：
  // 编号只对提交者本人有意义，所以对外一律用这个不可猜的码，内部 id 只在后台用。
  public_id: 'TEXT'
})
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_public ON submissions(public_id)`)

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
  // 导入老备份时库文件是直接顶替的，新表要在这里补齐，否则第一条批阅就 no such table
  db.exec(REVIEW_LOG_DDL)
  resetStatementCache()
  return db
}

/*
 * 预编译语句缓存。
 * `db.prepare(sql)` 每次都要走一遍 SQL 解析与字节码生成——单看是一次微秒级操作，
 * 但热路径（答卷列表每行、报表每个字段、批量导入每条）会把同一句 SQL 准备上千遍。
 * 实测 2 万次按 id 取行：不复用 459ms，复用 78ms，差近 6 倍。
 *
 * 缓存键就是 SQL 原文，命中率天然高（所有查询都是字面量，没有拼串）。
 */
const stmtCache = new Map()
const MAX_STMT = 500

function prepared(sql) {
  let st = stmtCache.get(sql)
  if (st) return st
  st = db.prepare(sql)
  // 超过上限就整体丢弃重来。不做 LRU：查询语句的集合是代码里写死的有限集，
  // 真触到上限说明有人在做 SQL 拼接，重新预热比维护一套淘汰逻辑更省事。
  if (stmtCache.size >= MAX_STMT) stmtCache.clear()
  stmtCache.set(sql, st)
  return st
}

/** 换库之后旧语句全部失效，必须清空——否则它们指向的已经是被关掉的那个连接 */
export function resetStatementCache() { stmtCache.clear() }

export const get = (sql, ...params) => prepared(sql).get(...params)
export const all = (sql, ...params) => prepared(sql).all(...params)
export const run = (sql, ...params) => prepared(sql).run(...params)

/**
 * 逐行流式读取。
 * `all()` 会把整个结果集物化成对象数组；报表、导出这类「读一遍就丢」的场景
 * 用它等于把数据规模直接搬到内存里。iterate() 是一边执行一边吐行，
 * 中间只留一行的缓冲。
 */
export function each(sql, ...params) {
  return prepared(sql).iterate(...params)
}

export function setting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key)
  if (!row) return fallback
  try { return JSON.parse(row.value) } catch { return row.value }
}

export function setSetting(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value)
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, v)
}

/**
 * 写审计日志。
 * ip 不传时回退到当前请求的来源地址：以前各调用点基本都不传，日志里这一列大面积是空的，
 * 而「从哪个 IP 干的」是出事后第一个要看的字段。
 */
export function log(user, action, detail = '', ip = '') {
  const from = ip || currentRequestIp()
  run('INSERT INTO logs(user_id, username, action, detail, ip, created_at) VALUES(?,?,?,?,?,?)',
    user?.id || 0, user?.username || '-', action, String(detail).slice(0, 500), from || '', now())
}

export { now, DATA_DIR }
