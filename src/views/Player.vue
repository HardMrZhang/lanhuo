<script setup lang="ts">
/**
 * 竖屏沉浸播放页：
 * - 上下滑动切集（scroll-snap），IntersectionObserver 决定哪一集处于激活状态。
 * - 只渲染当前集及数组中的前后相邻集，避免多路解码。
 * - 当前集播放时，用 <link rel="prefetch"> 预热下一集的清单/首片，切集近乎秒开。
 * - 播完自动跳下一集；地址栏与集数同步，可直接分享 /play/:id/:ep。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { tr, translateMessage } from '../i18n'
import type { Drama } from '../types'
import { history } from '../storage'
import { isPaidEpisode } from '../access'
import { account, refreshAccount } from '../account'
import VideoPlayer from '../components/VideoPlayer.vue'
import EpisodeDrawer from '../components/EpisodeDrawer.vue'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'

const props = defineProps<{ id: string; ep: number }>()
const router = useRouter()

const drama = ref<Drama | null>(null)
const error = ref('')
// 加载后再从实际集数中解析路由，集号可能不连续。
const current = ref(0)
const muted = ref(false)
const buffering = ref(false)
const showDrawer = ref(false)
const progress = ref(0)
const needGesture = ref(false)
const playbackError = ref('')

const feed = ref<HTMLElement | null>(null)
const players = ref<Record<number, InstanceType<typeof VideoPlayer> | null>>({})

const episodes = computed(() => drama.value?.episodes ?? [])
const total = computed(() => episodes.value.length)
const latestEpisode = computed(() =>
  episodes.value.reduce((latest, episode) => Math.max(latest, episode.no), 0),
)
const currentIndex = computed(() => episodes.value.findIndex((e) => e.no === current.value))
const currentEp = computed(() => episodes.value[currentIndex.value])
const isVip = computed(() => account.user?.vipActive === true)
const isLocked = (no: number) => isPaidEpisode(no) && !isVip.value
const episodeTitle = computed(() => {
  const title = currentEp.value?.title
  return !title || /^第\s*\d+\s*集$/.test(title.trim())
    ? tr(`第${current.value}集`, `Episode ${current.value}`)
    : title
})
watchEffect(() => {
  const title = drama.value?.title || tr('播放', 'Watch')
  const episode = current.value ? ` · ${tr(`第${current.value}集`, `Episode ${current.value}`)}` : ''
  document.title = `${title}${episode} · ${tr('短剧剧场', 'Drama Theater')}`
})

/** 只渲染当前集及相邻集，其他用占位保持滚动高度 */
const isNear = (index: number) => currentIndex.value >= 0 && Math.abs(index - currentIndex.value) <= 1

// ---------- 加载 ----------
async function loadDrama() {
  drama.value = await api.drama(props.id)
  if (!episodes.value.length) throw new Error('该剧暂无剧集')
}

onMounted(async () => {
  try {
    // 会员状态决定第 2 集起能否播放，进入播放页时先确认再加载剧集，
    // 避免会员短暂看到付费墙，也保证拿到的播放地址与服务端权限一致。
    await refreshAccount()
    await loadDrama()
    current.value = normalizeEpisode(props.ep)
    history.set(props.id, current.value)
    await nextTick()
    scrollTo(current.value, 'auto')
    setupObserver()
    prefetchNext(current.value)
  } catch (e) {
    error.value = (e as Error).message
  }
})

// 在会员中心开通后返回播放页（keep-alive 会保留组件），重新拉取播放地址。
watch(isVip, async (active, was) => {
  if (!active || was || !drama.value) return
  try {
    await loadDrama()
    prefetched.clear()
    nextTick(() => {
      observeAll()
      prefetchNext(current.value)
    })
  } catch {
    // 保留已有剧集数据，用户可手动重试。
  }
})

// ---------- 滑动切集 ----------
let io: IntersectionObserver | null = null
let scrollTarget: number | null = null
function setupObserver() {
  io?.disconnect()
  io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting && en.intersectionRatio >= 0.6) {
          const no = Number((en.target as HTMLElement).dataset.no)
          if (scrollTarget != null && no !== scrollTarget) continue
          if (no === scrollTarget) scrollTarget = null
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
  feed.value
    .querySelectorAll<HTMLElement>('.slide')
    .forEach((el) => io!.observe(el))
}

function scrollTo(no: number, behavior: ScrollBehavior = 'smooth') {
  const el = feed.value?.querySelector<HTMLElement>(`.slide[data-no="${no}"]`)
  el?.scrollIntoView({ behavior, block: 'start' })
}

function normalizeEpisode(no: number) {
  const first = episodes.value[0]
  if (!first) return 0
  if (!Number.isFinite(no)) return first.no
  const value = Math.trunc(no)
  return episodes.value.reduce(
    (nearest, episode) =>
      Math.abs(episode.no - value) < Math.abs(nearest.no - value) ? episode : nearest,
    first,
  ).no
}

function go(no: number, behavior: ScrollBehavior = 'smooth') {
  if (!episodes.value.some((episode) => episode.no === no)) return
  scrollTarget = no
  current.value = no
  nextTick(() => scrollTo(no, behavior))
}

// The player is kept mounted while only its episode route parameter changes.
watch(
  () => props.ep,
  (no) => {
    if (!drama.value) return
    const target = normalizeEpisode(no)
    if (target !== current.value) go(target, 'auto')
    else if (target !== no) router.replace({ name: 'play', params: { id: props.id, ep: target } })
  },
)

// 当前集变化：同步 URL、记录观看历史、预取下一集
watch(current, (no) => {
  progress.value = 0
  buffering.value = false
  needGesture.value = false
  playbackError.value = ''
  if (props.ep !== no)
    router.replace({ name: 'play', params: { id: props.id, ep: no } })
  history.set(props.id, no)
  prefetchNext(no)
  nextTick(observeAll)
})

// ---------- 预取 ----------
const prefetched = new Set<string>()
function prefetchNext(no: number) {
  const index = episodes.value.findIndex((episode) => episode.no === no)
  const next = index >= 0 ? episodes.value[index + 1] : undefined
  // 付费集不预热，避免对无权限的用户发起必然失败的请求。
  if (!next?.src || isLocked(next.no) || prefetched.has(next.src)) return
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
  const next = episodes.value[currentIndex.value + 1]
  if (next) go(next.no)
}
function onProgress(no: number, cur: number, dur: number) {
  if (no !== current.value) return
  progress.value =
    Number.isFinite(dur) && dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0
}
function onWaiting(no: number, waiting: boolean) {
  if (no === current.value) buffering.value = waiting && !playbackError.value
}
function onReady(no: number) {
  if (no !== current.value) return
  buffering.value = false
  needGesture.value = false
  playbackError.value = ''
}
function onPlaybackError(no: number, message: string) {
  if (no !== current.value) return
  playbackError.value = message
  buffering.value = false
  needGesture.value = false
}
function onGesture(no: number) {
  if (no !== current.value || playbackError.value) return
  needGesture.value = true
  buffering.value = false
}
function retryPlayback() {
  playbackError.value = ''
  needGesture.value = false
  players.value[current.value]?.retry()
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
    <div v-if="!drama || error" class="state-language"><LanguageSwitcher class="player-language" /></div>
    <p v-if="error" class="error" role="alert">
      {{ translateMessage(error) }}<br /><button class="link" @click="back">{{ tr('返回', 'Back') }}</button>
    </p>
    <p v-else-if="!drama" class="error" role="status">{{ tr('正在加载剧集…', 'Loading series…') }}</p>

    <template v-else-if="drama">
      <div ref="feed" class="feed">
        <section
          v-for="(e, index) in episodes"
          :key="e.no"
          class="slide"
          :data-no="e.no"
        >
          <VideoPlayer
            v-if="isNear(index) && !isLocked(e.no)"
            :ref="
              (el) =>
                (players[e.no] = el as InstanceType<typeof VideoPlayer> | null)
            "
            :src="e.src"
            :poster="drama.cover"
            :active="e.no === current"
            :muted="muted"
            @ended="onEnded(e.no)"
            @progress="(cur, dur) => onProgress(e.no, cur, dur)"
            @waiting="onWaiting(e.no, $event)"
            @ready="onReady(e.no)"
            @error="onPlaybackError(e.no, $event)"
            @need-gesture="onGesture(e.no)"
          />
          <div v-if="isLocked(e.no)" class="locked-slide">
            <img v-if="drama.cover" class="locked-cover" :src="drama.cover" alt="" aria-hidden="true" />
            <div class="locked-panel">
              <span class="locked-badge" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm3 8H9V7a3 3 0 0 1 6 0v3Z" />
                </svg>
                VIP
              </span>
              <p class="locked-title">{{ tr(`第${e.no}集为 VIP 专享`, `Episode ${e.no} is for VIP members`) }}</p>
              <p class="locked-copy">{{ tr('第 1 集免费观看，开通会员即可解锁全部剧集。', 'Episode 1 is free. Join VIP to unlock every episode.') }}</p>
              <button class="locked-cta" type="button" @click="router.push({ name: 'vip' })">
                {{ tr('开通 VIP 会员', 'Join VIP') }}
              </button>
              <button class="locked-back" type="button" @click="go(1)">
                {{ tr('返回第 1 集', 'Back to episode 1') }}
              </button>
            </div>
          </div>
        </section>
      </div>

      <!-- 顶部栏 -->
      <header class="top">
        <button class="icon" :aria-label="tr('返回', 'Back')" @click="back">
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M15 5l-7 7 7 7"
            />
          </svg>
        </button>
        <LanguageSwitcher class="player-language" />
        <div class="top-title">{{ drama.title }} · {{ tr(`第${current}集`, `Episode ${current}`) }}</div>
        <button
          class="icon"
          :aria-label="muted ? tr('取消静音', 'Unmute') : tr('静音', 'Mute')"
          @click="muted = !muted"
        >
          <svg
            v-if="muted"
            viewBox="0 0 24 24"
            width="22"
            height="22"
            aria-hidden="true"
          >
            <path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z" />
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              d="M16 9l5 6m0-6l-5 6"
            />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
            width="22"
            height="22"
            aria-hidden="true"
          >
            <path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z" />
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              d="M16 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"
            />
          </svg>
        </button>
      </header>

      <!-- 底部信息 -->
      <footer class="bottom">
        <div class="meta">
          <span class="chip" v-for="t in drama.tags?.slice(0, 3)" :key="t">{{
            t
          }}</span>
        </div>
        <div class="ep-title">{{ episodeTitle }}</div>
        <button class="select" @click="showDrawer = true">
          {{ tr('选集', 'Episodes') }} · {{ drama.status === 'completed' ? tr(`共${total}集`, `${total} episodes`) : tr(`更至${latestEpisode}集`, `Updated to episode ${latestEpisode}`) }}
          ›
        </button>
        <div class="bar"><i :style="{ width: `${progress * 100}%` }" /></div>
      </footer>

      <!-- 缓冲提示 -->
      <div
        v-if="buffering && !playbackError"
        class="spinner"
        role="status"
        :aria-label="tr('视频缓冲中', 'Buffering video')"
      />

      <div v-if="playbackError" class="playback-error" role="alert">
        <p>{{ translateMessage(playbackError) }}</p>
        <button class="retry-playback" @click="retryPlayback">{{ tr('重新播放', 'Try again') }}</button>
      </div>

      <!-- 自动播放被拦截时的引导 -->
      <button
        v-if="needGesture && !playbackError"
        class="gesture"
        @click="resumeWithGesture"
      >
        {{ tr('点击播放', 'Tap to play') }}
      </button>

      <EpisodeDrawer
        :drama="drama"
        :current="current"
        :open="showDrawer"
        :vip-active="isVip"
        @select="
          (no) => {
            showDrawer = false
            if (isLocked(no)) {
              router.push({ name: 'vip' })
              return
            }
            go(no)
          }
        "
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
  position: relative;
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
.player-language {
  pointer-events: auto;
  flex-shrink: 0;
  max-width: 90px;
  color: #fff;
  border-color: rgba(255, 255, 255, 0.25);
  background: rgba(0, 0, 0, 0.4);
}
.state-language {
  position: absolute;
  z-index: 20;
  top: calc(12px + var(--safe-top));
  right: 12px;
}
.top-title {
  flex: 1;
  min-width: 0;
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
  flex-shrink: 0;
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
.playback-error {
  position: absolute;
  z-index: 15;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(340px, calc(100% - 40px));
  padding: 22px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 12px;
  background: rgba(10, 12, 18, 0.9);
  color: #fff;
  text-align: center;
  font-size: 14px;
}
.retry-playback {
  margin-top: 16px;
  padding: 10px 24px;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-fg);
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
.locked-slide {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: #000;
}
.locked-cover {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: blur(22px) brightness(0.35);
  transform: scale(1.1);
}
.locked-panel {
  position: relative;
  z-index: 1;
  width: min(340px, 100%);
  padding: 26px 22px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 16px;
  background: rgba(20, 20, 20, 0.82);
  text-align: center;
  backdrop-filter: blur(10px);
}
.locked-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 999px;
  background: linear-gradient(100deg, #f6dca8, #d9ae68);
  color: #33251a;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.6px;
}
.locked-title {
  margin: 14px 0 6px;
  color: #fff;
  font-size: 17px;
  font-weight: 700;
}
.locked-copy {
  color: var(--fg-2);
  font-size: 13px;
  line-height: 1.7;
}
.locked-cta {
  width: 100%;
  margin-top: 18px;
  padding: 12px;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  font-size: 15px;
  font-weight: 700;
}
.locked-cta:hover {
  background: var(--accent-hover);
}
.locked-back {
  margin-top: 12px;
  color: var(--fg-3);
  font-size: 13px;
}
.locked-back:hover {
  color: #fff;
}
</style>
