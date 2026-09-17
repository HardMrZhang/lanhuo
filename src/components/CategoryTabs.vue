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
/* 顶栏下方的横向导航：深灰底、白字，选中项橙色下划线 */
.tabs {
  display: flex;
  gap: 0;
  padding: 0 8px;
  overflow-x: auto;
  white-space: nowrap;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
}
.tab {
  flex: 0 0 auto;
  position: relative;
  padding: 12px 14px;
  font-size: 14px;
  font-weight: 700;
  color: var(--fg);
  text-transform: uppercase;
  transition: color 0.15s;
}
.tab::after {
  content: '';
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: 0;
  height: 3px;
  background: var(--accent);
  transform: scaleX(0);
  transition: transform 0.15s;
}
.tab:hover {
  color: var(--accent);
}
.tab[data-active='true'] {
  color: var(--accent);
}
.tab[data-active='true']::after {
  transform: scaleX(1);
}
</style>
