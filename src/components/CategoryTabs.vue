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

// 选中项滚到可视区中间
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
  <nav ref="bar" class="tabs">
    <button
      v-for="c in categories"
      :key="c.id"
      class="tab"
      :data-active="c.id === modelValue"
      @click="select(c.id)"
    >
      {{ c.name }}
    </button>
  </nav>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  overflow-x: auto;
  scroll-snap-type: x proximity;
  white-space: nowrap;
}
.tab {
  flex: 0 0 auto;
  padding: 6px 14px;
  border-radius: 999px;
  background: var(--bg-2);
  color: var(--fg-2);
  font-size: 14px;
  scroll-snap-align: center;
  transition: background 0.15s, color 0.15s;
}
.tab[data-active='true'] {
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
</style>
