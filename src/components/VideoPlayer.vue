<script setup lang="ts">
/**
 * 单集播放器：
 * - .m3u8 走 hls.js（Safari 原生 HLS 直接用 <video>），.mp4 走原生。
 * - active=true 时才真正加载/播放；相邻集只保留 poster，避免同时拉多路流。
 * - 缓冲策略：前向缓冲 30s、保留后向 10s，起播用较低码率快速首帧再自动升档。
 */
import Hls from 'hls.js'
import { onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  src: string
  poster?: string
  active: boolean
  muted: boolean
}>()
const emit = defineEmits<{
  ended: []
  progress: [current: number, duration: number]
  waiting: [is: boolean]
  'need-gesture': []
}>()

const video = ref<HTMLVideoElement | null>(null)
const paused = ref(false)
let hls: Hls | null = null
let attachedSrc = ''

const isHls = (u: string) => /\.m3u8(\?|$)/i.test(u)
const nativeHls = () => {
  const v = document.createElement('video')
  return v.canPlayType('application/vnd.apple.mpegurl') !== ''
}

function attach() {
  const v = video.value
  if (!v || attachedSrc === props.src) return
  detach()
  attachedSrc = props.src

  if (isHls(props.src) && !nativeHls() && Hls.isSupported()) {
    hls = new Hls({
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      backBufferLength: 10,
      startLevel: -1,
      abrEwmaDefaultEstimate: 1_000_000,
      lowLatencyMode: false,
      enableWorker: true,
      fragLoadingMaxRetry: 4,
      manifestLoadingMaxRetry: 3,
    })
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal || !hls) return
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
      else {
        detach()
        attach()
      }
    })
    hls.loadSource(props.src)
    hls.attachMedia(v)
  } else {
    v.src = props.src
    v.load()
  }
}

function detach() {
  if (hls) {
    hls.destroy()
    hls = null
  }
  const v = video.value
  if (v) {
    v.pause()
    v.removeAttribute('src')
    v.load()
  }
  attachedSrc = ''
}

async function play() {
  const v = video.value
  if (!v) return
  try {
    await v.play()
    paused.value = false
  } catch {
    // 自动播放被拦截：需要用户手势
    paused.value = true
    emit('need-gesture')
  }
}

function pause() {
  video.value?.pause()
  paused.value = true
}

function toggle() {
  if (video.value?.paused) play()
  else pause()
}

function seek(sec: number) {
  if (video.value) video.value.currentTime = sec
}

function onTime() {
  const v = video.value
  if (v) emit('progress', v.currentTime, v.duration || 0)
}

watch(
  () => [props.active, props.src] as const,
  ([active]) => {
    if (active) {
      attach()
      play()
    } else {
      detach()
    }
  },
  { immediate: true, flush: 'post' },
)

watch(
  () => props.muted,
  (m) => {
    if (video.value) video.value.muted = m
  },
  { immediate: true, flush: 'post' },
)

onBeforeUnmount(detach)

defineExpose({ play, pause, toggle, seek })
</script>

<template>
  <div class="player" @click="toggle">
    <video
      ref="video"
      class="video"
      :poster="poster"
      :muted="muted"
      playsinline
      webkit-playsinline
      x5-video-player-type="h5"
      preload="auto"
      @ended="emit('ended')"
      @timeupdate="onTime"
      @waiting="emit('waiting', true)"
      @playing="emit('waiting', false); paused = false"
      @pause="paused = true"
    />
    <div v-if="paused && active" class="play-icon">▶</div>
  </div>
</template>

<style scoped>
.player {
  position: relative;
  width: 100%;
  height: 100%;
  background: #000;
}
.video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.play-icon {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 64px;
  color: rgba(255, 255, 255, 0.85);
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}
</style>
