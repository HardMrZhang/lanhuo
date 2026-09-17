<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../api'
import type { Category, DramaSummary } from '../types'
import CategoryTabs from '../components/CategoryTabs.vue'
import DramaCard from '../components/DramaCard.vue'

defineOptions({ name: 'Home' })

const SORTS = [
  { id: 'hot', name: '最热' },
  { id: 'new', name: '最新' },
  { id: 'rating', name: '好评' },
] as const

const categories = ref<Category[]>([])
const active = ref('all')
const sort = ref<(typeof SORTS)[number]['id']>('hot')
const keyword = ref('')
const dramas = ref<DramaSummary[]>([])
const loading = ref(false)
const error = ref('')

const allTabs = computed<Category[]>(() => [{ id: 'all', name: '全部' }, ...categories.value])
const activeName = computed(() => allTabs.value.find((c) => c.id === active.value)?.name ?? '全部')

let reqId = 0
async function load() {
  const id = ++reqId
  loading.value = true
  error.value = ''
  try {
    const list = await api.dramas({ category: active.value, q: keyword.value.trim(), sort: sort.value })
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
watch([active, sort], load)

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
    <!-- 顶栏 -->
    <header class="header">
      <div class="header-inner container">
        <router-link class="logo" to="/">
          <span class="logo-a">短</span><span class="logo-b">剧</span>
        </router-link>
        <form class="search" @submit.prevent>
          <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
              d="M10.5 3a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15zM16 16l5 5"
            />
          </svg>
          <input v-model="keyword" type="search" placeholder="搜索短剧" />
        </form>
      </div>
    </header>

    <CategoryTabs v-model="active" :categories="allTabs" />

    <main class="content container">
      <div class="section-head">
        <h2 class="section-title">{{ keyword ? `搜索「${keyword}」` : `${activeName}短剧` }}</h2>
        <div class="sorts">
          <button
            v-for="s in SORTS"
            :key="s.id"
            class="sort"
            :data-active="sort === s.id"
            @click="sort = s.id"
          >
            {{ s.name }}
          </button>
        </div>
      </div>

      <p v-if="error" class="state">加载失败：{{ error }}</p>
      <p v-else-if="!loading && dramas.length === 0" class="state">没有找到相关短剧</p>
      <div v-else class="grid" :class="{ dim: loading }">
        <DramaCard v-for="d in dramas" :key="d.id" :drama="d" />
      </div>
    </main>

    <footer class="footer">
      <div class="container">© {{ new Date().getFullYear() }} 短剧</div>
    </footer>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding-top: var(--safe-top);
  background: var(--bg);
}

/* ---------- 顶栏 ---------- */
.header {
  position: sticky;
  top: 0;
  z-index: 30;
  background: #000;
}
.header-inner {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 52px;
}
.logo {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  font-size: 20px;
  font-weight: 900;
  line-height: 1;
  white-space: nowrap;
}
.logo-a {
  color: #fff;
}
.logo-b {
  margin-left: 2px;
  padding: 3px 5px;
  border-radius: var(--radius);
  background: var(--accent);
  color: var(--accent-fg);
}
.search {
  position: relative;
  flex: 1;
  max-width: 480px;
  height: 34px;
}
.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--fg-3);
  pointer-events: none;
}
.search input {
  width: 100%;
  height: 100%;
  padding: 0 12px 0 32px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: var(--bg-2);
  color: var(--fg);
  font: inherit;
  outline: none;
  transition: border-color 0.15s, background 0.15s;
}
.search input:focus {
  background: var(--bg-3);
  border-color: var(--fg-3);
}
.search input::placeholder {
  color: var(--fg-3);
}

/* ---------- 内容 ---------- */
.content {
  flex: 1;
  padding-top: 16px;
  padding-bottom: 32px;
}
.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.section-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sorts {
  display: flex;
  gap: 14px;
  flex: 0 0 auto;
  font-size: 13px;
}
.sort {
  color: var(--fg-2);
  transition: color 0.15s;
}
.sort:hover {
  color: var(--fg);
}
.sort[data-active='true'] {
  color: var(--fg);
  font-weight: 700;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 10px;
  transition: opacity 0.15s;
}
.grid.dim {
  opacity: 0.6;
}
@media (min-width: 560px) {
  .grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (min-width: 768px) {
  .grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 20px 12px;
  }
}
@media (min-width: 960px) {
  .header-inner {
    height: 56px;
    gap: 32px;
  }
  .logo {
    font-size: 22px;
  }
  .content {
    padding-top: 20px;
  }
  .section-title {
    font-size: 18px;
  }
  .grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 22px 14px;
  }
}
@media (min-width: 1280px) {
  .grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}
@media (min-width: 1600px) {
  .grid {
    grid-template-columns: repeat(7, minmax(0, 1fr));
  }
}

.state {
  padding: 80px 0;
  text-align: center;
  color: var(--fg-2);
}

.footer {
  padding: 20px 0 calc(20px + var(--safe-bottom));
  border-top: 1px solid var(--border);
  color: var(--fg-3);
  font-size: 12px;
}
</style>
