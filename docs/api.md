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
| POST | `/api/public/forms/:id/submit` | 提交 `{data, password?, openid?, wxNickname?, wxAvatar?, duration?, seed?, switchCount?}` |
| GET | `/api/public/forms/:id/query?submissionId=` | 按编号查询答卷（需开启 `allowQuery`，且只能查本设备 / 本账号 / 同 IP 提交的答卷），返回含 `score` / `passed` / `reviewed` / `review` |

提交响应：

```json
{ "ok": true, "id": 12, "score": 85, "total": 100, "paperTotal": 100, "ungraded": 0, "graded": true,
  "passed": true, "message": "提交成功", "redirect": "",
  "jump": { "stopped": false } }
```

`jump.stopped: true` 表示这份作答被**条件跳转**提前结束了，`jump.text` 是作者写的那句结束语
（例如「本季度预算已用完，申请已记录」）。此时 `total` / `paperTotal` / `passLine` 只按
**已答题**计算，逐题回顾里也不会出现被跳过的题。

### 考试防作弊

`settings.antiCheat`：

| 字段 | 含义 |
| --- | --- |
| `shuffleQuestions` | 题目乱序。有任意一题带 `jump` 时自动降级为只乱选项——跳转语义是「命中即其后作废」，依赖题目先后 |
| `shuffleOptions` | 选项乱序。`sort` / `matrix` / `cascader` / `carousel` 等题型不打乱，它们的顺序本身就是题目 |
| `detectSwitch` | 记录切屏次数（浏览器 `visibilitychange`） |
| `maxSwitch` | 达到或超过这个次数把答卷标记为异常；`0` = 只记录不标记 |
| `autoSubmit` | 达到阈值时前端自动交卷 |

`GET /api/public/forms/:id` 会在开启乱序时下发 `seed`，提交时原样带回、随答卷入库。
种子是**可复现**的：同一 `seed` 用同一个函数重排，得到的就是当年发给这位考生的顺序，
逐题回顾按它排（否则「你选的是 B」在回顾里指的是另一个选项）。

`switchCount` 由浏览器上报，**只当线索不当判决**：改一个前端变量就能报 0。所以服务端只记录、
超过阈值时置 `flagged=1` 给阅卷人看，不据此判零分——误判一个真被弹窗打断的考生，
比放过一个切屏十次的人代价大。负数与超过 9999 的值会被夹到边界。

提交响应额外带 `switchCount` / `flagged` / `maxSwitch`，当场告诉考生自己的卷子被记了几次。

### 定时发布

`settings.timeWindow = { start, end }`。`GET /api/public/forms/:id` 不再因为时间窗未开而 403，
而是返回：

```json
{ "window": { "open": false, "notStarted": true, "opensAt": "2026-11-16T09:19", "closesAt": "" } }
```

页面据此把整页换成「问卷尚未开始 · 开放时间 …」。提交与匿名附件上传仍会被拒绝（403），
但理由写清是「几点开放」或「已于几点截止」，而不是笼统的「未发布」。

| 状态 | `window.open` | `notStarted` | `ended` |
| --- | --- | --- | --- |
| 无时间窗 | true | false | false |
| 未到开始时间 | false | true | false |
| 超过结束时间 | false | false | true |

### 条件逻辑

字段上的逻辑规则（形状与 `schema` 一起存，公开接口会下发 `requiredWhen` / `jump` / `fill`，
计算题的 `props.formula` 也在 `props` 白名单里）：

| 字段 | 形状 | 语义 |
| --- | --- | --- |
| `logic` | `[{fieldId, op, value}]` | 全部满足才显示；为空即总是显示 |
| `requiredWhen` | 同上 | 全部满足才必填；为空则按 `required` |
| `jump` | `[{op, value, text}]` | 命中即提前结束，`text` 为结束语 |
| `fill` | `{from, map: {来源值: 目标值}}` | 来源题有作答时填入**空着的**本题，不覆盖已答 |
| `type: "calculate"` | `props: {formula, precision, unit}` | 只读计算题，公式形如 `{{单价}} * {{数量}}` |

`op` 取值：`eq` `ne` `in` `contains` `gt` `lt` `empty` `notEmpty`。

实现只有一份：`web/js/flow.js`（服务端 `import '../../web/js/flow.js'`，浏览器走 `/js/flow.js`）。
提交时服务端跑 `resolveAnswers`：丢掉越界作答、**重算计算题**（不采信客户端算的数）、
返回跳转信息。校验与判分都先跑 `buildFlow`，所以「被跳过的必填题」不会拦住提交，
也不会算进卷面总分。

公式只支持 `+ - * / %`、括号、数字与 `{{字段}}` / `裸字段id` 引用，**没有 eval**。
引用不存在的字段会明确报错，除零返回 0（`Infinity` 会一路污染成 `NaN`）。

分数口径：
- `total` 只统计**可自动判分**的题目（客观题），主观题没有标准答案，不计入。
- `paperTotal` 是整卷满分（含主观题），展示用。
- `ungraded` 是待人工批阅的主观题数量；`graded: false` 表示尚有主观题未批阅，
  此时前端展示「待批阅」而不是 0 分，避免“全对也不及格”的误判。
- `passed` 由 `score / total` 与 `settings.passPercent` 比较得出，全部主观题时返回 `null`。

判分口径（三个入口共用 `lib/forms.js` 的 `isAnswerCorrect`，不要各写一套）：

| 题型 | 判据 |
| --- | --- |
| 单选 / 下拉 / 轮播 | 选项值相等 |
| 级联选择 | 选项值相等（存的是**最末一级**的值，不是整条路径） |
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
| GET | `/api/submissions?formId=&keyword=&page=&pageSize=&pending=1` | 列表；`pending=1` 只看考试类且未批阅的答卷。每行带 `switch_count`（未记录时为 `null`，不是 0）与 `flagged` |
| GET | `/api/submissions/:id` | 单份答卷详情（含 `manualScores`、批阅信息） |
| PUT | `/api/submissions/:id` | 编辑答卷内容（保留已有主观题人工分） |
| PUT | `/api/submissions/:id/review` | 主观题批阅，见下 |
| GET | `/api/forms/:id/review-queue?limit=&offset=` | 阅卷队列：这一页还没批完的答卷，含逐题作答原文与已给的分 |
| PUT | `/api/submissions/review-batch` | 批量保存人工分，body `{ items: [{ id, scores, note, seconds }] }` |
| GET | `/api/submissions/:id/review-logs?limit=` | 这份答卷的批阅留痕（谁、什么时候、动了哪几题、从几分改到几分） |
| GET | `/api/forms/:id/review-calibration?days=` | 评分尺度：同一道题被两位老师给出过差多远的分，见下 |
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
未出现在 `scores` 里的主观题保留原有分数，因此可以分批批阅、随时调整；
显式传 `null` 表示撤掉那道题的分，它会重新回到待批阅队列。

### 批量阅卷

一份一份点开批是最慢的那条路：点开 → 给分 → 保存 → 等列表刷新 → 点开下一份。
一个班 40 人就是 200 次点击，中间夹着 40 次整页重新加载。

```
GET /api/forms/7/review-queue?limit=10&offset=0
```

按答卷顺序返回这一页还没批完的答卷，`items` 里是这道题的主观题条目：
`given`（作答原文，已按题目自己的样子摊开，矩阵题不会是 `[object Object]`）、
`score`（满分）、`current`（已给的分，没批过是 `null`）、`analysis`。
`total` 是整个队列的长度，`scanned` 是扫过的答卷数。

同一个响应里还有 `need` / `done` 两个数字，是**整场考试的批阅进度**：

| 字段 | 含义 |
| --- | --- |
| `need` | 这份卷子里「有主观题」的答卷总数（进度的分母） |
| `done` | 其中已经批完的份数 = `need - total` |
| `total` | 还没批完的份数（当前队列长度） |
| `scanned` | 扫过多少份答卷（含纯客观题的，只做诊断用） |

分母只算「有主观题的答卷」：纯客观题的卷子不进队列，如果混进分母，进度条永远到不了头。
`scanned` 同理不能当分子——它包含主观题为 0 的答卷，拿它算进度，刚打开阅卷界面就显示「已批 40 份」。

```
PUT /api/submissions/review-batch
{ "items": [ { "id": 33, "scores": { "q_lesson": 12 }, "note": "论点完整" } ] }
```

**这一批只提交填了分的题**，服务端做的是合并而不是覆盖——同一份卷子分两天批两题，
第二天的保存不会把第一天的分抹掉（单份 `review` 接口同样是合并语义）。
一份出错不牵连整批：返回 `{ saved, rejected: [{ id, reason }] }`，
比如「应在 0 - 20 分之间」只拒那一份。一次最多 200 份。

判完的答卷会因为「还剩几题没批」归零而自动离开队列，所以前端批完一页是重新拉当前页而不是翻页
——往下翻页会跳过被清掉的位置：一页 10 份只批了 3 份，翻页就把剩下 7 份翻过去了。

### 阅卷的批次感

一页存完就清空，批到第 6 页时已经不知道自己在整场考试的哪儿。所以弹窗顶部常驻一条进度锚：

```
本次共 82 份 · 已批 37 · 还剩 45
[==========                              ]
这一页第 31 – 40 份 · 只有填了分的题会被提交
```

- **进度跟着队列走，不跟着页码走**：每存一次重新拉当前页，`need` / `done` 由服务端现算，
  所以撤分、删答卷这些「往回走」的动作也能如实反映（已批 21 → 撤了一道题 → 已批 20）。
- **存完继续批同一页**，不自动翻页：队列会前移补位，自动翻页会漏掉补上来的那几份。
- **只剩最后几份时**，原来的 offset 可能越过队尾（队列变短了），前端会回落到队尾那一页，
  而不是给一张空页让人以为已经批完。
- 队列真的空了才收尾：进度锚说「这场考试 22 份有主观题的卷子都批完了」，
  键盘条和保存按钮一起收起来——这时候点了保存只会报「还没有给任何一份卷子打分」。

### 阅卷的键盘操作

批量阅卷把「开弹窗 / 关弹窗」的成本压掉了，剩下的瓶颈全在打字。所以打分框有自己的一套键位
（实现抽在 `web/js/review.js`，纯函数，服务端与前端共用同一份「什么算批过」的口径）：

| 键 | 作用 |
| --- | --- |
| 数字 | 直接填分；聚焦即全选，敲了就替换（不用先删掉原来的分） |
| `Enter` | 下一题；最后一题再按一次等于保存本页 |
| `↑` `↓` | 上下题 |
| `Esc` | 退出阅卷 |

几条刻意的取舍：

- **不做「输完自动跳」**。两位数的分刚敲下第一位就跳走，得回头改——比多按一次 Enter 更烦。
- **留空 = 还没批，0 分 = 批了 0 分**。两者混为一谈的话，只看了一眼没敢给分的卷子会被悄悄判 0。
- **越界在本地就拦，不等服务端**。服务端会拒，但一份越界只拒那一份，回来是一句
  「已保存 7 份，1 份被拒」，还得自己回头找是哪一份哪一题；本地拦截会直接把焦点挪到那道题。
- **撤分有单独入口**。已给过分、想让它回到「待批」的题，提交时送 `null`；
  这个语义接口一直是有的，只是界面上此前没有入口。

### 批阅留痕：谁批的、改了什么、批了多久

`submissions` 上的 `reviewed_at` / `reviewed_by` 只记得**最后一次**，而且改一次覆盖一次。
于是「这份卷子两道题的分差得离谱，是谁批的」在库里永远只有一个答案：最后那个人、最后一个时间点。
真学校里这个问题是会被追问的，所以按「次」另记一张表：

```
GET /api/submissions/33/review-logs
{ "ok": true, "data": [
  { "id": 9, "username": "张老师", "source": "batch", "seconds": 41,
    "scoreBefore": 32, "scoreAfter": 41, "createdAt": "2026-11-14T09:12:03Z",
    "note": "",
    "changes": [
      { "id": "q_plan", "label": "简述下一季度计划", "from": 12, "to": 16 },
      { "id": "q_lesson", "label": "这次复盘的教训", "from": null, "to": 5 },
      { "id": "q_extra", "label": "补充说明", "from": 8, "to": null }
    ] },
  { "id": 7, "username": "李老师", "source": "single", "seconds": 96, ... }
] }
```

三条口径值得单独说：

- **`from` / `to` 里的 `null` 是「没有分」**，不是 0 分。撤分记成 `to: null`，
  改成 0 分记成 `to: 0`——两者混成一条，事后就看不出老师到底是判了 0 还是没批。
- **只在真有改动时落一条**。打开看一眼就关掉不在留痕里长出一行空记录。
- **耗时按份算，不按整页算**。批量阅卷一页十份里只批了 3 份，按整页时间平摊会把另外 7 份的耗时写大；
  所以每一份从「第一次动这一份的分」开始计时，负数与超过 6 小时的一律归零
  （系统时间被调过、标签页在后台睡一夜，那种数字只污染「批阅效率」，它本来也不是审计字段）。

单份 `review` 与批量 `review-batch` 都接受可选 `seconds`；写库的那一处是同一个 `applyReview()`，
所以两条入口的口径不会分叉。答卷详情 `GET /api/submissions/:id` 顺带返回 `reviewer` 与最近 20 条
`review_logs`（弹窗打开就要显示「上次谁批的」，再发一次请求等于把两次渲染拼在人眼前）。
阅卷队列的每一份也带 `reviewedAt` / `reviewer`：两个人各批了一半时，谁给了多少分要一眼看得见。

### 评分尺度：两个人对同一道题给了差多远的分

留痕能回答「谁批的、改了什么」，但两条痕迹只是并排摆着。张老师给 6 分、李老师给 17 分，
系统不会提醒任何人，成绩单照旧只有一个总分。教研组真正常做的事是「同一道题先各自批 10 份，
对一遍尺子再开工」——这件事现在能看了。

```
GET /api/forms/7/review-calibration?days=30
{ "ok": true, "data": {
  "conflicts": 18,
  "logs": 22,
  "questions": [
    { "id": "q1", "label": "简述 Raft 选主过程中任期号如何推进", "max": 20, "level": "明显",
      "cells": [ { "submissionId": 4, "gap": 12, "ratio": 0.6,
                   "by": [ { "name": "张老师", "value": 5 }, { "name": "李老师", "value": 17 },
                           { "name": "王老师", "value": 8 } ] } ] } ],
  "pairs": [ { "a": "张老师", "b": "李老师", "count": 18, "avgGap": 4.61, "bias": -4.61, "maxGap": 12 } ],
  "teachers": [ { "name": "张老师", "gradings": 12 }, { "name": "李老师", "gradings": 6 } ],
  "note": "" } }
```

不新建汇总表：`review_logs.changes` 里逐题记着 `from` / `to`，按 id 正序回放就能还原
「每一格最后是谁给了几分」。多一张统计表只多一个会跟留痕对不上的地方。

口径上有三条是刻意的：

- **只有「同一份答卷的同一道题被两个人给过不同的分」才算证据。**
  「这道题张老师平均给 12、李老师平均给 15」不算——他们批的可能是不同考生的答案，
  考生水平本来就有差。把两件事混成一个「分歧指数」，换来的只是一个没人敢信的排行榜。
- **撤分（`to: null`）不参与对账。** 它是「这个人对这格没有分数」，不是 0 分。
  把撤分当 0 算，一次误操作就能让整张尺子歪掉。
- **同一个人改两轮只认最后一次。** 改过分不等于第二个人。

一条只能承认、不能糊过去的事：**给分一致的两个人是不留痕的**（「分数没动就不落记录」是刻意定的，
见上）。所以接口不报「共对过 N 处」，只报「被后一位老师改过 N 处」——那是下限。
摆一个必然偏小的分母上去，只会让人得出「我们分歧率 90%」这种结论。

`level` 按**比例**折算，不按绝对分：满分 20 的题差 6 分以上算 `明显`（≥30%），
差 3 分以上 `值得看一眼`（≥15%），其余 `轻微`。满分 5 分差 2 分与满分 50 分差 2 分不是同一件事。

`pairs[].bias` 是「前者平均比后者高多少」：正数表示 `a` 更松，负数表示 `b` 更松。
它和 `avgGap`（绝对差多少）分开记——「谁偏松」与「差多少」是两个问题。

权限：需要表单的 `editor` 身份。只读协作者看不了——尺度对账会暴露「这份卷子谁给了几分」。

接口另外返回 `bands`，把「18 处分歧」换算成成绩单上的话：

```
"bands": { "submissions": 5, "maxSpread": 17 }
```

5 份卷子的总分因此带上了区间，最大浮动 17 分。浮动额是各题 (最高分 − 最低分) 相加，
与当前记着几分无关，所以这一项不读答卷、光靠留痕就对得上成绩单上那个区间。

### 成绩单上的尺子：分数带区间

尺度对账能看出李老师偏松，但成绩单上照旧只有孤零零一个 71 分——
没人知道这个 71 是严格尺子给的还是宽松尺子给的。同一道题张老师给 5 分、李老师给 17 分，
这份卷子的总分本来就该是「71 分，换个尺子会是 59 ~ 71」，而不是一个精确到小数点后两位的数字。

凡是返回答卷的地方都多一个 `band` 字段（没有区间时为 `null`）：

```
"band": {
  "score": 23, "low": 23, "high": 40, "spread": 17,
  "items": [
    { "id": "q1", "label": "简述 Raft 选主过程中任期号如何推进", "max": 20,
      "cur": 14, "low": 5, "high": 14,
      "by": [ { "name": "超级管理员", "value": 14 }, { "name": "李老师", "value": 5 } ] }
  ]
}
```

出现在这些位置：`GET /api/submissions`（每行）、`GET /api/submissions/:id`、
`GET /api/forms/:id/ranking`（榜单每行）、`GET /api/forms/:id/submissions.xlsx`
（多一列「分数区间」，写成 `6 ~ 25`）。

口径：

- **区间是「换个人批会几分」，不是「这个分有误差」。** 只对「同一份答卷同一道题、
  被两位以上老师给过不同分」的格子折算，其余格子照旧按现在的分算——没被第二个人批过的题，
  谁知道换个人会怎么给，把它的分也算成区间就是在编数字。
- **撤分（`to: null`）不参与。** 总分里本来就没有它的分，拿它去预测一个不存在的分，
  会算出比满分还高的区间。
- **两个人给同样的分不产生区间。** 这题换谁批都一样，成绩单上没必要留一个 0 宽的区间。
- **下界封在 0 分。** 一道题浮动 -18 分就能把总分压成负数，而负分不是成绩。
- **只在管理端出现。** 公开查询接口不给考生看区间：一句「你的 71 分可能是 59 分」
  在真实学校里只会变成一次申诉，而它本来是用来看「老师们的尺子齐不齐」的。

阅卷队列（`GET /api/forms/:id/review-queue`）的每道题另带 `others`：
这道题被两个人给出过不同的分时，列出两个人各自的分。它**不管这题现在有没有分**——
一道题刚被撤分时总分里已经没有它了，但「张老师给过 4、李老师给过 16」这件事
仍然必须摆在下一个批阅的人眼前，否则他就是第三个随手定口径的人。

回放逻辑只有一份（`web/js/review.js` 的 `replayCells`），浏览器与服务端共用：
尺度对账、分数区间、阅卷提醒三个出口都走它。写两遍必然分叉——一处把撤分当 0 分、
另一处不当，整张成绩单就会自相矛盾。

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
| GET | `/api/files/raw/*` | 读取本地存储的文件（需会话或签名票据） |

登录用户可直接上传；未登录时**必须**带 `formId`，且该表单需为已发布状态——公开填写页的附件
依赖这条路径，其他场景一律要求登录，避免被当成公共图床。

交卷时服务端会把答卷数据里引用到的文件（`{id,url,...}`）认领到该答卷，
`GET /api/forms/:id/attachments.zip` 才能打全。

**上传类型按真实内容判断**：`.html / .svg / .xml / .js / .css` 等「浏览器会当页面执行」的扩展名一律 `415`，
声明成图片实为 HTML、无扩展名但开头像网页的同样拒绝。读取时非图片/PDF/音视频/纯文本一律转成
`Content-Disposition: attachment`，且所有文件响应带 `Content-Security-Policy: sandbox` 与 `nosniff`。

**限流**：`POST /api/upload` 默认每分钟每 IP 60 次（登录用户 5 倍额度），交卷与答卷查询各 120 次，
可在「系统设置 → 站点 → 公开接口频率上限」调整。超出返回 `429`，响应头带 `Retry-After`（秒）。

### 下载需要鉴权

`GET /api/files/raw/<key>` 不再匿名可读。两条准入路径：

1. **签名票据** `?e=<过期毫秒>&s=<HMAC>`。上传接口返回的 `url` 就带着它，
   匿名填表的人靠这个预览自己刚传的图片。有效期 6 小时，只对那一个 key 有效。
2. **登录会话**。管理员、文件上传者、以及该文件所属表单的协作者可以直接访问，
   URL 里不用带任何凭据（浏览器自动带 Cookie）。

无关账号拿到完整路径返回 `403`，没有任何凭据返回 `401`。

票据只用于「此刻给这个浏览器的通行证」，**不入库**：答卷里存的是不带参数的规范路径，
读取时按当前身份的权限现签。所以导出的 Excel、WebHook 推送里的地址不会过期。

富文本正文内嵌的图片、表单头图 / 背景图在公开页上同样会换签，访客不会看到一片裂图。

**跨域**：只对同源和「跨域白名单」里的来源回 `Access-Control-Allow-Origin`。白名单默认空，
需要单独部署前端或让自有系统直连时再填；`X-API-Key` 的服务端调用不受影响（那本来就不受浏览器同源策略约束）。

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

## 表单协作

一份问卷 / 考试可以拉多个维护人，身份与题库协作同一套词（避免同一个词在两种资源里意思不同）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/forms/:id/members` | 成员列表 + `my_role`；`candidates`（仅所有者返回） |
| POST | `/api/forms/:id/members` | 加协作者 `{username\|userId, role: "editor"\|"viewer"}`；同一个人再传一次即改角色（返回 `updated: true`） |
| DELETE | `/api/forms/:id/members/:userId` | 移除协作者 |

| 能做什么 | 管理员 | 所有者 | editor | viewer |
| --- | --- | --- | --- | --- |
| 看表单、看报表 / 排名（汇总） | ✓ | ✓ | ✓ | ✓ |
| 改题目、导入、发布、发布控制 | ✓ | ✓ | ✓ | ✗ |
| 看答卷明细、批阅、导出 Excel、打包附件 | ✓ | ✓ | ✓ | ✗（接口返回 403，不是「还没有答卷」） |
| 管协作者 | ✓ | ✓ | ✗ | ✗ |
| 删除 / 恢复 / 彻底删除表单 | ✓ | ✓ | ✗ | ✗ |

只读刻意不给答卷明细与导出：他的权限是「看汇总」，不是把整库答卷带走。
能逐行读、只是不能点下载按钮，那不叫只读。
`GET /api/forms` 每行带 `my_role`，前端据此决定露出哪些按钮——点了才弹 403 比没有按钮更恼人。
删除账号时会一并清掉 `form_members` 行，否则 id 被新账号复用就凭空继承一份权限。

## 模板

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/templates` | 模板列表 |
| POST | `/api/templates/:id/use` | 基于模板创建表单 |

## 文件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/upload` | multipart 上传，字段名 `file` |
| GET | `/api/files/raw/:key` | 读取本地文件（需会话或签名票据） |
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
| POST | `/api/backup/inspect` | 备份包体检（multipart，字段 `file`；只读，不改任何数据） |
| POST | `/api/backup/import` | 备份导入（multipart，字段 `file`；先校验后顶替，自动快照） |
| GET | `/api/backup/snapshots` | 可回滚快照列表 |
| POST | `/api/backup/rollback` | 回滚，body `{ name? }` 省略则回滚到最近一份 |
| GET | `/api/system/info` | 系统信息 |
| GET | `/api/health` | 健康检查 |

## AI

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/ai/generate` | `{prompt, kind, lang, model?}` → 生成表单 schema；`source` 为 `ai`（真模型）或 `local`（降级模板），后者带 `warning` |
| POST | `/api/ai/stream` | SSE 流式生成，见下 |
| GET | `/api/ai/models?refresh=1` | 模型列表（透传上游 `/models`）+ 生成语言候选；上游不可用时 `reachable:false` 并给 `reason`，前端退回手填 |
| GET | `/api/ai/config` | 当前 AI 配置（Key 已脱敏） |
| POST | `/api/banks/:id/explain` | `{questionId, value?, force?}` → `{text, source}`，`source` 为 `ai` / `local` / `stored` |

### 流式生成的帧

```
data: {"delta":"...","fields":[{...}]}   ← 每帧带上「已配平的题目」，前端据此一道一道画
data: {"done":true,"title":"...","description":"...","schema":[...]}
data: {"error":"...","fallback":{...},"done":true}   ← AI 不可用时降级
```

`fields` 里只会有 JSON 已经配平完成的题目：半个对象（`{"type":"radio","la`）不会被当成一道题下发。
题干里的中文括号、转义引号都不影响配平。

`/api/ai/models`、`/api/ai/config` 需要管理员权限；`/api/banks/:id/explain` 跟随题库身份——
「只读」协作者问解析时，提示词与返回内容都不含标准答案。

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

## 数据字典

固定选项（学历、行业、问题类型…）集中维护一份，表单绑定后按需同步。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/dicts` | 登录 | 全部字典；`?items=1` 连选项一起返回 |
| GET | `/api/dicts/:code` | 登录 | 单套字典，附 `usedBy`（哪些表单绑定了它） |
| GET | `/api/public/dicts/:code` | 匿名 | 填写页渲染用，只返回**启用**的选项 |
| POST | `/api/dicts` | 管理员 | `{ name, code?, description?, items? }`，`code` 省略则由名称生成 |
| PUT | `/api/dicts/:code` | 管理员 | 改名 / 说明 / 排序（`code` 不可改，表单里存的就是它） |
| DELETE | `/api/dicts/:code` | 管理员 | 一并删除选项；响应里 `affectedForms` 是受影响的表单 |
| GET | `/api/dicts/:code/items` | 登录 | 选项列表（含停用项） |
| POST | `/api/dicts/:code/items` | 管理员 | 单条新增 |
| PUT | `/api/dicts/:code/items` | 管理员 | **整批替换**，同批重复 value 丢弃并回 `dropped` |
| PUT | `/api/dicts/:code/items/:id` | 管理员 | 改名 / 改值 / 启停 / 排序 |
| DELETE | `/api/dicts/:code/items/:id` | 管理员 | 删除单条 |
| POST | `/api/dicts/:code/items/import` | 管理员 | `{ text }` 一行一项，`名称\|值\|上级的值` 可选；已存在的值跳过并计入 `skipped` |
| GET | `/api/dicts/:code/export.xlsx` | 登录 | 导出为 xlsx（列：显示名称 / 存储值 / 上级 / 启用 / 排序），导出文件也是导入模板 |
| POST | `/api/dicts/:code/import-xlsx` | 管理员 | 上传 xlsx **追加**选项，已存在的值计入 `skipped`；表头可乱序，无表头按列位置读 |

### 层级（级联选择的选项来源）

`dict_items` 有一个 `parent` 列（默认空 = 顶级）。字典一旦带层级，设计器里「级联选择」
就能直接「从字典取用」，省 / 市 / 区这类选项从此也只有一份来源。

三条写库时的约束，都是为了避免级联里出现「看不见的选项」：

- 上级必须是**本字典里已存在的值**，否则拒绝（这一项会永远不出现在任何下拉里）；
- 不能以自己为上级，也不能把自己的下级设成上级（父子成环，渲染时无限递归）；
- 改某一项的 `value` 时，挂在它下面的子项 `parent` 一起改——否则改个值把整棵子树弄丢。

删除一项时子项**提成顶级**而不是跟着删；批量保存时上级写错的项被修正成顶级并在
`notes[]` 里说明，一条坏数据不会让整批 200 项都存不进去。

### 表单与字典的绑定

设计器里给选择题「从字典取用」时，选项会**拷贝**进 `schema[i].options`，同时记下
`schema[i].props.dict = '<code>'`。这是快照，不是引用。

理由：引用式绑定下，改一次字典里一个错别字，上个月已经发出去、已经收回三千份答卷那张表的
选项就跟着变了——历史答卷的值突然对不上任何选项，报表里全成「其他」。
所以字典改动只影响「以后主动同步」的表单：

```
POST /api/forms/:id/sync-dict          # 同步这张表上所有绑定字典的题
POST /api/forms/:id/sync-dict?code=xx  # 只同步某一套字典
```

同步按 `value` 认题：值还在的只更新显示名，值已不在字典里（或被停用）的从选项里移除，
字典新增的按字典顺序补齐；标准答案里指向被移除项的一并剔除（否则这题变成「谁答都错」）。
响应里 `changes[]` 逐题给出 `added / removed / relabeled / droppedAnswers`。

### 部门树作为选项来源

「按部门选人 / 报名」这类题以前只能手填一串部门名，而部门树早就在用户管理里维护着——
同一份组织架构抄两遍，迟早两份不一样。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/options/depts` | 登录 | 部门树转成的级联选项（`[{label, value, parent}]`，`value` 是部门 id） |
| POST | `/api/forms/:id/sync-depts` | `form:update` + 表单编辑权 | 把 `props.source === 'dept'` 的题按当前组织架构重新同步 |

和字典同一套取舍：**快照，不是引用**。部门合并 / 改名 / 撤销不该静默改动一张已经收回来几千份的
问卷——历史答卷里的部门 id 要对得上，报表里那一档不能凭空消失。`value` 用部门 id 而不是名字：
部门改名是常事，改名不该让历史答卷失去对应项。

同步口径与字典一致（按 `value` 认题：改名 / 新增 / 移除 / 失效标准答案剔除），
响应 `changes[]` 逐题给出细节。部门被删掉的选项会从卷面移除，但**历史答卷里的那个 id
仍然认得出来**（报表按 id 计数，不按选项列表）。

### 级联的作答控件

`schema[i].props.picker` 决定级联题怎么作答：

| 值 | 行为 |
|---|---|
| 不填 / `auto` | 节点数 ≥ 24 时用搜索式，否则用层级下拉 |
| `select` | 总是层级下拉（省 / 市 / 区逐级选） |
| `search` | 总是搜索式：输入关键字，直接给出可点的完整路径 |

两条路径的作答口径完全一样：只存**最末一级**的 `value`，判分、必填、条件逻辑、统计都不需要区分。
`picker` 属于外观配置，会随公开页的 `props` 一起下发（`props.source` 这类内部标记不下发）。
