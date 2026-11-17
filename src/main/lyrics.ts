import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { LyricsData, LyricsLine } from '../shared/types'
import { DatabaseStore, now } from './db'

interface SongLyricsRow {
  id: number
  path: string
  title: string
  artist: string
}

function decodeLyricsBuffer(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2))
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2))
  }
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

function fractionToMs(value: string | undefined): number {
  if (!value) return 0
  if (value.length === 1) return Number(value) * 100
  if (value.length === 2) return Number(value) * 10
  return Number(value.slice(0, 3))
}

export function parseLrc(text: string): LyricsLine[] {
  const withoutBom = text.replace(/^\uFEFF/, '')
  const offsetMatch = withoutBom.match(/\[offset:([+-]?\d+)\]/i)
  const offset = offsetMatch ? Number(offsetMatch[1]) : 0
  const lines: Array<{ timeMs: number; text: string }> = []

  for (const rawLine of withoutBom.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const timePattern = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
    const matches = [...line.matchAll(timePattern)]
    if (matches.length === 0) continue
    let consumedUntil = 0
    for (const match of matches) {
      consumedUntil = (match.index ?? 0) + match[0].length
    }
    const lyricText = line.slice(consumedUntil).trim()
    if (!lyricText) continue
    for (const match of matches) {
      const minutes = Number(match[1])
      const seconds = Number(match[2])
      const timeMs = Math.max(0, minutes * 60_000 + seconds * 1000 + fractionToMs(match[3]) + offset)
      lines.push({ timeMs, text: lyricText })
    }
  }

  // Translation lines often share the exact timestamp; display them together.
  const grouped = new Map<number, string[]>()
  for (const line of lines) {
    const existing = grouped.get(line.timeMs) ?? []
    if (!existing.includes(line.text)) existing.push(line.text)
    grouped.set(line.timeMs, existing)
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timeMs, texts]) => ({ timeMs, text: texts.join('\n') }))
}

async function findLrcInDirectory(dir: string, baseName: string): Promise<string | null> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    const wanted = `${baseName}.lrc`.toLowerCase()
    const match = entries.find(
      (entry) => entry.isFile() && entry.name.toLowerCase() === wanted
    )
    return match ? path.join(dir, match.name) : null
  } catch {
    return null
  }
}

async function findAutoLrc(
  audioPath: string,
  musicRoot: string
): Promise<string | null> {
  const audioDir = path.dirname(audioPath)
  const baseName = path.basename(audioPath, path.extname(audioPath))
  const directories = [
    audioDir,
    path.join(audioDir, 'Lyrics'),
    path.join(audioDir, 'lyrics'),
    path.join(audioDir, 'LRC'),
    path.join(audioDir, 'lrc'),
    path.join(musicRoot, 'Lyrics'),
    path.join(musicRoot, 'lyrics'),
    path.join(musicRoot, 'LRC'),
    path.join(musicRoot, 'lrc')
  ]
  const seen = new Set<string>()
  for (const dir of directories) {
    const key = path.resolve(dir).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const found = await findLrcInDirectory(dir, baseName)
    if (found) return found
  }
  return null
}

async function parseLyricsFile(filePath: string): Promise<LyricsData> {
  try {
    const buffer = await fsp.readFile(filePath)
    const text = decodeLyricsBuffer(buffer)
    const lines = parseLrc(text)
    if (lines.length === 0) {
      return {
        found: false,
        synced: false,
        lines: [],
        sourcePath: filePath,
        error: 'LRC 文件里没有找到带时间标签的歌词'
      }
    }
    return {
      found: true,
      synced: true,
      lines,
      sourcePath: filePath
    }
  } catch (error) {
    return {
      found: false,
      synced: false,
      lines: [],
      sourcePath: filePath,
      error: `读取歌词失败：${(error as Error).message}`
    }
  }
}

export async function getLyricsForSong(
  store: DatabaseStore,
  musicRoot: string,
  songId: number
): Promise<LyricsData> {
  const song = store.get<SongLyricsRow>(
    'SELECT id, path, title, artist FROM songs WHERE id = ?',
    [songId]
  )
  if (!song) {
    return {
      found: false,
      synced: false,
      lines: [],
      sourcePath: '',
      error: '歌曲不存在'
    }
  }

  const linked = store.get<{ lrc_path: string }>(
    'SELECT lrc_path FROM lyrics_links WHERE song_id = ?',
    [songId]
  )
  if (linked?.lrc_path && fs.existsSync(linked.lrc_path)) {
    return parseLyricsFile(linked.lrc_path)
  }

  const auto = await findAutoLrc(String(song.path), musicRoot)
  if (auto) return parseLyricsFile(auto)

  return {
    found: false,
    synced: false,
    lines: [],
    sourcePath: ''
  }
}

export async function setLyricsFile(
  store: DatabaseStore,
  songId: number,
  filePath: string
): Promise<LyricsData> {
  const song = store.get<{ id: number }>('SELECT id FROM songs WHERE id = ?', [songId])
  if (!song) {
    return {
      found: false,
      synced: false,
      lines: [],
      sourcePath: filePath,
      error: '歌曲不存在'
    }
  }
  const data = await parseLyricsFile(filePath)
  if (!data.found) return data
  store.run(
    `INSERT INTO lyrics_links (song_id, lrc_path, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(song_id) DO UPDATE SET lrc_path = excluded.lrc_path, updated_at = excluded.updated_at`,
    [songId, filePath, now()]
  )
  store.save()
  return data
}
