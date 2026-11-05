<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { authApi } from '../vip-api'
import { tr } from '../i18n'

const route = useRoute()
const token = computed(() => (typeof route.query.token === 'string' ? route.query.token : ''))
const password = ref('')
const confirm = ref('')
const error = ref('')
const busy = ref(false)
const done = ref(false)

async function submit() {
  if (busy.value) return
  error.value = ''
  if (password.value.length < 8 || password.value.length > 128) {
    error.value = tr('请输入 8–128 位密码', 'Enter a password with 8–128 characters')
    return
  }
  if (password.value !== confirm.value) {
    error.value = tr('两次输入的密码不一致', 'The passwords do not match')
    return
  }
  busy.value = true
  try {
    await authApi.resetPassword(token.value, password.value)
    done.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : tr('重置失败，请重试。', 'Unable to reset your password. Please try again.')
  } finally { busy.value = false }
}
</script>

<template>
  <div class="auth-page">
    <h1>{{ tr('设置新密码', 'Choose a new password') }}</h1>
    <template v-if="done">
      <p class="auth-text auth-ok">{{ tr('密码已重置，请用新密码登录。', 'Your password has been reset. Sign in with your new password.') }}</p>
      <router-link class="auth-link" to="/">{{ tr('返回首页登录', 'Back to sign in') }}</router-link>
    </template>
    <template v-else-if="token">
      <form class="auth-form" @submit.prevent="submit">
        <div>
          <label for="reset-password">{{ tr('新密码', 'New password') }}</label>
          <input id="reset-password" v-model="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required :placeholder="tr('至少 8 位密码', 'At least 8 characters')" />
        </div>
        <div>
          <label for="reset-confirm">{{ tr('确认新密码', 'Confirm new password') }}</label>
          <input id="reset-confirm" v-model="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="128" required :placeholder="tr('再次输入新密码', 'Enter it again')" />
        </div>
        <p v-if="error" class="auth-text auth-error" role="alert">{{ error }}</p>
        <button class="auth-submit" type="submit" :disabled="busy">{{ busy ? tr('请稍候…', 'Please wait…') : tr('确认重置', 'Reset password') }}</button>
      </form>
    </template>
    <template v-else>
      <p class="auth-text auth-error">{{ tr('链接无效，请重新申请密码重置。', 'This link is invalid. Please request a new reset link.') }}</p>
      <router-link class="auth-link" to="/">{{ tr('返回首页', 'Back to home') }}</router-link>
    </template>
  </div>
</template>

<style scoped>
.auth-page { min-height: 100dvh; display: grid; place-content: center; justify-items: center; gap: 16px; padding: 24px; }
.auth-page h1 { font-size: 22px; font-weight: 700; }
.auth-form { width: min(360px, 100%); display: grid; gap: 16px; }
.auth-form label { display: block; font-size: 13px; margin-bottom: 6px; color: #c4cad9; }
.auth-form input { width: 100%; padding: 12px 14px; border: 1px solid rgba(255,255,255,.13); border-radius: 10px; background: #080b12; color: var(--fg); }
.auth-text { color: var(--fg-2); font-size: 14px; line-height: 1.8; max-width: 420px; text-align: center; }
.auth-ok { color: #8fe0b0; }
.auth-error { color: var(--accent-fg-soft); }
.auth-submit { padding: 12px; border-radius: 10px; background: var(--gradient); color: #fff; font-weight: 700; }
.auth-link { color: var(--accent); font-size: 14px; font-weight: 600; }
</style>
