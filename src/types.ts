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
  categoryIds: string[]
  tags?: string[]
  /** 完结 / 更新中 */
  status: 'completed' | 'ongoing'
  views?: number
  episodes: Episode[]
}

/** 列表接口返回的精简版（不含 episodes） */
export type DramaSummary = Omit<Drama, 'episodes'> & { episodeCount: number }
