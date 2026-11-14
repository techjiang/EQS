import { h, ref, onMounted, onBeforeUnmount, computed, nextTick } from '/vendor/vue.esm.js'
import { api } from '../api.js'
import { route } from '../router.js'
import { ok, err, fmtDate } from '../ui.js'
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
    const board = ref(null)
    const wx = ref(null)
    let startAt = Date.now()
    const fieldErrors = ref([])
    const remain = ref(0)

    const restartTimer = () => {
      if (timer) { clearInterval(timer); timer = null }
      const minutes = Number(form.value?.settings?.duration) || 0
      if (form.value?.kind !== 'exam' || minutes <= 0) { remain.value = 0; return }
      remain.value = minutes * 60
      timer = setInterval(() => {
        remain.value -= 1
        if (remain.value <= 0) {
          clearInterval(timer)
          timer = null
          if (!result.value) {
            err('答题时间已到，正在自动交卷')
            submit()
          }
        }
      }, 1000)
    }

    const load = async () => {
      try {
        const r = await api.get(`/api/public/forms/${id}`)
        form.value = r.data
        model.value = defaultData(r.data.schema)
        document.title = r.data.title + ' · EQS'
        // 表单开了排行榜才去取；没开时接口会 403，不必每次都问一遍
        if (r.data.settings?.showRanking && r.data.kind === 'exam') {
          board.value = await api.get(`/api/public/forms/${id}/ranking?limit=10`).then(x => x.data).catch(() => null)
        }
        const w = route.value.query.wx
        if (w) { try { wx.value = JSON.parse(atob(w.replace(/-/g, '+').replace(/_/g, '/'))) } catch {} }
        restartTimer()
      } catch (e) {
        error.value = e.message
      } finally { loading.value = false }
    }
    let timer = null
    onMounted(load)
    onBeforeUnmount(() => { if (timer) clearInterval(timer) })

    const clock = computed(() => {
      const t = Math.max(0, remain.value)
      const m = String(Math.floor(t / 60)).padStart(2, '0')
      const s2 = String(t % 60).padStart(2, '0')
      return `${m}:${s2}`
    })

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
        if (form.value?.settings?.showRanking && form.value.kind === 'exam') {
          board.value = await api.get(`/api/public/forms/${id}/ranking?limit=10`).then(x => x.data).catch(() => null)
        }
        fieldErrors.value = []
        done.value = true
        ok(r.message || '提交成功')
        if (r.redirect) setTimeout(() => location.href = r.redirect, 1200)
        window.scrollTo({ top: 0, behavior: 'smooth' })
      } catch (e) {
        const msg = String(e.message || '提交失败')
        const list = msg.split(/[；;]/).map(x => x.trim()).filter(Boolean)
        err(msg)
        fieldErrors.value = list
        // 必须等一帧再找：错误文案刚塞进响应式状态，DOM 还没渲染出 .has-err，
        // 当场 querySelectorAll 拿到空数组，滚动根本不发生；
        // 而错误块插在上方会让浏览器做滚动锚定，用户反而被带到页面最底下。
        await nextTick()
        const target = document.querySelector('.q-block.has-err')
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' })
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

    /* ---------- 答卷编号查询 ---------- */
    const queryOpen = ref(false)
    const queryId = ref('')
    const querying = ref(false)
    const queryResult = ref(null)

    const lookup = async () => {
      if (!queryId.value.trim()) return err('请输入答卷编号')
      querying.value = true
      try {
        const r = await api.get(`/api/public/forms/${id}/query?submissionId=${encodeURIComponent(queryId.value.trim())}`)
        queryResult.value = r.data
      } catch (e) { queryResult.value = null; err(e.message) } finally { querying.value = false }
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
              form.value.kind === 'exam' && result.value?.score != null ? h('div', { class: 'center', style: 'margin:10px 0 4px' }, [
                h('div', { style: 'font-size:34px;font-weight:700;color:' + (result.value.passed ? 'var(--ok)' : 'var(--danger)') }, result.value.graded === false ? '待批阅' : `${result.value.score}`),
                h('div', { class: 'small muted' }, result.value.graded === false
                  ? '本卷暂无可自动判分的题目，成绩需人工批阅'
                  : `满分 ${result.value.total ?? '-'} 分 · 及格线 ${result.value.passLine ?? '-'} 分 · ${result.value.passed ? '通过' : '未通过'}`),
                // 名次与分数一起给：只给分数的话「85 分」在这张卷子里算什么水平是不知道的
                result.value.rank ? h('div', { class: 'small muted', style: 'margin-top:6px' },
                  `第 ${result.value.rank.rank} / ${result.value.rank.total} 名 · 超过 ${result.value.rank.percentile}% 的考生`) : null,
                result.value.ungraded ? h('div', {
                  style: 'margin-top:8px;padding:8px 12px;border-radius:9px;background:rgba(245,158,11,.12);font-size:12.5px;color:var(--warn, #b06b00)'
                }, `还有 ${result.value.ungraded} 道主观题等待人工批阅，批阅后总分与是否通过会更新，可凭答卷编号回来查询`) : null
              ]) : null,
              result.value?.review?.items?.length ? h('div', { style: 'margin-top:16px;text-align:left' }, [
                h('div', { class: 'small muted', style: 'margin-bottom:8px' }, '逐题回顾'),
                ...result.value.review.items.map((it, i) => h('div', {
                  style: `padding:10px 12px;border-radius:10px;margin-bottom:7px;background:${it.judged ? (it.correct ? 'rgba(16,185,129,.08)' : 'rgba(239,68,68,.07)') : 'var(--panel-2)'}`
                }, [
                  h('div', { class: 'flex between', style: 'gap:8px' }, [
                    h('div', { style: 'font-size:13.5px;font-weight:560' }, `${i + 1}. ${it.label}`),
                    h('span', { class: 'small', style: 'flex:none;color:' + (it.judged ? (it.correct ? 'var(--ok)' : 'var(--danger)') : 'var(--text-3)') },
                      // 「未设答案」在阅卷环节是错的：主观题不是没设答案，是等人给分
                      it.judged ? (it.correct ? `✓ +${it.score}` : `✕ 0/${it.score}`) : (it.score > 0 ? '待人工批阅' : '不计分'))
                  ]),
                  it.judged && !it.correct ? h('div', { class: 'small muted', style: 'margin-top:4px' }, `你的作答：${it.given.join('') || '（空）'} · 正确答案：${it.answerText || it.answer.join('、')}`) : null,
                  it.analysis ? h('div', { class: 'small muted', style: 'margin-top:4px' }, '解析：' + it.analysis) : null
                ]))
              ]) : null,
              h('div', { class: 'small muted', style: 'margin-top:10px' }, `答卷编号 ${result.value?.publicId || result.value?.id}，可凭此编号查询`),
              h('button', {
                class: 'btn mt2',
                onClick: () => {
                  done.value = false
                  result.value = null
                  model.value = defaultData(form.value.schema)
                  startAt = Date.now()
                  restartTimer()
                }
              }, '再填一份')
            ])
          : [
              remain.value > 0 && !done.value ? h('div', {
                class: 'flex between',
                style: `margin-bottom:16px;padding:9px 14px;border-radius:10px;font-size:13px;background:${remain.value <= 60 ? 'rgba(239,68,68,.1)' : 'var(--panel-2)'};color:${remain.value <= 60 ? 'var(--danger)' : 'var(--text-2)'}`
              }, [h('span', {}, '考试剩余时间'), h('b', { style: 'font-variant-numeric:tabular-nums' }, clock.value)]) : null,
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
                onUpload: uploadFile, errors: fieldErrors.value
              }),
              h('button', {
                class: 'btn primary', style: `width:100%;margin-top:20px;height:44px;font-size:15px;${s.buttonColor ? `background:${s.buttonColor}` : ''}`,
                disabled: submitting.value, onClick: submit
              }, submitting.value ? '提交中…' : (s.buttonText || '提交')),
              s.allowQuery ? h('div', { style: 'margin-top:16px' }, [
                h('button', {
                  class: 'btn ghost sm', style: 'width:100%',
                  onClick: () => { queryOpen.value = !queryOpen.value; queryResult.value = null }
                }, queryOpen.value ? '收起查询' : '查询我之前提交的答卷'),
                queryOpen.value ? h('div', { style: 'margin-top:10px;padding:14px;border:1px solid var(--line);border-radius:12px' }, [
                  h('div', { class: 'flex', style: 'gap:8px' }, [
                    h('input', {
                      class: 'input', placeholder: '答卷编号，例如 k3m9xz-7qp2', value: queryId.value,
                      onInput: e => queryId.value = e.target.value,
                      onKeydown: e => { if (e.key === 'Enter') lookup() }
                    }),
                    h('button', { class: 'btn', disabled: querying.value, onClick: lookup }, querying.value ? '查询中…' : '查询')
                  ]),
                  queryResult.value ? h('div', { style: 'margin-top:12px;font-size:13px' }, [
                    h('div', { class: 'small muted', style: 'margin-bottom:6px' },
                      `答卷 ${queryResult.value.publicId || queryResult.value.id} · ${fmtDate(queryResult.value.createdAt)}` +
                      (queryResult.value.score != null ? ` · 得分 ${queryResult.value.score}` : '') +
                      (queryResult.value.reviewed ? ' · 已人工批阅' : '')),
                    queryResult.value.review ? h('div', { class: 'small', style: 'margin-bottom:8px;color:' + (queryResult.value.passed ? 'var(--ok)' : 'var(--danger)') },
                      `${queryResult.value.passed ? '通过' : '未通过'} · 可判分总分 ${queryResult.value.review.total} 分 · 及格线 ${queryResult.value.review.passLine} 分` +
                      (queryResult.value.review.ungraded ? ` · 还有 ${queryResult.value.review.ungraded} 题待批阅` : '')) : null,
                    ...form.value.schema
                      .filter(f => queryResult.value.data[f.id] !== undefined && !['divider', 'richtext', 'html', 'image'].includes(f.type))
                      .map(f => {
                        const v = queryResult.value.data[f.id]
                        const text = Array.isArray(v) ? v.join('、')
                          : typeof v === 'object' && v ? Object.values(v).join('、')
                          : String(v == null || v === '' ? '-' : v)
                        return h('div', { style: 'padding:7px 0;border-bottom:1px dashed var(--line)' }, [
                          h('span', { class: 'small muted' }, f.label + '：'),
                          h('span', { style: 'margin-left:4px' }, text)
                        ])
                      })
                  ]) : null
                ]) : null
              ]) : null,
              board.value?.length ? h('div', { style: 'margin-top:20px;padding-top:16px;border-top:1px solid var(--line)' }, [
                h('div', { style: 'font-weight:600;font-size:13.5px;margin-bottom:8px' }, '成绩榜'),
                ...board.value.map(r => h('div', {
                  class: 'flex between',
                  style: 'padding:6px 0;font-size:13px;border-bottom:1px dashed var(--line)'
                }, [
                  h('span', {}, `${r.rank}. ${r.name}`),
                  h('span', { class: 'small', style: 'color:' + (r.passed ? 'var(--ok)' : 'var(--text-3)') }, String(r.score))
                ])),
                h('div', { class: 'small muted', style: 'margin-top:8px' }, '榜单只显示名次、打码后的昵称与分数，不公开答卷内容')
              ]) : null,
              h('div', { class: 'fill-foot' }, [
                h('div', {}, '由 '),
                h('a', { href: '/', style: 'color:var(--text-3)' }, 'EQS · 开源问卷平台')
              ])
            ])
      ])
    }
  }
}
