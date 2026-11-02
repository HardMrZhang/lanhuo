<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import type { DramaSummary } from '../types'
import { tr } from '../i18n'
import CoverImage from './CoverImage.vue'

const props = defineProps<{ dramas: DramaSummary[] }>()
const index = ref(0)
const hovered = ref(false)
const focused = ref(false)
const touching = ref(false)
let timer: ReturnType<typeof setInterval> | undefined
let startX = 0

const total = computed(() => props.dramas.length)

function select(next: number) {
  if (!total.value) return
  index.value = (next + total.value) % total.value
}

/** 计算每张海报相对中心的位移：中间 0，两侧 ±1、±2 */
function offsetOf(i: number) {
  let diff = i - index.value
  if (diff > total.value / 2) diff -= total.value
  if (diff < -total.value / 2) diff += total.value
  return diff
}

function styleFor(i: number): CSSProperties {
  const diff = offsetOf(i)
  const abs = Math.abs(diff)
  const clamped = Math.max(-2, Math.min(2, diff))
  const scale = abs === 0 ? 1 : abs === 1 ? 0.94 : 0.88
  const rotate = clamped * -26
  return {
    transform: `translate(-50%, -50%) translateX(calc(var(--cover-step, 232px) * ${clamped})) translateZ(${-abs * 70}px) rotateY(${rotate}deg) scale(${scale})`,
    zIndex: 30 - abs * 10,
    opacity: abs > 2 ? 0 : abs === 2 ? 0.5 : 1,
    pointerEvents: abs > 2 ? 'none' : 'auto',
  }
}

const active = computed(() => props.dramas[index.value])

function start() {
  stop()
  timer = setInterval(() => {
    if (
      !hovered.value &&
      !focused.value &&
      !touching.value &&
      !document.hidden &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
      total.value > 1
    )
      select(index.value + 1)
  }, 5000)
}
function stop() {
  clearInterval(timer)
}
function touchStart(event: TouchEvent) {
  startX = event.touches[0]?.clientX ?? 0
  touching.value = true
}
function touchEnd(event: TouchEvent) {
  const delta = (event.changedTouches[0]?.clientX ?? startX) - startX
  if (Math.abs(delta) > 45) select(index.value + (delta > 0 ? -1 : 1))
  touching.value = false
}
function focusOut(event: FocusEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) focused.value = false
}

watch(
  () => props.dramas.length,
  (length) => {
    if (index.value >= length) index.value = 0
  },
)

onMounted(start)
onActivated(start)
onDeactivated(stop)
onBeforeUnmount(stop)
</script>

<template>
  <div
    class="hero-carousel"
    role="region"
    :aria-roledescription="tr('轮播图', 'carousel')"
    :aria-label="tr('官方推荐', 'Featured picks')"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
    @focusin="focused = true"
    @focusout="focusOut"
    @touchstart="touchStart"
    @touchend="touchEnd"
    @touchcancel="touching = false"
    @keydown.left.prevent="select(index - 1)"
    @keydown.right.prevent="select(index + 1)"
  >
    <div class="stage">
      <div
        v-for="(drama, i) in dramas"
        :key="drama.id"
        class="cover"
        :class="{ active: i === index }"
        :style="styleFor(i)"
        :aria-hidden="i !== index"
      >
        <div class="cover-frame" @click="select(i)">
          <CoverImage
            :src="drama.cover"
            :alt="drama.title"
            :loading="i === 0 ? 'eager' : 'lazy'"
            width="310"
            height="410"
          />
        </div>
        <router-link
          class="cover-caption"
          :to="{ name: 'detail', params: { id: drama.id } }"
          :tabindex="i === index ? 0 : -1"
          >{{ drama.title }}</router-link
        >
      </div>
    </div>
    <div class="hero-foot">
      <div class="hero-copy">
        <h2>{{ active?.title }}</h2>
        <p>{{ active?.description }}</p>
        <div class="hero-meta">
          <strong v-if="active?.rating != null">{{ tr(`${active.rating}% 好评`, `${active.rating}% positive`) }}</strong>
          <span v-if="active?.episodeCount">
            {{ active.status === 'completed' ? tr(`全${active.episodeCount}集`, `${active.episodeCount} episodes`) : tr(`更新至${active.episodeCount}集`, `Up to Ep. ${active.episodeCount}`) }}
          </span>
        </div>
        <div class="hero-actions">
          <router-link
            v-if="active && active.episodeCount > 0"
            class="watch-button"
            :to="{ name: 'play', params: { id: active.id } }"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 5v14l11-7z" /></svg>
            {{ tr('立即观看', 'Play Now') }}
          </router-link>
          <router-link
            v-if="active"
            class="detail-button"
            :to="{ name: 'detail', params: { id: active.id } }"
            >{{ tr('查看详情', 'Details') }}</router-link
          >
        </div>
      </div>
      <div class="hero-nav">
        <button class="nav-arrow" :aria-label="tr('上一部推荐', 'Previous')" @click="select(index - 1)">‹</button>
        <div class="nav-dots">
          <button
            v-for="(drama, i) in dramas"
            :key="drama.id"
            :class="{ active: i === index }"
            :aria-label="tr(`推荐 ${i + 1}：${drama.title}`, `Recommendation ${i + 1}: ${drama.title}`)"
            :aria-pressed="i === index"
            @click="select(i)"
          />
        </div>
        <button class="nav-arrow" :aria-label="tr('下一部推荐', 'Next')" @click="select(index + 1)">›</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hero-carousel {
  --cover-step: 232px;
  position: relative;
  padding: 24px 0 0;
  user-select: none;
}
.stage {
  position: relative;
  height: 430px;
  overflow: hidden;
  perspective: 1100px;
  perspective-origin: 50% 50%;
  touch-action: pan-y;
}
.cover {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 240px;
  height: 320px;
  transform-style: preserve-3d;
  transition: transform 0.5s cubic-bezier(0.23, 1, 0.32, 1), opacity 0.5s ease;
  will-change: transform, opacity;
}
.cover-frame {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: var(--radius-lg);
  background: #000;
  box-shadow: 0 0 24px 0 rgba(0, 0, 0, 0.8);
  cursor: pointer;
  backface-visibility: hidden;
}
.cover-frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover:not(.active) .cover-frame img {
  opacity: 0.55;
}
.cover.active .cover-frame::after {
  content: '';
  position: absolute;
  inset: 0;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
  border-radius: inherit;
}
.cover-caption {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 12px);
  padding: 0 6px;
  overflow: hidden;
  color: rgba(255, 255, 255, 0.8);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.3s;
}
.cover.active .cover-caption {
  opacity: 1;
}
.hero-foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 32px;
  padding: 0 0 4px;
}
.hero-copy {
  max-width: 640px;
}
.hero-copy h2 {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.3;
}
.hero-copy p {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-top: 8px;
  color: var(--fg-2);
  font-size: 14px;
  line-height: 1.6;
}
.hero-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 10px;
  color: var(--fg-2);
  font-size: 13px;
}
.hero-meta strong {
  color: var(--gold);
}
.hero-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
}
.watch-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 42px;
  padding: 0 26px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  transition: background 0.2s;
}
.watch-button svg {
  width: 14px;
  height: 14px;
}
.watch-button:hover {
  background: var(--accent-hover);
}
.detail-button {
  display: inline-flex;
  align-items: center;
  height: 42px;
  padding: 0 22px;
  border-radius: 8px;
  background: #3a3a3a;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  transition: background 0.2s;
}
.detail-button:hover {
  background: #474747;
}
.hero-nav {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.nav-arrow {
  display: grid;
  place-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: #232323;
  color: #fff;
  font-size: 20px;
  line-height: 1;
  transition: background 0.2s;
}
.nav-arrow:hover {
  background: var(--accent);
}
.nav-dots {
  display: flex;
  align-items: center;
  gap: 6px;
}
.nav-dots button {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.25);
  transition: width 0.2s, background 0.2s;
}
.nav-dots button.active {
  width: 20px;
  border-radius: 4px;
  background: var(--accent);
}
@media (max-width: 1024px) {
  .hero-carousel {
    --cover-step: 206px;
  }
  .stage {
    height: 380px;
  }
  .cover {
    width: 214px;
    height: 286px;
  }
  .hero-copy {
    max-width: 100%;
  }
}
@media (max-width: 768px) {
  .hero-carousel {
    --cover-step: 132px;
    padding-top: 12px;
  }
  .stage {
    height: 310px;
  }
  .cover {
    width: 168px;
    height: 224px;
  }
  .hero-foot {
    flex-direction: column;
    align-items: stretch;
    gap: 16px;
  }
  .hero-copy h2 {
    font-size: 18px;
  }
  .hero-copy p {
    font-size: 13px;
  }
  .hero-nav {
    justify-content: center;
  }
  .watch-button,
  .detail-button {
    height: 38px;
    font-size: 13px;
  }
}
</style>
