import { h, ref, onMounted, computed } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { state } from '../store.js'
import { ok, err, confirmBox, fmtDate, Empty } from '../ui.js'

/**
 * 登录设备。
 *
 * 之前会话是「HMAC 签名的 Cookie」，签发时服务端什么都不存 ——
 * 于是手机丢了、在网吧登过、电脑借人用过，唯一的解法是「改密码」，
 * 而改密码会把所有设备一起踢掉，包括自己正用的这台。
 */
export default {
  setup() {
    const rows = ref([])
    const loading = ref(true)
    const busy = ref(false)

    const load = async () => {
      loading.value = true
      try {
        const r = await api.get('/api/auth/sessions')
        rows.value = r.data || []
      } catch (e) { err(e.message) } finally { loading.value = false }
    }
    onMounted(load)

    const others = computed(() => rows.value.filter(r => !r.current).length)

    const kick = async (s) => {
      const tip = s.current
        ? '退出当前这台设备？需要重新登录。'
        : `让「${s.device}（${s.ip}）」下线？对方需要重新登录。`
      if (!await confirmBox(tip)) return
      busy.value = true
      try {
        const r = await api.del(`/api/auth/sessions/${s.id}`)
        if (r.self) { state.user = null; location.href = '/login'; return }
        ok('已下线')
        load()
      } catch (e) { err(e.message) } finally { busy.value = false }
    }

    const kickOthers = async () => {
      if (!await confirmBox(`退出其它 ${others.value} 台设备？当前这台保持登录。`)) return
      busy.value = true
      try { await api.post('/api/auth/sessions/revoke-others'); ok('其它设备已全部下线'); load() } catch (e) { err(e.message) } finally { busy.value = false }
    }

    /** 「3 分钟前」比「2026-11-14 11:20」更能回答「这台还是我在用吗」 */
    const ago = (s) => {
      if (!s) return '-'
      const diff = Date.now() - new Date(s).getTime()
      if (diff < 60e3) return '刚刚'
      if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`
      if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`
      if (diff < 30 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`
      return fmtDate(s)
    }
    const left = (s) => {
      const days = Math.max(0, Math.ceil((new Date(s).getTime() - Date.now()) / 86400e3))
      return days ? `${days} 天后过期` : '即将过期'
    }

    return () => h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('div', {}, [
          h('h1', {}, '登录设备'),
          h('div', { class: 'sub' }, '当前账号在哪些设备上登录着，可以单独踢掉其中一台')
        ]),
        h('div', { class: 'flex' }, [
          h('button', { class: 'btn', disabled: busy.value || loading.value, onClick: load }, '刷新'),
          h('button', {
            class: 'btn primary', disabled: busy.value || !others.value, onClick: kickOthers
          }, others.value ? `退出其它设备（${others.value}）` : '没有其它设备')
        ])
      ]),

      h('div', { class: 'card', style: 'overflow:hidden' }, loading.value
        ? h('div', { style: 'padding:30px' }, '加载中…')
        : !rows.value.length ? Empty({ text: '没有活跃的登录会话' })
        : h('div', { style: 'overflow-x:auto' }, h('table', { class: 'table sessions-table' }, [
            h('thead', {}, h('tr', {}, [
              h('th', {}, '设备'),
              h('th', { class: 'col-ip' }, 'IP'),
              h('th', { class: 'col-time' }, '登录时间'),
              h('th', {}, '最近活跃'),
              h('th', { class: 'col-status' }, '状态'),
              h('th', {}, '操作')
            ])),
            h('tbody', {}, rows.value.map(s => h('tr', {}, [
              h('td', {}, h('div', { class: 'flex' }, [
                h('div', {
                  style: 'width:26px;height:26px;border-radius:8px;background:var(--panel-2);display:flex;align-items:center;justify-content:center;font-size:13px'
                }, /iPhone|iPad|iPod|Android/i.test(s.device) ? "📱" : "💻"),
                h('div', {}, [
                  h('div', { style: 'font-weight:540' }, s.device),
                  // 窄屏把 IP 收到设备名下面：单独一列放不下，信息和「是不是我的设备」没关系
                  h('div', { class: 'small muted' }, [s.current ? '这台设备 · ' : '', s.ip || '-']),
                  // 窄屏没有「状态」列：过期时间挪到设备名下面，免得读者以为这些会话永不过期
                  h('div', { class: 'small muted show-sm' }, s.current ? '当前登录' : left(s.expiresAt))
                ])
              ])),
              h('td', { class: 'mono small col-ip' }, s.ip || '-'),
              // 窄屏上「登录时间」最不重要：先让掉这一列，操作按钮才不至于被挤出屏幕
              h('td', { class: 'small muted nowrap col-time' }, fmtDate(s.createdAt)),
              h('td', { class: 'small nowrap' }, ago(s.lastSeenAt)),
              h('td', { class: ['nowrap', 'col-status'] }, h('span', { class: ['tag', s.current ? 'ok' : 'brand'] }, s.current ? '当前登录' : left(s.expiresAt))),
              h('td', {}, h('button', {
                class: ['btn', 'sm', s.current ? '' : 'danger'], disabled: busy.value,
                onClick: () => kick(s)
              }, s.current ? '退出登录' : '下线'))
            ])))
          ]))),

      h('div', { class: 'card pad', style: 'margin-top:14px' }, [
        h('b', { class: 'small' }, '说明'),
        h('div', { class: 'small muted', style: 'margin-top:6px;line-height:1.7' }, [
          '会话记录在服务端，下线即刻生效——不用改密码，也不影响这台设备。', h('br'),
          '改密码、被管理员重置密码或停用账号时，该账号的全部会话会一并作废。'
        ])
      ])
    ])
  }
}
