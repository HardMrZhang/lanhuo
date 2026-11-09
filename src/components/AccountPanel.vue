<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { account, authenticate, logout } from '../account'
import { authApi, AccountApiError } from '../vip-api'
import { locale, tr, translateMessage } from '../i18n'
import CaptchaField from './CaptchaField.vue'

const emit = defineEmits<{ done: [] }>()
const formId = useId()
type Mode = 'login' | 'register' | 'forgot'
const mode = ref<Mode>('login')
const email = ref('')
const password = ref('')
const error = ref('')
const notice = ref('')
const busy = ref(false)
const captchaKey = ref(0)
const captcha = ref<InstanceType<typeof CaptchaField> | null>(null)
const captchaRequested = ref(false)

const captchaEnabled = computed(() => account.capabilities?.captcha !== false)
const passwordResetEnabled = computed(() => account.capabilities?.passwordReset === true)
const emailVerificationEnabled = computed(() => account.capabilities?.emailVerification === true)
const needsVerification = computed(() => Boolean(account.user && account.user.emailVerified === false))
// 登录只在连续失败后才要求验证码；注册与找回密码始终需要。
const showCaptcha = computed(() => captchaEnabled.value && (mode.value !== 'login' || captchaRequested.value))

watch(mode, () => {
  error.value = ''
  notice.value = ''
  password.value = ''
  captchaKey.value++
})

async function submit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    if (mode.value === 'forgot') {
      const captchaValue = captcha.value?.value()
      if (showCaptcha.value && !captchaValue) {
        error.value = captcha.value?.error || tr('请输入图形验证码', 'Enter the captcha code')
        return
      }
      await authApi.forgotPassword(email.value, locale.value, captchaValue)
      notice.value = tr(
        '如果该邮箱已注册，重置链接已发送。请查收邮件（含垃圾箱）。',
        'If that email is registered, a reset link is on its way. Check your inbox and spam folder.',
      )
      captcha.value?.refresh()
      return
    }
    const captchaValue = captcha.value?.value()
    // 登录模式下验证码默认不渲染，只有服务端要求时才出现；此时不能因缺少验证码而拦截，
    // 否则会形成「提示要验证码但页面没有验证码」的死循环。
    if (showCaptcha.value && !captchaValue) {
      error.value = captcha.value?.error || tr('请输入图形验证码', 'Enter the captcha code')
      return
    }
    const user = await authenticate(mode.value, email.value, password.value, captchaValue)
    captchaRequested.value = false
    if (user.emailVerified === false) {
      notice.value = tr(
        '注册成功，请查收邮件完成邮箱验证后再开通会员。',
        'Account created. Verify your email before activating VIP.',
      )
    }
    captcha.value?.refresh()
    if (mode.value === 'register') email.value = ''
    emit('done')
  } catch (cause) {
    // 服务端在连续失败后会要求验证码，此时动态显示验证码输入框。
    if (cause instanceof AccountApiError && cause.payload?.captchaRequired === true) {
      captchaRequested.value = true
      captchaKey.value++
    }
    error.value = cause instanceof Error ? cause.message : tr('登录失败，请重试。', 'Unable to sign in. Please try again.')
    captcha.value?.refresh()
  } finally { busy.value = false }
}

async function signOut() {
  busy.value = true
  error.value = ''
  try { await logout(); emit('done') }
  catch (cause) { error.value = cause instanceof Error ? cause.message : tr('退出失败，请重试。', 'Unable to sign out. Please try again.') }
  finally { busy.value = false }
}

async function resendVerification() {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await authApi.resendVerification(locale.value)
    notice.value = result.alreadyVerified
      ? tr('邮箱已验证。', 'Your email is already verified.')
      : tr('验证邮件已发送，请查收。', 'Verification email sent. Please check your inbox.')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : tr('发送失败，请稍后重试。', 'Unable to send. Please try again later.')
  } finally { busy.value = false }
}
</script>

<template>
  <div class="account-content">
    <template v-if="account.user">
      <p class="account-email">{{ account.user.email }}</p>
      <p class="account-caption">{{ account.user.vipActive ? tr('VIP 会员已开通', 'VIP membership is active') : tr('欢迎来到你的短剧剧场', 'Welcome to your drama theater') }}</p>
      <div v-if="needsVerification" class="verify-box" role="status">
        <p class="verify-text">{{ tr('邮箱尚未验证，无法开通会员。', 'Your email is not verified yet, so VIP is unavailable.') }}</p>
        <button class="account-submit button-secondary" type="button" :disabled="busy" @click="resendVerification">
          {{ tr('重新发送验证邮件', 'Resend verification email') }}
        </button>
      </div>
      <div class="account-links">
        <router-link to="/vip">{{ tr('VIP 会员中心', 'VIP Membership') }} <span>›</span></router-link>
        <router-link to="/invite">{{ tr('邀请好友', 'Invite friends') }} <span>›</span></router-link>
        <router-link :to="{ name: 'home', query: { view: 'favorites' } }">{{ tr('我的追剧', 'My List') }} <span>›</span></router-link>
        <router-link :to="{ name: 'home', query: { view: 'history' } }">{{ tr('观看记录', 'Watch History') }} <span>›</span></router-link>
      </div>
      <button class="account-submit button-secondary" type="button" :disabled="busy" @click="signOut">{{ busy ? tr('正在退出…', 'Signing out…') : tr('退出登录', 'Sign out') }}</button>
    </template>
    <template v-else>
      <div class="account-tabs" :aria-label="tr('账号选项', 'Account options')">
        <button type="button" :class="{ active: mode === 'login' }" :aria-pressed="mode === 'login'" :disabled="busy" @click="mode = 'login'">{{ tr('登录', 'Sign in') }}</button>
        <button type="button" :class="{ active: mode === 'register' }" :aria-pressed="mode === 'register'" :disabled="busy" @click="mode = 'register'">{{ tr('注册账号', 'Create account') }}</button>
        <button v-if="passwordResetEnabled" type="button" :class="{ active: mode === 'forgot' }" :aria-pressed="mode === 'forgot'" :disabled="busy" @click="mode = 'forgot'">{{ tr('找回密码', 'Reset') }}</button>
      </div>
      <form class="account-form" @submit.prevent="submit">
        <div>
          <label :for="`${formId}-email`">{{ tr('邮箱', 'Email') }}</label>
          <input :id="`${formId}-email`" v-model="email" type="email" name="email" autocomplete="email" :placeholder="tr('输入你的邮箱', 'Enter your email')" maxlength="254" required :disabled="busy" />
        </div>
        <div v-if="mode !== 'forgot'">
          <label :for="`${formId}-password`">{{ tr('密码', 'Password') }}</label>
          <input :id="`${formId}-password`" v-model="password" type="password" name="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" :placeholder="mode === 'register' ? tr('至少 8 位密码', 'At least 8 characters') : tr('输入你的密码', 'Enter your password')" :minlength="mode === 'register' ? 8 : undefined" maxlength="128" required :disabled="busy" />
        </div>
        <CaptchaField v-if="showCaptcha" ref="captcha" :reset-key="captchaKey" />
        <p class="account-caption">
          <template v-if="mode === 'register'">
            {{ tr('注册后，会员时长与充值订单将关联此账号。', 'Your membership and payment orders will be linked to this account.') }}
            <template v-if="emailVerificationEnabled"> {{ tr('注册后需通过邮件验证邮箱才能开通会员。', 'You must verify your email before activating VIP.') }}</template>
          </template>
          <template v-else-if="mode === 'forgot'">{{ tr('输入注册邮箱，我们会发送重置密码的链接。', 'Enter your email and we will send a password reset link.') }}</template>
          <template v-else>{{ tr('登录后可开通会员、查看充值订单与会员有效期。', 'Sign in to join VIP and view your orders and membership expiry.') }}</template>
        </p>
        <button class="account-submit button-primary" type="submit" :disabled="busy">
          <template v-if="busy">{{ tr('请稍候…', 'Please wait…') }}</template>
          <template v-else-if="mode === 'login'">{{ tr('登录', 'Sign in') }}</template>
          <template v-else-if="mode === 'register'">{{ tr('创建账号', 'Create account') }}</template>
          <template v-else>{{ tr('发送重置链接', 'Send reset link') }}</template>
        </button>
      </form>
    </template>
    <p v-if="notice" class="account-notice" role="status">{{ notice }}</p>
    <p v-if="error" class="account-error" role="alert">{{ translateMessage(error) }}</p>
  </div>
</template>

<style scoped>
.account-tabs { display: flex; gap: 6px; padding: 4px; border-radius: 12px; background: rgba(255,255,255,.04); }
.account-tabs button { flex: 1; border-radius: 9px; padding: 9px; color: var(--fg-2); font-size: 14px; font-weight: 700; }
.account-tabs button.active { background: var(--gradient); color: #fff; }
.account-form { display: grid; gap: 16px; margin-top: 20px; }
.account-form label { display: block; font-size: 13px; margin-bottom: 6px; color: #c4cad9; }
.account-form input { width: 100%; min-width: 0; padding: 12px 14px; border: 1px solid rgba(255,255,255,.13); border-radius: 10px; background: #080b12; color: var(--fg); }
.account-form input::placeholder { color: var(--fg-3); }
.account-caption { color: var(--fg-2); font-size: 13px; line-height: 1.8; }
.account-submit { width: 100%; border-radius: 10px; }
.account-error { padding: 11px 13px; margin-top: 14px; color: var(--accent-fg-soft); background: var(--accent-soft); border-radius: 10px; font-size: 13px; }
.account-notice { padding: 11px 13px; margin-top: 14px; color: #cfe9d6; background: rgba(60, 200, 120, .12); border-radius: 10px; font-size: 13px; line-height: 1.7; }
.account-email { overflow-wrap: anywhere; font-weight: 700; margin-bottom: 6px; }
.account-links { display: grid; gap: 8px; margin: 20px 0; }
.account-links a { display: flex; justify-content: space-between; padding: 10px 12px; border-radius: 10px; background: var(--card); border: 1px solid var(--border); font-size: 14px; }
.account-links a:hover { border-color: var(--accent); }
.verify-box { display: grid; gap: 10px; margin: 16px 0; padding: 12px; border-radius: 10px; background: rgba(255, 176, 32, .1); border: 1px solid rgba(255, 176, 32, .28); }
.verify-text { font-size: 13px; line-height: 1.7; color: #f0d9a8; }
</style>
