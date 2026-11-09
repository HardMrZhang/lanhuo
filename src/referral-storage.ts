/**
 * 邀请码的本地存取。
 *
 * 场景：用户点别人的邀请链接进来 → 邀请码存在本地 → 注册/登录成功后
 * 调服务端接口绑定关系。绑定成功后清掉，避免下次误绑。
 */

const CODE_KEY = 'duanju:ref_code'

function readCode(): string {
  try {
    const raw = localStorage.getItem(CODE_KEY)
    return raw && /^[A-Z0-9]{6,16}$/.test(raw) ? raw : ''
  } catch {
    return ''
  }
}

export const referralStorage = {
  /** 保存邀请码。 */
  save(code: string) {
    const normalized = String(code || '').trim().toUpperCase()
    if (!/^[A-Z0-9]{6,16}$/.test(normalized)) return false
    try {
      localStorage.setItem(CODE_KEY, normalized)
      return true
    } catch {
      return false
    }
  },
  /** 读取当前保存的邀请码。 */
  get(): string {
    return readCode()
  },
  /** 清除（绑定成功后调用）。 */
  clear() {
    try {
      localStorage.removeItem(CODE_KEY)
    } catch {
      /* Storage is optional. */
    }
  },
  /** 从 URL 的 ?ref= 参数里取出邀请码并保存。 */
  captureFromLocation(): string {
    if (typeof window === 'undefined') return ''
    const code = new URLSearchParams(window.location.search).get('ref') || ''
    if (!code) return ''
    const normalized = code.trim().toUpperCase()
    if (!/^[A-Z0-9]{6,16}$/.test(normalized)) return ''
    referralStorage.save(normalized)
    return normalized
  },
}
