import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  screen,
  shell,
  Tray
} from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type {
  AppBootstrap,
  DevelopmentInfo,
  LyricsPlaybackState,
  PlaybackCommand,
  ScanProgress,
  TrayPlaybackState
} from '../shared/types'
import { DEFAULT_BRIDGE_PORT } from '../shared/types'
import { BiliService } from './bili/service'
import { BridgeServer } from './bridge'
import {
  AUDIO_EXTENSIONS,
  addSongsToPlaylist,
  addTagToSong,
  addTagToSongs,
  createBiliCategory,
  createPlaylist,
  deletePlaylist,
  deleteTag,
  exportPlaylistCsv,
  getAllSongs,
  getCategorySongs,
  getPlaylistItems,
  getSongTags,
  ensureCategory,
  getSongBiliCategory,
  getSongsByCategories,
  isInsideRoot,
  normalizeText,
  listCategories,
  listPlaylists,
  rematchPlaylistItems,
  removePlaylistItems,
  removeTagFromSong,
  renamePlaylist,
  renameTag,
  scanLibrary,
  setPlaylistItemManualMatch,
  setSongBiliCategory
} from './core'
import { getMediaSiteProvider } from './mediaSites'
import { DatabaseStore } from './db'
import { importPlaylistFile } from './importers'
import { deleteSongs, moveSongs } from './libraryFiles'
import { getLyricsForSong, setLyricsFile } from './lyrics'
import { logError, logInfo } from './logger'
import { ensureAppDirs, getDbPath, getExtensionDir, getPreloadPath, getRendererHtmlPath } from './paths'
import { generateBridgeToken, getBridgeToken, hasBridgeToken } from './token'

const bootLogPath = process.env['LOCAL_MUSIC_PLAYER_BOOT_LOG']
function bootLog(message: string): void {
  if (!bootLogPath) return
  try {
    fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    // Diagnostic logging must never interfere with startup.
  }
}

bootLog('main module loaded')
process.on('uncaughtException', (error) => {
  bootLog(`uncaughtException: ${error.stack ?? error.message}`)
})
process.on('unhandledRejection', (error) => {
  bootLog(`unhandledRejection: ${String(error)}`)
})

const legacyUserData = path.join(app.getPath('appData'), 'LocalMusicPlayer')
app.setName('DSM')
app.setAppUserModelId('com.dsm.musicplayer')
// Keep the existing user data so 0.3.x libraries, playlists and tokens survive the rename.
if (fs.existsSync(legacyUserData)) app.setPath('userData', legacyUserData)
bootLog('app identity set')

const userDataOverride = process.env['LOCAL_MUSIC_PLAYER_USER_DATA']
if (userDataOverride) {
  app.setPath('userData', path.resolve(userDataOverride))
  bootLog(`userData override: ${app.getPath('userData')}`)
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'music',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])
bootLog('music scheme registered')

let store: DatabaseStore | null = null
let biliService: BiliService | null = null
let bridge: BridgeServer | null = null
let mainWindow: BrowserWindow | null = null
let lyricsWindow: BrowserWindow | null = null
let lyricsVisible = false
let lyricsBoundsTimer: ReturnType<typeof setTimeout> | null = null
let lyricsPlaybackState: LyricsPlaybackState = {
  songId: null,
  title: '',
  artist: '',
  currentTimeMs: 0,
  durationMs: 0,
  isPlaying: false
}
let scanInProgress = false
let cleanedUp = false
let tray: Tray | null = null
let isQuitting = false
let trayPlaybackState: TrayPlaybackState = {
  title: '',
  artist: '',
  isPlaying: false,
  hasSong: false
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm'
}

function getMusicRoot(): string {
  return store?.getSetting('musicRoot') ?? ''
}

function getCloseToTray(): boolean {
  const stored = store?.getSetting('closeToTray')
  return stored == null ? true : stored === '1'
}

function getBiliDownloadDir(): string {
  const custom = store?.getSetting('biliDownloadRoot')?.trim()
  if (custom) return path.resolve(custom)
  const root = getMusicRoot()
  return root ? path.join(root, 'Bilibili') : ''
}

function isBiliDownloadDirCustom(): boolean {
  return Boolean(store?.getSetting('biliDownloadRoot')?.trim())
}

async function ensureWritableDirectory(dir: string): Promise<void> {
  const resolved = path.resolve(dir)
  await fsp.mkdir(resolved, { recursive: true })
  const stat = await fsp.stat(resolved)
  if (!stat.isDirectory()) throw new Error('选择的路径不是文件夹')
  await fsp.access(resolved, fs.constants.W_OK)
}

const FALLBACK_DEVELOPMENT_INFO: DevelopmentInfo = {
  productName: 'DS音乐播放器',
  abbreviation: 'DSM',
  version: app.getVersion(),
  basedOnVersion: '0.9.0',
  originalDeveloper: 'DeepSeek',
  developmentRole: 'AI 协作开发（主要开发）',
  maintainer: 'tan90114514',
  maintainerUrl: 'https://github.com/tan90114514',
  aiTools: ['DeepSeek'],
  developmentDate: '2026-11-13',
  license: 'MIT',
  notice: '衍生版本请保留 DEVELOPMENT.md 和 NOTICE.md，并补充衍生开发记录。'
}

let developmentInfoCache: DevelopmentInfo | null = null

function getDevelopmentInfo(): DevelopmentInfo {
  if (developmentInfoCache) return developmentInfoCache
  try {
    const raw = fs.readFileSync(path.join(app.getAppPath(), 'build-info.json'), 'utf8')
    const parsed = JSON.parse(raw) as DevelopmentInfo
    developmentInfoCache = {
      ...FALLBACK_DEVELOPMENT_INFO,
      ...parsed,
      aiTools: Array.isArray(parsed.aiTools) && parsed.aiTools.length > 0
        ? parsed.aiTools.map(String)
        : FALLBACK_DEVELOPMENT_INFO.aiTools
    }
    return developmentInfoCache
  } catch {
    developmentInfoCache = FALLBACK_DEVELOPMENT_INFO
    return developmentInfoCache
  }
}

function getBridgePort(): number {
  const stored = Number(store?.getSetting('bridgePort') ?? '')
  return Number.isInteger(stored) && stored >= 1024 && stored <= 65535
    ? stored
    : DEFAULT_BRIDGE_PORT
}

function getBridgeStatus() {
  return (
    bridge?.getStatus() ?? {
      running: false,
      port: getBridgePort(),
      tokenConfigured: store ? hasBridgeToken(store) : false,
      error: null
    }
  )
}

async function restartBridge(port: number): Promise<void> {
  if (!biliService) return
  if (bridge) {
    await bridge.stop()
    bridge = null
  }
  const server = new BridgeServer(biliService, {
    port,
    getToken: () => (store ? getBridgeToken(store) : null),
    tokenConfigured: () => (store ? hasBridgeToken(store) : false)
  })
  bridge = server
  await server.start()
}

function buildBootstrap(): AppBootstrap {
  if (!store || !biliService) throw new Error('应用尚未初始化')
  return {
    appVersion: app.getVersion(),
    developmentInfo: getDevelopmentInfo(),
    settings: {
      musicRoot: getMusicRoot(),
      bridgePort: getBridgePort(),
      biliDownloadDir: getBiliDownloadDir(),
      biliDownloadDirIsCustom: isBiliDownloadDirCustom(),
      closeToTray: getCloseToTray()
    },
    bridge: getBridgeStatus(),
    playlists: listPlaylists(store),
    categories: listCategories(store),
    jobs: biliService.getJobs()
  }
}

function sendScanProgress(progress: ScanProgress): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('scan:progress', progress)
  }
}

function defaultLyricsBounds(): { x: number; y: number; width: number; height: number } {
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.min(920, Math.max(560, area.width - 160))
  const height = 176
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + area.height - height - 42,
    width,
    height
  }
}

function lyricsBoundsAreVisible(bounds: { x: number; y: number; width: number; height: number }): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    const overlapX = Math.max(
      0,
      Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
    )
    const overlapY = Math.max(
      0,
      Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
    )
    return overlapX >= 120 && overlapY >= 70
  })
}

function getSavedLyricsBounds(): {
  x: number
  y: number
  width: number
  height: number
} {
  const fallback = defaultLyricsBounds()
  const raw = store?.getSetting('lyricsWindowBounds')
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw) as {
      x?: number
      y?: number
      width?: number
      height?: number
    }
    if (
      !Number.isFinite(parsed.x) ||
      !Number.isFinite(parsed.y) ||
      !Number.isFinite(parsed.width) ||
      !Number.isFinite(parsed.height)
    ) {
      return fallback
    }
    const bounds = {
      x: Math.round(parsed.x as number),
      y: Math.round(parsed.y as number),
      width: Math.max(460, Math.min(1800, Math.round(parsed.width as number))),
      height: Math.max(120, Math.min(600, Math.round(parsed.height as number)))
    }
    return lyricsBoundsAreVisible(bounds) ? bounds : fallback
  } catch {
    return fallback
  }
}

function scheduleSaveLyricsBounds(): void {
  if (lyricsBoundsTimer) clearTimeout(lyricsBoundsTimer)
  lyricsBoundsTimer = setTimeout(() => {
    lyricsBoundsTimer = null
    if (!lyricsWindow || lyricsWindow.isDestroyed() || !store) return
    try {
      store.setSetting('lyricsWindowBounds', JSON.stringify(lyricsWindow.getBounds()))
      store.save()
    } catch {
      // Window bounds are a convenience; a failed save must not break playback.
    }
  }, 350)
}

function notifyLyricsVisibility(visible: boolean): void {
  lyricsVisible = visible
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('lyrics:visibility', visible)
  }
  updateTrayMenu()
}

function createLyricsWindow(): BrowserWindow {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) return lyricsWindow
  const bounds = getSavedLyricsBounds()
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 460,
    minHeight: 120,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: '桌面歌词',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })
  lyricsWindow = win
  win.setMenuBarVisibility(false)
  win.setAlwaysOnTop(true)

  win.once('ready-to-show', () => {
    if (lyricsVisible) win.showInactive()
  })
  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed()) win.webContents.send('lyrics:playback', lyricsPlaybackState)
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('moved', scheduleSaveLyricsBounds)
  win.on('resize', scheduleSaveLyricsBounds)
  win.on('closed', () => {
    lyricsWindow = null
    notifyLyricsVisibility(false)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl}#lyrics`).catch((error) => bootLog(`lyrics loadURL failed: ${String(error)}`))
  } else {
    void win
      .loadFile(getRendererHtmlPath(), { hash: 'lyrics' })
      .catch((error) => bootLog(`lyrics loadFile failed: ${String(error)}`))
  }
  return win
}

function showLyricsWindow(): boolean {
  lyricsVisible = true
  const win = createLyricsWindow()
  win.setAlwaysOnTop(true)
  win.showInactive()
  win.webContents.send('lyrics:playback', lyricsPlaybackState)
  notifyLyricsVisibility(true)
  return true
}

function hideLyricsWindow(): boolean {
  lyricsVisible = false
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.hide()
    scheduleSaveLyricsBounds()
  }
  notifyLyricsVisibility(false)
  return false
}

function toggleLyricsWindow(): boolean {
  return lyricsVisible ? hideLyricsWindow() : showLyricsWindow()
}

function registerIpc(): void {
  ipcMain.handle('app:bootstrap', () => buildBootstrap())

  ipcMain.handle('music:chooseRoot', async () => {
    if (!mainWindow) throw new Error('窗口尚未创建')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择音乐文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    const root = path.resolve(result.filePaths[0])
    try {
      await fsp.access(root, fs.constants.R_OK)
    } catch {
      throw new Error(`无法读取这个文件夹，请检查 Windows 权限：${root}`)
    }
    if (!store) throw new Error('数据库未初始化')
    store.setSetting('musicRoot', root)
    store.save()
    return { canceled: false, root }
  })

  ipcMain.handle('library:scan', async () => {
    if (!store) throw new Error('数据库未初始化')
    if (scanInProgress) throw new Error('已有扫描正在进行')
    const root = getMusicRoot()
    if (!root) throw new Error('请先选择音乐文件夹')
    scanInProgress = true
    try {
      return await scanLibrary(store, root, sendScanProgress)
    } finally {
      scanInProgress = false
    }
  })

  ipcMain.handle('library:importPlaylist', async () => {
    if (!store || !mainWindow) throw new Error('应用尚未初始化')
    const root = getMusicRoot()
    if (!root) throw new Error('请先选择音乐文件夹')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入歌单',
      properties: ['openFile'],
      filters: [
        { name: '歌单文件', extensions: ['m3u', 'm3u8', 'csv', 'json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return importPlaylistFile(store, result.filePaths[0], root)
  })

  ipcMain.handle('library:playlistItems', (_event, playlistId: number) => {
    if (!store) throw new Error('数据库未初始化')
    return getPlaylistItems(store, Number(playlistId))
  })

  ipcMain.handle('library:createPlaylist', (_event, name: string) => {
    if (!store) throw new Error('数据库未初始化')
    return createPlaylist(store, String(name ?? ''))
  })

  ipcMain.handle('library:renamePlaylist', (_event, playlistId: number, name: string) => {
    if (!store) throw new Error('数据库未初始化')
    renamePlaylist(store, Number(playlistId), String(name ?? ''))
  })

  ipcMain.handle('library:deletePlaylist', (_event, playlistId: number) => {
    if (!store) throw new Error('数据库未初始化')
    deletePlaylist(store, Number(playlistId))
  })

  ipcMain.handle(
    'library:addSongsToPlaylist',
    (_event, playlistId: number, songIds: number[]) => {
      if (!store) throw new Error('数据库未初始化')
      if (!Array.isArray(songIds)) throw new Error('歌曲参数不合法')
      return addSongsToPlaylist(store, Number(playlistId), songIds)
    }
  )

  ipcMain.handle(
    'library:removePlaylistItems',
    (_event, playlistId: number, itemIds: number[]) => {
      if (!store) throw new Error('数据库未初始化')
      if (!Array.isArray(itemIds)) throw new Error('歌单条目参数不合法')
      return removePlaylistItems(store, Number(playlistId), itemIds)
    }
  )

  ipcMain.handle('library:rematchPlaylist', (_event, playlistId: number) => {
    if (!store) throw new Error('数据库未初始化')
    const result = rematchPlaylistItems(store, Number(playlistId))
    store.save()
    return result
  })

  ipcMain.handle(
    'library:matchPlaylistItem',
    (_event, playlistId: number, itemId: number, songId: number) => {
      if (!store) throw new Error('数据库未初始化')
      setPlaylistItemManualMatch(
        store,
        Number(playlistId),
        Number(itemId),
        Number(songId)
      )
      store.save()
    }
  )

  ipcMain.handle('library:chooseLocalAudioFiles', async () => {
    if (!mainWindow) throw new Error('窗口尚未创建')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要导入的本地歌曲',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '音频文件', extensions: [...AUDIO_EXTENSIONS].map((ext) => ext.slice(1)) },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(
    'library:importLocalFiles',
    async (
      _event,
      raw: {
        providerId?: string
        categoryId?: number | null
        newCategoryName?: string
        files?: string[]
      }
    ) => {
      if (!store) throw new Error('数据库未初始化')
      if (!Array.isArray(raw?.files) || raw.files.length === 0) {
        throw new Error('没有选择要导入的文件')
      }
      const provider = getMediaSiteProvider(String(raw.providerId ?? 'bilibili'))
      let categoryId =
        raw.categoryId == null || Number(raw.categoryId) <= 0
          ? null
          : Number(raw.categoryId)
      if (categoryId == null) {
        const name = String(raw.newCategoryName ?? '').trim()
        if (!name) throw new Error('请选择或新建一个收藏夹分类')
        categoryId = ensureCategory(
          store,
          provider.categoryKind,
          `manual:${normalizeText(name)}`,
          name
        )
      }
      const result = await provider.importLocalFiles(
        store,
        getMusicRoot(),
        categoryId,
        raw.files.map(String)
      )
      store.save()
      return { ...result, categoryId }
    }
  )

  ipcMain.handle('library:createBiliCategory', (_event, name: string) => {
    if (!store) throw new Error('数据库未初始化')
    const id = createBiliCategory(store, String(name ?? ''))
    store.save()
    return id
  })

  ipcMain.handle('library:getSongBiliCategory', (_event, songId: number) => {
    if (!store) throw new Error('数据库未初始化')
    return getSongBiliCategory(store, Number(songId))
  })

  ipcMain.handle(
    'library:setSongBiliCategory',
    (_event, songId: number, categoryId: number | null) => {
      if (!store) throw new Error('数据库未初始化')
      setSongBiliCategory(
        store,
        Number(songId),
        categoryId == null ? null : Number(categoryId)
      )
      store.save()
    }
  )

  ipcMain.handle('library:categorySongs', (_event, categoryId: number) => {
    if (!store) throw new Error('数据库未初始化')
    return getCategorySongs(store, Number(categoryId))
  })

  ipcMain.handle('library:songsByCategories', (_event, categoryIds: number[]) => {
    if (!store) throw new Error('数据库未初始化')
    if (!Array.isArray(categoryIds)) throw new Error('分类参数不合法')
    return getSongsByCategories(store, categoryIds)
  })

  ipcMain.handle('library:allSongs', () => {
    if (!store) throw new Error('数据库未初始化')
    return getAllSongs(store)
  })

  ipcMain.handle('library:deleteSongs', async (_event, songIds: unknown, deleteFiles: unknown) => {
    if (!store) throw new Error('数据库未初始化')
    if (scanInProgress) throw new Error('正在扫描音乐文件夹，请稍后再删除')
    return deleteSongs(store, getMusicRoot(), songIds, Boolean(deleteFiles))
  })

  ipcMain.handle('library:chooseSongMoveDir', async () => {
    if (!store || !mainWindow) throw new Error('应用尚未初始化')
    const root = getMusicRoot()
    if (!root) throw new Error('请先选择音乐文件夹')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择移动目标文件夹（必须在音乐文件夹内）',
      defaultPath: root,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    const dir = path.resolve(result.filePaths[0])
    const resolvedRoot = path.resolve(root)
    if (dir !== resolvedRoot && !isInsideRoot(resolvedRoot, dir)) {
      throw new Error('移动目标必须位于当前音乐文件夹内')
    }
    await ensureWritableDirectory(dir)
    return { canceled: false, dir }
  })

  ipcMain.handle('library:moveSongs', async (_event, songIds: unknown, targetDir: unknown) => {
    if (!store) throw new Error('数据库未初始化')
    if (scanInProgress) throw new Error('正在扫描音乐文件夹，请稍后再移动')
    return moveSongs(store, getMusicRoot(), songIds, String(targetDir ?? ''))
  })

  ipcMain.handle('library:exportCsv', async (_event, playlistId: number) => {
    if (!store || !mainWindow) throw new Error('应用尚未初始化')
    const playlist = listPlaylists(store).find((item) => item.id === Number(playlistId))
    if (!playlist) throw new Error('歌单不存在')
    const safeName = playlist.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 60)
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出匹配结果',
      defaultPath: path.join(app.getPath('documents'), `${safeName || '歌单'}-匹配结果.csv`),
      filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    return exportPlaylistCsv(store, Number(playlistId), result.filePath)
  })

  ipcMain.handle('library:addTag', (_event, songId: number, tagName: string) => {
    if (!store) throw new Error('数据库未初始化')
    const categories = addTagToSong(store, Number(songId), String(tagName))
    return { categoryId: 0, categories }
  })

  ipcMain.handle('library:addTagToSongs', (_event, songIds: number[], tagName: string) => {
    if (!store) throw new Error('数据库未初始化')
    if (!Array.isArray(songIds)) throw new Error('歌曲参数不合法')
    return addTagToSongs(store, songIds, String(tagName))
  })

  ipcMain.handle('library:getSongTags', (_event, songId: number) => {
    if (!store) throw new Error('数据库未初始化')
    return getSongTags(store, Number(songId))
  })

  ipcMain.handle(
    'library:removeTagFromSong',
    (_event, songId: number, categoryId: number) => {
      if (!store) throw new Error('数据库未初始化')
      return removeTagFromSong(store, Number(songId), Number(categoryId))
    }
  )

  ipcMain.handle('library:renameTag', (_event, categoryId: number, name: string) => {
    if (!store) throw new Error('数据库未初始化')
    return renameTag(store, Number(categoryId), String(name ?? ''))
  })

  ipcMain.handle('library:deleteTag', (_event, categoryId: number) => {
    if (!store) throw new Error('数据库未初始化')
    return deleteTag(store, Number(categoryId))
  })

  ipcMain.handle('settings:chooseBiliDownloadDir', async () => {
    if (!store || !mainWindow) throw new Error('应用尚未初始化')
    const current = getBiliDownloadDir()
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择B站音频下载文件夹',
      defaultPath: current || undefined,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    const dir = path.resolve(result.filePaths[0])
    await ensureWritableDirectory(dir)
    store.setSetting('biliDownloadRoot', dir)
    store.save()
    return { canceled: false, dir }
  })

  ipcMain.handle('settings:resetBiliDownloadDir', () => {
    if (!store) throw new Error('应用尚未初始化')
    store.run("DELETE FROM settings WHERE key = 'biliDownloadRoot'")
    store.save()
    return getBiliDownloadDir()
  })

  ipcMain.handle('settings:openBiliDownloadDir', async () => {
    const dir = getBiliDownloadDir()
    if (!dir) throw new Error('还没有设置音乐文件夹或B站下载文件夹')
    await ensureWritableDirectory(dir)
    const error = await shell.openPath(dir)
    if (error) throw new Error(error)
  })

  ipcMain.handle('settings:getToken', () => (store ? getBridgeToken(store) ?? '' : ''))

  ipcMain.handle('settings:generateToken', () => {
    if (!store) throw new Error('数据库未初始化')
    return generateBridgeToken(store)
  })

  ipcMain.handle('settings:setBridgePort', async (_event, rawPort: number) => {
    if (!store) throw new Error('数据库未初始化')
    const port = Number(rawPort)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('端口必须是 1024–65535 之间的整数')
    }
    store.setSetting('bridgePort', String(port))
    store.save()
    await restartBridge(port)
    return getBridgeStatus()
  })

  ipcMain.handle('settings:bridgeStatus', () => getBridgeStatus())

  ipcMain.handle('settings:openExtensionFolder', async () => {
    const dir = getExtensionDir()
    if (!fs.existsSync(dir)) throw new Error(`插件目录不存在：${dir}`)
    const error = await shell.openPath(dir)
    if (error) throw new Error(error)
  })

  ipcMain.handle('settings:copyText', (_event, text: string) => {
    clipboard.writeText(String(text ?? ''))
  })

  ipcMain.handle('bili:jobs', () => {
    if (!biliService) throw new Error('应用尚未初始化')
    return biliService.getJobs()
  })

  ipcMain.handle('bili:retry', async (_event, jobId: string) => {
    if (!biliService) throw new Error('应用尚未初始化')
    await biliService.retryJob(String(jobId))
  })

  ipcMain.handle('bili:cancel', async (_event, jobId: string) => {
    if (!biliService) throw new Error('应用尚未初始化')
    await biliService.cancelJob(String(jobId))
    updateTrayMenu()
  })

  ipcMain.handle('settings:setCloseToTray', (_event, enabled: boolean) => {
    if (!store) throw new Error('数据库未初始化')
    store.setSetting('closeToTray', enabled ? '1' : '0')
    store.save()
    updateTrayMenu()
    return Boolean(enabled)
  })

  ipcMain.on('player:trayState', (_event, rawState: TrayPlaybackState) => {
    if (!rawState || typeof rawState !== 'object') return
    trayPlaybackState = {
      title: String(rawState.title ?? '').slice(0, 200),
      artist: String(rawState.artist ?? '').slice(0, 200),
      isPlaying: Boolean(rawState.isPlaying),
      hasSong: Boolean(rawState.hasSong)
    }
    updateTrayMenu()
  })

  ipcMain.handle('lyrics:toggle', () => toggleLyricsWindow())
  ipcMain.handle('lyrics:isVisible', () => lyricsVisible)
  ipcMain.handle('lyrics:hide', () => hideLyricsWindow())
  ipcMain.handle('lyrics:getPlayback', () => lyricsPlaybackState)

  ipcMain.on('lyrics:playback', (_event, rawState: LyricsPlaybackState) => {
    if (!rawState || typeof rawState !== 'object') return
    lyricsPlaybackState = {
      songId:
        rawState.songId == null || !Number.isFinite(Number(rawState.songId))
          ? null
          : Number(rawState.songId),
      title: String(rawState.title ?? ''),
      artist: String(rawState.artist ?? ''),
      currentTimeMs: Math.max(0, Number(rawState.currentTimeMs) || 0),
      durationMs: Math.max(0, Number(rawState.durationMs) || 0),
      isPlaying: Boolean(rawState.isPlaying)
    }
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.webContents.send('lyrics:playback', lyricsPlaybackState)
    }
  })

  ipcMain.handle('lyrics:get', async (_event, rawSongId: number) => {
    if (!store) throw new Error('数据库未初始化')
    const songId = Number(rawSongId)
    if (!Number.isInteger(songId) || songId <= 0) throw new Error('歌曲 ID 不合法')
    return getLyricsForSong(store, getMusicRoot(), songId)
  })

  ipcMain.handle('lyrics:chooseFile', async (_event, rawSongId: number) => {
    if (!store) throw new Error('数据库未初始化')
    const songId = Number(rawSongId)
    if (!Number.isInteger(songId) || songId <= 0) throw new Error('歌曲 ID 不合法')
    const parent = lyricsWindow ?? mainWindow
    if (!parent) throw new Error('窗口尚未创建')
    const result = await dialog.showOpenDialog(parent, {
      title: '选择歌词文件',
      properties: ['openFile'],
      filters: [
        { name: '歌词文件', extensions: ['lrc', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return setLyricsFile(store, songId, result.filePaths[0])
  })
}

function parseRange(
  header: string,
  size: number
): { start: number; end: number } | null | 'invalid' {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return 'invalid'
  let start: number
  let end: number
  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'invalid'
    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Number(rawEnd) : size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return 'invalid'
  }
  return { start, end: Math.min(end, size - 1) }
}

async function handleMusicRequest(request: Request): Promise<Response> {
  try {
    if (!store) return new Response('Not ready', { status: 503 })
    const url = new URL(request.url)
    const id = Number(url.pathname.replace(/^\//, ''))
    if (!Number.isInteger(id) || id <= 0) return new Response('Bad song id', { status: 400 })
    const song = store.get<{ path: string; available: number; source: string }>(
      'SELECT path, available, source FROM songs WHERE id = ?',
      [id]
    )
    if (!song || Number(song.available) !== 1) return new Response('Not found', { status: 404 })
    const filePath = path.resolve(String(song.path))
    if (song.source !== 'bilibili') {
      const root = getMusicRoot()
      if (!root || !isInsideRoot(root, filePath)) {
        return new Response('Outside music root', { status: 403 })
      }
    }
    const stat = await fsp.stat(filePath).catch(() => null)
    if (!stat || !stat.isFile()) return new Response('Not found', { status: 404 })
    const mime = MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    const size = stat.size
    const rangeHeader = request.headers.get('range')
    let range: { start: number; end: number } | null = null
    if (rangeHeader) {
      const parsed = parseRange(rangeHeader, size)
      if (parsed === 'invalid') {
        return new Response('Range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` }
        })
      }
      range = parsed
    }

    if (request.method === 'HEAD') {
      const headers: Record<string, string> = {
        'Accept-Ranges': 'bytes',
        'Content-Type': mime,
        'Content-Length': String(size)
      }
      return new Response(null, { status: 200, headers })
    }

    if (range) {
      const stream = fs.createReadStream(filePath, {
        start: range.start,
        end: range.end
      })
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Type': mime,
          'Content-Length': String(range.end - range.start + 1),
          'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
          'Cache-Control': 'no-store'
        }
      })
    }

    const stream = fs.createReadStream(filePath)
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Type': mime,
        'Content-Length': String(size),
        'Cache-Control': 'no-store'
      }
    })
  } catch (error) {
    logError('媒体协议读取失败', error)
    return new Response('Internal error', { status: 500 })
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  updateTrayMenu()
}

function toggleMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isVisible()) {
    mainWindow.hide()
    updateTrayMenu()
  } else {
    showMainWindow()
  }
}

function sendPlaybackCommand(command: PlaybackCommand): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('player:command', command)
}

function buildTrayMenu(): Menu {
  const visible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible())
  return Menu.buildFromTemplate([
    {
      label: visible ? '隐藏主窗口' : '显示主窗口',
      click: () => toggleMainWindow()
    },
    { type: 'separator' },
    {
      label: trayPlaybackState.isPlaying ? '暂停' : '播放',
      click: () => sendPlaybackCommand('play-pause')
    },
    {
      label: '上一首',
      enabled: trayPlaybackState.hasSong,
      click: () => sendPlaybackCommand('previous')
    },
    {
      label: '下一首',
      enabled: trayPlaybackState.hasSong,
      click: () => sendPlaybackCommand('next')
    },
    {
      label: '停止播放',
      enabled: trayPlaybackState.hasSong,
      click: () => sendPlaybackCommand('stop')
    },
    { type: 'separator' },
    {
      label: lyricsVisible ? '隐藏桌面歌词' : '显示桌面歌词',
      click: () => {
        toggleLyricsWindow()
        updateTrayMenu()
      }
    },
    { type: 'separator' },
    {
      label: '退出 DS音乐播放器',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
}

function updateTrayMenu(): void {
  if (!tray) return
  const title = trayPlaybackState.title.trim()
  const artist = trayPlaybackState.artist.trim()
  tray.setToolTip(
    title
      ? `DS音乐播放器\n${trayPlaybackState.isPlaying ? '播放中' : '已暂停'}：${title}${
          artist ? ` - ${artist}` : ''
        }`
      : 'DS音乐播放器'
  )
  tray.setContextMenu(buildTrayMenu())
}

function createTray(): void {
  if (tray) return
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray.png')
    : path.join(app.getAppPath(), 'build', 'icon.png')
  try {
    let image = nativeImage.createFromPath(iconPath)
    if (image.isEmpty()) {
      bootLog(`tray icon is empty: ${iconPath}`)
      return
    }
    image = image.resize({ width: 32, height: 32 })
    tray = new Tray(image)
    tray.setToolTip('DS音乐播放器')
    tray.on('click', () => toggleMainWindow())
    updateTrayMenu()
  } catch (error) {
    bootLog(`tray creation failed: ${String(error)}`)
    logError('创建系统托盘失败', error)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: '#101015',
    title: 'DS音乐播放器',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    updateTrayMenu()
  })

  mainWindow.on('show', () => updateTrayMenu())
  mainWindow.on('hide', () => updateTrayMenu())

  mainWindow.on('close', (event) => {
    if (!isQuitting && getCloseToTray()) {
      event.preventDefault()
      mainWindow?.hide()
      updateTrayMenu()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (mainWindow) {
      const current = mainWindow.webContents.getURL()
      if (targetUrl !== current) event.preventDefault()
    }
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    bootLog(`renderer gone: ${JSON.stringify(details)}`)
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    bootLog(`renderer load failed: ${code} ${description}`)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl).catch((error) => bootLog(`loadURL failed: ${String(error)}`))
  } else {
    void mainWindow
      .loadFile(getRendererHtmlPath())
      .catch((error) => bootLog(`loadFile failed: ${String(error)}`))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.destroy()
    updateTrayMenu()
  })
}

async function startApp(): Promise<void> {
  bootLog('startApp entered')
  if (!app.requestSingleInstanceLock()) {
    bootLog('single instance lock not acquired')
    app.quit()
    return
  }
  bootLog('single instance lock acquired')
  app.on('second-instance', () => {
    showMainWindow()
  })

  ensureAppDirs()
  bootLog('app dirs ensured')
  store = await DatabaseStore.open(getDbPath())
  bootLog('database opened')
  const storedPort = Number(store.getSetting('bridgePort') ?? '')
  if (!Number.isInteger(storedPort) || storedPort < 1024 || storedPort > 65535) {
    store.setSetting('bridgePort', String(DEFAULT_BRIDGE_PORT))
    store.save()
  }
  const testImportPath = process.env['LOCAL_MUSIC_PLAYER_TEST_IMPORT']
  if (testImportPath) {
    try {
      const result = await importPlaylistFile(store, testImportPath, getMusicRoot())
      bootLog(`test import ok: playlist=${result.playlistId}, total=${result.total}, matched=${result.matched}`)
    } catch (error) {
      bootLog(`test import failed: ${(error as Error).stack ?? String(error)}`)
    }
  }
  biliService = new BiliService(store, getMusicRoot, getBiliDownloadDir)
  biliService.init()
  registerIpc()
  bootLog('ipc registered')
  protocol.handle('music', (request) => handleMusicRequest(request))
  await restartBridge(getBridgePort())
  bootLog('bridge started')
  createWindow()
  createTray()
  bootLog('window created')
  logInfo('应用启动完成')
}

bootLog('waiting for app ready')
app.whenReady().then(() => {
  bootLog('app ready')
  void startApp().catch((error) => {
    bootLog(`startApp failed: ${(error as Error).stack ?? String(error)}`)
    logError('应用启动失败', error)
    dialog.showErrorBox(
      'DS音乐播放器启动失败',
      error instanceof Error ? error.message : String(error)
    )
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (isQuitting || !getCloseToTray()) app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  tray?.destroy()
  tray = null
  if (cleanedUp) return
  cleanedUp = true
  try {
    biliService?.shutdown()
    store?.close()
    void bridge?.stop()
  } catch (error) {
    logError('退出清理失败', error)
  }
})

Menu.setApplicationMenu(null)
