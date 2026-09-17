<script setup lang="ts">
/**
 * 竖屏沉浸播放页：
 * - 上下滑动切集（scroll-snap），IntersectionObserver 决定哪一集处于激活状态。
 * - 只渲染 当前集 ±1，其它集不占 DOM，避免多路解码。
 * - 当前集播放时，用 <link rel="prefetch"> 预热下一集的清单/首片，切集近乎秒开。
 * - 播完自动跳下一集；地址栏与集数同步，可直接分享 /play/:id/:ep。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import type { Drama } from '../types'
import { history } from '../storage'
import VideoPlayer from '../components/VideoPlayer.vue'
import EpisodeDrawer from '../components/EpisodeDrawer.vue'

const props = defineProps<{ id: string; ep: number }>()
const router = useRouter()

const drama = ref<Drama | null>(null)
const error = ref('')
const current = ref(Math.max(1, props.ep))
const muted = ref(false)
const buffering = ref(false)
const showDrawer = ref(false)
const progress = ref(0)
const needGesture = ref(false)

const feed = ref<HTMLElement | null>(null)
const players = ref<Record<number, InstanceType<typeof VideoPlayer> | null>>({})

const episodes = computed(() => drama.value?.episodes ?? [])
const total = computed(() => episodes.value.length)
const currentEp = computed(() => episodes.value.find((e) => e.no === current.value))

/** 只渲染当前集及相邻集，其他用占位保持滚动高度 */
const isNear = (no: number) => Math.abs(no - current.value) <= 1

// ---------- 加载 ----------
onMounted(async () => {
  try {
    drama.value = await api.drama(props.id)
    if (!episodes.value.length) throw new Error('该剧暂无剧集')
    current.value = Math.min(Math.max(1, props.ep), total.value)
    history.set(props.id, current.value)
    await nextTick()
    scrollTo(current.value, 'auto')
    setupObserver()
  } catch (e) {
    error.value = (e as Error).message
  }
})

// ---------- 滑动切集 ----------
let io: IntersectionObserver | null = null
function setupObserver() {
  io?.disconnect()
  io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting && en.intersectionRatio >= 0.6) {
          const no = Number((en.target as HTMLElement).dataset.no)
          if (no && no !== current.value) current.value = no
        }
      }
    },
    { root: feed.value, threshold: [0.6] },
  )
  observeAll()
}
function observeAll() {
  if (!io || !feed.value) return
  io.disconnect()
  feed.value.querySelectorAll<HTMLElement>('.slide').forEach((el) => io!.observe(el))
}

function scrollTo(no: number, behavior: ScrollBehavior = 'smooth') {
  const el = feed.value?.querySelector<HTMLElement>(`.slide[data-no="${no}"]`)
  el?.scrollIntoView({ behavior, block: 'start' })
}

function go(no: number) {
  if (no < 1 || no > total.value) return
  current.value = no
  nextTick(() => scrollTo(no))
}

// 当前集变化：同步 URL、记录观看历史、预取下一集
watch(current, (no) => {
  progress.value = 0
  router.replace({ name: 'play', params: { id: props.id, ep: no } })
  history.set(props.id, no)
  prefetchNext(no)
  nextTick(observeAll)
})

// ---------- 预取 ----------
const prefetched = new Set<string>()
function prefetchNext(no: number) {
  const next = episodes.value.find((e) => e.no === no + 1)
  if (!next || prefetched.has(next.src)) return
  prefetched.add(next.src)
  const link = document.createElement('link')
  link.rel = 'prefetch'
  link.as = 'fetch'
  link.href = next.src
  link.crossOrigin = 'anonymous'
  document.head.appendChild(link)
}

// ---------- 播放事件 ----------
function onEnded(no: number) {
  if (no !== current.value) return
  if (no < total.value) go(no + 1)
}
function onProgress(cur: number, dur: number) {
  progress.value = dur ? cur / dur : 0
}
function onGesture() {
  needGesture.value = true
}
function resumeWithGesture() {
  needGesture.value = false
  players.value[current.value]?.play()
}

function back() {
  if (window.history.length > 1) router.back()
  else router.push({ name: 'detail', params: { id: props.id } })
}

onBeforeUnmount(() => io?.disconnect())
</script>

<template>
  <div class="page">
    <p v-if="error" class="error">{{ error }}<br /><button class="link" @click="back">返回首页</button></p>

    <template v-else-if="drama">
      <div ref="feed" class="feed">
        <section
          v-for="e in episodes"
          :key="e.no"
          class="slide"
          :data-no="e.no"
        >
          <VideoPlayer
            v-if="isNear(e.no)"
            :ref="(el) => (players[e.no] = el as InstanceType<typeof VideoPlayer> | null)"
            :src="e.src"
            :poster="drama.cover"
            :active="e.no === current"
            :muted="muted"
            @ended="onEnded(e.no)"
            @progress="onProgress"
            @waiting="buffering = $event"
            @need-gesture="onGesture"
          />
        </section>
      </div>

      <!-- 顶部栏 -->
      <header class="top">
        <button class="icon" aria-label="返回" @click="back">
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <div class="top-title">{{ drama.title }} · 第{{ current }}集</div>
        <button class="icon" :aria-label="muted ? '取消静音' : '静音'" @click="muted = !muted">
          <svg v-if="muted" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z" />
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9l5 6m0-6l-5 6" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z" />
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
          </svg>
        </button>
      </header>

      <!-- 底部信息 -->
      <footer class="bottom">
        <div class="meta">
          <span class="chip" v-for="t in drama.tags?.slice(0, 3)" :key="t">{{ t }}</span>
        </div>
        <div class="ep-title">{{ currentEp?.title || `第${current}集` }}</div>
        <button class="select" @click="showDrawer = true">
          选集 · {{ drama.status === 'completed' ? '全' : '更至' }}{{ total }}集 ›
        </button>
        <div class="bar"><i :style="{ width: `${progress * 100}%` }" /></div>
      </footer>

      <!-- 缓冲提示 -->
      <div v-if="buffering" class="spinner" />

      <!-- 自动播放被拦截时的引导 -->
      <button v-if="needGesture" class="gesture" @click="resumeWithGesture">点击播放</button>

      <EpisodeDrawer
        :drama="drama"
        :current="current"
        :open="showDrawer"
        @select="(no) => { showDrawer = false; go(no) }"
        @close="showDrawer = false"
      />
    </template>
  </div>
</template>

<style scoped>
.page {
  position: fixed;
  inset: 0;
  background: #000;
  overflow: hidden;
}
.feed {
  height: 100%;
  overflow-y: scroll;
  scroll-snap-type: y mandatory;
  scrollbar-width: none;
}
.slide {
  height: 100%;
  scroll-snap-align: start;
  scroll-snap-stop: always;
  background: #000;
}
.top,
.bottom {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 10;
  pointer-events: none;
}
.top {
  top: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: calc(8px + var(--safe-top)) 8px 8px;
  background: linear-gradient(rgba(0, 0, 0, 0.5), transparent);
}
.top-title {
  flex: 1;
  text-align: center;
  font-size: 14px;
  color: #fff;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.icon {
  pointer-events: auto;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  color: #fff;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.6));
}
.bottom {
  bottom: 0;
  padding: 24px 16px calc(12px + var(--safe-bottom));
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.6));
}
.meta {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}
.ep-title {
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
}
.select {
  pointer-events: auto;
  margin-top: 10px;
  width: 100%;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  text-align: left;
  font-size: 14px;
  backdrop-filter: blur(6px);
}
.bar {
  margin-top: 10px;
  height: 2px;
  background: rgba(255, 255, 255, 0.25);
  border-radius: 1px;
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.25s linear;
}
.spinner {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 36px;
  height: 36px;
  margin: -18px 0 0 -18px;
  border: 3px solid rgba(255, 255, 255, 0.25);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  pointer-events: none;
  z-index: 10;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.gesture {
  position: absolute;
  z-index: 15;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 12px 28px;
  border-radius: 4px;
  background: var(--accent);
  color: var(--accent-fg);
  font-size: 16px;
  font-weight: 700;
}
.error {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  text-align: center;
  color: var(--fg-2);
}
.link {
  margin-top: 12px;
  color: var(--accent);
}
</style>
