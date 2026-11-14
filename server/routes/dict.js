import { get, all, run, now, log } from '../lib/db.js'
import { readJson, fail, sendJson } from '../lib/http.js'
import { requireUser, requirePerm, can } from '../lib/auth.js'
import { listTypes, listItems, itemsToOptions, formsUsing, normalizeCode } from '../lib/dict.js'

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
    const result = run('INSERT INTO dict_items(type_code, label, value, sort, enabled, created_at) VALUES(?,?,?,?,?,?)',
      type.code, label, value, Number(body.sort) || nextSort(type.code), body.enabled === 0 || body.enabled === false ? 0 : 1, now())
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
    sendJson(res, 200, { ok: true, data: listItems(type.code), dropped: parsed.dropped })
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
    run('UPDATE dict_items SET label = ?, value = ?, sort = ?, enabled = ? WHERE id = ?',
      label, value,
      body.sort === undefined ? item.sort : Number(body.sort) || 0,
      body.enabled === undefined ? item.enabled : (body.enabled ? 1 : 0),
      item.id)
    sendJson(res, 200, { ok: true })
  })

  r.delete('/api/dicts/:code/items/:id', async (req, res, { params }) => {
    const me = requirePerm(req, 'form:create')
    if (!can(me, '*')) fail(403, '权限不足')
    const item = get('SELECT * FROM dict_items WHERE id = ? AND type_code = ?', Number(params.id), String(params.code))
    if (!item) fail(404, '选项不存在')
    run('DELETE FROM dict_items WHERE id = ?', item.id)
    sendJson(res, 200, { ok: true })
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
      const parts = l.split(/[|｜\t]/).map(s => s.trim())
      return { label: parts[0], value: parts[1] || parts[0] }
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
    out.push({ label, value, sort: Number(it?.sort) || 0, enabled: it?.enabled === 0 || it?.enabled === false ? 0 : 1 })
  }
  return { items: out, dropped }
}

function insertItems(code, items, ts) {
  let sort = nextSort(code)
  for (const it of items) {
    const label = String(it?.label ?? it?.name ?? it ?? '').trim()
    if (!label) continue
    const value = String(it?.value ?? '').trim() || label
    run('INSERT INTO dict_items(type_code, label, value, sort, enabled, created_at) VALUES(?,?,?,?,?,?)',
      code, label, value, Number(it?.sort) || sort, it?.enabled === 0 || it?.enabled === false ? 0 : 1, ts)
    sort += 10
  }
}
