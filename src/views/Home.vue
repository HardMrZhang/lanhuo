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
const searchOpen = ref(false)
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
    <!-- 顶栏：黑底，logo 第二个字放橙色圆角块 -->
    <header class="header">
      <router-link class="logo" to="/">
        <span class="logo-a">短</span><span class="logo-b">剧</span>
      </router-link>
      <form class="search" :class="{ open: searchOpen }" @submit.prevent>
        <input
          v-model="keyword"
          type="search"
          placeholder="搜索短剧"
          @focus="searchOpen = true"
          @blur="searchOpen = !!keyword"
        />
        <button type="button" class="search-btn" aria-label="搜索">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
              d="M10.5 3a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15zM16 16l5 5"
            />
          </svg>
        </button>
      </form>
    </header>

    <CategoryTabs v-model="active" :categories="allTabs" />

    <main class="content">
      <!-- 区块标题 + 排序 -->
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
      <span class="logo small"><span class="logo-a">短</span><span class="logo-b">剧</span></span>
      <span>© {{ new Date().getFullYear() }}</span>
    </footer>
  </div>
</template>

<style scoped>
.home {
  min-height: 100%;
  padding-top: var(--safe-top);
  padding-bottom: var(--safe-bottom);
  background: var(--bg);
}

/* ---------- 顶栏 ---------- */
.header {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 56px;
  padding: 0 12px;
  background: #000;
  border-bottom: 1px solid var(--border);
}
.logo {
  display: inline-flex;
  align-items: center;
  font-size: 22px;
  font-weight: 900;
  letter-spacing: -0.5px;
  line-height: 1;
  white-space: nowrap;
}
.logo-a {
  color: #fff;
}
.logo-b {
  margin-left: 2px;
  padding: 3px 6px;
  border-radius: 5px;
  background: var(--accent);
  color: var(--accent-fg);
}
.logo.small {
  font-size: 16px;
}
.search {
  flex: 1;
  display: flex;
  align-items: center;
  height: 36px;
  max-width: 520px;
  margin-left: auto;
  border-radius: 4px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  overflow: hidden;
  transition: border-color 0.15s;
}
.search.open {
  border-color: var(--fg-3);
}
.search input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 12px;
  border: 0;
  background: transparent;
  color: var(--fg);
  font: inherit;
  outline: none;
}
.search input::placeholder {
  color: var(--fg-3);
}
.search-btn {
  width: 44px;
  height: 100%;
  display: grid;
  place-items: center;
  background: var(--bg-3);
  color: var(--fg);
}

/* ---------- 内容 ---------- */
.content {
  padding: 12px;
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
  font-size: 18px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sorts {
  display: flex;
  gap: 4px;
  flex: 0 0 auto;
}
.sort {
  padding: 5px 10px;
  border-radius: 3px;
  font-size: 13px;
  color: var(--fg-2);
  background: var(--bg-2);
}
.sort[data-active='true'] {
  color: var(--accent-fg);
  background: var(--accent);
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
@media (min-width: 640px) {
  .grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (min-width: 960px) {
  .header {
    padding: 0 24px;
  }
  .content {
    max-width: 1280px;
    margin: 0 auto;
    padding: 16px 24px;
  }
  .grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 20px 14px;
  }
}
@media (min-width: 1400px) {
  .grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
}

.state {
  padding: 80px 0;
  text-align: center;
  color: var(--fg-2);
}

.footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 28px 12px calc(28px + var(--safe-bottom));
  border-top: 1px solid var(--border);
  color: var(--fg-3);
  font-size: 12px;
}
</style>
