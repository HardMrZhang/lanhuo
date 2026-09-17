<script setup lang="ts">
import type { DramaSummary } from '../types'

defineProps<{ drama: DramaSummary }>()

function formatViews(n?: number) {
  if (!n) return '0'
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`
  return String(n)
}
</script>

<template>
  <router-link class="card" :to="{ name: 'play', params: { id: drama.id, ep: 1 } }">
    <div class="thumb">
      <img :src="drama.cover" :alt="drama.title" loading="lazy" decoding="async" />
      <span v-if="drama.hd" class="hd">HD</span>
      <span class="dur">{{ drama.status === 'completed' ? '全' : '更至' }}{{ drama.episodeCount }}集</span>
    </div>
    <div class="title" :title="drama.title">{{ drama.title }}</div>
    <div class="meta">
      <span class="views">{{ formatViews(drama.views) }} 次播放</span>
      <span v-if="drama.rating != null" class="rating">
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path
            fill="currentColor"
            d="M3 7h2.5v7H3zM6.5 14V7.2L9.3 1.5c.9 0 1.6.8 1.4 1.7L10.2 6H14a1.5 1.5 0 0 1 1.4 2l-1.7 5A1.5 1.5 0 0 1 12.3 14z"
          />
        </svg>
        {{ drama.rating }}%
      </span>
    </div>
  </router-link>
</template>

<style scoped>
.card {
  display: block;
  color: var(--fg);
}
.thumb {
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-2);
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s ease;
}
.card:hover .thumb img {
  transform: scale(1.04);
}
.hd,
.dur {
  position: absolute;
  bottom: 6px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 2px;
  color: #fff;
}
.hd {
  left: 6px;
  background: var(--accent);
  color: var(--accent-fg);
}
.dur {
  right: 6px;
  background: rgba(0, 0, 0, 0.8);
}
.title {
  margin-top: 8px;
  font-size: 14px;
  font-weight: 400;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card:hover .title {
  color: var(--accent);
}
.meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 4px;
  font-size: 12px;
  color: var(--fg-2);
}
.rating {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
</style>
