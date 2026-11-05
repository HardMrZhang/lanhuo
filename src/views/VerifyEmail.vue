<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { authApi } from '../vip-api'
import { tr } from '../i18n'

const route = useRoute()
const status = ref<'idle' | 'pending' | 'done' | 'error'>('idle')
const message = ref('')

onMounted(async () => {
  const token = typeof route.query.token === 'string' ? route.query.token : ''
  if (!token) {
    status.value = 'error'
    message.value = tr('链接无效，请重新发送验证邮件。', 'This link is invalid. Please request a new verification email.')
    return
  }
  status.value = 'pending'
  try {
    await authApi.verifyEmail(token)
    status.value = 'done'
    message.value = tr('邮箱验证成功，现在可以登录并开通会员了。', 'Email verified. You can now sign in and activate VIP.')
  } catch {
    status.value = 'error'
    message.value = tr('验证链接无效或已过期，请重新发送。', 'This verification link is invalid or has expired. Please request a new one.')
  }
})
</script>

<template>
  <div class="auth-page">
    <h1>{{ tr('邮箱验证', 'Email verification') }}</h1>
    <p v-if="status === 'pending'" class="auth-text">{{ tr('正在验证…', 'Verifying…') }}</p>
    <p v-else-if="status === 'done'" class="auth-text auth-ok">{{ message }}</p>
    <p v-else class="auth-text auth-error">{{ message }}</p>
    <router-link class="auth-link" to="/">{{ tr('返回首页', 'Back to home') }}</router-link>
  </div>
</template>

<style scoped>
.auth-page { min-height: 100dvh; display: grid; place-content: center; justify-items: center; gap: 14px; padding: 24px; text-align: center; }
.auth-page h1 { font-size: 22px; font-weight: 700; }
.auth-text { color: var(--fg-2); font-size: 14px; line-height: 1.8; max-width: 420px; }
.auth-ok { color: #8fe0b0; }
.auth-error { color: var(--accent-fg-soft); }
.auth-link { color: var(--accent); font-size: 14px; font-weight: 600; }
</style>
