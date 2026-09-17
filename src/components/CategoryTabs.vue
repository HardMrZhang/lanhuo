<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { Category } from '../types'

const props = defineProps<{
  categories: Category[]
  modelValue: string
}>()
const emit = defineEmits<{ 'update:modelValue': [id: string] }>()

const bar = ref<HTMLElement | null>(null)

function select(id: string) {
  emit('update:modelValue', id)
}

watch(
  () => props.modelValue,
  async () => {
    await nextTick()
    const el = bar.value?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  },
  { immediate: true },
)
</script>

<template>
  <nav class="tabs-wrap">
    <div ref="bar" class="tabs container">
      <button
        v-for="c in categories"
        :key="c.id"
        class="tab"
        :data-active="c.id === modelValue"
        @click="select(c.id)"
      >
        {{ c.name }}
      </button>
    </div>
  </nav>
</template>

<style scoped>
/* 与内容区共用 container，文字左边缘与卡片左边缘对齐 */
.tabs-wrap {
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
}
.tabs {
  display: flex;
  gap: 22px;
  overflow-x: auto;
  white-space: nowrap;
}
.tab {
  flex: 0 0 auto;
  position: relative;
  padding: 13px 0 11px;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg-2);
  transition: color 0.15s;
}
.tab::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  background: var(--accent);
  opacity: 0;
  transition: opacity 0.15s;
}
.tab:hover {
  color: var(--fg);
}
.tab[data-active='true'] {
  color: var(--fg);
}
.tab[data-active='true']::after {
  opacity: 1;
}
</style>
