import { h, ref, onMounted, computed } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { ok, err, confirmBox, fmtSize, fmtDate, Empty, Modal } from '../ui.js'
import { state } from '../store.js'

const TABS = [
  ['site', '站点'], ['storage', '文件存储'], ['mail', '邮件'], ['sms', '短信'],
  ['wechat', '微信'], ['oauth', '第三方登录'], ['map', '地图'], ['ai', 'AI 模型'],
  ['webhook', 'WebHook'], ['apikey', 'API Key'], ['i18n', '多语言'], ['system', '系统与备份']
]

export default {
  setup() {
    const tab = ref('site')
    const cfg = ref({})
    const keys = ref([])
    const hooks = ref([])
    const info = ref(null)
    const loading = ref(true)
    const saving = ref(false)
    const hookEditing = ref(null)
    const i18nData = ref({})
    const lang = ref('zh')

    const load = async () => {
      loading.value = true
      try {
        const r = await api.get('/api/settings')
        cfg.value = r.data
        const [k, h, i] = await Promise.all([
          api.get('/api/api-keys').catch(() => ({ data: [] })),
          api.get('/api/webhooks').catch(() => ({ data: [] })),
          api.get('/api/system/info').catch(() => ({ data: null }))
        ])
        keys.value = k.data
        hooks.value = h.data
        info.value = i.data
        await loadI18n()
      } catch (e) { err(e.message) } finally { loading.value = false }
    }
    onMounted(load)

    const loadI18n = async () => {
      const r = await api.get(`/api/i18n/${lang.value}`).catch(() => ({ data: {} }))
      i18nData.value = r.data || {}
    }

    const save = async (key) => {
      saving.value = true
      try {
        await api.put(`/api/settings/${key}`, cfg.value[key] || {})
        ok('已保存')
        if (key === 'site') {
          const p = await api.get('/api/settings/public')
          state.site = { ...state.site, ...p.data }
        }
      } catch (e) { err(e.message) } finally { saving.value = false }
    }

    const testMail = async () => {
      const to = prompt('测试接收邮箱')
      if (!to) return
      try { await api.put('/api/settings/mail', cfg.value.mail); const r = await api.post('/api/settings/mail/test', { to }); ok(r.message) } catch (e) { err(e.message) }
    }
    const testSms = async () => {
      const phone = prompt('测试手机号')
      if (!phone) return
      try { await api.put('/api/settings/sms', cfg.value.sms); await api.post('/api/settings/sms/test', { phone }); ok('测试短信已发送') } catch (e) { err(e.message) }
    }

    const addKey = async () => {
      const name = prompt('密钥名称', '集成密钥')
      if (name === null) return
      try {
        const r = await api.post('/api/api-keys', { name })
        ok('已创建，请立即保存：' + r.key)
        prompt('请复制并妥善保存（只显示一次）。它只拥有创建者本人的权限。', r.key)
        load()
      } catch (e) { err(e.message) }
    }

    const saveHook = async () => {
      try {
        if (hookEditing.value.id) await api.put(`/api/webhooks/${hookEditing.value.id}`, hookEditing.value)
        else await api.post('/api/webhooks', hookEditing.value)
        ok('已保存')
        hookEditing.value = null
        load()
      } catch (e) { err(e.message) }
    }

    const testHook = async (h) => {
      try { const r = await api.post(`/api/webhooks/${h.id}/test`); ok('测试已发送') } catch (e) { err(e.message) }
    }

    const saveDefaultLang = async () => {
      if (!cfg.value.i18n) return
      try {
        await api.put('/api/settings/i18n', cfg.value.i18n)
        ok('默认语言已保存')
      } catch (e) { err(e.message) }
    }

    const saveI18n = async () => {
      try { await api.put(`/api/i18n/${lang.value}`, i18nData.value); ok('语言资源已保存') } catch (e) { err(e.message) }
    }

    /* ---------- 备份与迁移 ---------- */
    const backups = ref([])
    const importing = ref(false)
    const backingUp = ref(false)
    const rollingBack = ref(false)

    const loadSnapshots = async () => {
      try {
        const r = await api.get('/api/backup/snapshots')
        backups.value = r.data || []
      } catch { backups.value = [] }
    }
    onMounted(loadSnapshots)

    const backup = async () => {
      backingUp.value = true
      try {
        // 备份越大越久：服务端现在是边压边发，浏览器这边等首字节的时间也变长，
        // 按钮不给反馈的话用户会以为没点上，连点五次就是五份备份同时在跑
        await api.download('/api/backup/export', `eqs-backup-${Date.now()}.zip`)
        ok('备份已导出')
      } catch (e) { err(e.message) } finally { backingUp.value = false }
    }

    const restore = async (file) => {
      if (!file) return
      if (!await confirmBox('导入备份会用备份里的数据顶替当前数据库（附件按合并处理）。导入前系统会自动存一份快照，可在下方「回滚」撤回。确认继续？')) return
      importing.value = true
      try {
        const fd = new FormData()
        fd.append('file', file)
        const res = await fetch('/api/backup/import', { method: 'POST', body: fd, credentials: 'same-origin' })
        const j = await res.json()
        if (!j.ok) throw new Error(j.message)
        ok(j.message + (j.snapshot ? `；已存快照 ${j.snapshot}，可随时回滚` : ''))
        // 数据库整个被替换了：当前页面里的表单列表、统计数字全是旧库的，必须重新拉一遍
        await Promise.all([load(), loadSnapshots()])
      } catch (e) { err(e.message) } finally { importing.value = false }
    }

    const rollback = async (name) => {
      if (!await confirmBox(`回滚到 ${name}？当前数据会先被另存一份，回滚本身也能再撤回。`)) return
      rollingBack.value = true
      try {
        const r = await api.post('/api/backup/rollback', { name })
        ok(`${r.message}；当前状态已存为 ${r.safety}`)
        await Promise.all([load(), loadSnapshots()])
      } catch (e) { err(e.message) } finally { rollingBack.value = false }
    }

    const field = (label, node, hint) => h('div', { class: 'field' }, [h('label', {}, label), node, hint ? h('div', { class: 'hint' }, hint) : null])
    const txt = (obj, key, placeholder = '', type = 'text') => h('input', {
      class: 'input', type, value: obj?.[key] ?? '', placeholder,
      onInput: e => { cfg.value[tab.value][key] = type === 'number' ? Number(e.target.value) : e.target.value }
    })
    const sw = (obj, key, label) => h('div', { class: 'field' }, h('label', { class: 'flex between' }, [
      h('span', {}, label),
      h('div', { class: ['switch', obj?.[key] ? 'on' : ''], onClick: () => cfg.value[tab.value][key] = !obj?.[key] })
    ]))
    const ensure = (k) => { if (!cfg.value[k]) cfg.value[k] = {}; return cfg.value[k] }

    const body = () => {
      const c = cfg.value
      switch (tab.value) {
        case 'site': {
          const s = ensure('site')
          return h('div', {}, [
            field('站点名称', txt(s, 'name', 'EQS')),
            field('站点标语', txt(s, 'slogan', '一体化问卷 · 考试 · 刷题平台')),
            field('Logo 地址', txt(s, 'logo', '/assets/eqs-mark.svg')),
            field('站点访问地址', txt(s, 'baseUrl', 'https://your-domain.com'), '用于生成回调地址与第三方登录'),
            field('ICP 备案号', txt(s, 'icp', '')),
            sw(s, 'allowRegister', '允许自助注册'),
            h('div', { class: 'hint' }, '默认关闭。问卷系统里的账号等于「能建卷、能看自己那份数据」，陌生人注册进来没有审核环节，建议只在内部试用时打开。'),
            h('div', { style: 'height:14px' }),
            field('客户端 IP 来源', (() => {
              const cur = s.trustProxy === true ? 'on' : ['auto', 'on'].includes(s.trustProxy) ? s.trustProxy : 'off'
              // 选项用 selected 而不是只给 select 一个 value：props 在子节点之前应用，
              // 只写 value 时浏览器还没得选，下拉框会显示成空白
              return h('select', {
                class: 'select', style: 'max-width:340px', value: cur,
                onChange: e => s.trustProxy = e.target.value
              }, [
                ['off', '不信任（默认）：只认 TCP 对端地址'],
                ['on', '信任代理头：按层数从右往左取（Nginx 反代选这个）'],
                ['auto', '仅当对端是本机/内网时才采信，取最右段']
              ].map(([v, l]) => h('option', { value: v, selected: v === cur }, l)))
            })()),
            s.trustProxy === 'on' ? field('代理层数', h('input', {
              class: 'input', type: 'number', min: 1, max: 5, value: s.trustHops ?? 1,
              onInput: e => s.trustHops = Number(e.target.value) || 1
            }), '从右往左第几段是可信代理写的。Nginx 直接反代就是 1，前面再加一层 CDN 就是 2。') : null,
            h('div', { class: 'hint' },
              'X-Forwarded-For 是客户端自己发的头，无条件相信它会让「每个 IP 限填一次」「登录失败锁号」两条防线失效——' +
              '换个头就换了个计数器和一条新身份。默认不信任。' +
              '如果你用 Nginx 反代（deploy/nginx.conf 那套），必须改成「信任代理头、1 层」，否则所有人的 IP 都是 127.0.0.1，' +
              '「每个 IP 限填一次」会变成「全站只能填一次」。')
          ])
        }
        case 'storage': {
          const s = ensure('storage')
          if (!s.driver) s.driver = 'local'
          return h('div', {}, [
            field('存储方式', h('select', {
              class: 'select', value: s.driver, onChange: e => s.driver = e.target.value
            }, [['local', '本地存储（默认，无需配置）'], ['aliyun', '阿里云 OSS'], ['qiniu', '七牛云'], ['upyun', '又拍云'], ['s3', '通用 S3 协议']].map(([v, l]) => h('option', { value: v }, l)))),
            s.driver === 'local' ? h('div', { class: 'hint' }, '文件保存在 data/files 目录，随备份一起迁移。') : null,
            ['aliyun', 'qiniu', 'upyun'].includes(s.driver) ? field('Access Key', txt(s, 'accessKey')) : null,
            ['aliyun', 'qiniu', 'upyun'].includes(s.driver) ? field('Secret Key', txt(s, 'secretKey', '', 'password')) : null,
            ['aliyun', 'qiniu', 'upyun'].includes(s.driver) ? field(s.driver === 'upyun' ? '操作员密码' : '存储空间 Bucket', txt(s, 'bucket')) : null,
            s.driver === 'upyun' ? field('操作员', txt(s, 'operator')) : null,
            s.driver === 'upyun' ? field('密码', txt(s, 'password', '', 'password')) : null,
            s.driver === 'aliyun' ? field('地域（如 oss-cn-hangzhou）', txt(s, 'region', 'oss-cn-hangzhou')) : null,
            s.driver === 's3' ? field('Endpoint', txt(s, 'endpoint', 'https://s3.amazonaws.com')) : null,
            s.driver === 's3' ? field('Bucket', txt(s, 'bucket')) : null,
            s.driver === 's3' ? field('Region', txt(s, 'region', 'us-east-1')) : null,
            s.driver === 's3' ? field('Access Key', txt(s, 'accessKey')) : null,
            s.driver === 's3' ? field('Secret Key', txt(s, 'secretKey', '', 'password')) : null,
            s.driver !== 'local' ? field('CDN / 访问域名', txt(s, 'domain', 'https://cdn.example.com')) : null
          ])
        }
        case 'mail': {
          const m = ensure('mail')
          return h('div', {}, [
            sw(m, 'enabled', '启用邮件通知'),
            field('SMTP 服务器', txt(m, 'host', 'smtp.example.com')),
            field('端口', txt(m, 'port', '465', 'number')),
            sw(m, 'secure', '使用 SSL/TLS'),
            field('账号', txt(m, 'user', 'noreply@example.com')),
            field('密码 / 授权码', txt(m, 'pass', '', 'password')),
            field('发件人名称', txt(m, 'fromName', 'EQS 问卷系统')),
            field('发件人邮箱', txt(m, 'from', 'noreply@example.com')),
            h('button', { class: 'btn', onClick: testMail }, '发送测试邮件')
          ])
        }
        case 'sms': {
          const s = ensure('sms')
          if (!s.provider) s.provider = 'aliyun'
          const p = s.provider
          return h('div', {}, [
            field('服务商', h('select', {
              class: 'select', value: p, onChange: e => s.provider = e.target.value
            }, [['aliyun', '阿里云短信'], ['tencent', '腾讯云短信'], ['zhongyu', '中昱维信']].map(([v, l]) => h('option', { value: v }, l)))),
            p === 'aliyun' ? field('AccessKeyId', txt(s, 'accessKey')) : null,
            p === 'aliyun' ? field('AccessKeySecret', txt(s, 'secretKey', '', 'password')) : null,
            p === 'aliyun' ? field('地域', txt(s, 'region', 'cn-hangzhou')) : null,
            p === 'tencent' ? field('SecretId', txt(s, 'secretId')) : null,
            p === 'tencent' ? field('SecretKey', txt(s, 'secretKey', '', 'password')) : null,
            p === 'tencent' ? field('SdkAppId', txt(s, 'sdkAppId')) : null,
            p === 'zhongyu' ? field('API 地址', txt(s, 'endpoint', 'https://api.zhongyu.com')) : null,
            p === 'zhongyu' ? field('API Key', txt(s, 'apiKey', '', 'password')) : null,
            field('短信签名', txt(s, 'signName', 'EQS')),
            field('模板 ID', txt(s, 'templateCode')),
            h('button', { class: 'btn', onClick: testSms }, '发送测试短信')
          ])
        }
        case 'wechat': {
          const w = ensure('wechat')
          return h('div', {}, [
            sw(w, 'enabled', '启用微信公众号能力'),
            field('AppID', txt(w, 'appId')),
            field('AppSecret', txt(w, 'appSecret', '', 'password')),
            field('模板消息 ID', txt(w, 'templateId')),
            field('通知接收人 OpenID', txt(w, 'notifyOpenid')),
            h('div', { class: 'hint' }, '问卷可开启「仅限微信内填写」与「记录微信昵称头像」，需先配置公众号。')
          ])
        }
        case 'oauth': {
          const o = ensure('oauth')
          if (!o.google) o.google = {}
          if (!o.wechatMp) o.wechatMp = {}
          return h('div', {}, [
            h('h3', { style: 'font-size:14px;margin-bottom:10px' }, 'Google 登录'),
            field('Client ID', txt(o.google, 'clientId')),
            field('Client Secret', txt(o.google, 'clientSecret', '', 'password')),
            h('h3', { style: 'font-size:14px;margin:18px 0 10px' }, '微信开放平台 / 公众号'),
            field('AppID', txt(o.wechatMp, 'appId')),
            field('AppSecret', txt(o.wechatMp, 'appSecret', '', 'password')),
            h('div', { class: 'hint' }, '回调地址：{站点地址}/api/oauth/google/callback、/api/oauth/wechat/callback')
          ])
        }
        case 'map': {
          const m = ensure('map')
          return h('div', {}, [
            sw(m, 'enabled', '启用地位置题型'),
            field('高德地图 Key', txt(m, 'amapKey')),
            field('安全密钥', txt(m, 'amapSecurity', '', 'password'))
          ])
        }
        case 'ai': {
          const a = ensure('ai')
          return h('div', {}, [
            sw(a, 'enabled', '启用 AI 能力'),
            field('接口地址（OpenAI Compatible）', txt(a, 'baseUrl', 'https://api.openai.com/v1'), '支持 SiliconFlow、DeepSeek、Qwen、Llama 等兼容接口'),
            field('API Key', txt(a, 'apiKey', '', 'password')),
            field('模型名称', txt(a, 'model', 'gpt-4o-mini')),
            field('温度（0-2）', txt(a, 'temperature', '0.7', 'number'))
          ])
        }
        case 'webhook': {
          return h('div', {}, [
            h('div', { class: 'flex between mb' }, [
              h('div', { class: 'hint' }, '可订阅事件：新增(create)、修改(update)、删除(delete)。请求头带 X-EQS-Signature 供校验。'),
              h('button', { class: 'btn sm primary', onClick: () => hookEditing.value = { name: '', url: '', events: ['create'], secret: '', enabled: 1 } }, '+ 新增')
            ]),
            hooks.value.length ? h('table', { class: 'table' }, [
              h('thead', {}, h('tr', {}, ['名称', '地址', '事件', '状态', '操作'].map(t => h('th', {}, t)))),
              h('tbody', {}, hooks.value.map(hk => h('tr', {}, [
                h('td', {}, hk.name),
                h('td', { class: 'mono truncate', style: 'max-width:240px' }, hk.url),
                h('td', {}, hk.events.join(', ')),
                h('td', {}, h('span', { class: ['tag', hk.enabled ? 'ok' : 'danger'] }, hk.enabled ? '启用' : '停用')),
                h('td', {}, h('div', { class: 'flex', style: 'gap:4px' }, [
                  h('button', { class: 'btn ghost sm', onClick: () => hookEditing.value = { ...hk } }, '编辑'),
                  h('button', { class: 'btn ghost sm', onClick: () => testHook(hk) }, '测试'),
                  h('button', { class: 'btn ghost sm danger', onClick: async () => { await api.del(`/api/webhooks/${hk.id}`); load() } }, '删除')
                ]))
              ])))
            ]) : h(Empty, { text: '还没有配置 WebHook' })
          ])
        }
        case 'apikey': {
          return h('div', {}, [
            h('div', { class: 'flex between mb' }, [
              h('div', { class: 'hint' }, '用于外部系统调用接口，请求头携带 X-API-Key。'),
              h('button', { class: 'btn sm primary', onClick: addKey }, '+ 创建密钥')
            ]),
            keys.value.length ? h('table', { class: 'table' }, [
              h('thead', {}, h('tr', {}, ['名称', '状态', '创建时间', '操作'].map(t => h('th', {}, t)))),
              h('tbody', {}, keys.value.map(k => h('tr', {}, [
                h('td', {}, k.name),
                h('td', {}, h('span', { class: ['tag', k.enabled ? 'ok' : 'danger'] }, k.enabled ? '有效' : '停用')),
                h('td', { class: 'small muted' }, fmtDate(k.created_at)),
                h('td', {}, h('button', { class: 'btn ghost sm danger', onClick: async () => { await api.del(`/api/api-keys/${k.id}`); load() } }, '删除'))
              ])))
            ]) : h(Empty, { text: '暂无密钥' })
          ])
        }
        case 'i18n': {
          const i18 = ensure('i18n')
          return h('div', {}, [
            field('站点默认语言', h('select', {
              class: 'select', style: 'max-width:220px', value: i18.defaultLang || 'zh',
              onChange: e => { i18.defaultLang = e.target.value; saveDefaultLang() }
            }), '新访客看到的界面语言；用户自己切过之后以他的选择为准'),
            h('div', { class: 'flex mb', style: 'margin-top:16px' }, [
              h('div', { class: 'small muted', style: 'flex:1;align-self:center' }, '下面是选中语言的词条，改完点保存即刻生效'),
              h('select', { class: 'select', style: 'max-width:160px', value: lang.value, onChange: async e => { lang.value = e.target.value; await loadI18n() } },
                [h('option', { value: 'zh' }, '简体中文'), h('option', { value: 'en' }, 'English')]),
              h('button', { class: 'btn', onClick: saveI18n }, '保存词条')
            ]),
            h('div', { style: 'max-height:420px;overflow:auto' }, Object.entries(i18nData.value).map(([k, v]) => h('div', { class: 'field' }, [
              h('label', { class: 'mono' }, k),
              h('input', { class: 'input', value: v, onInput: e => i18nData.value[k] = e.target.value })
            ])))
          ])
        }
        case 'system': {
          const i = info.value || {}
          return h('div', {}, [
            h('div', { class: 'grid c2 mb' }, [
              h('div', { class: 'card pad' }, [
                h('b', {}, '系统信息'),
                h('div', { class: 'small muted mt' }, [
                  `版本 ${i.version || '-'}`, h('br'),
                  `Node ${i.node || '-'}`, h('br'),
                  `平台 ${i.platform || '-'}`, h('br'),
                  `数据目录 ${i.dataDir || '-'}`, h('br'),
                  `数据库大小 ${fmtSize(i.dbSize)}`
                ])
              ]),
              h('div', { class: 'card pad' }, [
                h('b', {}, '数据统计'),
                h('div', { class: 'small muted mt' }, Object.entries(i.counts || {}).map(([k, v]) => h('div', {}, `${({ forms: '表单', submissions: '答卷', users: '用户', banks: '题库', questions: '题目', files: '文件' })[k] || k}：${v}`)))
              ])
            ]),
            h('div', { class: 'card pad' }, [
              h('b', {}, '备份与迁移'),
              h('p', { class: 'small muted', style: 'margin:6px 0 12px' },
                '导出的压缩包包含数据库（一致快照）与全部上传文件，流式打包，数据再大也不会把服务端内存吃满。导入会校验备份里的数据库，通不过就当场拦下，不会拿坏库顶替；顶替前自动存一份快照，随时能回滚。'),
              h('div', { class: 'flex wrap' }, [
                h('button', { class: 'btn primary', disabled: backingUp.value, onClick: backup }, backingUp.value ? '打包中…' : '导出备份'),
                h('label', { class: 'btn', style: importing.value ? 'opacity:.6;pointer-events:none' : '' }, [
                  importing.value ? '导入中…' : '导入备份',
                  h('input', {
                    type: 'file', accept: '.zip', class: 'hide',
                    onChange: e => { restore(e.target.files?.[0]); e.target.value = '' }
                  })
                ])
              ]),
              h('div', { class: 'small muted', style: 'margin-top:12px' },
                '命令行也可以直接备份：bash scripts/backup.sh（服务运行中同样安全，会先做事一致快照）。'),
              h('div', { style: 'margin-top:18px' }, [
                // 390px 上「可回滚快照」和那行说明挤在一行时标题会被拆成两行，
                // 看着像排版坏了——窄屏就让它自然换行
                h('div', { class: 'flex between', style: 'margin-bottom:8px;flex-wrap:wrap;gap:2px 10px' }, [
                  h('b', { class: 'small', style: 'white-space:nowrap' }, '可回滚快照'),
                  h('span', { class: 'small muted' }, '最多保留最近 5 份（导入 / 回滚前自动创建）')
                ]),
                backups.value.length
                  ? h('div', {}, backups.value.map((s, i) => h('div', {
                      class: 'flex between',
                      style: `gap:10px;padding:9px 0;flex-wrap:wrap;${i ? 'border-top:1px dashed var(--line)' : ''}`
                    }, [
                      h('div', { style: 'min-width:0' }, [
                        h('div', { style: 'font-size:12.5px;word-break:break-all' }, s.name),
                        h('div', { class: 'small muted' },
                          `${fmtSize(s.bytes)} · ${fmtDate(s.createdAt)} · ${({ import: '导入前', rollback: '回滚前', manual: '手动' })[s.kind] || s.kind}`)
                      ]),
                      h('button', {
                        class: 'btn sm', style: 'flex:none', disabled: rollingBack.value,
                        onClick: () => rollback(s.name)
                      }, i === 0 ? '回滚到这份' : '回滚')
                    ])))
                  : h('div', { class: 'small muted' }, '还没有快照。第一次导入备份时会自动创建。')
              ])
            ])
          ])
        }
        default: return null
      }
    }

    const savable = computed(() => !['webhook', 'apikey', 'system', 'i18n'].includes(tab.value))

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [h('h1', {}, '系统设置'), h('div', { class: 'sub' }, '存储、通知、第三方能力与备份迁移')]),
        savable.value ? h('button', { class: 'btn primary', disabled: saving.value, onClick: () => save(tab.value) }, saving.value ? '保存中…' : '保存设置') : null
      ]),
      h('div', { class: 'tabs', style: 'flex-wrap:wrap;margin-bottom:16px' }, TABS.map(([v, l]) => h('button', {
        class: tab.value === v ? 'on' : '', onClick: () => tab.value = v
      }, l))),
      loading.value ? h('div', { class: 'card skeleton', style: 'height:280px' })
        : h('div', { class: 'card pad' }, body()),

      hookEditing.value ? Modal({
        title: hookEditing.value.id ? '编辑 WebHook' : '新增 WebHook', modelValue: true, onClose: () => hookEditing.value = null,
        children: [
          h('div', { class: 'field' }, [h('label', {}, '名称'), h('input', {
            class: 'input', value: hookEditing.value.name, onInput: e => hookEditing.value.name = e.target.value
          })]),
          h('div', { class: 'field' }, [h('label', {}, '回调地址'), h('input', {
            class: 'input', value: hookEditing.value.url, placeholder: 'https://example.com/hook',
            onInput: e => hookEditing.value.url = e.target.value
          })]),
          h('div', { class: 'field' }, [h('label', {}, '订阅事件'), h('div', { class: 'flex' }, ['create', 'update', 'delete'].map(ev => h('label', { class: 'flex small' }, [
            h('input', {
              type: 'checkbox', style: 'accent-color:var(--brand)',
              checked: hookEditing.value.events?.includes(ev),
              onChange: e => {
                const s = new Set(hookEditing.value.events || [])
                e.target.checked ? s.add(ev) : s.delete(ev)
                hookEditing.value.events = [...s]
              }
            }),
            h('span', {}, { create: '新增', update: '修改', delete: '删除' }[ev])
          ])))]),
          h('div', { class: 'field' }, [h('label', {}, '签名密钥（可选）'), h('input', {
            class: 'input', value: hookEditing.value.secret || '', onInput: e => hookEditing.value.secret = e.target.value
          })])
        ],
        footer: [h('button', { class: 'btn', onClick: () => hookEditing.value = null }, '取消'), h('button', { class: 'btn primary', onClick: saveHook }, '保存')]
      }) : null
    ])
  }
}
