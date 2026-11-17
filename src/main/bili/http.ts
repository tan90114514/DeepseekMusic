import crypto from 'node:crypto'

const API_BASE = 'https://api.bilibili.com'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9,
  42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1,
  60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

const COOKIE_ALLOWLIST = new Set([
  'SESSDATA',
  'buvid3',
  'buvid4',
  'b_nut',
  'bili_ticket',
  'bili_jct',
  'DedeUserID',
  'DedeUserID__ckMd5'
])

interface BiliEnvelope<T> {
  code: number
  message: string
  ttl?: number
  data: T
}

interface WbiKeys {
  imgKey: string
  subKey: string
  expiresAt: number
}

let wbiCache: WbiKeys | null = null

export class BiliError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(message: string, code = 'BILI_ERROR', retryable = true) {
    super(message)
    this.name = 'BiliError'
    this.code = code
    this.retryable = retryable
  }
}

export function sanitizeBiliCookie(cookieHeader: string | undefined | null): string {
  if (!cookieHeader) return ''
  const out: string[] = []
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (!trimmed || /[\r\n]/.test(trimmed)) continue
    const equals = trimmed.indexOf('=')
    if (equals <= 0) continue
    const name = trimmed.slice(0, equals).trim()
    if (!COOKIE_ALLOWLIST.has(name)) continue
    out.push(trimmed)
  }
  return out.join('; ')
}

export function biliHeaders(cookie = '', referer = 'https://www.bilibili.com/'): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Referer: referer,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  }
  if (cookie) headers.Cookie = cookie
  return headers
}

function mixinKey(orig: string): string {
  return MIXIN_KEY_ENC_TAB.map((index) => orig[index] ?? '').join('').slice(0, 32)
}

export function encodeWbi(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string
): string {
  const wts = Math.round(Date.now() / 1000)
  const withTime: Record<string, string | number> = { ...params, wts }
  const query = Object.keys(withTime)
    .sort()
    .map((key) => {
      const value = String(withTime[key]).replace(/[!'()*]/g, '')
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join('&')
  const wRid = crypto.createHash('md5').update(query + mixinKey(imgKey + subKey)).digest('hex')
  return `${query}&w_rid=${wRid}`
}

async function getWbiKeys(cookie: string): Promise<WbiKeys> {
  if (wbiCache && wbiCache.expiresAt > Date.now()) return wbiCache
  let response: Response
  try {
    response = await fetch(`${API_BASE}/x/web-interface/nav`, {
      headers: biliHeaders(cookie),
      signal: AbortSignal.timeout(20000)
    })
  } catch (error) {
    throw new BiliError(`连接B站失败：${(error as Error).message}`, 'BILI_NETWORK')
  }
  if (!response.ok) {
    throw new BiliError(`B站导航接口 HTTP ${response.status}`, 'BILI_HTTP', response.status >= 500)
  }
  const payload = (await response.json()) as BiliEnvelope<{
    wbi_img?: { img_url?: string; sub_url?: string }
  }>
  const imgUrl = payload.data?.wbi_img?.img_url
  const subUrl = payload.data?.wbi_img?.sub_url
  if (!imgUrl || !subUrl) {
    throw new BiliError('B站未返回 WBI 签名密钥', 'BILI_WBI')
  }
  const keyOf = (url: string): string => url.split('/').pop()?.split('.')[0] ?? ''
  wbiCache = {
    imgKey: keyOf(imgUrl),
    subKey: keyOf(subUrl),
    expiresAt: Date.now() + 15 * 60 * 1000
  }
  return wbiCache
}

export interface BiliApiOptions {
  cookie?: string
  sign?: boolean
  referer?: string
  timeoutMs?: number
}

export async function biliApi<T>(
  endpoint: string,
  params: Record<string, string | number>,
  options: BiliApiOptions = {}
): Promise<T> {
  const cookie = sanitizeBiliCookie(options.cookie)
  let query: string
  if (options.sign) {
    const keys = await getWbiKeys(cookie)
    query = encodeWbi(params, keys.imgKey, keys.subKey)
  } else {
    query = Object.keys(params)
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
      .join('&')
  }
  const url = `${API_BASE}/${endpoint.replace(/^\/+/, '')}?${query}`
  let response: Response
  try {
    response = await fetch(url, {
      headers: biliHeaders(cookie, options.referer),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30000)
    })
  } catch (error) {
    throw new BiliError(`连接B站失败：${(error as Error).message}`, 'BILI_NETWORK')
  }

  if (response.status === 412) {
    throw new BiliError(
      'B站触发了访问限制（HTTP 412）。请稍后重试，并减少连续下载。',
      'BILI_RISK_CONTROL',
      true
    )
  }
  if (!response.ok) {
    throw new BiliError(`B站接口 HTTP ${response.status}`, 'BILI_HTTP', response.status >= 500)
  }

  let payload: BiliEnvelope<T>
  try {
    payload = (await response.json()) as BiliEnvelope<T>
  } catch {
    throw new BiliError('B站返回了无法解析的响应', 'BILI_BAD_RESPONSE')
  }

  if (payload.code === 0) return payload.data

  const message = payload.message || `B站错误码 ${payload.code}`
  if (payload.code === -101) {
    throw new BiliError(
      '收藏夹需要登录才能读取。请在插件中勾选“携带登录 Cookie”后重新发送。',
      'BILI_AUTH_REQUIRED',
      false
    )
  }
  if (payload.code === -403 || payload.code === -404) {
    throw new BiliError(`B站拒绝访问：${message}`, 'BILI_ACCESS_DENIED', false)
  }
  if (payload.code === -352) {
    throw new BiliError(`B站风控拦截：${message}`, 'BILI_RISK_CONTROL', true)
  }
  if (payload.code === -400) {
    throw new BiliError(`B站请求参数错误：${message}`, 'BILI_BAD_REQUEST', false)
  }
  throw new BiliError(`B站接口错误（${payload.code}）：${message}`, 'BILI_API')
}
