import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { BiliJobFailure, BiliJobStatus, BiliJobView } from '../../shared/types'
import {
  addSongAutoCategories,
  addSongCategory,
  ensureCategory,
  findUniqueLocalMatch,
  isInsideRoot,
  normalizeArtist,
  normalizeTitle,
  pathKeyFor
} from '../core'
import { DatabaseStore, now } from '../db'
import { logError, logInfo } from '../logger'
import { fetchFavorite } from './favorite'
import { BiliError, sanitizeBiliCookie } from './http'
import { fetchAudioStream, fetchVideoInfo } from './playurl'

interface JobRow {
  id: string
  request_id: string
  media_id: string
  category_id: number | null
  title: string
  status: BiliJobStatus
  total: number
  succeeded: number
  failed: number
  skipped: number
  current_title: string
  current_phase: string
  last_error: string
  created_at: number
  started_at: number | null
  finished_at: number | null
  updated_at: number
}

interface ItemRow {
  id: number
  job_id: string
  bvid: string
  cid: number | null
  title: string
  up_name: string
  duration_ms: number
  status: string
  bytes_done: number
  bytes_total: number
  attempts: number
  output_path: string
  song_id: number | null
  skip_reason: string
  error_code: string
  error_message: string
}

interface FailureRow {
  bvid: string
  title: string
  error_code: string
  error_message: string
}

export class BiliTaskError extends Error {
  readonly code: string
  readonly httpStatus: number
  readonly activeTaskId?: string

  constructor(message: string, code: string, httpStatus = 400, activeTaskId?: string) {
    super(message)
    this.name = 'BiliTaskError'
    this.code = code
    this.httpStatus = httpStatus
    this.activeTaskId = activeTaskId
  }
}

export interface StartTaskInput {
  requestId: string
  mediaId: string
  cookieHeader?: string
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function safeFilename(value: string, maxLength: number, fallback: string): string {
  let result = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
  if (!result) result = fallback
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(result)) result = `_${result}`
  return result.slice(0, maxLength).replace(/[. ]+$/g, '') || fallback
}

function errorCode(error: unknown): string {
  if (error instanceof BiliError) return error.code
  if (error instanceof BiliTaskError) return error.code
  return 'DOWNLOAD_FAILED'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRetryableCode(code: string): boolean {
  return !['BILI_AUTH_REQUIRED', 'BILI_ACCESS_DENIED', 'DASH_AUDIO_NOT_FOUND', 'BILI_CID_NOT_FOUND'].includes(
    code
  )
}

export class BiliService {
  private readonly store: DatabaseStore
  private readonly getMusicRoot: () => string
  private readonly getBiliDownloadDir: () => string
  private readonly cookies = new Map<string, string>()
  private readonly jobControllers = new Map<string, AbortController>()
  private readonly cancelledJobs = new Set<string>()
  private stopping = false

  constructor(
    store: DatabaseStore,
    getMusicRoot: () => string,
    getBiliDownloadDir: () => string
  ) {
    this.store = store
    this.getMusicRoot = getMusicRoot
    this.getBiliDownloadDir = getBiliDownloadDir
  }

  init(): void {
    const runningJobs = this.store.all<{ id: string }>(
      "SELECT id FROM download_jobs WHERE status IN ('queued', 'running')"
    )
    if (runningJobs.length > 0) {
      this.store.run(
        `UPDATE download_jobs
         SET status = 'interrupted', current_phase = '', finished_at = ?, updated_at = ?,
             last_error = '应用上次退出时任务被中断，可在任务列表重试'
         WHERE status IN ('queued', 'running')`,
        [now(), now()]
      )
      this.store.run(
        `UPDATE download_items SET status = 'interrupted', updated_at = ?
         WHERE status IN ('queued', 'running')`,
        [now()]
      )
      this.store.save()
    }
  }

  private isCancelled(jobId: string): boolean {
    return this.cancelledJobs.has(jobId)
  }

  async cancelJob(jobId: string): Promise<void> {
    const job = this.store.get<JobRow>('SELECT * FROM download_jobs WHERE id = ?', [jobId])
    if (!job) throw new BiliTaskError('任务不存在', 'TASK_NOT_FOUND', 404)
    if (job.status !== 'queued' && job.status !== 'running') {
      throw new BiliTaskError('任务已经结束，不能取消', 'TASK_NOT_ACTIVE', 409)
    }
    this.cancelledJobs.add(jobId)
    this.jobControllers.get(jobId)?.abort()
    this.store.transaction(() => {
      this.store.run(
        `UPDATE download_items
         SET status = 'interrupted', error_code = 'TASK_CANCELED',
             error_message = '用户取消任务', updated_at = ?
         WHERE job_id = ? AND status IN ('queued', 'running')`,
        [now(), jobId]
      )
      this.updateCounts(jobId)
      this.updateJob(jobId, {
        status: 'interrupted',
        currentTitle: '',
        currentPhase: '',
        lastError: '用户已取消任务',
        finishedAt: now()
      })
    })
    this.store.save()
    logInfo(`B站任务 ${jobId} 已由用户取消`)
  }

  private requireRoot(): string {
    const root = this.getMusicRoot()
    if (!root) {
      throw new BiliTaskError('还没有选择音乐文件夹，请先完成首次设置', 'MUSIC_ROOT_REQUIRED', 409)
    }
    if (!fs.existsSync(root)) {
      throw new BiliTaskError('音乐文件夹不存在，请到设置里重新选择', 'MUSIC_ROOT_REQUIRED', 409)
    }
    return root
  }

  private requireDownloadRoot(): string {
    const dir = this.getBiliDownloadDir() || path.join(this.requireRoot(), 'Bilibili')
    if (!dir) {
      throw new BiliTaskError('B站下载文件夹不可用，请到设置里重新选择', 'BILI_DOWNLOAD_DIR_REQUIRED', 409)
    }
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
    } catch (error) {
      throw new BiliTaskError(
        `B站下载文件夹不可写：${dir}（${(error as Error).message}）`,
        'BILI_DOWNLOAD_DIR_NOT_WRITABLE',
        409
      )
    }
    return dir
  }

  async startTask(input: StartTaskInput): Promise<BiliJobView> {
    if (!/^\d{1,20}$/.test(input.mediaId)) {
      throw new BiliTaskError('收藏夹 ID 必须是数字', 'INVALID_MEDIA_ID', 422)
    }
    if (!/^[A-Za-z0-9-]{8,100}$/.test(input.requestId)) {
      throw new BiliTaskError('requestId 格式不正确', 'INVALID_REQUEST_ID', 422)
    }
    this.requireRoot()
    this.requireDownloadRoot()

    const existing = this.store.get<{ id: string }>(
      'SELECT id FROM download_jobs WHERE request_id = ?',
      [input.requestId]
    )
    if (existing) {
      return this.getJob(existing.id)
    }

    const active = this.store.get<{ id: string }>(
      `SELECT id FROM download_jobs
       WHERE media_id = ? AND status IN ('queued', 'running') LIMIT 1`,
      [input.mediaId]
    )
    if (active) {
      throw new BiliTaskError(
        '这个收藏夹已有任务正在执行',
        'TASK_RUNNING',
        409,
        active.id
      )
    }

    const id = crypto.randomUUID()
    const cookie = sanitizeBiliCookie(input.cookieHeader)
    this.cookies.set(id, cookie)
    this.store.run(
      `INSERT INTO download_jobs
        (id, request_id, media_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
      [id, input.requestId, input.mediaId, now(), now()]
    )
    this.store.save()
    logInfo(`创建B站收藏夹任务 ${id}，media_id=${input.mediaId}`)
    setImmediate(() => {
      void this.runJob(id, input.mediaId)
    })
    return this.getJob(id)
  }

  getJobs(limit = 20): BiliJobView[] {
    const jobs = this.store.all<JobRow>(
      'SELECT * FROM download_jobs ORDER BY updated_at DESC LIMIT ?',
      [limit]
    )
    return jobs.map((job) => this.toView(job))
  }

  getJob(jobId: string): BiliJobView {
    const job = this.store.get<JobRow>('SELECT * FROM download_jobs WHERE id = ?', [jobId])
    if (!job) throw new BiliTaskError('任务不存在', 'TASK_NOT_FOUND', 404)
    return this.toView(job)
  }

  private toView(job: JobRow): BiliJobView {
    const failures = this.store
      .all<FailureRow>(
        `SELECT bvid, title, error_code, error_message FROM download_items
         WHERE job_id = ? AND status = 'failed'
         ORDER BY updated_at DESC LIMIT 10`,
        [job.id]
      )
      .map(
        (row): BiliJobFailure => ({
          bvid: String(row.bvid),
          title: String(row.title),
          code: String(row.error_code || 'DOWNLOAD_FAILED'),
          message: String(row.error_message || '下载失败'),
          retryable: isRetryableCode(String(row.error_code || 'DOWNLOAD_FAILED'))
        })
      )
    const total = Number(job.total)
    const succeeded = Number(job.succeeded)
    const failed = Number(job.failed)
    const skipped = Number(job.skipped)
    return {
      id: String(job.id),
      requestId: String(job.request_id),
      mediaId: String(job.media_id),
      title: String(job.title ?? ''),
      status: job.status,
      total,
      succeeded,
      failed,
      skipped,
      pending: Math.max(0, total - succeeded - failed - skipped),
      createdAt: Number(job.created_at),
      updatedAt: Number(job.updated_at),
      lastError: String(job.last_error ?? ''),
      currentTitle: String(job.current_title ?? ''),
      currentPhase: String(job.current_phase ?? ''),
      failures
    }
  }

  private updateJob(
    jobId: string,
    fields: Partial<{
      status: BiliJobStatus
      title: string
      categoryId: number
      total: number
      currentTitle: string
      currentPhase: string
      lastError: string
      startedAt: number
      finishedAt: number | null
    }>
  ): void {
    const sets: string[] = []
    const values: Array<string | number | null> = []
    if (fields.status !== undefined) {
      sets.push('status = ?')
      values.push(fields.status)
    }
    if (fields.title !== undefined) {
      sets.push('title = ?')
      values.push(fields.title)
    }
    if (fields.categoryId !== undefined) {
      sets.push('category_id = ?')
      values.push(fields.categoryId)
    }
    if (fields.total !== undefined) {
      sets.push('total = ?')
      values.push(fields.total)
    }
    if (fields.currentTitle !== undefined) {
      sets.push('current_title = ?')
      values.push(fields.currentTitle)
    }
    if (fields.currentPhase !== undefined) {
      sets.push('current_phase = ?')
      values.push(fields.currentPhase)
    }
    if (fields.lastError !== undefined) {
      sets.push('last_error = ?')
      values.push(fields.lastError)
    }
    if (fields.startedAt !== undefined) {
      sets.push('started_at = ?')
      values.push(fields.startedAt)
    }
    if (fields.finishedAt !== undefined) {
      sets.push('finished_at = ?')
      values.push(fields.finishedAt)
    }
    sets.push('updated_at = ?')
    values.push(now())
    values.push(jobId)
    this.store.run(`UPDATE download_jobs SET ${sets.join(', ')} WHERE id = ?`, values)
  }

  private updateCounts(jobId: string): void {
    const counts = this.store.get<{
      total: number
      succeeded: number
      failed: number
      skipped: number
    }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
       FROM download_items WHERE job_id = ?`,
      [jobId]
    )
    this.store.run(
      'UPDATE download_jobs SET total = ?, succeeded = ?, failed = ?, skipped = ?, updated_at = ? WHERE id = ?',
      [
        Number(counts?.total ?? 0),
        Number(counts?.succeeded ?? 0),
        Number(counts?.failed ?? 0),
        Number(counts?.skipped ?? 0),
        now(),
        jobId
      ]
    )
  }

  private async runJob(jobId: string, mediaId: string): Promise<void> {
    if (this.isCancelled(jobId)) return
    const cookie = this.cookies.get(jobId) ?? ''
    const controller = new AbortController()
    this.jobControllers.set(jobId, controller)
    try {
      this.updateJob(jobId, {
        status: 'running',
        startedAt: now(),
        currentPhase: '读取收藏夹',
        currentTitle: '',
        lastError: '',
        finishedAt: null
      })
      this.store.save()

      const favorite = await fetchFavorite(mediaId, cookie, (page, collected) => {
        this.updateJob(jobId, {
          currentPhase: `读取收藏夹第 ${page} 页（${collected} 个视频）`
        })
      })
      if (this.stopping || this.isCancelled(jobId) || controller.signal.aborted) return
      if (favorite.items.length === 0) {
        throw new BiliTaskError('收藏夹里没有可下载的视频', 'EMPTY_FAVORITE', 422)
      }

      const musicRoot = this.requireRoot()
      const downloadRoot = this.requireDownloadRoot()
      const categoryId = this.store.transaction(() => {
        const id = ensureCategory(this.store, 'bilibili', mediaId, favorite.title)
        this.store.run(
          `INSERT INTO bili_favorites (media_id, category_id, title, page_url, last_synced_at, created_at)
           VALUES (?, ?, ?, '', ?, ?)
           ON CONFLICT(media_id) DO UPDATE SET
             category_id = excluded.category_id,
             title = excluded.title,
             last_synced_at = excluded.last_synced_at`,
          [mediaId, id, favorite.title, now(), now()]
        )
        for (const item of favorite.items) {
          this.store.run(
            `INSERT OR IGNORE INTO download_items
              (job_id, bvid, title, up_name, duration_ms, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
            [
              jobId,
              item.bvid,
              item.title,
              item.upName,
              Math.max(0, Math.round(item.durationSec * 1000)),
              now(),
              now()
            ]
          )
        }
        return id
      })

      if (this.isCancelled(jobId) || controller.signal.aborted) return
      this.updateJob(jobId, {
        title: favorite.title,
        categoryId,
        total: favorite.items.length,
        currentPhase: '准备下载',
        currentTitle: ''
      })
      this.store.save()
      await this.processQueuedItems(jobId, musicRoot, downloadRoot, cookie, controller.signal)
    } catch (error) {
      logError(`B站任务 ${jobId} 失败`, error)
      if (this.stopping || this.isCancelled(jobId)) return
      this.store.run(
        `UPDATE download_items
         SET status = 'interrupted', error_code = 'JOB_FAILED', error_message = ?, updated_at = ?
         WHERE job_id = ? AND status IN ('queued', 'running')`,
        [errorMessage(error), now(), jobId]
      )
      this.updateCounts(jobId)
      this.updateJob(jobId, {
        status: 'failed',
        currentPhase: '',
        currentTitle: '',
        lastError: errorMessage(error),
        finishedAt: now()
      })
      this.store.save()
    } finally {
      this.jobControllers.delete(jobId)
      this.cancelledJobs.delete(jobId)
    }
  }

  private async processQueuedItems(
    jobId: string,
    musicRoot: string,
    downloadRoot: string,
    cookie: string,
    signal: AbortSignal
  ): Promise<void> {
    const job = this.store.get<JobRow>('SELECT * FROM download_jobs WHERE id = ?', [jobId])
    if (!job) throw new BiliTaskError('任务不存在', 'TASK_NOT_FOUND', 404)
    if (job.category_id == null) {
      throw new BiliTaskError('任务还未绑定分类，请重新发送收藏夹', 'CATEGORY_MISSING', 422)
    }
    const items = this.store.all<ItemRow>(
      `SELECT * FROM download_items WHERE job_id = ? AND status = 'queued' ORDER BY id ASC`,
      [jobId]
    )

    for (const item of items) {
      if (this.stopping || this.isCancelled(jobId) || signal.aborted) return
      await this.processItem(
        jobId,
        Number(job.category_id),
        String(job.title),
        musicRoot,
        downloadRoot,
        cookie,
        item,
        signal
      )
      this.updateCounts(jobId)
      this.store.save()
    }

    if (this.stopping || this.isCancelled(jobId) || signal.aborted) return
    this.updateCounts(jobId)
    const updated = this.store.get<JobRow>('SELECT * FROM download_jobs WHERE id = ?', [jobId])
    if (!updated) return
    const failed = Number(updated.failed)
    const total = Number(updated.total)
    this.updateJob(jobId, {
      status: total === 0 ? 'failed' : failed > 0 ? 'partial' : 'completed',
      currentTitle: '',
      currentPhase: '',
      finishedAt: now(),
      lastError: failed > 0 ? `${failed} 个视频下载失败，可在任务列表重试` : ''
    })
    if (failed === 0) this.cookies.delete(jobId)
    this.store.save()
    logInfo(`B站任务 ${jobId} 结束，total=${updated.total}, ok=${updated.succeeded}, failed=${updated.failed}`)
  }

  private async processItem(
    jobId: string,
    categoryId: number,
    favoriteTitle: string,
    musicRoot: string,
    downloadRoot: string,
    cookie: string,
    item: ItemRow,
    signal: AbortSignal
  ): Promise<void> {
    if (this.isCancelled(jobId) || signal.aborted) return
    const itemId = Number(item.id)
    const bvid = String(item.bvid)
    this.store.run(
      `UPDATE download_items SET status = 'running', attempts = attempts + 1,
         bytes_done = 0, error_code = '', error_message = '', updated_at = ? WHERE id = ?`,
      [now(), itemId]
    )
    this.updateJob(jobId, {
      currentTitle: String(item.title),
      currentPhase: '检查本地文件'
    })
    this.store.save()

    try {
      const existing = this.store.get<{
        id: number
        path: string
        available: number
      }>('SELECT id, path, available FROM songs WHERE bvid = ? LIMIT 1', [bvid])
      if (existing && Number(existing.available) === 1 && fs.existsSync(String(existing.path))) {
        this.linkExistingSong(categoryId, itemId, Number(existing.id))
        return
      }

      const localMatch = findUniqueLocalMatch(
        this.store,
        String(item.title),
        String(item.up_name),
        Number(item.duration_ms)
      )
      if (localMatch) {
        this.linkExistingSong(categoryId, itemId, Number(localMatch.id))
        this.store.run(
          'UPDATE download_items SET skip_reason = ? WHERE id = ?',
          ['本地已有标题+UP主+时长匹配的文件', itemId]
        )
        this.store.save()
        return
      }

      if (this.isCancelled(jobId) || signal.aborted) return
      this.updateJob(jobId, { currentPhase: '读取视频信息' })
      const info = await fetchVideoInfo(bvid, cookie)
      if (this.isCancelled(jobId) || signal.aborted) return
      this.store.run('UPDATE download_items SET cid = ? WHERE id = ?', [info.cid, itemId])
      const durationMs =
        Number(item.duration_ms) > 0
          ? Number(item.duration_ms)
          : Math.round(info.durationSec * 1000)

      this.updateJob(jobId, { currentPhase: '获取音频流' })
      const stream = await fetchAudioStream(bvid, info.cid, cookie)
      if (this.isCancelled(jobId) || signal.aborted) return
      const ext = /mpeg/i.test(stream.mimeType) ? '.mp3' : '.m4a'
      const outputPath = await this.allocateOutputPath(
        downloadRoot,
        favoriteTitle,
        String(item.title),
        bvid,
        ext
      )
      this.updateJob(jobId, { currentPhase: '下载音频' })
      const bytes = await this.downloadAudio(
        stream.urls,
        outputPath,
        bvid,
        itemId,
        stream.bandwidth,
        signal
      )
      if (this.isCancelled(jobId) || signal.aborted) {
        await fsp.rm(outputPath, { force: true }).catch(() => undefined)
        return
      }

      const songId = this.store.transaction(() => {
        const song = this.upsertBiliSong({
          bvid,
          title: String(item.title),
          upName: String(item.up_name),
          album: favoriteTitle,
          durationMs,
          outputPath,
          ext
        })
        addSongCategory(this.store, categoryId, song, 'bilibili')
        if (isInsideRoot(musicRoot, outputPath)) {
          addSongAutoCategories(this.store, song, musicRoot, outputPath, '')
        }
        return song
      })

      this.store.run(
        `UPDATE download_items
         SET status = 'success', output_path = ?, song_id = ?, bytes_done = ?, bytes_total = ?,
             error_code = '', error_message = '', updated_at = ?
         WHERE id = ?`,
        [outputPath, songId, bytes, bytes, now(), itemId]
      )
      this.store.save()
    } catch (error) {
      if (this.isCancelled(jobId) || signal.aborted) {
        this.store.run(
          `UPDATE download_items
           SET status = 'interrupted', error_code = 'TASK_CANCELED',
               error_message = '用户取消任务', updated_at = ?
           WHERE id = ?`,
          [now(), itemId]
        )
        this.store.save()
        return
      }
      logError(`下载B站视频 ${bvid} 失败`, error)
      this.store.run(
        `UPDATE download_items
         SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
         WHERE id = ?`,
        [errorCode(error), errorMessage(error).slice(0, 1000), now(), itemId]
      )
      this.store.save()
    }
  }

  private linkExistingSong(categoryId: number, itemId: number, songId: number): void {
    addSongCategory(this.store, categoryId, songId, 'bilibili')
    this.store.run(
      `UPDATE download_items
       SET status = 'skipped', song_id = ?, skip_reason = '已存在，已加入B站分类',
           error_code = '', error_message = '', updated_at = ?
       WHERE id = ?`,
      [songId, now(), itemId]
    )
    this.store.save()
  }

  private upsertBiliSong(input: {
    bvid: string
    title: string
    upName: string
    album: string
    durationMs: number
    outputPath: string
    ext: string
  }): number {
    const artist = input.upName.trim() || '未知歌手'
    const existing = this.store.get<{ id: number }>(
      'SELECT id FROM songs WHERE bvid = ? LIMIT 1',
      [input.bvid]
    )
    if (existing) {
      const id = Number(existing.id)
      this.store.run(
        `UPDATE songs
         SET path = ?, path_key = ?, title = ?, title_norm = ?, artist = ?, artist_norm = ?,
             album = ?, duration_ms = ?, ext = ?, source = 'bilibili', up_name = ?,
             metadata_locked = 1, available = 1, updated_at = ?
         WHERE id = ?`,
        [
          input.outputPath,
          pathKeyFor(input.outputPath),
          input.title,
          normalizeTitle(input.title),
          artist,
          normalizeArtist(artist),
          input.album,
          Math.max(0, Math.round(input.durationMs)),
          input.ext,
          input.upName,
          now(),
          id
        ]
      )
      return id
    }
    this.store.run(
      `INSERT INTO songs
        (path, path_key, title, title_norm, artist, artist_norm, album, duration_ms, genre, ext,
         source, bvid, up_name, metadata_locked, available, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, 'bilibili', ?, ?, 1, 1, ?, ?)`,
      [
        input.outputPath,
        pathKeyFor(input.outputPath),
        input.title,
        normalizeTitle(input.title),
        artist,
        normalizeArtist(artist),
        input.album,
        Math.max(0, Math.round(input.durationMs)),
        input.ext,
        input.bvid,
        input.upName,
        now(),
        now()
      ]
    )
    return this.store.lastInsertId()
  }

  private async allocateOutputPath(
    downloadRoot: string,
    favoriteTitle: string,
    title: string,
    bvid: string,
    ext: string
  ): Promise<string> {
    const folder = safeFilename(favoriteTitle, 60, 'B站收藏夹')
    const dir = path.join(downloadRoot, folder)
    await fsp.mkdir(dir, { recursive: true })
    const base = safeFilename(title, 80, bvid)
    let suffix = 0
    while (suffix < 100) {
      const fileName = `${base} [${bvid}]${suffix === 0 ? '' : ` (${suffix + 1})`}${ext}`
      const candidate = path.join(dir, fileName)
      const row = this.store.get<{ id: number }>('SELECT id FROM songs WHERE path = ?', [candidate])
      if (!row && !fs.existsSync(candidate)) return candidate
      suffix += 1
    }
    return path.join(dir, `${bvid}-${Date.now()}${ext}`)
  }

  private async downloadAudio(
    urls: string[],
    outputPath: string,
    bvid: string,
    itemId: number,
    bandwidth: number,
    signal: AbortSignal
  ): Promise<number> {
    const partPath = `${outputPath}.part`
    let lastError: unknown = null
    for (const url of urls) {
      if (this.stopping || signal.aborted) throw new Error('任务已取消')
      try {
        await fsp.rm(partPath, { force: true })
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000)
        const abortExternal = (): void => controller.abort()
        signal.addEventListener('abort', abortExternal, { once: true })
        if (signal.aborted) controller.abort()
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              'User-Agent': USER_AGENT,
              Referer: `https://www.bilibili.com/video/${bvid}`,
              Accept: '*/*'
            }
          })
          if (!response.ok || !response.body) {
            throw new Error(`音频 CDN 返回 HTTP ${response.status}`)
          }
          const total = Number(response.headers.get('content-length') ?? 0)
          let done = 0
          let lastUpdate = 0
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              done += chunk.length
              const stamp = Date.now()
              if (stamp - lastUpdate > 350) {
                lastUpdate = stamp
                serviceStoreProgress(itemId, done, total, bandwidth)
              }
              callback(null, chunk)
            }
          })
          const serviceStoreProgress = (
            id: number,
            bytes: number,
            bytesTotal: number,
            _bandwidth: number
          ): void => {
            this.store.run(
              'UPDATE download_items SET bytes_done = ?, bytes_total = ?, updated_at = ? WHERE id = ?',
              [bytes, bytesTotal, now(), id]
            )
          }
          await pipeline(
            Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
            counter,
            fs.createWriteStream(partPath)
          )
          if (signal.aborted) throw new Error('任务已取消')
          if (done < 256) throw new Error('下载到的音频文件为空或过小')
          await fsp.rename(partPath, outputPath)
          serviceStoreProgress(itemId, done, total || done, bandwidth)
          return done
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abortExternal)
        }
      } catch (error) {
        lastError = error
        await fsp.rm(partPath, { force: true }).catch(() => undefined)
        if (this.stopping || signal.aborted) throw error
      }
    }
    throw new BiliError(
      `音频下载失败：${errorMessage(lastError)}`,
      'AUDIO_DOWNLOAD_FAILED',
      true
    )
  }

  async retryJob(jobId: string): Promise<void> {
    this.requireRoot()
    this.requireDownloadRoot()
    const job = this.store.get<JobRow>('SELECT * FROM download_jobs WHERE id = ?', [jobId])
    if (!job) throw new BiliTaskError('任务不存在', 'TASK_NOT_FOUND', 404)
    if (job.status === 'queued' || job.status === 'running') {
      throw new BiliTaskError('任务正在执行，不能重复重试', 'TASK_RUNNING', 409)
    }
    const failedCount = this.store.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM download_items
       WHERE job_id = ? AND status IN ('failed', 'interrupted')`,
      [jobId]
    )
    if (Number(failedCount?.count ?? 0) === 0) {
      throw new BiliTaskError('没有失败条目需要重试', 'NOTHING_TO_RETRY', 409)
    }
    if (job.category_id == null || !job.title) {
      throw new BiliTaskError(
        '这个任务在读取收藏夹阶段就失败了，请在插件里重新发送收藏夹',
        'TASK_NOT_RETRYABLE',
        409
      )
    }
    const musicRoot = this.requireRoot()
    const downloadRoot = this.requireDownloadRoot()
    this.store.transaction(() => {
      this.store.run(
        `UPDATE download_items
         SET status = 'queued', error_code = '', error_message = '', bytes_done = 0, updated_at = ?
         WHERE job_id = ? AND status IN ('failed', 'interrupted')`,
        [now(), jobId]
      )
      this.updateCounts(jobId)
      this.updateJob(jobId, {
        status: 'running',
        currentTitle: '',
        currentPhase: '准备重试',
        lastError: '',
        finishedAt: null
      })
    })
    this.store.save()
    const cookie = this.cookies.get(jobId) ?? ''
    const controller = new AbortController()
    this.jobControllers.set(jobId, controller)
    setImmediate(() => {
      void this.processQueuedItems(jobId, musicRoot, downloadRoot, cookie, controller.signal)
        .catch((error: unknown) => {
          if (this.stopping || this.isCancelled(jobId)) return
          logError(`重试B站任务 ${jobId} 失败`, error)
          this.store.run(
            `UPDATE download_items SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
             WHERE job_id = ? AND status IN ('queued', 'running')`,
            [errorCode(error), errorMessage(error).slice(0, 1000), now(), jobId]
          )
          this.updateCounts(jobId)
          this.updateJob(jobId, {
            status: 'failed',
            currentPhase: '',
            lastError: errorMessage(error),
            finishedAt: now()
          })
          this.store.save()
        })
        .finally(() => {
          this.jobControllers.delete(jobId)
          this.cancelledJobs.delete(jobId)
        })
    })
  }

  shutdown(): void {
    this.stopping = true
    for (const controller of this.jobControllers.values()) controller.abort()
    this.jobControllers.clear()
    this.store.run(
      `UPDATE download_jobs
       SET status = 'interrupted', current_phase = '', updated_at = ?, finished_at = ?,
           last_error = '应用退出时任务被中断，可在任务列表重试'
       WHERE status IN ('queued', 'running')`,
      [now(), now()]
    )
    this.store.run(
      `UPDATE download_items SET status = 'interrupted', updated_at = ?
       WHERE status IN ('queued', 'running')`,
      [now()]
    )
    this.cookies.clear()
    this.store.save()
  }
}
