<script setup lang="ts">
import { locale, setLocale } from '../i18n'
</script>

<template>
  <button
    class="language-switcher"
    type="button"
    :aria-label="locale === 'en' ? '切换到中文' : 'Switch to English'"
    :title="locale === 'en' ? '切换到中文' : 'Switch to English'"
    :lang="locale === 'en' ? 'zh-CN' : 'en'"
    @click="setLocale(locale === 'en' ? 'zh-CN' : 'en')"
  ><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg><span>{{ locale === 'en' ? '中文' : 'EN' }}</span></button>
</template>

<style scoped>
.language-switcher { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 36px; padding: 6px 9px; border: 1px solid rgba(255,255,255,.16); border-radius: 9px; background: rgba(10,12,20,.5); color: #e4e8f3; font-size: 12px; font-weight: 650; white-space: nowrap; line-height: 1.2; }
.language-switcher:hover { border-color: #d7b56d; color: #f6d798; }
.language-switcher svg { width: 15px; height: 15px; }
@media (max-width: 480px) { .language-switcher { padding: 6px; gap: 4px; } .language-switcher svg { display: none; } }
</style>
