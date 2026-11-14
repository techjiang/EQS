import { get, all } from './db.js'
import { pendingLeft } from './forms.js'

/**
 * 考试成绩排名。
 *
 * README 与工作台卡片上写着「自动评分、成绩统计与排名」，前 18 轮把前两件做完了，
 * 「排名」一直没有接口也没有页面——成绩只能靠导出的 Excel 自己排。
 *
 * 两条约束决定了实现方式：
 *  1. 93 万份答卷不能都读进内存再排。排序交给 SQL，靠 (form_id, score) 索引走一遍就行。
 *  2. 同分必须同名次。所以名次不是「第几行」，而是「比多少人高」，下一名要跳号（1,2,2,4）。
 */
const BASE = `FROM submissions s LEFT JOIN users u ON u.id = s.user_id
  WHERE s.form_id = ? AND s.deleted_at IS NULL AND s.score IS NOT NULL`

/** 名次口径：同分同名次，下一个分数从「前面的人数 + 1」开始 */
// 并列规则写在这里而不是 SQL 的 RANK() 里：窗口函数要先把全表排完才能给第一行，
// 而我们只要前 N 名，内存和 CPU 都该跟 N 有关、跟答卷总量无关。

/**
 * 榜单前 N 名。只读 N 行，与答卷总量无关。
 *
 * 每行带 pending（还有几道主观题没批）：及格线是按「可判分总分」算的，
 * 主观题没批完的卷子可判分总分更低、及格线也低，于是榜单上会出现
 * 「50 分通过、48 分未通过」这种看着矛盾的相邻两行。不是判错了，是两份卷子的及格线不同。
 * 把「待批阅」标出来，读者就不用猜了。
 */
export function rankingTop(formId, limit = 20, form = null) {
  const n = Math.min(100, Math.max(1, Number(limit) || 20))
  const rows = all(
    `SELECT s.id, s.public_id, s.score, s.passed, s.created_at, s.user_id, s.wx_nickname, s.manual_scores, s.data,
            u.nickname, u.username
     ${BASE} ORDER BY s.score DESC, s.created_at ASC, s.id ASC LIMIT ?`,
    Number(formId), n
  )
  let rank = 0
  let prev = null
  return rows.map((row, i) => {
    const sc = Number(row.score)
    // 第 i 行是「名次 i+1」，但它跟上一个同分时名次不变——同分同名次
    if (prev === null || sc !== prev) { rank = i + 1; prev = sc }
    return {
      id: row.id,
      publicId: row.public_id || String(row.id),
      score: row.score,
      passed: row.passed === 1,
      createdAt: row.created_at,
      name: row.wx_nickname || row.nickname || (row.user_id ? row.username : '') || '',
      // 只对 N 行算，不扫全表；没有 form 对象时（调用方没传）就不查这一项
      pending: form ? pendingLeft(form, { data: row.data, manual_scores: row.manual_scores }) : 0,
      rank
    }
  })
}

/** 某一行的名次：比我高的人数 + 1。并列时同名次，所以数「比我高」而不是数「排我前面」 */
export function rankOf(formId, submissionId) {
  const row = get('SELECT id, score, created_at FROM submissions WHERE id = ? AND form_id = ? AND deleted_at IS NULL', Number(submissionId), Number(formId))
  if (!row || row.score === null || row.score === undefined) return null
  /*
   * 名次 = 「比我分高的人数 + 1」。不能按「排在我前面的人数」算：
   * 排行榜里同一分数是并列的（1,1,3,3,3），而按行数算会得出 1,2,3,4,5——
   * 于是同一个考生在榜单上是第 1 名、在查询页上却是第 2 名。
   * 同分之间用提交时间排先后只影响列表顺序，不影响名次。
   */
  const better = get(`SELECT COUNT(*) c ${BASE} AND s.score > ?`, Number(formId), row.score).c
  const total = get(`SELECT COUNT(*) c ${BASE}`, Number(formId)).c
  return {
    rank: better + 1,
    total,
    score: row.score,
    // 「超过了百分之多少的考生」：第 1 名 100%，最后一名不是 0 而是 100/total
    percentile: total ? Math.round(((total - better) / total) * 1000) / 10 : 0
  }
}

/**
 * 给公开页用的名字。
 * 排行榜是匿名入口：微信昵称、账号昵称原样贴出去，等于把「谁考了几分」公开挂在网上。
 * 只留首字，其余打码；没有昵称的一律「匿名考生」。
 */
export function maskName(name) {
  const s = String(name || '').trim()
  if (!s) return '匿名考生'
  if (/^[\d\s]+$/.test(s)) return '匿名考生'
  return s.slice(0, 1) + '*'.repeat(Math.min(3, Math.max(1, s.length - 1)))
}

/** 公开榜单：只有名次、打码后的名字和分数 */
export function publicRanking(form, limit = 10) {
  return rankingTop(form.id, limit, form).map(r => ({
    rank: r.rank,
    name: maskName(r.name),
    score: r.score,
    passed: r.passed,
    pending: r.pending,
    publicId: r.publicId
  }))
}

/**
 * 分数分布：按 10 档统计人数。
 * 排名本身不告诉你「90 分算不算好」——一个全员 95 分的考试，第 20 名也很强。
 * 分档用 SQL 一次算完，和榜单一样不把答卷读进内存。
 *
 * 档位按卷面可判分总分切，切不出来（满分未知或全 0）就退回「按最高分切」。
 */
export function distributionOf(form, total) {
  if (!total) return { buckets: [], full: 0 }
  const maxScore = get('SELECT MAX(score) m FROM submissions WHERE form_id = ? AND deleted_at IS NULL AND score IS NOT NULL', Number(form.id))?.m
  const full = Math.max(1, Number(maxScore) || 1) * 1
  const step = full / 10
  const buckets = []
  for (let i = 0; i < 10; i++) {
    const from = Math.round(step * i * 100) / 100
    const to = i === 9 ? Infinity : Math.round(step * (i + 1) * 100) / 100
    const c = get(
      `SELECT COUNT(*) c FROM submissions WHERE form_id = ? AND deleted_at IS NULL AND score IS NOT NULL
        AND score >= ? AND score < ?`,
      Number(form.id), from, to
    ).c
    buckets.push({ from, to: i === 9 ? full : to, count: c })
  }
  return { buckets, full }
}
