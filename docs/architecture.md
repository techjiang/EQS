# EQS 架构设计

## 设计目标

1. **小白可装**：不用装数据库、不用配环境、不用构建前端。
2. **可迁移**：所有状态收敛在一个目录，复制即迁移。
3. **高性能**：单进程、零依赖、WAL 模式 SQLite，静态资源 gzip + ETag 缓存。
4. **可扩展**：存储、通知、AI、登录方式全部插件化配置。

## 技术选型取舍

| 备选 | 放弃原因 |
| --- | --- |
| Spring Boot + MySQL | 部署门槛高：需要 JDK、MySQL、连接池配置，不适合小白 |
| Next.js / Nuxt | 需要 Node 构建链与数百个 npm 包，产物体积大，离线部署麻烦 |
| 前端 SPA + 构建 | 需要 `npm install`，引入供应链风险与版本漂移 |
| MongoDB | 额外进程与内存占用，单机场景收益有限 |

最终选择 **Node.js 22 内建能力 + 无构建前端**：

- `node:sqlite`（Node 22.5+ 内置）替代 better-sqlite3，免编译；
- `node:http` 自研 60 行路由器，替代 Express，冷启动 < 100ms；
- Vue 3 ESM 版与 ECharts 本地化内置，浏览器直接加载，无打包步骤。

代价是放弃了生态便利，换来**一个 `git clone` 就能跑**的部署体验。

## 目录与数据流

```
浏览器（Vue 3 ESM）
   │  fetch JSON / SSE
   ▼
node:http 服务器 ── 路由表 ── 鉴权中间件 ── 业务模块
   │                                        │
   │                                        ├── node:sqlite（WAL）
   │                                        ├── 本地文件 / 对象存储
   │                                        ├── SMTP / 短信 / 微信
   │                                        └── OpenAI Compatible
   ▼
静态资源（gzip + ETag）
```

## 数据库

17 张表，全部 `CREATE TABLE IF NOT EXISTS`，启动即自愈：

| 表 | 用途 |
| --- | --- |
| `users` / `roles` / `depts` | 用户、角色权限、部门 |
| `forms` | 表单/考试定义（schema 与 settings 存 JSON） |
| `submissions` | 答卷 |
| `banks` / `questions` | 题库与题目 |
| `practice_records` | 刷题进度、错题、收藏、笔记 |
| `files` | 上传文件索引 |
| `settings` | KV 配置（分组 JSON） |
| `webhooks` / `api_keys` / `logs` / `i18n` | 集成与运维 |

**软删除**：`forms`、`submissions`、`banks`、`questions` 都用 `deleted_at` 标记，回收中心据此展示并支持恢复。

**两层删除**：`DELETE` 只做软删除（可恢复）；`purge` 才是真删库，且要求对象已在回收站里——
避免一次误点就让问卷连同答卷消失。表单的 `purge` 会连带清理 `files` 记录与磁盘文件。

**统计口径**：工作台的「表单总数 / 已发布」排除模板（`is_template = 0`）；
答卷类统计一律 `submissions.deleted_at IS NULL AND forms.deleted_at IS NULL`，
表单进回收站后它的答卷也不再计入。

**索引**：`(form_id, deleted_at)`、`(bank_id, deleted_at)`、`(kind, deleted_at)`，覆盖主要列表查询。

## 表单引擎

表单结构是纯 JSON：

```json
{
  "id": "f_ab12cd",
  "type": "radio",
  "label": "性别",
  "required": true,
  "options": [{ "label": "男", "value": "男" }],
  "answer": ["男"],
  "score": 5,
  "logic": [{ "fieldId": "f_xx", "op": "eq", "value": "女" }],
  "props": {}
}
```

三层能力：

1. **显隐逻辑**：`logic` 数组为 AND 关系，支持 `eq/ne/in/contains/gt/lt/empty/notEmpty`。
2. **校验**：必填、手机号、邮箱、身份证、数值、长度上下限，服务端为准（前端只做即时提示）。
3. **评分**：按 `answer` 与 `score` 自动比对（选项值集合排序后全等），聚合出总分与及格判定。

同一份 schema 同时驱动设计器、预览、公开填写、数据表格、报表五个视图，避免多份渲染逻辑漂移。

## 性能要点

- **WAL + `synchronous=NORMAL`**：写入不阻塞读取，牺牲极端断电一致性换取吞吐。
  代价是新数据先落在 `eqs.db-wal`，`eqs.db` 主文件可能长时间是空的——任何备份/恢复路径
  都必须先 `PRAGMA wal_checkpoint`（或 `VACUUM INTO`）拿到一致快照，
  否则打出来的「备份」是一个没有表的空库，恢复后全站空白。
- **无 ORM**：直接 prepared statement，避免查询构造开销。语句按 SQL 原文缓存复用
  （`lib/db.js` 的 `prepared()`）：同一句 SQL 反复 prepare 时，2 万次按 id 取行从 459ms 降到 78ms。
- **JSON 一次解析**：读表时集中 `safeJson`，避免逐字段解析。
- **统计靠流式累加，不靠内存堆数据**：`createStatsAccumulator` 一份答卷进来就累加、算完就丢，
  内存只跟「题目数 × 选项数」有关，与答卷数量无关。旧实现把整表 `SELECT *` 读进内存再逐份 parse，
  93 万份答卷时是 13 秒 / 2.2GB 峰值——返回给前端的 JSON 只有 18KB。
- **报表结果按数据指纹缓存**：键是「行数 + 最大 id + 最大 updated_at + 表单更新时间」，
  任何一次增删改都会让它失效，所以「命中缓存」与「数据没变」是同一件事。
- **导出与同步走流式**：答卷导出用 `writeXlsxStream` 边读库边写响应（工作表 XML 不落成整条字符串），
  数据同步 API 用 `sinceId` 游标分批。旧实现 93 万行导出直接 `RangeError: Invalid string length`。
- **`each()` 逐行读**：`all()` 会把结果集物化成对象数组，报表 / 导出这类「读一遍就丢」的场景用 `each()`。
- **静态资源**：非 HTML 强缓存一天，`ETag` 命中直接 304；文本资源超 1KB 自动 gzip。
- **冷启动**：进程启动约 80ms，内存占用约 60MB。

## 安全

- 密码 `scrypt` 加盐哈希，校验用 `timingSafeEqual`。
- 会话是服务端可撤销的随机 token（库里存 sha256），Cookie 带 HttpOnly / SameSite=Lax；
  改密、停用、删除、手动下线都会让对应会话立刻失效。
- 所有 SQL 使用参数绑定，无字符串拼接。
- 文件路径经 `path.resolve` 校验，杜绝路径穿越。
- 公开接口不返回正确答案与解析，刷题接口同理。
- WebHook 请求带 `X-EQS-Signature`（HMAC-SHA256），接收方自行校验。
- 富文本说明字段在渲染前剥离 `<script>` 与 `on*` 属性。

## 扩展点

- **换存储**：`server/lib/storage.js` 实现 `put*` 函数即可接入新对象存储。
- **换通知**：`server/lib/notify.js` 集中 SMTP / 短信 / 微信 / WebHook。
- **加题型**：`server/lib/forms.js` 的 `FIELD_TYPES` 增类型，`web/js/renderer.js` 加渲染分支。
- **换数据库**：所有 SQL 集中在 `lib` 与 `routes`，替换 `lib/db.js` 的导出即可。

## 压测参考

| 场景 | 本机（4C8G） |
| --- | --- |
| 单条答卷提交 | ≈ 3 ms |
| 1 万条答卷表单列表（分页 20） | ≈ 12 ms |
| 1 万条答卷报表统计 | ≈ 90 ms |

### 93 万份答卷的实测（同一台机器）

| 场景 | 改造前 | 改造后 |
| --- | --- | --- |
| 报表统计（首次） | 13 s / 2.2 GB | 3.5 s / 120 MB |
| 报表统计（数据没变） | 13 s | 190 ms（命中指纹缓存） |
| 导出 Excel | **500 · RangeError** | 25 s / 36 MB（流式，内存 150 MB） |
| 数据同步 API | 486 MB 响应 / 2 GB 峰值 | 500 KB / 默认 1000 条一批 |
| 待批阅队列 | 2 s（全表扫） | 2 ms（只扫有主观题的表单） |

结论一句话：**瓶颈不在 SQLite，在「把整表搬到 Node 堆里」这个动作。** 换成任何数据库都一样。
| 静态首页首字节 | ≈ 5 ms（gzip 后 2.1 KB） |
