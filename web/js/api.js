const jsonHeaders = { 'Content-Type': 'application/json' }

async function request(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options })
  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new Error(`请求失败 (${res.status})`)
    return res
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok === false) throw new Error(body.message || `请求失败 (${res.status})`)
  return body
}

export const api = {
  get: (url) => request(url),
  post: (url, body) => request(url, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body || {}) }),
  put: (url, body) => request(url, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(body || {}) }),
  del: (url) => request(url, { method: 'DELETE' }),
  upload: (file, extra = {}) => {
    const fd = new FormData()
    fd.append('file', file)
    for (const [k, v] of Object.entries(extra)) fd.append(k, v)
    return request('/api/upload', { method: 'POST', body: fd })
  },
  download: async (url, filename) => {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) throw new Error('下载失败')
    const blob = await res.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 3000)
  },
  stream: async (url, body, onDelta) => {
    const res = await fetch(url, { method: 'POST', headers: jsonHeaders, credentials: 'same-origin', body: JSON.stringify(body) })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop()
      for (const p of parts) {
        const line = p.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return
        try { onDelta(JSON.parse(payload)) } catch {}
      }
    }
  }
}
