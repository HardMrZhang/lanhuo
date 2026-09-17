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
  position: relative;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
}
/* 右侧渐隐，提示还能横向滑动 */
.tabs-wrap::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  bottom: 1px;
  width: 36px;
  background: linear-gradient(to right, transparent, var(--bg-2));
  pointer-events: none;
}
.tabs {
  display: flex;
  gap: 24px;
  overflow-x: auto;
  white-space: nowrap;
  padding-right: 36px;
  scroll-padding-inline: var(--gutter);
}
.tab {
  flex: 0 0 auto;
  position: relative;
  padding: 14px 0 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--fg-2);
  transition: color 0.15s;
}
@media (min-width: 960px) {
  .tabs {
    gap: 30px;
  }
  .tab {
    padding: 16px 0 14px;
    font-size: 17px;
  }
}
@media (min-width: 1600px) {
  .tabs {
    gap: 34px;
  }
  .tab {
    padding: 18px 0 16px;
    font-size: 18px;
  }
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
