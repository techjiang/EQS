import { get, all, run, now, log } from '../lib/db.js'
import { readJson, fail, sendJson } from '../lib/http.js'
import { requireUser, requirePerm, can } from '../lib/auth.js'
import { listTypes, listItems, itemsToOptions, formsUsing, normalizeCode, sanitizeParents } from '../lib/dict.js'
import { readXlsxUpload } from './files.js'
import { buildXlsx, readXlsx } from '../lib/xlsx.js'

/**
 * 数据字典接口。
 *
 * 读：任何登录用户（设计器要用它列选项、公开页要拿它渲染）；
 * 写：管理员。理由和部门/职位一致——字典是全站共享的，
 * 谁都能改的话，「学历」的下拉里迟早会冒出「本科（自考）」这种个人口径。
 */
export default function register(r) {
  /* ---------------- 类型 ---------------- */
  r.get('/api/dicts', async (req, res) => {
    requireUser(req)
    const url = new URL(req.url, 'http://x')
    const withItems = url.searchParams.get('items') === '1'
    const data = listTypes({ withItems })
    // 顺带把每个类型被哪些表单用着带回去：字典删除的确认框里要用，
    // 否则「删了会不会影响别人」只能靠人自己去翻表单。
    sendJson(res, 200, { ok: true, data })
  })

  r.get('/api/dicts/:code', async (req, res, { params }) => {
    requireUser(req)
    const type = get('SELECT * FROM dict_types WHERE code = ?', String(params.code))
    if (!type) fail(404, '字典不存在')
    sendJson(res, 200, { ok: true, data: { ...type, items: listItems(type.code) }, usedBy: formsUsing(type.code) })
  })

  /** 公开取字典选项：填写页渲染下拉时要用，不登录也能取（字典是展示性数据，不含个人信息） */
  r.get('/api/public/dicts/:code', async (req, res, { params }) => {
    const type = get('SELECT * FROM dict_types WHERE code = ?', String(params.code))
    if (!type) fail(404, '字典不存在')
    sendJson(res, 200, { ok: true, data: { code: type.code, name: type.name, options: itemsToOptions(listItems(type.code, { onlyEnabled: true })) } })
  })

  r.post('/api/dicts', async (req, res) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const body = await readJson(req)
    const name = String(body.name || '').trim()
    if (!name) fail(400, '请填写字典名称')
    const code = normalizeCode(body.code, name)
    if (!code) fail(400, '请填写字典标识')
    if (get('SELECT id FROM dict_types WHERE code = ?', code)) fail(409, `字典标识「${code}」已被占用`)
    if (get('SELECT id FROM dict_types WHERE name = ?', name)) fail(409, `已有同名字典「${name}」`)

    const ts = now()
    const result = run('INSERT INTO dict_types(code, name, description, sort, created_at) VALUES(?,?,?,?,?)',
      code, name, String(body.description || ''), Number(body.sort) || 0, ts)
    // 建字典时顺手把选项一起写进来：先建空壳再逐条加，是两次往返和一次失败机会
    const items = Array.isArray(body.items) ? body.items : []
    insertItems(code, items, ts)
    log(me, '新增字典', `${name}（${code}，${items.length} 项）`)
    sendJson(res, 201, { ok: true, id: Number(result.lastInsertRowid), code, data: { ...get('SELECT * FROM dict_types WHERE code = ?', code), items: listItems(code) } })
  })

  r.put('/api/dicts/:code', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const type = get('SELECT * FROM dict_types WHERE code = ?', String(params.code))
    if (!type) fail(404, '字典不存在')
    const body = await readJson(req)
    const name = body.name === undefined ? type.name : String(body.name).trim()
    if (!name) fail(400, '字典名称不能为空')
    if (name !== type.name && get('SELECT id FROM dict_types WHERE name = ? AND code <> ?', name, type.code)) fail(409, `已有同名字典「${name}」`)
    run('UPDATE dict_types SET name = ?, description = ?, sort = ? WHERE code = ?',
      name, body.description === undefined ? type.description : String(body.description),
      body.sort === undefined ? type.sort : Number(body.sort) || 0, type.code)
    log(me, '修改字典', `${type.name} → ${name}`)
    sendJson(res, 200, { ok: true, data: { ...get('SELECT * FROM dict_types WHERE code = ?', type.code), items: listItems(type.code) } })
  })

  r.delete('/api/dicts/:code', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const type = get('SELECT * FROM dict_types WHERE code = ?', String(params.code))
    if (!type) fail(404, '字典不存在')
    // 删字典不拦着（表单里已经是快照，删了照样能填），但要说清有多少张表单从此「同步」不了
    const used = formsUsing(type.code)
    run('DELETE FROM dict_items WHERE type_code = ?', type.code)
    run('DELETE FROM dict_types WHERE code = ?', type.code)
    log(me, '删除字典', `${type.name}（${type.code}），涉及 ${used.length} 张表单`)
    sendJson(res, 200, { ok: true, affectedForms: used })
  })

  /* ---------------- 字典项 ---------------- */
  r.get('/api/dicts/:code/items', async (req, res, { params }) => {
    requireUser(req)
    const type = get('SELECT * FROM dict_types WHERE code = ?', String(params.code))
    if (!type) fail(404, '字典不存在')
    sendJson(res, 200, { ok: true, data: listItems(type.code) })
  })

  r.post('/api/dicts/:code/items', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const type = get('SELECT * FROM dict_types WHERE code = ?', String(params.code))
    if (!type) fail(404, '字典不存在')
    const body = await readJson(req)
    const label = String(body.label || '').trim()
    if (!label) fail(400, '请填写选项名称')
    const value = String(body.value ?? label).trim() || label
    if (get('SELECT id FROM dict_items WHERE type_code = ? AND value = ?', type.code, value)) fail(409, `该字典下已有值为「${value}」的选项`)
    // 上级必须是本字典里已存在的值：写一个不存在的上级，这一项在级联里就永远不出现
    const parent = String(body.parent || '').trim()
    if (parent && !get('SELECT id FROM dict_items WHERE type_code = ? AND value = ?', type.code, parent)) fail(400, `上级选项「${parent}」不存在`)
    if (parent === value) fail(400, '不能把自己设为上级')
    const result = run('INSERT INTO dict_items(type_code, label, value, sort, enabled, parent, created_at) VALUES(?,?,?,?,?,?,?)',
      type.code, label, value, Number(body.sort) || nextSort(type.code), body.enabled === 0 || body.enabled === false ? 0 : 1, parent, now())
    sendJson(res, 201, { ok: true, id: Number(result.lastInsertRowid) })
  })

  /** 批量替换某个字典的全部选项（前端表格编辑后一次提交；也是 Excel/文本粘贴导入的落点） */
  r.put('/api/dicts/:code/items', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const type = get('SELECT * FROM dict_types WHERE code = ?', String(params.code))
    if (!type) fail(404, '字典不存在')
    const body = await readJson(req)
    if (!Array.isArray(body.items)) fail(400, '选项必须是数组')
    const parsed = parseItems(body.items)
    if (parsed.error) fail(400, parsed.error)
    run('DELETE FROM dict_items WHERE type_code = ?', type.code)
    insertItems(type.code, parsed.items, now())
    log(me, '更新字典项', `${type.name}（${type.code}）共 ${parsed.items.length} 项`)
    sendJson(res, 200, { ok: true, data: listItems(type.code), dropped: parsed.dropped, notes: parsed.notes })
  })

  r.put('/api/dicts/:code/items/:id', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const type = get('SELECT * FROM dict_types WHERE code = ?', String(params.code))
    if (!type) fail(404, '字典不存在')
    const item = get('SELECT * FROM dict_items WHERE id = ? AND type_code = ?', Number(params.id), type.code)
    if (!item) fail(404, '选项不存在')
    const body = await readJson(req)
    const label = body.label === undefined ? item.label : String(body.label).trim()
    if (!label) fail(400, '选项名称不能为空')
    const value = body.value === undefined ? item.value : (String(body.value).trim() || label)
    const dup = get('SELECT id FROM dict_items WHERE type_code = ? AND value = ? AND id <> ?', type.code, value, item.id)
    if (dup) fail(409, `该字典下已有值为「${value}」的选项`)
    const parent = body.parent === undefined ? item.parent : String(body.parent || '').trim()
    if (parent) {
      if (parent === value) fail(400, '不能把自己设为上级')
      if (!get('SELECT id FROM dict_items WHERE type_code = ? AND value = ?', item.type_code, parent)) fail(400, `上级选项「${parent}」不存在`)
      // 自己的子孙不能当自己的上级：那是一个环，级联渲染会一直往下找
      const desc = descendantValues(item.type_code, String(item.value))
      if (desc.has(parent)) fail(400, '不能把自己的下级设为上级')
    }
    run('UPDATE dict_items SET label = ?, value = ?, sort = ?, enabled = ?, parent = ? WHERE id = ?',
      label, value,
      body.sort === undefined ? item.sort : Number(body.sort) || 0,
      body.enabled === undefined ? item.enabled : (body.enabled ? 1 : 0),
      parent,
      item.id)
    // 改了一个值，原来挂在它下面的孩子就成孤儿了：在级联里等于整棵子树凭空消失。
    // 顺手把子项的 parent 一起改掉——「改个名字把下面的全弄丢」是最难解释的那种 bug。
    const renamed = String(item.value) !== String(value)
    if (renamed) {
      run('UPDATE dict_items SET parent = ? WHERE type_code = ? AND parent = ?', value, item.type_code, String(item.value))
    }
    sendJson(res, 200, { ok: true, renamed: renamed ? { from: String(item.value), to: value, children: renamed } : null })
  })

  r.delete('/api/dicts/:code/items/:id', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const item = get('SELECT * FROM dict_items WHERE id = ? AND type_code = ?', Number(params.id), String(params.code))
    if (!item) fail(404, '选项不存在')
    // 删一项，它的子项提成顶级而不是跟着删：一起删掉的话点一次「删除」能带走一整棵树的选项
    const orphans = get('SELECT COUNT(*) c FROM dict_items WHERE type_code = ? AND parent = ?', item.type_code, String(item.value)).c
    run('UPDATE dict_items SET parent = \'\' WHERE type_code = ? AND parent = ?', item.type_code, String(item.value))
    run('DELETE FROM dict_items WHERE id = ?', item.id)
    sendJson(res, 200, { ok: true, orphans })
  })

  /** 文本粘贴导入：一行一项，「名称|值」可选；也认「名称,值」。省掉逐条点加号 */
  r.post('/api/dicts/:code/items/import', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const type = get('SELECT * FROM dict_types WHERE code = ?', String(params.code))
    if (!type) fail(404, '字典不存在')
    const body = await readJson(req)
    const text = String(body.text || '')
    if (!text.trim()) fail(400, '请粘贴选项文本')
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    const incoming = lines.map(l => {
      // 「名称|值|上级的值」：级联字典要能一行写完父子关系，
      // 否则插一份省市区的清单得先导 34 个顶级的、再一条条挂上去
      const parts = l.split(/[|｜\t]/).map(s => s.trim())
      return { label: parts[0], value: parts[1] || parts[0], parent: parts[2] || '' }
    })
    const seen = new Set(listItems(type.code).map(i => i.value))
    const items = []
    let skipped = 0
    for (const i of incoming) {
      // 已有值、以及同一批里重复的值都跳过：两条一样的值只会在下拉里让人犹豫
      if (seen.has(i.value)) { skipped++; continue }
      seen.add(i.value)
      items.push(i)
    }
    insertItems(type.code, items, now())
    log(me, '导入字典项', `${type.name}（${type.code}）新增 ${items.length} 项`)
    sendJson(res, 200, { ok: true, added: items.length, skipped, data: listItems(type.code) })
  })

  /* ---------------- Excel 导入导出 ----------------
   * 「字典项只能用粘贴导入」是个说不通的边界：维护字典的人手上就是一张 Excel，
   * 而题库、答卷早有 xlsx 进出了。导出还能反过来当模板用——先导出、改完、再导回。
   */

  r.get('/api/dicts/:code/export.xlsx', async (req, res, { params }) => {
    requireUser(req)
    const type = get('SELECT * FROM dict_types WHERE code = ?', String(params.code))
    if (!type) fail(404, '字典不存在')
    const rows = [DICT_HEADERS]
    for (const it of listItems(type.code)) {
      rows.push([it.label, it.value, it.parent || '', it.enabled ? '是' : '否', it.sort])
    }
    const buf = buildXlsx(type.name || '字典项', rows)
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="dict-${encodeURIComponent(type.code)}.xlsx"; filename*=UTF-8''${encodeURIComponent(type.name + '.xlsx')}`,
      'Content-Length': buf.length
    })
    res.end(buf)
  })

  r.post('/api/dicts/:code/import-xlsx', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const type = get('SELECT * FROM dict_types WHERE code = ?', String(params.code))
    if (!type) fail(404, '字典不存在')
    const buf = await readXlsxUpload(req)
    if (!buf?.length) fail(400, '请上传 xlsx 文件')
    const rows = readXlsx(buf)
    if (!rows) fail(400, '无法读取该文件，请上传 .xlsx 格式的表格')
    const parsed = parseDictRows(rows)
    if (parsed.error) fail(400, parsed.error)
    // 导入是「追加」不是「替换」：拿一张补充表来加几个选项是最常见的用法，
    // 而替换会让已经绑定这套字典的表单在同步时丢掉一批选项
    const seen = new Set(listItems(type.code).map(i => String(i.value)))
    const fresh = []
    let skipped = 0
    for (const it of parsed.items) {
      if (seen.has(String(it.value))) { skipped++; continue }
      seen.add(String(it.value))
      fresh.push(it)
    }
    insertItems(type.code, fresh, now())
    log(me, 'Excel 导入字典项', `${type.name}（${type.code}）新增 ${fresh.length} 项`)
    sendJson(res, 200, {
      ok: true, added: fresh.length, skipped,
      notes: parsed.notes || [], unknownColumns: parsed.unknownColumns || [],
      data: listItems(type.code)
    })
  })
}

const DICT_HEADERS = ['显示名称', '存储值', '上级', '启用', '排序']

const DICT_ALIAS = {
  label: ['显示名称', '名称', '选项', 'label', 'name'],
  value: ['存储值', '值', 'value', 'code'],
  parent: ['上级', '上级选项', '父级', 'parent'],
  enabled: ['启用', '是否启用', '状态', 'enabled'],
  sort: ['排序', 'sort', 'order']
}

/**
 * 表格 → 字典项。
 * 认表头（不要求顺序），没有表头就按「名称 / 值 / 上级 / 启用 / 排序」的位置读。
 * 上级写的是**上级的存储值**，不写就落到顶级。
 */
export function parseDictRows(rows) {
  if (!rows?.length) return { items: [] }
  let map = null
  for (const [key, names] of Object.entries(DICT_ALIAS)) {
    const at = rows[0].findIndex(v => names.some(n => n === String(v ?? '').trim().toLowerCase()))
    if (at >= 0) { map = map || {}; map[key] = at }
  }
  // 认不出「名称」这一列，就说明这张表没有表头：按位置读第一行起的数据
  const hasHeader = !!map && map.label !== undefined
  if (!hasHeader) map = { label: 0, value: 1, parent: 2, enabled: 3, sort: 4 }
  const start = hasHeader ? 1 : 0
  const known = new Set(Object.values(map))
  const unknownColumns = start
    ? rows[0].map((v, i) => ({ name: String(v ?? '').trim(), at: i }))
        .filter(c => c.name && !known.has(c.at) && rows.slice(1).some(r => String(r[c.at] ?? '').trim() !== ''))
        .map(c => c.name)
    : []
  const at = (row, k) => (map[k] === undefined ? '' : String(row[map[k]] ?? '').trim())
  const items = []
  const seen = new Set()
  let dropped = 0
  for (let i = start; i < rows.length; i++) {
    const label = at(rows[i], 'label')
    if (!label) { dropped++; continue }
    const value = at(rows[i], 'value') || label
    if (seen.has(value)) { dropped++; continue }
    seen.add(value)
    const enabledRaw = at(rows[i], 'enabled').toLowerCase()
    items.push({
      label, value,
      parent: at(rows[i], 'parent'),
      // 空白当启用：一张只有两列的表不该把选项全导成停用状态
      enabled: enabledRaw === '' || ['是', '启用', 'y', 'yes', 'true', '1', '✓'].includes(enabledRaw) ? 1 : 0,
      sort: Number(at(rows[i], 'sort')) || 0
    })
  }
  const fixed = sanitizeParents(items)
  return { items: fixed.items, notes: fixed.notes, unknownColumns, dropped }
}

/** 某个值的全部子孙（用来拦住「把自己的下级设成上级」这种环） */
function descendantValues(code, value) {
  const out = new Set()
  const queue = [value]
  let guard = 0
  while (queue.length && guard++ < 5000) {
    const cur = queue.shift()
    for (const row of all('SELECT value FROM dict_items WHERE type_code = ? AND parent = ?', code, cur)) {
      const v = String(row.value)
      if (out.has(v)) continue
      out.add(v)
      queue.push(v)
    }
  }
  return out
}

function nextSort(code) {
  const row = get('SELECT MAX(sort) AS m FROM dict_items WHERE type_code = ?', code)
  return (Number(row?.m) || 0) + 10
}

/**
 * 清洗一批选项。
 * value 默认等于 label（和设计器手写选项同一口径）；同批里 value 重复的直接丢掉后半条，
 * 否则「保存成功」之后下拉里两个一模一样的值，导出统计时会合并成一项，谁都看不出为什么。
 */
function parseItems(raw) {
  const out = []
  const seen = new Set()
  let dropped = 0
  for (const it of raw) {
    const label = String(it?.label ?? it?.name ?? it ?? '').trim()
    if (!label) { dropped++; continue }
    const value = String(it?.value ?? '').trim() || label
    if (seen.has(value)) { dropped++; continue }
    seen.add(value)
    out.push({
      label, value, sort: Number(it?.sort) || 0,
      enabled: it?.enabled === 0 || it?.enabled === false ? 0 : 1,
      // 级联字典靠这一列串父子；平级字典留空，不改变原有形状
      parent: String(it?.parent ?? '').trim()
    })
  }
  // 父子关系有问题时不报错、直接修正并回报：一条「上级不存在」不该让整批 200 项存不进去
  const fixed = sanitizeParents(out)
  return { items: fixed.items, dropped, notes: fixed.notes }
}

function insertItems(code, items, ts) {
  let sort = nextSort(code)
  for (const it of items) {
    const label = String(it?.label ?? it?.name ?? it ?? '').trim()
    if (!label) continue
    const value = String(it?.value ?? '').trim() || label
    run('INSERT INTO dict_items(type_code, label, value, sort, enabled, parent, created_at) VALUES(?,?,?,?,?,?,?)',
      code, label, value, Number(it?.sort) || sort, it?.enabled === 0 || it?.enabled === false ? 0 : 1,
      String(it?.parent ?? '').trim(), ts)
    sort += 10
  }
}
