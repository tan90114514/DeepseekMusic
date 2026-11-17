import { biliApi } from './http'

interface FavoriteMedia {
  bvid?: string
  title?: string
  duration?: number
  type?: number
  upper?: { name?: string }
  attr?: number
}

interface FavoritePageData {
  info?: {
    id?: number
    title?: string
    media_count?: number
  }
  medias?: FavoriteMedia[] | null
  has_more?: boolean
}

export interface FavoriteItem {
  bvid: string
  title: string
  upName: string
  durationSec: number
}

export interface FavoriteResult {
  title: string
  items: FavoriteItem[]
}

const PAGE_SIZE = 20
const MAX_PAGES = 200

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchFavorite(
  mediaId: string,
  cookie: string,
  onPage?: (page: number, collected: number) => void
): Promise<FavoriteResult> {
  const items: FavoriteItem[] = []
  const seen = new Set<string>()
  let title = ''
  let declaredCount = 0

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await biliApi<FavoritePageData | null>(
      'x/v3/fav/resource/list',
      {
        media_id: mediaId,
        pn: page,
        ps: PAGE_SIZE,
        platform: 'web',
        order: 'mtime',
        type: 0,
        tid: 0
      },
      { cookie }
    )

    if (!data) {
      if (page === 1) {
        throw new Error('收藏夹不存在、不可见，或需要登录 Cookie')
      }
      break
    }
    if (data.info?.title) {
      title = data.info.title
      declaredCount = Number(data.info.media_count ?? declaredCount)
    }

    const medias = data.medias ?? []
    for (const media of medias) {
      const bvid = String(media.bvid ?? '').trim()
      if (!bvid || (media.type !== undefined && media.type !== 2)) continue
      if (seen.has(bvid)) continue
      seen.add(bvid)
      items.push({
        bvid,
        title: String(media.title ?? '').trim() || bvid,
        upName: String(media.upper?.name ?? '').trim(),
        durationSec: Math.max(0, Number(media.duration ?? 0))
      })
    }
    onPage?.(page, items.length)
    if (medias.length < PAGE_SIZE) break
    if (declaredCount > 0 && items.length >= declaredCount) break
    await sleep(250)
  }

  return {
    title: title.trim() || `B站收藏夹 ${mediaId}`,
    items
  }
}
