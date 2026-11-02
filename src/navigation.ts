import type { DramaSummary } from './types'
import { tr } from './i18n'

export interface ContentChannel {
  id: string
  name: string
  categoryIds: string[]
  available: boolean
}

export const contentChannels: ContentChannel[] = [
  {
    id: 'shorts',
    get name() { return tr('成人短剧', 'Adult Shorts') },
    categoryIds: ['urban', 'romance', 'costume', 'suspense', 'comeback', 'fantasy', 'family'],
    available: true,
  },
  { id: 'western', get name() { return tr('欧美短剧', 'Western Shorts') }, categoryIds: ['western'], available: true },
  {
    id: 'live',
    get name() { return tr('真人剧', 'Live Action') },
    categoryIds: ['urban', 'romance', 'costume', 'suspense', 'comeback', 'family'],
    available: true,
  },
  { id: 'videos', get name() { return tr('成人视频', 'Adult Videos') }, categoryIds: [], available: true },
  { id: 'novels', get name() { return tr('成人小说', 'Adult Fiction') }, categoryIds: [], available: false },
]

export function dramasForChannel(dramas: DramaSummary[], id: string): DramaSummary[] {
  const channel = contentChannels.find((item) => item.id === id)
  if (!channel) return dramas
  if (!channel.available) return []
  return dramas.filter((drama) => {
    if (drama.channelId) return drama.channelId === id
    return !channel.categoryIds.length || channel.categoryIds.includes(drama.categoryIds[0] ?? '')
  })
}
