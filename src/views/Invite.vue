<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { account, refreshAccount } from '../account'
import { referralApi, type ReferralOverview } from '../referral-api'
import { referralStorage } from '../referral-storage'
import { tr, translateMessage } from '../i18n'
import SiteHeader from '../components/SiteHeader.vue'
import SiteFooter from '../components/SiteFooter.vue'
import AccountPanel from '../components/AccountPanel.vue'

const overview = ref<ReferralOverview | null>(null)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const copied = ref<'code' | 'link' | ''>('')
const inputCode = ref('')
const binding = ref(false)
const bindError = ref('')

/** 完整邀请链接（当前域名 + ?ref=邀请码）。 */
const inviteLink = computed(() => {
  if (!overview.value) return ''
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return `${origin}${overview.value.linkPath}`
})

async function load() {
  if (!account.user) return
  loading.value = true
  error.value = ''
  try {
    overview.value = await referralApi.overview()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : tr('加载失败，请稍后重试。', 'Unable to load. Please try again later.')
  } finally {
    loading.value = false
  }
}

/**
 * 复制邀请码或邀请链接。
 *
 * 剪贴板不可用（http 页面、非安全上下文）时给出手动复制提示，
 * 而不是静默失败 —— 用户看不到是否复制成功就会重复点。
 */
async function copy(kind: 'code' | 'link', value: string) {
  if (!value) return
  error.value = ''
  try {
    await navigator.clipboard.writeText(value)
    copied.value = kind
    window.setTimeout(() => { copied.value = '' }, 2000)
  } catch {
    error.value = tr('复制失败，请选中下方内容后手动复制。', 'Could not copy. Select the text below and copy it manually.')
  }
}

/** 手动输入邀请码绑定邀请关系。 */
async function bind() {
  const code = inputCode.value.trim().toUpperCase()
  if (!code) return
  binding.value = true
  bindError.value = ''
  notice.value = ''
  try {
    await referralApi.bind(code)
    notice.value = tr('绑定成功，感谢你的邀请。', 'Bound successfully. Thanks for the referral.')
    inputCode.value = ''
    referralStorage.clear()
    await load()
  } catch (cause) {
    bindError.value = cause instanceof Error ? cause.message : tr('绑定失败，请稍后重试。', 'Unable to bind. Please try again later.')
  } finally {
    binding.value = false
  }
}

function formatDate(timestamp: number) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

watch(
  () => account.user?.id,
  (id) => { if (id) void load() },
  // immediate：组件创建时用户可能已经登录（account.user 已有值），
  // 此时 id 不再变化，watch 不会触发，邀请码就永远不会加载。
  { immediate: true },
)

onMounted(async () => {
  // 邀请码的全局捕获与自动绑定在 App.vue 里统一处理，这里只需刷新账号信息。
  await refreshAccount()
})
</script>

<template>
  <div class="invite-page">
    <SiteHeader />
    <main class="invite-main">
      <section class="invite-hero">
        <p class="eyebrow">INVITE FRIENDS</p>
        <h1>{{ tr('邀请好友', 'Invite friends') }}</h1>
        <p class="invite-sub">{{ tr('分享你的邀请码，好友注册后自动关联邀请关系。', 'Share your code — friends are linked automatically once they sign up.') }}</p>
      </section>

      <template v-if="!account.user">
        <section class="panel signin-panel">
          <h2>{{ tr('登录后查看你的邀请码', 'Sign in to see your code') }}</h2>
          <p class="panel-hint">{{ tr('邀请码与账号绑定，登录后即可获取并分享。', 'Your code is tied to your account. Sign in to get it.') }}</p>
          <AccountPanel />
        </section>
      </template>

      <template v-else>
        <section class="panel code-panel">
          <h2>{{ tr('我的邀请码', 'My invite code') }}</h2>
          <p class="panel-hint">{{ tr('把邀请码或邀请链接发给好友，好友注册后即关联到你名下。', 'Send the code or link to a friend; they are linked to you after signing up.') }}</p>
          <p v-if="loading" class="loading-block" role="status">{{ tr('正在加载…', 'Loading…') }}</p>
          <p v-else-if="error" class="notice notice-error" role="alert">{{ translateMessage(error) }}</p>
          <template v-else-if="overview">
            <div class="code-box">
              <span class="code-value">{{ overview.code }}</span>
              <button class="copy-button" type="button" @click="copy('code', overview.code)">
                {{ copied === 'code' ? tr('已复制', 'Copied') : tr('复制', 'Copy') }}
              </button>
            </div>
            <div class="code-box">
              <span class="code-value link">{{ inviteLink }}</span>
              <button class="copy-button" type="button" @click="copy('link', inviteLink)">
                {{ copied === 'link' ? tr('已复制', 'Copied') : tr('复制', 'Copy') }}
              </button>
            </div>
            <p v-if="notice" class="notice notice-ok" role="status">{{ notice }}</p>
          </template>
        </section>

        <section v-if="overview" class="panel stat-panel">
          <h2>{{ tr('我的邀请', 'My referrals') }}</h2>
          <div class="stat-grid">
            <div class="stat-card">
              <strong>{{ overview.invitedCount }}</strong>
              <span>{{ tr('已邀请好友', 'Friends invited') }}</span>
            </div>
            <div class="stat-card">
              <strong>{{ overview.invitedBy ? 1 : 0 }}</strong>
              <span>{{ tr('邀请人', 'Invited by') }}</span>
            </div>
          </div>
          <p v-if="overview.invitedBy" class="panel-hint invited-by">
            {{ tr('你的邀请码来自', 'Your code came from') }} <strong>{{ overview.invitedBy.email }}</strong>
          </p>
        </section>

        <section v-if="overview?.invited.length" class="panel list-panel">
          <h2>{{ tr('邀请记录', 'Referral history') }}</h2>
          <ul class="invite-list">
            <li v-for="(item, index) in overview.invited" :key="`${item.email}-${index}`">
              <span class="invite-email">{{ item.email }}</span>
              <span class="invite-time">{{ formatDate(item.boundAt) }}</span>
            </li>
          </ul>
        </section>
        <section v-else-if="overview" class="panel list-panel">
          <h2>{{ tr('邀请记录', 'Referral history') }}</h2>
          <p class="panel-hint">{{ tr('还没有邀请记录，把邀请码分享给好友吧。', 'No referrals yet — share your code with a friend.') }}</p>
        </section>

        <section class="panel bind-panel">
          <h2>{{ tr('填写好友的邀请码', 'Enter a friend’s code') }}</h2>
          <p class="panel-hint">{{ tr('如果好友给你发了邀请码，在这里填写即可关联邀请关系。', 'If a friend sent you a code, enter it here to link the referral.') }}</p>
          <form class="bind-form" @submit.prevent="bind">
            <input
              v-model="inputCode"
              type="text"
              :placeholder="tr('输入邀请码', 'Enter invite code')"
              maxlength="16"
              autocomplete="off"
              autocapitalize="characters"
              :disabled="binding"
            />
            <button class="button-primary" type="submit" :disabled="binding || !inputCode.trim()">
              {{ binding ? tr('绑定中…', 'Binding…') : tr('绑定', 'Bind') }}
            </button>
          </form>
          <p v-if="bindError" class="notice notice-error" role="alert">{{ translateMessage(bindError) }}</p>
        </section>

        <section class="panel rules-panel">
          <h2>{{ tr('邀请规则', 'Referral rules') }}</h2>
          <ol class="rules-list">
            <li>{{ tr('每个账号拥有唯一邀请码，可通过邀请码或邀请链接分享。', 'Every account has a unique code you can share as a code or a link.') }}</li>
            <li>{{ tr('好友使用你的邀请码完成注册后，邀请关系自动建立。', 'The referral is linked automatically after a friend signs up with your code.') }}</li>
            <li>{{ tr('一个账号只能绑定一个邀请码，绑定后不可更改。', 'An account can only be linked to one code, and it cannot be changed afterwards.') }}</li>
            <li>{{ tr('系统会检测异常邀请行为，违规记录可能被取消。', 'The system detects abnormal referral activity; records may be cancelled if rules are broken.') }}</li>
          </ol>
        </section>

        <section class="panel terms-panel">
          <h2>{{ tr('活动条款', 'Terms') }}</h2>
          <ul class="terms-list">
            <li>{{ tr('邀请关系仅用于统计来源，不涉及任何奖励发放。', 'Referral records are used for attribution only; no rewards are granted.') }}</li>
            <li>{{ tr('禁止使用虚假信息或批量注册刷取邀请记录。', 'False information and bulk registrations to inflate records are prohibited.') }}</li>
            <li>{{ tr('最终解释权归本站所有。', 'The site reserves the right to make the final interpretation.') }}</li>
          </ul>
        </section>
      </template>
    </main>
    <SiteFooter />
  </div>
</template>

<style scoped>
.invite-page {
  min-height: 100dvh;
  background: var(--bg);
  padding-top: 68px;
  padding-bottom: calc(40px + var(--safe-bottom));
}
.invite-main {
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: 24px var(--gutter) 0;
  display: grid;
  gap: 16px;
}
.invite-hero {
  padding: 12px 4px 4px;
}
.invite-hero .eyebrow {
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 1.4px;
}
.invite-hero h1 {
  margin-top: 8px;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.3px;
}
.invite-sub {
  margin-top: 8px;
  color: var(--fg-2);
  font-size: 14px;
  line-height: 1.7;
}
.panel {
  padding: 20px;
  border-radius: var(--radius-lg);
  background: var(--card);
  border: 1px solid var(--border);
}
.panel h2 {
  font-size: 17px;
  font-weight: 700;
}
.panel-hint {
  margin-top: 8px;
  color: var(--fg-2);
  font-size: 13px;
  line-height: 1.7;
}
.code-box {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--bg-3);
  border: 1px solid var(--border);
}
.code-value {
  flex: 1;
  min-width: 0;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 2px;
  overflow-wrap: anywhere;
}
.code-value.link {
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0;
  color: var(--fg-2);
}
.copy-button {
  flex-shrink: 0;
  padding: 8px 14px;
  border-radius: 18px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}
.copy-button:hover {
  background: var(--accent-hover);
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 14px;
}
.stat-card {
  padding: 16px;
  border-radius: 12px;
  background: var(--bg-3);
  text-align: center;
}
.stat-card strong {
  display: block;
  font-size: 26px;
  font-weight: 700;
}
.stat-card span {
  display: block;
  margin-top: 4px;
  color: var(--fg-2);
  font-size: 13px;
}
.invited-by {
  margin-top: 12px;
}
.invite-list {
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
}
.invite-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 13px;
  border-radius: 10px;
  background: var(--bg-3);
}
.invite-email {
  font-size: 14px;
}
.invite-time {
  flex-shrink: 0;
  color: var(--fg-3);
  font-size: 12px;
}
.bind-form {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}
.bind-form input {
  flex: 1;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-3);
  color: var(--fg);
  letter-spacing: 1px;
}
.bind-form input::placeholder {
  color: var(--fg-3);
  letter-spacing: 0;
}
.rules-list,
.terms-list {
  margin: 14px 0 0;
  padding-left: 20px;
  display: grid;
  gap: 8px;
  color: var(--fg-2);
  font-size: 13px;
  line-height: 1.8;
}
.terms-list {
  list-style: disc;
}
.notice {
  margin-top: 12px;
  padding: 11px 13px;
  border-radius: 10px;
  font-size: 13px;
}
.notice-error {
  color: var(--accent-fg-soft);
  background: var(--accent-soft);
}
.notice-ok {
  color: var(--success);
  background: rgba(60, 200, 120, 0.12);
}
.loading-block {
  margin-top: 14px;
  color: var(--fg-2);
  font-size: 14px;
}
.button-primary {
  padding: 12px 20px;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
.button-primary:disabled {
  opacity: 0.45;
}
@media (max-width: 768px) {
  .invite-page {
    padding-top: 56px;
  }
  .invite-main {
    padding-inline: 16px;
  }
  .invite-hero h1 {
    font-size: 24px;
  }
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
