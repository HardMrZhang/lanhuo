<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { account, refreshAccount } from './account'
import { referralApi } from './referral-api'
import { referralStorage } from './referral-storage'

const route = useRoute()
/** 后台页面有自己的布局（侧边栏），不套用户端的缓存策略。 */
const isAdmin = computed(() => route.path.startsWith('/admin'))

/**
 * 全局捕获邀请码并绑定邀请关系。
 *
 * 邀请链接是 `/?ref=CODE`，用户可能从首页、详情页、播放页任何一个入口进来，
 * 所以捕获必须放在根组件而不是某个页面里，否则从别的入口进来就丢了码。
 *
 * 绑定时机：用户已登录时立即绑定；未登录时先把码存到本地，
 * 等注册/登录成功后再由下面的 watch 补绑。
 */
let binding = false

/** 尝试把本地存的邀请码绑定到当前账号。 */
async function tryBind() {
  if (binding || !account.user) return
  const code = referralStorage.get()
  if (!code) return
  binding = true
  try {
    const result = await referralApi.bindLink(code)
    // 绑定成功就清掉本地码，避免下次再尝试（已经绑过的账号会返回 409）。
    if (result.bound) referralStorage.clear()
  } catch {
    // 绑定失败不打扰用户：可以稍后在邀请页手动输入邀请码。
  } finally {
    binding = false
  }
}

onMounted(async () => {
  // 先把 URL 上的 ?ref= 存下来，再刷新登录态。
  referralStorage.captureFromLocation()
  await refreshAccount()
  await tryBind()
})

// 用户在当前会话里注册/登录成功后，补绑之前存下的邀请码。
watch(
  () => account.user?.id,
  () => { void tryBind() },
)

// 路由带 ?ref= 变化时（分享链接可能指向任意页面）重新捕获。
watch(
  () => route.query.ref,
  (value) => {
    if (typeof value === 'string' && value) {
      referralStorage.captureFromLocation()
      void tryBind()
    }
  },
)
</script>

<template>
  <router-view v-slot="{ Component, route: current }">
    <keep-alive include="Home" :exclude="isAdmin ? 'Home' : undefined">
      <component
        :is="Component"
        :key="
          current.name === 'home'
            ? 'home'
            : current.name === 'play'
              ? `play:${current.params.id}`
              : current.fullPath
        "
      />
    </keep-alive>
  </router-view>
</template>
