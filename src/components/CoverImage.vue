<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { tr } from '../i18n'

const props = withDefaults(defineProps<{ src?: string; alt?: string }>(), { alt: '' })
const failed = ref(false)
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
  <path d="M169 265L199 286L169 307Z" fill="#e7caa1"/>
  <text x="180" y="395" text-anchor="middle" fill="#f4e9da" font-size="${tr('29', '24')}" font-family="system-ui, sans-serif" letter-spacing="${tr('5', '1')}">${tr('短剧剧场', 'Drama Theater')}</text>
  <text x="180" y="432" text-anchor="middle" fill="#b0adad" font-size="11" font-family="system-ui, sans-serif" letter-spacing="${tr('4', '2')}">${tr('精彩短剧', 'SHORT DRAMA')}</text>
</svg>`)}`)
const imageSrc = computed(() => (!failed.value && props.src ? props.src : fallback.value))

watch(() => props.src, () => { failed.value = false })

function onError() {
  if (!failed.value) failed.value = true
}
</script>

<template>
  <img :src="imageSrc" :alt="alt" @error="onError" />
</template>
