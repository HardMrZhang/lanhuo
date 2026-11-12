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
  'duration': [duration: number]
}>()

const video = ref<HTMLVideoElement | null>(null)
const paused = ref(false)
const failed = ref(false)
let mounted = false
let hls: Hls | null = null
let hlsReady = false
let attachedSrc = ''
let sourceGeneration = 0
/** 拖动进度条时的目标位置，等 duration 就绪后再跳转 */
let pendingSeek: number | null = null

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
    instance.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
      // HLS 的总时长来自 level 的 duration，第一个 level 加载后才有值。
      const total = (data as { details?: { totalDuration?: number } }).details?.totalDuration
      if (typeof total === 'number' && total > 0 && total !== knownDuration.value) {
        knownDuration.value = total
        emit('duration', total)
      }
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
  pendingSeek = null
  knownDuration.value = 0
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

/** 记录倍速，重新加载/切集后保持 */
const playbackRate = ref(1)

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
  element.playbackRate = playbackRate.value
  element.defaultPlaybackRate = playbackRate.value
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
  if (!video.value) return
  // HLS 未就绪时直接改 currentTime 会被忽略，seekable 之前先存住目标位置，
  // 等元数据/清单就绪后再跳过去 —— 否则用户拖动进度条会“没反应”。
  const target = Math.max(0, seconds)
  pendingSeek = target
  if (Number.isFinite(video.value.duration) && video.value.duration > 0) {
    const clamped = Math.min(target, Math.max(0, video.value.duration - 0.1))
    video.value.currentTime = clamped
    pendingSeek = null
  }
}

/** 已知的时长（duration 事件在部分源上触发较晚） */
const knownDuration = ref(0)

/** 拖动进度条时用的比例 seek（0~1），duration 未就绪时按已知时长换算 */
function seekRatio(ratio: number) {
  const element = video.value
  const duration =
    element && Number.isFinite(element.duration) ? element.duration : knownDuration.value
  if (!duration || duration <= 0) return
  seek(ratio * duration)
}

function onDurationChange() {
  const element = video.value
  if (!element) return
  const d = element.duration
  if (!Number.isFinite(d) || d <= 0) return
  knownDuration.value = d
  emit('duration', d)
  // 拖动过但时长后到的情况：现在才知道该跳到哪
  if (pendingSeek !== null) {
    element.currentTime = Math.min(pendingSeek, Math.max(0, d - 0.1))
    pendingSeek = null
  }
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
// 倍速在重新加载后需要重新应用
watch(playbackRate, (rate) => {
  if (video.value) {
    video.value.playbackRate = rate
    video.value.defaultPlaybackRate = rate
  }
})
onBeforeUnmount(() => {
  mounted = false
  detach()
})

/** 设置倍速（切集/重新加载后需要重设） */
function setPlaybackRate(rate: number) {
  playbackRate.value = rate
  if (!video.value) return
  video.value.playbackRate = rate
  video.value.defaultPlaybackRate = rate
}

/** 供外部读取 <video> 元素 */
function videoElement() {
  return video.value
}

defineExpose({
  play,
  pause,
  toggle,
  seek,
  seekRatio,
  retry,
  setPlaybackRate,
  videoElement,
})
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
      @durationchange="onDurationChange"
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
