import { accountRequest, type AccountApiError } from './vip-api'

/** 邀请记录条目（邮箱已脱敏）。 */
export interface ReferralInvite {
  email: string
  boundAt: number
  source: string
}

/** 邀请概览：邀请码、邀请链接、已邀请人数与明细。 */
export interface ReferralOverview {
  code: string
  linkPath: string
  invitedCount: number
  invited: ReferralInvite[]
  invitedBy: { email: string; code: string } | null
}

export const referralApi = {
  overview: () => accountRequest<ReferralOverview>('/referral/overview'),
  bind: (code: string) => accountRequest<{ bound: boolean }>('/referral/bind', {
    method: 'POST',
    body: JSON.stringify({ code }),
  }),
  bindLink: (code: string) => accountRequest<{ bound: boolean; reason: string | null }>('/referral/bind-link', {
    method: 'POST',
    body: JSON.stringify({ code }),
  }),
}

export { AccountApiError }
