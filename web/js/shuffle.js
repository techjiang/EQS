/**
 * 可复现的乱序：同一 seed 一定得到同一顺序。
 *
 * 为什么不用 Math.random：
 *  1. 老师要按「第 3 题」跟学生对话，而每个人卷子的第 3 题都不一样。乱序只有在
 *     「同一份答卷能重现当年那个顺序」时才是可解释的，所以 seed 跟着答卷一起存；
 *  2. 测试要能断言内容，随机的东西没法断言。
 *
 * 用的是 xmur3 取哈希 + mulberry32 生成序列，两个都是常见的小实现，
 * 重点是「同 seed 同结果」和「分布够散」，不是密码学强度。
 */

function xmur3(str) {
  let h = 1779033703 ^ String(str).length
  for (let i = 0; i < String(str).length; i++) {
    h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return h >>> 0
  }
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 同一 seed → 同一个随机序列 */
export function seededRandom(seed) {
  return mulberry32(xmur3(seed || 'eqs')())
}

/** 原地不动地返回一个新数组：Fisher–Yates，用调用方给的随机源 */
export function shuffled(list, rand) {
  const arr = [...(list || [])]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/**
 * 哪些题型的选项不能打乱：
 *  - sort：数组顺序就是答案本身，打乱初始顺序等于把题目改成另一道题
 *  - matrix：列是刻度（很满意→很不满意），打乱之后量表就读不出方向
 *  - 没有选项的题型（文本、日期、上传……）本来也没得打乱
 */
const OPTION_LOCKED = new Set(['sort', 'matrix', 'cascader', 'carousel', 'slider', 'rate', 'nps', 'subform'])

/**
 * 按设置乱序整张卷子。
 *
 * @param schema 已归一化的字段数组
 * @param seed   与这份答卷绑定的随机种子
 * @param opts   { questions, options }
 * @returns { schema, seed } 新数组，原 schema 不动
 *
 * 一个刻意的取舍：**有 jqmp 的表单不打乱题目顺序**。
 * 条件跳转的语义是「命中则其后所有题目作废」，它依赖题目先后；
 * 顺序一乱，「跳到第几题之后结束」就变成另一件事，学生看到的结束点跟设计者想的完全不同。
 * 所以只要任意一题带 jump，就只乱选项、不乱题目 —— 宁可少一个能力，也不出一个解释不清的规则。
 */
export function shuffleSchema(schema, seed, { questions = false, options = false } = {}) {
  const list = Array.isArray(schema) ? schema : []
  if (!questions && !options) return { schema: list, seed: seed || '' }
  const rand = seededRandom(seed)
  const hasJump = list.some(f => Array.isArray(f.jump) && f.jump.length)

  let out = list.map(f => {
    if (!options) return f
    if (!Array.isArray(f.options) || f.options.length < 2) return f
    if (OPTION_LOCKED.has(f.type)) return f
    return { ...f, options: shuffled(f.options, rand) }
  })

  if (questions && !hasJump) {
    /*
     * 说明类组件（分割线 / 富文本 / 图片）跟着它**下面**那道题走。
     * 分割线在这里的用法是「下一段的小标题」，跟着下一题移动才讲得通；
     * 单独抽出去打乱，「这一段说明」就会飘到毫不相关的位置，甚至变成对上一题的注解。
     */
    const anchors = []
    let pending = []
    for (const f of out) {
      if (['divider', 'richtext', 'html', 'image'].includes(f.type)) pending.push(f)
      else { anchors.push({ field: f, before: pending }); pending = [] }
    }
    // 末尾孤零零的说明块没有「下一题」可依附，就留在最后
    const tail = pending
    out = [...shuffled(anchors, rand).flatMap(a => [...a.before, a.field]), ...tail]
  }

  return { schema: out, seed: seed || '' }
}
