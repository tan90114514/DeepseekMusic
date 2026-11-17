import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  BiliJobStatus,
  BiliJobView,
  CategoryKind,
  CategoryView,
  ExportResult,
  LocalImportResult,
  MatchStatus,
  PlaylistItemView,
  PlaylistSummary,
  ScanProgress,
  ScanResult,
  SongView
} from '../shared/types'
import { DatabaseStore, now } from './db'
import { logError } from './logger'

export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.opus',
  '.wav',
  '.webm'
])

interface SongRow {
  id: number
  path: string
  path_key: string
  title: string
  title_norm: string
  artist: string
  artist_norm: string
  album: string
  duration_ms: number
  genre: string
  ext: string
  source: string
  bvid: string | null
  up_name: string
  metadata_locked: number
  available: number
}

interface PlaylistItemRow {
  id: number
  playlist_id: number
  position: number
  title: string
  title_norm: string
  artist: string
  artist_norm: string
  album: string
  duration_ms: number
  path_hint: string
  path_key: string
  match_status: MatchStatus
  match_method: string | null
  match_score: number
  matched_song_id: number | null
  match_note: string
  song_path?: string | null
  song_available?: number | null
}

export interface MatchDecision {
  status: MatchStatus
  method: string | null
  score: number
  songId: number | null
  note: string
}

export function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeTitle(value: unknown): string {
  return normalizeText(value)
}

function looseTitle(value: unknown): string {
  return normalizeText(value)
    .replace(/[（(\[【][^）)\]】]*[）)\]】]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

export function normalizeArtist(value: unknown): string {
  const parts = normalizeText(value)
    .replace(/[、，,;；&＆]/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  return [...new Set(parts)].sort().join('/')
}

export function pathKeyFor(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase()
}

export function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function titleFromFilename(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)).trim() || '未命名歌曲'
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--:--'
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

export function ensureCategory(
  store: DatabaseStore,
  kind: CategoryKind,
  sourceKey: string,
  name: string
): number {
  const key = normalizeText(sourceKey)
  const existing = store.get<{ id: number }>(
    'SELECT id FROM categories WHERE kind = ? AND source_key = ?',
    [kind, key]
  )
  if (existing) {
    store.run('UPDATE categories SET name = ?, updated_at = ? WHERE id = ?', [
      name,
      now(),
      existing.id
    ])
    return existing.id
  }
  store.run(
    'INSERT INTO categories (name, kind, source_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [name, kind, key, now(), now()]
  )
  return store.lastInsertId()
}

export function addSongCategory(
  store: DatabaseStore,
  categoryId: number,
  songId: number,
  origin: 'auto' | 'manual' | 'bilibili'
): void {
  store.run(
    `INSERT OR IGNORE INTO song_categories (category_id, song_id, origin, added_at)
     VALUES (?, ?, ?, ?)`,
    [categoryId, songId, origin, now()]
  )
}

export function folderNameForPath(root: string, filePath: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(filePath))
  const parts = rel.split(path.sep).filter(Boolean)
  return parts.length > 1 ? parts[0] : '根目录'
}

export function splitGenres(raw: string): string[] {
  return [...new Set(
    raw
      .split(/[;；/、]/)
      .map((part) => part.trim())
      .filter(Boolean)
  )].slice(0, 8)
}

export function addSongAutoCategories(
  store: DatabaseStore,
  songId: number,
  root: string,
  songPath: string,
  genre: string
): void {
  store.run("DELETE FROM song_categories WHERE song_id = ? AND origin = 'auto'", [songId])
  const folderName = folderNameForPath(root, songPath)
  const folderId = ensureCategory(store, 'folder', folderName, folderName)
  addSongCategory(store, folderId, songId, 'auto')
  for (const genreName of splitGenres(genre)) {
    const genreId = ensureCategory(store, 'genre', genreName, genreName)
    addSongCategory(store, genreId, songId, 'auto')
  }
}

export function listCategories(store: DatabaseStore): CategoryView[] {
  const rows = store.all<{
    id: number
    name: string
    kind: CategoryKind
    song_count: number
  }>(
    `SELECT c.id, c.name, c.kind, COUNT(DISTINCT s.id) AS song_count
     FROM categories c
     LEFT JOIN song_categories sc ON sc.category_id = c.id
     LEFT JOIN songs s ON s.id = sc.song_id AND s.available = 1
     GROUP BY c.id
     HAVING song_count > 0 OR c.kind IN ('tag', 'bilibili')
     ORDER BY CASE c.kind
       WHEN 'folder' THEN 1 WHEN 'genre' THEN 2 WHEN 'tag' THEN 3 ELSE 4 END,
       c.name COLLATE NOCASE`
  )
  return rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    kind: row.kind,
    songCount: Number(row.song_count)
  }))
}

export function listPlaylists(store: DatabaseStore): PlaylistSummary[] {
  return store
    .all<{
      id: number
      name: string
      format: string
      total: number
      matched: number
      missing: number
      suspicious: number
      created_at: number
    }>(
      `SELECT p.id, p.name, p.format, p.created_at,
              COUNT(pi.id) AS total,
              SUM(CASE WHEN pi.match_status = 'matched' THEN 1 ELSE 0 END) AS matched,
              SUM(CASE WHEN pi.match_status = 'missing' THEN 1 ELSE 0 END) AS missing,
              SUM(CASE WHEN pi.match_status = 'suspicious' THEN 1 ELSE 0 END) AS suspicious
       FROM playlists p
       LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
       GROUP BY p.id
       ORDER BY p.created_at DESC`
    )
    .map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      format: String(row.format),
      total: Number(row.total ?? 0),
      matched: Number(row.matched ?? 0),
      missing: Number(row.missing ?? 0),
      suspicious: Number(row.suspicious ?? 0),
      createdAt: Number(row.created_at)
    }))
}

function normalizePlaylistName(rawName: string): string {
  const name = rawName.normalize('NFKC').trim().slice(0, 80)
  if (!name) throw new Error('歌单名不能为空')
  return name
}

function getPlaylistSummary(store: DatabaseStore, playlistId: number): PlaylistSummary {
  const playlist = listPlaylists(store).find((item) => item.id === playlistId)
  if (!playlist) throw new Error('歌单不存在')
  return playlist
}

export function createPlaylist(store: DatabaseStore, rawName: string): PlaylistSummary {
  const name = normalizePlaylistName(rawName)
  store.run(
    `INSERT INTO playlists (name, format, source_path, created_at, updated_at)
     VALUES (?, 'manual', '', ?, ?)`,
    [name, now(), now()]
  )
  const id = store.lastInsertId()
  store.save()
  return getPlaylistSummary(store, id)
}

export function renamePlaylist(store: DatabaseStore, playlistId: number, rawName: string): void {
  const name = normalizePlaylistName(rawName)
  if (!store.get('SELECT id FROM playlists WHERE id = ?', [playlistId])) {
    throw new Error('歌单不存在')
  }
  store.run('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?', [name, now(), playlistId])
  store.save()
}

export function deletePlaylist(store: DatabaseStore, playlistId: number): void {
  if (!store.get('SELECT id FROM playlists WHERE id = ?', [playlistId])) {
    throw new Error('歌单不存在')
  }
  store.run('DELETE FROM playlists WHERE id = ?', [playlistId])
  store.save()
}

export function addSongsToPlaylist(
  store: DatabaseStore,
  playlistId: number,
  rawSongIds: number[]
): { added: number; skipped: number } {
  if (!store.get('SELECT id FROM playlists WHERE id = ?', [playlistId])) {
    throw new Error('歌单不存在')
  }
  const songIds = [
    ...new Set(
      rawSongIds
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  ]
  if (songIds.length === 0) throw new Error('没有选择歌曲')
  const positionRow = store.get<{ max_position: number }>(
    'SELECT COALESCE(MAX(position), 0) AS max_position FROM playlist_items WHERE playlist_id = ?',
    [playlistId]
  )
  let position = Number(positionRow?.max_position ?? 0)
  let added = 0
  let skipped = 0
  store.transaction(() => {
    for (const songId of songIds) {
      const song = store.get<SongRow>(
        `SELECT * FROM songs WHERE id = ? AND available = 1`,
        [songId]
      )
      if (!song) {
        skipped += 1
        continue
      }
      const existing = store.get<{ id: number }>(
        'SELECT id FROM playlist_items WHERE playlist_id = ? AND matched_song_id = ?',
        [playlistId, songId]
      )
      if (existing) {
        skipped += 1
        continue
      }
      position += 1
      store.run(
        `INSERT INTO playlist_items
           (playlist_id, position, title, title_norm, artist, artist_norm, album,
            duration_ms, path_hint, path_key, match_status, match_method, match_score,
            matched_song_id, match_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'matched', 'manual', 1, ?, '手动加入', ?, ?)`,
        [
          playlistId,
          position,
          String(song.title),
          normalizeTitle(String(song.title)),
          String(song.artist ?? ''),
          normalizeArtist(String(song.artist ?? '')),
          String(song.album ?? ''),
          Number(song.duration_ms ?? 0),
          String(song.path),
          pathKeyFor(String(song.path)),
          songId,
          now(),
          now()
        ]
      )
      added += 1
    }
  })
  store.save()
  return { added, skipped }
}

export function removePlaylistItems(
  store: DatabaseStore,
  playlistId: number,
  rawItemIds: number[]
): { removed: number } {
  if (!store.get('SELECT id FROM playlists WHERE id = ?', [playlistId])) {
    throw new Error('歌单不存在')
  }
  const itemIds = [
    ...new Set(
      rawItemIds
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  ]
  if (itemIds.length === 0) return { removed: 0 }
  const placeholders = itemIds.map(() => '?').join(',')
  const existing = store.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM playlist_items
     WHERE playlist_id = ? AND id IN (${placeholders})`,
    [playlistId, ...itemIds]
  )
  store.run(
    `DELETE FROM playlist_items WHERE playlist_id = ? AND id IN (${placeholders})`,
    [playlistId, ...itemIds]
  )
  store.save()
  return { removed: Number(existing?.count ?? 0) }
}

export function getPlaylistItems(store: DatabaseStore, playlistId: number): PlaylistItemView[] {
  const rows = store.all<PlaylistItemRow>(
    `SELECT pi.*, s.path AS song_path, s.available AS song_available
     FROM playlist_items pi
     LEFT JOIN songs s ON s.id = pi.matched_song_id
     WHERE pi.playlist_id = ?
     ORDER BY pi.position ASC`,
    [playlistId]
  )
  return rows.map((row) => ({
    id: Number(row.id),
    position: Number(row.position),
    title: String(row.title),
    artist: String(row.artist ?? ''),
    album: String(row.album ?? ''),
    durationMs: Number(row.duration_ms ?? 0),
    status: row.match_status,
    matchMethod: row.match_method ?? null,
    note: String(row.match_note ?? ''),
    songId: row.matched_song_id == null ? null : Number(row.matched_song_id),
    path: String(row.song_path ?? row.path_hint ?? ''),
    available: Boolean(row.song_available)
  }))
}

function mapSongRow(row: SongRow): SongView {
  return {
    id: Number(row.id),
    title: String(row.title),
    artist: String(row.artist ?? ''),
    album: String(row.album ?? ''),
    durationMs: Number(row.duration_ms ?? 0),
    genre: String(row.genre ?? ''),
    path: String(row.path),
    source: String(row.source),
    bvid: row.bvid == null ? null : String(row.bvid),
    available: Boolean(row.available)
  }
}

export function getCategorySongs(store: DatabaseStore, categoryId: number): SongView[] {
  return store
    .all<SongRow>(
      `SELECT DISTINCT s.*
       FROM songs s
       JOIN song_categories sc ON sc.song_id = s.id
       WHERE sc.category_id = ? AND s.available = 1
       ORDER BY s.title COLLATE NOCASE, s.artist COLLATE NOCASE`,
      [categoryId]
    )
    .map(mapSongRow)
}

export function getSongsByCategories(store: DatabaseStore, categoryIds: number[]): SongView[] {
  const ids = [...new Set(categoryIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  return store
    .all<SongRow>(
      `SELECT DISTINCT s.*
       FROM songs s
       JOIN song_categories sc ON sc.song_id = s.id
       WHERE sc.category_id IN (${placeholders}) AND s.available = 1
       ORDER BY s.title COLLATE NOCASE, s.artist COLLATE NOCASE`,
      ids
    )
    .map(mapSongRow)
}

export function getAllSongs(store: DatabaseStore): SongView[] {
  return store
    .all<SongRow>(
      `SELECT * FROM songs WHERE available = 1
       ORDER BY title COLLATE NOCASE, artist COLLATE NOCASE`
    )
    .map(mapSongRow)
}

export function getSongBiliCategory(store: DatabaseStore, songId: number): number | null {
  if (!Number.isInteger(songId) || songId <= 0) throw new Error('歌曲 ID 不合法')
  const row = store.get<{ category_id: number }>(
    `SELECT sc.category_id
     FROM song_categories sc
     JOIN categories c ON c.id = sc.category_id
     WHERE sc.song_id = ? AND c.kind = 'bilibili'
     ORDER BY sc.added_at DESC
     LIMIT 1`,
    [songId]
  )
  return row ? Number(row.category_id) : null
}

function setSongCategoryForKind(
  store: DatabaseStore,
  songId: number,
  categoryId: number | null,
  kind: CategoryKind
): void {
  if (!Number.isInteger(songId) || songId <= 0) throw new Error('歌曲 ID 不合法')
  if (!store.get('SELECT id FROM songs WHERE id = ?', [songId])) {
    throw new Error('歌曲不存在')
  }
  let targetId: number | null = null
  if (categoryId != null) {
    if (!Number.isInteger(categoryId) || categoryId <= 0) throw new Error('分类 ID 不合法')
    const category = store.get<{ kind: string }>('SELECT kind FROM categories WHERE id = ?', [
      categoryId
    ])
    if (!category) throw new Error('分类不存在')
    if (category.kind !== kind) throw new Error(`分类类型不是 ${kind}`)
    targetId = categoryId
  }
  store.transaction(() => {
    store.run(
      `DELETE FROM song_categories
       WHERE song_id = ?
         AND category_id IN (SELECT id FROM categories WHERE kind = ?)`,
      [songId, kind]
    )
    if (targetId != null) addSongCategory(store, targetId, songId, 'manual')
  })
}

export function setSongBiliCategory(
  store: DatabaseStore,
  songId: number,
  categoryId: number | null
): void {
  setSongCategoryForKind(store, songId, categoryId, 'bilibili')
}

export function createBiliCategory(store: DatabaseStore, rawName: string): number {
  const name = String(rawName ?? '').trim()
  if (!name) throw new Error('分类名称不能为空')
  return ensureCategory(store, 'bilibili', `manual:${normalizeText(name)}`, name)
}

function safeImportSegment(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80)
  return cleaned || fallback
}

async function parseLocalAudio(filePath: string): Promise<{
  title: string
  artist: string
  album: string
  durationMs: number
  genre: string
}> {
  try {
    const mm = await import('music-metadata')
    const metadata = await mm.parseFile(filePath, { duration: true, skipCovers: true })
    const genres = metadata.common.genre?.filter(Boolean) ?? []
    return {
      title: metadata.common.title?.trim() || titleFromFilename(filePath),
      artist:
        metadata.common.artist?.trim() ||
        metadata.common.artists?.filter(Boolean).join(' / ') ||
        '',
      album: metadata.common.album?.trim() || '',
      durationMs: Math.round((metadata.format.duration ?? 0) * 1000),
      genre: genres.join(' / ')
    }
  } catch {
    return fileMetadataFallback(filePath)
  }
}

export async function importLocalFilesToCategory(
  store: DatabaseStore,
  root: string,
  categoryId: number,
  categoryKind: CategoryKind,
  folderName: string,
  files: string[]
): Promise<LocalImportResult> {
  if (!root) throw new Error('请先设置音乐文件夹')
  const category = store.get<{ name: string; kind: string }>(
    'SELECT name, kind FROM categories WHERE id = ?',
    [categoryId]
  )
  if (!category) throw new Error('目标分类不存在')
  if (category.kind !== categoryKind) throw new Error('目标分类类型不匹配')
  const targetDir = path.join(
    root,
    safeImportSegment(folderName, '视频收藏夹'),
    safeImportSegment(category.name, '未命名分类')
  )
  const errors: string[] = []
  let imported = 0
  for (const rawFile of files) {
    const source = path.resolve(String(rawFile))
    try {
      const ext = path.extname(source).toLowerCase()
      if (!AUDIO_EXTENSIONS.has(ext)) throw new Error('不是支持的音频格式')
      const stat = await fsp.stat(source)
      if (!stat.isFile()) throw new Error('不是文件')
      let targetPath = source
      let copied = false
      if (!isInsideRoot(root, source)) {
        await fsp.mkdir(targetDir, { recursive: true })
        const base = safeImportSegment(path.basename(source, ext), '未命名歌曲')
        let suffix = 0
        while (suffix < 100) {
          const candidate = path.join(
            targetDir,
            `${base}${suffix === 0 ? '' : ` (${suffix + 1})`}${ext}`
          )
          if (!fs.existsSync(candidate)) {
            targetPath = candidate
            break
          }
          suffix += 1
        }
        if (targetPath === source) throw new Error('目标文件夹里同名文件过多')
        await fsp.copyFile(source, targetPath)
        copied = true
      }
      const parsed = await parseLocalAudio(targetPath)
      const songId = upsertScannedSong(store, root, targetPath, parsed)
      setSongCategoryForKind(store, songId, categoryId, categoryKind)
      imported += 1
    } catch (error) {
      errors.push(`${path.basename(source)}：${(error as Error).message}`)
    }
  }
  return { imported, failed: errors.length, categoryId, errors }
}

export function findUniqueLocalMatch(
  store: DatabaseStore,
  title: string,
  artist: string,
  durationMs: number
): SongRow | null {
  const titleNorm = normalizeTitle(title)
  const artistNorm = normalizeArtist(artist)
  if (!titleNorm || !artistNorm || durationMs <= 0) return null
  const rows = store.all<SongRow>(
    `SELECT * FROM songs
     WHERE available = 1 AND title_norm = ? AND artist_norm = ?
       AND duration_ms > 0 AND ABS(duration_ms - ?) <= 3000
     LIMIT 3`,
    [titleNorm, artistNorm, durationMs]
  )
  return rows.length === 1 ? rows[0] : null
}

function decideMatch(store: DatabaseStore, item: PlaylistItemRow): MatchDecision {
  if (item.path_key) {
    const byPath = store.get<{ id: number }>(
      'SELECT id FROM songs WHERE path_key = ? AND available = 1 LIMIT 1',
      [item.path_key]
    )
    if (byPath) {
      return {
        status: 'matched',
        method: 'path',
        score: 1,
        songId: Number(byPath.id),
        note: '路径精确匹配'
      }
    }
  }

  const titleNorm = item.title_norm
  const artistNorm = item.artist_norm
  if (!titleNorm) {
    return { status: 'missing', method: null, score: 0, songId: null, note: '导入数据缺少歌名' }
  }

  if (artistNorm && Number(item.duration_ms) > 0) {
    const candidates = store.all<{ id: number; path: string; duration_ms: number }>(
      `SELECT id, path, duration_ms FROM songs
       WHERE available = 1 AND title_norm = ? AND artist_norm = ?
         AND duration_ms > 0 AND ABS(duration_ms - ?) <= 3000
       LIMIT 5`,
      [titleNorm, artistNorm, Number(item.duration_ms)]
    )
    if (candidates.length === 1) {
      return {
        status: 'matched',
        method: 'meta',
        score: 0.9,
        songId: Number(candidates[0].id),
        note: '标题+歌手+时长（±3秒）'
      }
    }
    if (candidates.length > 1) {
      return {
        status: 'suspicious',
        method: null,
        score: 0.5,
        songId: null,
        note: `存在 ${candidates.length} 个“标题+歌手+时长”都符合的文件`
      }
    }
  }

  if (Number(item.duration_ms) > 0) {
    const titleDuration = store.all<{ id: number }>(
      `SELECT id FROM songs
       WHERE available = 1 AND title_norm = ? AND duration_ms > 0
         AND ABS(duration_ms - ?) <= 3000
       LIMIT 5`,
      [titleNorm, Number(item.duration_ms)]
    )
    if (titleDuration.length === 1) {
      return {
        status: 'matched',
        method: 'title-duration',
        score: 0.8,
        songId: Number(titleDuration[0].id),
        note: '标题+时长（±3秒；歌手不同或缺失）'
      }
    }
    if (titleDuration.length > 1) {
      return {
        status: 'suspicious',
        method: null,
        score: 0.45,
        songId: null,
        note: `存在 ${titleDuration.length} 个标题和时长都符合的文件`
      }
    }
  }

  const loose = looseTitle(titleNorm)
  if (loose && Number(item.duration_ms) > 0) {
    const nearby = store.all<{ id: number; title: string; duration_ms: number }>(
      `SELECT id, title, duration_ms FROM songs
       WHERE available = 1 AND duration_ms > 0 AND ABS(duration_ms - ?) <= 5000
       LIMIT 40`,
      [Number(item.duration_ms)]
    )
    const fuzzy = nearby.filter((candidate) => looseTitle(candidate.title) === loose)
    if (fuzzy.length === 1) {
      return {
        status: 'matched',
        method: 'fuzzy-title-duration',
        score: 0.7,
        songId: Number(fuzzy[0].id),
        note: '模糊标题+时长（±5秒）'
      }
    }
  }

  if (artistNorm) {
    const sameMeta = store.all<{ id: number; duration_ms: number }>(
      `SELECT id, duration_ms FROM songs
       WHERE available = 1 AND title_norm = ? AND artist_norm = ? LIMIT 5`,
      [titleNorm, artistNorm]
    )
    if (sameMeta.length > 0) {
      return {
        status: 'suspicious',
        method: null,
        score: 0.4,
        songId: null,
        note:
          Number(item.duration_ms) > 0
            ? '标题和歌手相同，但时长不在 ±3 秒内'
            : '标题和歌手相同，但导入数据缺少可靠时长'
      }
    }
  }

  const titleOnly = store.all<{ id: number }>(
    `SELECT id FROM songs WHERE available = 1 AND title_norm = ? LIMIT 5`,
    [titleNorm]
  )
  if (titleOnly.length > 0) {
    return {
      status: 'suspicious',
      method: null,
      score: 0.3,
      songId: null,
      note: '只有歌名相同，缺少足够信息自动确认'
    }
  }

  return { status: 'missing', method: null, score: 0, songId: null, note: '本地未找到候选文件' }
}

export function rematchPlaylistItems(
  store: DatabaseStore,
  playlistId?: number
): { matched: number; missing: number; suspicious: number } {
  const items = playlistId
    ? store.all<PlaylistItemRow>('SELECT * FROM playlist_items WHERE playlist_id = ?', [playlistId])
    : store.all<PlaylistItemRow>('SELECT * FROM playlist_items')
  let matched = 0
  let missing = 0
  let suspicious = 0
  store.transaction(() => {
    for (const item of items) {
      if (item.match_method === 'manual' && item.matched_song_id != null) {
        matched += 1
        continue
      }
      const result = decideMatch(store, item)
      if (result.status === 'matched') matched += 1
      else if (result.status === 'missing') missing += 1
      else suspicious += 1
      store.run(
        `UPDATE playlist_items
         SET match_status = ?, match_method = ?, match_score = ?, matched_song_id = ?,
             match_note = ?, updated_at = ?
         WHERE id = ?`,
        [
          result.status,
          result.method,
          result.score,
          result.songId,
          result.note,
          now(),
          Number(item.id)
        ]
      )
    }
  })
  return { matched, missing, suspicious }
}

export function setPlaylistItemManualMatch(
  store: DatabaseStore,
  playlistId: number,
  itemId: number,
  songId: number
): void {
  const item = store.get<{ id: number }>(
    'SELECT id FROM playlist_items WHERE id = ? AND playlist_id = ?',
    [itemId, playlistId]
  )
  if (!item) throw new Error('歌单条目不存在')
  const song = store.get<{ id: number }>(
    'SELECT id FROM songs WHERE id = ? AND available = 1',
    [songId]
  )
  if (!song) throw new Error('选择的歌曲不存在或不可用')
  store.run(
    `UPDATE playlist_items
     SET match_status = 'matched', match_method = 'manual', match_score = 1,
         matched_song_id = ?, match_note = '手动选择本地歌曲', updated_at = ?
     WHERE id = ?`,
    [songId, now(), itemId]
  )
}

function defaultArtist(artist: string): string {
  return artist.trim() || '未知歌手'
}

function fileMetadataFallback(filePath: string): {
  title: string
  artist: string
  album: string
  durationMs: number
  genre: string
} {
  return {
    title: titleFromFilename(filePath),
    artist: '',
    album: '',
    durationMs: 0,
    genre: ''
  }
}

function upsertScannedSong(
  store: DatabaseStore,
  root: string,
  filePath: string,
  parsed: {
    title: string
    artist: string
    album: string
    durationMs: number
    genre: string
  }
): number {
  const existing = store.get<{ id: number; metadata_locked: number }>(
    'SELECT id, metadata_locked FROM songs WHERE path = ?',
    [filePath]
  )
  const title = parsed.title.trim() || titleFromFilename(filePath)
  const artist = defaultArtist(parsed.artist)
  const durationMs = Math.max(0, Math.round(parsed.durationMs || 0))
  let songId: number
  if (existing) {
    songId = Number(existing.id)
    if (Number(existing.metadata_locked) === 1) {
      store.run(
        `UPDATE songs SET path_key = ?, duration_ms = ?, ext = ?, available = 1, updated_at = ?
         WHERE id = ?`,
        [pathKeyFor(filePath), durationMs, path.extname(filePath).toLowerCase(), now(), songId]
      )
    } else {
      store.run(
        `UPDATE songs SET path_key = ?, title = ?, title_norm = ?, artist = ?, artist_norm = ?,
           album = ?, duration_ms = ?, genre = ?, ext = ?, available = 1, updated_at = ?
         WHERE id = ?`,
        [
          pathKeyFor(filePath),
          title,
          normalizeTitle(title),
          artist,
          normalizeArtist(artist),
          parsed.album.trim(),
          durationMs,
          parsed.genre,
          path.extname(filePath).toLowerCase(),
          now(),
          songId
        ]
      )
    }
  } else {
    store.run(
      `INSERT INTO songs
        (path, path_key, title, title_norm, artist, artist_norm, album, duration_ms, genre, ext,
         source, metadata_locked, available, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', 0, 1, ?, ?)`,
      [
        filePath,
        pathKeyFor(filePath),
        title,
        normalizeTitle(title),
        artist,
        normalizeArtist(artist),
        parsed.album.trim(),
        durationMs,
        parsed.genre,
        path.extname(filePath).toLowerCase(),
        now(),
        now()
      ]
    )
    songId = store.lastInsertId()
  }
  addSongAutoCategories(store, songId, root, filePath, parsed.genre)
  return songId
}

export interface ScanProgressHandler {
  (progress: ScanProgress): void
}

export async function scanLibrary(
  store: DatabaseStore,
  root: string,
  onProgress?: ScanProgressHandler
): Promise<ScanResult> {
  const started = Date.now()
  if (!root) throw new Error('还没有选择音乐文件夹')
  try {
    await fsp.access(root, fs.constants.R_OK)
  } catch {
    throw new Error(`无法读取音乐文件夹：${root}。请检查路径和 Windows 权限。`)
  }
  const stat = await fsp.stat(root)
  if (!stat.isDirectory()) throw new Error('选择的音乐路径不是文件夹')

  const files: string[] = []
  const errors: string[] = []
  let traversalErrors = 0

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (error) {
      traversalErrors += 1
      if (errors.length < 30) errors.push(`无法读取目录：${dir}（${(error as Error).message}）`)
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(full)
      }
    }
  }

  onProgress?.({ phase: 'walking', processed: 0, total: 0, current: root, message: '正在查找音频文件' })
  await walk(root)
  onProgress?.({
    phase: 'parsing',
    processed: 0,
    total: files.length,
    current: '',
    message: `找到 ${files.length} 个音频文件`
  })

  const mm = await import('music-metadata')
  const seenIds = new Set<number>()
  let processed = 0
  let parseErrors = 0
  let lastReport = 0
  let cursor = 0

  const reportProgress = (current: string): void => {
    const stamp = Date.now()
    if (stamp - lastReport < 150 && processed < files.length) return
    lastReport = stamp
    onProgress?.({
      phase: 'parsing',
      processed,
      total: files.length,
      current,
      message: `正在读取元数据 ${processed}/${files.length}`
    })
  }

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= files.length) return
      const filePath = files[index]
      let parsed = fileMetadataFallback(filePath)
      try {
        const metadata = await mm.parseFile(filePath, { duration: true, skipCovers: true })
        const genres = metadata.common.genre?.filter(Boolean) ?? []
        parsed = {
          title: metadata.common.title?.trim() || titleFromFilename(filePath),
          artist:
            metadata.common.artist?.trim() ||
            metadata.common.artists?.filter(Boolean).join(' / ') ||
            '',
          album: metadata.common.album?.trim() || '',
          durationMs: Math.round((metadata.format.duration ?? 0) * 1000),
          genre: genres.join(' / ')
        }
      } catch (error) {
        parseErrors += 1
        if (errors.length < 30) {
          errors.push(`元数据读取失败，已按文件名收录：${filePath}（${(error as Error).message}）`)
        }
      }

      try {
        const songId = store.transaction(() =>
          upsertScannedSong(store, root, filePath, parsed)
        )
        seenIds.add(songId)
      } catch (error) {
        logError(`收录文件失败：${filePath}`, error)
        if (errors.length < 30) errors.push(`收录失败：${filePath}（${(error as Error).message}）`)
      }
      processed += 1
      reportProgress(filePath)
    }
  }

  const workers = Array.from({ length: Math.min(6, Math.max(1, files.length)) }, () => worker())
  await Promise.all(workers)

  if (traversalErrors === 0) {
    const existing = store.all<{ id: number; path: string; source: string }>(
      'SELECT id, path, source FROM songs WHERE available = 1'
    )
    const hideIds: number[] = []
    for (const song of existing) {
      if (seenIds.has(Number(song.id))) continue
      // B站文件允许保存到音乐根目录之外的独立下载目录；扫描根目录时不能把它们误标为缺失。
      if (song.source === 'bilibili' && !isInsideRoot(root, String(song.path))) continue
      hideIds.push(Number(song.id))
    }
    for (let i = 0; i < hideIds.length; i += 400) {
      const chunk = hideIds.slice(i, i + 400)
      if (chunk.length === 0) continue
      const placeholders = chunk.map(() => '?').join(',')
      store.run(
        `UPDATE songs SET available = 0, updated_at = ? WHERE id IN (${placeholders})`,
        [now(), ...chunk]
      )
    }
    const ids = [...seenIds]
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400)
      if (chunk.length === 0) continue
      const placeholders = chunk.map(() => '?').join(',')
      store.run(
        `UPDATE songs SET available = 1, updated_at = ? WHERE id IN (${placeholders})`,
        [now(), ...chunk]
      )
    }
  }

  onProgress?.({
    phase: 'matching',
    processed: files.length,
    total: files.length,
    current: '',
    message: '正在重新匹配歌单'
  })
  rematchPlaylistItems(store)
  store.run(
    `INSERT INTO scan_runs
      (root_path, status, files_found, files_indexed, error_count, started_at, finished_at)
     VALUES (?, 'completed', ?, ?, ?, ?, ?)`,
    [root, files.length, seenIds.size, errors.length, started, Date.now()]
  )
  store.save()

  onProgress?.({
    phase: 'done',
    processed: files.length,
    total: files.length,
    current: '',
    message: `扫描完成，收录 ${seenIds.size} 首`
  })

  return {
    scanned: files.length,
    indexed: seenIds.size,
    errors,
    elapsedMs: Date.now() - started
  }
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export async function exportPlaylistCsv(
  store: DatabaseStore,
  playlistId: number,
  filePath: string
): Promise<ExportResult> {
  const playlist = store.get<{ name: string }>('SELECT name FROM playlists WHERE id = ?', [
    playlistId
  ])
  if (!playlist) throw new Error('歌单不存在')
  const items = getPlaylistItems(store, playlistId)
  const statusMap: Record<MatchStatus, string> = {
    matched: '已下载',
    missing: '缺失',
    suspicious: '疑似'
  }
  const methodMap: Record<string, string> = {
    path: '路径精确',
    meta: '标题+歌手+时长'
  }
  const lines = [
    ['歌名', '歌手', '专辑', '时长', '状态', '匹配方式', '匹配文件', '说明'].join(',')
  ]
  for (const item of items) {
    lines.push(
      [
        csvCell(item.title),
        csvCell(item.artist),
        csvCell(item.album),
        csvCell(formatMs(item.durationMs)),
        csvCell(statusMap[item.status] ?? item.status),
        csvCell(item.matchMethod ? methodMap[item.matchMethod] ?? item.matchMethod : ''),
        csvCell(item.path),
        csvCell(item.note)
      ].join(',')
    )
  }
  await fsp.writeFile(filePath, `\ufeff${lines.join('\r\n')}`, 'utf8')
  return { canceled: false, path: filePath }
}

function normalizeTagName(rawTagName: string): string {
  const tagName = rawTagName.normalize('NFKC').trim().slice(0, 30)
  if (!tagName) throw new Error('标签名不能为空')
  return tagName
}

function ensureTagCategory(store: DatabaseStore, categoryId: number): { id: number; name: string } {
  const category = store.get<{ id: number; name: string; kind: string }>(
    'SELECT id, name, kind FROM categories WHERE id = ?',
    [categoryId]
  )
  if (!category || category.kind !== 'tag') throw new Error('标签不存在')
  return { id: Number(category.id), name: String(category.name) }
}

function cleanupEmptyTagCategory(store: DatabaseStore, categoryId: number): void {
  const remaining = store.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM song_categories WHERE category_id = ?',
    [categoryId]
  )
  if (Number(remaining?.count ?? 0) === 0) {
    store.run('DELETE FROM categories WHERE id = ?', [categoryId])
  }
}

export function getSongTags(store: DatabaseStore, songId: number): CategoryView[] {
  return store
    .all<{ id: number; name: string; song_count: number }>(
      `SELECT c.id, c.name, COUNT(DISTINCT all_sc.song_id) AS song_count
       FROM categories c
       JOIN song_categories sc ON sc.category_id = c.id AND sc.song_id = ?
       LEFT JOIN song_categories all_sc ON all_sc.category_id = c.id
       WHERE c.kind = 'tag'
       GROUP BY c.id
       ORDER BY c.name COLLATE NOCASE`,
      [songId]
    )
    .map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      kind: 'tag' as const,
      songCount: Number(row.song_count ?? 0)
    }))
}

export function addTagToSong(store: DatabaseStore, songId: number, rawTagName: string): CategoryView[] {
  const tagName = normalizeTagName(rawTagName)
  const song = store.get<{ id: number }>('SELECT id FROM songs WHERE id = ?', [songId])
  if (!song) throw new Error('歌曲不存在')
  const categoryId = ensureCategory(store, 'tag', tagName, tagName)
  addSongCategory(store, categoryId, songId, 'manual')
  store.save()
  return listCategories(store)
}

export function addTagToSongs(
  store: DatabaseStore,
  rawSongIds: number[],
  rawTagName: string
): CategoryView[] {
  const tagName = normalizeTagName(rawTagName)
  const songIds = [
    ...new Set(
      rawSongIds.map(Number).filter((value) => Number.isInteger(value) && value > 0)
    )
  ]
  if (songIds.length === 0) throw new Error('没有选择歌曲')
  const categoryId = ensureCategory(store, 'tag', tagName, tagName)
  store.transaction(() => {
    for (const songId of songIds) {
      const song = store.get<{ id: number }>('SELECT id FROM songs WHERE id = ?', [songId])
      if (song) addSongCategory(store, categoryId, songId, 'manual')
    }
  })
  store.save()
  return listCategories(store)
}

export function removeTagFromSong(
  store: DatabaseStore,
  songId: number,
  categoryId: number
): CategoryView[] {
  ensureTagCategory(store, categoryId)
  store.run('DELETE FROM song_categories WHERE song_id = ? AND category_id = ?', [
    songId,
    categoryId
  ])
  cleanupEmptyTagCategory(store, categoryId)
  store.save()
  return listCategories(store)
}

export function renameTag(
  store: DatabaseStore,
  categoryId: number,
  rawName: string
): CategoryView[] {
  const name = normalizeTagName(rawName)
  ensureTagCategory(store, categoryId)
  const sourceKey = normalizeText(name)
  const existing = store.get<{ id: number }>(
    "SELECT id FROM categories WHERE kind = 'tag' AND source_key = ? AND id <> ?",
    [sourceKey, categoryId]
  )
  if (existing) {
    store.transaction(() => {
      store.run(
        `INSERT OR IGNORE INTO song_categories (category_id, song_id, origin, added_at)
         SELECT ?, song_id, origin, added_at FROM song_categories WHERE category_id = ?`,
        [existing.id, categoryId]
      )
      store.run('DELETE FROM categories WHERE id = ?', [categoryId])
    })
  } else {
    store.run('UPDATE categories SET name = ?, source_key = ?, updated_at = ? WHERE id = ?', [
      name,
      sourceKey,
      now(),
      categoryId
    ])
  }
  store.save()
  return listCategories(store)
}

export function deleteTag(store: DatabaseStore, categoryId: number): CategoryView[] {
  ensureTagCategory(store, categoryId)
  store.run('DELETE FROM categories WHERE id = ?', [categoryId])
  store.save()
  return listCategories(store)
}

export function jobStatusLabel(status: BiliJobStatus): string {
  const labels: Record<BiliJobStatus, string> = {
    queued: '排队中',
    running: '下载中',
    completed: '已完成',
    partial: '部分失败',
    failed: '失败',
    interrupted: '已中断'
  }
  return labels[status] ?? status
}

export function emptyJobView(): BiliJobView {
  return {
    id: '',
    requestId: '',
    mediaId: '',
    title: '',
    status: 'queued',
    total: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    createdAt: 0,
    updatedAt: 0,
    lastError: '',
    currentTitle: '',
    currentPhase: '',
    failures: []
  }
}
