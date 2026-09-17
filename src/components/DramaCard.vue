<script setup lang="ts">
import type { DramaSummary } from '../types'

defineProps<{ drama: DramaSummary }>()

function formatViews(n?: number) {
  if (!n) return ''
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`
  return String(n)
}
</script>

<template>
  <router-link class="card" :to="{ name: 'play', params: { id: drama.id, ep: 1 } }">
    <div class="cover">
      <img :src="drama.cover" :alt="drama.title" loading="lazy" decoding="async" />
      <span class="badge">{{ drama.status === 'completed' ? '全' : '更至' }}{{ drama.episodeCount }}集</span>
      <span v-if="drama.views" class="views">▶ {{ formatViews(drama.views) }}</span>
    </div>
    <div class="title">{{ drama.title }}</div>
    <div v-if="drama.tags?.length" class="tags">{{ drama.tags.slice(0, 2).join(' · ') }}</div>
  </router-link>
</template>

<style scoped>
.card {
  display: block;
}
.cover {
  position: relative;
  aspect-ratio: 3 / 4;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-2);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.badge,
.views {
  position: absolute;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  backdrop-filter: blur(4px);
}
.badge {
  top: 6px;
  right: 6px;
}
.views {
  bottom: 6px;
  left: 6px;
}
.title {
  margin-top: 6px;
  font-size: 14px;
  font-weight: 500;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tags {
  margin-top: 2px;
  font-size: 12px;
  color: var(--fg-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
