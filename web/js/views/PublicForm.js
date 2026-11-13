import { h, ref, onMounted, computed } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { route } from '../router.js'
import { ok, err } from '../ui.js'
import { FormRenderer } from '../renderer.js'
import { defaultData } from '../fields.js'

export default {
  setup() {
    const id = Number(route.value.path.split('/')[2])
    const form = ref(null)
    const model = ref({})
    const loading = ref(true)
    const submitting = ref(false)
    const done = ref(false)
    const result = ref(null)
    const error = ref('')
    const password = ref('')
    const wx = ref(null)
    const startAt = Date.now()

    const load = async () => {
      try {
        const r = await api.get(`/api/public/forms/${id}`)
        form.value = r.data
        model.value = defaultData(r.data.schema)
        document.title = r.data.title + ' · EQS'
        const w = route.value.query.wx
        if (w) { try { wx.value = JSON.parse(atob(w.replace(/-/g, '+').replace(/_/g, '/'))) } catch {} }
        if (r.data.settings?.headerImage) document.title = r.data.title
      } catch (e) {
        error.value = e.message
      } finally { loading.value = false }
    }
    onMounted(load)

    const settings = computed(() => form.value?.settings || {})

    const submit = async () => {
      if (submitting.value) return
      if (result.value) return
      submitting.value = true
      try {
        const r = await api.post(`/api/public/forms/${id}/submit`, {
          data: model.value,
          password: password.value,
          duration: Math.round((Date.now() - startAt) / 1000),
          openid: wx.value?.openid || '',
          wxNickname: wx.value?.nickname || '',
          wxAvatar: wx.value?.avatar || ''
        })
        result.value = r
        done.value = true
        ok(r.message || '提交成功')
        if (r.redirect) setTimeout(() => location.href = r.redirect, 1200)
        window.scrollTo({ top: 0, behavior: 'smooth' })
      } catch (e) {
        err(e.message)
      } finally { submitting.value = false }
    }

    const uploadFile = async (file, field) => {
      if (field.props?.maxSize && file.size > field.props.maxSize * 1024 * 1024) {
        err(`文件超过 ${field.props.maxSize}MB`); return null
      }
      try {
        const r = await api.upload(file, { formId: id })
        return r
      } catch (e) { err(e.message); return null }
    }

    const wechatLogin = async () => {
      try {
        const r = await api.get(`/api/wechat/oauth/url?redirect=${encodeURIComponent('/f/' + id)}`)
        location.href = r.url
      } catch (e) { err(e.message) }
    }

    return () => {
      if (loading.value) return h('div', { class: 'center', style: 'padding:100px;color:var(--text-3)' }, '加载中…')
      if (error.value) return h('div', { class: 'center', style: 'padding:90px 20px' }, [
        h('img', { src: '/assets/eqs-mark.svg', style: 'width:64px;opacity:.8' }),
        h('h2', { style: 'margin:16px 0 8px' }, '无法打开此表单'),
        h('p', { class: 'muted' }, error.value)
      ])

      const s = settings.value
      const style = [s.bgColor ? `background:${s.bgColor}` : '', s.bgImage ? `background-image:url(${s.bgImage});background-size:cover;background-attachment:fixed` : ''].join(';')

      return h('div', { class: 'fill-page', style }, [
        h('div', {
          class: 'fill-hero',
          style: [s.headerImage ? `background-image:linear-gradient(rgba(0,0,0,.35),rgba(0,0,0,.35)),url(${s.headerImage})` : '', 'background-size:cover;background-position:center'].join(';')
        }, h('div', {}, [
          h('h1', {}, form.value.title),
          form.value.description ? h('p', { style: 'margin-top:8px;opacity:.92;font-size:14px' }, form.value.description) : null
        ])),
        h('div', { class: 'fill-card' }, done.value
          ? h('div', { class: 'center', style: 'padding:20px 0' }, [
              h('div', { style: 'font-size:52px' }, '🎉'),
              h('h2', { style: 'margin:12px 0 6px' }, result.value?.message || '提交成功'),
              form.value.kind === 'exam' && result.value?.score != null ? h('div', { class: 'tag brand', style: 'font-size:14px;height:30px' }, [
                `得分 ${result.value.score} 分 · ${result.value.passed ? '通过' : '未通过'}`
              ]) : null,
              h('div', { class: 'small muted', style: 'margin-top:10px' }, `答卷编号 #${result.value?.id}，可凭此编号查询`),
              h('button', { class: 'btn mt2', onClick: () => { done.value = false; result.value = null; model.value = defaultData(form.value.schema) } }, '再填一份')
            ])
          : [
              s.needPassword ? h('div', { class: 'field', style: 'margin-bottom:20px' }, [
                h('label', {}, '访问密码'),
                h('input', { class: 'input', type: 'password', value: password.value, onInput: e => password.value = e.target.value, placeholder: '请输入访问密码' })
              ]) : null,
              s.onlyWechat && !wx.value && s.recordWechat ? h('button', { class: 'btn', style: 'margin-bottom:16px', onClick: wechatLogin }, '微信授权，自动填写昵称头像') : null,
              wx.value?.nickname ? h('div', { class: 'flex', style: 'margin-bottom:14px' }, [
                wx.value.avatar ? h('img', { src: wx.value.avatar, style: 'width:28px;height:28px;border-radius:50%' }) : null,
                h('span', { class: 'small muted' }, '以 ' + wx.value.nickname + ' 身份填写')
              ]) : null,
              FormRenderer({
                schema: form.value.schema, model: model.value,
                onUpload: uploadFile
              }),
              h('button', {
                class: 'btn primary', style: `width:100%;margin-top:20px;height:44px;font-size:15px;${s.buttonColor ? `background:${s.buttonColor}` : ''}`,
                disabled: submitting.value, onClick: submit
              }, submitting.value ? '提交中…' : (s.buttonText || '提交')),
              h('div', { class: 'fill-foot' }, [
                h('div', {}, '由 '),
                h('a', { href: '/', style: 'color:var(--text-3)' }, 'EQS · 开源问卷平台')
              ])
            ])
      ])
    }
  }
}
