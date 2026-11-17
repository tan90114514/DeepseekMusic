import fs from 'node:fs'
import fsp from 'node:fs/promises'
import type { Stats } from 'node:fs'
import path from 'node:path'
import type {
  DeleteSongsResult,
  MoveSongsResult,
  SongOperationFailure
} from '../shared/types'
import {
  addSongAutoCategories,
  isInsideRoot,
  pathKeyFor,
  rematchPlaylistItems
} from './core'
import type { DatabaseStore } from './db'

interface SongFileRow {
  id: number
  path: string
  title: string
  source: string
  genre: string
}

function normalizeSongIds(rawIds: unknown): number[] {
  if (!Array.isArray(rawIds)) throw new Error('歌曲参数不合法')
  const ids = [
    ...new Set(
      rawIds
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0)
    )
  ]
  if (ids.length === 0) throw new Error('没有选择歌曲')
  if (ids.length > 1000) throw new Error('一次最多处理 1000 首歌曲')
  return ids
}

function getSongs(store: DatabaseStore, ids: number[]): SongFileRow[] {
  const rows: SongFileRow[] = []
  for (let index = 0; index < ids.length; index += 400) {
    const chunk = ids.slice(index, index + 400)
    const placeholders = chunk.map(() => '?').join(',')
    rows.push(
      ...store.all<SongFileRow>(
        `SELECT id, path, title, source, genre FROM songs WHERE id IN (${placeholders})`,
        chunk
      )
    )
  }
  const order = new Map(ids.map((id, index) => [id, index]))
  return rows.sort((a, b) => Number(order.get(a.id) ?? 0) - Number(order.get(b.id) ?? 0))
}

function failure(song: SongFileRow, error: unknown): SongOperationFailure {
  return {
    songId: song.id,
    title: song.title,
    path: song.path,
    error: error instanceof Error ? error.message : String(error)
  }
}

async function moveFile(source: string, target: string): Promise<void> {
  try {
    await fsp.rename(source, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL)
    try {
      await fsp.unlink(source)
    } catch (unlinkError) {
      await fsp.rm(target, { force: true }).catch(() => undefined)
      throw unlinkError
    }
  }
}

export async function deleteSongs(
  store: DatabaseStore,
  musicRoot: string,
  rawIds: unknown,
  deleteFiles: boolean
): Promise<DeleteSongsResult> {
  const ids = normalizeSongIds(rawIds)
  const songs = getSongs(store, ids)
  const failures: SongOperationFailure[] = []
  const removedIds: number[] = []
  let filesRemoved = 0

  for (const song of songs) {
    if (deleteFiles) {
      const filePath = path.resolve(song.path)
      const sourceIsBili = song.source === 'bilibili'
      if (!sourceIsBili && (!musicRoot || !isInsideRoot(musicRoot, filePath))) {
        failures.push(failure(song, new Error('文件不在当前音乐文件夹内，出于安全考虑未删除')))
        continue
      }
      try {
        await fsp.unlink(filePath)
        filesRemoved += 1
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          failures.push(failure(song, error))
          continue
        }
      }
    }
    removedIds.push(song.id)
  }

  if (removedIds.length > 0) {
    store.transaction(() => {
      for (const songId of removedIds) {
        store.run('UPDATE playlist_items SET matched_song_id = NULL, updated_at = ? WHERE matched_song_id = ?', [
          Date.now(),
          songId
        ])
        store.run('UPDATE download_items SET song_id = NULL, updated_at = ? WHERE song_id = ?', [
          Date.now(),
          songId
        ])
        store.run('DELETE FROM song_categories WHERE song_id = ?', [songId])
        store.run('DELETE FROM lyrics_links WHERE song_id = ?', [songId])
        store.run('DELETE FROM songs WHERE id = ?', [songId])
      }
    })
    rematchPlaylistItems(store)
    store.save()
  }

  return { removed: removedIds.length, filesRemoved, failures }
}

export async function moveSongs(
  store: DatabaseStore,
  musicRoot: string,
  rawIds: unknown,
  rawTargetDir: string
): Promise<MoveSongsResult> {
  if (!musicRoot) throw new Error('还没有选择音乐文件夹')
  const ids = normalizeSongIds(rawIds)
  const root = path.resolve(musicRoot)
  const targetDir = path.resolve(String(rawTargetDir ?? ''))
  if (targetDir !== root && !isInsideRoot(root, targetDir)) {
    throw new Error('移动目标必须位于当前音乐文件夹内。跨盘移动请先用文件资源管理器。')
  }
  const targetStat = await fsp.stat(targetDir).catch(() => null)
  if (!targetStat || !targetStat.isDirectory()) throw new Error('目标文件夹不存在')
  await fsp.access(targetDir, fs.constants.W_OK)

  const songs = getSongs(store, ids)
  const failures: SongOperationFailure[] = []
  let moved = 0
  let skipped = 0

  for (const song of songs) {
    const source = path.resolve(song.path)
    if (path.dirname(source).toLowerCase() === targetDir.toLowerCase()) {
      skipped += 1
      continue
    }
    let sourceStat: Stats
    try {
      sourceStat = await fsp.stat(source)
    } catch (error) {
      failures.push(failure(song, error))
      continue
    }
    if (!sourceStat.isFile()) {
      failures.push(failure(song, new Error('原路径不是音频文件')))
      continue
    }

    const ext = path.extname(source)
    const baseName = path.basename(source, ext)
    let targetPath = ''
    for (let suffix = 0; suffix < 1000; suffix += 1) {
      const name = suffix === 0 ? `${baseName}${ext}` : `${baseName} (${suffix + 1})${ext}`
      const candidate = path.join(targetDir, name)
      const existing = store.get<{ id: number }>('SELECT id FROM songs WHERE path_key = ?', [
        pathKeyFor(candidate)
      ])
      if (existing && Number(existing.id) !== song.id) continue
      if (!fs.existsSync(candidate)) {
        targetPath = candidate
        break
      }
    }
    if (!targetPath) {
      failures.push(failure(song, new Error('目标文件夹里同名文件过多')))
      continue
    }

    try {
      await moveFile(source, targetPath)
    } catch (error) {
      failures.push(failure(song, error))
      continue
    }

    try {
      store.transaction(() => {
        store.run('UPDATE songs SET path = ?, path_key = ?, updated_at = ? WHERE id = ?', [
          targetPath,
          pathKeyFor(targetPath),
          Date.now(),
          song.id
        ])
        store.run('UPDATE download_items SET output_path = ?, updated_at = ? WHERE song_id = ?', [
          targetPath,
          Date.now(),
          song.id
        ])
        addSongAutoCategories(store, song.id, root, targetPath, song.genre)
      })
      moved += 1
    } catch (error) {
      try {
        await moveFile(targetPath, source)
      } catch {
        // Keep the original operation error; the file may need manual cleanup.
      }
      failures.push(failure(song, error))
    }
  }

  if (moved > 0) store.save()
  return { moved, skipped, failures, targetDir }
}
