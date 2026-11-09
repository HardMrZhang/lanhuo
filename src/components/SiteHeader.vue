<script setup lang="ts">
import { computed, onMounted, ref, useId, watch } from 'vue'
import { useRoute, type LocationQueryRaw } from 'vue-router'
import { contentChannels } from '../navigation'
import { account, refreshAccount, refreshCapabilities } from '../account'
import AccountPanel from './AccountPanel.vue'
import LanguageSwitcher from './LanguageSwitcher.vue'
import { locale, tr } from '../i18n'

const route = useRoute()
const menuOpen = ref(false)
const accountDialog = ref<HTMLDialogElement | null>(null)
const accountTitleId = useId()
const channelLabels: Record<string, string> = {
  shorts: 'Shorts',
  western: 'Western Shorts',
  anime: 'Animation',
  live: 'Live Action',
  videos: 'Videos',
  novels: 'Fiction',
}
const links = computed<{ id: string; label: string; query: LocationQueryRaw }[]>(() => [
  { id: 'home', label: tr('首页', 'Home'), query: {} },
  ...contentChannels.filter((channel) => channel.available).map((channel) => ({
    id: channel.id,
    label: locale.value === 'en' ? channelLabels[channel.id] || channel.name : channel.name,
    query: { channel: channel.id },
  })),
  { id: 'ranking', label: tr('热播榜', 'Trending'), query: { view: 'ranking' } },
  { id: 'tags', label: tr('标签榜', 'Tags'), query: { view: 'tags' } },
  { id: 'addresses', label: tr('官方地址', 'Site'), query: { view: 'addresses' } },
])

function isActive(id: string) {
  if (route.name !== 'home') return false
  if (route.query.channel) return id === route.query.channel
  if (route.query.view) return id === route.query.view
  if (route.query.category === 'anime') return id === 'anime'
  return id === 'home' && !Object.keys(route.query).length
}

function openAccount() {
  menuOpen.value = false
  accountDialog.value?.showModal()
}

onMounted(() => {
  void refreshAccount()
  void refreshCapabilities()
})

watch(
  () => route.fullPath,
  () => {
    menuOpen.value = false
    accountDialog.value?.close()
  },
)
</script>

<template>
  <header class="site-header" @keydown.esc="menuOpen = false">
    <div class="header-inner">
      <button
        class="menu-toggle"
        type="button"
        :aria-label="tr('导航', 'Menu')"
        aria-controls="main-navigation"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <span aria-hidden="true">{{ menuOpen ? '×' : '☰' }}</span>
      </button>
      <router-link class="brand" to="/" :aria-label="tr('短剧剧场首页', 'Drama Theater home')">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 5v14l11-7z" /></svg>
        </span>
        <span class="brand-name">{{ tr('短剧', 'Drama') }}<b>{{ tr('剧场', 'Theater') }}</b></span>
      </router-link>
      <nav
        id="main-navigation"
        class="menu"
        :class="{ open: menuOpen }"
        :aria-label="tr('主导航', 'Main navigation')"
      >
        <router-link
          v-for="link in links"
          :key="link.id"
          :to="{ name: 'home', query: link.query }"
          :class="{ active: isActive(link.id) }"
          :aria-current="isActive(link.id) ? 'page' : undefined"
          >{{ link.label }}</router-link
        >
        <router-link
          class="vip-link"
          to="/vip"
          :class="{ active: route.name === 'vip' }"
          :aria-current="route.name === 'vip' ? 'page' : undefined"
          >{{ tr('VIP 会员', 'VIP') }}</router-link
        >
        <router-link
          class="invite-link"
          to="/invite"
          :class="{ active: route.name === 'invite' }"
          :aria-current="route.name === 'invite' ? 'page' : undefined"
          >{{ tr('邀请', 'Invite') }}</router-link
        >
        <button class="mobile-account" type="button" @click="openAccount">
          {{ account.user ? tr('我的账号', 'My Account') : tr('登录 / 注册', 'Sign in') }}
        </button>
      </nav>
      <div class="header-right">
        <router-link
          class="search-button"
          :to="{ name: 'home', query: { search: '1' } }"
          :aria-label="tr('搜索短剧', 'Search dramas')"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 5 5" />
          </svg>
          <span>{{ tr('搜索', 'Search') }}</span>
        </router-link>
        <LanguageSwitcher class="header-language" />
        <button
          class="login-button"
          type="button"
          :title="account.user?.email"
          :aria-label="account.user ? tr('我的账号', 'My account') : tr('登录 / 注册', 'Sign in')"
          @click="openAccount"
        >
          <span v-if="account.user" class="avatar">{{ account.user.email.slice(0, 1).toUpperCase() }}</span>
          <template v-else>{{ tr('登录', 'Sign in') }}</template>
        </button>
      </div>
    </div>
  </header>
  <Teleport to="body">
    <dialog
      ref="accountDialog"
      class="account-dialog"
      :aria-labelledby="accountTitleId"
      @click="$event.target === accountDialog && accountDialog?.close()"
    >
      <div class="account-panel">
        <button
          class="dialog-close"
          :aria-label="tr('关闭', 'Close')"
          type="button"
          @click="accountDialog?.close()"
        >
          ×
        </button>
        <h2 :id="accountTitleId">
          {{ account.user ? tr('我的账号', 'My Account') : tr('欢迎来到短剧剧场', 'Welcome to Drama Theater') }}
        </h2>
        <AccountPanel @done="accountDialog?.close()" />
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.site-header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 999;
  padding-top: var(--safe-top);
  min-height: 68px;
  background: linear-gradient(
    180deg,
    #151314 0%,
    rgba(21, 19, 20, 0.8) 70%,
    rgba(21, 19, 20, 0) 100%
  );
}
.header-inner {
  display: flex;
  align-items: center;
  gap: 32px;
  padding: 20px 64px;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  color: #fff;
}
.brand-mark {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: var(--accent);
}
.brand-mark svg {
  width: 18px;
  height: 18px;
  color: #fff;
}
.brand-name {
  font-size: 21px;
  font-weight: 700;
  letter-spacing: -0.2px;
  white-space: nowrap;
}
.brand-name b {
  font-weight: 700;
  color: var(--accent);
}
.menu {
  display: flex;
  align-items: center;
  gap: 56px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  flex: 1;
}
.menu::-webkit-scrollbar {
  display: none;
}
.menu a {
  flex-shrink: 0;
  font-size: 18px;
  font-weight: 600;
  line-height: 28px;
  white-space: nowrap;
  color: #fff;
  transition: color 0.25s, transform 0.25s;
}
.menu a:hover {
  color: var(--accent);
  transform: scale(1.08);
}
.menu a.active {
  color: var(--accent);
}
.menu a.vip-link {
  color: var(--gold);
}
.menu a.vip-link:hover,
.menu a.vip-link.active {
  color: #ffd98a;
}
.menu a.invite-link {
  color: var(--success);
}
.menu a.invite-link:hover,
.menu a.invite-link.active {
  color: #a8e3c9;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-shrink: 0;
  margin-left: auto;
}
.search-button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 40px;
  padding: 0 16px;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.12);
  font-size: 14px;
  font-weight: 500;
  transition: background 0.2s;
}
.search-button:hover {
  background: rgba(255, 255, 255, 0.18);
}
.search-button svg {
  width: 17px;
  height: 17px;
}
.login-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 76px;
  height: 38px;
  padding: 0 18px;
  border-radius: 19px;
  background: var(--accent);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  transition: background 0.2s;
}
.login-button:hover {
  background: var(--accent-hover);
}
.avatar {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.24);
  font-size: 12px;
  font-weight: 700;
}
.menu-toggle,
.mobile-account {
  display: none;
}
.account-dialog {
  padding: 0;
  width: min(380px, calc(100vw - 32px));
  max-height: calc(100dvh - 40px);
  border: 1px solid var(--border);
  border-radius: 14px;
  background: #1f1f1f;
  color: var(--fg);
  box-shadow: 0 28px 70px -24px rgba(0, 0, 0, 0.8);
}
.account-dialog::backdrop {
  background: rgba(0, 0, 0, 0.72);
}
.account-panel {
  position: relative;
  padding: 28px 24px 24px;
}
.dialog-close {
  position: absolute;
  top: 10px;
  right: 14px;
  color: var(--fg-2);
  font-size: 26px;
  line-height: 1;
}
.account-panel h2 {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 20px;
}
@media (max-width: 1400px) {
  .menu {
    gap: 32px;
  }
  .menu a {
    font-size: 16px;
  }
}
@media (max-width: 1100px) {
  .header-inner {
    gap: 16px;
    padding: 16px 20px;
    position: relative;
  }
  .brand-name {
    font-size: 19px;
  }
  .menu {
    display: none;
    gap: 0;
    position: absolute;
    top: calc(100% + 6px);
    left: 12px;
    right: 12px;
    padding: 12px;
    border-radius: 14px;
    background: #1b1b1b;
    border: 1px solid var(--border);
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
  }
  .menu.open {
    display: grid;
  }
  .menu a {
    padding: 11px 6px;
    border-radius: 8px;
    background: #262626;
    text-align: center;
    font-size: 14px;
  }
  .menu a:hover {
    transform: none;
  }
  .menu-toggle {
    display: grid;
    place-content: center;
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    font-size: 20px;
    line-height: 1;
  }
  .header-right {
    gap: 12px;
  }
}
@media (max-width: 768px) {
  .site-header {
    min-height: 56px;
  }
  .header-inner {
    padding: 12px 16px;
    gap: 10px;
  }
  .brand-mark {
    width: 26px;
    height: 26px;
  }
  .brand-name {
    font-size: 17px;
  }
  .search-button {
    width: 34px;
    height: 34px;
    padding: 0;
    justify-content: center;
    background: none;
    border: 0;
  }
  .search-button span {
    display: none;
  }
  .login-button {
    display: none;
  }
  .menu {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    max-height: calc(100dvh - 80px);
    overflow-y: auto;
  }
  .mobile-account {
    display: block;
    grid-column: 1 / -1;
    padding: 12px;
    border-radius: 8px;
    background: var(--accent);
    font-size: 14px;
    font-weight: 600;
  }
}
</style>
