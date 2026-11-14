import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRouter, sendJson, serveStatic, HttpError, clientIp } from './lib/http.js'
import { ensureAdmin, seedRoles } from './lib/auth.js'
import { seedTemplates, seedSettings, seedDicts } from './lib/seed.js'
import { log } from './lib/db.js'
import { runWithRequest } from './lib/ctx.js'

import authRoutes from './routes/auth.js'
import formRoutes from './routes/forms.js'
import submissionRoutes from './routes/submissions.js'
import bankRoutes from './routes/banks.js'
import adminRoutes from './routes/admin.js'
import fileRoutes from './routes/files.js'
import systemRoutes from './routes/system.js'
import dictRoutes from './routes/dict.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIR = path.join(__dirname, '..', 'web')
const PORT = Number(process.env.PORT || 8080)

seedRoles()
ensureAdmin()
seedTemplates()
seedSettings()
seedDicts()

const router = createRouter()
for (const register of [authRoutes, formRoutes, submissionRoutes, bankRoutes, adminRoutes, fileRoutes, systemRoutes, dictRoutes]) register(router)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const pathname = decodeURIComponent(url.pathname)

  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key',
      'Access-Control-Allow-Credentials': 'true'
    })
    return res.end()
  }

  // API 跨域（供 webhook / 外部系统调用）
  if (pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
  }

  try {
    const match = router.match(req.method, pathname)
    // 请求级上下文：handler 里任何一处 log() 不传 IP，也能拿到来源地址
    if (match) return await runWithRequest(clientIp(req), () => match.handler(req, res, { params: match.params }))
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, message: '接口不存在' })

    // 静态资源
    if (serveStatic(WEB_DIR, req, res, pathname)) return
    // 前端路由回退到 index.html
    if (!path.extname(pathname)) {
      if (serveStatic(WEB_DIR, req, res, '/index.html')) return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404 Not Found')
  } catch (err) {
    // 有些模块（如 forms.js 的作答清洗）不在 http.js 里，只按约定挂一个 status；
    // 只认 instanceof HttpError 的后果是：一个「你的作答不合法」的 422 被报成 500，
    // 前端拿到的文案变成「服务器内部错误」，用户完全不知道是自己填错了
    const status = err instanceof HttpError ? err.status : (Number(err?.status) || 500)
    if (status >= 500) {
      console.error('[EQS]', err)
      try { log(null, '服务异常', err.message, clientIp(req)) } catch {}
    }
    sendJson(res, status, { ok: false, message: err.message || '服务器内部错误' })
  }
})

server.listen(PORT, () => {
  console.log(`\n  EQS 已启动  →  http://localhost:${PORT}`)
  console.log(`  数据目录：${process.env.EQS_DATA_DIR || path.join(process.cwd(), 'data')}`)
  console.log(`  默认账号：admin / ${process.env.EQS_ADMIN_PASSWORD || 'admin123'}\n`)
})

const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
