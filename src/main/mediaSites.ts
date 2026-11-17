import type { CategoryKind, LocalImportResult } from '../shared/types'
import type { DatabaseStore } from './db'
import { importLocalFilesToCategory } from './core'

/**
 * 视频网站收藏夹的扩展接口。
 *
 * 以后增加 YouTube、Vimeo 等站点时，只需要实现这个接口并注册到
 * MEDIA_SITE_PROVIDERS，不必再改歌单/歌曲库主流程。
 */
export interface MediaSiteProvider {
  id: string
  label: string
  categoryKind: CategoryKind
  folderName: string
  importLocalFiles(
    store: DatabaseStore,
    root: string,
    categoryId: number,
    files: string[]
  ): Promise<LocalImportResult>
}

export const MEDIA_SITE_PROVIDERS: MediaSiteProvider[] = [
  {
    id: 'bilibili',
    label: 'B站收藏夹',
    categoryKind: 'bilibili',
    folderName: 'B站收藏夹',
    importLocalFiles: (store, root, categoryId, files) =>
      importLocalFilesToCategory(store, root, categoryId, 'bilibili', 'B站收藏夹', files)
  }
]

export function getMediaSiteProvider(id: string): MediaSiteProvider {
  const provider = MEDIA_SITE_PROVIDERS.find((item) => item.id === id)
  if (!provider) throw new Error('不支持的视频网站类型')
  return provider
}
