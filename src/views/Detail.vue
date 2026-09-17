<script setup lang="ts">
/**
 * 剧集详情页：封面 + 简介 + 集数网格 + 相关推荐。
 * 从卡片点进来先到这里，选集后再进播放页；记住上次看到的集数。
 */
import { computed, onActivated, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import type { Drama, DramaSummary } from '../types'
import { favorites, history } from '../storage'
import DramaCard from '../components/DramaCard.vue'

const props = defineProps<{ id: string }>()
const router = useRouter()

const drama = ref<Drama | null>(null)
const related = ref<DramaSummary[]>([])
const error = ref('')
const expanded = ref(false)
const fav = ref(false)
const lastEp = ref<number | null>(null)

const total = computed(() => drama.value?.episodes.length ?? 0)
const statusText = computed(() =>
  drama.value?.status === 'completed' ? `已完结 · 共${total.value}集` : `更新中 · 更至${total.value}集`,
)

function formatViews(n?: number) {
  if (!n) return ''
  if (n >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/, '')}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, '')}万`
  return String(n)
}

function refreshLocal() {
  fav.value = favorites.has(props.id)
  lastEp.value = history.get(props.id)?.ep ?? null
}

async function load() {
  try {
    const d = await api.drama(props.id)
    drama.value = d
    refreshLocal()
    const cat = d.categoryIds[0]
    if (cat) {
      const list = await api.dramas({ category: cat, sort: 'hot' })
      related.value = list.filter((x) => x.id !== d.id).slice(0, 6)
    }
  } catch (e) {
    error.value = (e as Error).message
  }
}

onMounted(load)
onActivated(refreshLocal)

function play(ep: number) {
  router.push({ name: 'play', params: { id: props.id, ep } })
}
function playMain() {
  play(lastEp.value ?? 1)
}
function toggleFav() {
  fav.value = favorites.toggle(props.id)
}
function back() {
  if (window.history.length > 1) router.back()
  else router.push({ name: 'home' })
}
</script>

<template>
  <div class="detail">
    <header class="top">
      <div class="top-inner container">
        <button class="back" aria-label="返回" @click="back">‹</button>
        <span class="top-title">{{ drama?.title }}</span>
      </div>
    </header>

    <p v-if="error" class="state">{{ error }}</p>

    <template v-else-if="drama">
      <!-- 头图：模糊封面做底 -->
      <section class="hero">
        <div class="hero-bg" :style="{ backgroundImage: `url(${drama.cover})` }" />
        <div class="hero-inner container">
          <img class="poster" :src="drama.cover" :alt="drama.title" />
          <div class="info">
            <h1 class="title">{{ drama.title }}</h1>
            <div class="sub">
              <span>{{ statusText }}</span>
              <span v-if="drama.views" class="dot">·</span>
              <span v-if="drama.views">{{ formatViews(drama.views) }}次播放</span>
              <span v-if="drama.rating != null" class="dot">·</span>
              <span v-if="drama.rating != null">{{ drama.rating }}% 好评</span>
            </div>
            <div v-if="drama.tags?.length" class="tags">
              <span v-for="t in drama.tags" :key="t" class="tag">{{ t }}</span>
            </div>
          </div>
          <!-- 手机：整行放在封面下方；桌面：落在信息栏底部 -->
          <div class="actions">
            <button class="btn primary" @click="playMain">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path fill="currentColor" d="M8 5v14l11-7z" />
              </svg>
              {{ lastEp ? `继续观看 第${lastEp}集` : '立即播放' }}
            </button>
            <button class="btn" :data-on="fav" @click="toggleFav">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  :fill="fav ? 'currentColor' : 'none'"
                  stroke="currentColor"
                  stroke-width="2"
                  d="M12 20.5 3.8 12.6a4.6 4.6 0 0 1 6.5-6.5L12 7.8l1.7-1.7a4.6 4.6 0 0 1 6.5 6.5z"
                />
              </svg>
              {{ fav ? '已追剧' : '追剧' }}
            </button>
          </div>
        </div>
      </section>

      <main class="container">
        <!-- 简介 -->
        <section class="block">
          <h2 class="block-title">简介</h2>
          <p class="desc" :class="{ expanded }" @click="expanded = !expanded">
            {{ drama.description }}
          </p>
          <button v-if="drama.description.length > 60" class="more" @click="expanded = !expanded">
            {{ expanded ? '收起' : '展开' }}
          </button>
        </section>

        <!-- 选集 -->
        <section class="block">
          <div class="block-head">
            <h2 class="block-title">选集</h2>
            <span class="block-sub">{{ statusText }}</span>
          </div>
          <div class="eps">
            <button
              v-for="e in drama.episodes"
              :key="e.no"
              class="ep"
              :data-watched="e.no === lastEp"
              :title="e.title"
              @click="play(e.no)"
            >
              {{ e.no }}
              <i v-if="e.no === lastEp" class="ep-mark" />
            </button>
          </div>
        </section>

        <!-- 相关推荐 -->
        <section v-if="related.length" class="block">
          <h2 class="block-title">相关推荐</h2>
          <div class="grid">
            <DramaCard v-for="d in related" :key="d.id" :drama="d" />
          </div>
        </section>
      </main>
    </template>
  </div>
</template>

<style scoped>
.detail {
  min-height: 100%;
  padding-top: var(--safe-top);
  padding-bottom: calc(24px + var(--safe-bottom));
}

/* ---------- 顶栏 ---------- */
.top {
  position: sticky;
  top: 0;
  z-index: 30;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(10px);
}
.top-inner {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 48px;
}
.back {
  width: 32px;
  height: 32px;
  margin-left: -8px;
  font-size: 26px;
  line-height: 32px;
  text-align: center;
}
.top-title {
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- 头图 ---------- */
.hero {
  position: relative;
  overflow: hidden;
}
.hero-bg {
  position: absolute;
  inset: -40px;
  background-size: cover;
  background-position: center;
  filter: blur(28px) brightness(0.35);
  transform: scale(1.1);
}
/* 手机：封面 | 信息 两栏，按钮整行在下；桌面：封面跨两行，按钮落在信息栏底部 */
.hero-inner {
  position: relative;
  display: grid;
  grid-template-columns: 104px minmax(0, 1fr);
  grid-template-areas:
    'poster info'
    'actions actions';
  column-gap: 14px;
  row-gap: 16px;
  padding-top: 16px;
  padding-bottom: 18px;
}
.poster {
  grid-area: poster;
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
  border-radius: var(--radius);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
}
.info {
  grid-area: info;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.title {
  margin: 0;
  font-size: 19px;
  font-weight: 800;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sub {
  margin-top: 6px;
  font-size: 12px;
  color: var(--fg-2);
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.dot {
  color: var(--fg-3);
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.tag {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.1);
  color: var(--fg);
}
.actions {
  grid-area: actions;
  display: flex;
  gap: 10px;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 42px;
  padding: 0 16px;
  border-radius: var(--radius);
  background: rgba(255, 255, 255, 0.12);
  color: var(--fg);
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}
.btn.primary {
  flex: 1;
  background: var(--accent);
  color: var(--accent-fg);
}
.btn[data-on='true'] {
  color: var(--accent);
}

/* ---------- 内容块 ---------- */
.block {
  padding-top: 20px;
}
.block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.block-title {
  margin: 0 0 10px;
  font-size: 16px;
  font-weight: 700;
}
.block-sub {
  font-size: 12px;
  color: var(--fg-2);
}
.desc {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--fg-2);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.desc.expanded {
  -webkit-line-clamp: unset;
  display: block;
}
.more {
  margin-top: 4px;
  font-size: 13px;
  color: var(--fg-3);
}

.eps {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
}
.ep {
  position: relative;
  aspect-ratio: 1;
  border-radius: var(--radius);
  background: var(--bg-2);
  font-size: 15px;
  font-weight: 600;
  transition: background 0.15s, color 0.15s;
}
.ep:hover {
  background: var(--bg-3);
}
.ep[data-watched='true'] {
  color: var(--accent);
}
.ep-mark {
  position: absolute;
  right: 5px;
  bottom: 5px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px 10px;
}

.state {
  padding: 80px 0;
  text-align: center;
  color: var(--fg-2);
}

/* ---------- 桌面端 ---------- */
@media (min-width: 640px) {
  .eps {
    grid-template-columns: repeat(10, minmax(0, 1fr));
  }
  .grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px 12px;
  }
}
@media (min-width: 960px) {
  .top-inner {
    height: 56px;
  }
  .hero-inner {
    grid-template-columns: 200px minmax(0, 1fr);
    grid-template-areas:
      'poster info'
      'poster actions';
    align-items: end;
    column-gap: 28px;
    row-gap: 20px;
    padding-top: 32px;
    padding-bottom: 32px;
  }
  .info {
    align-self: start;
  }
  .title {
    font-size: 28px;
  }
  .sub {
    font-size: 13px;
  }
  .btn.primary {
    flex: 0 0 auto;
    padding: 0 24px;
  }
  .top-title {
    font-size: 17px;
  }
  .tag {
    font-size: 13px;
    padding: 3px 9px;
  }
  .btn {
    height: 42px;
    font-size: 16px;
  }
  .block {
    padding-top: 28px;
  }
  .block-title {
    font-size: 20px;
  }
  .block-sub {
    font-size: 14px;
  }
  .desc {
    font-size: 16px;
  }
  .more {
    font-size: 14px;
  }
  .eps {
    grid-template-columns: repeat(15, minmax(0, 1fr));
    gap: 10px;
  }
  .ep {
    font-size: 17px;
  }
  .grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 24px 14px;
  }
}
@media (min-width: 1600px) {
  .title {
    font-size: 32px;
  }
  .sub {
    font-size: 15px;
  }
  .block-title {
    font-size: 22px;
  }
  .eps {
    grid-template-columns: repeat(20, minmax(0, 1fr));
  }
  .grid {
    grid-template-columns: repeat(7, minmax(0, 1fr));
  }
}
</style>
