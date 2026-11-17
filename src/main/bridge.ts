import { app } from 'electron'
import crypto from 'node:crypto'
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { BridgeStatus } from '../shared/types'
import { BRIDGE_PROTOCOL_VERSION } from '../shared/types'
import { BiliService, BiliTaskError } from './bili/service'
import { logError, logInfo } from './logger'

const MAX_BODY_BYTES = 64 * 1024

interface BridgeOptions {
  port: number
  getToken: () => string | null
  tokenConfigured: () => boolean
}

interface TaskBody {
  protocolVersion?: number
  requestId?: string
  type?: string
  payload?: { mediaId?: string }
  credentials?: { mode?: string; cookieHeader?: string }
}

function isExtensionOrigin(origin: string): boolean {
  return origin.startsWith('chrome-extension://')
}

function setCors(res: ServerResponse, origin: string | undefined): void {
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Max-Age', '600')
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  origin?: string
): void {
  setCors(res, origin)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(JSON.stringify(body))
}

function errorBody(code: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: false, error: { code, message, ...extra } }
}

function timingSafeTokenEquals(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

async function readBody(req: IncomingMessage): Promise<TaskBody> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('请求体必须是 JSON 对象')
    }
    return parsed as TaskBody
  } catch (error) {
    throw new Error(`JSON 解析失败：${(error as Error).message}`)
  }
}

export class BridgeServer {
  private readonly storeService: BiliService
  private readonly options: BridgeOptions
  private server: Server | null = null
  private status: BridgeStatus
  private starting: Promise<BridgeStatus> | null = null

  constructor(biliService: BiliService, options: BridgeOptions) {
    this.storeService = biliService
    this.options = options
    this.status = {
      running: false,
      port: options.port,
      tokenConfigured: options.tokenConfigured(),
      error: null
    }
  }

  getStatus(): BridgeStatus {
    return {
      ...this.status,
      port: this.options.port,
      tokenConfigured: this.options.tokenConfigured()
    }
  }

  async start(): Promise<BridgeStatus> {
    if (this.server && this.status.running) return this.getStatus()
    if (this.starting) return this.starting
    this.starting = new Promise<BridgeStatus>((resolve) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res)
      })
      this.server = server
      server.on('error', (error) => {
        this.status = {
          running: false,
          port: this.options.port,
          tokenConfigured: this.options.tokenConfigured(),
          error: error.message
        }
        logError('Bridge 服务启动失败', error)
        resolve(this.getStatus())
      })
      server.listen(this.options.port, '127.0.0.1', () => {
        this.status = {
          running: true,
          port: this.options.port,
          tokenConfigured: this.options.tokenConfigured(),
          error: null
        }
        logInfo(`Bridge 正在监听 127.0.0.1:${this.options.port}`)
        resolve(this.getStatus())
      })
    }).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.status = {
      running: false,
      port: this.options.port,
      tokenConfigured: this.options.tokenConfigured(),
      error: null
    }
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      setTimeout(() => resolve(), 2000)
    })
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    if (origin && !isExtensionOrigin(origin)) {
      sendJson(res, 403, errorBody('ORIGIN_FORBIDDEN', '只接受浏览器扩展页面访问本地 Bridge'))
      return
    }

    const host = String(req.headers.host ?? '')
    if (!host.startsWith(`127.0.0.1:${this.options.port}`)) {
      sendJson(res, 403, errorBody('HOST_FORBIDDEN', 'Host 不合法'), origin)
      return
    }

    if (req.method === 'OPTIONS') {
      setCors(res, origin)
      res.statusCode = 204
      res.end()
      return
    }

    const token = this.options.getToken()
    if (!token) {
      sendJson(
        res,
        401,
        errorBody('TOKEN_NOT_CONFIGURED', '本地软件尚未生成配对 token，请到设置页生成'),
        origin
      )
      return
    }
    const authorization = String(req.headers.authorization ?? '')
    const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!provided || !timingSafeTokenEquals(token, provided)) {
      sendJson(res, 401, errorBody('UNAUTHORIZED', '配对 token 缺失或错误'), origin)
      return
    }

    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.options.port}`)
      if (req.method === 'GET' && url.pathname === '/ping') {
        sendJson(
          res,
          200,
          {
            ok: true,
            app: 'DSM',
            appVersion: app.getVersion(),
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
            capabilities: ['bilibili.favorite'],
            port: this.options.port
          },
          origin
        )
        return
      }

      if (req.method === 'POST' && url.pathname === '/task') {
        const body = await readBody(req)
        if (body.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
          sendJson(
            res,
            422,
            errorBody('PROTOCOL_VERSION_UNSUPPORTED', '插件与本地软件的协议版本不一致'),
            origin
          )
          return
        }
        if (body.type !== 'bilibili.favorite') {
          sendJson(res, 422, errorBody('INVALID_TASK_TYPE', '不支持的任务类型'), origin)
          return
        }
        const requestId = String(body.requestId ?? '').trim()
        const mediaId = String(body.payload?.mediaId ?? '').trim()
        const mode = body.credentials?.mode ?? 'none'
        const cookieHeader =
          mode === 'browserCookie' ? String(body.credentials?.cookieHeader ?? '') : ''
        if (!requestId || !mediaId) {
          sendJson(res, 422, errorBody('INVALID_TASK', '缺少 requestId 或 mediaId'), origin)
          return
        }
        const job = await this.storeService.startTask({ requestId, mediaId, cookieHeader })
        sendJson(res, 202, { ok: true, taskId: job.id, status: job.status }, origin)
        return
      }

      if (req.method === 'GET' && url.pathname === '/progress') {
        const taskId = String(url.searchParams.get('taskId') ?? '')
        if (!taskId) {
          sendJson(res, 422, errorBody('TASK_ID_REQUIRED', '缺少 taskId'), origin)
          return
        }
        const job = this.storeService.getJob(taskId)
        sendJson(
          res,
          200,
          {
            ok: true,
            ...job,
            current: {
              title: job.currentTitle,
              phase: job.currentPhase
            }
          },
          origin
        )
        return
      }

      sendJson(res, 404, errorBody('NOT_FOUND', '接口不存在'), origin)
    } catch (error) {
      if (error instanceof BiliTaskError) {
        sendJson(
          res,
          error.httpStatus,
          errorBody(error.code, error.message, error.activeTaskId ? { activeTaskId: error.activeTaskId } : {}),
          origin
        )
        return
      }
      logError('Bridge 请求处理失败', error)
      sendJson(
        res,
        500,
        errorBody('INTERNAL_ERROR', error instanceof Error ? error.message : '本地软件内部错误'),
        origin
      )
    }
  }
}
