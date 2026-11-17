export const DEFAULT_BRIDGE_PORT = 39547
export const BRIDGE_PROTOCOL_VERSION = 1

export type MatchStatus = 'matched' | 'missing' | 'suspicious'
export type CategoryKind = 'folder' | 'genre' | 'tag' | 'bilibili'
export type BiliJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'interrupted'

export interface AppSettingsView {
  musicRoot: string
  bridgePort: number
  biliDownloadDir: string
  biliDownloadDirIsCustom: boolean
  closeToTray: boolean
}

export type PlaybackCommand = 'play-pause' | 'next' | 'previous' | 'stop'

export interface TrayPlaybackState {
  title: string
  artist: string
  isPlaying: boolean
  hasSong: boolean
}

export interface BridgeStatus {
  running: boolean
  port: number
  tokenConfigured: boolean
  error: string | null
}

export interface PlaylistSummary {
  id: number
  name: string
  format: string
  total: number
  matched: number
  missing: number
  suspicious: number
  createdAt: number
}

export interface PlaylistItemView {
  id: number
  position: number
  title: string
  artist: string
  album: string
  durationMs: number
  status: MatchStatus
  matchMethod: string | null
  note: string
  songId: number | null
  path: string
  available: boolean
}

export interface SongView {
  id: number
  title: string
  artist: string
  album: string
  durationMs: number
  genre: string
  path: string
  source: string
  bvid: string | null
  available: boolean
}

export interface CategoryView {
  id: number
  name: string
  kind: CategoryKind
  songCount: number
}

export interface DevelopmentInfo {
  productName: string
  abbreviation: string
  version: string
  basedOnVersion: string
  originalDeveloper: string
  developmentRole: string
  maintainer: string
  maintainerUrl: string
  aiTools: string[]
  developmentDate: string
  license: string
  notice: string
}

export interface AppBootstrap {
  appVersion: string
  developmentInfo: DevelopmentInfo
  settings: AppSettingsView
  bridge: BridgeStatus
  playlists: PlaylistSummary[]
  categories: CategoryView[]
  jobs: BiliJobView[]
}

export interface ScanProgress {
  phase: 'walking' | 'parsing' | 'matching' | 'done'
  processed: number
  total: number
  current: string
  message?: string
}

export interface ScanResult {
  scanned: number
  indexed: number
  errors: string[]
  elapsedMs: number
}

export interface ImportResult {
  playlistId: number
  name: string
  total: number
  matched: number
  missing: number
  suspicious: number
  warnings: string[]
}

export interface LocalImportResult {
  imported: number
  failed: number
  categoryId: number
  errors: string[]
}

export interface ExportResult {
  canceled: boolean
  path?: string
}

export interface BiliJobFailure {
  bvid: string
  title: string
  code: string
  message: string
  retryable: boolean
}

export interface BiliJobView {
  id: string
  requestId: string
  mediaId: string
  title: string
  status: BiliJobStatus
  total: number
  succeeded: number
  failed: number
  skipped: number
  pending: number
  createdAt: number
  updatedAt: number
  lastError: string
  currentTitle: string
  currentPhase: string
  failures: BiliJobFailure[]
}

export interface AddTagResult {
  categoryId: number
  categories: CategoryView[]
}

export interface LyricsLine {
  timeMs: number
  text: string
}

export interface LyricsData {
  found: boolean
  synced: boolean
  lines: LyricsLine[]
  sourcePath: string
  error?: string
}

export interface LyricsPlaybackState {
  songId: number | null
  title: string
  artist: string
  currentTimeMs: number
  durationMs: number
  isPlaying: boolean
}

export interface SongOperationFailure {
  songId: number
  title: string
  path: string
  error: string
}

export interface DeleteSongsResult {
  removed: number
  filesRemoved: number
  failures: SongOperationFailure[]
}

export interface MoveSongsResult {
  moved: number
  skipped: number
  failures: SongOperationFailure[]
  targetDir: string
}

export interface AppApi {
  bootstrap(): Promise<AppBootstrap>
  chooseMusicRoot(): Promise<{ canceled: boolean; root?: string }>
  scanLibrary(): Promise<ScanResult>
  importPlaylist(): Promise<ImportResult | null>
  getPlaylistItems(playlistId: number): Promise<PlaylistItemView[]>
  createPlaylist(name: string): Promise<PlaylistSummary>
  renamePlaylist(playlistId: number, name: string): Promise<void>
  deletePlaylist(playlistId: number): Promise<void>
  addSongsToPlaylist(
    playlistId: number,
    songIds: number[]
  ): Promise<{ added: number; skipped: number }>
  removePlaylistItems(
    playlistId: number,
    itemIds: number[]
  ): Promise<{ removed: number }>
  rematchPlaylist(
    playlistId: number
  ): Promise<{ matched: number; missing: number; suspicious: number }>
  matchPlaylistItem(playlistId: number, itemId: number, songId: number): Promise<void>
  getSongBiliCategory(songId: number): Promise<number | null>
  setSongBiliCategory(songId: number, categoryId: number | null): Promise<void>
  createBiliCategory(name: string): Promise<number>
  chooseLocalAudioFiles(): Promise<string[]>
  importLocalFiles(
    providerId: string,
    categoryId: number | null,
    newCategoryName: string,
    files: string[]
  ): Promise<LocalImportResult>
  getCategorySongs(categoryId: number): Promise<SongView[]>
  getSongsByCategories(categoryIds: number[]): Promise<SongView[]>
  getAllSongs(): Promise<SongView[]>
  deleteSongs(songIds: number[], deleteFiles: boolean): Promise<DeleteSongsResult>
  chooseSongMoveDir(): Promise<{ canceled: boolean; dir?: string }>
  moveSongs(songIds: number[], targetDir: string): Promise<MoveSongsResult>
  exportPlaylistCsv(playlistId: number): Promise<ExportResult>
  getToken(): Promise<string>
  generateToken(): Promise<string>
  setBridgePort(port: number): Promise<BridgeStatus>
  getBridgeStatus(): Promise<BridgeStatus>
  setCloseToTray(enabled: boolean): Promise<boolean>
  onPlaybackCommand(callback: (command: PlaybackCommand) => void): void
  reportTrayPlaybackState(state: TrayPlaybackState): void
  openExtensionFolder(): Promise<void>
  chooseBiliDownloadDir(): Promise<{ canceled: boolean; dir?: string }>
  resetBiliDownloadDir(): Promise<string>
  openBiliDownloadDir(): Promise<void>
  copyText(text: string): Promise<void>
  getBiliJobs(): Promise<BiliJobView[]>
  retryBiliJob(jobId: string): Promise<void>
  cancelBiliJob(jobId: string): Promise<void>
  addTag(songId: number, tagName: string): Promise<AddTagResult>
  addTagToSongs(songIds: number[], tagName: string): Promise<CategoryView[]>
  getSongTags(songId: number): Promise<CategoryView[]>
  removeTagFromSong(songId: number, categoryId: number): Promise<CategoryView[]>
  renameTag(categoryId: number, name: string): Promise<CategoryView[]>
  deleteTag(categoryId: number): Promise<CategoryView[]>
  onScanProgress(callback: (progress: ScanProgress) => void): void
  toggleDesktopLyrics(): Promise<boolean>
  isDesktopLyricsVisible(): Promise<boolean>
  hideDesktopLyrics(): Promise<void>
  onDesktopLyricsVisibility(callback: (visible: boolean) => void): void
  reportLyricsPlayback(state: LyricsPlaybackState): void
  getLyricsPlaybackState(): Promise<LyricsPlaybackState>
  onLyricsPlayback(callback: (state: LyricsPlaybackState) => void): void
  getLyricsForSong(songId: number): Promise<LyricsData>
  chooseLyricsFile(songId: number): Promise<LyricsData | null>
}
