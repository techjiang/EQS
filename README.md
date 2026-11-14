<div align="center">

<img src="assets/eqs-logo.svg" width="128" alt="EQS Logo">

# EQS

**开源的一体化问卷 · 考试 · 刷题平台**

拖拽生成表单 · AI 一句话成卷 · 实时统计报表 · 数据完全私有

[![Node](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](#-docker-部署)

</div>

---

## 为什么选 EQS

| 特性 | 说明 |
| --- | --- |
| **真正一体化** | 问卷、考试、刷题不是三个割裂的产品，题库、用户、权限、数据统一管理 |
| **零依赖部署** | 只用 Node.js 22+ 内建能力，`npm install` 都不需要，复制解压即启动 |
| **数据自己掌控** | 单文件内嵌数据库 + 本地文件存储，一个目录就是全部数据，备份=压缩一个文件夹 |
| **28+ 组件** | 拖拽即用，覆盖文本、选择、量表、矩阵、子表单、签名、定位等全部常见场景 |
| **AI 加持** | 兼容 OpenAI 接口，支持 SiliconFlow / DeepSeek / Qwen / Llama；流式生成边吐边画（题目一道一道长出来），模型可从真实列表里切换，可按语言生成；刷题页逐题给 AI 解析 |
| **完整闭环** | 从创建、发布、作答，到评分、练习、报表、导出，全部在同一平台完成 |

## 功能特点

**问卷与表单**
- 28+ 自定义组件，拖拽式可视化设计，支持文本 / Excel 批量导入题目
- 单行/多行文本、日期、下拉、单选、多选、文件上传、排序、级联、轮播、一键定位、手机号校验、矩阵量表、子表单、手写签名、评分、NPS、滑动条、分割线、富文本等
- 条件逻辑全打通：显示隐藏、动态必填、条件跳转提前结束、自动带入、公式计算、题干引用作答
  （等于/不等于/包含/大小比较/为空，多条件组合；「选了其他才必填」「没有预算就直接结束」都能拖出来）
- 表单外观配置：头图、背景图、背景色、按钮文字与颜色
- 提交后自定义文案、提交后自动跳转网址、按答卷编号查询

**发布控制**
- 按微信 / 账号 / IP / 设备限制答题次数，可要求「仅登录用户填写」（未登录在首页就换成登录入口，填完才被拒是最糟的体验）
- 允许填写时间窗口、访问密码、仅限微信内填写
- 记录微信昵称与头像（公众号网页授权）

**数据管理**
- 答卷新增、编辑、批量删除、筛选、标记、导入、导出（Excel / CSV / JSON）、打印
- 附件打包下载（内置 ZIP 打包，无需外部工具）
- 实时统计报表：柱状图 / 折线图 / 饼图，一键导出 PNG

**考试与刷题**
- 题库管理、Excel 导入导出（下载模板 → 填表 → 导回，形成闭环）、智能组卷、随机抽题、题目复用
- 多题库混合组卷：跨题库轮转抽题，一张卷子覆盖多个知识域，比例自动均摊
- 题目标签：文本导入写「标签：数据库,基础」、Excel 多一列「标签」、编辑弹窗直接改；
  按标签筛题、按标签组卷，筛选落空时明确报错而不是偷偷退回全库
- 题库协作：一个题库可以拉多个维护人，「可编辑」能增删改题与组卷、「只读」只能看题与刷题；
  只读身份下不下发标准答案、也导不出带答案的 Excel——不然「只读」只在界面上成立
- 正确答案、分值、答案解析、自动评分、及格判定
- 成绩排名：管理端榜单（前 N 名 + 分数分布），交卷即显示「第几名 / 超过百分之多少」；
  同分同名次、下一名跳号；公开成绩榜可选开启，名字打码，只给名次与分数
- 判分口径统一：单选/多选/判断比选项，填空比文本（忽略大小写与空格），**排序比顺序**，**矩阵逐行比**；
  交卷判分、交卷回顾、刷题判题共用同一份实现，不会出现「刷题判对、交卷判错」
- 主观题人工批阅：逐题给分、满分/0 分快捷操作、批阅备注，保存即重算总分与及格状态
- 「待批阅」筛选，阅卷队列一眼看清还有多少份没批
- 顺序练习 / 随机练习 / 错题练习 / 收藏练习，答题卡、即时判题、学习笔记、练习进度
- 连续答对可自动移出错题集
- 题目收藏、学习笔记、**AI 解析**：逐题讲清为什么是这个答案、错项错在哪；
  题库里已有解析的直接读库不重复调用，AI 未配置时退回本地解析并标明来源，
  「只读」协作者问解析时不会把标准答案递给他

**平台能力**
- 用户管理、角色权限（RBAC）
- 组织架构：多级部门树（可改名、可换上级、删前校验占用）、职位挂在部门下，用户带「部门 / 职位」
- 表单协作：一份问卷 / 考试可拉多个维护人，「可编辑」能改题、发布、看数据与批阅，
  「只读」只能看表单与报表；只有所有者能管成员与删除。身份判断收敛在一处，
  列表 / 数据 / 报表 / 导出 / 附件 / 导入全部同一口径（以前 29 处各自写着 created_by）
- 模板中心：6 套内置模板，一键套用，任意表单可存为模板
- 回收中心：误删的表单、答卷、题库与题目都能恢复；彻底删除要求先入回收站，并连带清理附件文件
- 文件存储：本地 / 阿里云 OSS / 七牛云 / 又拍云 / 通用 S3
- 通知：SMTP 邮件、阿里云/腾讯云/中昱维信短信、微信公众号模板消息
- 数据同步 API（全量导出）+ WebHook 推送（新增/修改/删除，HMAC 签名）
- 第三方登录：Google OAuth、微信扫码
- 地图能力：高德地图 Key 配置用于地理题型
- 国际化：界面多语言资源可扩展，可在线编辑
- 深色模式、响应式布局，PC 与移动端皆可作答

## 快速开始

### 方式一：直接运行（推荐）

```bash
git clone https://cnb.cool/sleepyheade/EQS.git
cd EQS
bash scripts/start.sh
```

Windows 用户双击 `scripts\start.bat` 即可，脚本会自动打开浏览器。

打开 http://localhost:8080，默认账号 `admin` / `admin123`（**首次登录请立即修改密码**）。

> 需要 Node.js 22 或更高版本。没有 `npm install`，没有数据库安装，没有外部中间件。

### 方式二：Docker

```bash
docker run -d --name eqs -p 8080:8080 -v $(pwd)/data:/data eqs:latest
```

或用 compose：

```bash
docker compose up -d
```

### 方式三：Windows / 宝塔面板

- Windows：解压后双击 `scripts\start.bat`
- 宝塔：软件商店安装「Node 项目管理器」→ 添加项目 → 运行命令填 `node server/index.js`，端口 8080

## 部署到生产

```bash
# 1. 复制到服务器
scp -r EQS/ user@server:/opt/eqs

# 2. 用 systemd 托管
sudo cp deploy/eqs.service /etc/systemd/system/
sudo systemctl enable --now eqs

# 3. 配置 Nginx 反向代理（示例见 deploy/nginx.conf）
sudo cp deploy/nginx.conf /etc/nginx/conf.d/eqs.conf
sudo nginx -s reload

# 4. 打开后台 → 系统设置 → 站点 → 「客户端 IP 来源」选「信任代理头」，层数 1
#    不做这步，所有访客的 IP 都是 127.0.0.1，「每个 IP 限填一次」会变成「全站只能填一次」
```

## 备份与迁移

EQS 的所有状态都在 `data/` 目录里：`eqs.db`（数据库）和 `files/`（上传文件）。

**方式一：后台导出**
系统设置 → 系统与备份 → 导出备份，得到一个 ZIP 包；导入同一个 ZIP 当场生效（不用重启）。

- 导出是**流式**的：边读边压边发，内存不随数据量涨。几个 G 的附件目录也一样能导
- 包里带一份 `manifest.json`（版本、导出时间、各表行数、数据库 sha256），排查「这个包是什么时候的」不用解压猜
- 导入前会校验包里的 `eqs.db`：文件头、`integrity_check`、核心表齐全，通不过就当场拦下，不会拿坏库顶替
- 顶替前自动存一份快照（`data/.backups/`），页面下方「可回滚快照」一键撤回，回滚本身也能再撤回
- 单次导入上限 8GB（请求体流式落盘，不受普通接口 64MB 的限制）

**方式二：直接打包目录**

```bash
bash scripts/backup.sh          # 生成 backups/eqs-backup-<时间>.tar.gz
```

> 两种方式都会先用 SQLite 的一致性快照（`wal_checkpoint` / `VACUUM INTO`）把 WAL 里的数据落盘再打包。
> 服务运行中直接 `tar data/` 可能拿到一个没有表的空库——那是 WAL 模式的坑，不是备份成功。

**迁移到新机器**

```bash
tar -xzf eqs-backup-20250101-120000.tar.gz   # 解出 data/
bash scripts/start.sh                        # 启动即完成迁移
```

数据库换成外部 MySQL 需求可参考 `docs/architecture.md`。

## 配置说明

所有配置都在后台「系统设置」里完成，无需改配置文件：

| 分类 | 配置项 |
| --- | --- |
| 站点 | 名称、标语、Logo、访问地址、ICP 备案 |
| 文件存储 | 本地 / 阿里云 OSS / 七牛云 / 又拍云 / S3 |
| 邮件 | SMTP 服务器、端口、SSL、账号密码、发件人 |
| 短信 | 阿里云 / 腾讯云 / 中昱维信 |
| 微信 | 公众号 AppID、AppSecret、模板消息 |
| 第三方登录 | Google OAuth、微信开放平台 |
| 地图 | 高德地图 Key 与安全密钥 |
| AI | OpenAI Compatible 接口地址、Key、默认模型（可从 `/models` 真实列表里选）、温度 |
| WebHook | 回调地址、订阅事件、签名密钥 |
| API Key | 外部系统调用凭证 |

环境变量（可选）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `EQS_DATA_DIR` | `./data` | 数据目录 |
| `EQS_ADMIN_PASSWORD` | `admin123` | 初始化管理员密码（仅首次生效） |

## API

请求头带 `Cookie: eqs_token=…`（登录会话）或 `X-API-Key: eqs_…`（在系统设置 → API Key 创建）。

> **登录会话存在服务端**：`/api/auth/sessions` 可以列出账号登过的设备并单独踢掉其中一台，
> 退出登录会吊销服务端那一条（不只是删浏览器 Cookie），改密码 / 被重置 / 被停用会作废该账号全部会话。
>
> **API Key 只拥有签发人本人的权限**：管理员签的 Key 才是管理员级，普通用户签不了 Key。停用后立即失效。
> 这条以前写的是「等同管理员权限」，于是任何登录用户自助签一把 Key 就能导出整站数据——现在不成立了。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | 登录 |
| `GET` | `/api/forms` | 表单列表 |
| `POST` | `/api/forms` | 创建表单 |
| `PUT` | `/api/forms/:id` | 更新表单 |
| `POST` | `/api/forms/:id/import-text` | 文本批量导入题目，返回 `{added, droppedAnswers}` |
| `POST` | `/api/forms/:id/import-xlsx` | Excel 批量导入题目（multipart，字段 `file`） |
| `GET` | `/api/banks/:id/export.xlsx` | 题库导出 Excel；`/api/banks/template.xlsx` 取导入模板 |
| `GET` | `/api/forms/:id/submissions.xlsx` | 导出全部答卷（按筛选条件，不受分页影响） |
| `GET` | `/api/public/forms/:id` | 公开读取表单（不含答案） |
| `POST` | `/api/public/forms/:id/submit` | 提交答卷 |
| `GET` | `/api/forms/:id/report` | 报表统计 |
| `GET` | `/api/submissions?formId=1` | 答卷列表 |
| `GET` | `/api/sync/export?formId=1&sinceId=0&limit=1000` | 增量数据同步（游标分页） |
| `GET` | `/api/backup/export` | 备份导出（流式 zip） |
| `POST` | `/api/backup/import` | 备份导入（先校验、后顶替，自动存快照） |
| `GET` | `/api/backup/snapshots` | 可回滚快照列表 |
| `POST` | `/api/backup/rollback` | 回滚到指定快照（默认最近一份） |
| `GET` | `/api/health` | 健康检查 |

## 技术栈

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js 22+ | 内置 `node:sqlite`、`fetch`、`WebSocket`，零依赖 |
| 数据库 | SQLite（WAL） | 单文件、无需运维、备份即复制 |
| 后端 | 原生 `node:http` + 自研路由 | 无框架开销，毫秒级冷启动 |
| 前端 | Vue 3（ESM 版）+ ECharts | 本地化引入，无构建步骤，离线可用 |
| 存储 | 本地磁盘 / OSS / 七牛 / 又拍 / S3 | 按需切换 |

更多文档：
- [架构设计](docs/architecture.md)
- [API 参考](docs/api.md)
- [视觉设计](docs/design.md)
- [常见问题](docs/faq.md)

## 开发

```bash
node --watch server/index.js   # 热重启
node tests/smoke.test.js       # 冒烟测试（590 项）
```

## 项目结构

```
EQS/
├── server/            # 后端
│   ├── index.js       # 入口与路由装配
│   ├── lib/           # 数据库、鉴权、表单引擎、存储、通知、AI
│   └── routes/        # 各业务模块接口
├── web/               # 前端（无构建）
│   ├── index.html
│   ├── css/app.css    # 设计系统
│   ├── js/            # 视图与组件渲染器
│   └── vendor/        # 本地化的 Vue 与 ECharts
├── assets/            # Logo 与图标源文件
├── deploy/            # Nginx / systemd 示例
├── scripts/           # 启动与备份脚本
├── tests/             # 冒烟测试
└── docs/              # 文档
```

## 贡献

欢迎提交 Issue 与 PR。提交前请确保 `node tests/smoke.test.js` 全部通过。

## 许可证

[MIT](LICENSE)
