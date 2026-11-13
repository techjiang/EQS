# EQS API 参考

所有接口返回 JSON，结构统一为 `{ ok: boolean, ... }`，失败时带 `message`。

鉴权二选一：
- Cookie：`eqs_token=<登录返回的会话>`
- 请求头：`X-API-Key: eqs_xxx`（在系统设置 → API Key 创建）

## 鉴权

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | `{username, password}` |
| POST | `/api/auth/register` | `{username, password, nickname?, email?}` |
| POST | `/api/auth/logout` | 退出登录 |
| GET | `/api/auth/me` | 当前用户与权限 |
| PUT | `/api/auth/me` | 修改昵称/邮箱/头像/密码 |

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

`GET /api/public/forms/:id` 返回的 `settings` 已按白名单裁剪：只含外观与开关
（`submitText`、`buttonText`、`redirectUrl`、`headerImage`、`bgImage`、`bgColor`、`buttonColor`、
`allowQuery`、`onlyWechat`、`recordWechat`、`needPassword`、`passPercent`、`showResult`、`duration`），
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

## 题库与组卷

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/banks` | 题库列表 |
| POST | `/api/banks` | 新建题库 `{name, description?}` |
| GET | `/api/banks/:id/questions` | 题目列表 |
| POST | `/api/banks/:id/questions` | 新增题目 |
| POST | `/api/banks/:id/import` | `{text}` 文本批量导入 |
| POST | `/api/banks/paper` | 多题库混合组卷，见下 |

### 多题库混合组卷

```
POST /api/banks/paper
{ "bankIds": [1, 2, 3], "count": 10, "types": ["single", "essay"],
  "title": "2025 前端与安全能力考核", "passPercent": 60, "duration": 60 }
```

- `bankIds` 按当前用户权限过滤，传了但全部无效时返回 `400 所选题库不存在或无权访问`，
  不会静默退化成「从全部题库抽题」。
- 抽题时先把候选题全局打乱，再按题库轮转取题（round-robin），
  避免题量大的题库把卷面刷满，保证混合卷各题库比例均衡。
- `types` 可限定题型；`passPercent` / `duration` 写入新考试的 settings。
- 返回新建的考试表单详情，`schema.fields` 即组好的卷面。

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
| GET/POST | `/api/banks` | 题库列表 / 创建 |
| PUT/DELETE | `/api/banks/:id` | 更新 / 删除 |
| GET/POST | `/api/banks/:id/questions` | 题目列表 / 新增 |
| PUT/DELETE | `/api/questions/:id` | 更新 / 删除题目 |
| POST | `/api/banks/:id/import-text` | 文本批量导入，返回 `{imported, droppedAnswers}`（答案指向不存在的选项会被剔除并列在这里） |
| GET | `/api/banks/template.xlsx` | 下载题库导入模板（1 行表头 + 4 行示例） |
| GET | `/api/banks/:id/export.xlsx` | 题库导出为 Excel，改完可直接再导回来 |
| POST | `/api/banks/:id/import-xlsx` | multipart 上传 `file`（.xlsx）批量导入，返回 `{imported, skipped, droppedAnswers, unknownColumns}` |
| POST | `/api/banks/:id/paper` | 智能组卷 `{title, count, duration}` |
| GET | `/api/banks/:id/practice?mode=sequence\|random\|wrong\|favorite` | 拉取练习题目（不含答案） |
| POST | `/api/banks/:id/practice/answer` | 提交作答 `{questionId, value, progress?, note?, favorite?}` |
| GET | `/api/banks/:id/progress` | 练习进度 |

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
| GET/POST | `/api/depts` | 部门 |
| GET | `/api/settings` | 全部配置（密钥脱敏） |
| GET | `/api/settings/public` | 公开配置 |
| PUT | `/api/settings/:key` | 更新分组配置 |
| GET/POST | `/api/webhooks` | WebHook |
| GET/POST | `/api/api-keys` | API Key |
| GET | `/api/logs` | 操作日志 |
| GET | `/api/i18n/:lang`、PUT | 多语言资源 |
| GET | `/api/sync/export` | 全量数据同步 |
| GET | `/api/backup/export` | 备份导出 |
| POST | `/api/backup/import` | 备份导入 |
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

`skipped` 会逐行给出跳过原因（题干为空、选择题选项不足两个）；`unknownColumns` 列出表头里
既不是已知字段又有内容的列——静默忽略会让人以为那列导进去了。

导出的 xlsx 是标准 OOXML（store 打包，Excel / WPS / Numbers / LibreOffice 均可打开），
读取端同时支持 sharedStrings 与 inlineStr、以及 store / deflate 两种压缩方式。
