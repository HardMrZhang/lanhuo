export interface AccountUser {
  id: string
  email: string
  vipActive: boolean
  vipExpiresAt: string | null
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
  provider: 'nowpayments' | 'vaehub'
  createdAt: string
  paidAt: string | null
  checkoutUrl: string | null
  payAddress: string | null
  payAmount: number | null
  payCurrency: string | null
  qrString: string | null
  qrExpiresAt: string | null
  network: string
  expiresAt: string | null
}

export interface VipProvider {
  id: 'nowpayments' | 'vaehub'
  name: string
}

export interface VipCatalog {
  plans: VipPlan[]
  payment: { providers: VipProvider[]; enabled: boolean; currencies: string[]; network: string }
}

export class AccountApiError extends Error {
  constructor(message: string, public status: number) {
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
      throw new AccountApiError(message, response.status)
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
