<script setup lang="ts">
import type { Drama } from '../types'

defineProps<{
  drama: Drama
  current: number
  open: boolean
}>()
const emit = defineEmits<{ select: [no: number]; close: [] }>()
</script>

<template>
  <transition name="drawer">
    <div v-if="open" class="mask" @click.self="emit('close')">
      <div class="sheet">
        <div class="head">
          <div>
            <div class="title">{{ drama.title }}</div>
            <div class="sub">
              {{ drama.status === 'completed' ? '已完结' : '更新中' }} · 共 {{ drama.episodes.length }} 集
            </div>
          </div>
          <button class="close" @click="emit('close')">✕</button>
        </div>
        <p class="desc">{{ drama.description }}</p>
        <div class="grid">
          <button
            v-for="e in drama.episodes"
            :key="e.no"
            class="ep"
            :data-active="e.no === current"
            @click="emit('select', e.no)"
          >
            {{ e.no }}
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
  margin: 10px 0 14px;
  font-size: 13px;
  color: var(--fg-2);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
}
.ep {
  aspect-ratio: 1;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  font-size: 15px;
  font-weight: 500;
}
.ep[data-active='true'] {
  background: var(--accent);
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
