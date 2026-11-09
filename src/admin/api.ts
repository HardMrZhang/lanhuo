/**
 * 后台 API 客户端。
 *
 * 两个后台共用同一个客户端工厂，但各自指向不同的接口前缀：
 *   支付后台   /admin-api/payment
 *   推荐后台   /admin-api/recommend
 *
 * 服务端用不同的 Cookie 名维护两套登录态，所以浏览器里同时开两个后台
 * 也不会互相顶掉。
 */
import { reactive, readonly } from 'vue'

export const ADMIN_AREAS = {
  payment: { base: '/admin-api/payment', title: '支付管理后台', cookie: 'duanju_admin_payment' },
  recommend: { base: '/admin-api/recommend', title: '推荐系统后台', cookie: 'duanju_admin_recommend' },
} as const

export type AdminArea = keyof typeof ADMIN_AREAS

export interface AdminUser {
  id: string
  username: string
  role: string
  displayName: string
  enabled: boolean
  createdAt: number
  lastLoginAt: number | null
}

export class AdminApiError extends Error {
  constructor(message: string, public status: number) {
    super(message)
  }
}

async function request<T>(base: string, path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 25000)
  try {
    const response = await fetch(`${base}${path}`, {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const message = typeof payload?.error === 'string' ? payload.error : `请求失败（${response.status}）`
      throw new AdminApiError(message, response.status)
    }
    return payload as T
  } catch (error) {
    if (error instanceof AdminApiError) throw error
    if (error instanceof Error && error.name === 'AbortError') throw new Error('请求超时，请重试。')
    if (error instanceof TypeError) throw new Error('网络连接失败，请检查网络后重试。')
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}

/** 某个后台的接口封装。 */
export function apiFor(area: AdminArea) {
  const base = ADMIN_AREAS[area].base
  return {
    area,
    base,
    login: (username: string, password: string) =>
      request<{ admin: AdminUser }>(base, '/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    logout: () => request<{ ok: boolean }>(base, '/logout', { method: 'POST', body: '{}' }),
    me: () => request<{ admin: AdminUser }>(base, '/me'),
    get: <T>(path: string) => request<T>(base, path),
    post: <T>(path: string, body?: unknown) =>
      request<T>(base, path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
    patch: <T>(path: string, body: unknown) =>
      request<T>(base, path, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: <T>(path: string) => request<T>(base, path, { method: 'DELETE' }),
  }
}

/**
 * 两个后台各自的登录态。
 *
 * 用 reactive 存，是因为登录状态要驱动界面（登录表单 ↔ 业务页面），
 * 不需要跨组件用 provide/inject 传递，直接 import 即可。
 */
const sessions = reactive<Record<AdminArea, { admin: AdminUser | null; status: 'unknown' | 'ready' }>>({
  payment: { admin: null, status: 'unknown' },
  recommend: { admin: null, status: 'unknown' },
})

export const adminSession = readonly(sessions)

/** 登录并记录登录态。 */
export async function adminLogin(area: AdminArea, username: string, password: string) {
  const result = await apiFor(area).login(username, password)
  sessions[area].admin = result.admin
  sessions[area].status = 'ready'
  return result.admin
}

/** 退出登录。 */
export async function adminLogout(area: AdminArea) {
  try {
    await apiFor(area).logout()
  } finally {
    sessions[area].admin = null
  }
}

/** 恢复登录态（刷新页面后用 Cookie 换回管理员信息）。 */
export async function adminRestore(area: AdminArea) {
  try {
    const result = await apiFor(area).me()
    sessions[area].admin = result.admin
  } catch {
    sessions[area].admin = null
  } finally {
    sessions[area].status = 'ready'
  }
  return sessions[area].admin
}
