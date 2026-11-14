import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 请求级上下文。
 *
 * 只放「随手要拿、又不值得一层层往下传」的东西。目前只有来源 IP：
 * `log(me, '删除表单', ...)` 这类调用散在 20 多个地方，绝大多数没传 IP，
 * 于是审计日志里这一列大面积是空的 —— 而它恰恰是最先要看的那一列。
 * 与其逐个改调用点（总会漏），不如在请求入口存一份，缺省时回退过来。
 *
 * 单独放在这个文件里，是为了不让 http.js ↔ db.js 互相 import 成环。
 */
const store = new AsyncLocalStorage()

export const runWithRequest = (ip, fn) => store.run(ip, fn)
export const currentRequestIp = () => store.getStore() || ''
