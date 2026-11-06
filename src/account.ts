import { reactive, readonly } from 'vue'
import { accountRequest, authApi, type AccountUser, type AuthCapabilities, type CaptchaAnswer } from './vip-api'

const state = reactive<{
  user: AccountUser | null
  status: 'loading' | 'ready' | 'error'
  error: string
  capabilities: AuthCapabilities | null
}>({
  user: null,
  status: 'loading',
  error: '',
  capabilities: null,
})
export const account = readonly(state)

let refresh: Promise<void> | null = null
let revision = 0

export function updateAccount(user: AccountUser | null) {
  revision++
  state.user = user
  state.status = 'ready'
  state.error = ''
}

export function refreshAccount() {
  if (refresh) return refresh
  const currentRevision = revision
  state.status = 'loading'
  refresh = accountRequest<{ user: AccountUser | null }>('/auth/me')
    .then(({ user }) => {
      if (currentRevision === revision) updateAccount(user)
    })
    .catch((error: unknown) => {
      if (currentRevision === revision) {
        state.status = 'error'
        state.error = error instanceof Error ? error.message : '无法加载账号，请重试。'
      }
    })
    .finally(() => { refresh = null })
  return refresh
}

/** 账号能力开关只影响 UI 展示，失败时静默降级到「仅邮箱登录」。 */
export async function refreshCapabilities() {
  try {
    state.capabilities = await authApi.capabilities()
  } catch {
    state.capabilities = null
  }
}

export async function authenticate(
  mode: 'login' | 'register',
  email: string,
  password: string,
  captcha?: CaptchaAnswer,
) {
  const { user } = await accountRequest<{ user: AccountUser }>(`/auth/${mode}`, {
    method: 'POST',
    body: JSON.stringify({ email: email.trim(), password, ...(captcha ?? {}) }),
  })
  updateAccount(user)
  return user
}

export async function logout() {
  await accountRequest('/auth/logout', { method: 'POST', body: '{}' })
  updateAccount(null)
}
