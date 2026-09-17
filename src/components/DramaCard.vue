<script setup lang="ts">
import type { DramaSummary } from '../types'

defineProps<{ drama: DramaSummary }>()

function formatViews(n?: number) {
  if (!n) return '0'
  if (n >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/, '')}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, '')}万`
  return String(n)
}
</script>

<template>
  <router-link class="card" :to="{ name: 'detail', params: { id: drama.id } }">
    <div class="thumb">
      <img :src="drama.cover" :alt="drama.title" loading="lazy" decoding="async" />
      <span v-if="drama.hd" class="hd">HD</span>
      <span class="dur">{{ drama.status === 'completed' ? '全' : '更至' }}{{ drama.episodeCount }}集</span>
    </div>
    <div class="title" :title="drama.title">{{ drama.title }}</div>
    <div class="meta">
      <span>{{ formatViews(drama.views) }}次播放</span>
      <template v-if="drama.rating != null">
        <span class="dot">·</span>
        <span class="rating">
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
            <path
              fill="currentColor"
              d="M3 7h2.5v7H3zM6.5 14V7.2L9.3 1.5c.9 0 1.6.8 1.4 1.7L10.2 6H14a1.5 1.5 0 0 1 1.4 2l-1.7 5A1.5 1.5 0 0 1 12.3 14z"
            />
          </svg>
          {{ drama.rating }}%
        </span>
      </template>
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
}
.hd {
  left: 6px;
  background: var(--accent);
  color: var(--accent-fg);
}
.dur {
  right: 6px;
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
}
.title {
  margin-top: 8px;
  font-size: 15px;
  line-height: 1.35;
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
  align-items: center;
  gap: 5px;
  margin-top: 4px;
  font-size: 13px;
  color: var(--fg-2);
  white-space: nowrap;
}
@media (min-width: 960px) {
  .title {
    font-size: 16px;
  }
  .meta {
    font-size: 14px;
  }
  .hd,
  .dur {
    font-size: 12px;
    padding: 4px 6px;
  }
}
@media (min-width: 1600px) {
  .title {
    margin-top: 10px;
    font-size: 17px;
  }
  .meta {
    font-size: 15px;
  }
  .hd,
  .dur {
    font-size: 13px;
  }
}
.dot {
  color: var(--fg-3);
}
.rating {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
</style>
