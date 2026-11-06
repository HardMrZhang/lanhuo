export interface AccountUser {
  id: string
  email: string
  vipActive: boolean
  vipExpiresAt: string | null
  emailVerified: boolean
}

export interface VipPlan {
  id: string
  name: string
  days: number
  price: number
  currency: 'USDT'
  recommended: boolean
}

export interface VipOrder {
  id: string
  planId: string
  planName: string
  days: number
  amount: number
  currency: 'USDT'
  status: 'creating' | 'pending' | 'confirming' | 'partially_paid' | 'paid' | 'failed' | 'expired' | 'refunded' | 'review'
  /** 'base' 是改造前的历史通道标识，链上收款方式与 'bsc' 一致，服务端已统一归一化。 */
  provider: 'nowpayments' | 'vaehub' | 'bsc' | 'base'
  createdAt: string
  paidAt: string | null
  checkoutUrl: string | null
  payAddress: string | null
  payAmount: number | null
  /** 应付金额的精确文本（BSC 链通道：尾数是订单唯一标识，不能丢尾零）。 */
  payAmountText: string | null
  payCurrency: string | null
  qrString: string | null
  qrExpiresAt: string | null
  network: string
  expiresAt: string | null
  /** BSC 链通道：代币符号与链 ID，用于提醒用户核对网络。 */
  tokenSymbol: string | null
  chainId: number | null
  /** BSC 链通道：代币合约地址（用户核对充值币种时需要）。 */
  tokenContract: string | null
  /** 链上交易哈希，到账后写入，便于人工核对。 */
  txHash: string | null
}

export interface VipProvider {
  id: VipProviderId
  name: string
}

/** 支付通道标识：NOWPayments（USDT）、VaeHub（法币代收）、BSC 链（自建固定地址）。 */
export type VipProviderId = 'nowpayments' | 'vaehub' | 'bsc'

export interface VipCatalog {
  plans: VipPlan[]
  payment: { providers: VipProvider[]; enabled: boolean; currencies: string[]; network: string }
}

/** 服务端下发的账号能力开关，前端据此决定是否显示验证码/找回密码等入口。 */
export interface AuthCapabilities {
  captcha: boolean
  passwordReset: boolean
  emailVerification: boolean
}

export interface CaptchaChallenge {
  id: string | null
  svg: string | null
  required: boolean
}

/**
 * 图形验证码答案。服务端按 captchaId / captchaText 两个字段校验，
 * 与题目 id / text 的含义不同，这里显式区分，避免字段名错配导致校验永远失败。
 */
export interface CaptchaAnswer {
  captchaId: string
  captchaText: string
}

export class AccountApiError extends Error {
  constructor(message: string, public status: number, public payload: Record<string, unknown> | null = null) {
    super(message)
  }
}

export async function accountRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 25000)
  try {
    const response = await fetch(`/api${path}`, {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const message = typeof payload?.error === 'string' ? payload.error : typeof payload?.message === 'string' ? payload.message : '请求失败，请稍后重试。'
      throw new AccountApiError(message, response.status, payload && typeof payload === 'object' ? payload : null)
    }
    if (!payload) throw new Error('服务暂时不可用，请稍后重试。')
    return payload as T
  } catch (error) {
    if (error instanceof AccountApiError) throw error
    if (error instanceof Error && error.name === 'AbortError') throw new Error('请求超时，请重试；重复尝试不会重复创建同一笔订单。')
    if (error instanceof TypeError) throw new Error('网络连接失败，请检查网络后重试。')
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}

export const vipApi = {
  plans: () => accountRequest<VipCatalog>('/vip/plans'),
  orders: () => accountRequest<{ orders: VipOrder[] }>('/vip/orders'),
  order: (id: string) => accountRequest<{ order: VipOrder; user: AccountUser }>(`/vip/orders/${encodeURIComponent(id)}`),
  create: (planId: string, key: string, provider?: string) => accountRequest<{ order: VipOrder }>('/vip/orders', {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify(provider ? { planId, provider } : { planId }),
  }),
}

export const authApi = {
  capabilities: () => accountRequest<AuthCapabilities>('/auth/providers'),
  captcha: () => accountRequest<CaptchaChallenge>('/auth/captcha'),
  verifyEmail: (token: string) => accountRequest<{ verified: boolean }>('/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token }),
  }),
  resendVerification: (lang: string) => accountRequest<{ sent: boolean; alreadyVerified?: boolean }>('/auth/resend-verification', {
    method: 'POST',
    body: JSON.stringify({ lang }),
  }),
  forgotPassword: (email: string, lang: string, captcha?: CaptchaAnswer) => accountRequest<{ sent: boolean }>('/auth/password/forgot', {
    method: 'POST',
    body: JSON.stringify({ email, lang, ...(captcha ?? {}) }),
  }),
  resetPassword: (token: string, password: string) => accountRequest<{ reset: boolean }>('/auth/password/reset', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  }),
}
