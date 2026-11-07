<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { tr } from '../i18n'

const props = withDefaults(defineProps<{ src?: string; alt?: string; size?: number }>(), {
  alt: '',
  size: 480,
})
const failed = ref(false)
const thumbFailed = ref(false)
const fallback = computed(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640" viewBox="0 0 360 640">
  <defs>
    <linearGradient id="bg" x2="1" y2="1"><stop stop-color="#28334b"/><stop offset="1" stop-color="#10121d"/></linearGradient>
    <radialGradient id="light"><stop stop-color="#f79b71" stop-opacity=".23"/><stop offset="1" stop-color="#f79b71" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="360" height="640" fill="url(#bg)"/>
  <ellipse cx="290" cy="180" rx="250" ry="320" fill="url(#light)"/>
  <rect x="22" y="22" width="316" height="596" rx="3" fill="none" stroke="#e7caa1" stroke-opacity=".3"/>
  <path d="M50 120H310M50 522H310" stroke="#e7caa1" stroke-opacity=".3"/>
  <g fill="none" stroke="#e7caa1" stroke-width="3">
    <rect x="112" y="236" width="136" height="100" rx="10"/>
    <path d="M140 236V336M220 236V336M112 262H140M112 310H140M220 262H248M220 310H248"/>
  </g>
    20|    <path d="M169 265L199 286L169 307Z" fill="#e7caa1"/>
  <text x="180" y="395" text-anchor="middle" fill="#f4e9da" font-size="${tr('29', '24')}" font-family="system-ui, sans-serif" letter-spacing="${tr('5', '1')}">${tr('短剧剧场', 'Drama Theater')}</text>
  <text x="180" y="432" text-anchor="middle" fill="#b0adad" font-size="11" font-family="system-ui, sans-serif" letter-spacing="${tr('4', '2')}">${tr('精彩短剧', 'SHORT DRAMA')}</text>
</svg>`)}`)

/**
 * 列表/轮播用缩略图（480px WebP，约为原图 1/4 体积），详情页用原图。
 * 封面地址形如 /posters/imported/local-<16位hex>.jpg，缩略图同路径换 .webp。
 */
const originalSrc = computed(() => props.src ?? '')
const thumbnailSrc = computed(() =>
  originalSrc.value.replace(
    /\/posters\/imported\/(local-[a-f0-9]{16})\.jpg(\?.*)?$/,
    '/posters/imported/$1.webp$2',
  ),
)
/** 只有小图场景才用缩略图；size 传 720 以上表示要原图。 */
const useThumb = computed(() => props.size < 720 && Boolean(thumbnailSrc.value))
const imageSrc = computed(() => {
  if (failed.value) return fallback.value
  if (useThumb.value) return thumbFailed.value ? originalSrc.value : thumbnailSrc.value
  return originalSrc.value
})

watch(() => props.src, () => {
  failed.value = false
  thumbFailed.value = false
})

function onError() {
  // 缩略图取不到时退回原图，原图再失败才用占位图。
  if (useThumb.value && !thumbFailed.value) {
    thumbFailed.value = true
    return
  }
  if (!failed.value) failed.value = true
}
</script>

<template>
  <img :src="imageSrc" :alt="alt" @error="onError" />
</template>
