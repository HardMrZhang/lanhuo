<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import { account, authenticate, logout } from '../account'
import { tr, translateMessage } from '../i18n'

const emit = defineEmits<{ done: [] }>()
const formId = useId()
const mode = ref<'login' | 'register'>('login')
const email = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

watch(mode, () => { error.value = ''; password.value = '' })

async function submit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await authenticate(mode.value, email.value, password.value)
    password.value = ''
    emit('done')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '登录失败，请重试。'
  } finally { busy.value = false }
}

async function signOut() {
  busy.value = true
  error.value = ''
  try { await logout(); emit('done') }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '退出失败，请重试。' }
  finally { busy.value = false }
}
</script>

<template>
  <div class="account-content">
    <template v-if="account.user">
      <p class="account-email">{{ account.user.email }}</p>
      <p class="account-caption">{{ account.user.vipActive ? tr('VIP 会员已开通', 'VIP membership is active') : tr('欢迎来到你的短剧剧场', 'Welcome to your drama theater') }}</p>
      <div class="account-links">
        <router-link to="/vip">{{ tr('VIP 会员中心', 'VIP Membership') }} <span>›</span></router-link>
        <router-link :to="{ name: 'home', query: { view: 'favorites' } }">{{ tr('我的追剧', 'My List') }} <span>›</span></router-link>
        <router-link :to="{ name: 'home', query: { view: 'history' } }">{{ tr('观看记录', 'Watch History') }} <span>›</span></router-link>
      </div>
      <button class="account-submit button-secondary" type="button" :disabled="busy" @click="signOut">{{ busy ? tr('正在退出…', 'Signing out…') : tr('退出登录', 'Sign out') }}</button>
    </template>
    <template v-else>
      <div class="account-tabs" :aria-label="tr('账号选项', 'Account options')">
        <button type="button" :class="{ active: mode === 'login' }" :aria-pressed="mode === 'login'" :disabled="busy" @click="mode = 'login'">{{ tr('登录', 'Sign in') }}</button>
        <button type="button" :class="{ active: mode === 'register' }" :aria-pressed="mode === 'register'" :disabled="busy" @click="mode = 'register'">{{ tr('注册账号', 'Create account') }}</button>
      </div>
      <form class="account-form" @submit.prevent="submit">
        <div>
          <label :for="`${formId}-email`">{{ tr('邮箱', 'Email') }}</label>
          <input :id="`${formId}-email`" v-model="email" type="email" name="email" autocomplete="email" :placeholder="tr('输入你的邮箱', 'Enter your email')" maxlength="254" required :disabled="busy" />
        </div>
        <div>
          <label :for="`${formId}-password`">{{ tr('密码', 'Password') }}</label>
          <input :id="`${formId}-password`" v-model="password" type="password" name="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" :placeholder="mode === 'register' ? tr('至少 8 位密码', 'At least 8 characters') : tr('输入你的密码', 'Enter your password')" :minlength="mode === 'register' ? 8 : undefined" maxlength="128" required :disabled="busy" />
        </div>
        <p class="account-caption">{{ mode === 'register' ? tr('注册后，会员时长与充值订单将关联此账号。', 'Your membership and payment orders will be linked to this account.') : tr('登录后可开通会员、查看充值订单与会员有效期。', 'Sign in to join VIP and view your orders and membership expiry.') }}</p>
        <button class="account-submit button-primary" type="submit" :disabled="busy">{{ busy ? tr('请稍候…', 'Please wait…') : mode === 'login' ? tr('登录', 'Sign in') : tr('创建账号', 'Create account') }}</button>
      </form>
    </template>
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
.account-email { overflow-wrap: anywhere; font-weight: 700; margin-bottom: 6px; }
.account-links { display: grid; gap: 8px; margin: 20px 0; }
.account-links a { display: flex; justify-content: space-between; padding: 10px 12px; border-radius: 10px; background: var(--card); border: 1px solid var(--border); font-size: 14px; }
.account-links a:hover { border-color: var(--accent); }
</style>
