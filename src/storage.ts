/** 本地观看记录 / 收藏，存 localStorage，无需登录。 */

const HISTORY_KEY = 'duanju:history'
const FAV_KEY = 'duanju:favorites'

export interface HistoryItem {
  ep: number
  /** 该集观看进度（秒） */
  time: number
  updatedAt: number
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 隐私模式或空间不足时忽略 */
  }
}

export const history = {
  get(dramaId: string): HistoryItem | undefined {
    return read<Record<string, HistoryItem>>(HISTORY_KEY, {})[dramaId]
  },
  set(dramaId: string, ep: number, time = 0) {
    const all = read<Record<string, HistoryItem>>(HISTORY_KEY, {})
    all[dramaId] = { ep, time, updatedAt: Date.now() }
    write(HISTORY_KEY, all)
  },
}

export const favorites = {
  has(dramaId: string) {
    return read<string[]>(FAV_KEY, []).includes(dramaId)
  },
  toggle(dramaId: string) {
    const list = read<string[]>(FAV_KEY, [])
    const i = list.indexOf(dramaId)
    if (i >= 0) list.splice(i, 1)
    else list.unshift(dramaId)
    write(FAV_KEY, list)
    return i < 0
  },
}
