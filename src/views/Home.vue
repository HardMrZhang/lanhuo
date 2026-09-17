<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../api'
import type { Category, DramaSummary } from '../types'
import CategoryTabs from '../components/CategoryTabs.vue'
import DramaCard from '../components/DramaCard.vue'

defineOptions({ name: 'Home' })

const categories = ref<Category[]>([])
const active = ref('all')
const keyword = ref('')
const dramas = ref<DramaSummary[]>([])
const loading = ref(false)
const error = ref('')

const allTabs = computed<Category[]>(() => [{ id: 'all', name: '全部' }, ...categories.value])

let reqId = 0
async function load() {
  const id = ++reqId
  loading.value = true
  error.value = ''
  try {
    const list = await api.dramas({ category: active.value, q: keyword.value.trim() })
    if (id === reqId) dramas.value = list
  } catch (e) {
    if (id === reqId) error.value = (e as Error).message
  } finally {
    if (id === reqId) loading.value = false
  }
}

let timer: number | undefined
watch(keyword, () => {
  window.clearTimeout(timer)
  timer = window.setTimeout(load, 250)
})
watch(active, load)

onMounted(async () => {
  try {
    categories.value = await api.categories()
  } catch (e) {
    error.value = (e as Error).message
  }
  load()
})
</script>

<template>
  <div class="home">
    <header class="header">
      <h1 class="logo">短剧</h1>
      <input v-model="keyword" class="search" type="search" placeholder="搜索剧名 / 标签" />
    </header>

    <CategoryTabs v-model="active" :categories="allTabs" />

    <main class="content">
      <p v-if="error" class="state">加载失败：{{ error }}</p>
      <p v-else-if="!loading && dramas.length === 0" class="state">暂无内容</p>
      <div v-else class="grid" :class="{ dim: loading }">
        <DramaCard v-for="d in dramas" :key="d.id" :drama="d" />
      </div>
    </main>
  </div>
</template>

<style scoped>
.home {
  min-height: 100%;
  padding-top: var(--safe-top);
  padding-bottom: calc(16px + var(--safe-bottom));
}
.header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 12px 4px;
}
.logo {
  margin: 0;
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 1px;
  color: var(--accent);
}
.search {
  flex: 1;
  height: 34px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: var(--bg-2);
  color: var(--fg);
  font: inherit;
  outline: none;
}
.search::placeholder {
  color: var(--fg-2);
}
.content {
  padding: 4px 12px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px 10px;
  transition: opacity 0.15s;
}
.grid.dim {
  opacity: 0.6;
}
@media (min-width: 600px) {
  .grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
@media (min-width: 900px) {
  .home {
    max-width: 1080px;
    margin: 0 auto;
  }
  .grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}
.state {
  padding: 60px 0;
  text-align: center;
  color: var(--fg-2);
}
</style>
