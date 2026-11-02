export interface Category {
  id: string
  name: string
}

export interface Episode {
  /** 1-based 集数 */
  no: number
  title?: string
  /** 视频地址：支持 .m3u8（HLS）或 .mp4 */
  src: string
  /** 时长（秒），可选 */
  duration?: number
}

export interface Drama {
  id: string
  title: string
  cover: string
  description: string
  /** 显式导入栏目；未设置的旧演示数据继续按题材分类匹配。 */
  channelId?: 'shorts' | 'anime' | 'western'
  categoryIds: string[]
  tags?: string[]
  /** 完结 / 更新中 */
  status: 'completed' | 'ongoing'
  views?: number
  /** 好评率 0-100 */
  rating?: number
  /** 是否高清标识 */
  hd?: boolean
  /** 上架时间 ISO 字符串，用于「最新」排序 */
  publishedAt?: string
  episodes: Episode[]
}

/** 列表接口返回的精简版（不含 episodes） */
export type DramaSummary = Omit<Drama, 'episodes'> & { episodeCount: number }
