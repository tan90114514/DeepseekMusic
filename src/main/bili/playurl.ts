import { BiliError, biliApi } from './http'

interface ViewData {
  cid?: number
  duration?: number
  pages?: Array<{ cid?: number; part?: string }>
}

export interface VideoInfo {
  cid: number
  durationSec: number
  pageCount: number
}

export interface AudioStream {
  urls: string[]
  bandwidth: number
  mimeType: string
}

interface DashAudio {
  baseUrl?: string
  base_url?: string
  backupUrl?: string[]
  backup_url?: string[]
  bandwidth?: number
  mimeType?: string
  mime_type?: string
  codecs?: string
}

interface PlayurlData {
  dash?: {
    audio?: DashAudio[] | null
  } | null
}

export async function fetchVideoInfo(bvid: string, cookie: string): Promise<VideoInfo> {
  const data = await biliApi<ViewData>(
    'x/web-interface/view',
    { bvid },
    { cookie, referer: `https://www.bilibili.com/video/${bvid}` }
  )
  const cid = Number(data.pages?.[0]?.cid ?? data.cid ?? 0)
  if (!cid) throw new BiliError('无法获取视频播放分片 ID', 'BILI_CID_NOT_FOUND', false)
  return {
    cid,
    durationSec: Math.max(0, Number(data.duration ?? 0)),
    pageCount: data.pages?.length ?? 1
  }
}

function extractUrls(audio: DashAudio): string[] {
  const urls = [
    audio.baseUrl,
    audio.base_url,
    ...(audio.backupUrl ?? []),
    ...(audio.backup_url ?? [])
  ].filter((value): value is string => typeof value === 'string' && value.startsWith('http'))
  return [...new Set(urls)]
}

export async function fetchAudioStream(
  bvid: string,
  cid: number,
  cookie: string
): Promise<AudioStream> {
  const params = {
    bvid,
    cid,
    fnval: 16,
    fnver: 0,
    fourk: 1
  }
  let data: PlayurlData
  try {
    data = await biliApi<PlayurlData>('x/player/wbi/playurl', params, {
      cookie,
      sign: true,
      referer: `https://www.bilibili.com/video/${bvid}`,
      timeoutMs: 30000
    })
  } catch (signedError) {
    // Keep a fallback for the day Bilibili changes only the WBI path.
    try {
      data = await biliApi<PlayurlData>('x/player/playurl', params, {
        cookie,
        sign: false,
        referer: `https://www.bilibili.com/video/${bvid}`,
        timeoutMs: 30000
      })
    } catch {
      throw signedError
    }
  }

  const audios = (data.dash?.audio ?? []).filter((audio) => extractUrls(audio).length > 0)
  if (audios.length === 0) {
    throw new BiliError(
      '该视频没有可下载的 DASH 音频流（可能是番剧、付费内容或接口变化）',
      'DASH_AUDIO_NOT_FOUND',
      false
    )
  }
  audios.sort((a, b) => Number(b.bandwidth ?? 0) - Number(a.bandwidth ?? 0))
  const best = audios[0]
  return {
    urls: extractUrls(best),
    bandwidth: Number(best.bandwidth ?? 0),
    mimeType: String(best.mimeType ?? best.mime_type ?? 'audio/mp4')
  }
}
