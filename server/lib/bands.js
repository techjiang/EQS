import { all } from './db.js'
import { manualScoresOf, safeJson } from './forms.js'
import { scoreBand, crossedOf } from '../../web/js/review.js'

/**
 * 成绩单上的尺子：把「同一道题两个人差多远」折成这份卷子的分数区间。
 *
 * 尺度对账能看出李老师偏松，但成绩单上只有孤零零一个 71 分——没人知道这个 71
 * 是严格尺子给的还是宽松尺子给的。同一道题张老师给 5 分、李老师给 17 分，
 * 这份卷子的总分本来就该是「71 分，换个尺子会是 59 ~ 71」，而不是一个精确到小数点后两位的数字。
 *
 * 三条口径：
 *  1. **区间是「换个人批会几分」，不是「这个分有误差」。** 所以只对「同一份卷子同一道题、
 *     被两位以上老师给过不同分」的格子折算，其余格子照旧按现在的分算——没被第二个人批过的题，
 *     谁也不知道换个人会怎么给，把它的分也算成区间就是在编数字。
 *  2. **撤分不参与。** 总分里本来就没有它的分，拿它去预测一个不存在的分会算出比满分还高的区间。
 *  3. **只在管理端出现。** 公开查询页不给考生看区间：一句「你的 71 分可能是 59 分」
 *     在真实学校里只会变成一次申诉，而它本来是用来看「老师们的尺子齐不齐」的。
 */

const cols = rows => rows.map(() => '?').join(',')

/** 留痕按答卷分组：entries 的字段名与 web/js/review.js 的回放口径对齐 */
function groupLogs(rows) {
  const map = new Map()
  for (const r of rows) {
    const key = Number(r.submission_id)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push({
      submissionId: key, userId: r.user_id, username: r.username || '',
      createdAt: r.created_at, changes: safeJson(r.changes, [])
    })
  }
  return map
}

function maxOfFn(form) {
  const schema = Array.isArray(form.schema) ? form.schema : safeJson(form.schema, [])
  // 满分从当前 schema 取：区间说的「差了几分」必须跟题目现在的分值对得上
  return id => Number(schema.find(f => f.id === id)?.score) || 0
}

/** 一页答卷（列表页 20 行、榜单 20 行）：一次查完这一页的留痕，别一行一次 */
export function bandsOf(form, rows) {
  const out = new Map()
  if (!form || form.kind !== 'exam' || !rows?.length) return out
  const ids = [...new Set(rows.map(r => Number(r.id)).filter(Boolean))]
  if (!ids.length) return out
  const maxOf = maxOfFn(form)
  const grouped = groupLogs(all(
    `SELECT submission_id, user_id, username, changes, created_at FROM review_logs
      WHERE submission_id IN (${cols(ids)}) ORDER BY id ASC`, ...ids))
  for (const row of rows) {
    const band = scoreBand(grouped.get(Number(row.id)) || [], { maxOf, score: row.score, manual: manualScoresOf(row) })
    if (band) out.set(Number(row.id), band)
  }
  return out
}

/**
 * 尺子不齐的格子，**不管这题现在有没有分**。
 *
 * 阅卷队列用它：一道题刚被撤分（所以现在没分、总分里也没有它），
 * 但「张老师给过 4、李老师给过 16」这件事仍然必须摆在下一个批阅的人眼前——
 * 否则他就是第三个随手定口径的人。区间只算有分的格子，提醒不能这么算。
 */
export function crossedBySubmission(form, rows) {
  const out = new Map()
  if (!form || form.kind !== 'exam' || !rows?.length) return out
  const ids = [...new Set(rows.map(r => Number(r.id)).filter(Boolean))]
  if (!ids.length) return out
  const maxOf = maxOfFn(form)
  const grouped = groupLogs(all(
    `SELECT submission_id, user_id, username, changes, created_at FROM review_logs
      WHERE submission_id IN (${cols(ids)}) ORDER BY id ASC`, ...ids))
  for (const [sid, entries] of grouped) {
    const list = [...crossedOf(entries).values()].flat().map(c => ({ ...c, max: maxOf(c.id) }))
    if (list.length) out.set(sid, list)
  }
  return out
}

/**
 * 整张卷子里，每一份「有几处尺子不齐」。
 *
 * 阅卷队列要按「批完会不会改结论」排序，而这需要知道整队每一份的口径分歧数——
 * 不是只这一页。按页算的话，第二页的排序就看不见第一页的分歧，翻页顺序自相矛盾。
 *
 * 代价是这一次要读整张卷子的留痕。与 `bandsOf` 按页算不同，这里的量级是「这场考试的
 * 全部批阅次数」，而不是「一页 20 行」；一场千人的考试也就是几千条。
 * 真要撑不住，这里换成 SQL 聚合而不是把明细读进内存——但那是另一个数量级才会发生的事。
 */
export function crossedCountByForm(form) {
  const out = new Map()
  if (!form || form.kind !== 'exam') return out
  const grouped = groupLogs(all(
    'SELECT submission_id, user_id, username, changes, created_at FROM review_logs WHERE form_id = ? ORDER BY id ASC', form.id))
  for (const [sid, entries] of grouped) {
    const n = [...crossedOf(entries).values()].flat().length
    if (n) out.set(sid, n)
  }
  return out
}

/**
 * 导出一整张卷子：留痕读一次就够。
 *
 * 导出是流式的（93 万份答卷也不进内存），但留痕不能跟着每行查一次——
 * 一份卷子的批阅记录就那么几条，按行查等于把索引扫描做 N 遍。
 * 这里一次读完、按 submission 分组，行到跟前只剩一次 Map 查找。
 */
export function formBandReader(form) {
  if (!form || form.kind !== 'exam') return () => null
  const maxOf = maxOfFn(form)
  const grouped = groupLogs(all(
    'SELECT submission_id, user_id, username, changes, created_at FROM review_logs WHERE form_id = ? ORDER BY id ASC', form.id))
  return (row) => scoreBand(grouped.get(Number(row.id)) || [], { maxOf, score: row.score, manual: manualScoresOf(row) })
}
