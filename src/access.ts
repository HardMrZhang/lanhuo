/**
 * 付费规则（与 server/access.js 保持一致）：
 * 每部剧第 1 集免费，第 2 集起需要有效期内的 VIP 会员。
 */
export const FREE_EPISODES = 1
export const PAYWALL_START_EPISODE = FREE_EPISODES + 1

/** 只按集数判断是否属于付费集，与用户身份无关。 */
export function isPaidEpisode(no: number) {
  return Number.isFinite(no) && no >= PAYWALL_START_EPISODE
}
