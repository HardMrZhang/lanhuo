<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DramaSummary } from '../types'
import { tr } from '../i18n'
import { favorites } from '../storage'
import { isHotDrama } from '../navigation'
import CoverImage from './CoverImage.vue'

const props = defineProps<{ drama: DramaSummary; rank?: number }>()
const saved = ref(favorites.has(props.drama.id))
const hot = computed(() => isHotDrama(props.drama))
const hasEpisodes = computed(() => props.drama.episodeCount > 0)
const episodeText = computed(() =>
  !hasEpisodes.value
    ? tr('待更新', 'Coming soon')
    : props.drama.status === 'completed'
      ? tr(`全${props.drama.episodeCount}集`, `${props.drama.episodeCount} eps`)
      : tr(`更新至${props.drama.episodeCount}集`, `Ep ${props.drama.episodeCount}`),
)

function toggleSave() {
  saved.value = favorites.toggle(props.drama.id)
}
</script>

<template>
  <div class="drama-card">
    <div class="card-poster">
      <router-link
        class="poster-link"
        :to="{ name: 'detail', params: { id: drama.id } }"
        :aria-label="tr(`查看${drama.title}`, `View ${drama.title}`)"
      >
        <CoverImage
          :src="drama.cover"
          :alt="drama.title"
          loading="lazy"
          decoding="async"
          width="300"
          height="400"
        />
      </router-link>
      <span v-if="rank" class="rank-number" :class="{ top: rank <= 3 }">{{ rank }}</span>
      <span v-if="hot" class="hot-badge" aria-label="热门">🔥</span>
      <span class="episode-flag">{{ episodeText }}</span>
      <div class="card-actions">
        <router-link
          v-if="hasEpisodes"
          class="play-button"
          :to="{ name: 'play', params: { id: drama.id } }"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 5v14l11-7z" /></svg>
          {{ tr('立即播放', 'Play Now') }}
        </router-link>
        <span v-else class="play-button disabled">{{ tr('待更新', 'Coming soon') }}</span>
        <button
          class="fav-button"
          :class="{ saved }"
          type="button"
          :aria-label="saved ? tr('取消收藏', 'Remove from list') : tr('收藏', 'Save')"
          :aria-pressed="saved"
          @click="toggleSave"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z" />
          </svg>
        </button>
      </div>
    </div>
    <div class="card-content">
      <router-link
        class="card-title"
        :to="{ name: 'detail', params: { id: drama.id } }"
        :title="drama.title"
        >{{ drama.title }}</router-link
      >
      <div class="card-tags">
        <span v-for="tag in drama.tags?.slice(0, 2)" :key="tag">{{ tag }}</span>
        <span v-if="!drama.tags?.length">{{ tr('精选短剧', 'Featured') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.drama-card {
  min-width: 0;
}
.card-poster {
  position: relative;
  display: block;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  border-radius: var(--radius);
  background: #202020;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.04);
}
.poster-link {
  display: block;
  width: 100%;
  height: 100%;
}
.card-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.35s ease;
}
.drama-card:hover .card-poster img {
  transform: scale(1.04);
}
.episode-flag {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.66);
  color: rgba(255, 255, 255, 0.9);
  font-size: 11px;
  line-height: 16px;
  backdrop-filter: blur(4px);
}
.rank-number {
  position: absolute;
  top: 0;
  left: 0;
  padding: 2px 9px 4px;
  border-bottom-right-radius: 6px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 20px;
  font-weight: 700;
  font-style: italic;
  line-height: 1.1;
}
.rank-number.top {
  background: var(--accent);
}
.hot-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 16px;
  line-height: 1;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
  pointer-events: none;
}
/* 悬停时从底部升起播放条 */
.card-actions {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  gap: 6px;
  padding: 10px;
  background: linear-gradient(0deg, rgba(0, 0, 0, 0.82), transparent);
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 0.22s, transform 0.22s;
}
.drama-card:hover .card-actions,
.drama-card:focus-within .card-actions {
  opacity: 1;
  transform: none;
}
.play-button {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 30px;
  border-radius: 5px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.play-button svg {
  width: 13px;
  height: 13px;
}
.play-button:hover {
  background: var(--accent-hover);
}
.play-button.disabled {
  background: #3a3a3a;
  cursor: default;
}
.fav-button {
  display: grid;
  place-content: center;
  width: 34px;
  height: 30px;
  border-radius: 5px;
  background: #3a3a3a;
  color: #fff;
}
.fav-button svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
}
.fav-button:hover {
  background: #4a4a4a;
}
.fav-button.saved {
  color: var(--accent);
}
.fav-button.saved svg {
  fill: currentColor;
}
.card-content {
  padding-top: 8px;
}
.card-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: #fff;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.35;
}
.card-title:hover {
  color: var(--accent);
}
.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0 4px;
  margin-top: 5px;
  overflow: hidden;
  color: rgba(255, 255, 255, 0.4);
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
}
.card-tags span:not(:last-child)::after {
  content: ' ⦁';
}
@media (max-width: 768px) {
  .card-title {
    font-size: 14px;
  }
  .card-actions {
    display: none;
  }
  .episode-flag {
    font-size: 10px;
  }
}
</style>
