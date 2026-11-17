import { useEffect, useMemo, useRef, useState } from 'react'
import type { LyricsData, LyricsPlaybackState } from '../../shared/types'

const EMPTY_PLAYBACK: LyricsPlaybackState = {
  songId: null,
  title: '',
  artist: '',
  currentTimeMs: 0,
  durationMs: 0,
  isPlaying: false
}

function readFontSize(): number {
  const stored = Number(localStorage.getItem('desktopLyricsFontSize') ?? '32')
  if (!Number.isFinite(stored)) return 32
  return Math.min(72, Math.max(18, Math.round(stored)))
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}

export default function LyricsOverlay(): React.JSX.Element {
  const [playback, setPlayback] = useState<LyricsPlaybackState>(EMPTY_PLAYBACK)
  const [lyrics, setLyrics] = useState<LyricsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fontSize, setFontSize] = useState(readFontSize)
  const [tick, setTick] = useState(0)
  const [reloadNonce, setReloadNonce] = useState(0)
  const playbackRef = useRef<LyricsPlaybackState>(EMPTY_PLAYBACK)
  const playbackReceivedAt = useRef(Date.now())
  const lyricsRequestSeq = useRef(0)

  useEffect(() => {
    document.body.classList.add('lyrics-mode')
    document.documentElement.classList.add('lyrics-mode')
    return () => {
      document.body.classList.remove('lyrics-mode')
      document.documentElement.classList.remove('lyrics-mode')
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('desktopLyricsFontSize', String(fontSize))
  }, [fontSize])

  useEffect(() => {
    window.api.onDesktopLyricsVisibility((visible) => {
      if (visible) setReloadNonce((value) => value + 1)
    })
  }, [])

  useEffect(() => {
    let active = true
    const applyPlayback = (next: LyricsPlaybackState): void => {
      if (!active) return
      playbackRef.current = next
      playbackReceivedAt.current = Date.now()
      setPlayback(next)
    }

    window.api.onLyricsPlayback(applyPlayback)
    window.api
      .getLyricsPlaybackState()
      .then(applyPlayback)
      .catch(() => undefined)

    const timer = window.setInterval(() => {
      setTick((value) => value + 1)
    }, 100)

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const songId = playback.songId
    const sequence = lyricsRequestSeq.current + 1
    lyricsRequestSeq.current = sequence
    setError('')
    setLyrics(null)
    if (!songId) {
      setLoading(false)
      return
    }
    setLoading(true)
    window.api
      .getLyricsForSong(songId)
      .then((result) => {
        if (sequence !== lyricsRequestSeq.current) return
        setLyrics(result)
        if (!result.found && result.error) setError(result.error)
      })
      .catch((loadError) => {
        if (sequence !== lyricsRequestSeq.current) return
        setError(errorText(loadError))
      })
      .finally(() => {
        if (sequence === lyricsRequestSeq.current) setLoading(false)
      })
  }, [playback.songId, reloadNonce])

  const estimatedTime = useMemo(() => {
    const state = playbackRef.current
    const elapsed = state.isPlaying ? Date.now() - playbackReceivedAt.current : 0
    const estimated = state.currentTimeMs + elapsed
    if (state.durationMs > 0) return Math.min(state.durationMs, estimated)
    return estimated
    // `tick` deliberately invalidates this calculation while the audio is playing.
  }, [playback, tick])

  const currentIndex = useMemo(() => {
    const lines = lyrics?.lines ?? []
    if (lines.length === 0) return -1
    let index = -1
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].timeMs <= estimatedTime + 80) index = i
      else break
    }
    return index
  }, [lyrics, estimatedTime])

  const previousLine =
    lyrics?.found && currentIndex > 0 ? lyrics.lines[currentIndex - 1]?.text : ''
  const currentLine =
    lyrics?.found && currentIndex >= 0 ? lyrics.lines[currentIndex]?.text : ''
  const nextLine =
    lyrics?.found && lyrics.lines.length > 0
      ? lyrics.lines[currentIndex >= 0 ? currentIndex + 1 : 0]?.text ?? ''
      : ''

  async function chooseLyrics(): Promise<void> {
    if (!playback.songId || loading) return
    setLoading(true)
    setError('')
    try {
      const result = await window.api.chooseLyricsFile(playback.songId)
      if (result) {
        setLyrics(result)
        if (!result.found) setError(result.error ?? '这个文件里没有可用歌词')
      }
    } catch (chooseError) {
      setError(errorText(chooseError))
    } finally {
      setLoading(false)
    }
  }

  function changeFontSize(delta: number): void {
    setFontSize((current) => Math.min(72, Math.max(18, current + delta)))
  }

  function closeOverlay(): void {
    void window.api.hideDesktopLyrics()
  }

  return (
    <div className="lyrics-window">
      <div className="lyrics-toolbar">
        <div className="lyrics-heading">
          <span className="lyrics-live-dot" />
          <span>桌面歌词</span>
          {playback.title ? (
            <span className="lyrics-heading-track">
              {playback.title}
              {playback.artist ? ` · ${playback.artist}` : ''}
            </span>
          ) : null}
        </div>
        <div className="lyrics-toolbar-actions">
          <button type="button" className="lyrics-tool" onClick={() => changeFontSize(-2)} title="缩小歌词">
            A−
          </button>
          <span className="lyrics-font-value">{fontSize}</span>
          <button type="button" className="lyrics-tool" onClick={() => changeFontSize(2)} title="放大歌词">
            A+
          </button>
          <button
            type="button"
            className="lyrics-tool lyrics-tool-wide"
            onClick={() => void chooseLyrics()}
            disabled={!playback.songId || loading}
          >
            选歌词
          </button>
          <button type="button" className="lyrics-close" onClick={closeOverlay} title="隐藏桌面歌词">
            ✕
          </button>
        </div>
      </div>

      <div className="lyrics-content">
        {!playback.songId ? (
          <div className="lyrics-empty">
            <div className="lyrics-empty-title">播放一首歌后显示歌词</div>
            <div className="lyrics-empty-hint">
              将同名 .lrc 放在歌曲旁边，或播放后点“选歌词”
            </div>
          </div>
        ) : loading ? (
          <div className="lyrics-status">正在读取歌词…</div>
        ) : error ? (
          <div className="lyrics-empty">
            <div className="lyrics-empty-title">没有找到可用歌词</div>
            <div className="lyrics-error">{error}</div>
            <button
              className="lyrics-load-button"
              type="button"
              onClick={() => void chooseLyrics()}
            >
              选择 LRC 文件
            </button>
          </div>
        ) : lyrics?.found ? (
          <div className="lyrics-lines">
            <div className="lyrics-line lyrics-line-dim" style={{ fontSize: Math.round(fontSize * 0.7) }}>
              {previousLine || '\u00a0'}
            </div>
            <div className="lyrics-line lyrics-line-current" style={{ fontSize }}>
              {currentLine || (nextLine ? '\u00a0' : '…')}
            </div>
            <div className="lyrics-line lyrics-line-next" style={{ fontSize: Math.round(fontSize * 0.78) }}>
              {nextLine || '\u00a0'}
            </div>
          </div>
        ) : (
          <div className="lyrics-empty">
            <div className="lyrics-empty-title">还没有歌词</div>
            <div className="lyrics-empty-hint">
              自动查找同名 .lrc 失败。可以手动选择这个歌曲的歌词文件。
            </div>
            <button
              className="lyrics-load-button"
              type="button"
              onClick={() => void chooseLyrics()}
            >
              选择 LRC 文件
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
