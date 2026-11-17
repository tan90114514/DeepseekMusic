import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppApi,
  LyricsData,
  LyricsPlaybackState,
  PlaybackCommand,
  ScanProgress,
  TrayPlaybackState
} from '../shared/types'

const api: AppApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  chooseMusicRoot: () => ipcRenderer.invoke('music:chooseRoot'),
  scanLibrary: () => ipcRenderer.invoke('library:scan'),
  importPlaylist: () => ipcRenderer.invoke('library:importPlaylist'),
  getPlaylistItems: (playlistId) => ipcRenderer.invoke('library:playlistItems', playlistId),
  createPlaylist: (name) => ipcRenderer.invoke('library:createPlaylist', name),
  renamePlaylist: (playlistId, name) =>
    ipcRenderer.invoke('library:renamePlaylist', playlistId, name),
  deletePlaylist: (playlistId) => ipcRenderer.invoke('library:deletePlaylist', playlistId),
  addSongsToPlaylist: (playlistId, songIds) =>
    ipcRenderer.invoke('library:addSongsToPlaylist', playlistId, songIds),
  removePlaylistItems: (playlistId, itemIds) =>
    ipcRenderer.invoke('library:removePlaylistItems', playlistId, itemIds),
  rematchPlaylist: (playlistId) => ipcRenderer.invoke('library:rematchPlaylist', playlistId),
  matchPlaylistItem: (playlistId, itemId, songId) =>
    ipcRenderer.invoke('library:matchPlaylistItem', playlistId, itemId, songId),
  getSongBiliCategory: (songId) => ipcRenderer.invoke('library:getSongBiliCategory', songId),
  setSongBiliCategory: (songId, categoryId) =>
    ipcRenderer.invoke('library:setSongBiliCategory', songId, categoryId),
  createBiliCategory: (name) => ipcRenderer.invoke('library:createBiliCategory', name),
  chooseLocalAudioFiles: () => ipcRenderer.invoke('library:chooseLocalAudioFiles'),
  importLocalFiles: (providerId, categoryId, newCategoryName, files) =>
    ipcRenderer.invoke('library:importLocalFiles', {
      providerId,
      categoryId,
      newCategoryName,
      files
    }),
  getCategorySongs: (categoryId) => ipcRenderer.invoke('library:categorySongs', categoryId),
  getSongsByCategories: (categoryIds) =>
    ipcRenderer.invoke('library:songsByCategories', categoryIds),
  getAllSongs: () => ipcRenderer.invoke('library:allSongs'),
  deleteSongs: (songIds, deleteFiles) =>
    ipcRenderer.invoke('library:deleteSongs', songIds, deleteFiles),
  chooseSongMoveDir: () => ipcRenderer.invoke('library:chooseSongMoveDir'),
  moveSongs: (songIds, targetDir) =>
    ipcRenderer.invoke('library:moveSongs', songIds, targetDir),
  exportPlaylistCsv: (playlistId) => ipcRenderer.invoke('library:exportCsv', playlistId),
  getToken: () => ipcRenderer.invoke('settings:getToken'),
  generateToken: () => ipcRenderer.invoke('settings:generateToken'),
  setBridgePort: (port) => ipcRenderer.invoke('settings:setBridgePort', port),
  getBridgeStatus: () => ipcRenderer.invoke('settings:bridgeStatus'),
  setCloseToTray: (enabled) => ipcRenderer.invoke('settings:setCloseToTray', enabled),
  onPlaybackCommand: (callback: (command: PlaybackCommand) => void) => {
    ipcRenderer.on('player:command', (_event, command: PlaybackCommand) => callback(command))
  },
  reportTrayPlaybackState: (state: TrayPlaybackState) => {
    ipcRenderer.send('player:trayState', state)
  },
  openExtensionFolder: () => ipcRenderer.invoke('settings:openExtensionFolder'),
  chooseBiliDownloadDir: () => ipcRenderer.invoke('settings:chooseBiliDownloadDir'),
  resetBiliDownloadDir: () => ipcRenderer.invoke('settings:resetBiliDownloadDir'),
  openBiliDownloadDir: () => ipcRenderer.invoke('settings:openBiliDownloadDir'),
  copyText: (text) => ipcRenderer.invoke('settings:copyText', text),
  getBiliJobs: () => ipcRenderer.invoke('bili:jobs'),
  retryBiliJob: (jobId) => ipcRenderer.invoke('bili:retry', jobId),
  cancelBiliJob: (jobId) => ipcRenderer.invoke('bili:cancel', jobId),
  addTag: (songId, tagName) => ipcRenderer.invoke('library:addTag', songId, tagName),
  addTagToSongs: (songIds, tagName) =>
    ipcRenderer.invoke('library:addTagToSongs', songIds, tagName),
  getSongTags: (songId) => ipcRenderer.invoke('library:getSongTags', songId),
  removeTagFromSong: (songId, categoryId) =>
    ipcRenderer.invoke('library:removeTagFromSong', songId, categoryId),
  renameTag: (categoryId, name) => ipcRenderer.invoke('library:renameTag', categoryId, name),
  deleteTag: (categoryId) => ipcRenderer.invoke('library:deleteTag', categoryId),
  onScanProgress: (callback: (progress: ScanProgress) => void) => {
    ipcRenderer.on('scan:progress', (_event, progress: ScanProgress) => callback(progress))
  },
  toggleDesktopLyrics: () => ipcRenderer.invoke('lyrics:toggle'),
  isDesktopLyricsVisible: () => ipcRenderer.invoke('lyrics:isVisible'),
  hideDesktopLyrics: () => ipcRenderer.invoke('lyrics:hide'),
  onDesktopLyricsVisibility: (callback: (visible: boolean) => void) => {
    ipcRenderer.on('lyrics:visibility', (_event, visible: boolean) => callback(Boolean(visible)))
  },
  reportLyricsPlayback: (state: LyricsPlaybackState) => {
    ipcRenderer.send('lyrics:playback', state)
  },
  getLyricsPlaybackState: () => ipcRenderer.invoke('lyrics:getPlayback'),
  onLyricsPlayback: (callback: (state: LyricsPlaybackState) => void) => {
    ipcRenderer.on('lyrics:playback', (_event, state: LyricsPlaybackState) => callback(state))
  },
  getLyricsForSong: (songId: number): Promise<LyricsData> =>
    ipcRenderer.invoke('lyrics:get', songId),
  chooseLyricsFile: (songId: number): Promise<LyricsData | null> =>
    ipcRenderer.invoke('lyrics:chooseFile', songId)
}

contextBridge.exposeInMainWorld('api', api)
