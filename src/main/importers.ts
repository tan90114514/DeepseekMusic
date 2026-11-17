import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ImportResult } from '../shared/types'
import {
  isInsideRoot,
  normalizeArtist,
  normalizeTitle,
  pathKeyFor,
  rematchPlaylistItems,
  titleFromFilename
} from './core'
import { DatabaseStore, now } from './db'

export interface RawTrack {
  title: string
  artist: string
  album: string
  durationMs: number
  pathHint: string
}

interface ParsedPlaylist {
  format: string
  name: string
  tracks: RawTrack[]
  warnings: string[]
}

const TITLE_KEYS = new Set([
  'title',
  'name',
  'song',
  'songname',
  'song_name',
  'musicname',
  'music_name',
  '歌名',
  '标题',
  '曲名',
  '歌曲',
  '歌曲名'
])
const ARTIST_KEYS = new Set([
  'artist',
  'artists',
  'singer',
  'singers',
  'performer',
  '歌手',
  '艺术家',
  '演唱者',
  '艺人',
  '作者'
])
const ALBUM_KEYS = new Set(['album', 'albumname', 'album_name', '专辑', '专辑名'])
const DURATION_KEYS = new Set([
  'duration',
  'durationms',
  'duration_ms',
  'length',
  'time',
  'interval',
  'dt',
  '时长',
  '时间'
])
const PATH_KEYS = new Set([
  'path',
  'file',
  'filepath',
  'file_path',
  'localpath',
  'local_path',
  '路径',
  '文件路径',
  '文件'
])

function decodeText(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buffer)
    } catch {
      return buffer.toString('utf8')
    }
  }
}

function keyName(value: string): string {
  return value.replace(/^\uFEFF/, '').replace(/\s+/g, '').trim().toLowerCase()
}

function parseDurationMs(value: unknown, treatAsMs = false): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0
    if (treatAsMs || value > 10000) return Math.round(value)
    return Math.round(value * 1000)
  }
  const text = String(value ?? '').trim()
  if (!text) return 0
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) {
    const parts = text.split(':').map(Number)
    if (parts.length === 3) return ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000
    return (parts[0] * 60 + parts[1]) * 1000
  }
  const number = Number(text.replace(/,/g, ''))
  if (!Number.isFinite(number) || number <= 0) return 0
  return parseDurationMs(number, treatAsMs)
}

function resolvePathHint(
  rawPath: string,
  playlistDir: string,
  root: string
): { hint: string; key: string; warning?: string } {
  const text = rawPath.trim()
  if (!text) return { hint: '', key: '' }
  if (/^(https?|file):\/\//i.test(text)) {
    return { hint: text, key: '', warning: `跳过非本地路径：${text}` }
  }
  const candidates = path.isAbsolute(text)
    ? [path.resolve(text)]
    : [path.resolve(playlistDir, text), path.resolve(root, text)]
  const inside = candidates.filter((candidate) => isInsideRoot(root, candidate))
  if (inside.length === 0) {
    return {
      hint: text,
      key: '',
      warning: `路径不在音乐根目录内，导入时忽略：${text}`
    }
  }
  const existing = inside.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  })
  const chosen = existing ?? inside[0]
  return { hint: chosen, key: pathKeyFor(chosen) }
}

function parseM3u(text: string, fileName: string): ParsedPlaylist {
  const warnings: string[] = []
  const tracks: RawTrack[] = []
  const lines = text.split(/\r?\n/)
  let pendingDuration = 0
  let pendingTitle = ''
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#EXTINF:')) {
      const payload = line.slice(8)
      const comma = payload.indexOf(',')
      const durationPart = comma >= 0 ? payload.slice(0, comma) : payload
      pendingDuration = parseDurationMs(Number(durationPart.split(/\s+/)[0] || 0))
      pendingTitle = comma >= 0 ? payload.slice(comma + 1).trim() : ''
      continue
    }
    if (line.startsWith('#')) continue
    if (/^(https?|file):\/\//i.test(line)) {
      warnings.push(`已跳过网络地址（不会下载 HLS）：${line}`)
      pendingTitle = ''
      pendingDuration = 0
      continue
    }
    let title = pendingTitle
    let artist = ''
    if (title.includes(' - ')) {
      const split = title.indexOf(' - ')
      artist = title.slice(0, split).trim()
      title = title.slice(split + 3).trim()
    }
    if (!title) title = titleFromFilename(line)
    tracks.push({
      title,
      artist,
      album: '',
      durationMs: pendingDuration,
      pathHint: line
    })
    pendingTitle = ''
    pendingDuration = 0
  }
  return {
    format: path.extname(fileName).slice(1).toLowerCase() || 'm3u',
    name: path.basename(fileName, path.extname(fileName)),
    tracks,
    warnings
  }
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? ''
  const counts: Record<string, number> = { ',': 0, '\t': 0, ';': 0 }
  let quoted = false
  for (let i = 0; i < firstLine.length; i += 1) {
    const char = firstLine[i]
    if (char === '"') {
      if (quoted && firstLine[i + 1] === '"') i += 1
      else quoted = !quoted
    } else if (!quoted && char in counts) {
      counts[char] += 1
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ','
}

function unquoteLegacyLine(line: string): string {
  let value = line.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/""/g, '"')
  }
  return value
}

function labelKey(label: string): 'title' | 'artist' | 'album' | 'duration' | 'path' | null {
  if (['歌曲名', '歌名', '标题', '曲名'].includes(label)) return 'title'
  if (['歌手名', '歌手', '艺人', '演唱者'].includes(label)) return 'artist'
  if (['专辑名', '专辑'].includes(label)) return 'album'
  if (['时长'].includes(label)) return 'duration'
  if (['路径', '文件路径'].includes(label)) return 'path'
  return null
}

/**
 * Some music apps export a "CSV" that is actually one labelled line per song:
 * 歌曲名：Foo，歌手名：Bar，专辑名：Baz
 * Support it without requiring a header or ASCII comma delimiters.
 */
function parseLabelledList(text: string, fileName: string): ParsedPlaylist | null {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const sample = lines
    .slice(0, 8)
    .map(unquoteLegacyLine)
    .find((line) => /(歌曲名|歌名|标题|曲名)[：:]/.test(line))
  if (!sample || !/(歌手名|歌手|艺人|演唱者)[：:]/.test(sample)) return null

  const labelPattern = /(歌曲名|歌名|标题|曲名|歌手名|歌手|艺人|演唱者|专辑名|专辑|时长|路径|文件路径)[：:]/g
  const tracks: RawTrack[] = []
  const warnings: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = unquoteLegacyLine(lines[index])
    if (/^\[(ti|ar|al|by|offset|re|ve):/i.test(line)) continue
    const matches = [...line.matchAll(labelPattern)]
    if (matches.length === 0) {
      warnings.push(`第 ${index + 1} 行没有可识别的歌曲字段，已跳过`)
      continue
    }
    const values: Partial<Record<'title' | 'artist' | 'album' | 'duration' | 'path', string>> = {}
    for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
      const match = matches[matchIndex]
      const key = labelKey(match[1])
      if (!key) continue
      const valueStart = (match.index ?? 0) + match[0].length
      const valueEnd = matches[matchIndex + 1]?.index ?? line.length
      const value = line
        .slice(valueStart, valueEnd)
        .replace(/^[，,;；\s]+/, '')
        .replace(/[，,;；\s]+$/, '')
        .trim()
      if (value && values[key] === undefined) values[key] = value
    }
    const title = values.title ?? ''
    if (!title) {
      warnings.push(`第 ${index + 1} 行缺少歌名，已跳过`)
      continue
    }
    tracks.push({
      title,
      artist: values.artist ?? '',
      album: values.album ?? '',
      durationMs: values.duration ? parseDurationMs(values.duration) : 0,
      pathHint: values.path ?? ''
    })
  }

  if (tracks.length === 0) return null
  return {
    format: 'csv',
    name: path.basename(fileName, path.extname(fileName)),
    tracks,
    warnings
  }
}

function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === delimiter) {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''))
      if (row.some((entry) => entry.trim())) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }
  row.push(cell.replace(/\r$/, ''))
  if (row.some((entry) => entry.trim())) rows.push(row)
  return rows
}

function parseCsv(text: string, fileName: string): ParsedPlaylist {
  const labelled = parseLabelledList(text, fileName)
  if (labelled) return labelled
  const warnings: string[] = []
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ''), detectDelimiter(text))
  if (rows.length < 2) throw new Error('CSV 为空，或没有表头和数据行')
  const headers = rows[0].map((cell) => keyName(cell))
  const findIndex = (aliases: Set<string>): number =>
    headers.findIndex((header) => aliases.has(header))
  const titleIndex = findIndex(TITLE_KEYS)
  if (titleIndex < 0) {
    throw new Error('CSV 缺少歌名列（title/name/歌名/歌曲名）')
  }
  const artistIndex = findIndex(ARTIST_KEYS)
  const albumIndex = findIndex(ALBUM_KEYS)
  const durationIndex = findIndex(DURATION_KEYS)
  const pathIndex = findIndex(PATH_KEYS)
  const durationAsMs =
    durationIndex >= 0 && /ms|dt/i.test(headers[durationIndex] ?? '')

  const tracks: RawTrack[] = []
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]
    const title = (row[titleIndex] ?? '').trim()
    if (!title) {
      warnings.push(`CSV 第 ${i + 1} 行缺少歌名，已跳过`)
      continue
    }
    tracks.push({
      title,
      artist: artistIndex >= 0 ? (row[artistIndex] ?? '').trim() : '',
      album: albumIndex >= 0 ? (row[albumIndex] ?? '').trim() : '',
      durationMs:
        durationIndex >= 0 ? parseDurationMs(row[durationIndex], durationAsMs) : 0,
      pathHint: pathIndex >= 0 ? (row[pathIndex] ?? '').trim() : ''
    })
  }
  return {
    format: 'csv',
    name: path.basename(fileName, path.extname(fileName)),
    tracks,
    warnings
  }
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  return ''
}

function findArrayInJson(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  for (const key of ['songs', 'tracks', 'data', 'list', 'playlist', 'songlist']) {
    if (Array.isArray(record[key])) return record[key] as unknown[]
  }
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === 'object') {
      const found = findArrayInJson(nested)
      if (found.length > 0) return found
    }
  }
  return []
}

function artistsFromJson(item: Record<string, unknown>): string {
  const direct = stringValue(item.artist ?? item.singer ?? item.artists ?? item.singers)
  if (direct) return direct
  const arrays = [item.ar, item.artists, item.singers, item.singer]
  for (const value of arrays) {
    if (!Array.isArray(value)) continue
    const names = value
      .map((entry) =>
        typeof entry === 'string'
          ? entry
          : stringValue((entry as Record<string, unknown>)?.name)
      )
      .filter(Boolean)
    if (names.length > 0) return names.join(' / ')
  }
  return ''
}

function albumFromJson(item: Record<string, unknown>): string {
  const direct = stringValue(item.album ?? item.albumname ?? item.albumName)
  if (direct) return direct
  for (const value of [item.al, item.album]) {
    if (value && typeof value === 'object') {
      const name = stringValue((value as Record<string, unknown>).name)
      if (name) return name
    }
  }
  return ''
}

function parseJson(text: string, fileName: string): ParsedPlaylist {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`JSON 格式错误：${(error as Error).message}`)
  }
  const items = findArrayInJson(parsed)
  const warnings: string[] = []
  if (items.length === 0) throw new Error('JSON 中找不到歌曲数组')
  const tracks: RawTrack[] = []
  for (let index = 0; index < items.length; index += 1) {
    const value = items[index]
    if (!value || typeof value !== 'object') {
      warnings.push(`JSON 第 ${index + 1} 项不是对象，已跳过`)
      continue
    }
    const item = value as Record<string, unknown>
    const title = stringValue(
      item.title ?? item.name ?? item.songname ?? item.songName ?? item.musicName ?? item.song
    )
    if (!title) {
      warnings.push(`JSON 第 ${index + 1} 项缺少歌名，已跳过`)
      continue
    }
    const explicitMs =
      item.durationMs !== undefined ||
      item.duration_ms !== undefined ||
      item.dt !== undefined
    const durationRaw =
      item.durationMs ?? item.duration_ms ?? item.dt ?? item.duration ?? item.interval ?? item.length
    tracks.push({
      title,
      artist: artistsFromJson(item),
      album: albumFromJson(item),
      durationMs: parseDurationMs(durationRaw, explicitMs),
      pathHint: stringValue(
        item.path ?? item.file ?? item.filepath ?? item.filePath ?? item.localPath
      )
    })
  }
  return {
    format: 'json',
    name: path.basename(fileName, path.extname(fileName)),
    tracks,
    warnings
  }
}

async function parsePlaylistFile(filePath: string): Promise<ParsedPlaylist> {
  const ext = path.extname(filePath).toLowerCase()
  const buffer = await fsp.readFile(filePath)
  const text = decodeText(buffer)
  if (ext === '.m3u' || ext === '.m3u8') return parseM3u(text, filePath)
  if (ext === '.csv') return parseCsv(text, filePath)
  if (ext === '.json') return parseJson(text, filePath)
  throw new Error('仅支持 .m3u、.m3u8、.csv、.json 歌单文件')
}

export async function importPlaylistFile(
  store: DatabaseStore,
  filePath: string,
  root: string
): Promise<ImportResult> {
  if (!root) throw new Error('请先选择音乐文件夹，再导入歌单')
  const parsed = await parsePlaylistFile(filePath)
  if (parsed.tracks.length === 0) throw new Error('歌单中没有可导入的歌曲')
  const warnings = [...parsed.warnings]
  const playlistDir = path.dirname(filePath)

  const playlistId = store.transaction(() => {
    store.run(
      `INSERT INTO playlists (name, format, source_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [parsed.name || '未命名歌单', parsed.format, filePath, now(), now()]
    )
    const id = store.lastInsertId()
    let position = 0
    for (const track of parsed.tracks) {
      const pathInfo = resolvePathHint(track.pathHint, playlistDir, root)
      if (pathInfo.warning && !warnings.includes(pathInfo.warning)) {
        warnings.push(pathInfo.warning)
      }
      const title = track.title.trim() || titleFromFilename(track.pathHint || '未命名歌曲')
      position += 1
      store.run(
        `INSERT INTO playlist_items
          (playlist_id, position, title, title_norm, artist, artist_norm, album, duration_ms,
           path_hint, path_key, match_status, match_method, match_score, matched_song_id,
           match_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'missing', NULL, 0, NULL, '', ?, ?)`,
        [
          id,
          position,
          title,
          normalizeTitle(title),
          track.artist.trim(),
          normalizeArtist(track.artist),
          track.album.trim(),
          Math.max(0, Math.round(track.durationMs)),
          pathInfo.hint,
          pathInfo.key,
          now(),
          now()
        ]
      )
    }
    return id
  })

  store.save()
  const stats = rematchPlaylistItems(store, playlistId)
  store.save()
  return {
    playlistId,
    name: parsed.name,
    total: parsed.tracks.length,
    matched: stats.matched,
    missing: stats.missing,
    suspicious: stats.suspicious,
    warnings: [...new Set(warnings)]
  }
}
