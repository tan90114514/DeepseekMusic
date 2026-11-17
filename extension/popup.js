'use strict'

const $ = (id) => document.getElementById(id)
const COOKIE_ALLOWLIST = [
  'SESSDATA',
  'buvid3',
  'buvid4',
  'b_nut',
  'bili_ticket',
  'bili_jct',
  'DedeUserID',
  'DedeUserID__ckMd5'
]
const STATUS_LABELS = {
  queued: '排队中',
  running: '下载中',
  completed: '已完成',
  partial: '部分失败',
  failed: '失败',
  interrupted: '已中断'
}

const state = {
  mediaId: '',
  taskId: '',
  busy: false,
  pollTimer: null,
  taskConfig: null
}

function setMessage(text, kind = '') {
  const el = $('message')
  el.textContent = text || ''
  el.className = `message ${kind}`.trim()
}

function setConnectionStatus(text, kind = '') {
  const el = $('connectionStatus')
  el.textContent = text || ''
  el.className = `hint ${kind}`.trim()
}

function setPageState(text, kind = '') {
  const el = $('pageState')
  el.textContent = text
  el.className = `page-state ${kind}`.trim()
}

function getConfigFromForm() {
  const port = Number($('port').value.trim())
  const token = $('token').value.trim()
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('端口必须是 1024–65535 的整数')
  }
  if (!token) {
    throw new Error('请填写本地软件设置页生成的配对 Token')
  }
  return { port, token }
}

async function persistConfig() {
  const config = getConfigFromForm()
  await chrome.storage.local.set({ bridgePort: config.port, bridgeToken: config.token })
  return config
}

async function readStoredConfig() {
  const stored = await chrome.storage.local.get(['bridgePort', 'bridgeToken'])
  const port = Number(stored.bridgePort || 39547)
  const token = String(stored.bridgeToken || '')
  $('port').value = String(port)
  $('token').value = token
  if (!token) $('settingsDetails').open = true
  return { port, token }
}

async function parseCurrentPage() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tab = tabs[0]
    if (!tab || !tab.url) {
      setPageState('无法读取当前标签页地址，请重新点击插件图标。', 'error')
      return
    }
    const url = new URL(tab.url)
    if (!url.hostname.endsWith('bilibili.com')) {
      setPageState('当前标签页不是B站页面。请打开目标收藏夹详情页。', 'error')
      return
    }
    let mediaId = url.searchParams.get('fid') || ''
    if (!/^\d+$/.test(mediaId)) {
      const pathMatch = url.pathname.match(/\/medialist\/(?:play|detail)\/ml(\d+)/i)
      mediaId = pathMatch ? pathMatch[1] : ''
    }
    if (!/^\d+$/.test(mediaId)) {
      setPageState(
        '没有在当前地址里找到收藏夹 ID。请打开“收藏夹详情页”，地址通常包含 fid=数字。',
        'error'
      )
      return
    }
    state.mediaId = mediaId
    $('favoriteId').textContent = mediaId
    setPageState('已识别当前B站收藏夹，可以发送到 DS音乐播放器。', 'ok')
    $('sendBtn').disabled = false
  } catch (error) {
    setPageState(`读取当前页面失败：${error.message}`, 'error')
  }
}

class BridgeError extends Error {
  constructor(message, code, status, data) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.status = status
    this.data = data
  }
}

async function bridgeRequest(path, options, config, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response
    try {
      response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
        method: options.method || 'GET',
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      })
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new BridgeError('连接本地软件超时，请确认软件正在运行', 'NETWORK_TIMEOUT', 0)
      }
      throw new BridgeError(
        '无法连接本地软件。请确认软件已启动、端口填写正确，并检查安全软件拦截。',
        'NETWORK_ERROR',
        0
      )
    }
    let payload = null
    try {
      payload = await response.json()
    } catch {
      throw new BridgeError(`本地软件返回了无法解析的响应（HTTP ${response.status}）`, 'BAD_RESPONSE', response.status)
    }
    if (!response.ok || !payload.ok) {
      const err = payload && payload.error ? payload.error : {}
      throw new BridgeError(
        err.message || `本地软件返回 HTTP ${response.status}`,
        err.code || 'BRIDGE_ERROR',
        response.status,
        payload
      )
    }
    return payload
  } finally {
    clearTimeout(timer)
  }
}

async function testConnection() {
  setConnectionStatus('正在连接…')
  try {
    const config = await persistConfig()
    const result = await bridgeRequest('/ping', { method: 'GET' }, config, 8000)
    setConnectionStatus(
      `连接成功：本地软件 v${result.appVersion || '?'}，协议 v${result.protocolVersion || '?'}`,
      'ok'
    )
  } catch (error) {
    setConnectionStatus(error.message, 'error')
    if (error.code === 'UNAUTHORIZED' || error.code === 'TOKEN_NOT_CONFIGURED') {
      setConnectionStatus('Token 不正确，或软件里还没有生成 Token。', 'error')
    }
    if (error.code === 'TOKEN_NOT_CONFIGURED') $('settingsDetails').open = true
  }
}

async function ensureCookiePermission() {
  const details = {
    permissions: ['cookies'],
    origins: ['https://*.bilibili.com/*']
  }
  const already = await chrome.permissions.contains(details)
  if (already) return true
  return chrome.permissions.request(details)
}

async function collectCookieHeader() {
  const granted = await chrome.permissions.contains({
    permissions: ['cookies'],
    origins: ['https://*.bilibili.com/*']
  })
  if (!granted) {
    throw new Error('当前未授权读取 B站 Cookie。请重新勾选“携带登录 Cookie”。')
  }
  const cookies = []
  for (const url of ['https://www.bilibili.com/', 'https://space.bilibili.com/']) {
    const found = await chrome.cookies.getAll({ url })
    for (const cookie of found) cookies.push(cookie)
  }
  const byName = new Map()
  for (const cookie of cookies) {
    if (COOKIE_ALLOWLIST.includes(cookie.name)) byName.set(cookie.name, cookie.value)
  }
  if (!byName.has('SESSDATA')) {
    throw new Error('没有找到 B站登录 Cookie（SESSDATA）。请先在当前浏览器登录B站，或取消勾选 Cookie。')
  }
  return COOKIE_ALLOWLIST.filter((name) => byName.has(name))
    .map((name) => `${name}=${byName.get(name)}`)
    .join('; ')
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer)
    state.pollTimer = null
  }
}

function renderProgress(job) {
  $('progressSection').hidden = false
  const status = String(job.status || 'queued')
  $('jobStatus').textContent = STATUS_LABELS[status] || status
  $('jobStatus').className = `status-pill ${status}`
  const title = job.title || (job.mediaId ? `B站收藏夹 ${job.mediaId}` : 'B站收藏夹任务')
  $('jobTitle').textContent = title

  const total = Number(job.total || 0)
  const succeeded = Number(job.succeeded || 0)
  const failed = Number(job.failed || 0)
  const skipped = Number(job.skipped || 0)
  const pending = Number(job.pending || 0)
  const done = Math.min(total, succeeded + failed + skipped)
  const percent = total > 0 ? Math.round((done / total) * 100) : status === 'running' ? 6 : 0
  $('progressBar').style.width = `${percent}%`
  $('jobCounts').textContent = total
    ? `成功 ${succeeded} · 跳过 ${skipped} · 失败 ${failed} · 待处理 ${pending}`
    : '正在读取收藏夹信息…'
  const phase = job.current && job.current.phase ? job.current.phase : job.currentPhase || ''
  const currentTitle = job.current && job.current.title ? job.current.title : job.currentTitle || ''
  $('currentLine').textContent = currentTitle ? `${phase}${phase ? '：' : ''}${currentTitle}` : phase

  const failures = Array.isArray(job.failures) ? job.failures : []
  $('failureBox').hidden = failures.length === 0
  const list = $('failureList')
  list.textContent = ''
  for (const failure of failures.slice(0, 5)) {
    const li = document.createElement('li')
    li.textContent = `${failure.title || failure.bvid}：${failure.message || failure.code}`
    list.appendChild(li)
  }

  if (status === 'running' || status === 'queued') {
    if (!state.pollTimer) {
      state.pollTimer = setInterval(() => {
        void refreshProgress(true)
      }, 1300)
    }
  } else {
    stopPolling()
    if (status === 'partial' || status === 'failed' || status === 'interrupted') {
      setMessage(
        '任务没有全部成功。公开收藏夹可直接在桌面软件的任务列表里重试；需要登录的内容请重新勾选 Cookie 后发送。',
        'error'
      )
    } else if (status === 'completed') {
      setMessage('任务完成，可以回到 DS音乐播放器查看 B站分类。', 'ok')
    }
  }
}

async function refreshProgress(auto = false) {
  if (!state.taskId) return
  try {
    const config = state.taskConfig || (await readStoredConfig())
    if (!config.token) throw new Error('请先填写配对 Token')
    const job = await bridgeRequest(
      `/progress?taskId=${encodeURIComponent(state.taskId)}`,
      { method: 'GET' },
      config,
      8000
    )
    renderProgress(job)
  } catch (error) {
    if (!auto) setMessage(error.message, 'error')
    stopPolling()
  }
}

async function startProgressPolling(taskId) {
  state.taskId = taskId
  state.taskConfig = getConfigFromForm()
  await chrome.storage.local.set({ lastTaskId: taskId, lastTaskAt: Date.now() })
  $('progressSection').hidden = false
  setMessage('')
  await refreshProgress(false)
}

async function sendTask() {
  if (state.busy) return
  if (!state.mediaId) {
    setMessage('请先打开B站收藏夹详情页。', 'error')
    return
  }
  state.busy = true
  $('sendBtn').disabled = true
  $('sendBtn').textContent = '正在发送…'
  setMessage('正在连接本地软件…')
  stopPolling()

  try {
    const config = await persistConfig()
    let cookieHeader = ''
    if ($('useCookies').checked) {
      setMessage('正在读取B站登录 Cookie（仅发送到本机）…')
      cookieHeader = await collectCookieHeader()
    }
    const requestId = crypto.randomUUID()
    setMessage('正在发送任务…')
    const result = await bridgeRequest(
      '/task',
      {
        method: 'POST',
        body: {
          protocolVersion: 1,
          requestId,
          type: 'bilibili.favorite',
          payload: { mediaId: state.mediaId },
          options: { skipExisting: true },
          credentials: cookieHeader
            ? { mode: 'browserCookie', cookieHeader }
            : { mode: 'none' }
        }
      },
      config,
      20000
    )
    $('useCookies').checked = false
    await startProgressPolling(result.taskId)
  } catch (error) {
    if (error.data && error.data.error && error.data.error.activeTaskId) {
      $('useCookies').checked = false
      await startProgressPolling(error.data.error.activeTaskId)
      return
    }
    setMessage(error.message, 'error')
    if (error.code === 'UNAUTHORIZED' || error.code === 'TOKEN_NOT_CONFIGURED') {
      $('settingsDetails').open = true
      setConnectionStatus('Token 不正确，或软件里还没有生成 Token。', 'error')
    }
  } finally {
    state.busy = false
    $('sendBtn').textContent = '发送到 DS音乐播放器'
    $('sendBtn').disabled = !state.mediaId
  }
}

async function restoreLastTask() {
  const stored = await chrome.storage.local.get(['lastTaskId', 'lastTaskAt'])
  if (!stored.lastTaskId) return
  if (stored.lastTaskAt && Date.now() - Number(stored.lastTaskAt) > 24 * 60 * 60 * 1000) return
  state.taskId = String(stored.lastTaskId)
  state.taskConfig = getConfigFromForm()
  if (!state.taskConfig.token) return
  $('progressSection').hidden = false
  await refreshProgress(true)
}

function bindEvents() {
  $('testBtn').addEventListener('click', () => {
    void testConnection()
  })
  $('sendBtn').addEventListener('click', () => {
    void sendTask()
  })
  $('refreshBtn').addEventListener('click', () => {
    void refreshProgress(false)
  })
  $('toggleToken').addEventListener('click', () => {
    const input = $('token')
    const show = input.type === 'password'
    input.type = show ? 'text' : 'password'
    $('toggleToken').textContent = show ? '隐藏' : '显示'
  })
  $('port').addEventListener('input', () => setConnectionStatus(''))
  $('token').addEventListener('input', () => setConnectionStatus(''))
  $('useCookies').addEventListener('change', async () => {
    if (!$('useCookies').checked) return
    try {
      setMessage('')
      const granted = await ensureCookiePermission()
      if (!granted) {
        $('useCookies').checked = false
        setMessage('没有授予 Cookie 权限，本次仍可使用公开收藏夹。', 'error')
      }
    } catch (error) {
      $('useCookies').checked = false
      setMessage(`申请 Cookie 权限失败：${error.message}`, 'error')
    }
  })
  window.addEventListener('unload', () => stopPolling())
}

async function init() {
  bindEvents()
  await readStoredConfig()
  await parseCurrentPage()
  await restoreLastTask()
}

void init()
