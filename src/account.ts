import { reactive, readonly } from 'vue'
import { accountRequest, type AccountUser } from './vip-api'

const state = reactive<{ user: AccountUser | null; status: 'loading' | 'ready' | 'error'; error: string }>({
  user: null,
  status: 'loading',
  error: '',
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

export async function authenticate(mode: 'login' | 'register', email: string, password: string) {
  const { user } = await accountRequest<{ user: AccountUser }>(`/auth/${mode}`, {
    method: 'POST',
    body: JSON.stringify({ email: email.trim(), password }),
  })
  updateAccount(user)
}

export async function logout() {
  await accountRequest('/auth/logout', { method: 'POST', body: '{}' })
  updateAccount(null)
}
