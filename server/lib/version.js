import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * 版本号只写在 package.json 里。
 *
 * 以前 /api/health、/api/system/info、备份包的 manifest 各自写死一个 '1.0.0'，
 * 发版时改了 package.json 而这三处忘改，于是「后台显示 1.0.0、备份包写 1.0.0、
 * 实际装的是 1.1.0」——排查线上问题时，这个数字是第一句要看的，它不该有三份。
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'))

export const APP_VERSION = pkg.version || '0.0.0'
export const APP_NAME = pkg.name || 'eqs'
