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

/**
 * 回放批阅留痕：每一格（答卷 × 题目）最后是谁给了几分。
 *
 * 尺度对账和分数区间是同一份回放的两个出口：一个回头看「两个人差多远」，
 * 一个往前算「换成另一个人批，这份卷子会是几分」。写成两遍必然分叉——
 * 一处把撤分当 0 分、另一处不当，整张成绩单就会自相矛盾。
 */
function replayCells(entries = []) {
  const who = (e) => (Number(e.userId) > 0 ? `u${e.userId}` : `n${e.username || '?'}`)
  // (答卷, 题目) → { id, label, by: Map(老师 → { name, value, at }), current }
  const cells = new Map()
  const teachers = new Map()
  entries.forEach((e, i) => {
    const key = who(e)
    if (!teachers.has(key)) teachers.set(key, { name: e.username || '未知账号', gradings: 0 })
    for (const c of e.changes || []) {
      const ck = `${e.submissionId}::${c.id}`
      if (!cells.has(ck)) cells.set(ck, { submissionId: Number(e.submissionId), id: c.id, label: c.label || c.id, by: new Map(), seq: -1, current: null })
      const cell = cells.get(ck)
      const value = c.to === undefined ? null : c.to
      // 后写的覆盖先写的：留痕按时间排，「这名老师最后给了几分」才是他现在的口径
      cell.by.set(key, { name: teachers.get(key).name, value, at: e.createdAt || '' })
      /*
       * 每格另外记一份「最后一次写入」。不能靠 by 的顺序取：
       * 同一位老师改第二遍时 Map 里那一项还在原位，顺序是第一次出现的顺序——
       * 拿它当时间序，会把「先批的人的分」当成现在的分。
       */
      if (i >= cell.seq) { cell.seq = i; cell.current = { name: teachers.get(key).name, value }; cell.currentKey = key; cell.lastAt = e.createdAt || '' }
    }
    if ((e.changes || []).length) teachers.get(key).gradings++
  })
  return { cells, teachers }
}

/**
 * 两两对账：这一格里，谁比谁松、松多少。
 *
 * 抽出来是因为它现在有两个出口：一次性的「谁偏松」（calibrate）和
 * 「谁的尺子随时间往哪走」（reviewDrift）。抄两遍必然分叉——
 * 一处把撤分算进去、一处不算，两段结论就会互相打脸。
 */
function addPairs(pairs, teachers, given) {
  for (let i = 0; i < given.length; i++) {
    for (let j = i + 1; j < given.length; j++) {
      const [ka, a] = given[i]
      const [kb, b] = given[j]
      const [k1, k2] = ka < kb ? [ka, kb] : [kb, ka]
      const [v1, v2] = ka < kb ? [Number(a.value), Number(b.value)] : [Number(b.value), Number(a.value)]
      const pk = `${k1}::${k2}`
      const p = pairs.get(pk) || { a: teachers.get(k1).name, b: teachers.get(k2).name, count: 0, sum: 0, maxGap: 0 }
      p.count++
      p.sum += v1 - v2        // 正数 = 前者给得更高
      p.maxGap = Math.max(p.maxGap, Math.abs(v1 - v2))
      pairs.set(pk, p)
    }
  }
}

/**
 * 时间分桶的粒度：先按天，太散了按周，再散按月。
 *
 * 不直接给「按天」是因为一场考试可能跨两个月：九十多个日桶画出来是一条毛刺，
 * 而读者要的是「前松后紧」这种走向，不是每一天的抖动。
 */
function bucketPlan(times) {
  const stamps = times.map(t => new Date(t).getTime()).filter(t => Number.isFinite(t))
  if (!stamps.length) return 'day'
  // 用的是跨度而不是「有几个不同的日子」：一场 40 天的考试如果只有 8 天有人批卷，
  // 按天数算是日桶（8 个），而折线上那 8 个点之间隔着 32 天没人批——那是空白，不是连续
  const days = Math.max(1, Math.round((Math.max(...stamps) - Math.min(...stamps)) / 86400_000))
  if (days <= 8) return 'day'
  if (Math.ceil(days / 7) <= 8) return 'week'
  return 'month'
}

const pad = n => String(n).padStart(2, '0')
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 某个时刻落在哪个桶里；周桶从周一切，中文环境里周一才是「这周开始」 */
function bucketKey(unit, at) {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  if (unit === 'month') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
  if (unit === 'week') {
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    // getDay() 里周日是 0：往前退到周一
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
    return dayKey(monday)
  }
  return dayKey(d)
}

/** 桶的显示名：日/周桶写「11-12」，月桶写「2026-11」 */
function bucketLabel(unit, key) {
  if (!key) return '未知时间'
  if (unit === 'month') return key
  const [, m, d] = key.split('-')
  return `${Number(m)}-${Number(d)}`
}

const round1 = v => Math.round(Number(v) * 10) / 10
// 人工分本身支持两位小数（applyReview 会四舍五入到两位），所以两者相减必然带浮点尾巴：
// 5.299999999999999 分不是「差 5.3 分」，它只是一个还没被收拾干净的 double
const round100 = v => Math.round(Number(v) * 100) / 100

/** 偏移量的写法：正数是「比别人给得高」，带符号才看得出方向 */
export function biasText(v) {
  const n = round1(v)
  if (!Number.isFinite(n)) return '—'
  return `${n > 0 ? '+' : ''}${n}`
}

/**
 * 尺子的时间维度：同一批格子上，某位老师的给分随时间往哪走。
 *
 * 区间做的是「他批的这批卷子，换个人批会在什么范围」。但一位老师批前 20 份时偏松、
 * 被教研组长谈过之后后 40 份收紧——这件事在区间里看不出来：它是历史上所有批阅摞在一起的总和，
 * 开头那 20 份和后来那 40 份被平均成一个数，于是「谈过之后确实收了」永远无法被证实或证伪。
 *
 * **绝对分不进这条线。** 「张老师前 20 份平均 15 分、后 40 份平均 12 分」什么也说明不了——
 * 后面那 40 位考生可能就是答得更差。所以每个点都是「同一格上，这位老师与同格其他人的
 * 平均分之差」：只有被两位以上老师批过的格子才产生数据点，考生水平在减法里被抵消掉。
 * 代价是样本量受限于「被两位老师批过的格子」，这一点在界面上写明，不假装样本充足。
 *
 * 其余几条口径：
 *  - **撤分不参与**（与 crossInfo 同一条判据）：撤分是「这个人对这格没有分数」，不是 0 分。
 *  - **每位老师用自己的时间**：一格里他最后一次写入的时刻，而不是整条留痕的时间。
 *  - **样本太少的桶不下结论**：一个桶里只有 1 格就说「他收紧了」，那只是运气。
 *    门槛定在 2 格——再往上（比如 3）会把「一场 20 份的小考试」整个判成样本不足，
 *    而那正是最需要被提醒的场合。
 *  - **只有一天数据就不谈走向**：一天之内的「前松后紧」可能只是批卷顺序的差别。
 *
 * 还有一条只能承认的：同一格里所有人的偏移加起来是 0（每个人的偏移都相对同格其他人的均值），
 * 所以**两个人的走向互为镜像**——张老师收紧 4.5 分，同格那位就是放松 4.5 分。
 * 这不是两个发现，是一件事的两个方向。这样说比假装有两条独立证据要老实。
 */
export function reviewDrift(entries = [], { minSamples = 2 } = {}) {
  const { cells } = replayCells(entries)
  const marks = []
  for (const cell of cells.values()) {
    // 与 crossInfo 同一条判据：撤分（null）不是 0 分，不参与偏移
    const given = [...cell.by.entries()].filter(([, v]) => v.value !== null && v.value !== undefined)
    if (given.length < 2) continue
    for (const [key, v] of given) {
      const others = given.filter(([k2]) => k2 !== key).map(([, x]) => Number(x.value))
      if (!others.length) continue
      const base = others.reduce((a, b) => a + b, 0) / others.length
      marks.push({
        at: v.at || cell.lastAt || '',
        key,
        name: v.name || '未知账号',
        questionId: cell.id,
        // 正数 = 这一格他比同格其他人给得高
        diff: Number(v.value) - base
      })
    }
  }
  const plan = bucketPlan(marks.map(m => m.at))
  const groups = new Map()
  for (const m of marks) {
    const k = bucketKey(plan, m.at)
    if (!k) continue
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(m)
  }
  const keys = [...groups.keys()].sort()
  const buckets = keys.map((key, i) => {
    const list = groups.get(key)
    const byTeacher = new Map()
    for (const m of list) {
      const t = byTeacher.get(m.key) || { key: m.key, name: m.name, sum: 0, n: 0 }
      t.sum += m.diff
      t.n++
      byTeacher.set(m.key, t)
    }
    return {
      key,
      label: bucketLabel(plan, key),
      index: i,
      // 一桶里有几格被比对过：样本量摆在旁边，读者才知道这条线有几分重量
      samples: list.length,
      teachers: [...byTeacher.values()]
        .map(t => ({ key: t.key, name: t.name, bias: round1(t.sum / t.n), n: t.n }))
        .sort((a, b) => b.n - a.n)
    }
  })

  // 每位老师：整体偏移、首末两段（只取样本够的桶）、走向
  const teachers = new Map()
  for (const m of marks) {
    const t = teachers.get(m.key) || { key: m.key, name: m.name, sum: 0, n: 0 }
    t.sum += m.diff
    t.n++
    teachers.set(m.key, t)
  }
  const out = [...teachers.values()].map(t => {
    const mine = buckets.map(b => ({ label: b.label, entry: b.teachers.find(x => x.key === t.key) }))
      .filter(x => x.entry && x.entry.n >= minSamples)
    const first = mine[0] || null
    const last = mine.length > 1 ? mine[mine.length - 1] : null
    const delta = first && last ? round1(last.entry.bias - first.entry.bias) : 0
    return {
      key: t.key,
      name: t.name || '未知账号',
      bias: round1(t.sum / t.n),
      samples: t.n,
      first: first ? { label: first.label, bias: first.entry.bias, n: first.entry.n } : null,
      last: last ? { label: last.label, bias: last.entry.bias, n: last.entry.n } : null,
      delta,
      verdict: driftVerdict(delta, first, last)
    }
  }).sort((a, b) => b.samples - a.samples)

  return {
    unit: plan,
    buckets,
    teachers: out,
    samples: marks.length,
    note: marks.length
      ? ''
      // 这句话要说的是「怎么才会有」，而不是把上面那句「还没有分歧」再抄一遍
      : '等同一道题被两位老师都改过分，这里会出现每个人随时间的走向——只看某个人的绝对分涨跌说明不了尺子松紧，那可能只是考生答得不同'
  }
}

/**
 * 走向的结论。两条门槛：
 *  - 至少要两个样本够的桶，否则「谈过之后收紧了」只是一句话，不是事实；
 *  - 变化不到 1 分就说「没动」：0.6 分的起伏在阅卷里就是运气，把它说成「收紧」会让人白开会。
 */
function driftVerdict(delta, first, last) {
  if (!first) return '样本不足'
  if (!last) return '只有一个时间段可比'
  if (Math.abs(delta) < 1) return '没动'
  return delta < 0 ? '收紧' : '放松'
}

/** 走向的一句话：从 +4.6 走到 +0.9（收紧 3.7 分） */
export function driftText(t) {
  if (!t?.first || !t?.last) return ''
  const arrow = `${biasText(t.first.bias)} → ${biasText(t.last.bias)}`
  if (t.verdict === '没动') return `${arrow}（基本没动）`
  return `${arrow}（${t.verdict} ${Math.abs(round1(t.delta))} 分）`
}

/**
 * 我自己的尺子：同格对比下，我比同格其他人高几分。
 *
 * 尺度对账回答「谁偏松」，第三人称，摆在一张谁都看得见的页面上。但批到第 6 页的那个人
 * 站在电脑前，需要的是一人称的一句话——「我这把尺子比同题其他人高 6 分」。这不是体贴：
 * 一个人连着批 40 份，他这把尺子的偏移会摊在每一份卷子上，而成绩单上看不见。
 * 知道自己在戴什么颜色的眼镜，才可能在给分的那一刻把手收回来。
 *
 * 口径与 `reviewDrift` 完全一致（同一个 `replayCells`，逐格减去同格其他人的均值），
 * 所以「我的走向」与「我的整体偏移」不会互相打脸。四条边界：
 *  - **撤分不算分**：那是我对这格没有分数，不是 0 分。
 *  - **一定要有别人在同一格给过分**：绝对分不进这个数——我批的这批考生可能就是答得更好。
 *  - **样本太少不下结论**：3 处以下只说「还没对上过几格」。一两格就判一个人偏松，
 *    那是一句会跟着他很久的话，而它可能只是运气。
 *  - **结案不改写历史**：定过案的格子照旧算进来，「当初有人给过 4 分」是事实。
 */
export function selfBias(entries = [], { userId = 0, minSamples = 3 } = {}) {
  const me = Number(userId) > 0 ? `u${Number(userId)}` : ''
  const empty = { samples: 0, bias: 0, confident: false, perQuestion: {}, text: '' }
  if (!me) return empty
  const { cells } = replayCells(entries)
  let sum = 0
  let samples = 0
  const per = new Map()
  for (const cell of cells.values()) {
    // 与 crossInfo / reviewDrift 同一条判据：撤分不是 0 分
    const given = [...cell.by.entries()].filter(([, v]) => v.value !== null && v.value !== undefined)
    const mine = given.find(([k]) => k === me)
    if (!mine) continue
    const others = given.filter(([k]) => k !== me).map(([, v]) => Number(v.value))
    if (!others.length) continue
    // 正数 = 这一格我比同格其他人给得高。考生水平在减法里被抵消掉
    const diff = Number(mine[1].value) - others.reduce((a, b) => a + b, 0) / others.length
    sum += diff
    samples++
    const q = per.get(cell.id) || { sum: 0, samples: 0 }
    q.sum += diff
    q.samples++
    per.set(cell.id, q)
  }
  const bias = samples ? round1(sum / samples) : 0
  const perQuestion = {}
  for (const [id, q] of per) {
    const v = { bias: round1(q.sum / q.samples), samples: q.samples }
    perQuestion[id] = { ...v, text: questionBiasText(v) }
  }
  return {
    samples,
    bias,
    // 够不够格下结论：界面上靠它决定是写「你的尺子 +6 分」还是「样本太少」
    confident: samples >= minSamples,
    perQuestion,
    text: selfBiasText(bias, samples, minSamples)
  }
}

/**
 * 一人称的那句话。措辞刻意避开「偏差」「不准确」这类词：
 * 说的是「你比别人给得高」，是一把尺子的形状，不是一次失误。
 */
/**
 * 单题的口径提示：够不够格摆到那一题上。
 *
 * 「整场偏高 2 分」是背景，「这题我平均高 6 分」才是能拦住一个数字的话。
 * 但门槛不能松到 1 处：只跟别人对上过一次就贴一条「这题你偏高」，那是噪声，
 * 而这类提示一旦被贴成噪声，人就会连真的那条一起无视。所以至少 2 处、至少 1 分。
 */
export function selfQuestion(perQuestion = {}, qid = '') {
  const q = perQuestion?.[qid]
  if (!q || Number(q.samples) < 2) return null
  if (Math.abs(Number(q.bias) || 0) < 1) return null
  return { bias: q.bias, samples: q.samples, text: q.text }
}

export function selfBiasText(bias, samples, minSamples = 3) {
  const n = Math.max(Number(samples) || 0, 0)
  if (!n) return '还没人和你批过同一道题，这把尺子暂时没得比——同一个格子被两个人给过分，才看得出松紧'
  if (n < minSamples) return `只和别人的分对过 ${n} 处，样本太少，先不判你偏松还是偏紧`
  const b = round1(bias)
  if (Math.abs(b) < 1) return `你和同题其他人给得差不多（${n} 处对比，${biasText(b)} 分）`
  return `你比同题其他人平均${b > 0 ? '高' : '低'} ${Math.abs(b)} 分（${n} 处对比）`
}

/** 单题口径的那句话：题目自己带处数，读的人才知道这句话有几分重量 */
export function questionBiasText(p) {
  const n = Math.max(Number(p?.samples) || 0, 0)
  if (!n) return ''
  const b = round1(p.bias)
  if (Math.abs(b) < 1) return `这题你和别人给得差不多（${n} 处对比）`
  return `这题你平均比同题其他人${b > 0 ? '高' : '低'} ${Math.abs(b)} 分（${n} 处对比）`
}

/**
 * 评分尺度：同一份卷子的同一道题，被两位老师分别给过分，差了多少。
 *
 * 留痕能追到「谁批的、改了什么」，但两个人对同一题给出 4 分和 18 分时，
 * 系统只是把两条并排摆着，不会提醒任何人。真实的教研组做法是「同一道题先各自批 10 份，
 * 对一遍尺子再开工」，而这件事此前只能靠人喊。
 *
 * 口径上有一条必须守住：**只有「同一份卷子的同一道题被两个人给过不同的分」才算证据**。
 * 「这道题张老师平均给 12、李老师平均给 15」不算——他们批的可能是不同学生的答案，
 * 考生水平本来就有差。把这两件事混成一个「分歧指数」，换来的只是一个没人敢信的排行榜。
 *
 * 还有一条只能承认、不能糊过去：**给分一致的两个人是不留痕的**。
 * 「分数没动就不留痕」是上一轮刻意定下的（打开看一眼就关掉不该长出空记录），
 * 于是第二个老师如果给了同样的分，库里什么都没有。所以这里的分母是看不见的，
 * 能报的只有「真被后一位老师改过的地方」——不编一个「共对过 N 处」糊在上面。
 *
 * 回放按时间顺序走留痕：每位老师在每一格上的**最后一次**给分为准。
 * 撤分（to === null）表示「这个人对这格没有分数」，不是 0 分——
 * 把撤分当 0 算，一次误操作就会让整张尺子歪掉。
 */
export function calibrate(entries, { maxOf = () => 0, verdicts = [] } = {}) {
  const { cells, teachers } = replayCells(entries)
  const idx = verdictIndex(verdicts)

  const questions = new Map()
  const pairs = new Map()
  /*
   * 只报 conflicts，不报「共对过几处」。
   * 「对过」的分母在库里根本不存在：分数没动就不留痕（打开看一眼就关掉不该长出空记录），
   * 所以第二个老师给了同样的分时什么都没记下。一个必然偏小的分母摆上去，
   * 只会让人得出「我们分歧率 90%」这种结论。能数的只有「真被后一位老师改过的地方」。
   */
  let conflicts = 0
  let stale = 0
  const resolved = []
  for (const cell of cells.values()) {
    const given = [...cell.by.entries()].filter(([, v]) => v.value !== null && v.value !== undefined)
    if (given.length < 2) continue
    const values = given.map(([, v]) => Number(v.value))
    const raw = Math.max(...values) - Math.min(...values)
    if (raw === 0) continue
    // 两位小数就够：差 5.3 分是个能读的数字，差 5.299999999999999 分是一行噪声
    const gap = round100(raw)
    const max = Number(maxOf(cell.id)) || 0
    /*
     * 两两对账跟结案无关：「这题按 18 分定了」不会让「当初有人给了 4 分」这件事消失，
     * 它仍然是那位老师尺子偏松的证据。结案收的是「这条分歧还要不要继续摆着」，
     * 不是改写历史。所以尺子统计照旧算全部有分歧的格子。
     */
    addPairs(pairs, teachers, given)
    const state = verdictState(cell, idx.get(`${cell.submissionId}::${cell.id}`) || null)
    const entry = {
      // id/label 必须一起带出去：界面上「按 14 分定了」这个动作要指名是哪一道题，
      // 少了它就是拿 undefined 去请求一个不存在的题目
      id: cell.id, label: cell.label,
      submissionId: cell.submissionId, gap, ratio: max > 0 ? gap / max : 0,
      by: given.map(([, v]) => ({ name: v.name, value: Number(v.value) })),
      ...state
    }
    // 已经拍过板、而且成绩单认这个结论：不再算「悬着的分歧」
    if (state.settled) { resolved.push({ ...entry, max }); continue }
    // 定过案但成绩单对不上（被改成别的分、被撤分）：它重新回到待处理，并单独报数
    if (state.stale) stale++
    conflicts++
    const q = questions.get(cell.id) || { id: cell.id, label: cell.label, max, cells: [] }
    q.max = q.max || max
    q.cells.push(entry)
    questions.set(cell.id, q)
  }

  const list = [...questions.values()]
    .map(q => ({
      ...q,
      // 同题里最扎眼的那一处排前面：一眼要看到「4 分 vs 18 分」，不是平均后才 7 分
      worst: q.cells.reduce((a, b) => (b.gap > (a?.gap ?? -1) ? b : a), null),
      cells: q.cells.sort((a, b) => b.gap - a.gap)
    }))
    .sort((a, b) => (b.worst?.gap || 0) - (a.worst?.gap || 0))

  /*
   * 这些分歧在成绩单上长什么样。
   *
   * 「18 处分歧」是个抽象数字，读者得自己换算成「所以呢」。这里直接算：
   * 有几份卷子的总分因此带上了区间、最大浮动多少分——
   * 浮动额就是各格 (最高分 − 最低分) 相加，与当前记着几分无关，
   * 所以这里不需要读答卷，光靠留痕就对得上成绩单上那个区间。
   */
  let banded = 0
  let maxSpread = 0
  const spreadOf = new Map()
  for (const cell of cells.values()) {
    const c = crossInfo(cell, idx.get(`${cell.submissionId}::${cell.id}`) || null)
    if (!c) continue
    // 与 scoreBand 同一条判据：已经有结论的分歧不再撑开区间
    if (c.settled) continue
    // 这题现在没有分（还没批 / 被撤分），总分里本来就不含它，不该算进浮动——
    // 与 scoreBand 同一条判据，否则这里报「3 份卷子带区间」、成绩单上却是 2 份
    if (cell.current?.value === null || cell.current?.value === undefined) continue
    spreadOf.set(cell.submissionId, (spreadOf.get(cell.submissionId) || 0) + (c.max - c.min))
  }
  for (const v of spreadOf.values()) {
    banded++
    maxSpread = Math.max(maxSpread, v)
  }

  return {
    conflicts,
    // 已经拍过板、而且成绩单认这个结论的分歧。它们从「悬着」里消失，但不是被删掉——
    // 界面要能说清「原来 8 处，定了 6 处，还剩 2 处」。
    // 名字带 Cells 是为了跟 regrade.settled（那是「换他的尺子等于现状」的人）分开
    settledCells: resolved.length,
    // 定过案、但成绩单上的分已经跟结论对不上：这处分歧重新需要人拍一次
    stale,
    resolved: resolved.sort((a, b) => b.gap - a.gap),
    questions: list,
    pairs: [...pairs.values()]
      .map(p => ({ ...p, avgGap: p.count ? Math.round((Math.abs(p.sum) / p.count) * 100) / 100 : 0, bias: p.count ? Math.round((p.sum / p.count) * 100) / 100 : 0 }))
      .sort((a, b) => b.count - a.count || b.maxGap - a.maxGap),
    teachers: [...teachers.values()].sort((a, b) => b.gradings - a.gradings),
    bands: { submissions: banded, maxSpread: Math.round(maxSpread * 100) / 100 }
  }
}

/**
 * 一处分歧有多值得管。
 *
 * 满分 20 的题差 1 分不值得开会，差 10 分才值得。所以门槛按比例算，不按绝对分算——
 * 否则满分 5 分的题差 2 分和满分 50 分的题差 2 分会被判成同一件事。
 */
export function gapLevel(gap, max) {
  const m = Number(max) || 0
  if (!m || !(Number(gap) > 0)) return ''
  const r = Number(gap) / m
  if (r >= 0.3) return '明显'
  if (r >= 0.15) return '值得看一眼'
  return '轻微'
}

/**
 * 结案记录归一：一格最多一条有效结论。
 *
 * 传进来的顺序就是写入顺序（SQL 按 id 升序），后写的覆盖先写的——
 * 「先定 18 分、后来改口按 12 算」这件事，读者要的是最后一次的口径。
 *
 * `value` 为 null 的那一行表示「撤回结案」：分歧重新变成待处理。
 * 撤回本身也是一次改口，所以行不删，只是让索引里那格消失。
 */
function verdictIndex(verdicts = []) {
  const out = new Map()   // `${submissionId}::${questionId}` → { value, name, at, note, id }
  for (const v of verdicts || []) {
    const key = `${Number(v.submissionId)}::${v.questionId}`
    if (v.value === null || v.value === undefined || v.value === '') { out.delete(key); continue }
    out.set(key, {
      value: Number(v.value),
      name: v.username || '未知账号',
      at: v.createdAt || '',
      note: v.note || '',
      id: v.id ?? 0
    })
  }
  return out
}

/**
 * 一格的结案状态：这处分歧是不是已经有人拍过板了。
 *
 * **过期的判据是「当前分认不认这个结论」，不是「结论之后有没有人动过手」。**
 * 时间顺序看着更严谨，实际会漏掉最要紧的一种：结案按 18 分算了，第二天有人改成 6 分，
 * 第三天又改回 18 分——按时间序它「被改过」，按当前分它「还是 18」。要问的从来是后者：
 * 这格现在记着的分，还算不算这个结论。
 *
 * 所以 `stale` 只有一句话：**结论和成绩单对不上了。**
 * 这一格被第三个人改成别的分、被撤分、或者某人绕过结案直接改分，都会走到这里。
 */
function verdictState(cell, verdict) {
  // current 一并带出去：界面上说「定过案按 18 分，但现在是 6 分」得能读到那个 6
  const cur = cell.current?.value === undefined ? null : cell.current.value
  if (!verdict) return { verdict: null, settled: false, stale: false, current: cur }
  const stale = cur === null || Number(cur) !== Number(verdict.value)
  return { verdict, settled: !stale, stale, current: cur }
}

/**
 * 哪些格子的尺子不齐：同一份卷子的同一道题，被两位以上老师给过不同的分。
 *
 * 这是「分数带区间」和「阅卷时提醒别人给过几分」共用的那一份判据。
 * 写两遍就会分叉：一处把撤分当 0 分、一处不当，界面上的提醒和成绩单上的区间对不上，
 * 而读者只会得出一个结论——这些数字都是猜的。
 *
 * `only: 'open'`（默认）只给还没结案的：成绩单上的区间要的是「还悬着的分歧」，
 * 已经有人拍过板的格子不该再撑开一个永远收不住的范围。
 * 阅卷队列与会话提醒用 `only: 'all'`——「这题有人拍过板、按几分算」本身
 * 就是下一个批阅人需要的信息。
 */
export function crossedOf(entries, { verdicts = [], only = 'open' } = {}) {
  const out = new Map()   // submissionId → [ { id, label, min, max, by, verdict, settled, stale } ]
  const idx = verdictIndex(verdicts)
  for (const cell of replayCells(entries).cells.values()) {
    const c = crossInfo(cell, idx.get(`${cell.submissionId}::${cell.id}`) || null)
    if (!c) continue
    if (only === 'open' && c.settled) continue
    if (!out.has(cell.submissionId)) out.set(cell.submissionId, [])
    out.get(cell.submissionId).push(c)
  }
  return out
}

/** 这一格的尺子齐不齐。不齐就给出两端、每个人各自的分，以及这处分歧的结案状态 */
function crossInfo(cell, verdict = null) {
  // 撤分（to: null）是「这个人对这格没有分数」，不是 0 分：
  // 一次误操作就能让成绩单上的区间凭空宽出一整题的分
  const by = [...cell.by.values()].filter(v => v.value !== null && v.value !== undefined)
    .map(v => ({ name: v.name, value: Number(v.value) }))
  if (by.length < 2) return null
  const values = by.map(v => v.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  // 两个人都给 8 分不是「尺子不齐」：这题换谁批都一样，不该在成绩单上留一个区间
  if (min === max) return null
  return { id: cell.id, label: cell.label, min, max, by, ...verdictState(cell, verdict) }
}

/**
 * 一处分歧结案后的那句话：这一格按 18 分算，李老师定的。
 *
 * 过期的时候要说得更清楚：**结论还在，但成绩单已经不听它的了。**
 * 「已定案」和「定过、但现在对不上」是两件事，混成一句会让人以为这处分歧已经处理完，
 * 而实际上它正卡在「有人拍过板、后来又有人改了分」的中间状态——那恰恰是最该看一眼的。
 */
export function verdictText(v) {
  if (!v?.verdict) return ''
  const n = Math.round(Number(v.verdict.value) * 100) / 100
  const who = v.verdict.name || '未知账号'
  if (v.stale) {
    const cur = v.current
    const now = cur === null || cur === undefined ? '已经没有分' : `现在是 ${Math.round(Number(cur) * 100) / 100} 分`
    return `定过案（按 ${n} 分，${who} 定），但${now}——这处分歧又回到了待处理`
  }
  return `按 ${n} 分算，${who} 定`
}

/**
 * 成绩单上的尺子：把「同一道题两个人差多远」折成这份卷子的分数区间。
 *
 * 尺度对账能看出李老师偏松，但成绩单上只有一个孤零零的 71 分：
 * 没人知道这个 71 是严格尺子给的还是宽松尺子给的。同一道题张老师给 5 分、
 * 李老师给 17 分，那这份卷子的总分本来就该是「71 分，上下浮动一个区间」，
 * 而不是一个精确到小数点后两位的数字。
 *
 * 区间的意思要说清楚：**它不是「这个分数有误差」，而是「换另一个人批会是几分」**。
 * 所以只对「同一份卷子同一道题、被两位以上老师给过不同的分」的格子做折算，
 * 其余格子照旧按现在的分算——没被第二个人批过的题，谁也不知道换个人会怎么给，
 * 把它的分也算成一个区间就是在编数字。
 *
 * 还没批（或被撤分）的格子不参与：总分里本来就没有它的分，
 * 拿区间去「预测」一个不存在的分，只会算出比满分还高的区间。
 */
export function scoreBand(entries, { maxOf = () => 0, score = null, manual = {}, verdicts = [] } = {}) {
  const base = Number(score)
  if (!Number.isFinite(base)) return null
  const items = []
  let low = base
  let high = base
  const round = v => Math.round(v * 100) / 100
  // 只算还没结案的分歧：已经有人拍过板的格子，成绩单不该再带着一个收不住的范围
  for (const cell of [...crossedOf(entries, { verdicts }).values()].flat()) {
    const raw = manual?.[cell.id]
    // 这题现在没有分（还没批 / 被撤分）：总分里本来就不含它，不该算进区间
    if (raw === undefined || raw === null || raw === '') continue
    const cur = Number(raw)
    if (!Number.isFinite(cur)) continue
    // 位移是相对「这题现在记着的分」算的：区间要套在真实成绩上，而不是另算一个总分
    const floor = Math.min(cell.min, cur)
    const ceil = Math.max(cell.max, cur)
    low += floor - cur
    high += ceil - cur
    items.push({
      id: cell.id, label: cell.label, max: Number(maxOf(cell.id)) || 0,
      cur, low: floor, high: ceil, by: cell.by
    })
  }
  if (!items.length) return null
  return {
    score: round(base),
    // 下界不能是负分：一道题浮动 -18 分就能把总分压到 0 以下，而负分不是成绩
    low: round(Math.max(low, 0)),
    high: round(high),
    spread: round(high - Math.max(low, 0)),
    // 浮动最大的那题排前面：一眼要看到是哪道题把区间撑开的
    items: items.sort((a, b) => (b.high - b.low) - (a.high - a.low))
  }
}

/** 分数区间的一句话：71 分（68 ~ 75）；没有区间时只说分数 */
export function bandText(band) {
  if (!band) return ''
  const n = v => String(Math.round(Number(v) * 100) / 100)
  if (!(band.spread > 0)) return `${n(band.score)} 分`
  return `${n(band.score)} 分（${n(band.low)} ~ ${n(band.high)}）`
}

/**
 * 换一把尺子重批全场：如果这份卷子交给某位老师批，谁会被推出及格线。
 *
 * 区间只回答「这一份的分数会怎么变」，尺度对账只回答「谁偏松几分」，
 * 时间走向只回答「他后来收没收」。这三件拼起来还差一句：
 * **按李老师那把松尺子重批全场，及格的人会多出几个，是多在哪几个人身上。**
 *
 * 这件事只能分两段说，混在一起就变成了编数字：
 *
 *  1. **事实替换**：他真批过的那几格，把他给的分换回去。这不是预测，是把已经发生过的另一种结果
 *     按回原位——同一个人对同一份答案给的分，本来就该只有一个。
 *  2. **外推**：他没批过的格子，拿他在这道题上的口径偏移（同格对比算出来的分差）平移过去。
 *     这一段是投影，界面上单独标出格数。没被任何人批过的主观题不做外推：
 *     那题现在没有分，替他凭空给一个分，等于用编出来的数字把人推过及格线。
 *
 * 还有一条前提：**只算已经批完的卷子。** 还有主观题没给分的卷子，总分本身还会涨，
 * 拿它算「会不会翻过及格线」算的是一个还没定下来的分数。这类卷子跳过并单独报数，
 * 不假装它们也参与了。
 *
 * 两条边界：
 *  - **及格线本身不动。** 它是「可判分总分 × passPercent」，换尺子不改变题目的分值，
 *    所以线在原地——动的是人。这句话要摆在界面上：读者以为要问的是线，其实要问的是人。
 *  - **只算主观题。** 客观题是机器判的，跟谁的尺子都没关系。
 *  - **负数与超满分一律剪回 [0, 满分]**：一位老师整体偏松 6 分，平移到一道已经给了满分的题上
 *    会得到 26/20，而超纲的分数不是成绩。
 */
/**
 * 名次表：分数降序，同分同名次（与榜单 ranking.js 同一口径——名次 = 比我高的人数 + 1）。
 *
 * 不用 O(n²) 的两两比较：一场几千份答卷乘以每位老师就是上亿次比较，而这只是排序后
 * 顺着走一遍的事。同分用「第一次出现的下标 + 1」，于是并列的下一位要跳号（1,1,3）。
 */
function ranksBy(list) {
  const sorted = [...list].sort((a, b) => b.score - a.score)
  const ranks = new Map()
  // prev 存的是「上一个分数」本身，不是上一行：拿行对象去比会一路比成 undefined，
  // 于是每行都拿到自己的下标当名次，并列的人被拆成 1、2、3
  let rank = 0
  let prev = null
  sorted.forEach((s, i) => {
    if (prev === null || s.score !== prev) { rank = i + 1; prev = s.score }
    ranks.set(s.id, rank)
  })
  return ranks
}

/**
 * 换一把尺子重批之后，**名次会不会变**。
 *
 * 上一轮已经能回答「谁会被推出及格线」。但及格线是行政上的线，教研组真正吵的常常是另一件事：
 * 按李老师那把尺子重批，第一名还是不是原来那个人。这句话以前答不出来——
 * 分数位移了 12 分，读者自己没法在心里把几十份卷子重排一遍。
 *
 * 三件事必须分开说：
 *  - **第 1 名换人**，和**前 10 名进出**，不是同一件事。榜首换人才是「这场分歧改变了结论」；
 *    前 10 里挪两位，多数时候没人会去申诉。
 *  - **同一个人的名次没动，不等于这场分歧不存在**：分数变了但顺序没变，说明分歧集中在
 *    同一批卷子上，它只影响分数的绝对值，不影响谁排在谁前面。这句话本身就是结论。
 *  - **并列要照榜单的规矩算**：3 份同分并列第 1，重批后其中一份上浮 2 分成了唯一第一，
 *    这算「第 1 名换人」——原来那三个人都是第一，现在只有他一个。
 *
 * 名次只在**已批完的卷子**里算：还有主观题没给分的卷子，分数本身还会涨，
 * 它的名次是个还没定下来的数。把它硬塞进榜单，会让第 3 名凭空掉到第 4 名。
 */
export function standings(before = [], after = [], { topN = 10 } = {}) {
  // before/after: [{ id, score }]，同一批答卷的两个版本（换尺子前后）
  const rb = ranksBy(before)
  const ra = ranksBy(after)
  const topB = before.filter(s => rb.get(s.id) === 1).map(s => s.id).sort((a, b) => a - b)
  const topA = after.filter(s => ra.get(s.id) === 1).map(s => s.id).sort((a, b) => a - b)
  const topChanged = topB.length !== topA.length || topB.some((id, i) => id !== topA[i])
  const scoreAfter = new Map(after.map(s => [s.id, s.score]))
  const crossedTop = []
  let moved = 0
  let pushed = 0
  let maxMove = 0
  const movers = []
  for (const s of before) {
    const was = rb.get(s.id)
    const is = ra.get(s.id)
    if (was === undefined || is === undefined) continue
    const move = was - is           // 正数 = 名次上升（数字变小）
    // 分数没动、名次却掉了：这不是「他变差了」，是别人浮上去了。这种卷子不进分数变动清单，
    // 但它确实是这场分歧的受害者——一句话要说出来，否则读者只看到名次变了却找不到原因
    const shifted = scoreAfter.get(s.id) !== s.score
    if (move) {
      moved++
      if (!shifted) pushed++
      maxMove = Math.max(maxMove, Math.abs(move))
    }
    // 进出前 N 单独记：第 1 名没换人时，这才是「有没有人因此被挤出去」的答案
    const wasTop = was <= topN
    const isTop = is <= topN
    if (wasTop !== isTop || move) movers.push({ id: s.id, rankBefore: was, rankAfter: is, move, shifted, dir: wasTop === isTop ? '' : (isTop ? 'in' : 'out') })
    if (wasTop !== isTop) crossedTop.push({ id: s.id, dir: isTop ? 'in' : 'out', rankBefore: was, rankAfter: is })
  }
  // 进出前 N 的排最前，然后按位移大小：挪得最多的人是这张表要指出来的人
  movers.sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || Math.abs(b.move) - Math.abs(a.move))
  return {
    ranked: before.length,
    topBefore: topB,
    topAfter: topA,
    topChanged,
    crossedTop: crossedTop.sort((a, b) => Math.abs(b.move) - Math.abs(a.move)),
    moved,
    // 分数没变、被别人的位移挤动名次的份数
    pushed,
    maxMove,
    topN,
    movers
  }
}

/**
 * 名次那句话。
 *
 * 三种「第 1 名变了」要说成三句不同的中文，混成一句「第 1 名换人」会误导人：
 *  - **真的换人**：原来那个人被挤下去了。这才是「这场分歧改变了结论」。
 *  - **有人追平**：原来独占第一的那位还在台上，只是旁边多站了一个。
 *  - **并列被打散**：原本三份并列第一，现在只剩一份——掉下去的那两份并没有变差，
 *    只是别人浮上去了，但榜单上从此有了唯一的第一名。
 */
export function standingText(s) {
  if (!s || !s.ranked) return ''
  const zh = n => `#${n}`
  if (s.topChanged) {
    const gone = s.topBefore.filter(id => !s.topAfter.includes(id))
    const come = s.topAfter.filter(id => !s.topBefore.includes(id))
    if (come.length && gone.length) return `第 1 名换人：${come.map(zh).join('、')} 顶替 ${gone.map(zh).join('、')}`
    if (come.length) return `第 1 名被追平：${come.map(zh).join('、')} 并列进来`
    return `并列被打散：原本 ${s.topBefore.length} 份并列第 1，现在由 ${s.topAfter.map(zh).join('、')} 独走`
  }
  // 句子里不再重复「名次」两个字：界面上那颗标签已经写了，叠起来是「名次名次有 3 份挪了位」
  const pushedNote = s.pushed ? `（其中 ${s.pushed} 份自己的分没变，是被别人的位移挤动的）` : ''
  if (s.crossedTop.length) return `第 1 名不变，但前 ${s.topN} 名有 ${s.crossedTop.length} 人进出，最大移动 ${s.maxMove} 位${pushedNote}`
  // 分数变了、名次没变：这不是「没影响」，而是分歧只动了绝对值、没动谁排在谁前面
  if (s.moved) return `有 ${s.moved} 份挪了位，但前 ${s.topN} 名没人进出${pushedNote}`
  return `一位都没变（${s.ranked} 份里的顺序不受影响）`
}

/**
 * 逐份清单的排法，也是「哪些必须列出来」的规则：
 *
 *  1. **换边的**（及格线）：这是这块最硬的结论，一份都不能省。
 *  2. **牵扯榜首的**：把第 1 名顶下去的那份、被顶下去的那份。
 *     只列「升上去的那个」是不完整的——读者会问「原来第一名呢」。
 *  3. **前 N 进出的**：第 1 名没换人时，这才是「有没有人被挤出去」的答案。
 *  4. 其余按位移大小。
 *
 * 前三类一律留全，剩余名额才按位移补：说了「6 人上岸」却只列 5 条，
 * 读者数一遍会以为结论有假。
 */
function flipsFirst(items, n) {
  const hard = items.filter(it => it.flip || it.topTouched)
  const rest = items.filter(it => !it.flip && !it.topTouched)
  const byMove = (a, b) => Math.abs(b.delta) - Math.abs(a.delta)
  hard.sort(byMove)
  rest.sort(byMove)
  return hard.concat(rest).slice(0, Math.max(n, hard.length))
}

export function regradeRuler(entries = [], rows = [], { maxOf = () => 0, topN = 10 } = {}) {
  // rows: [{ id, score, passed, manual, passLine, total, pending }]，pending 是还没给分的主观题数
  const { cells, teachers } = replayCells(entries)
  // 每位老师每道题的偏移（只从「同格 ≥2 人」的格子里取）：考生水平在减法里抵消掉
  const biasOf = new Map()   // key → Map(qid → { sum, n })
  const quota = new Map()    // key → 他真批过几格
  for (const cell of cells.values()) {
    const given = [...cell.by.entries()].filter(([, v]) => v.value !== null && v.value !== undefined)
    for (const [k, v] of given) quota.set(k, (quota.get(k) || 0) + 1)
    if (given.length < 2) continue
    for (const [k, v] of given) {
      const others = given.filter(([k2]) => k2 !== k).map(([, x]) => Number(x.value))
      const base = others.reduce((a, b) => a + b, 0) / others.length
      if (!biasOf.has(k)) biasOf.set(k, new Map())
      const per = biasOf.get(k)
      const hit = per.get(cell.id) || { sum: 0, n: 0 }
      hit.sum += Number(v.value) - base
      hit.n++
      per.set(cell.id, hit)
    }
  }

  /*
   * 谁是「当前成绩单上的那把尺子」：每一格最后写入的人。
   * 换他的尺子重批等于现状——一分都不会变，于是他会从结果里消失。
   * 这件事得说出来，否则读者会以为漏了一个人，或者以为他的尺子没有偏移。
   */
  const lastWriter = new Map()
  for (const cell of cells.values()) {
    if (cell.currentKey) lastWriter.set(cell.currentKey, (lastWriter.get(cell.currentKey) || 0) + 1)
  }
  const settled = []
  // 未批完的卷子与「谁给的分」无关，所以在这里一次数完，别让每位老师各数一遍
  const unfinished = rows.filter(r => Number(r.pending) > 0 && Number.isFinite(Number(r.score)) && Number.isFinite(Number(r.passLine))).length
  const out = []
  for (const [key, t] of teachers) {
    const per = biasOf.get(key) || new Map()
    const perQ = new Map([...per.entries()].map(([qid, x]) => [qid, x.sum / x.n]))
    let facts = 0
    let projected = 0
    let changed = 0
    let up = 0
    let down = 0
    let flipUp = 0
    let flipDown = 0
    let passBefore = 0
    let maxMove = 0
    const items = []
    // 名次要跟没被动过的卷子一起排：只拿「分数变了的那几份」排序，
    // 第 1 名永远是它们里的第一名，而真实榜单上可能有一份纯客观题的满分卷根本不受影响
    const beforeList = []
    const afterList = []
    for (const row of rows) {
      /*
       * 还没判过分的卷子（score 为 null）不入名次，也不进这笔账。
       * Number(null) 是 0——不显式拦一下，未判分的卷子会以 0 分混进榜单垫底，
       * 名次总数凭空多出几十位。成绩榜本身也是这么筛的（`score IS NOT NULL`）。
       */
      if (row.score === null || row.score === undefined) continue
      const cur = Number(row.score)
      const line = Number(row.passLine)
      if (!Number.isFinite(cur) || !Number.isFinite(line)) continue
      // 还有主观题没给分的卷子，总分还会往上涨：它的「会不会过线」是个还没定下来的数
      if (Number(row.pending) > 0) continue
      // 换尺子不改变题目分值，所以及格线在原地不动——动的是人
      const was = cur >= line
      if (was) passBefore++
      let delta = 0
      for (const [qid, raw] of Object.entries(row.manual || {})) {
        if (raw === undefined || raw === null || raw === '') continue
        const max = Number(maxOf(qid)) || 0
        const now = Number(raw)
        if (!Number.isFinite(now)) continue
        const cell = cells.get(`${row.id}::${qid}`)
        const mine = cell?.by.get(key)?.value
        if (mine !== undefined && mine !== null) {
          // 事实替换：他给过这个分，那就是他的答案，不是一次预测
          delta += Math.min(Math.max(Number(mine), 0), max || Number(mine)) - now
          facts++
          continue
        }
        const b = perQ.get(qid)
        if (b === undefined) continue
        // 外推：平移之后仍要落在 [0, 满分] 里，超纲的分不是成绩
        const next = Math.min(Math.max(now + b, 0), max || now + b)
        delta += next - now
        projected++
      }
      const after = Math.max(Math.min(cur + delta, Number(row.total) || Infinity), 0)
      beforeList.push({ id: row.id, score: round100(cur) })
      afterList.push({ id: row.id, score: round100(after) })
      if (!delta) continue
      const move = round100(after - cur)
      changed++
      if (move > 0) up++
      else down++
      maxMove = Math.max(maxMove, Math.abs(move))
      // 上岸与落榜分两栏数：「3 人上岸、1 人落榜」和「净增 2 人」不是同一件事
      const is = after >= line
      if (is && !was) flipUp++
      if (was && !is) flipDown++
      items.push({ id: row.id, from: round100(cur), to: round100(after), delta: move, flip: is === was ? '' : (is ? 'up' : 'down') })
    }
    /*
     * 名次：及格线是行政上的线，教研组真正吵的常常是「按他的尺子重批，第一名还是不是原来那个」。
     * 分数位移了 12 分，读者自己没法在心里把几十份卷子重排一遍——这里替他们排。
     */
    const st = standings(beforeList, afterList, { topN })
    /*
     * 把「牵扯榜首」的份子挂到逐份清单上。
     * 只列升上去那个、不列被顶下来那个，读者会问「原来第一名呢」——
     * 而那份卷子可能一分没变（他是被别人挤下去的），本来根本进不了这张表。
     */
    for (const it of items) {
      if (!st.topBefore.includes(it.id) && !st.topAfter.includes(it.id)) continue
      const wasTop = st.topBefore.includes(it.id)
      const isTop = st.topAfter.includes(it.id)
      if (wasTop !== isTop) it.topTouched = isTop ? 'up' : 'down'
    }
    /*
     * 名次挪了、分数却一分没变的那几份：delta 是 0，本来压根进不了 items。
     * 可界面上写着「名次有 16 份挪了位」，读者却只看到 7 行，剩下 9 行去哪了？
     * 补一条进来并标 `untouched`（分数没被改），它们不进 `changed` 计数——确实没人动过分。
     */
    /*
     * 「被追平」时，原来那位还在榜首。只列挤进来的人，读者照样会问「原来那个呢」——
     * 所以把仍在榜首的那几份也补一条（hold），让这一组分能自己读成一句话。
     */
    if (st.topChanged) {
      for (const id of st.topBefore.filter(x => st.topAfter.includes(x))) {
        if (items.some(it => it.id === id)) {
          const it = items.find(x => x.id === id)
          it.topTouched = 'hold'
          continue
        }
        const row = rows.find(x => Number(x.id) === Number(id))
        if (!row || row.score === null || row.score === undefined) continue
        items.push({
          id, from: round100(row.score), to: round100(row.score), delta: 0,
          flip: '', untouched: true, topTouched: 'hold'
        })
      }
    }
    for (const m of st.movers) {
      if (items.some(it => it.id === m.id)) continue
      const row = rows.find(x => Number(x.id) === Number(m.id))
      if (!row || row.score === null || row.score === undefined) continue
      const isTop = st.topAfter.includes(m.id)
      const wasTop = st.topBefore.includes(m.id)
      items.push({
        id: m.id, from: round100(row.score), to: round100(row.score), delta: 0,
        flip: '', untouched: true,
        topTouched: wasTop === isTop ? '' : (isTop ? 'up' : 'down')
      })
    }
    out.push({
      key,
      name: t.name || '未知账号',
      bias: round100([...perQ.values()].reduce((a, b) => a + b, 0) / (perQ.size || 1)),
      graded: quota.get(key) || 0,
      facts,
      projected,
      changed,
      up,
      down,
      flipUp,
      flipDown,
      passBefore,
      // 没变的那几份成绩不动，所以过线人数就是「原来的 + 上岸 − 落榜」，不必再数一遍
      passAfter: passBefore + flipUp - flipDown,
      standing: st,
      maxMove: round100(maxMove),
      /*
       * 换边的那几份排最前面，然后才按位移大小。
       * 「有人被推过线」是这张表唯一的结论，把它埋在一堆「分数变了但没换边」的中间，
       * 读者就得自己一行行找哪几个人的名字变了颜色。
       *
       * 也不能截断到固定条数：说「6 人越线上岸」却只列出 5 条，第 6 个人就这么没了，
       * 读者数一遍会以为结论有假。换边的、牵扯榜首的一律留全，剩下的名额才按位移补。
       */
      items: flipsFirst(items, 8)
    })
  }
  for (const t of out) {
    if (t.changed > 0) continue
    /*
     * 重批一分不动有两种原因，话得分开说：
     *  - `current`：每一格最后都是他写的。现在的成绩单就是他的口径，换他的尺子等于现状。
     *  - 否则：他的偏移恰好被题目的上下界剪掉了，或者他批过的地方跟记着的分本来就一样。
     * 混成一句「换他的尺子不会变」，读者没法判断这是「他已经赢了」还是「他的分没起作用」。
     */
    settled.push({
      name: t.name || '未知账号',
      graded: quota.get(t.key) || 0,
      current: (lastWriter.get(t.key) || 0) >= cells.size && cells.size > 0
    })
  }
  /*
   * 排序：先看有没有人因为他换边（及格线），再看有没有把第 1 名换掉，最后才是改了多少份。
   * 「榜首换人」比「前 10 挪两位」重，但它比「8 人越线上岸」轻——及格线是行政后果。
   */
  const kept = out.filter(t => t.changed > 0)
    .sort((a, b) => (b.flipUp + b.flipDown) - (a.flipUp + a.flipDown)
      || (b.standing?.topChanged ? 1 : 0) - (a.standing?.topChanged ? 1 : 0)
      || b.changed - a.changed)
  return {
    teachers: kept,
    // 重批等于现状的人：现在的分就是他落下的，不列出来会让读者以为漏了一个
    settled,
    // 分母要说清：没批完的卷子不参与，「36 份里 8 人上岸」和「36 份里 8 人上岸，另有 5 份还没批完」不是同一句话
    reviewed: rows.length - unfinished,
    topN,
    unfinished,
    note: kept.length
      ? ''
      : '等同一道题被两位老师都改过分，这里会出现「换成某位的尺子，谁会被推出及格线」——只有被比过的地方才能算出偏移，人少的时候这条账算不出来'
  }
}

/** 换尺子的那句结论：按他的尺子重批，3 人越线上岸，1 人掉到线下 */
export function regradeText(t) {
  if (!t) return ''
  const parts = []
  if (t.flipUp) parts.push(`${t.flipUp} 人越线上岸`)
  if (t.flipDown) parts.push(`${t.flipDown} 人掉到线下`)
  if (!parts.length) return t.changed ? `${t.changed} 份分数会变，但没人换边` : '这份卷子的分一个都不会变'
  return parts.join('，')
}

/* ============ 阅卷队列的顺序：先批那些批完会改变结论的 ============ */

/**
 * 这一份卷子批完之后，会不会改变结论。
 *
 * 阅卷队列一直是按交卷时间排的：一个班 40 人，就从第一份扫到最后一份。
 * 可批阅时间是有限的，而队列里大多数卷子批了也不改变任何结论——
 * 离及格线还差 5 分、剩余主观题只有 10 分可给，批完仍然是过不了线；
 * 反过来已经稳稳过线的，批完只会更高。把时间花在这两类卷子上，等于按 id 顺序写作业。
 *
 * 真正值得先批的是「批完就会换一句话」的几种：
 *
 *  1. `drop`  **现在列表上写着及格，批完却可能掉线。** 这一档最该先看。
 *  2. `pass`  现在过不了线，但剩余主观题的分够把它推过去。
 *  3. `top`   现在追不上第 1 名，但剩余的分够追上。
 *  4. `fresh` 一道题都还没判过，及格线本身还没定下来。
 *  5. `scale` 这份卷子某道题已经被两位老师给出过不同的分，下一个批的人会把第三种口径定下来。
 *
 * 为什么会有 `drop`：及格线不是固定的，它按「可判分题目总分」的百分比算。
 * 还有 40 分主观题没批时，分母只是客观题那 60 分，线画在 36；批完分母变成 100，线抬到 60。
 * 于是一个 40 分的考生此刻显示「及格」，把两道主观题各给 5 分之后就是 50 分、线下。
 * **分数只会往上走，线也会往上走，所以「掉线」不是分数被扣，是分数线跑到了他前面。**
 * 这一档如果不说，老师按列表上的「及格」把剩下的卷子扫一遍，扫完发现半数人不及格，
 * 却不知道是哪几份在什么时候翻过去的。
 *
 * 其余几条口径：
 *  - 批分本身只会加分（主观题给分落在 [0, 满分]），所以上界就是 `score + room`。
 *  - 两端各取一次线：现在的线用 `nowTotal`（已判分题目总分）算，批完的线用 `nowTotal + room` 算。
 *    只比一边，`drop` 这一档根本不会出现，`pass` 也会把「给满也够不着」的卷子误判进来。
 */
export function queueUrgency(row = {}, { passLineOf = () => 0, top = null } = {}) {
  const low = Number(row.score) || 0
  const room = Math.max(Number(row.room) || 0, 0)
  const nowTotal = Number(row.nowTotal) || 0
  const crossed = Math.max(Number(row.crossed) || 0, 0)
  // 没有剩余可给的分，它本来也不该在队列里
  if (!(room > 0)) return { tier: '', gap: 0, room: 0, text: '' }
  /*
   * 一道题都还没判过的时候，及格线本身还没定下来：它是按「可判分题目总分」的百分比算的，
   * 分母此刻是 0。拿 0 去和 0 比，会得出「他已经过线了」这种既不真也不假的话。
   * 这一档单独说：还没判过分，批完才知道——它既不该说成「会改结论」，也不该说成「不会改」。
   */
  if (!(nowTotal > 0)) return { tier: 'fresh', gap: 0, room, text: '还没判过分，批完才知道过不过线' }
  const high = low + room
  const passNow = Number(passLineOf(nowTotal)) || 0
  const passFull = Number(passLineOf(nowTotal + room)) || 0
  if (low >= passNow && low < passFull) {
    // 线跑到了他前面：这几题给不满 need 分，他就从「及格」变成「不及格」
    const need = round100(passFull - low)
    return { tier: 'drop', gap: need, room, text: `现在算过线，但这几题给不满 ${need} 分就会掉到线下` }
  }
  if (low < passNow && high >= passFull) {
    const gap = round100(passNow - low)
    return { tier: 'pass', gap, room, text: `还差 ${gap} 分过线，剩 ${room} 分可给` }
  }
  // 榜首只跟「已经批完的答卷」比：还在涨分的卷子当榜首，会变成谁都没批完却已经有个第 1 名
  if (top !== null && top !== undefined && low < Number(top) && high >= Number(top)) {
    const gap = round100(Number(top) - low)
    return { tier: 'top', gap, room, text: `距第 1 名 ${gap} 分，剩 ${room} 分可给` }
  }
  if (crossed > 0) {
    return { tier: 'scale', gap: 0, room, text: `${crossed} 处口径不一致，等下一个批的人定` }
  }
  return { tier: '', gap: 0, room, text: '' }
}

/** 三档优先级的人话说法。文案放在这里，服务端与页面用的是同一句 */
export const URGENCY_LABEL = {
  drop: '批完可能掉线', pass: '批完可能上岸', top: '批完可能换第 1 名',
  fresh: '还没判过分', scale: '尺子还没定'
}

/*
 * 档位权重。
 *
 * `drop` 排最前是有意的：列表上已经写着「及格」，老师扫一眼就会认；批完掉下去之后，
 * 谁也不会回头想「他是什么时候从及格变成不及格的」。这一档不先说不先批，就是等着挨骂。
 * 然后是 `pass`（上岸，行政后果）；榜首其次；再往下是「一点都还没判」与「尺子没定」——
 * 后者不是不着急，而是它已经有人在管了，只差最后一个人定口径。
 */
const TIER_WEIGHT = { drop: 5, pass: 4, top: 3, fresh: 2, scale: 1, '': 0 }

/** 差距占剩余分值的比例：越小越贴边，越该先批。没有档位的排最后 */
function tightness(row) {
  const u = row?.urgency || {}
  const room = Number(u.room) || 0
  if (!u.tier || !(room > 0)) return 1e9
  return (Number(u.gap) || 0) / room
}

/**
 * 排队的顺序。
 *
 * `priority` 下同档位里按「差距 / 剩余可给分」升序：还差 2 分、手里有 20 分的那份，
 * 比还差 19 分、手里只有 20 分的那份更贴边——前者怎么批都大概率换边，后者得给满才勉强。
 * 平手时按 id：顺序必须是确定的，否则翻页会漏人、也会重批同一份。
 */
export function orderQueue(rows = [], { mode = 'priority' } = {}) {
  const list = [...rows]
  if (mode !== 'priority') return list.sort((a, b) => Number(a.id) - Number(b.id))
  return list.sort((a, b) => (TIER_WEIGHT[b?.urgency?.tier || ''] || 0) - (TIER_WEIGHT[a?.urgency?.tier || ''] || 0)
    || tightness(a) - tightness(b)
    || Number(a.id) - Number(b.id))
}

/**
 * 队列的一句话摘要：这一整队里，几份批完会改变结论。
 *
 * 「还剩 45 份」只说工作量，不说这 45 份里哪几份值得现在就批。
 * 一份都不换边时也要说——那正是「这些卷子批了也不改变任何结论」这个结论本身。
 */
export function queueSummary(rows = []) {
  const count = t => rows.filter(r => (r?.urgency?.tier || '') === t).length
  const drop = count('drop')
  const pass = count('pass')
  const top = count('top')
  const scale = count('scale')
  const fresh = count('fresh')
  const parts = []
  if (drop) parts.push(`${drop} 份现在显示及格、批完可能掉线`)
  if (pass) parts.push(`${pass} 份批完可能上岸`)
  if (top) parts.push(`${top} 份可能换第 1 名`)
  if (fresh) parts.push(`${fresh} 份还没判过分`)
  if (scale) parts.push(`${scale} 份的尺子还没定`)
  return {
    drop, pass, top, scale, fresh, total: rows.length,
    // 队列空了不谈优先级：那不是「都不用批」，是没有可批的
    text: !rows.length
      ? ''
      : parts.length
        ? `其中 ${parts.join('，')}`
        : '剩下这些卷子批完都不会改结论，可以慢慢来'
  }
}
