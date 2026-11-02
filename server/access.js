/**
 * 付费集数规则：每部剧第 1 集免费，第 2 集起需有效 VIP 会员。
 * 前端用于展示锁定状态，服务端用于拦截媒体文件，两处必须保持一致。
 */
export const FREE_EPISODES = 1
export const PAYWALL_START_EPISODE = FREE_EPISODES + 1

export function isEpisodeLocked(no) {
  return Number.isFinite(no) && no >= PAYWALL_START_EPISODE
}

/** 只对站内 /media 资源做服务端鉴权；外部地址无法在此拦截。 */
export function mediaPathOf(src) {
  if (typeof src !== 'string') return null
  const pathname = src.split(/[?#]/)[0]
  return pathname.startsWith('/media/') ? pathname.slice('/media'.length) : null
}

/** 需要 VIP 才能访问的媒体路径集合（相对 /media 挂载点）。 */
export function lockedMediaPaths(dramas) {
  const locked = new Set()
  for (const drama of dramas ?? []) {
    for (const episode of drama.episodes ?? []) {
      if (!isEpisodeLocked(episode.no)) continue
      const pathname = mediaPathOf(episode.src)
      if (pathname) locked.add(pathname)
    }
  }
  return locked
}
