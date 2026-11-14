# EQS API 参考

所有接口返回 JSON，结构统一为 `{ ok: boolean, ... }`，失败时带 `message`。

鉴权二选一：
- Cookie：`eqs_token=<登录返回的会话>`
- 请求头：`X-API-Key: eqs_xxx`（在系统设置 → API Key 创建，只拥有签发人本人的权限）

## 鉴权

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | `{username, password}` |
| POST | `/api/auth/register` | `{username, password, nickname?, email?}` |
| POST | `/api/auth/logout` | 退出登录 |
| GET | `/api/auth/me` | 当前用户与权限 |
| PUT | `/api/auth/me` | 修改昵称/邮箱/头像/密码 |
| GET | `/api/auth/sessions` | 当前账号的登录会话列表（设备 / IP / 最近活跃 / 是否当前） |
| DELETE | `/api/auth/sessions/:id` | 让指定设备下线；返回 `self: true` 表示踢的是自己 |
| POST | `/api/auth/sessions/revoke-others` | 退出除当前这台之外的全部设备 |

> 会话存在服务端 `sessions` 表，Cookie 里只放一个随机串（库里存它的 sha256）。
> 所以退出登录、踢某台设备、改密码、被管理员重置密码或停用账号，都是**立刻生效**的；
> 以前是签名 Cookie，除了改密码没有任何办法单独作废某一条。

## 表单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/forms?kind=&keyword=&template=&recycle=&page=&pageSize=` | 列表 |
| GET | `/api/forms/:id` | 详情（含完整 schema） |
| POST | `/api/forms` | 创建 `{title, kind, description?, schema?, settings?}` |
| PUT | `/api/forms/:id` | 更新任意字段 |
| DELETE | `/api/forms/:id` | 移入回收中心 |
| POST | `/api/forms/:id/restore` | 恢复 |
| DELETE | `/api/forms/:id/purge` | 彻底删除（须先移入回收中心，连带清理答卷与附件文件） |
| POST | `/api/forms/:id/duplicate` | 复制 |
| POST | `/api/forms/:id/import-text` | `{text}` 文本批量导入题目，返回 `{added, schema}` |
| POST | `/api/forms/:id/import-xlsx` | multipart 上传 `file`（.xlsx）批量导入题目，返回 `{added, skipped, droppedAnswers, unknownColumns, schema}` |
| GET | `/api/forms/:id/report` | 报表统计数据 |

## 回收中心

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/recycle/submissions` | 回收站里的答卷，返回 `{self, byForm}`：自己删掉的 / 所属表单在回收站的 |
| POST | `/api/submissions/:id/restore` | 恢复一份答卷（所属表单必须已恢复） |
| POST | `/api/submissions/batch-delete` | 批量删除 `{ids}`，返回 `{count, skipped}` |
| GET | `/api/banks/recycle` | 回收站里的题库 |
| POST | `/api/banks/:id/restore` | 恢复题库（题目跟着回来） |
| DELETE | `/api/banks/:id/purge` | 彻底删除题库（须先移入回收中心，连带删掉题目） |
| GET | `/api/questions/recycle` | 回收站里单独删掉的题目 |
| POST | `/api/questions/:id/restore` | 恢复题目 |

删除语义统一为**软删除 + 二次确认**：`DELETE` 只置 `deleted_at`，进回收中心；
「彻底删除」要求对象已在回收站，并真正删库。表单的彻底删除会一并清理 `files`
记录与本地磁盘文件，附件地址随即失效。

`kind` 取值：`survey`（问卷）、`exam`（考试）、`form`（通用表单）。

## 作答（公开）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/public/forms/:id` | 读取已发布表单（不含答案） |
| POST | `/api/public/forms/:id/submit` | 提交 `{data, password?, openid?, wxNickname?, wxAvatar?, duration?}` |
| GET | `/api/public/forms/:id/query?submissionId=` | 按编号查询答卷（需开启 `allowQuery`，且只能查本设备 / 本账号 / 同 IP 提交的答卷），返回含 `score` / `passed` / `reviewed` / `review` |

提交响应：

```json
{ "ok": true, "id": 12, "score": 85, "total": 100, "paperTotal": 100, "ungraded": 0, "graded": true, "passed": true, "message": "提交成功", "redirect": "" }
```

分数口径：
- `total` 只统计**可自动判分**的题目（客观题），主观题没有标准答案，不计入。
- `paperTotal` 是整卷满分（含主观题），展示用。
- `ungraded` 是待人工批阅的主观题数量；`graded: false` 表示尚有主观题未批阅，
  此时前端展示「待批阅」而不是 0 分，避免“全对也不及格”的误判。
- `passed` 由 `score / total` 与 `settings.passPercent` 比较得出，全部主观题时返回 `null`。

判分口径（三个入口共用 `lib/forms.js` 的 `isAnswerCorrect`，不要各写一套）：

| 题型 | 判据 |
| --- | --- |
| 单选 / 下拉 / 轮播 / 级联 | 选项值相等 |
| 多选 / 复选框 | 选项集合相等，勾选顺序无关 |
| 判断 | 落到「正确 / 错误」选项值上比 |
| 填空 / 简答 / 电话 / 邮箱 / 日期 | 文本相等，忽略首尾与连续空白、忽略大小写；`3306` 与 `3306.0` 视为同一个 |
| 排序 | 数组**顺序**逐位相等（不是集合比对——否则把选项全排进去就算对） |
| 矩阵 | 作答 `{行: 答案}` 与答案数组逐行相等；答案只写一个值时按「每行都是它」 |

交卷后的 `review.items` 除 `answer`（原始数组）外还带 `answerText`（人能读的一行）：
矩阵会展开成「响应速度：满意 · 稳定性：一般」，排序用 `→` 连接。

`GET /api/public/forms/:id` 返回的 `settings` 已按白名单裁剪：只含外观与开关
（`submitText`、`buttonText`、`redirectUrl`、`headerImage`、`bgImage`、`bgColor`、`buttonColor`、
`allowQuery`、`onlyWechat`、`recordWechat`、`needPassword`、`passPercent`、`showResult`、
`showRank`、`showRanking`、`duration`），
访问密码、白名单、通知邮箱等敏感字段不会下发到浏览器。

## 答卷

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/submissions?formId=&keyword=&page=&pageSize=&pending=1` | 列表；`pending=1` 只看考试类且未批阅的答卷 |
| GET | `/api/submissions/:id` | 单份答卷详情（含 `manualScores`、批阅信息） |
| PUT | `/api/submissions/:id` | 编辑答卷内容（保留已有主观题人工分） |
| PUT | `/api/submissions/:id/review` | 主观题批阅，见下 |
| DELETE | `/api/submissions/:id` | 删除 |
| POST | `/api/submissions/batch-delete` | `{ids}` 批量删除 |

### 主观题人工批阅

```
PUT /api/submissions/:id/review
{ "scores": { "q_lesson": 12, "q_plan": 15 }, "note": "思路完整，指标可再具体些" }
```

`scores` 的键是 schema 中题目的 `key`，值是人工给出的分数。服务端逐项校验：
只接受主观题（无标准答案且分值 > 0）、值必须是 `[0, 题目分值]` 内的数字，
给选择题打分、负数、非数字一律 400。

保存后按「客观题自动分 + 主观题人工分」重算总分，写回 `score` 并记录
`reviewed_at` / `reviewed_by` / `review_note`，同时触发 `update` WebHook。
未出现在 `scores` 里的主观题保留原有分数，因此可以分批批阅、随时调整。

### 成绩排名

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/forms/:id/ranking?limit=20` | 管理端榜单：`top[]`（含 `rank`、`score`、`name`）、`total`、`distribution` |
| GET | `/api/public/forms/:id/ranking?limit=10` | 公开榜单，需表单开启 `showRanking`，名字打码 |

名次口径：**同分同名次，下一名跳号**（1,1,3,3,3），而不是「第几行」。
名次 = 「比我分高的人数 + 1」，所以同一个考生在榜单和查询页上拿到的名次一定一致。

榜单只读前 N 行（SQL 排序，走 `(form_id, score)` 索引），内存与耗时跟 N 有关，
与答卷总量无关；`distribution` 是 10 档分数分布，用于判断「这个分数算什么水平」。

交卷返回体里带 `rank: {rank, total, percentile, score}`，
`percentile` 是「超过百分之多少的考生」。以下情况一律不给名次：

- 表单 `showResult: false`（不公布成绩——第 1 名配满分等于把满分告诉了所有人）
- 表单 `showRank: false`
- 非考试类表单

公开榜单只给 `rank` / `name` / `score` / `passed` / `publicId`，不含任何答卷内容。
`name` 取微信昵称、账号昵称，打码成「张*」；空名或纯数字（手机号当昵称）统一「匿名考生」。

## 题库与组卷

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/banks` | 题库列表 |
| POST | `/api/banks` | 新建题库 `{name, description?}` |
| GET | `/api/banks/:id/questions?keyword=&type=&tag=` | 题目列表；`keyword` 同时匹配题干与标签，`tag` 按标签整词匹配 |
| POST | `/api/banks/:id/questions` | 新增题目（支持 `items: []` 批量，每条可带自己的 `tags`） |
| POST | `/api/banks/:id/import` | `{text}` 文本批量导入 |
| POST | `/api/banks/paper` | 多题库混合组卷，见下 |

### 多题库混合组卷

```
POST /api/banks/paper
{ "bankIds": [1, 2, 3], "count": 10,
  "types": ["radio", "textarea"], "tags": ["网络", "协议"],
  "title": "2025 前端与安全能力考核", "passPercent": 60, "duration": 60 }
```

- `bankIds` 按当前用户权限过滤，传了但全部无效时返回 `400 所选题库不存在或无权访问`，
  不会静默退化成「从全部题库抽题」。
- 抽题时先把候选题全局打乱，再按题库轮转取题（round-robin），
  避免题量大的题库把卷面刷满，保证混合卷各题库比例均衡。
- `types` 限定题型，取值同 schema 的字段类型（`radio` / `checkbox` / `text` / `textarea` …）；
  `tags` 限定标签，多个标签是「同时满足」。两者筛不到任何题目时返回
  `400 该题库中没有同时满足 … 的题目`，**不会静默退回全库抽题**。
- `passPercent` 是卷面百分比，越界会被夹到 `1..100`；`duration` 写入新考试的 settings。
- 返回新建的考试表单详情，`schema` 即组好的卷面。

### 题库标签

题目带一个纯文本 `tags` 字段，逗号分隔（`"数据库,基础"`）。来源有三处：文本导入的
`标签：数据库,基础` 一行、Excel 的「标签」列、题目接口的 `tags` 字段。组卷与筛题都
按**整词**匹配——`tag=基础` 不会命中 `计算机基础`。

## 附件上传

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/upload` | `multipart/form-data`，可带 `formId`、`submissionId` |
| GET | `/api/files/raw/*` | 读取本地存储的文件 |

登录用户可直接上传；未登录时**必须**带 `formId`，且该表单需为已发布状态——公开填写页的附件
依赖这条路径，其他场景一律要求登录，避免被当成公共图床。

交卷时服务端会把答卷数据里引用到的文件（`{id,url,...}`）认领到该答卷，
`GET /api/forms/:id/attachments.zip` 才能打全。

## 答卷

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/submissions?formId=&keyword=&marked=&from=&to=&page=` | 列表 |
| GET | `/api/submissions/:id` | 详情 |
| POST | `/api/submissions` | 后台新增 `{formId, data}` |
| PUT | `/api/submissions/:id` | 编辑 `{data, marked?}` |
| DELETE | `/api/submissions/:id` | 删除 |
| POST | `/api/submissions/batch-delete` | `{ids: []}` |
| POST | `/api/forms/:id/import` | 导入 `{items: [...]}` |
| GET | `/api/forms/:id/attachments.zip` | 打包下载附件 |
| GET | `/api/forms/:id/submissions.xlsx?keyword=&marked=` | 导出当前筛选条件下的全部答卷为 Excel（不受分页影响） |

## 题库与刷题

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/banks` | 题库列表 / 创建。列表每行带 `my_role`（`owner` / `editor` / `viewer`），前端据此收起按钮 |
| PUT/DELETE | `/api/banks/:id` | 更新 / 删除（删除只有所有者能做） |
| GET/POST | `/api/banks/:id/questions` | 题目列表 / 新增 |
| PUT/DELETE | `/api/questions/:id` | 更新 / 删除题目 |
| POST | `/api/banks/:id/import-text` | 文本批量导入（`答案：` `分值：` `解析：` `标签：`），返回 `{imported, droppedAnswers}` |
| GET | `/api/banks/template.xlsx` | 下载题库导入模板（1 行表头 + 4 行示例） |
| GET | `/api/banks/:id/export.xlsx` | 题库导出为 Excel，改完可直接再导回来 |
| POST | `/api/banks/:id/import-xlsx` | multipart 上传 `file`（.xlsx）批量导入，返回 `{imported, skipped, droppedAnswers, unknownColumns}` |
| POST | `/api/banks/:id/paper` | 单题库组卷 `{title, count, duration, passPercent, types?, tags?}` |
| GET | `/api/banks/:id/practice?mode=sequence\|random\|wrong\|favorite` | 拉取练习题目（不含答案） |
| POST | `/api/banks/:id/practice/answer` | 提交作答 `{questionId, value, progress?, note?, favorite?}` |
| GET | `/api/banks/:id/progress` | 练习进度 |
| GET | `/api/banks/:id/members` | 协作者列表 + `my_role` + `candidates`（仅所有者返回可邀请的人） |
| POST | `/api/banks/:id/members` | 加协作者 `{username\|userId, role: "editor"\|"viewer"}`；同一个人再传一次即改角色（返回 `updated: true`） |
| DELETE | `/api/banks/:id/members/:userId` | 移除协作者 |

### 题库协作的权限边界

题库的访问身份分四档：管理员 / 所有者 / `editor` / `viewer`。

| 能做什么 | 管理员 | 所有者 | editor | viewer |
| --- | --- | --- | --- | --- |
| 看题目、刷题 | ✓ | ✓ | ✓ | ✓ |
| 看到标准答案与解析 | ✓ | ✓ | ✓ | ✗（接口返回 `redacted: true`，`answer`/`analysis` 摘空） |
| 增删改题、导入、组卷 | ✓ | ✓ | ✓ | ✗ |
| 导出 Excel（含答案） | ✓ | ✓ | ✓ | ✗ |
| 改名、管理协作者 | ✓ | ✓ | ✗ | ✗ |
| 删除 / 恢复题库 | ✓ | ✓ | ✗ | ✗ |

只读身份刻意看不到答案、也不能导出：否则「只读」在界面上成立、在数据上不成立。

## 模板

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/templates` | 模板列表 |
| POST | `/api/templates/:id/use` | 基于模板创建表单 |

## 文件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/upload` | multipart 上传，字段名 `file` |
| GET | `/api/files/raw/:key` | 读取本地文件 |
| GET | `/api/files?formId=` | 文件列表 |
| DELETE | `/api/files/:id` | 删除文件 |

## 管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/users` | 用户列表 / 新增 |
| PUT/DELETE | `/api/users/:id` | 更新 / 删除 |
| GET/POST | `/api/roles` | 角色 |
| GET/POST | `/api/depts` | 部门列表（返回扁平 `data` 与 `tree`）/ 新增 `{name, parent_id?, sort?}` |
| PUT/DELETE | `/api/depts/:id` | 改名 / 换上级 / 排序；删除时部门内有人或有子部门一律拒绝 |
| GET/POST | `/api/positions` | 职位列表 / 新增 `{name, dept_id?, sort?}` |
| PUT/DELETE | `/api/positions/:id` | 更新 / 删除（有人占着该职位时拒绝） |
| GET | `/api/settings` | 全部配置（密钥脱敏） |
| GET | `/api/settings/public` | 公开配置 |
| PUT | `/api/settings/:key` | 更新分组配置 |
| GET/POST | `/api/webhooks` | WebHook |
| GET/POST | `/api/api-keys` | API Key |
| GET | `/api/logs?action=&keyword=&page=&pageSize=` | 审计日志；返回 `{data, actions, total, page, totalPages}`，`actions` 是动作清单（含各自动作条数，供筛选面板） |
| DELETE | `/api/logs?days=90` | 清理 `days` 天前的日志（最少 7 天，不提供一键清空） |
| GET | `/api/i18n/:lang`、PUT | 多语言资源 |
| GET | `/api/sync/export?formId=1&sinceId=0&limit=1000` | 增量数据同步（游标分页） |
| GET | `/api/backup/export` | 备份导出（流式 zip，含 `manifest.json`） |
| POST | `/api/backup/import` | 备份导入（multipart，字段 `file`；先校验后顶替，自动快照） |
| GET | `/api/backup/snapshots` | 可回滚快照列表 |
| POST | `/api/backup/rollback` | 回滚，body `{ name? }` 省略则回滚到最近一份 |
| GET | `/api/system/info` | 系统信息 |
| GET | `/api/health` | 健康检查 |

## AI

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/ai/generate` | `{prompt, kind, lang}` → 生成表单 schema |
| POST | `/api/ai/stream` | SSE 流式生成 |

## WebHook 事件

| 事件 | 触发时机 |
| --- | --- |
| `create` | 新答卷提交 |
| `update` | 答卷被修改 |
| `delete` | 答卷被删除 |
| `test` | 后台手动测试 |

请求体：

```json
{ "event": "create", "timestamp": "2025-01-01T00:00:00Z", "data": { "formId": 1, "formTitle": "...", "submission": { } } }
```

校验签名：`sha256=` + `HMAC_SHA256(secret, rawBody)`，放在 `X-EQS-Signature` 头。

## Excel 表格格式

导入 / 导出共用一张表，列可以按表头名认（顺序无所谓），也可以不带表头按下面的顺序读：

| 列 | 表头别名 | 说明 |
| --- | --- | --- |
| 题型 | 类型 / type | 单选、多选、判断、填空、简答、评分、量表、日期、数字…不写则按内容推断 |
| 题干 | 题目 / title | 必填，为空的行会被跳过 |
| 选项 | options | 单元格内一行一个（`A.苹果` 换行 `B.香蕉`），也可用 `\|` 分隔；序号前缀会被去掉 |
| 答案 | 正确答案 / answer | `A`、`A,C`、`正确`；越界字母会被剔除并在 `droppedAnswers` 里回报 |
| 分值 | 分数 / score | 不填按 0，0 分表示不计分（不是「没填」） |
| 解析 | analysis | 判题后的解析文案 |
| 标签 | 分类 / tags | 逗号分隔，用于筛题与按标签组卷 |
| 矩阵行 | 行 / rows | 仅矩阵量表使用，一行一个评价对象（`速度` 换行 `稳定`）；缺这一列时矩阵题导入后只剩列、没有行 |

`skipped` 会逐行给出跳过原因（题干为空、选择题选项不足两个）；`unknownColumns` 列出表头里
既不是已知字段又有内容的列——静默忽略会让人以为那列导进去了。

导出的 xlsx 是标准 OOXML（store 打包，Excel / WPS / Numbers / LibreOffice 均可打开），
读取端同时支持 sharedStrings 与 inlineStr、以及 store / deflate 两种压缩方式。
