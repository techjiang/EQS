import { buildZip, readZipEntries } from './zip.js'

/* 零依赖的 xlsx 读写。
 *
 * 只支持「一张表、纯值」这一种形态——EQS 需要的就是这个：把题库/答卷的表格拿进来、把答卷导出去。
 * 公式、样式、多工作表、合并单元格一律不读（读成值），写出时也不生成（生成的东西越小，
 * 越不会有「打开提示需要修复」这类问题）。用 Excel / WPS / Numbers / LibreOffice 都能正常打开。 */

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // XML 1.0 不允许控制字符；用户粘贴进来的文本里常有，直接写进去 Excel 会拒绝打开
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')

const colName = (i) => {
  let n = i + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** 值 → 单元格；数字写成数字，其余写成内联字符串 */
function cell(ref, value) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`
}

const sheetName_ = (name) => String(name || 'Sheet1').replace(/[:\\/?*[\]]/g, '_').slice(0, 31) || 'Sheet1'

const sheetHead = (rows0) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${rows0?.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 0 ? 22 : 18}" customWidth="1"/>`).join('') || ''}</cols><sheetData>`
const sheetRowXml = (row, ri) => `<row r="${ri + 1}">${row.map((v, ci) => cell(colName(ci) + (ri + 1), v)).join('')}</row>`
const sheetTail = (lastCol, rowCount) => `</sheetData><autoFilter ref="A1:${lastCol}${Math.max(1, rowCount)}"/></worksheet>`

/** 除工作表之外的固定部件 */
function fixedParts(safeName) {
  return [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(safeName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    },
    {
      name: 'xl/styles.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`
    }
  ]
}

/**
 * 生成 xlsx。
 * @param {string} sheetName 工作表名（Excel 限制 31 字符且不许出现 : \ / ? * [ ]）
 * @param {Array<Array<any>>} rows 第一行会被冻结并加粗
 */
export function buildXlsx(sheetName, rows) {
  const body = rows.map((row, ri) => sheetRowXml(row, ri)).join('')
  const lastCol = colName(Math.max(0, (rows[0]?.length || 1) - 1))
  const sheet = sheetHead(rows[0]) + body + sheetTail(lastCol, rows.length)
  return buildZip([...fixedParts(sheetName_(sheetName)), { name: 'xl/worksheets/sheet1.xml', data: sheet }])
}

/**
 * 流式生成 xlsx。
 *
 * 用在「行数由数据决定」的导出上（答卷导出：一份问卷几十万份答卷）。
 * buildXlsx 需要先有一整个二维数组，行一多就同时存在三份完整数据
 * （行数组、拼好的 XML 字符串、压缩副本），实测 93 万行直接 range error。
 * 这里改成边遍历边吐块：内存只跟一行有关。
 *
 * @param {string} sheetName
 * @param {AsyncIterable<Array<any>>|Iterable<Array<any>>} rows 第一行是表头
 * @param {import('node:stream').Writable} out
 */
export async function writeXlsxStream(sheetName, rows, out) {
  const { writeZipStream } = await import('./zip.js')
  const { Readable } = await import('node:stream')

  // 表头要用来定列宽与 autoFilter，必须先看一行
  const it = rows[Symbol.asyncIterator] ? rows[Symbol.asyncIterator]() : rows[Symbol.iterator]()
  const first = await it.next()
  const head = first.done ? [] : first.value
  let count = first.done ? 0 : 1

  const parts = fixedParts(sheetName_(sheetName))
  const sheetNameText = 'xl/worksheets/sheet1.xml'
  const forward = {
    async *[Symbol.asyncIterator]() {
      yield sheetHead(head)
      let ri = 0
      if (!first.done) yield sheetRowXml(head, ri++)
      let r = await it.next()
      while (!r.done) { yield sheetRowXml(r.value, ri++) ; r = await it.next() }
      count = ri
      yield sheetTail(colName(Math.max(0, (head.length || 1) - 1)), ri)
    }
  }
  // 工作表放在最后：Excel 不在乎顺序，但把小的静态部件先写出来，
  // 客户端能更早开始收内容
  const entries = [...parts.map(p => ({ name: p.name, data: p.data })), { name: sheetNameText, data: forward }]
  return writeZipStream(entries, out)
}

/** 反解 XML 实体 */
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

/** 收集 <si>/<is> 里的全部 <t> 文本（富文本被拆成多个 run，只取第一个 t 会截断字） */
function textOf(xml) {
  let out = ''
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g
  let m
  while ((m = re.exec(xml))) out += unescapeXml(m[1])
  return out
}

const refToCol = (ref) => {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] || 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/**
 * 读取 xlsx 的第一个工作表，返回二维数组（已按列号对齐，空单元格补 ''）。
 * 读不了就返回 null，让调用方给出「请上传 .xlsx 文件」这类人话。
 */
export function readXlsx(buf) {
  const entries = readZipEntries(buf)
  if (!entries) return null
  const find = (name) => entries.find(e => e.name === name)?.data?.toString('utf8')
  const sharedXml = find('xl/sharedStrings.xml') || ''
  const shared = []
  {
    const re = /<si[\s>][\s\S]*?<\/si>|<si\/>/g
    let m
    while ((m = re.exec(sharedXml))) shared.push(textOf(m[0]))
  }
  // 工作表文件：优先 workbook.xml.rels 里的第一张，否则退到 sheets/ 下第一个
  let sheetPath = entries.map(e => e.name).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0]
  const rels = find('xl/_rels/workbook.xml.rels') || ''
  const firstSheetRel = /<Relationship[^>]*Type="[^"]*worksheet"[^>]*Target="([^"]+)"/.exec(rels)?.[1]
  if (firstSheetRel) {
    const p = firstSheetRel.startsWith('/') ? firstSheetRel.slice(1) : 'xl/' + firstSheetRel.replace(/^\.\//, '')
    if (entries.some(e => e.name === p)) sheetPath = p
  }
  if (!sheetPath) return null
  const sheet = find(sheetPath)
  if (!sheet) return null

  const rows = []
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g
  let rm
  while ((rm = rowRe.exec(sheet))) {
    const cells = []
    const cellRe = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g
    let cm
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1] ?? cm[3] ?? ''
      const inner = cm[2] ?? ''
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1]
      const type = /t="([^"]+)"/.exec(attrs)?.[1] || 'n'
      let value = ''
      if (type === 's') {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1])
        value = shared[idx] ?? ''
      } else if (type === 'inlineStr') {
        value = textOf(inner)
      } else if (type === 'str') {
        value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '')
      } else if (type === 'b') {
        value = /<v>1<\/v>/.test(inner) ? 'TRUE' : 'FALSE'
      } else {
        const num = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
        value = num === undefined ? '' : String(num).trim()
      }
      const at = ref ? refToCol(ref) : cells.length
      while (cells.length < at) cells.push('')
      cells[at] = value
    }
    rows.push(cells)
  }
  // 去掉纯空行（Excel 常带一大片空行，不过滤的话「第 200 行有个空题目」这种报错没法读）
  return rows.filter(r => r.some(v => String(v ?? '').trim() !== ''))
}
