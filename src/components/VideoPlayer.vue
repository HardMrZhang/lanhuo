<script setup lang="ts">
/** Load only the active episode; adjacent slides retain their poster. */
import Hls from 'hls.js'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { tr } from '../i18n'

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
  ready: []
  error: [message: string]
  'need-gesture': []
}>()

const video = ref<HTMLVideoElement | null>(null)
const paused = ref(false)
const failed = ref(false)
let mounted = false
let hls: Hls | null = null
let hlsReady = false
let attachedSrc = ''
let sourceGeneration = 0

const isHls = (url: string) => /\.m3u8(\?|$)/i.test(url)

function fail(message: string) {
  if (!props.active || failed.value) return
  failed.value = true
  paused.value = true
  video.value?.pause()
  hls?.stopLoad()
  emit('waiting', false)
  emit('error', message)
}

function attach(force = false) {
  const element = video.value
  if (
    !element ||
    !props.active ||
    (!force && attachedSrc && attachedSrc === props.src)
  )
    return
  detach()
  attachedSrc = props.src
  failed.value = false
  emit('waiting', true)

  if (!props.src) {
    fail('该集暂无可用视频地址，请稍后重试。')
    return
  }
  if (
    isHls(props.src) &&
    !element.canPlayType('application/vnd.apple.mpegurl')
  ) {
    if (!Hls.isSupported()) {
      fail('当前浏览器无法播放此格式的视频。')
      return
    }
    const instance = new Hls({
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
    hls = instance
    instance.on(Hls.Events.MANIFEST_PARSED, () => {
      if (hls !== instance || !props.active) return
      hlsReady = true
      void play()
    })
    instance.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal || hls !== instance || !props.active) return
      fail(
        data.type === Hls.ErrorTypes.NETWORK_ERROR
          ? '视频加载失败，请检查网络后重试。'
          : '视频暂时无法播放，请重试或选择其他集数。',
      )
    })
    instance.loadSource(props.src)
    instance.attachMedia(element)
  } else {
    element.src = props.src
    element.load()
  }
}

function detach() {
  sourceGeneration++
  attachedSrc = ''
  failed.value = false
  hls?.destroy()
  hls = null
  hlsReady = false
  const element = video.value
  if (element) {
    element.pause()
    element.removeAttribute('src')
    element.load()
  }
}

async function play() {
  const element = video.value
  if (
    !element ||
    !props.active ||
    failed.value ||
    !attachedSrc ||
    (hls && !hlsReady)
  )
    return
  const generation = sourceGeneration
  element.muted = props.muted
  try {
    await element.play()
    if (generation === sourceGeneration && props.active) paused.value = false
  } catch (cause) {
    if (generation !== sourceGeneration || !props.active) return
    const name = cause instanceof Error ? cause.name : ''
    if (name === 'AbortError') return
    if (name === 'NotAllowedError') {
      paused.value = true
      emit('waiting', false)
      emit('need-gesture')
    } else {
      fail('视频暂时无法播放，请重试或选择其他集数。')
    }
  }
}

function pause() {
  video.value?.pause()
  paused.value = true
  if (props.active) emit('waiting', false)
}
function toggle() {
  if (!props.active || failed.value) return
  if (video.value?.paused) void play()
  else pause()
}
function seek(seconds: number) {
  if (video.value) video.value.currentTime = seconds
}
function retry() {
  if (!props.active) return
  attach(true)
  void play()
}
function syncActive() {
  if (!mounted) return
  if (props.active) {
    attach()
    void play()
  } else {
    detach()
  }
}
function onTime() {
  const element = video.value
  if (element && props.active)
    emit('progress', element.currentTime, element.duration || 0)
}
function onPlaying() {
  if (!props.active || !attachedSrc) return
  paused.value = false
  failed.value = false
  emit('waiting', false)
  emit('ready')
}
function onMediaError() {
  const mediaError = video.value?.error
  if (!props.active || !attachedSrc || !mediaError) return
  const message =
    mediaError.code === 2
      ? '视频加载失败，请检查网络后重试。'
      : mediaError.code === 4
        ? '视频源不可用或格式不受支持，请重试或选择其他集数。'
        : '视频暂时无法播放，请重试或选择其他集数。'
  fail(message)
}

// The template ref is available on mount. The watcher handles later changes only.
onMounted(() => {
  mounted = true
  syncActive()
})
watch(() => [props.active, props.src] as const, syncActive, { flush: 'post' })
watch(
  () => props.muted,
  (muted) => {
    if (video.value) video.value.muted = muted
  },
  { flush: 'post' },
)
onBeforeUnmount(() => {
  mounted = false
  detach()
})

defineExpose({ play, pause, toggle, seek, retry })
</script>

<template>
  <div class="player" @click="toggle">
    <video
      ref="video"
      class="video"
      :aria-label="tr('剧集视频', 'Episode video')"
      :poster="poster"
      :muted="muted"
      playsinline
      webkit-playsinline
      x5-video-player-type="h5"
      preload="auto"
      @ended="active && emit('ended')"
      @timeupdate="onTime"
      @waiting="active && !failed && emit('waiting', true)"
      @playing="onPlaying"
      @pause="paused = true"
      @error="onMediaError"
    />
    <div v-if="paused && active && !failed" class="play-icon" aria-hidden="true">▶</div>
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
