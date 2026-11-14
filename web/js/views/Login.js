import { h, ref } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { state, applyTheme } from '../store.js'
import { navigate } from '../router.js'
import { toast, err } from '../ui.js'

export default {
  setup() {
    const mode = ref('login')
    const form = ref({ username: '', password: '', nickname: '', email: '' })
    const loading = ref(false)

    const submit = async () => {
      if (loading.value) return
      loading.value = true
      try {
        if (mode.value === 'login') {
          await api.post('/api/auth/login', { username: form.value.username, password: form.value.password })
        } else {
          if (form.value.password.length < 6) throw new Error('密码至少 6 位')
          await api.post('/api/auth/register', form.value)
        }
        const me = await api.get('/api/auth/me')
        state.user = me.user
        toast('欢迎回来，' + (me.user.nickname || me.user.username), 'ok')
        // 从「仅限登录用户填写」的表单过来时回原页：登录完绕到工作台再找回来，
        // 那份问卷多半已经找不到了
        const next = new URLSearchParams(location.search).get('next')
        navigate(next && next.startsWith('/') ? next : '/')
      } catch (e) {
        err(e.message)
      } finally {
        loading.value = false
      }
    }

    const oauth = async (kind) => {
      try {
        const r = await api.get(`/api/oauth/${kind}/url`)
        location.href = r.url
      } catch (e) { err(e.message) }
    }

    const input = (key, label, type = 'text', placeholder = '') => h('div', { class: 'field' }, [
      h('label', {}, label),
      h('input', {
        class: 'input', type, placeholder,
        value: form.value[key],
        onInput: e => form.value[key] = e.target.value,
        onKeydown: e => { if (e.key === 'Enter') submit() }
      })
    ])

    return () => h('div', { class: 'auth-wrap' }, [
      h('div', { class: 'auth-art' }, [
        h('div', { class: 'flex', style: 'gap:12px;margin-bottom:34px' }, [
          h('img', { src: '/assets/eqs-logo.svg', style: 'width:46px;height:46px;border-radius:13px;background:rgba(255,255,255,.18);padding:5px' }),
          h('div', {}, [h('b', { style: 'font-size:20px;letter-spacing:.5px' }, 'EQS'), h('div', { style: 'font-size:12px;opacity:.85' }, '开放式问卷平台')])
        ]),
        h('h2', {}, '问卷、考试、刷题，一套系统全搞定'),
        h('p', {}, '拖拽生成表单，AI 一句话成卷，实时统计报表，数据完全掌握在自己手里。'),
        h('div', { class: 'auth-feats' }, [
          ['⚡', '零依赖部署'], ['🔒', '数据私有'], ['🎨', '27+ 组件'], ['🤖', 'AI 生成']
        ].map(([i, t]) => h('div', { class: 'auth-feat' }, [
          h('i', {}, i), h('span', {}, t)
        ])))
      ]),
      h('div', { class: 'auth-form' }, h('div', { class: 'auth-box' }, [
        h('div', { class: 'logo' }, [
          h('img', { src: '/assets/eqs-mark.svg' }),
          h('b', { style: 'font-size:19px' }, state.site.name || 'EQS')
        ]),
        h('h1', {}, mode.value === 'login' ? '登录你的工作台' : '创建新账号'),
        h('p', { class: 'sub' }, mode.value === 'login'
          ? (state.site.allowRegister ? '使用管理员分配的账号，或自行注册体验。' : '请使用管理员分配的账号登录。')
          : '注册后即可创建问卷与考试。'),
        input('username', '账号', 'text', '请输入账号'),
        input('password', '密码', 'password', '请输入密码'),
        mode.value === 'register' ? input('nickname', '昵称', 'text', '显示名称（可选）') : null,
        mode.value === 'register' ? input('email', '邮箱', 'email', '用于找回密码（可选）') : null,
        h('button', {
          class: 'btn primary', style: 'width:100%;margin-top:8px',
          disabled: loading.value, onClick: submit
        }, loading.value ? '处理中…' : (mode.value === 'login' ? '登录' : '注册并登录')),
        h('div', { class: 'flex between', style: 'margin-top:14px' }, [
          // 自助注册默认关闭：站点没开这个门时，别摆一个点下去必定 403 的链接
          state.site.allowRegister || mode.value === 'register'
            ? h('a', { href: 'javascript:;', class: 'small', onClick: () => mode.value = mode.value === 'login' ? 'register' : 'login' },
                mode.value === 'login' ? '没有账号？注册一个' : '已有账号？去登录')
            : h('span', { class: 'small muted' }, '账号由管理员开通'),
          h('a', { href: '/', class: 'small muted', 'data-link': true }, '先去逛逛 →')
        ]),
        h('div', { class: 'mt2', style: 'border-top:1px solid var(--line);padding-top:14px' }, [
          h('div', { class: 'small muted center mb' }, '第三方登录'),
          h('div', { class: 'flex', style: 'gap:8px' }, [
            h('button', { class: 'btn', style: 'flex:1', onClick: () => oauth('google') }, 'Google'),
            h('button', { class: 'btn', style: 'flex:1', onClick: () => oauth('wechat') }, '微信')
          ])
        ]),
        h('p', { class: 'small muted center', style: 'margin-top:16px' }, '首次部署请用安装时设置的管理员账号登录，并立即修改密码')
      ]))
    ])
  }
}
