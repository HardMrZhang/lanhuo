<script setup lang="ts">
import type { Drama } from '../types'
import { tr } from '../i18n'
import { isPaidEpisode } from '../access'

const props = defineProps<{
  drama: Drama
  current: number
  open: boolean
  vipActive: boolean
}>()
const emit = defineEmits<{ select: [no: number]; close: [] }>()

const locked = (no: number) => isPaidEpisode(no) && !props.vipActive
</script>

<template>
  <transition name="drawer">
    <div v-if="open" class="mask" @click.self="emit('close')">
      <div class="sheet" role="dialog" aria-modal="true" :aria-label="tr('选择剧集', 'Choose an episode')">
        <div class="head">
          <div>
            <div class="title">{{ drama.title }}</div>
            <div class="sub">
              {{ drama.status === 'completed' ? tr('已完结', 'Completed') : tr('更新中', 'Ongoing') }} · {{ tr(`共 ${drama.episodes.length} 集`, `${drama.episodes.length} episodes`) }}
            </div>
          </div>
          <button class="close" :aria-label="tr('关闭选集', 'Close episode picker')" @click="emit('close')">✕</button>
        </div>
        <p class="desc">{{ drama.description }}</p>
        <p class="paywall-note">
          {{ vipActive
            ? tr('VIP 会员已解锁全部剧集', 'VIP unlocks every episode')
            : tr('第 1 集免费，第 2 集起为 VIP 专享', 'Episode 1 is free. Episode 2 onward is for VIP members.') }}
        </p>
        <div class="grid">
          <button
            v-for="e in drama.episodes"
            :key="e.no"
            class="ep"
            :data-active="e.no === current"
            :data-locked="locked(e.no)"
            :aria-label="locked(e.no)
              ? tr(`第${e.no}集为 VIP 专享`, `Episode ${e.no} is for VIP members`)
              : tr(`播放第${e.no}集`, `Play episode ${e.no}`)"
            :aria-current="e.no === current ? 'true' : undefined"
            @click="emit('select', e.no)"
          >
            <span>{{ e.no }}</span>
            <span v-if="locked(e.no)" class="lock" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="10" height="10">
                <path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm3 8H9V7a3 3 0 0 1 6 0v3Z" />
              </svg>
            </span>
          </button>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.mask {
  position: absolute;
  inset: 0;
  z-index: 20;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: flex-end;
}
.sheet {
  width: 100%;
  max-height: 70%;
  padding: 16px 16px calc(16px + var(--safe-bottom));
  border-radius: 16px 16px 0 0;
  background: var(--bg-2);
  overflow-y: auto;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}
.title {
  font-size: 17px;
  font-weight: 700;
}
.sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--fg-2);
}
.close {
  font-size: 18px;
  color: var(--fg-2);
  padding: 4px;
}
.desc {
  margin: 10px 0 8px;
  font-size: 13px;
  color: var(--fg-2);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.paywall-note {
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--gold);
}
.grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
}
.ep {
  position: relative;
  aspect-ratio: 1;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  font-size: 15px;
  font-weight: 500;
}
.ep[data-locked='true'] {
  color: var(--fg-3);
}
.ep[data-active='true'] {
  background: var(--accent);
  color: var(--accent-fg);
  font-weight: 700;
}
.lock {
  position: absolute;
  top: 3px;
  right: 3px;
  color: var(--gold);
  display: grid;
  place-items: center;
}
.ep[data-active='true'] .lock {
  color: #fff;
}
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity 0.2s;
}
.drawer-enter-active .sheet,
.drawer-leave-active .sheet {
  transition: transform 0.25s ease;
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}
.drawer-enter-from .sheet,
.drawer-leave-to .sheet {
  transform: translateY(100%);
}
</style>
