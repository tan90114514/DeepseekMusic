import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppBootstrap,
  BiliJobView,
  CategoryKind,
  CategoryView,
  PlaybackCommand,
  PlaylistItemView,
  PlaylistSummary,
  ScanProgress,
  SongView
} from '../../shared/types'
import {
  applyTheme,
  readThemeConfig,
  type ThemeConfig,
  type ThemeMode
} from './theme'
import { PauseTransportIcon, PlayTransportIcon } from './TransportIcons'

type View =
  | { type: 'all' }
  | { type: 'playlist'; id: number }
  | { type: 'category'; id: number }
  | { type: 'jobs' }

const MODE_OPTIONS = [
  { value: 'sequential', label: '顺序播放' },
  { value: 'repeat-one', label: '单曲循环' },
  { value: 'shuffle-list', label: '列表随机' },
  { value: 'shuffle-category', label: '分类内随机' },
  { value: 'shuffle-all', label: '跨分类随机' }
] as const

type PlaybackMode = (typeof MODE_OPTIONS)[number]['value']
type ToastKind = 'info' | 'success' | 'error'
type SongSortKey = 'title' | 'artist' | 'album' | 'duration'
type SourceFilter = 'all' | 'local' | 'bilibili'
type PlaylistStatusFilter = 'all' | 'matched' | 'missing' | 'suspicious'
type PlaylistNameDialogState =
  | { mode: 'create' }
  | { mode: 'rename'; id: number; name: string }

const SONG_COLLATOR = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base'
})

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').trim()
}

interface ToastState {
  message: string
  kind: ToastKind
}

const STATUS_LABELS: Record<string, string> = {
  matched: '已下载',
  missing: '缺失',
  suspicious: '疑似',
  queued: '排队中',
  running: '下载中',
  completed: '已完成',
  partial: '部分失败',
  failed: '失败',
  interrupted: '已中断'
}

const CATEGORY_KIND_LABEL: Record<CategoryKind, string> = {
  folder: '文件夹',
  genre: '流派',
  tag: '标签',
  bilibili: 'B站收藏夹'
}

const CATEGORY_KIND_ORDER: CategoryKind[] = ['folder', 'genre', 'tag', 'bilibili']

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

function formatDurationMs(ms: number): string {
  return ms > 0 ? formatClock(ms / 1000) : '--:--'
}

function shuffleArray<T>(items: T[]): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function readStoredMode(): PlaybackMode {
  const saved = localStorage.getItem('playbackMode')
  if (MODE_OPTIONS.some((option) => option.value === saved)) return saved as PlaybackMode
  return 'sequential'
}

function readStoredVolume(): number {
  const value = Number(localStorage.getItem('playbackVolume') ?? '0.8')
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.8
}

function playlistItemToSong(item: PlaylistItemView): SongView | null {
  if (item.status !== 'matched' || !item.songId || !item.available) return null
  return {
    id: item.songId,
    title: item.title,
    artist: item.artist,
    album: item.album,
    durationMs: item.durationMs,
    genre: '',
    path: item.path,
    source: 'local',
    bvid: null,
    available: true
  }
}

function dedupeSongs(songs: SongView[]): SongView[] {
  const seen = new Set<number>()
  return songs.filter((song) => {
    if (seen.has(song.id)) return false
    seen.add(song.id)
    return true
  })
}

function folderNameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || filePath
}

export default function App(): React.JSX.Element {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null)
  const [loading, setLoading] = useState(true)
  const [fatalError, setFatalError] = useState('')
  const [view, setView] = useState<View>({ type: 'all' })
  const [playlistItems, setPlaylistItems] = useState<PlaylistItemView[]>([])
  const [categorySongs, setCategorySongs] = useState<SongView[]>([])
  const [allSongs, setAllSongs] = useState<SongView[]>([])
  const [viewLoading, setViewLoading] = useState(false)
  const [dataVersion, setDataVersion] = useState(0)
  const [selectedCategories, setSelectedCategories] = useState<Set<number>>(new Set())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)
  const [scanErrors, setScanErrors] = useState<string[]>([])
  const [operation, setOperation] = useState<'root' | 'import' | null>(null)
  const [tagTarget, setTagTarget] = useState<SongView | null>(null)
  const [tagBusy, setTagBusy] = useState(false)
  const [retryingJob, setRetryingJob] = useState<string | null>(null)
  const [cancellingJob, setCancellingJob] = useState<string | null>(null)
  const [lyricsVisible, setLyricsVisible] = useState(false)
  const [theme, setTheme] = useState<ThemeConfig>(readThemeConfig)
  const [manageMode, setManageMode] = useState(false)
  const [selectedSongIds, setSelectedSongIds] = useState<Set<number>>(new Set())
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteDiskFiles, setDeleteDiskFiles] = useState(true)
  const [songOpBusy, setSongOpBusy] = useState<'delete' | 'move' | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [songSort, setSongSort] = useState<SongSortKey>('title')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  const [playlistStatusFilter, setPlaylistStatusFilter] = useState<PlaylistStatusFilter>('all')
  const [playlistDialog, setPlaylistDialog] = useState<PlaylistNameDialogState | null>(null)
  const [playlistDialogBusy, setPlaylistDialogBusy] = useState(false)
  const [playlistDeleteTarget, setPlaylistDeleteTarget] = useState<PlaylistSummary | null>(null)
  const [playlistDeleteBusy, setPlaylistDeleteBusy] = useState(false)
  const [addToPlaylistOpen, setAddToPlaylistOpen] = useState(false)
  const [addToPlaylistBusy, setAddToPlaylistBusy] = useState(false)
  const [batchTagOpen, setBatchTagOpen] = useState(false)
  const [batchTagBusy, setBatchTagBusy] = useState(false)
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [rematchPlaylistBusy, setRematchPlaylistBusy] = useState(false)
  const [biliCategoryTarget, setBiliCategoryTarget] = useState<SongView | null>(null)
  const [biliCategoryBusy, setBiliCategoryBusy] = useState(false)
  const [manualMatchTarget, setManualMatchTarget] = useState<PlaylistItemView | null>(null)
  const [manualMatchBusy, setManualMatchBusy] = useState(false)
  const [biliImportOpen, setBiliImportOpen] = useState(false)
  const [biliImportBusy, setBiliImportBusy] = useState(false)

  const [currentSong, setCurrentSong] = useState<SongView | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentSeconds, setCurrentSeconds] = useState(0)
  const [durationSeconds, setDurationSeconds] = useState(0)
  const [volume, setVolume] = useState(readStoredVolume)
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>(readStoredMode)
  const [playerQueue, setPlayerQueue] = useState<SongView[]>([])
  const [playerQueueIndex, setPlayerQueueIndex] = useState(-1)
  const [queueOpen, setQueueOpen] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const queueRef = useRef<SongView[]>([])
  const queueIndexRef = useRef(-1)
  const currentSongRef = useRef<SongView | null>(null)
  const queueBuildToken = useRef(0)
  const scanningRef = useRef(false)
  const audioErrorNotifiedRef = useRef(false)
  const prevActiveJobsRef = useRef(false)
  const lastLyricsReportRef = useRef(0)
  const playbackCommandRef = useRef<(command: PlaybackCommand) => void>(() => undefined)
  const mediaActionsRef = useRef<{
    play: () => void
    pause: () => void
    next: () => void
    previous: () => void
    stop: () => void
    seek: (time: number) => void
  }>({
    play: () => undefined,
    pause: () => undefined,
    next: () => undefined,
    previous: () => undefined,
    stop: () => undefined,
    seek: () => undefined
  })

  const playlists = bootstrap?.playlists ?? []
  const categories = bootstrap?.categories ?? []
  const jobs = bootstrap?.jobs ?? []
  const activeJobs = jobs.filter((job) => job.status === 'running' || job.status === 'queued')

  const playlistSongs = useMemo(
    () =>
      playlistItems
        .map(playlistItemToSong)
        .filter((song): song is SongView => song !== null),
    [playlistItems]
  )

  const visibleSongs = useMemo(() => {
    if (view.type === 'all') return allSongs
    if (view.type === 'category') return categorySongs
    if (view.type === 'playlist') return playlistSongs
    return []
  }, [view.type, allSongs, categorySongs, playlistSongs])

  const displayedSongs = useMemo(() => {
    const query = normalizeSearch(searchQuery)
    const filtered = visibleSongs.filter((song) => {
      if (view.type !== 'playlist' && sourceFilter !== 'all' && song.source !== sourceFilter) {
        return false
      }
      if (!query) return true
      return normalizeSearch(
        `${song.title} ${song.artist} ${song.album} ${song.path} ${song.genre}`
      ).includes(query)
    })
    const direction = sortDirection === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      if (songSort === 'duration') {
        const diff = a.durationMs - b.durationMs
        if (diff !== 0) return diff * direction
      } else {
        const diff = SONG_COLLATOR.compare(a[songSort], b[songSort])
        if (diff !== 0) return diff * direction
      }
      return SONG_COLLATOR.compare(a.title, b.title)
    })
  }, [visibleSongs, searchQuery, sourceFilter, songSort, sortDirection, view.type])

  const displayedPlaylistItems = useMemo(() => {
    const query = normalizeSearch(searchQuery)
    return playlistItems.filter((item) => {
      if (playlistStatusFilter !== 'all' && item.status !== playlistStatusFilter) return false
      if (!query) return true
      return normalizeSearch(`${item.title} ${item.artist} ${item.album} ${item.path}`).includes(
        query
      )
    })
  }, [playlistItems, playlistStatusFilter, searchQuery])

  const playlistStatusCounts = useMemo(() => {
    return {
      all: playlistItems.length,
      matched: playlistItems.filter((item) => item.status === 'matched').length,
      missing: playlistItems.filter((item) => item.status === 'missing').length,
      suspicious: playlistItems.filter((item) => item.status === 'suspicious').length
    }
  }, [playlistItems])

  const playbackSourceSongs = useMemo(() => {
    if (view.type === 'playlist') {
      return displayedPlaylistItems
        .map(playlistItemToSong)
        .filter((song): song is SongView => song !== null)
    }
    return displayedSongs
  }, [view.type, displayedSongs, displayedPlaylistItems])

  const libraryFiltering =
    normalizeSearch(searchQuery).length > 0 ||
    (view.type === 'playlist' ? playlistStatusFilter !== 'all' : sourceFilter !== 'all')

  const selectedPlaylist =
    view.type === 'playlist' ? playlists.find((item) => item.id === view.id) : undefined
  const selectedCategory =
    view.type === 'category' ? categories.find((item) => item.id === view.id) : undefined
  const canManageSongs = view.type === 'all' || view.type === 'category'
  const selectedSongs = useMemo(
    () => displayedSongs.filter((song) => selectedSongIds.has(song.id)),
    [displayedSongs, selectedSongIds]
  )
  const allVisibleSelected =
    displayedSongs.length > 0 && displayedSongs.every((song) => selectedSongIds.has(song.id))

  const viewTitle =
    view.type === 'all'
      ? '全部歌曲'
      : view.type === 'jobs'
        ? 'B站下载任务'
        : view.type === 'playlist'
          ? selectedPlaylist?.name ?? '歌单'
          : selectedCategory?.name ?? '分类'

  const viewSubtitle =
    view.type === 'all'
      ? `${allSongs.length} 首本地歌曲`
      : view.type === 'jobs'
        ? `${activeJobs.length > 0 ? `${activeJobs.length} 个任务执行中` : '插件发来的任务会显示在这里'}`
        : view.type === 'playlist' && selectedPlaylist
          ? `已下载 ${selectedPlaylist.matched} · 缺失 ${selectedPlaylist.missing} · 疑似 ${selectedPlaylist.suspicious}`
          : `${categorySongs.length} 首歌曲`

  const groupedCategories = useMemo(() => {
    const grouped: Record<CategoryKind, CategoryView[]> = {
      folder: [],
      genre: [],
      tag: [],
      bilibili: []
    }
    for (const category of categories) grouped[category.kind].push(category)
    return grouped
  }, [categories])

  const notify = (message: string, kind: ToastKind = 'info'): void => {
    setToast({ message, kind })
  }

  const pruneSelectedCategories = (nextCategories: CategoryView[]): void => {
    const valid = new Set(nextCategories.map((category) => category.id))
    setSelectedCategories((previous) => {
      const next = new Set([...previous].filter((id) => valid.has(id)))
      return next.size === previous.size ? previous : next
    })
  }

  async function loadInitial(): Promise<void> {
    setLoading(true)
    setFatalError('')
    try {
      const data = await window.api.bootstrap()
      setBootstrap(data)
      pruneSelectedCategories(data.categories)
    } catch (error) {
      setFatalError(errorText(error))
    } finally {
      setLoading(false)
    }
  }

  async function refreshBootstrap(silent = false): Promise<AppBootstrap | null> {
    try {
      const data = await window.api.bootstrap()
      setBootstrap(data)
      pruneSelectedCategories(data.categories)
      return data
    } catch (error) {
      if (!silent) notify(errorText(error), 'error')
      return null
    }
  }

  useEffect(() => {
    void loadInitial()
  }, [])

  useEffect(() => {
    window.api.onScanProgress((progress) => {
      setScanProgress(progress)
    })
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 6500)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const audio = audioRef.current
    if (audio) audio.volume = volume
    localStorage.setItem('playbackVolume', String(volume))
  }, [volume])

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    setManageMode(false)
    setSelectedSongIds(new Set())
    setDeleteDialogOpen(false)
  }, [view])

  useEffect(() => {
    if (!manageMode) return
    setSelectedSongIds((previous) => {
      const visible = new Set(displayedSongs.map((song) => song.id))
      const next = new Set([...previous].filter((id) => visible.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [displayedSongs, manageMode])

  useEffect(() => {
    if (!bootstrap) return
    const shouldPoll = view.type === 'jobs' || activeJobs.length > 0
    if (!shouldPoll) return
    let cancelled = false
    let timer = 0

    const tick = async (): Promise<void> => {
      try {
        const nextJobs = await window.api.getBiliJobs()
        if (cancelled) return
        const activeNow = nextJobs.some(
          (job) => job.status === 'queued' || job.status === 'running'
        )
        setBootstrap((previous) => (previous ? { ...previous, jobs: nextJobs } : previous))
        if (prevActiveJobsRef.current && !activeNow) {
          try {
            const fresh = await window.api.bootstrap()
            if (cancelled) return
            setBootstrap(fresh)
            pruneSelectedCategories(fresh.categories)
            setDataVersion((value) => value + 1)
          } catch {
            // The next manual refresh will pick up the library changes.
          }
        }
        prevActiveJobsRef.current = activeNow
      } catch {
        // Polling failures are silent; the visible status remains usable.
      }
    }

    void tick()
    timer = window.setInterval(
      () => {
        void tick()
      },
      view.type === 'jobs' ? 1800 : 2600
    )
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [view.type, activeJobs.length > 0, Boolean(bootstrap)])

  useEffect(() => {
    if (!bootstrap || view.type === 'jobs') return
    let cancelled = false
    setViewLoading(true)
    const load = async (): Promise<void> => {
      try {
        if (view.type === 'all') {
          const songs = await window.api.getAllSongs()
          if (!cancelled) setAllSongs(songs)
        } else if (view.type === 'playlist') {
          const items = await window.api.getPlaylistItems(view.id)
          if (!cancelled) setPlaylistItems(items)
        } else if (view.type === 'category') {
          const songs = await window.api.getCategorySongs(view.id)
          if (!cancelled) setCategorySongs(songs)
        }
      } catch (error) {
        if (!cancelled) notify(errorText(error), 'error')
      } finally {
        if (!cancelled) setViewLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [view, dataVersion, bootstrap?.settings.musicRoot])

  useEffect(() => {
    const audio = audioRef.current
    return () => {
      audio?.pause()
    }
  }, [])

  useEffect(() => {
    let active = true
    window.api
      .isDesktopLyricsVisible()
      .then((visible) => {
        if (active) setLyricsVisible(visible)
      })
      .catch(() => undefined)
    window.api.onDesktopLyricsVisibility((visible) => {
      setLyricsVisible(visible)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    window.api.onPlaybackCommand((command) => playbackCommandRef.current(command))
  }, [])

  useEffect(() => {
    window.api.reportTrayPlaybackState({
      title: currentSong?.title ?? '',
      artist: currentSong?.artist ?? '',
      isPlaying,
      hasSong: Boolean(currentSong)
    })
  }, [currentSong, isPlaying])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const session = navigator.mediaSession
    const setHandler = (
      action: MediaSessionAction,
      handler: ((details: MediaSessionActionDetails) => void) | null
    ): void => {
      try {
        session.setActionHandler(action, handler)
      } catch {
        // Some Chromium builds do not support every media action.
      }
    }

    setHandler('play', () => mediaActionsRef.current.play())
    setHandler('pause', () => mediaActionsRef.current.pause())
    setHandler('nexttrack', () => mediaActionsRef.current.next())
    setHandler('previoustrack', () => mediaActionsRef.current.previous())
    setHandler('stop', () => mediaActionsRef.current.stop())
    setHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') mediaActionsRef.current.seek(details.seekTime)
    })

    return () => {
      for (const action of ['play', 'pause', 'nexttrack', 'previoustrack', 'stop', 'seekto'] as MediaSessionAction[]) {
        setHandler(action, null)
      }
    }
  }, [])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const session = navigator.mediaSession
    if (!currentSong) {
      session.metadata = null
      session.playbackState = 'none'
      return
    }
    try {
      if (typeof MediaMetadata !== 'undefined') {
        session.metadata = new MediaMetadata({
          title: currentSong.title,
          artist: currentSong.artist || '未知歌手',
          album: currentSong.album || 'DS音乐播放器'
        })
      }
    } catch {
      // Metadata is optional; playback continues without system metadata.
    }
    session.playbackState = isPlaying ? 'playing' : 'paused'
  }, [currentSong, isPlaying])

  useEffect(() => {
    if (!('mediaSession' in navigator) || durationSeconds <= 0) return
    try {
      navigator.mediaSession.setPositionState({
        duration: durationSeconds,
        position: Math.min(currentSeconds, durationSeconds),
        playbackRate: 1
      })
    } catch {
      // Position reporting is optional.
    }
  }, [currentSeconds, durationSeconds])

  function reportLyricsPlayback(
    force = false,
    override?: { song?: SongView | null; currentTimeMs?: number; isPlaying?: boolean }
  ): void {
    const now = Date.now()
    if (!force && now - lastLyricsReportRef.current < 280) return
    lastLyricsReportRef.current = now
    const song = override?.song !== undefined ? override.song : currentSongRef.current
    const audio = audioRef.current
    const durationMs =
      audio && Number.isFinite(audio.duration) && audio.duration > 0
        ? Math.round(audio.duration * 1000)
        : song?.durationMs ?? 0
    try {
      window.api.reportLyricsPlayback({
        songId: song?.id ?? null,
        title: song?.title ?? '',
        artist: song?.artist ?? '',
        currentTimeMs:
          override?.currentTimeMs ??
          (audio && Number.isFinite(audio.currentTime) ? Math.round(audio.currentTime * 1000) : 0),
        durationMs,
        isPlaying:
          override?.isPlaying ??
          (audio ? !audio.paused && !audio.ended : false)
      })
    } catch {
      // Desktop lyrics are optional; never interrupt playback for this.
    }
  }

  async function toggleDesktopLyrics(): Promise<void> {
    try {
      const visible = await window.api.toggleDesktopLyrics()
      setLyricsVisible(visible)
      if (visible) reportLyricsPlayback(true)
    } catch (error) {
      notify(`桌面歌词打开失败：${errorText(error)}`, 'error')
    }
  }

  const sourceSongs = (): SongView[] => {
    if (playbackSourceSongs.length > 0) return playbackSourceSongs
    return currentSongRef.current ? [currentSongRef.current] : []
  }

  async function calculateQueue(
    mode: PlaybackMode,
    song: SongView,
    source: SongView[]
  ): Promise<{ songs: SongView[]; index: number }> {
    let pool: SongView[] = source
    try {
      if (mode === 'shuffle-all') {
        pool = await window.api.getAllSongs()
      } else if (mode === 'shuffle-category') {
        let ids = [...selectedCategories]
        if (ids.length === 0 && view.type === 'category') ids = [view.id]
        if (ids.length === 0) ids = categories.map((category) => category.id)
        pool = ids.length > 0 ? await window.api.getSongsByCategories(ids) : source
      }
    } catch {
      pool = source
    }
    pool = dedupeSongs(pool.length > 0 ? pool : source)
    if (pool.length === 0) pool = [song]
    if (mode === 'sequential' || mode === 'repeat-one') {
      const index = pool.findIndex((item) => item.id === song.id)
      if (index >= 0) return { songs: pool, index }
      return { songs: [song, ...pool], index: 0 }
    }
    const rest = shuffleArray(pool.filter((item) => item.id !== song.id))
    return { songs: [song, ...rest], index: 0 }
  }

  function commitQueue(songs: SongView[], index: number): void {
    queueRef.current = songs
    queueIndexRef.current = index
    setPlayerQueue(songs)
    setPlayerQueueIndex(index)
  }

  function playAt(index: number, songs: SongView[]): void {
    const song = songs[index]
    if (!song) return
    const audio = audioRef.current
    queueBuildToken.current += 1
    commitQueue(songs, index)
    currentSongRef.current = song
    audioErrorNotifiedRef.current = false
    setCurrentSong(song)
    setCurrentSeconds(0)
    setDurationSeconds(song.durationMs > 0 ? song.durationMs / 1000 : 0)
    reportLyricsPlayback(true, { song, currentTimeMs: 0 })
    if (!audio) return
    audio.src = `music://song/${song.id}`
    const promise = audio.play()
    if (promise) {
      promise.catch(() => {
        notify('无法开始播放，请检查文件是否仍在磁盘上。', 'error')
      })
    }
  }

  async function refreshQueueForMode(
    mode: PlaybackMode,
    song: SongView,
    source: SongView[]
  ): Promise<void> {
    const token = queueBuildToken.current + 1
    queueBuildToken.current = token
    const result = await calculateQueue(mode, song, source)
    if (token !== queueBuildToken.current || currentSongRef.current?.id !== song.id) return
    commitQueue(result.songs, result.index)
  }

  function startPlayback(song: SongView): void {
    const source = playbackSourceSongs.length > 0 ? playbackSourceSongs : [song]
    if (playbackMode === 'sequential' || playbackMode === 'repeat-one') {
      const queue = source.some((item) => item.id === song.id)
        ? [...source]
        : [song, ...source]
      const index = Math.max(0, queue.findIndex((item) => item.id === song.id))
      playAt(index, queue)
      return
    }
    if (playbackMode === 'shuffle-list') {
      const queue = [song, ...shuffleArray(source.filter((item) => item.id !== song.id))]
      playAt(0, queue)
      return
    }
    playAt(0, [song])
    void refreshQueueForMode(playbackMode, song, source)
  }

  function queuePlayNext(song: SongView): void {
    const current = currentSongRef.current
    if (!current) {
      playAt(0, [song])
      return
    }
    if (current.id === song.id) {
      notify('这首歌正在播放。', 'info')
      return
    }
    let next = queueRef.current.length > 0 ? [...queueRef.current] : [current]
    if (!next.some((item) => item.id === current.id)) next = [current, ...next]
    const existingIndex = next.findIndex((item) => item.id === song.id)
    if (existingIndex >= 0) next.splice(existingIndex, 1)
    const currentIndex = next.findIndex((item) => item.id === current.id)
    const insertAt = currentIndex >= 0 ? currentIndex + 1 : next.length
    next.splice(insertAt, 0, song)
    commitQueue(next, currentIndex >= 0 ? currentIndex : 0)
    notify(`“${song.title}”将在当前歌曲后播放。`, 'success')
  }

  function queueAppend(song: SongView): void {
    const current = currentSongRef.current
    if (!current) {
      playAt(0, [song])
      return
    }
    let next = queueRef.current.length > 0 ? [...queueRef.current] : [current]
    if (!next.some((item) => item.id === current.id)) next = [current, ...next]
    if (next.some((item) => item.id === song.id)) {
      notify('这首歌已经在播放队列里。', 'info')
      return
    }
    const currentIndex = next.findIndex((item) => item.id === current.id)
    next.push(song)
    commitQueue(next, currentIndex >= 0 ? currentIndex : 0)
    notify(`已加入播放队列：${song.title}`, 'success')
  }

  function removeQueueItem(index: number): void {
    if (index === queueIndexRef.current) return
    const current = currentSongRef.current
    const next = queueRef.current.filter((_, itemIndex) => itemIndex !== index)
    const nextIndex = current ? next.findIndex((item) => item.id === current.id) : -1
    commitQueue(next, nextIndex)
  }

  function clearQueueAfterCurrent(): void {
    const current = currentSongRef.current
    if (!current) {
      commitQueue([], -1)
      return
    }
    const index = queueRef.current.findIndex((item) => item.id === current.id)
    const next = index >= 0 ? queueRef.current.slice(0, index + 1) : [current]
    commitQueue(next, index >= 0 ? index : 0)
    notify('已清空当前歌曲后面的队列。', 'info')
  }

  function toggleSongSelection(songId: number): void {
    setSelectedSongIds((previous) => {
      const next = new Set(previous)
      if (next.has(songId)) next.delete(songId)
      else next.add(songId)
      return next
    })
  }

  function toggleAllVisibleSongs(): void {
    setSelectedSongIds(() => {
      if (allVisibleSelected) return new Set()
      return new Set(displayedSongs.map((song) => song.id))
    })
  }

  function toggleManageMode(): void {
    setManageMode((previous) => {
      if (previous) setSelectedSongIds(new Set())
      return !previous
    })
  }

  function stopPlaybackForRemovedSongs(ids: Set<number>): boolean {
    const current = currentSongRef.current
    const removedCurrent = Boolean(current && ids.has(current.id))
    const audio = audioRef.current
    if (removedCurrent) {
      audio?.pause()
      if (audio) {
        audio.removeAttribute('src')
        audio.load()
      }
      currentSongRef.current = null
      setCurrentSong(null)
      setIsPlaying(false)
      setCurrentSeconds(0)
      setDurationSeconds(0)
      commitQueue([], -1)
      reportLyricsPlayback(true, { song: null, currentTimeMs: 0, isPlaying: false })
      return true
    }
    const nextQueue = queueRef.current.filter((song) => !ids.has(song.id))
    const nextIndex = current
      ? nextQueue.findIndex((song) => song.id === current.id)
      : -1
    commitQueue(nextQueue, nextIndex)
    return false
  }

  async function handleDeleteSongs(): Promise<void> {
    if (selectedSongIds.size === 0 || songOpBusy) return
    const ids = new Set(selectedSongIds)
    setSongOpBusy('delete')
    const removedCurrent = stopPlaybackForRemovedSongs(ids)
    if (removedCurrent) await new Promise((resolve) => setTimeout(resolve, 180))
    try {
      const result = await window.api.deleteSongs([...ids], deleteDiskFiles)
      const firstFailure = result.failures[0]
      const failed = result.failures.length
      const fileText = deleteDiskFiles ? `，删除文件 ${result.filesRemoved} 个` : ''
      const failText = failed
        ? `；${failed} 首未处理${firstFailure ? `：${firstFailure.error}` : ''}`
        : ''
      notify(
        `已从音乐库移除 ${result.removed} 首${fileText}${failText}`,
        failed ? 'error' : 'success'
      )
      setDeleteDialogOpen(false)
      setSelectedSongIds(new Set(result.failures.map((item) => item.songId)))
      if (failed === 0) setManageMode(false)
      await refreshBootstrap(true)
      setDataVersion((value) => value + 1)
    } catch (error) {
      notify(`删除失败：${errorText(error)}`, 'error')
    } finally {
      setSongOpBusy(null)
    }
  }

  async function handleMoveSongs(): Promise<void> {
    if (selectedSongIds.size === 0 || songOpBusy) return
    setSongOpBusy('move')
    try {
      const choice = await window.api.chooseSongMoveDir()
      if (choice.canceled || !choice.dir) return
      const ids = new Set(selectedSongIds)
      const result = await window.api.moveSongs([...ids], choice.dir)
      const firstFailure = result.failures[0]
      const failed = result.failures.length
      const skipText = result.skipped > 0 ? `，${result.skipped} 首已在目标文件夹` : ''
      const failText = failed
        ? `；${failed} 首失败${firstFailure ? `：${firstFailure.error}` : ''}`
        : ''
      notify(`已移动 ${result.moved} 首${skipText}${failText}`, failed ? 'error' : 'success')
      const current = currentSongRef.current
      if (current && ids.has(current.id)) {
        const songs = await window.api.getAllSongs()
        const updated = songs.find((song) => song.id === current.id)
        if (updated) {
          currentSongRef.current = updated
          setCurrentSong(updated)
          const nextQueue = queueRef.current.map((song) =>
            song.id === updated.id ? updated : song
          )
          commitQueue(nextQueue, queueIndexRef.current)
        }
      }
      setSelectedSongIds(new Set(result.failures.map((item) => item.songId)))
      if (failed === 0) setManageMode(false)
      await refreshBootstrap(true)
      setDataVersion((value) => value + 1)
    } catch (error) {
      notify(`移动失败：${errorText(error)}`, 'error')
    } finally {
      setSongOpBusy(null)
    }
  }

  function handleModeChange(nextMode: PlaybackMode): void {
    setPlaybackMode(nextMode)
    localStorage.setItem('playbackMode', nextMode)
    const song = currentSongRef.current
    if (song) {
      void refreshQueueForMode(nextMode, song, sourceSongs())
    }
  }

  function handleNext(auto = false): void {
    const audio = audioRef.current
    if (!currentSongRef.current) return
    if (auto && playbackMode === 'repeat-one' && audio) {
      audio.currentTime = 0
      setCurrentSeconds(0)
      void audio.play()
      return
    }
    const queue = queueRef.current
    const nextIndex = queueIndexRef.current + 1
    if (nextIndex < queue.length) {
      playAt(nextIndex, queue)
      return
    }
    if (
      playbackMode === 'shuffle-list' ||
      playbackMode === 'shuffle-category' ||
      playbackMode === 'shuffle-all'
    ) {
      if (queue.length > 0) {
        const reshuffled = shuffleArray(queue)
        if (reshuffled.length > 1 && reshuffled[0].id === currentSongRef.current.id) {
          ;[reshuffled[0], reshuffled[1]] = [reshuffled[1], reshuffled[0]]
        }
        playAt(0, reshuffled)
      }
      return
    }
    if (playbackMode === 'repeat-one' && queue.length > 0) {
      playAt(0, queue)
      return
    }
    setIsPlaying(false)
    if (!auto) notify('已经是播放列表的最后一首。', 'info')
  }

  function handlePrevious(): void {
    const audio = audioRef.current
    if (!currentSongRef.current) return
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0
      setCurrentSeconds(0)
      return
    }
    let previousIndex = queueIndexRef.current - 1
    if (previousIndex < 0) {
      if (
        playbackMode === 'shuffle-list' ||
        playbackMode === 'shuffle-category' ||
        playbackMode === 'shuffle-all'
      ) {
        previousIndex = queueRef.current.length - 1
      } else {
        if (audio) {
          audio.currentTime = 0
          setCurrentSeconds(0)
        }
        return
      }
    }
    if (previousIndex >= 0) playAt(previousIndex, queueRef.current)
  }

  function togglePlay(): void {
    const audio = audioRef.current
    if (!currentSongRef.current) {
      if (playbackSourceSongs.length > 0) startPlayback(playbackSourceSongs[0])
      else notify('还没有可播放的歌曲。', 'info')
      return
    }
    if (!audio) return
    if (audio.paused) {
      const promise = audio.play()
      promise?.catch(() => notify('无法继续播放，文件可能已被移动。', 'error'))
    } else {
      audio.pause()
    }
  }

  function handleSeek(seconds: number): void {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = seconds
    setCurrentSeconds(seconds)
    reportLyricsPlayback(true, { currentTimeMs: Math.round(seconds * 1000) })
  }

  function handleEnded(): void {
    setIsPlaying(false)
    reportLyricsPlayback(true, { isPlaying: false })
    handleNext(true)
  }

  function handleAudioError(): void {
    if (audioErrorNotifiedRef.current) return
    audioErrorNotifiedRef.current = true
    setIsPlaying(false)
    reportLyricsPlayback(true, { isPlaying: false })
    const title = currentSongRef.current?.title ?? '当前歌曲'
    notify(`播放失败：${title}。文件可能已移动，或编码不受支持。`, 'error')
  }

  function handleSetVolume(next: number): void {
    setVolume(Math.min(1, Math.max(0, next)))
  }

  async function handleChooseRoot(): Promise<void> {
    if (operation) return
    setOperation('root')
    try {
      const result = await window.api.chooseMusicRoot()
      if (result.canceled) return
      await refreshBootstrap(true)
      notify('音乐文件夹已设置，开始首次扫描。', 'success')
      await doScan()
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setOperation(null)
    }
  }

  async function doScan(): Promise<void> {
    if (scanningRef.current) return
    scanningRef.current = true
    setScanning(true)
    setScanErrors([])
    setScanProgress({ phase: 'walking', processed: 0, total: 0, current: '', message: '准备扫描…' })
    try {
      const result = await window.api.scanLibrary()
      setScanErrors(result.errors)
      await refreshBootstrap(true)
      setDataVersion((value) => value + 1)
      notify(
        `扫描完成：收录 ${result.indexed} 首${result.errors.length ? `，${result.errors.length} 条提示` : ''}。`,
        result.errors.length > 0 ? 'info' : 'success'
      )
    } catch (error) {
      notify(`扫描失败：${errorText(error)}`, 'error')
    } finally {
      scanningRef.current = false
      setScanning(false)
      setScanProgress(null)
    }
  }

  async function handleImport(): Promise<void> {
    if (operation || scanning) return
    setOperation('import')
    try {
      const result = await window.api.importPlaylist()
      if (!result) return
      await refreshBootstrap(true)
      setView({ type: 'playlist', id: result.playlistId })
      setDataVersion((value) => value + 1)
      notify(
        `已导入 ${result.total} 首：匹配 ${result.matched}，缺失 ${result.missing}，疑似 ${result.suspicious}。${
          result.warnings.length ? `有 ${result.warnings.length} 条路径/格式提示。` : ''
        }`,
        result.warnings.length > 0 ? 'info' : 'success'
      )
    } catch (error) {
      notify(`导入失败：${errorText(error)}`, 'error')
    } finally {
      setOperation(null)
    }
  }

  async function handleExport(): Promise<void> {
    if (view.type !== 'playlist') return
    try {
      const result = await window.api.exportPlaylistCsv(view.id)
      if (!result.canceled && result.path) notify(`已导出：${result.path}`, 'success')
    } catch (error) {
      notify(`导出失败：${errorText(error)}`, 'error')
    }
  }

  async function handleRefreshJobs(): Promise<void> {
    try {
      await refreshBootstrap(true)
      setDataVersion((value) => value + 1)
      notify('任务状态已刷新。', 'info')
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  async function handleOpenJobs(): Promise<void> {
    setView({ type: 'jobs' })
    try {
      await refreshBootstrap(true)
      setDataVersion((value) => value + 1)
    } catch {
      // The jobs view still renders the last known state.
    }
  }

  async function handleRetryJob(jobId: string): Promise<void> {
    if (retryingJob) return
    setRetryingJob(jobId)
    try {
      await window.api.retryBiliJob(jobId)
      const nextJobs = await window.api.getBiliJobs()
      setBootstrap((previous) => (previous ? { ...previous, jobs: nextJobs } : previous))
      notify('已重新开始失败条目的下载。', 'success')
    } catch (error) {
      notify(`重试失败：${errorText(error)}`, 'error')
    } finally {
      setRetryingJob(null)
    }
  }

  async function handleCancelJob(jobId: string): Promise<void> {
    if (cancellingJob) return
    setCancellingJob(jobId)
    try {
      await window.api.cancelBiliJob(jobId)
      const nextJobs = await window.api.getBiliJobs()
      setBootstrap((previous) => (previous ? { ...previous, jobs: nextJobs } : previous))
      notify('B站任务已取消。已下载完成的文件会保留。', 'success')
    } catch (error) {
      notify(`取消任务失败：${errorText(error)}`, 'error')
    } finally {
      setCancellingJob(null)
    }
  }

  function applyCategories(categories: CategoryView[]): void {
    setBootstrap((previous) => (previous ? { ...previous, categories } : previous))
    pruneSelectedCategories(categories)
  }

  async function handleSaveTag(name: string): Promise<void> {
    if (!tagTarget || !name.trim()) return
    setTagBusy(true)
    try {
      const result = await window.api.addTag(tagTarget.id, name.trim())
      applyCategories(result.categories)
      setTagTarget(null)
      notify(`已加入标签“${name.trim()}”。`, 'success')
      setDataVersion((version) => version + 1)
    } catch (error) {
      notify(`添加标签失败：${errorText(error)}`, 'error')
    } finally {
      setTagBusy(false)
    }
  }

  async function handlePlaylistNameSubmit(name: string): Promise<void> {
    if (!playlistDialog) return
    setPlaylistDialogBusy(true)
    try {
      if (playlistDialog.mode === 'create') {
        const playlist = await window.api.createPlaylist(name)
        await refreshBootstrap(true)
        setView({ type: 'playlist', id: playlist.id })
        notify(`已创建歌单“${playlist.name}”。`, 'success')
      } else {
        await window.api.renamePlaylist(playlistDialog.id, name)
        await refreshBootstrap(true)
        notify('歌单已重命名。', 'success')
      }
      setDataVersion((version) => version + 1)
      setPlaylistDialog(null)
    } catch (error) {
      notify(`保存歌单失败：${errorText(error)}`, 'error')
    } finally {
      setPlaylistDialogBusy(false)
    }
  }

  async function handleRematchPlaylist(): Promise<void> {
    if (!selectedPlaylist || rematchPlaylistBusy) return
    setRematchPlaylistBusy(true)
    try {
      const result = await window.api.rematchPlaylist(selectedPlaylist.id)
      await refreshBootstrap(true)
      setDataVersion((value) => value + 1)
      notify(
        `重新检测完成：匹配 ${result.matched}，缺失 ${result.missing}，疑似 ${result.suspicious}。`,
        result.missing > 0 ? 'info' : 'success'
      )
    } catch (error) {
      notify(`重新检测失败：${errorText(error)}`, 'error')
    } finally {
      setRematchPlaylistBusy(false)
    }
  }

  async function handleManualMatch(songId: number): Promise<void> {
    if (!manualMatchTarget || !selectedPlaylist || manualMatchBusy) return
    setManualMatchBusy(true)
    try {
      await window.api.matchPlaylistItem(
        selectedPlaylist.id,
        manualMatchTarget.id,
        songId
      )
      await refreshBootstrap(true)
      setDataVersion((value) => value + 1)
      notify('已手动匹配歌单条目。', 'success')
      setManualMatchTarget(null)
    } catch (error) {
      notify(`手动匹配失败：${errorText(error)}`, 'error')
    } finally {
      setManualMatchBusy(false)
    }
  }

  async function handleImportLocalToBili(
    categoryId: number | null,
    newCategoryName: string,
    files: string[]
  ): Promise<void> {
    if (biliImportBusy) return
    setBiliImportBusy(true)
    try {
      const result = await window.api.importLocalFiles(
        'bilibili',
        categoryId,
        newCategoryName,
        files
      )
      await refreshBootstrap(true)
      setDataVersion((value) => value + 1)
      notify(
        `已导入 ${result.imported} 首到 B站收藏夹${
          result.failed > 0 ? `，${result.failed} 首失败：${result.errors[0] ?? ''}` : ''
        }`,
        result.failed > 0 ? 'info' : 'success'
      )
      if (result.imported > 0) setBiliImportOpen(false)
    } catch (error) {
      notify(`导入本地歌曲失败：${errorText(error)}`, 'error')
    } finally {
      setBiliImportBusy(false)
    }
  }

  async function handleSetBiliCategory(categoryId: number | null): Promise<void> {
    if (!biliCategoryTarget || biliCategoryBusy) return
    setBiliCategoryBusy(true)
    try {
      await window.api.setSongBiliCategory(biliCategoryTarget.id, categoryId)
      await refreshBootstrap(true)
      setDataVersion((value) => value + 1)
      const targetName =
        categoryId == null
          ? '已移出 B站收藏夹分类'
          : `已移动到“${categories.find((category) => category.id === categoryId)?.name ?? 'B站分类'}”`
      notify(`${biliCategoryTarget.title}：${targetName}。`, 'success')
      setBiliCategoryTarget(null)
    } catch (error) {
      notify(`设置 B站分类失败：${errorText(error)}`, 'error')
    } finally {
      setBiliCategoryBusy(false)
    }
  }

  async function handleDeletePlaylist(): Promise<void> {
    if (!playlistDeleteTarget) return
    setPlaylistDeleteBusy(true)
    try {
      await window.api.deletePlaylist(playlistDeleteTarget.id)
      setPlaylistDeleteTarget(null)
      setView({ type: 'all' })
      await refreshBootstrap(true)
      setDataVersion((version) => version + 1)
      notify('歌单已删除，歌曲文件没有被删除。', 'success')
    } catch (error) {
      notify(`删除歌单失败：${errorText(error)}`, 'error')
    } finally {
      setPlaylistDeleteBusy(false)
    }
  }

  async function handleRemovePlaylistItem(item: PlaylistItemView): Promise<void> {
    if (view.type !== 'playlist') return
    try {
      const result = await window.api.removePlaylistItems(view.id, [item.id])
      await refreshBootstrap(true)
      setDataVersion((version) => version + 1)
      notify(result.removed > 0 ? '已从歌单移除。' : '条目已经不存在。', 'success')
    } catch (error) {
      notify(`移除歌单条目失败：${errorText(error)}`, 'error')
    }
  }

  async function handleAddSelectedToPlaylist(
    playlistId: number | null,
    newName: string
  ): Promise<void> {
    if (selectedSongIds.size === 0) return
    setAddToPlaylistBusy(true)
    try {
      let targetId = playlistId
      let targetName = ''
      if (!targetId) {
        if (!newName.trim()) throw new Error('请输入新歌单名称')
        const created = await window.api.createPlaylist(newName)
        targetId = created.id
        targetName = created.name
      }
      const result = await window.api.addSongsToPlaylist(targetId, [...selectedSongIds])
      const playlist = (await refreshBootstrap(true))?.playlists.find(
        (item) => item.id === targetId
      )
      setDataVersion((version) => version + 1)
      setAddToPlaylistOpen(false)
      notify(
        `已加入“${playlist?.name ?? targetName ?? '歌单'}”：新增 ${result.added} 首，跳过 ${result.skipped} 首。`,
        'success'
      )
    } catch (error) {
      notify(`加入歌单失败：${errorText(error)}`, 'error')
    } finally {
      setAddToPlaylistBusy(false)
    }
  }

  async function handleBatchAddTag(name: string): Promise<void> {
    if (selectedSongIds.size === 0) return
    setBatchTagBusy(true)
    try {
      const categories = await window.api.addTagToSongs([...selectedSongIds], name)
      applyCategories(categories)
      setBatchTagOpen(false)
      setDataVersion((version) => version + 1)
      notify(`已给 ${selectedSongIds.size} 首歌曲加上标签“${name}”。`, 'success')
    } catch (error) {
      notify(`批量加标签失败：${errorText(error)}`, 'error')
    } finally {
      setBatchTagBusy(false)
    }
  }

  function toggleCategorySelection(categoryId: number): void {
    setSelectedCategories((previous) => {
      const next = new Set(previous)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }

  if (loading) {
    return (
      <div className="full-screen center-screen">
        <div className="loading-orbit" />
        <p className="muted">正在打开 DS音乐播放器…</p>
      </div>
    )
  }

  if (fatalError) {
    return (
      <div className="full-screen center-screen">
        <div className="fatal-card">
          <div className="brand-mark large">DS</div>
          <h1>DS音乐播放器无法启动</h1>
          <p>{fatalError}</p>
          <button className="btn primary" onClick={() => void loadInitial()}>
            重新尝试
          </button>
        </div>
      </div>
    )
  }

  if (!bootstrap) return <div className="full-screen center-screen">正在加载…</div>

  if (!bootstrap.settings.musicRoot) {
    return (
      <Onboarding
        busy={operation === 'root'}
        scanning={scanning}
        onChoose={() => void handleChooseRoot()}
      />
    )
  }

  const bridgeState =
    bootstrap.bridge.running && bootstrap.bridge.tokenConfigured
      ? '已连接'
      : bootstrap.bridge.running
        ? '待配对'
        : '未启动'
  const bridgeClass = bootstrap.bridge.running
    ? bootstrap.bridge.tokenConfigured
      ? 'ok'
      : 'warn'
    : 'bad'
  const scanPercent =
    scanProgress && scanProgress.total > 0
      ? Math.min(100, Math.round((scanProgress.processed / scanProgress.total) * 100))
      : null
  const playerDuration = durationSeconds > 0 ? durationSeconds : (currentSong?.durationMs ?? 0) / 1000
  const selectedCategoryCount = selectedCategories.size
  const currentViewIsJobs = view.type === 'jobs'

  playbackCommandRef.current = (command: PlaybackCommand): void => {
    switch (command) {
      case 'play-pause':
        togglePlay()
        break
      case 'next':
        handleNext(false)
        break
      case 'previous':
        handlePrevious()
        break
      case 'stop': {
        const audio = audioRef.current
        if (audio) {
          audio.pause()
          audio.currentTime = 0
        }
        setCurrentSeconds(0)
        setIsPlaying(false)
        reportLyricsPlayback(true, { currentTimeMs: 0, isPlaying: false })
        break
      }
    }
  }

  mediaActionsRef.current = {
    play: () => {
      const audio = audioRef.current
      if (currentSongRef.current && audio) {
        if (audio.paused) void audio.play().catch(() => undefined)
      } else {
        togglePlay()
      }
    },
    pause: () => {
      audioRef.current?.pause()
    },
    next: () => handleNext(false),
    previous: () => handlePrevious(),
    stop: () => {
      const audio = audioRef.current
      if (audio) {
        audio.pause()
        audio.currentTime = 0
      }
      setCurrentSeconds(0)
      setIsPlaying(false)
      reportLyricsPlayback(true, { currentTimeMs: 0, isPlaying: false })
    },
    seek: (time: number) => handleSeek(time)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">DS</div>
          <div>
            <div className="brand-name">DS音乐播放器</div>
            <div className="brand-sub">DSM / LOCAL MUSIC</div>
            <div className="brand-tagline">属于自己的播放器</div>
          </div>
        </div>
        <div className="root-hint" title={bootstrap.settings.musicRoot}>
          {folderNameOf(bootstrap.settings.musicRoot)}
        </div>
        <div className="topbar-spacer" />
        <button
          className="bridge-chip"
          type="button"
          title="打开 B站下载设置"
          onClick={() => setSettingsOpen(true)}
        >
          <span className={`dot ${bridgeClass}`} />
          B站 Bridge · {bridgeState}
        </button>
        <button
          className="btn secondary"
          type="button"
          disabled={Boolean(operation) || scanning}
          onClick={() => void handleImport()}
        >
          导入歌单
        </button>
        <button
          className="btn secondary"
          type="button"
          disabled={scanning || Boolean(operation)}
          onClick={() => void doScan()}
        >
          {scanning ? '扫描中…' : '扫描音乐'}
        </button>
        <button className="icon-btn" type="button" onClick={() => setSettingsOpen(true)} title="设置">
          ⚙
        </button>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <button
            className={`side-nav ${view.type === 'all' ? 'active' : ''}`}
            type="button"
            onClick={() => setView({ type: 'all' })}
          >
            <span className="side-icon">♫</span>
            <span className="side-label">全部歌曲</span>
            <span className="side-count">{allSongs.length}</span>
          </button>

          <div className="side-section">
            <div className="side-heading">
              <span>我的歌单</span>
              <div className="side-heading-actions">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setPlaylistDialog({ mode: 'create' })}
                >
                  ＋ 新建
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={Boolean(operation) || scanning}
                  onClick={() => void handleImport()}
                >
                  导入
                </button>
              </div>
            </div>
            {playlists.length === 0 ? (
              <div className="side-empty">还没有歌单，可以新建或导入</div>
            ) : (
              playlists.map((playlist) => (
                <button
                  key={playlist.id}
                  className={`side-nav ${view.type === 'playlist' && view.id === playlist.id ? 'active' : ''}`}
                  type="button"
                  onClick={() => setView({ type: 'playlist', id: playlist.id })}
                >
                  <span className="side-icon">☰</span>
                  <span className="side-label" title={playlist.name}>
                    {playlist.name}
                  </span>
                  {playlist.missing > 0 ? (
                    <span className="side-badge danger">{playlist.missing}</span>
                  ) : (
                    <span className="side-count">{playlist.total}</span>
                  )}
                </button>
              ))
            )}
          </div>

          <div className="side-section category-section">
            <div className="side-heading">
              <span>分类</span>
              <span className="mini-hint">勾选用于分类随机</span>
            </div>
            {CATEGORY_KIND_ORDER.map((kind) => {
              const list = groupedCategories[kind]
              if (list.length === 0) return null
              return (
                <div key={kind} className="category-group">
                  <div className="category-kind">
                    <span>{CATEGORY_KIND_LABEL[kind]}</span>
                    {kind === 'tag' ? (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setTagManagerOpen(true)}
                      >
                        管理
                      </button>
                    ) : kind === 'bilibili' ? (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setBiliImportOpen(true)}
                      >
                        导入
                      </button>
                    ) : null}
                  </div>
                  {list.map((category) => {
                    const active = view.type === 'category' && view.id === category.id
                    return (
                      <div
                        key={category.id}
                        className={`category-row ${active ? 'active' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedCategories.has(category.id)}
                          onChange={() => toggleCategorySelection(category.id)}
                          aria-label={`选择分类 ${category.name}`}
                        />
                        <button
                          type="button"
                          className="category-button"
                          onClick={() => setView({ type: 'category', id: category.id })}
                          title={category.name}
                        >
                          <span className={`kind-dot ${kind}`} />
                          <span className="category-name">{category.name}</span>
                          <span className="side-count">{category.songCount}</span>
                        </button>
                      </div>
                    )
                  })}
                </div>
              )
            })}
            {groupedCategories.bilibili.length === 0 ? (
              <div className="category-group">
                <div className="category-kind">
                  <span>B站收藏夹</span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setBiliImportOpen(true)}
                  >
                    导入
                  </button>
                </div>
                <div className="side-empty">还没有分类，可以直接导入本地歌曲</div>
              </div>
            ) : null}
            {categories.length === 0 ? (
              <div className="side-empty">扫描音乐后会自动生成文件夹和流派分类</div>
            ) : null}
          </div>

          <div className="sidebar-bottom">
            {selectedCategoryCount > 0 ? (
              <div className="selection-hint">已勾选 {selectedCategoryCount} 个分类</div>
            ) : null}
            <button
              className={`side-nav tasks-link ${currentViewIsJobs ? 'active' : ''}`}
              type="button"
              onClick={() => void handleOpenJobs()}
            >
              <span className="side-icon pink">↓</span>
              <span className="side-label">B站下载任务</span>
              {activeJobs.length > 0 ? (
                <span className="side-badge pink">{activeJobs.length}</span>
              ) : (
                <span className="side-count">{jobs.length}</span>
              )}
            </button>
            <div className="legal-mini">仅个人备份与学习使用，请遵守平台条款。</div>
          </div>
        </aside>

        <main className="main-panel">
          <div className="content-header">
            <div>
              <div className="eyebrow">
                {view.type === 'jobs' ? 'BILIBILI BRIDGE' : 'LIBRARY'}
              </div>
              <h1 className="content-title">{viewTitle}</h1>
              <div className="content-subtitle">{viewSubtitle}</div>
            </div>
            <div className="content-actions">
              {view.type === 'playlist' && selectedPlaylist ? (
                <>
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={rematchPlaylistBusy}
                    onClick={() => void handleRematchPlaylist()}
                    title="重新按当前本地音乐库检测这个歌单"
                  >
                    {rematchPlaylistBusy ? '检测中…' : '重新检测'}
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() =>
                      setPlaylistDialog({
                        mode: 'rename',
                        id: selectedPlaylist.id,
                        name: selectedPlaylist.name
                      })
                    }
                  >
                    重命名
                  </button>
                  <button
                    className="btn danger"
                    type="button"
                    onClick={() => setPlaylistDeleteTarget(selectedPlaylist)}
                  >
                    删除歌单
                  </button>
                  <button className="btn secondary" type="button" onClick={() => void handleExport()}>
                    导出 CSV
                  </button>
                </>
              ) : null}
              {currentViewIsJobs ? (
                <button className="btn secondary" type="button" onClick={() => void handleRefreshJobs()}>
                  刷新任务
                </button>
              ) : null}
              {canManageSongs && displayedSongs.length > 0 ? (
                <button
                  className={`btn ${manageMode ? 'primary-soft' : 'secondary'}`}
                  type="button"
                  onClick={toggleManageMode}
                >
                  {manageMode ? '退出管理' : '管理歌曲'}
                </button>
              ) : null}
              {view.type === 'all' ? (
                <button className="btn secondary" type="button" onClick={() => void handleImport()}>
                  导入歌单
                </button>
              ) : null}
            </div>
          </div>

          {manageMode ? (
            <div className="song-manage-bar">
              <div className="song-manage-summary">
                <strong>管理歌曲</strong>
                <span>
                  已选 {selectedSongIds.size} 首 / 共 {displayedSongs.length} 首
                </span>
              </div>
              <div className="song-manage-actions">
                <button
                  className="btn secondary small-btn"
                  type="button"
                  onClick={toggleAllVisibleSongs}
                  disabled={Boolean(songOpBusy)}
                >
                  {allVisibleSelected ? '取消全选' : '全选'}
                </button>
                <button
                  className="btn secondary small-btn"
                  type="button"
                  onClick={() => setAddToPlaylistOpen(true)}
                  disabled={selectedSongIds.size === 0 || Boolean(songOpBusy)}
                >
                  加入歌单…
                </button>
                <button
                  className="btn secondary small-btn"
                  type="button"
                  onClick={() => setBatchTagOpen(true)}
                  disabled={selectedSongIds.size === 0 || Boolean(songOpBusy)}
                >
                  加标签…
                </button>
                <button
                  className="btn secondary small-btn"
                  type="button"
                  onClick={() => void handleMoveSongs()}
                  disabled={selectedSongIds.size === 0 || Boolean(songOpBusy)}
                >
                  {songOpBusy === 'move' ? '移动中…' : '移动到…'}
                </button>
                <button
                  className="btn danger small-btn"
                  type="button"
                  onClick={() => {
                    setDeleteDiskFiles(true)
                    setDeleteDialogOpen(true)
                  }}
                  disabled={selectedSongIds.size === 0 || Boolean(songOpBusy)}
                >
                  删除…
                </button>
              </div>
            </div>
          ) : null}

          {manageMode ? (
            <div className="song-manage-hint">
              勾选歌曲后可加入歌单、加标签、移动或删除。移动目标必须在当前音乐文件夹内；删除时会再确认是否同时删除磁盘文件。
            </div>
          ) : null}

          {view.type !== 'jobs' ? (
            <div className="library-toolbar">
              <div className="library-search">
                <span className="library-search-icon">⌕</span>
                <input
                  className="text-input"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={
                    view.type === 'playlist'
                      ? '搜索歌单里的歌名、歌手、专辑或路径'
                      : '搜索歌名、歌手、专辑、流派或路径'
                  }
                  aria-label="搜索歌曲"
                />
              </div>
              {view.type === 'playlist' ? (
                <div className="status-filter-chips" role="group" aria-label="按状态筛选">
                  {(
                    [
                      ['all', '全部'],
                      ['matched', '已下载'],
                      ['missing', '缺失'],
                      ['suspicious', '疑似']
                    ] as Array<[PlaylistStatusFilter, string]>
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      className={`status-chip ${playlistStatusFilter === value ? 'active' : ''} ${value}`}
                      type="button"
                      onClick={() => setPlaylistStatusFilter(value)}
                    >
                      {label}
                      <span>{playlistStatusCounts[value]}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  <select
                    className="toolbar-select"
                    value={sourceFilter}
                    onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}
                    aria-label="按来源筛选"
                  >
                    <option value="all">全部来源</option>
                    <option value="local">本地</option>
                    <option value="bilibili">B站收藏夹</option>
                  </select>
                  <select
                    className="toolbar-select"
                    value={songSort}
                    onChange={(event) => setSongSort(event.target.value as SongSortKey)}
                    aria-label="排序字段"
                  >
                    <option value="title">按歌名</option>
                    <option value="artist">按歌手</option>
                    <option value="album">按专辑</option>
                    <option value="duration">按时长</option>
                  </select>
                  <button
                    className="btn secondary small-btn"
                    type="button"
                    title={sortDirection === 'asc' ? '当前升序，点击切换降序' : '当前降序，点击切换升序'}
                    onClick={() =>
                      setSortDirection((previous) => (previous === 'asc' ? 'desc' : 'asc'))
                    }
                  >
                    {sortDirection === 'asc' ? '↑ 升序' : '↓ 降序'}
                  </button>
                </>
              )}
              {libraryFiltering ? (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setSearchQuery('')
                    setSourceFilter('all')
                    setPlaylistStatusFilter('all')
                  }}
                >
                  清除筛选
                </button>
              ) : null}
              <span className="library-result-count">
                {view.type === 'playlist'
                  ? `${displayedPlaylistItems.length} / ${playlistItems.length} 条`
                  : `${displayedSongs.length} / ${visibleSongs.length} 首`}
              </span>
            </div>
          ) : null}

          {scanning ? (
            <div className="scan-banner">
              <div className="scan-banner-head">
                <span>{scanProgress?.message ?? '正在扫描音乐…'}</span>
                <span>{scanPercent === null ? '' : `${scanPercent}%`}</span>
              </div>
              <div className="scan-track">
                <div
                  className={`scan-fill ${scanPercent === null ? 'indeterminate' : ''}`}
                  style={scanPercent === null ? undefined : { width: `${scanPercent}%` }}
                />
              </div>
              {scanProgress?.current ? (
                <div className="scan-current" title={scanProgress.current}>
                  {scanProgress.current}
                </div>
              ) : null}
            </div>
          ) : null}

          {scanErrors.length > 0 ? (
            <div className="notice-banner">
              <div>
                扫描完成，但有 {scanErrors.length} 条提示。缺失歌曲可能因此暂时保留。
              </div>
              <button type="button" className="text-button" onClick={() => setScanErrors([])}>
                知道了
              </button>
            </div>
          ) : null}

          {viewLoading ? <div className="thin-loading" /> : null}

          {currentViewIsJobs ? (
            <JobsView
              jobs={jobs}
              retryingJob={retryingJob}
              cancellingJob={cancellingJob}
              onRefresh={() => void handleRefreshJobs()}
              onRetry={(jobId) => void handleRetryJob(jobId)}
              onCancel={(jobId) => void handleCancelJob(jobId)}
            />
          ) : view.type === 'playlist' ? (
            <PlaylistTable
              items={displayedPlaylistItems}
              currentSongId={currentSong?.id ?? null}
              onPlay={(item) => {
                const song = playlistItemToSong(item)
                if (song) startPlayback(song)
              }}
              onTag={(song) => setTagTarget(song)}
              onPlayNext={queuePlayNext}
              onAddToQueue={queueAppend}
              onBiliCategory={(song) => setBiliCategoryTarget(song)}
              onManualMatch={(item) => setManualMatchTarget(item)}
              onRemoveItem={(item) => void handleRemovePlaylistItem(item)}
              filtered={libraryFiltering}
            />
          ) : (
            <SongTable
              songs={displayedSongs}
              currentSongId={currentSong?.id ?? null}
              onPlay={startPlayback}
              onTag={(song) => setTagTarget(song)}
              onPlayNext={queuePlayNext}
              onAddToQueue={queueAppend}
              onBiliCategory={(song) => setBiliCategoryTarget(song)}
              emptyTitle={view.type === 'all' ? '还没有本地歌曲' : '这个分类还没有歌曲'}
              emptyText={
                view.type === 'all'
                  ? '扫描音乐文件夹，或从B站下载音频后，歌曲会出现在这里。'
                  : '可以扫描文件夹，或给歌曲添加标签。'
              }
              onScan={() => void doScan()}
              filtered={libraryFiltering}
              manageMode={manageMode}
              selectedSongIds={selectedSongIds}
              allSelected={allVisibleSelected}
              onToggleSelect={toggleSongSelection}
              onToggleAll={toggleAllVisibleSongs}
            />
          )}
        </main>
      </div>

      <footer className="player-bar">
        <div className="now-playing">
          <div className="player-cover">♪</div>
          <div className="now-meta">
            <div className="now-title" title={currentSong?.title ?? ''}>
              {currentSong?.title ?? '未播放'}
            </div>
            <div className="now-artist" title={currentSong?.artist ?? ''}>
              {currentSong?.artist || '选择一首歌开始'}
            </div>
          </div>
        </div>

        <div className="player-center">
          <div className="transport">
            <button
              className="control-btn"
              type="button"
              onClick={handlePrevious}
              disabled={!currentSong}
              title="上一首"
            >
              ⏮
            </button>
            <button
              className={`play-btn ${isPlaying ? 'is-pause' : 'is-play'}`}
              type="button"
              onClick={togglePlay}
              title={isPlaying ? '暂停' : '播放'}
            >
              {isPlaying ? <PauseTransportIcon /> : <PlayTransportIcon />}
            </button>
            <button
              className="control-btn"
              type="button"
              onClick={() => handleNext(false)}
              disabled={!currentSong}
              title="下一首"
            >
              ⏭
            </button>
          </div>
          <div className="timeline">
            <span className="time-label">{formatClock(currentSeconds)}</span>
            <input
              className="range seek-range"
              type="range"
              min={0}
              max={playerDuration > 0 ? playerDuration : 0}
              step={0.1}
              value={Math.min(currentSeconds, playerDuration || 0)}
              onChange={(event) => handleSeek(Number(event.target.value))}
              disabled={!currentSong || playerDuration <= 0}
              aria-label="播放进度"
            />
            <span className="time-label">{formatClock(playerDuration)}</span>
          </div>
        </div>

        <div className="player-side">
          <button
            className="queue-toggle"
            type="button"
            onClick={() => setQueueOpen(true)}
            title="查看播放队列"
          >
            队列
            {playerQueue.length > 0 ? <span className="queue-count">{playerQueue.length}</span> : null}
          </button>
          <button
            className={`lyrics-toggle ${lyricsVisible ? 'active' : ''}`}
            type="button"
            onClick={() => void toggleDesktopLyrics()}
            title="显示/隐藏桌面歌词（自动读取同名 .lrc）"
          >
            词
          </button>
          <div className="mode-control">
            <span className="mode-label">模式</span>
            <select
              className="mode-select"
              value={playbackMode}
              onChange={(event) => handleModeChange(event.target.value as PlaybackMode)}
              title="分类随机会优先使用左侧勾选的分类"
            >
              {MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <span className="volume-icon">🔊</span>
          <input
            className="range volume-range"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(event) => handleSetVolume(Number(event.target.value))}
            aria-label="音量"
          />
        </div>
      </footer>

      <audio
        ref={audioRef}
        preload="metadata"
        onTimeUpdate={() => {
          const audio = audioRef.current
          if (audio) setCurrentSeconds(audio.currentTime)
          reportLyricsPlayback()
        }}
        onLoadedMetadata={() => {
          const audio = audioRef.current
          if (audio && Number.isFinite(audio.duration)) setDurationSeconds(audio.duration)
          reportLyricsPlayback(true)
        }}
        onDurationChange={() => {
          const audio = audioRef.current
          if (audio && Number.isFinite(audio.duration)) setDurationSeconds(audio.duration)
        }}
        onPlay={() => {
          setIsPlaying(true)
          reportLyricsPlayback(true, { isPlaying: true })
        }}
        onPause={() => {
          setIsPlaying(false)
          reportLyricsPlayback(true, { isPlaying: false })
        }}
        onSeeked={() => reportLyricsPlayback(true)}
        onEnded={handleEnded}
        onError={handleAudioError}
      />

      {settingsOpen ? (
        <SettingsModal
          bootstrap={bootstrap}
          theme={theme}
          onThemeChange={setTheme}
          onClose={() => setSettingsOpen(false)}
          onRefresh={refreshBootstrap}
          onChangeRoot={handleChooseRoot}
          onScan={doScan}
          notify={notify}
        />
      ) : null}

      {queueOpen ? (
        <QueueDialog
          songs={playerQueue}
          currentIndex={playerQueueIndex}
          onClose={() => setQueueOpen(false)}
          onPlay={(index) => {
            playAt(index, playerQueue)
            setQueueOpen(false)
          }}
          onRemove={removeQueueItem}
          onClearAfterCurrent={clearQueueAfterCurrent}
        />
      ) : null}

      {manualMatchTarget ? (
        <ManualMatchDialog
          item={manualMatchTarget}
          busy={manualMatchBusy}
          onClose={() => {
            if (!manualMatchBusy) setManualMatchTarget(null)
          }}
          onSave={(songId) => void handleManualMatch(songId)}
        />
      ) : null}

      {biliImportOpen ? (
        <BiliImportDialog
          categories={categories}
          busy={biliImportBusy}
          onClose={() => {
            if (!biliImportBusy) setBiliImportOpen(false)
          }}
          onImport={(categoryId, newCategoryName, files) =>
            void handleImportLocalToBili(categoryId, newCategoryName, files)
          }
        />
      ) : null}

      {biliCategoryTarget ? (
        <BiliCategoryDialog
          song={biliCategoryTarget}
          categories={categories}
          busy={biliCategoryBusy}
          onClose={() => {
            if (!biliCategoryBusy) setBiliCategoryTarget(null)
          }}
          onSave={(categoryId) => void handleSetBiliCategory(categoryId)}
        />
      ) : null}

      {playlistDialog ? (
        <TextInputDialog
          eyebrow="PLAYLIST"
          title={playlistDialog.mode === 'create' ? '新建歌单' : '重命名歌单'}
          label="歌单名称"
          initial={playlistDialog.mode === 'rename' ? playlistDialog.name : ''}
          placeholder="例如：通勤、游戏、收藏"
          submitLabel={playlistDialog.mode === 'create' ? '创建歌单' : '保存名称'}
          busy={playlistDialogBusy}
          onClose={() => {
            if (!playlistDialogBusy) setPlaylistDialog(null)
          }}
          onSubmit={(name) => void handlePlaylistNameSubmit(name)}
        />
      ) : null}

      {playlistDeleteTarget ? (
        <ConfirmActionDialog
          eyebrow="DELETE PLAYLIST"
          title={`删除歌单“${playlistDeleteTarget.name}”？`}
          message={`歌单里的 ${playlistDeleteTarget.total} 条记录会被移除，但不会删除磁盘上的歌曲文件，也不会删除音乐库里的歌曲。`}
          confirmLabel="删除歌单"
          busy={playlistDeleteBusy}
          onClose={() => {
            if (!playlistDeleteBusy) setPlaylistDeleteTarget(null)
          }}
          onConfirm={() => void handleDeletePlaylist()}
        />
      ) : null}

      {addToPlaylistOpen ? (
        <AddToPlaylistDialog
          playlists={playlists}
          count={selectedSongIds.size}
          busy={addToPlaylistBusy}
          onClose={() => {
            if (!addToPlaylistBusy) setAddToPlaylistOpen(false)
          }}
          onSubmit={(playlistId, name) => void handleAddSelectedToPlaylist(playlistId, name)}
        />
      ) : null}

      {batchTagOpen ? (
        <TextInputDialog
          eyebrow="BATCH TAG"
          title={`给 ${selectedSongIds.size} 首歌曲加标签`}
          label="标签名称"
          initial=""
          placeholder="例如：通勤、钢琴、收藏"
          submitLabel="批量添加"
          busy={batchTagBusy}
          onClose={() => {
            if (!batchTagBusy) setBatchTagOpen(false)
          }}
          onSubmit={(name) => void handleBatchAddTag(name)}
        />
      ) : null}

      {tagManagerOpen ? (
        <TagManagerDialog
          tags={categories.filter((category) => category.kind === 'tag')}
          onClose={() => setTagManagerOpen(false)}
          onChanged={applyCategories}
          notify={notify}
        />
      ) : null}

      {tagTarget ? (
        <TagDialog
          song={tagTarget}
          busy={tagBusy}
          onChanged={applyCategories}
          onClose={() => setTagTarget(null)}
          onSave={(name) => void handleSaveTag(name)}
        />
      ) : null}

      {deleteDialogOpen ? (
        <DeleteSongsDialog
          songs={selectedSongs}
          deleteFiles={deleteDiskFiles}
          busy={songOpBusy === 'delete'}
          onToggleDeleteFiles={() => setDeleteDiskFiles((value) => !value)}
          onCancel={() => {
            if (!songOpBusy) setDeleteDialogOpen(false)
          }}
          onConfirm={() => void handleDeleteSongs()}
        />
      ) : null}

      {toast ? (
        <div className={`toast ${toast.kind}`} role="status">
          {toast.message}
        </div>
      ) : null}
    </div>
  )
}

function Onboarding(props: {
  busy: boolean
  scanning: boolean
  onChoose: () => void
}): React.JSX.Element {
  return (
    <div className="onboarding">
      <div className="onboarding-glow" />
      <div className="onboarding-card">
        <div className="onboarding-brand">
          <div className="brand-mark xlarge">DS</div>
          <div>
            <div className="eyebrow">DS音乐播放器 · DSM</div>
            <h1>把音乐留在本地。</h1>
          </div>
        </div>
        <p className="onboarding-lead">
          导入第三方歌单，扫描本地音乐，按文件夹/流派/B站收藏夹分类播放。
          B站音频由本机直接下载入库，不使用网页播放器抓流。
        </p>
        <div className="feature-grid">
          <div className="feature">
            <span className="feature-icon">▤</span>
            <strong>歌单校验</strong>
            <p>M3U / CSV / JSON，自动匹配已下载、缺失和疑似歌曲。</p>
          </div>
          <div className="feature">
            <span className="feature-icon">♫</span>
            <strong>本地播放</strong>
            <p>顺序、单曲循环、列表随机、分类随机和跨分类随机。</p>
          </div>
          <div className="feature">
            <span className="feature-icon pink">↓</span>
            <strong>B站收藏夹</strong>
            <p>插件只发任务；本地软件下载 DASH 音频并自动入库。</p>
          </div>
        </div>
        <div className="onboarding-actions">
          <button
            className="btn primary large"
            type="button"
            onClick={props.onChoose}
            disabled={props.busy}
          >
            {props.busy
              ? props.scanning
                ? '正在建立音乐库…'
                : '正在选择文件夹…'
              : '选择音乐文件夹'}
          </button>
          <span className="onboarding-note">
            数据只保存在本机。首次选择后会扫描一次，之后可在顶部手动重新扫描。
          </span>
        </div>
        <div className="onboarding-footer">
          支持 mp3 / m4a / aac / flac / ogg / opus / wav / webm。B站下载默认保存原始 m4a，不做强制转码。
          <br />
          本软件与哔哩哔哩无关联，仅用于个人备份学习，请勿公开传播下载内容。
        </div>
      </div>
    </div>
  )
}

function PlaylistTable(props: {
  items: PlaylistItemView[]
  currentSongId: number | null
  onPlay: (item: PlaylistItemView) => void
  onTag: (song: SongView) => void
  onPlayNext: (song: SongView) => void
  onAddToQueue: (song: SongView) => void
  onBiliCategory: (song: SongView) => void
  onManualMatch: (item: PlaylistItemView) => void
  onRemoveItem: (item: PlaylistItemView) => void
  filtered: boolean
}): React.JSX.Element {
  if (props.items.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-art">▤</div>
        <h2>{props.filtered ? '没有匹配的歌单条目' : '歌单还是空的'}</h2>
        <p>
          {props.filtered
            ? '换一个关键词或状态筛选，或者清空筛选条件。'
            : '从顶部“导入歌单”选择 M3U、M3U8、CSV 或 JSON 文件。'}
        </p>
      </div>
    )
  }
  return (
    <div className="table-shell">
      <table className="data-table">
        <thead>
          <tr>
            <th className="index-cell">#</th>
            <th>歌名</th>
            <th>歌手</th>
            <th>专辑</th>
            <th className="duration-cell">时长</th>
            <th>状态</th>
            <th className="action-cell">操作</th>
          </tr>
        </thead>
        <tbody>
          {props.items.map((item) => {
            const playable = item.status === 'matched' && Boolean(item.songId) && item.available
            const current = playable && item.songId === props.currentSongId
            const statusClass =
              item.status === 'missing'
                ? 'danger'
                : item.status === 'suspicious'
                  ? 'warn'
                  : 'ok'
            return (
              <tr
                key={item.id}
                className={`${statusClass}-row ${current ? 'current-row' : ''}`}
                onDoubleClick={() => {
                  if (playable) props.onPlay(item)
                }}
              >
                <td className="index-cell">{item.position}</td>
                <td>
                  <div className="song-title" title={item.path || item.title}>
                    {item.title}
                  </div>
                  {item.note && item.status !== 'matched' ? (
                    <div className="song-note">{item.note}</div>
                  ) : null}
                </td>
                <td className="muted-cell">{item.artist || '—'}</td>
                <td className="muted-cell">{item.album || '—'}</td>
                <td className="duration-cell">{formatDurationMs(item.durationMs)}</td>
                <td>
                  <span className={`status-pill ${statusClass}`}>{STATUS_LABELS[item.status]}</span>
                </td>
                <td className="action-cell">
                  <button
                    className="row-action play-action"
                    type="button"
                    disabled={!playable}
                    onClick={() => props.onPlay(item)}
                    title={playable ? '播放' : '没有可播放的本地文件'}
                  >
                    ▶
                  </button>
                  {playable ? (
                    <button
                      className="row-action queue-action"
                      type="button"
                      onClick={() => {
                        const pseudoSong = playlistItemToSong(item)
                        if (pseudoSong) props.onPlayNext(pseudoSong)
                      }}
                      title="下一首播放"
                    >
                      ⏭
                    </button>
                  ) : null}
                  {playable ? (
                    <button
                      className="row-action queue-action"
                      type="button"
                      onClick={() => {
                        const pseudoSong = playlistItemToSong(item)
                        if (pseudoSong) props.onAddToQueue(pseudoSong)
                      }}
                      title="加入播放队列"
                    >
                      ＋
                    </button>
                  ) : null}
                  <button
                    className="row-action text-action"
                    type="button"
                    onClick={() => props.onManualMatch(item)}
                    title="手动选择本地歌曲进行匹配"
                  >
                    匹配
                  </button>
                  {playable ? (
                    <button
                      className="row-action text-action"
                      type="button"
                      onClick={() => {
                        const pseudoSong = playlistItemToSong(item)
                        if (pseudoSong) props.onBiliCategory(pseudoSong)
                      }}
                      title="设置 B站收藏夹分类"
                    >
                      B站分类
                    </button>
                  ) : null}
                  {playable && item.songId ? (
                    <button
                      className="row-action text-action"
                      type="button"
                      onClick={() => {
                        const pseudoSong = playlistItemToSong(item)
                        if (pseudoSong) props.onTag(pseudoSong)
                      }}
                      title="加入标签"
                    >
                      ＋标签
                    </button>
                  ) : null}
                  <button
                    className="row-action text-action remove-item-action"
                    type="button"
                    onClick={() => props.onRemoveItem(item)}
                    title="从这个歌单移除，不删除文件"
                  >
                    移除
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function DeleteSongsDialog(props: {
  songs: SongView[]
  deleteFiles: boolean
  busy: boolean
  onToggleDeleteFiles: () => void
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const count = props.songs.length
  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => {
        if (!props.busy) props.onCancel()
      }}
    >
      <div
        className="modal confirm-modal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="confirm-head">
          <div className="eyebrow">REMOVE FROM LIBRARY</div>
          <h2>删除 {count} 首歌曲？</h2>
        </div>
        <p className="confirm-lead">
          歌曲会从 DS音乐播放器的音乐库、分类和歌单匹配中移除。
        </p>
        <div className="confirm-song-list">
          {props.songs.slice(0, 6).map((song) => (
            <div key={song.id} title={song.path}>
              <span>{song.title}</span>
              <small>{song.artist || '未知歌手'}</small>
            </div>
          ))}
          {count > 6 ? <div className="confirm-more">还有 {count - 6} 首…</div> : null}
        </div>

        <label className="confirm-check">
          <input
            type="checkbox"
            checked={props.deleteFiles}
            onChange={props.onToggleDeleteFiles}
            disabled={props.busy}
          />
          <span>
            <strong>同时删除磁盘上的音频文件</strong>
            <small>B站误下载的 m4a 也会一并删除；此操作不可恢复。</small>
          </span>
        </label>

        <div className={`confirm-warning ${props.deleteFiles ? 'danger' : ''}`}>
          {props.deleteFiles
            ? '将永久删除音频文件。歌词 .lrc、歌单源文件和插件不会被删除。'
            : '只从音乐库移除，音频文件仍留在磁盘上；下次扫描可能重新收录。'}
        </div>

        <div className="confirm-actions">
          <button
            className="btn secondary"
            type="button"
            onClick={props.onCancel}
            disabled={props.busy}
          >
            取消
          </button>
          <button
            className="btn danger"
            type="button"
            onClick={props.onConfirm}
            disabled={props.busy || count === 0}
          >
            {props.busy
              ? '正在删除…'
              : props.deleteFiles
                ? `删除 ${count} 首并删除文件`
                : `从音乐库移除 ${count} 首`}
          </button>
        </div>
      </div>
    </div>
  )
}

function QueueDialog(props: {
  songs: SongView[]
  currentIndex: number
  onClose: () => void
  onPlay: (index: number) => void
  onRemove: (index: number) => void
  onClearAfterCurrent: () => void
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="modal queue-modal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="eyebrow">PLAY QUEUE</div>
            <h2>播放队列</h2>
          </div>
          <button className="icon-btn" type="button" onClick={props.onClose} title="关闭">
            ✕
          </button>
        </div>
        <p className="confirm-lead">
          {props.songs.length > 0
            ? `共 ${props.songs.length} 首，当前第 ${Math.max(1, props.currentIndex + 1)} 首。点任意歌曲可以直接切换播放。`
            : '队列还是空的。可以从歌曲行末的“下一首播放”或“加入队列”添加。'}
        </p>
        {props.songs.length > 0 ? (
          <div className="queue-list">
            {props.songs.map((song, index) => {
              const current = index === props.currentIndex
              return (
                <div
                  key={`${song.id}-${index}`}
                  className={`queue-row ${current ? 'current' : ''}`}
                  onClick={() => props.onPlay(index)}
                >
                  <span className="queue-index">{index + 1}</span>
                  <div className="queue-track">
                    <strong title={song.title}>{song.title}</strong>
                    <small>{song.artist || '未知歌手'}</small>
                  </div>
                  <span className="queue-duration">{formatDurationMs(song.durationMs)}</span>
                  {current ? (
                    <span className="queue-current-badge">当前</span>
                  ) : (
                    <button
                      className="queue-remove"
                      type="button"
                      title="从队列移除"
                      onClick={(event) => {
                        event.stopPropagation()
                        props.onRemove(index)
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ) : null}
        <div className="modal-actions queue-actions">
          <button
            className="btn secondary"
            type="button"
            onClick={props.onClearAfterCurrent}
            disabled={props.songs.length === 0}
          >
            清空后面的队列
          </button>
          <button className="btn primary-soft" type="button" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

function BiliImportDialog(props: {
  categories: CategoryView[]
  busy: boolean
  onClose: () => void
  onImport: (categoryId: number | null, newCategoryName: string, files: string[]) => void
}): React.JSX.Element {
  const biliCategories = props.categories.filter((category) => category.kind === 'bilibili')
  const [target, setTarget] = useState<number | 'new'>(
    biliCategories[0]?.id ?? 'new'
  )
  const [newName, setNewName] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [selecting, setSelecting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !props.busy) props.onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [props.busy, props.onClose])

  async function chooseFiles(): Promise<void> {
    setSelecting(true)
    setError('')
    try {
      const selected = await window.api.chooseLocalAudioFiles()
      if (selected.length > 0) setFiles(selected)
    } catch (chooseError) {
      setError(errorText(chooseError))
    } finally {
      setSelecting(false)
    }
  }

  function submit(): void {
    if (files.length === 0) {
      setError('请先选择本地音频文件')
      return
    }
    if (target === 'new' && !newName.trim()) {
      setError('请输入新分类名称，或选择一个已有分类')
      return
    }
    setError('')
    props.onImport(
      target === 'new' ? null : target,
      target === 'new' ? newName.trim() : '',
      files
    )
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => {
        if (!props.busy) props.onClose()
      }}
    >
      <div
        className="modal bili-import-modal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="eyebrow">IMPORT LOCAL SONGS</div>
            <h2>导入本地歌曲到 B站收藏夹</h2>
          </div>
          <button
            className="icon-btn"
            type="button"
            onClick={props.onClose}
            disabled={props.busy}
            title="关闭"
          >
            ✕
          </button>
        </div>
        <p className="settings-hint">
          直接导入到收藏夹分类，不会新建歌单。以后接入其他视频网站时，也会复用这个导入模块。
        </p>
        <label className="form-label" htmlFor="biliImportTarget">
          目标 B站收藏夹分类
        </label>
        <select
          id="biliImportTarget"
          className="text-input"
          value={target}
          disabled={props.busy}
          onChange={(event) => {
            setTarget(event.target.value === 'new' ? 'new' : Number(event.target.value))
            setError('')
          }}
        >
          {biliCategories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}（{category.songCount} 首）
            </option>
          ))}
          <option value="new">＋ 新建 B站收藏夹分类</option>
        </select>
        {target === 'new' ? (
          <input
            className="text-input"
            style={{ marginTop: 8 }}
            maxLength={60}
            value={newName}
            disabled={props.busy}
            onChange={(event) => {
              setNewName(event.target.value)
              setError('')
            }}
            placeholder="例如：我喜欢的音乐"
          />
        ) : null}
        <div className="bili-import-files">
          <div className="bili-import-files-head">
            <span>已选择 {files.length} 个文件</span>
            <button
              className="btn secondary small-btn"
              type="button"
              disabled={props.busy || selecting}
              onClick={() => void chooseFiles()}
            >
              {selecting ? '选择中…' : '选择本地歌曲…'}
            </button>
          </div>
          {files.length > 0 ? (
            <div className="bili-import-file-list">
              {files.slice(0, 8).map((file) => (
                <div key={file} title={file}>
                  {file.split(/[\\/]/).pop()}
                </div>
              ))}
              {files.length > 8 ? <div>…还有 {files.length - 8} 个文件</div> : null}
            </div>
          ) : (
            <div className="tag-manager-empty">支持 MP3、M4A、FLAC、WAV 等常见音频格式。</div>
          )}
        </div>
        {error ? <div className="inline-error">{error}</div> : null}
        <p className="settings-hint">
          音乐文件夹内的文件会直接收录；文件夹外的文件会复制到“音乐文件夹 / B站收藏夹 / 分类名”。
        </p>
        <div className="modal-actions">
          <button
            className="btn secondary"
            type="button"
            onClick={props.onClose}
            disabled={props.busy}
          >
            取消
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={props.busy || selecting || files.length === 0}
            onClick={submit}
          >
            {props.busy ? '导入中…' : '导入到收藏夹'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ManualMatchDialog(props: {
  item: PlaylistItemView
  busy: boolean
  onClose: () => void
  onSave: (songId: number) => void
}): React.JSX.Element {
  const [songs, setSongs] = useState<SongView[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<number | null>(props.item.songId)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    window.api
      .getAllSongs()
      .then((items) => {
        if (active) setSongs(items)
      })
      .catch((loadError) => {
        if (active) setError(errorText(loadError))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !props.busy) props.onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [props.busy, props.onClose])

  const candidates = useMemo(() => {
    const search = normalizeSearch(query)
    const itemTitle = normalizeSearch(props.item.title)
    const itemArtist = normalizeSearch(props.item.artist)
    const result = songs.filter((song) => {
      if (!search) return true
      return normalizeSearch(`${song.title} ${song.artist} ${song.album} ${song.path}`).includes(
        search
      )
    })
    return [...result]
      .map((song) => {
        const title = normalizeSearch(song.title)
        const artist = normalizeSearch(song.artist)
        let score = 0
        if (title === itemTitle) score += 10
        else if (title.includes(itemTitle) || itemTitle.includes(title)) score += 6
        if (itemArtist && artist.includes(itemArtist)) score += 3
        if (
          props.item.durationMs > 0 &&
          song.durationMs > 0 &&
          Math.abs(props.item.durationMs - song.durationMs) <= 3000
        ) {
          score += 4
        }
        return { song, score }
      })
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score
        return SONG_COLLATOR.compare(a.song.title, b.song.title)
      })
      .slice(0, 120)
      .map((entry) => entry.song)
  }, [songs, query, props.item])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => {
        if (!props.busy) props.onClose()
      }}
    >
      <div
        className="modal manual-match-modal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="eyebrow">MANUAL MATCH</div>
            <h2>选择本地歌曲匹配</h2>
          </div>
          <button
            className="icon-btn"
            type="button"
            onClick={props.onClose}
            disabled={props.busy}
            title="关闭"
          >
            ✕
          </button>
        </div>
        <div className="manual-match-target">
          <strong title={props.item.title}>{props.item.title}</strong>
          <span>
            {props.item.artist || '未知歌手'} · {formatDurationMs(props.item.durationMs)}
          </span>
          <small>{props.item.note || '等待选择本地文件'}</small>
        </div>
        <div className="library-search manual-match-search">
          <span className="library-search-icon">⌕</span>
          <input
            className="text-input"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索本地歌曲的标题、歌手、专辑或路径"
          />
        </div>
        {loading ? (
          <div className="settings-hint">正在读取本地歌曲…</div>
        ) : (
          <div className="manual-match-list">
            {candidates.length === 0 ? (
              <div className="tag-manager-empty">没有匹配的本地歌曲。</div>
            ) : (
              candidates.map((song) => (
                <button
                  className={`manual-match-row ${selected === song.id ? 'selected' : ''}`}
                  type="button"
                  key={song.id}
                  disabled={props.busy}
                  onClick={() => setSelected(song.id)}
                >
                  <span className="manual-match-check">{selected === song.id ? '✓' : ''}</span>
                  <span className="manual-match-info">
                    <strong>{song.title}</strong>
                    <small>
                      {song.artist || '未知歌手'} · {formatDurationMs(song.durationMs)}
                      {song.id === props.item.songId ? ' · 当前匹配' : ''}
                    </small>
                  </span>
                  <span className="manual-match-path" title={song.path}>
                    {song.path}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
        {error ? <div className="inline-error">{error}</div> : null}
        <p className="settings-hint">
          手动匹配会保留，不会在“重新检测”时被自动覆盖。选择前请确认歌名、时长和文件路径。
        </p>
        <div className="modal-actions">
          <button
            className="btn secondary"
            type="button"
            onClick={props.onClose}
            disabled={props.busy}
          >
            取消
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={props.busy || loading || selected == null}
            onClick={() => {
              if (selected != null) props.onSave(selected)
            }}
          >
            {props.busy ? '保存中…' : '用这首歌匹配'}
          </button>
        </div>
      </div>
    </div>
  )
}

function BiliCategoryDialog(props: {
  song: SongView
  categories: CategoryView[]
  busy: boolean
  onClose: () => void
  onSave: (categoryId: number | null) => void
}): React.JSX.Element {
  const biliCategories = props.categories.filter((category) => category.kind === 'bilibili')
  const [selected, setSelected] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ id: number; name: string } | null>(null)

  useEffect(() => {
    let active = true
    window.api
      .getSongBiliCategory(props.song.id)
      .then((categoryId) => {
        if (active) setSelected(categoryId)
      })
      .catch((loadError) => {
        if (active) setError(errorText(loadError))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [props.song.id])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !props.busy) props.onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [props.busy, props.onClose])

  async function createCategory(): Promise<void> {
    if (!newName.trim() || creating) return
    setCreating(true)
    setError('')
    try {
      const id = await window.api.createBiliCategory(newName.trim())
      setCreated({ id, name: newName.trim() })
      setSelected(id)
      setNewName('')
    } catch (createError) {
      setError(errorText(createError))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => {
        if (!props.busy) props.onClose()
      }}
    >
      <div
        className="modal bili-category-modal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="eyebrow">BILIBILI FAVORITE</div>
            <h2>设置 B站收藏夹分类</h2>
          </div>
          <button
            className="icon-btn"
            type="button"
            onClick={props.onClose}
            disabled={props.busy}
            title="关闭"
          >
            ✕
          </button>
        </div>
        <p className="dialog-song" title={props.song.title}>
          {props.song.title} <span className="muted">· {props.song.artist || '未知歌手'}</span>
        </p>
        {loading ? (
          <div className="settings-hint">正在读取当前分类…</div>
        ) : (
          <div className="bili-category-list">
            <label className={`bili-category-option ${selected == null ? 'selected' : ''}`}>
              <input
                type="radio"
                name="biliCategory"
                checked={selected == null}
                disabled={props.busy}
                onChange={() => setSelected(null)}
              />
              <span>
                <strong>不放入 B站收藏夹分类</strong>
                <small>只移出 B站收藏夹分组，不删除歌曲或文件。</small>
              </span>
            </label>
            {biliCategories.map((category) => (
              <label
                className={`bili-category-option ${selected === category.id ? 'selected' : ''}`}
                key={category.id}
              >
                <input
                  type="radio"
                  name="biliCategory"
                  checked={selected === category.id}
                  disabled={props.busy}
                  onChange={() => setSelected(category.id)}
                />
                <span>
                  <strong>{category.name}</strong>
                  <small>{category.songCount} 首歌曲</small>
                </span>
              </label>
            ))}
            {created && !biliCategories.some((category) => category.id === created.id) ? (
              <label
                className={`bili-category-option ${selected === created.id ? 'selected' : ''}`}
              >
                <input
                  type="radio"
                  name="biliCategory"
                  checked={selected === created.id}
                  disabled={props.busy}
                  onChange={() => setSelected(created.id)}
                />
                <span>
                  <strong>{created.name}</strong>
                  <small>新建分类 · 保存后生效</small>
                </span>
              </label>
            ) : null}
            {biliCategories.length === 0 && !created ? (
              <div className="tag-manager-empty">还没有 B站收藏夹分类，可以在下面新建一个。</div>
            ) : null}
          </div>
        )}
        <div className="bili-category-create">
          <input
            className="text-input"
            maxLength={60}
            value={newName}
            disabled={props.busy || creating}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void createCategory()
              }
            }}
            placeholder="新建 B站收藏夹分类名称"
          />
          <button
            className="btn secondary small-btn"
            type="button"
            disabled={props.busy || creating || !newName.trim()}
            onClick={() => void createCategory()}
          >
            {creating ? '新建中…' : '新建分类'}
          </button>
        </div>
        {error ? <div className="inline-error">{error}</div> : null}
        <p className="settings-hint">
          “移动”只更换 B站收藏夹分类，不影响文件夹、流派、自定义标签、歌曲来源或音频文件。
        </p>
        <div className="modal-actions">
          <button
            className="btn secondary"
            type="button"
            onClick={props.onClose}
            disabled={props.busy}
          >
            取消
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={props.busy || loading}
            onClick={() => props.onSave(selected)}
          >
            {props.busy ? '保存中…' : '保存分类'}
          </button>
        </div>
      </div>
    </div>
  )
}

function TextInputDialog(props: {
  eyebrow: string
  title: string
  label: string
  initial: string
  placeholder: string
  submitLabel: string
  busy: boolean
  maxLength?: number
  onClose: () => void
  onSubmit: (value: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState(props.initial)
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !props.busy) props.onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [props.busy, props.onClose])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => {
        if (!props.busy) props.onClose()
      }}
    >
      <form
        className="modal small-modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          if (value.trim()) props.onSubmit(value.trim())
        }}
      >
        <div className="modal-head">
          <div>
            <div className="eyebrow">{props.eyebrow}</div>
            <h2>{props.title}</h2>
          </div>
          <button
            className="icon-btn"
            type="button"
            onClick={props.onClose}
            disabled={props.busy}
            title="关闭"
          >
            ✕
          </button>
        </div>
        <label className="form-label" htmlFor="textDialogInput">
          {props.label}
        </label>
        <input
          id="textDialogInput"
          className="text-input"
          autoFocus
          maxLength={props.maxLength ?? 80}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={props.placeholder}
        />
        <div className="modal-actions">
          <button
            className="btn secondary"
            type="button"
            onClick={props.onClose}
            disabled={props.busy}
          >
            取消
          </button>
          <button
            className="btn primary"
            type="submit"
            disabled={props.busy || !value.trim()}
          >
            {props.busy ? '保存中…' : props.submitLabel}
          </button>
        </div>
      </form>
    </div>
  )
}

function ConfirmActionDialog(props: {
  eyebrow: string
  title: string
  message: string
  confirmLabel: string
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => {
        if (!props.busy) props.onClose()
      }}
    >
      <div
        className="modal confirm-modal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="confirm-head">
          <div className="eyebrow">{props.eyebrow}</div>
          <h2>{props.title}</h2>
        </div>
        <p className="confirm-lead">{props.message}</p>
        <div className="confirm-actions">
          <button
            className="btn secondary"
            type="button"
            onClick={props.onClose}
            disabled={props.busy}
          >
            取消
          </button>
          <button
            className="btn danger"
            type="button"
            onClick={props.onConfirm}
            disabled={props.busy}
          >
            {props.busy ? '处理中…' : props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function AddToPlaylistDialog(props: {
  playlists: PlaylistSummary[]
  count: number
  busy: boolean
  onClose: () => void
  onSubmit: (playlistId: number | null, newName: string) => void
}): React.JSX.Element {
  const [target, setTarget] = useState(props.playlists[0]?.id ?? 0)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !props.busy) props.onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [props.busy, props.onClose])

  function submit(): void {
    if (target === 0 && !newName.trim()) {
      setError('请输入新歌单名称')
      return
    }
    setError('')
    props.onSubmit(target === 0 ? null : target, target === 0 ? newName.trim() : '')
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => {
        if (!props.busy) props.onClose()
      }}
    >
      <form
        className="modal small-modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="modal-head">
          <div>
            <div className="eyebrow">ADD TO PLAYLIST</div>
            <h2>把 {props.count} 首歌曲加入歌单</h2>
          </div>
          <button
            className="icon-btn"
            type="button"
            onClick={props.onClose}
            disabled={props.busy}
            title="关闭"
          >
            ✕
          </button>
        </div>
        <label className="form-label" htmlFor="targetPlaylistSelect">
          目标歌单
        </label>
        <select
          id="targetPlaylistSelect"
          className="text-input"
          value={target}
          onChange={(event) => {
            setTarget(Number(event.target.value))
            setError('')
          }}
        >
          <option value={0}>＋ 新建歌单</option>
          {props.playlists.map((playlist) => (
            <option key={playlist.id} value={playlist.id}>
              {playlist.name}（{playlist.total} 首）
            </option>
          ))}
        </select>
        {target === 0 ? (
          <input
            className="text-input"
            style={{ marginTop: 8 }}
            autoFocus
            maxLength={80}
            value={newName}
            onChange={(event) => {
              setNewName(event.target.value)
              setError('')
            }}
            placeholder="新歌单名称"
          />
        ) : null}
        {error ? <div className="inline-error">{error}</div> : null}
        <p className="settings-hint">
          已在歌单里的同名歌曲会自动跳过，不会重复添加；不会复制音频文件。
        </p>
        <div className="modal-actions">
          <button
            className="btn secondary"
            type="button"
            onClick={props.onClose}
            disabled={props.busy}
          >
            取消
          </button>
          <button className="btn primary" type="submit" disabled={props.busy}>
            {props.busy ? '加入中…' : '加入歌单'}
          </button>
        </div>
      </form>
    </div>
  )
}

function TagManagerDialog(props: {
  tags: CategoryView[]
  onClose: () => void
  onChanged: (categories: CategoryView[]) => void
  notify: (message: string, kind?: ToastKind) => void
}): React.JSX.Element {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingName, setEditingName] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<number | null>(null)
  const [error, setError] = useState('')

  async function saveRename(tagId: number): Promise<void> {
    if (!editingName.trim()) {
      setError('标签名不能为空')
      return
    }
    setBusy(true)
    setError('')
    try {
      const categories = await window.api.renameTag(tagId, editingName.trim())
      props.onChanged(categories)
      setEditingId(null)
      props.notify('标签已重命名。', 'success')
    } catch (renameError) {
      setError(errorText(renameError))
    } finally {
      setBusy(false)
    }
  }

  async function removeTag(tagId: number): Promise<void> {
    if (pendingDelete !== tagId) {
      setPendingDelete(tagId)
      return
    }
    setBusy(true)
    setError('')
    try {
      const categories = await window.api.deleteTag(tagId)
      props.onChanged(categories)
      setPendingDelete(null)
      props.notify('标签已删除，歌曲文件没有被删除。', 'success')
    } catch (deleteError) {
      setError(errorText(deleteError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="modal tag-manager-modal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="eyebrow">TAG MANAGER</div>
            <h2>标签管理</h2>
          </div>
          <button className="icon-btn" type="button" onClick={props.onClose} title="关闭">
            ✕
          </button>
        </div>
        {props.tags.length === 0 ? (
          <div className="tag-manager-empty">还没有标签。可以在歌曲列表里点“＋标签”添加。</div>
        ) : (
          <div className="tag-manager-list">
            {props.tags.map((tag) => (
              <div className="tag-manager-row" key={tag.id}>
                {editingId === tag.id ? (
                  <>
                    <input
                      className="text-input"
                      autoFocus
                      maxLength={30}
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                    />
                    <button
                      className="btn primary small-btn"
                      type="button"
                      disabled={busy}
                      onClick={() => void saveRename(tag.id)}
                    >
                      保存
                    </button>
                    <button
                      className="btn secondary small-btn"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(null)
                        setError('')
                      }}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <div className="tag-manager-name">
                      <strong>{tag.name}</strong>
                      <span>{tag.songCount} 首</span>
                    </div>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => {
                        setEditingId(tag.id)
                        setEditingName(tag.name)
                        setError('')
                        setPendingDelete(null)
                      }}
                    >
                      重命名
                    </button>
                    <button
                      className={`text-button ${pendingDelete === tag.id ? 'danger-text' : ''}`}
                      type="button"
                      disabled={busy}
                      onClick={() => void removeTag(tag.id)}
                    >
                      {pendingDelete === tag.id ? '确认删除' : '删除'}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        {error ? <div className="inline-error">{error}</div> : null}
        <p className="settings-hint">
          删除标签只移除标签关系，不会删除歌曲或音频文件。标签重命名为已有标签时，会自动合并。
        </p>
      </div>
    </div>
  )
}

function SongTable(props: {
  songs: SongView[]
  currentSongId: number | null
  onPlay: (song: SongView) => void
  onTag: (song: SongView) => void
  emptyTitle: string
  emptyText: string
  onScan: () => void
  onPlayNext: (song: SongView) => void
  onAddToQueue: (song: SongView) => void
  onBiliCategory: (song: SongView) => void
  filtered: boolean
  manageMode: boolean
  selectedSongIds: Set<number>
  allSelected: boolean
  onToggleSelect: (songId: number) => void
  onToggleAll: () => void
}): React.JSX.Element {
  if (props.songs.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-art">♫</div>
        <h2>{props.filtered ? '没有匹配的歌曲' : props.emptyTitle}</h2>
        <p>
          {props.filtered
            ? '换一个关键词或筛选条件，或者清空筛选。'
            : props.emptyText}
        </p>
        {!props.filtered ? (
          <button className="btn secondary" type="button" onClick={props.onScan}>
            扫描音乐文件夹
          </button>
        ) : null}
      </div>
    )
  }
  return (
    <div className="table-shell">
      <table className="data-table song-table">
        <thead>
          <tr>
            {props.manageMode ? (
              <th className="select-cell">
                <input
                  type="checkbox"
                  checked={props.allSelected}
                  onChange={props.onToggleAll}
                  aria-label="全选当前列表"
                />
              </th>
            ) : null}
            <th className="index-cell">#</th>
            <th>歌名</th>
            <th>歌手</th>
            <th>专辑</th>
            <th className="duration-cell">时长</th>
            <th>来源</th>
            <th className="action-cell">操作</th>
          </tr>
        </thead>
        <tbody>
          {props.songs.map((song, index) => {
            const current = song.id === props.currentSongId
            const selected = props.selectedSongIds.has(song.id)
            return (
              <tr
                key={song.id}
                className={`${current ? 'current-row' : ''} ${selected ? 'selected-row' : ''}`}
                onDoubleClick={() => {
                  if (!props.manageMode) props.onPlay(song)
                }}
              >
                {props.manageMode ? (
                  <td className="select-cell">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => props.onToggleSelect(song.id)}
                      aria-label={`选择歌曲 ${song.title}`}
                    />
                  </td>
                ) : null}
                <td className="index-cell">{index + 1}</td>
                <td>
                  <div className="song-title" title={song.path}>
                    {song.title}
                  </div>
                  {song.genre ? <div className="song-note">{song.genre}</div> : null}
                </td>
                <td className="muted-cell">{song.artist || '—'}</td>
                <td className="muted-cell">{song.album || '—'}</td>
                <td className="duration-cell">{formatDurationMs(song.durationMs)}</td>
                <td>
                  <span className={`source-pill ${song.source === 'bilibili' ? 'pink' : ''}`}>
                    {song.source === 'bilibili' ? 'B站收藏夹' : '本地'}
                  </span>
                </td>
                <td className="action-cell">
                  <button
                    className="row-action play-action"
                    type="button"
                    onClick={() => props.onPlay(song)}
                    title="播放"
                  >
                    ▶
                  </button>
                  <button
                    className="row-action queue-action"
                    type="button"
                    onClick={() => props.onPlayNext(song)}
                    title="下一首播放"
                  >
                    ⏭
                  </button>
                  <button
                    className="row-action queue-action"
                    type="button"
                    onClick={() => props.onAddToQueue(song)}
                    title="加入播放队列"
                  >
                    ＋
                  </button>
                  <button
                    className="row-action text-action"
                    type="button"
                    onClick={() => props.onBiliCategory(song)}
                    title="设置 B站收藏夹分类"
                  >
                    B站分类
                  </button>
                  <button
                    className="row-action text-action"
                    type="button"
                    onClick={() => props.onTag(song)}
                    title="加入标签"
                  >
                    ＋标签
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function JobsView(props: {
  jobs: BiliJobView[]
  retryingJob: string | null
  cancellingJob: string | null
  onRefresh: () => void
  onRetry: (jobId: string) => void
  onCancel: (jobId: string) => void
}): React.JSX.Element {
  if (props.jobs.length === 0) {
    return (
      <div className="empty-state jobs-empty">
        <div className="empty-art pink">↓</div>
        <h2>还没有 B站下载任务</h2>
        <p>
          在 Chrome/Edge 中加载插件，打开B站收藏夹详情页，填写软件里生成的端口和 Token
          后发送任务。插件只发任务，下载发生在这台电脑上。
        </p>
        <p className="muted small">可在右上角齿轮 → B站下载设置中打开插件文件夹。</p>
      </div>
    )
  }
  return (
    <div className="job-list">
      {props.jobs.map((job) => {
        const total = job.total
        const done = Math.min(total, job.succeeded + job.failed + job.skipped)
        const percent = total > 0 ? Math.round((done / total) * 100) : job.status === 'running' ? 8 : 0
        const active = job.status === 'running' || job.status === 'queued'
        const canRetry =
          !active &&
          total > 0 &&
          (job.failed > 0 || job.status === 'partial' || job.status === 'interrupted')
        return (
          <article className={`job-card status-${job.status}`} key={job.id}>
            <div className="job-head">
              <div className="job-info">
                <div className="job-name">{job.title || `B站收藏夹 ${job.mediaId}`}</div>
                <div className="job-meta">
                  media_id: {job.mediaId} · 创建于{' '}
                  {new Date(job.createdAt).toLocaleString('zh-CN', { hour12: false })}
                </div>
              </div>
              <span className={`status-pill ${job.status}`}>
                {STATUS_LABELS[job.status] || job.status}
              </span>
            </div>
            <div className="job-progress-row">
              <div className="job-track">
                <div className="job-fill" style={{ width: `${percent}%` }} />
              </div>
              <span className="job-percent">
                {total > 0 ? `${done}/${total}` : active ? '读取中' : '—'}
              </span>
            </div>
            <div className="job-stats">
              <span className="ok-text">成功 {job.succeeded}</span>
              <span>跳过 {job.skipped}</span>
              <span className={job.failed > 0 ? 'danger-text' : ''}>失败 {job.failed}</span>
              <span>待处理 {job.pending}</span>
            </div>
            {job.currentTitle || job.currentPhase ? (
              <div className="job-current">
                {job.currentPhase}
                {job.currentTitle ? `：${job.currentTitle}` : ''}
              </div>
            ) : null}
            {job.lastError ? <div className="job-error">{job.lastError}</div> : null}
            {job.failures.length > 0 ? (
              <div className="job-failures">
                <div className="job-failures-title">失败明细</div>
                {job.failures.map((failure) => (
                  <div className="job-failure" key={failure.bvid}>
                    <span title={failure.message}>{failure.title || failure.bvid}</span>
                    <span className="muted">{failure.message}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="job-actions">
              {active ? <span className="muted small">任务执行中，可关闭插件弹窗。</span> : null}
              {active ? (
                <button
                  className="btn secondary small-btn cancel-job-btn"
                  type="button"
                  disabled={props.cancellingJob === job.id}
                  onClick={() => props.onCancel(job.id)}
                >
                  {props.cancellingJob === job.id ? '正在取消…' : '取消任务'}
                </button>
              ) : null}
              {canRetry ? (
                <button
                  className="btn secondary small-btn"
                  type="button"
                  disabled={props.retryingJob === job.id}
                  onClick={() => props.onRetry(job.id)}
                >
                  {props.retryingJob === job.id ? '正在重试…' : '重试失败条目'}
                </button>
              ) : null}
              {!active && total === 0 && job.status === 'failed' ? (
                <span className="muted small">读取收藏夹阶段失败，请从插件重新发送。</span>
              ) : null}
            </div>
          </article>
        )
      })}
    </div>
  )
}

const THEME_OPTIONS: Array<{
  mode: ThemeMode
  label: string
  description: string
}> = [
  { mode: 'classic', label: '经典', description: '粉黑 · 初始样式' },
  { mode: 'day', label: '日间', description: 'DS 蓝白' },
  { mode: 'night', label: '夜间', description: '深海蓝黑' },
  { mode: 'custom', label: '自定义', description: '自选主色' }
]

function SettingsModal(props: {
  bootstrap: AppBootstrap
  theme: ThemeConfig
  onThemeChange: (theme: ThemeConfig) => void
  onClose: () => void
  onRefresh: (silent?: boolean) => Promise<AppBootstrap | null>
  onChangeRoot: () => Promise<void>
  onScan: () => Promise<void>
  notify: (message: string, kind?: ToastKind) => void
}): React.JSX.Element {
  const [token, setToken] = useState('')
  const [loadingToken, setLoadingToken] = useState(true)
  const [port, setPort] = useState(String(props.bootstrap.settings.bridgePort))
  const [status, setStatus] = useState(props.bootstrap.bridge)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    let active = true
    window.api
      .getToken()
      .then((value) => {
        if (active) setToken(value)
      })
      .catch(() => {
        if (active) setToken('')
      })
      .finally(() => {
        if (active) setLoadingToken(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [props.onClose])

  async function generateToken(): Promise<void> {
    setBusy('token')
    try {
      const next = await window.api.generateToken()
      setToken(next)
      const refreshed = await props.onRefresh(true)
      setStatus(refreshed?.bridge ?? { ...status, tokenConfigured: true })
      props.notify('新 Token 已生成。请把新 Token 填进浏览器插件，旧 Token 立即失效。', 'success')
    } catch (error) {
      props.notify(errorText(error), 'error')
    } finally {
      setBusy('')
    }
  }

  async function savePort(): Promise<void> {
    setBusy('port')
    try {
      const next = await window.api.setBridgePort(Number(port))
      setStatus(next)
      const refreshed = await props.onRefresh(true)
      if (refreshed) setStatus(refreshed.bridge)
      if (next.running) {
        props.notify(`Bridge 已改为 127.0.0.1:${next.port}，请在插件里同步端口。`, 'success')
      } else {
        props.notify(`端口启动失败：${next.error ?? '未知错误'}`, 'error')
      }
    } catch (error) {
      props.notify(errorText(error), 'error')
    } finally {
      setBusy('')
    }
  }

  async function copyToken(): Promise<void> {
    if (!token) return
    try {
      await window.api.copyText(token)
      props.notify('Token 已复制。', 'success')
    } catch (error) {
      props.notify(errorText(error), 'error')
    }
  }

  async function openExtension(): Promise<void> {
    try {
      await window.api.openExtensionFolder()
    } catch (error) {
      props.notify(errorText(error), 'error')
    }
  }

  async function chooseDownloadDir(): Promise<void> {
    setBusy('download-dir')
    try {
      const result = await window.api.chooseBiliDownloadDir()
      if (result.canceled) return
      await props.onRefresh(true)
      props.notify(`B站下载文件夹已设置为：${result.dir ?? ''}`, 'success')
    } catch (error) {
      props.notify(`设置下载文件夹失败：${errorText(error)}`, 'error')
    } finally {
      setBusy('')
    }
  }

  async function resetDownloadDir(): Promise<void> {
    setBusy('download-dir')
    try {
      const dir = await window.api.resetBiliDownloadDir()
      await props.onRefresh(true)
      props.notify(`已恢复默认下载位置：${dir}`, 'success')
    } catch (error) {
      props.notify(`恢复默认失败：${errorText(error)}`, 'error')
    } finally {
      setBusy('')
    }
  }

  async function openDownloadDir(): Promise<void> {
    try {
      await window.api.openBiliDownloadDir()
    } catch (error) {
      props.notify(`打开下载文件夹失败：${errorText(error)}`, 'error')
    }
  }

  async function toggleCloseToTray(enabled: boolean): Promise<void> {
    setBusy('tray')
    try {
      await window.api.setCloseToTray(enabled)
      await props.onRefresh(true)
      props.notify(
        enabled ? '关闭窗口时会最小化到系统托盘。' : '关闭窗口时会直接退出软件。',
        'success'
      )
    } catch (error) {
      props.notify(`保存托盘设置失败：${errorText(error)}`, 'error')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="modal settings-modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <div>
            <div className="eyebrow">PREFERENCES</div>
            <h2>设置</h2>
          </div>
          <button className="icon-btn" type="button" onClick={props.onClose} title="关闭">
            ✕
          </button>
        </div>

        <div className="settings-scroll">
          <section className="settings-section">
            <h3>外观主题</h3>
            <div className="theme-grid">
              {THEME_OPTIONS.map((option) => {
                const selected = props.theme.mode === option.mode
                const previewStyle =
                  option.mode === 'custom'
                    ? {
                        background: `linear-gradient(135deg, ${props.theme.customAccent}, ${props.theme.customBackground})`
                      }
                    : undefined
                return (
                  <button
                    key={option.mode}
                    type="button"
                    className={`theme-option theme-${option.mode} ${selected ? 'selected' : ''}`}
                    onClick={() =>
                      props.onThemeChange({ ...props.theme, mode: option.mode })
                    }
                  >
                    <span className="theme-preview" style={previewStyle}>
                      {option.mode === 'classic' ? (
                        <>
                          <i style={{ background: '#fb7299' }} />
                          <i style={{ background: '#171720' }} />
                        </>
                      ) : option.mode === 'day' ? (
                        <>
                          <i style={{ background: '#4d6bfe' }} />
                          <i style={{ background: '#f4f7ff' }} />
                        </>
                      ) : option.mode === 'night' ? (
                        <>
                          <i style={{ background: '#6f8cff' }} />
                          <i style={{ background: '#08111f' }} />
                        </>
                      ) : (
                        <>
                          <i style={{ background: props.theme.customAccent }} />
                          <i style={{ background: props.theme.customBackground }} />
                        </>
                      )}
                    </span>
                    <span className="theme-copy">
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                    {selected ? <span className="theme-check">✓</span> : null}
                  </button>
                )
              })}
            </div>
            {props.theme.mode === 'custom' ? (
              <div className="theme-custom">
                <label>
                  <span>强调色</span>
                  <input
                    type="color"
                    value={props.theme.customAccent}
                    onChange={(event) =>
                      props.onThemeChange({ ...props.theme, customAccent: event.target.value })
                    }
                  />
                  <code>{props.theme.customAccent}</code>
                </label>
                <label>
                  <span>背景色</span>
                  <input
                    type="color"
                    value={props.theme.customBackground}
                    onChange={(event) =>
                      props.onThemeChange({ ...props.theme, customBackground: event.target.value })
                    }
                  />
                  <code>{props.theme.customBackground}</code>
                </label>
              </div>
            ) : null}
            <p className="settings-hint">
              默认使用“经典”粉黑样式；日间模式使用 DS 蓝白配色，夜间模式为深蓝夜色。
              自定义只需选择强调色和背景色，文字和面板会自动适配对比度。
            </p>
          </section>

          <section className="settings-section">
            <h3>音乐文件夹</h3>
            <div className="path-box" title={props.bootstrap.settings.musicRoot}>
              {props.bootstrap.settings.musicRoot}
            </div>
            <div className="inline-actions">
              <button
                className="btn secondary"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => {
                  props.onChangeRoot().catch((error: unknown) =>
                    props.notify(errorText(error), 'error')
                  )
                }}
              >
                更换文件夹并扫描
              </button>
              <button
                className="btn secondary"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => {
                  props.onScan().catch((error: unknown) =>
                    props.notify(errorText(error), 'error')
                  )
                }}
              >
                重新扫描
              </button>
            </div>
            <p className="settings-hint">
              扫描不会修改你的音乐文件。B站下载位置可以在下一节单独设置。
            </p>
          </section>

          <section className="settings-section">
            <div className="section-title-row">
              <h3>B站下载文件夹</h3>
              <span className={`source-pill ${props.bootstrap.settings.biliDownloadDirIsCustom ? 'pink' : ''}`}>
                {props.bootstrap.settings.biliDownloadDirIsCustom ? '自定义' : '默认'}
              </span>
            </div>
            <div className="path-box" title={props.bootstrap.settings.biliDownloadDir}>
              {props.bootstrap.settings.biliDownloadDir || '尚未设置（先选择音乐文件夹）'}
            </div>
            <div className="inline-actions">
              <button
                className="btn primary-soft"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void chooseDownloadDir()}
              >
                {busy === 'download-dir' ? '设置中…' : '选择下载文件夹'}
              </button>
              <button className="btn secondary" type="button" onClick={() => void openDownloadDir()}>
                打开文件夹
              </button>
              <button
                className="btn secondary"
                type="button"
                disabled={Boolean(busy) || !props.bootstrap.settings.biliDownloadDirIsCustom}
                onClick={() => void resetDownloadDir()}
              >
                恢复默认
              </button>
            </div>
            <p className="settings-hint">
              默认位置是“音乐文件夹\Bilibili”。自定义后，新下载会直接保存到所选目录下的
              “收藏夹名”子文件夹。已经下载的旧文件不会自动搬家。
              如果在软件内播放，B站文件允许来自音乐根目录之外；重新扫描不会把它们误标为缺失。
            </p>
          </section>

          <section className="settings-section">
            <div className="section-title-row">
              <h3>B站 Bridge</h3>
              <span className={`bridge-badge ${status.running ? 'on' : 'off'}`}>
                <span className={`dot ${status.running ? (status.tokenConfigured ? 'ok' : 'warn') : 'bad'}`} />
                {status.running ? `运行中 · 127.0.0.1:${status.port}` : '未运行'}
              </span>
            </div>
            {status.error ? <div className="inline-error">{status.error}</div> : null}

            <label className="form-label" htmlFor="bridgePortInput">
              本地端口
            </label>
            <div className="port-row">
              <input
                id="bridgePortInput"
                className="text-input mono-input"
                type="number"
                min={1024}
                max={65535}
                value={port}
                onChange={(event) => setPort(event.target.value)}
              />
              <button
                className="btn secondary"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void savePort()}
              >
                {busy === 'port' ? '保存中…' : '保存端口'}
              </button>
            </div>
            <p className="settings-hint">
              修改端口会重启本地 Bridge，浏览器插件里的端口必须同步修改。只监听本机
              127.0.0.1，不对局域网开放。
            </p>

            <label className="form-label">配对 Token</label>
            {loadingToken ? (
              <div className="token-box muted">正在读取…</div>
            ) : (
              <div className="token-box mono">{token || '尚未生成 Token'}</div>
            )}
            <div className="inline-actions">
              <button
                className="btn secondary"
                type="button"
                disabled={Boolean(busy) || loadingToken}
                onClick={() => void copyToken()}
              >
                复制 Token
              </button>
              <button
                className="btn primary-soft"
                type="button"
                disabled={Boolean(busy) || loadingToken}
                onClick={() => void generateToken()}
              >
                {busy === 'token' ? '生成中…' : token ? '重新生成' : '生成 Token'}
              </button>
              <button className="btn secondary" type="button" onClick={() => void openExtension()}>
                打开插件文件夹
              </button>
            </div>
            <p className="settings-hint">
              重新生成会让插件里的旧 Token 立即失效。所有没有 Token 的请求都会被拒绝。
            </p>
          </section>

          <section className="settings-section guide-section">
            <h3>插件使用顺序</h3>
            <ol className="guide-list">
              <li>
                点“打开插件文件夹”，记下这个目录。Chrome 打开{' '}
                <code>chrome://extensions</code>（Edge 是 <code>edge://extensions</code>），
                打开“开发者模式”，选择“加载已解压的扩展程序”，选中该目录。
              </li>
              <li>在插件弹窗里填入上面的端口和配对 Token，点“保存并测试连接”。</li>
              <li>
                打开 B站“收藏夹详情页”（地址里应带 <code>fid=数字</code>），点击插件图标，
                需要登录内容时勾选“携带登录 Cookie”，然后发送任务。
              </li>
              <li>
                回到 DS音乐播放器的“B站下载任务”。下载成功后，音频会进入对应 B站收藏夹分类。
              </li>
            </ol>
            <p className="settings-hint">
              当前版本保存B站原始 DASH 音频为 m4a，不强制转码；不内嵌浏览器登录，也不绕过付费或受限内容。
            </p>
          </section>

          <section className="settings-section">
            <h3>数据与隐私</h3>
            <p className="settings-hint">
              数据库、日志和缓存都保存在 Windows 用户数据目录（app.getPath('userData')），
              不会写安装目录。音频只保存在你选择的音乐文件夹。插件默认不发送 Cookie；
              开启时 Cookie 只用于本次任务，不写入数据库、不写日志。
            </p>
          </section>

          <section className="settings-section">
            <h3>系统托盘</h3>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={props.bootstrap.settings.closeToTray}
                disabled={Boolean(busy)}
                onChange={(event) => void toggleCloseToTray(event.target.checked)}
              />
              <span>
                <strong>关闭窗口时最小化到托盘</strong>
                <small>托盘菜单可以播放/暂停、上一首、下一首、显示歌词和退出。</small>
              </span>
            </label>
            <p className="settings-hint">
              关闭此选项后，点击窗口右上角 ✕ 会直接退出软件。无论此选项如何，运行期间托盘图标都会存在。
            </p>
          </section>

          <section className="settings-section about-section">
            <h3>关于 / 开发信息</h3>
            <div className="dev-info-grid">
              <div>
                <span>产品</span>
                <strong>
                  {props.bootstrap.developmentInfo.productName}（
                  {props.bootstrap.developmentInfo.abbreviation}）
                </strong>
              </div>
              <div>
                <span>版本</span>
                <strong>v{props.bootstrap.appVersion}</strong>
              </div>
              <div>
                <span>原始主要开发</span>
                <strong>
                  {props.bootstrap.developmentInfo.originalDeveloper} ·{' '}
                  {props.bootstrap.developmentInfo.developmentRole}
                </strong>
              </div>
              <div>
                <span>项目发起 / 维护</span>
                <strong>{props.bootstrap.developmentInfo.maintainer}</strong>
              </div>
              <div>
                <span>GitHub</span>
                <strong className="mono">
                  {props.bootstrap.developmentInfo.maintainerUrl.replace('https://', '')}
                </strong>
              </div>
              <div>
                <span>基于版本</span>
                <strong>v{props.bootstrap.developmentInfo.basedOnVersion}</strong>
              </div>
              <div>
                <span>AI 工具</span>
                <strong>{props.bootstrap.developmentInfo.aiTools.join(' / ')}</strong>
              </div>
              <div>
                <span>开发时间</span>
                <strong>{props.bootstrap.developmentInfo.developmentDate}</strong>
              </div>
              <div>
                <span>许可证</span>
                <strong>{props.bootstrap.developmentInfo.license}</strong>
              </div>
            </div>
            <p className="settings-hint">{props.bootstrap.developmentInfo.notice}</p>
          </section>
        </div>
      </div>
    </div>
  )
}

function TagDialog(props: {
  song: SongView
  busy: boolean
  onClose: () => void
  onSave: (name: string) => void
  onChanged: (categories: CategoryView[]) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [tags, setTags] = useState<CategoryView[]>([])
  const [removingId, setRemovingId] = useState<number | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    window.api
      .getSongTags(props.song.id)
      .then((items) => {
        if (active) setTags(items)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [props.song.id])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [props.onClose])

  async function removeTag(categoryId: number): Promise<void> {
    setRemovingId(categoryId)
    setError('')
    try {
      const categories = await window.api.removeTagFromSong(props.song.id, categoryId)
      const nextTags = await window.api.getSongTags(props.song.id)
      setTags(nextTags)
      props.onChanged(categories)
    } catch (removeError) {
      setError(errorText(removeError))
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <form
        className="modal small-modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          if (value.trim()) props.onSave(value.trim())
        }}
      >
        <div className="modal-head">
          <div>
            <div className="eyebrow">TAG</div>
            <h2>给歌曲加标签</h2>
          </div>
          <button className="icon-btn" type="button" onClick={props.onClose} title="关闭">
            ✕
          </button>
        </div>
        <p className="dialog-song" title={props.song.title}>
          {props.song.title} <span className="muted">· {props.song.artist || '未知歌手'}</span>
        </p>
        {tags.length > 0 ? (
          <div className="tag-chip-row">
            {tags.map((tag) => (
              <span className="tag-chip" key={tag.id}>
                {tag.name}
                <button
                  type="button"
                  className="tag-chip-remove"
                  title={`移除标签 ${tag.name}`}
                  disabled={removingId === tag.id}
                  onClick={() => void removeTag(tag.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="settings-hint">这首歌还没有标签。</p>
        )}
        {error ? <div className="inline-error">{error}</div> : null}
        <label className="form-label" htmlFor="tagNameInput">
          标签名（最多 30 字）
        </label>
        <input
          id="tagNameInput"
          className="text-input"
          autoFocus
          maxLength={30}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="例如：通勤、钢琴、收藏"
        />
        <div className="modal-actions">
          <button className="btn secondary" type="button" onClick={props.onClose}>
            取消
          </button>
          <button className="btn primary" type="submit" disabled={props.busy || !value.trim()}>
            {props.busy ? '保存中…' : '保存标签'}
          </button>
        </div>
      </form>
    </div>
  )
}
