/**
 * 阅卷的纯逻辑：把「一页草稿」变成「该提交什么」。
 *
 * 放在这里而不是埋在视图里，是因为这几十行牵着两件容易出错的事：
 * ① 哪些题算「这次批了」（空串 = 还没批，0 分 = 批了 0 分）；
 * ② 越界的分数要在提交前拦住——服务端会拒，但一份越界只拒那一份，
 *    老师看到的是一句「已保存 7 份，1 份被拒」，还得回头找是哪一份。
 */

/** 一题的分数是否落在 [0, 满分] 内。空串表示「这题还没批」，不算越界 */
export function scoreError(raw, max) {
  if (raw === '' || raw === undefined || raw === null) return ''
  const n = Number(raw)
  if (!Number.isFinite(n)) return '不是数字'
  if (n < 0) return `不能小于 0`
  if (n > max) return `不能超过满分 ${max}`
  return ''
}

/**
 * 把一页草稿整理成批量保存的请求体。
 * 只交填了分的题：留空 = 还没批，不该因为看了一眼就被判 0 分。
 * 返回 { items, error }，error 里带上第一处越界的位置，好把焦点也挪过去。
 */
export function batchPayload(rows) {
  const items = []
  for (const [ri, row] of (rows || []).entries()) {
    const scores = {}
    const revoked = row.revoke instanceof Set ? row.revoke : new Set()
    for (const [qi, it] of (row.items || []).entries()) {
      // 显式撤分：送 null，服务端会把这道题退回待批（文档里一直有，界面上此前没入口）
      if (revoked.has(it.id)) { scores[it.id] = null; continue }
      const raw = row.draft?.[it.id]
      const message = scoreError(raw, Number(it.score) || 0)
      if (message) return { items, error: { row: ri, item: qi, id: it.id, label: it.label, message } }
      if (raw === '' || raw === undefined || raw === null) continue
      scores[it.id] = Number(raw)
    }
    if (!Object.keys(scores).length) continue
    // 每一份单独算耗时：一页十份里只有三份动过手，按整页时间平摊会把另外七份的耗时写大
    const seconds = elapsedSeconds(row.startedAt, Number(row.finishedAt) || Date.now())
    items.push(seconds ? { id: row.id, scores, note: row.noteDraft, seconds } : { id: row.id, scores, note: row.noteDraft })
  }
  return { items, error: null }
}

/**
 * Enter 键该往哪走：本页所有打分框按 DOM 顺序排成一条队列，
 * 到队尾再按一次就是「该保存了」。返回 -1 表示没有下一个。
 */
export function nextIndex(current, total) {
  if (!Number.isInteger(current) || current < 0) return total ? 0 : -1
  return current + 1 < total ? current + 1 : -1
}

/**
 * 整场考试的批阅进度。
 *
 * 一页存完就清空，批到第 6 页时已经不知道自己在整场里的位置，也不知道还剩几个人的卷子没看。
 * 分母只算「有主观题的卷子」——纯客观题的答卷不进阅卷队列，混进分母的话进度永远到不了头。
 * 份数只做裁剪不做四舍五入：已批 37 / 共 82 显示 45%，因为「还剩 45 份」是给人看的数字，
 * 百分比跟着它算才对得上。
 */
export function reviewProgress(need, done) {
  const total = Math.max(Math.floor(Number(need) || 0), 0)
  const finished = Math.min(Math.max(Math.floor(Number(done) || 0), 0), total)
  const left = total - finished
  return { total, done: finished, left, percent: total ? Math.round((finished / total) * 100) : 0, complete: total > 0 && left === 0 }
}

/**
 * 保存这一页之后该往哪走。
 *
 * 队列会在批完之后前移，所以「继续」永远是同一个 offset（不是 +limit）——
 * 往下翻页会跳过被清掉的位置，一页 10 份批了 3 份，翻页就漏掉 3 份没批的。
 * 队列空了才是真的批完了，这时候别再拉一张空页，直接给收尾。
 */
export function afterSave({ offset, left }) {
  if (Number(left) <= 0) return { action: 'done', offset: Math.max(Number(offset) || 0, 0) }
  return { action: 'continue', offset: Math.max(Number(offset) || 0, 0) }
}

/**
 * 这次批阅到底改了哪几题。
 *
 * 库里的 submissions 只留「最后一次批阅：谁、什么时候」，改一次覆盖一次——
 * 于是「这份卷子两道题的分差得离谱，是谁批的」永远只能得到一个答案：
 * 最后那个人，最后一个时间点。留痕要能回答的是「哪一题被谁从几分改到几分」，
 * 所以按题对齐前后两份人工分，只挑真的动了的那几题。
 *
 * null 表示「这题没有分」（还没批，或被撤分），与 0 分是两件事：
 * 把「撤分」和「改成 0 分」记成同一条，事后就看不出老师到底判了 0 还是没批。
 */
export function scoreChanges(before, after, labelOf = id => id) {
  const out = []
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})])
  for (const id of keys) {
    const from = before?.[id] === undefined ? null : before[id]
    const to = after?.[id] === undefined ? null : after[id]
    if (from === to) continue
    out.push({ id, label: String(labelOf(id) ?? id), from, to })
  }
  return out
}

/** 一条留痕要给人看的那句话：改了几题、怎么改的 */
export function changeText(changes = []) {
  if (!changes.length) return '没有改动'
  const given = changes.filter(c => c.to !== null && c.from === null).length
  const revoked = changes.filter(c => c.to === null).length
  const edited = changes.length - given - revoked
  const parts = []
  if (given) parts.push(`新增 ${given} 题`)
  if (edited) parts.push(`改分 ${edited} 题`)
  if (revoked) parts.push(`撤分 ${revoked} 题`)
  return parts.join(' · ') || `改动 ${changes.length} 题`
}

/** 单题的一句话：主观题一 12 → 18 / 新增 18 分 / 撤掉 18 分 */
export function changeLine(c) {
  const f = v => (v === null || v === undefined ? '' : String(v))
  if (c.from === null || c.from === undefined) return `新增 ${f(c.to)} 分`
  if (c.to === null || c.to === undefined) return `撤掉 ${f(c.from)} 分`
  return `${f(c.from)} → ${f(c.to)} 分`
}

/** 耗时：秒数是人写的，别让人自己换算成「几分几秒」 */
export function humanSeconds(sec) {
  const s = Math.max(Math.round(Number(sec) || 0), 0)
  if (!s) return ''
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return rest ? `${m} 分 ${rest} 秒` : `${m} 分`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`
}

/**
 * 批一份卷子花了多久。
 *
 * 记的是「从第一次下手到保存」这一段时间，不是从弹窗打开算起：
 * 打开一页十份里只有三份是真批过的，按打开时间算，另外七份会平白多出十几分钟。
 * 负数与离谱的值一律给 0——系统时间被调过、标签页在后台睡了一夜，
 * 那种数字记进去只会污染「批阅效率」这件事，而它本来就不是审计字段。
 */
export function elapsedSeconds(from, to, max = 6 * 3600) {
  const a = Number(from), b = Number(to)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  const s = Math.round((b - a) / 1000)
  if (s <= 0 || s > max) return 0
  return s
}
