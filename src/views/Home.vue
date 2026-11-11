<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import { api } from '../api'
import type { Category, DramaSummary, RecommendSlot } from '../types'
import { favorites, history } from '../storage'
import { contentChannels, dramasForChannel, isHotDrama, uniqueById } from '../navigation'
import { locale, tr, translateCategory, translateMessage } from '../i18n'
import SiteHeader from '../components/SiteHeader.vue'
import SiteFooter from '../components/SiteFooter.vue'
import FeaturedCarousel from '../components/FeaturedCarousel.vue'
import DramaCard from '../components/DramaCard.vue'

defineOptions({ name: 'Home' })
const route = useRoute()
const router = useRouter()
const categories = ref<Category[]>([])
const dramas = ref<DramaSummary[]>([])
/** 后台配置的推荐位；为空时首页用默认排序规则。 */
const recommendSlots = ref<RecommendSlot[]>([])
const loading = ref(true)
const error = ref('')
const keyword = ref('')
const input = ref<HTMLInputElement | null>(null)
const localVersion = ref(0)
const page = ref(1)
// 每页条数必须能被当前网格列数整除，否则最后一行会空出一格（看起来"每页少一部"）。
// 列数随断点变化：>1024 五列 / 769-1024 四列 / 481-768 三列 / <=480 两列。
const gridColumns = ref(5)
function syncGridColumns() {
  const w = window.innerWidth
  gridColumns.value = w > 1024 ? 5 : w > 768 ? 4 : w > 480 ? 3 : 2
}
const PAGE_ROWS = 5
const pageSize = computed(() => gridColumns.value * PAGE_ROWS)
const addressCopied = ref(false)
const addressError = ref('')
const currentAddress = window.location.origin
const SORTS = computed(() => [
  { id: 'hot', name: tr('最热', 'Popular') },
  { id: 'new', name: tr('最新', 'Newest') },
  { id: 'rating', name: tr('好评', 'Top rated') },
] as const)
const searchOpen = computed(() => route.query.search === '1' || Boolean(route.query.q))
const query = computed(() => (typeof route.query.q === 'string' ? route.query.q : ''))
const sort = computed(() =>
  SORTS.value.some((s) => s.id === route.query.sort) ? String(route.query.sort) : 'hot',
)
const activeCategory = computed(() =>
  typeof route.query.category === 'string' ? route.query.category : 'all',
)
const activeChannel = computed(() =>
  typeof route.query.channel === 'string' ? route.query.channel : 'all',
)
const selectedChannel = computed(() =>
  contentChannels.find((channel) => channel.id === activeChannel.value),
)
const activeCategoryName = computed(() =>
  activeCategory.value === 'all'
    ? tr('全部短剧', 'All dramas')
    : (() => {
        const name = categories.value.find((c) => c.id === activeCategory.value)?.name ?? '精选'
        return tr(/(?:短剧|漫剧)$/.test(name) ? name : `${name}短剧`, translateCategory(name))
      })(),
)
const view = computed(() => (typeof route.query.view === 'string' ? route.query.view : ''))
const isOverview = computed(
  () =>
    !searchOpen.value &&
    activeCategory.value === 'all' &&
    activeChannel.value === 'all' &&
    !view.value,
)
const isSpecialView = computed(() => view.value === 'favorites' || view.value === 'history')
const pageTitle = computed(() =>
  query.value
    ? tr(`搜索「${query.value}」`, `Search: “${query.value}”`)
    : view.value === 'ranking'
      ? tr('热播排行榜', 'Trending')
      : view.value === 'favorites'
        ? tr('我的追剧', 'My List')
        : view.value === 'history'
          ? tr('观看记录', 'Watch History')
          : view.value === 'tags'
            ? tr('标签榜', 'Top Tags')
            : view.value === 'addresses'
              ? tr('官方地址', 'Site Address')
              : searchOpen.value
                ? tr('搜索短剧', 'Search dramas')
                : view.value === 'all'
                  ? sort.value === 'new'
                    ? tr('最新上架', 'New Releases')
                    : sort.value === 'rating'
                      ? tr('好评推荐', 'Highly Recommended')
                      : tr('全部短剧', 'All Dramas')
                  : (selectedChannel.value?.name ?? activeCategoryName.value),
)
const displayList = computed(() => {
  void localVersion.value
  let result = dramasForChannel(dramas.value, activeChannel.value)
  if (view.value === 'favorites') result = result.filter((d) => favorites.has(d.id))
  if (view.value === 'history')
    result = result
      .filter((d) => history.get(d.id))
      .sort((a, b) => (history.get(b.id)?.updatedAt ?? 0) - (history.get(a.id)?.updatedAt ?? 0))
  return result
})
/**
 * 按后台配置的推荐位挑选剧。
 *
 * 后台没配（或配置为空）时返回 null，调用方回落到默认排序逻辑。
 */
function dramasFromSlot(slot: RecommendSlot | undefined, pool: DramaSummary[]): DramaSummary[] | null {
  if (!slot?.items?.length) return null
  const byId = new Map(pool.map((drama) => [drama.id, drama]))
  const picked: DramaSummary[] = []
  for (const item of slot.items) {
    const drama = byId.get(item.dramaId)
    if (drama && !picked.some((entry) => entry.id === drama.id)) picked.push(drama)
  }
  return picked.length ? picked : null
}

/** 首页只上带 🔥 的热门剧（见 navigation.isHotDrama），重复的不再出现。 */
const isHot = isHotDrama
const featured = computed(() => {
  // 后台推荐位优先：配置了就按配置来，没配置才用默认规则。
  const configured = dramasFromSlot(recommendSlots.value.find((slot) => slot.key === 'home_featured'), dramas.value)
  if (configured) return configured.slice(0, 7)
  // 轮播：新下载的欧美多集剧 + 必须是热门（带 🔥），集数多优先，其次播放量、上架时间。
  return uniqueById(
    dramas.value
      .filter((drama) => drama.episodeCount > 0 && drama.channelId === 'western' && isHot(drama))
      .sort(
        (a, b) =>
          b.episodeCount - a.episodeCount ||
          (b.views ?? 0) - (a.views ?? 0) ||
          (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''),
      ),
  ).slice(0, 7)
})
/** 已在轮播出现过的剧，后面分区不再重复出现。 */
const featuredIds = computed(() => new Set(featured.value.map((d) => d.id)))
const ranking = computed(() => {
  const configured = dramasFromSlot(recommendSlots.value.find((slot) => slot.key === 'home_ranking'), dramas.value)
  if (configured) return configured.filter((d) => !featuredIds.value.has(d.id)).slice(0, 15)
  return uniqueById(
    [...dramas.value]
      .filter((d) => isHot(d) && !featuredIds.value.has(d.id))
      .sort((a, b) => (b.views ?? 0) - (a.views ?? 0)),
  ).slice(0, 15)
})
const rankingIds = computed(() => new Set([...featuredIds.value, ...ranking.value.map((d) => d.id)]))
const latest = computed(() => {
  const configured = dramasFromSlot(recommendSlots.value.find((slot) => slot.key === 'home_latest'), dramas.value)
  if (configured) return configured.filter((d) => !rankingIds.value.has(d.id)).slice(0, 15)
  return uniqueById(
    [...dramas.value]
      .filter((d) => isHot(d) && !rankingIds.value.has(d.id))
      .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')),
  ).slice(0, 15)
})
const latestIds = computed(() => new Set([...rankingIds.value, ...latest.value.map((d) => d.id)]))
const topRated = computed(() => {
  const configured = dramasFromSlot(recommendSlots.value.find((slot) => slot.key === 'home_top_rated'), dramas.value)
  if (configured) return configured.filter((d) => !latestIds.value.has(d.id)).slice(0, 15)
  return uniqueById(
    [...dramas.value]
      .filter((d) => isHot(d) && !latestIds.value.has(d.id))
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)),
  ).slice(0, 15)
})
const homeShownIds = computed(
  () =>
    new Set([
      ...featured.value.map((d) => d.id),
      ...ranking.value.map((d) => d.id),
      ...latest.value.map((d) => d.id),
      ...topRated.value.map((d) => d.id),
    ]),
)
const categorySections = computed(() => {
  const taken = new Set(homeShownIds.value)
  return contentChannels
    .filter((channel) => channel.available)
    .slice(0, 4)
    .map((channel) => {
      const list = uniqueById(
        dramasForChannel(dramas.value, channel.id).filter((d) => isHot(d) && !taken.has(d.id)),
      ).slice(0, 15)
      for (const d of list) taken.add(d.id)
      return { channel, dramas: list }
    })
    .filter((section) => section.dramas.length)
})

function scrollRow(event: MouseEvent, direction: -1 | 1) {
  const wrap = (event.currentTarget as HTMLElement).closest('.row-wrap')
  const row = wrap?.querySelector<HTMLElement>('.drama-row')
  if (!row) return
  const step = row.firstElementChild instanceof HTMLElement ? row.firstElementChild.offsetWidth + 12 : 240
  row.scrollBy({ left: step * direction * 3, behavior: 'smooth' })
}
const rankedTags = computed(() => {
  const counts = new Map<string, number>()
  for (const drama of dramas.value) {
    for (const tag of new Set(drama.tags ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
})
const unavailableType = computed(() =>
  activeChannel.value === 'novels' ? tr('小说', 'novels') : '',
)
const totalPages = computed(() => Math.ceil(displayList.value.length / pageSize.value))
const pagedDramas = computed(() =>
  displayList.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
)
watch(totalPages, (pages) => {
  page.value = Math.min(page.value, Math.max(1, pages))
})
// 列数变化（缩放窗口）会改变每页条数，回到第一页避免出现空白页。
watch(gridColumns, () => {
  page.value = 1
})
let requestId = 0
let loadedQuery = ''
async function load() {
  const id = ++requestId
  loading.value = true
  error.value = ''
  try {
    const [list, cats, slots] = await Promise.all([
      api.dramas({
        category: activeCategory.value,
        q: query.value,
        sort: view.value === 'ranking' ? 'hot' : sort.value,
      }),
      categories.value.length ? Promise.resolve(categories.value) : api.categories(),
      recommendSlots.value.length ? Promise.resolve(recommendSlots.value) : api.recommendSlots(),
    ])
    if (id === requestId) {
      dramas.value = list
      categories.value = cats
      recommendSlots.value = slots
    }
  } catch (e) {
    if (id === requestId) error.value = e instanceof Error ? e.message : '加载失败，请稍后重试'
  } finally {
    if (id === requestId) loading.value = false
  }
}
function applySearch() {
  const q = keyword.value.trim()
  router.push({ name: 'home', query: q ? { q, search: '1' } : { search: '1' } })
}
function clearSearch() {
  keyword.value = ''
  applySearch()
  nextTick(() => input.value?.focus())
}
function changeSort(next: string) {
  router.replace({ name: 'home', query: { ...route.query, sort: next } })
}
function channelQuery(channel: string): LocationQueryRaw {
  return {
    ...route.query,
    view: view.value === 'ranking' ? 'ranking' : 'all',
    category: undefined,
    channel: channel === 'all' ? undefined : channel,
  }
}
async function copyAddress() {
  addressCopied.value = false
  addressError.value = ''
  try {
    await navigator.clipboard.writeText(currentAddress)
    addressCopied.value = true
  } catch {
    addressError.value = '复制失败，请选中上方地址后手动复制。'
  }
}
function goPage(next: number) {
  page.value = next
  document.getElementById('catalog-heading')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
watch(
  [pageTitle, isOverview, locale, () => route.name],
  () => {
    if (route.name !== 'home') return
    document.title = `${isOverview.value ? tr('精品故事', 'Featured stories') : pageTitle.value} · ${tr('短剧剧场', 'Drama Theater')}`
  },
  { immediate: true },
)
watch(
  () => route.fullPath,
  async () => {
    if (route.name !== 'home') return
    keyword.value = query.value
    const queryKey = JSON.stringify(route.query)
    if (queryKey !== loadedQuery) {
      loadedQuery = queryKey
      page.value = 1
      await load()
    }
    if (searchOpen.value) nextTick(() => input.value?.focus())
  },
  { immediate: true },
)
onActivated(() => {
  localVersion.value++
})
syncGridColumns()
onMounted(() => {
  syncGridColumns()
  window.addEventListener('resize', syncGridColumns)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', syncGridColumns)
})
</script>

<template>
  <div class="home-page">
    <SiteHeader />
    <main class="container">
      <section v-if="isOverview" class="home-intro">
        <div class="intro-copy">
          <h1>{{ tr('成人短剧 · 欧美短剧 · 真人剧', 'Adult dramas · Western shorts · Live action') }} <span>{{ tr('免费在线观看', 'Watch free online') }}</span></h1>
          <p>
            {{ tr('汇聚都市、甜宠、古装、悬疑与欧美短剧等精选内容，发现热门剧集与精品故事，竖屏横屏随心切换，手机电脑高清畅享。', 'Discover modern romance, historical tales, mysteries and western shorts. Enjoy popular series and memorable stories in HD on your phone or computer.') }}
          </p>
        </div>
      </section>      <section v-else class="browse-head">
        <nav class="breadcrumb" :aria-label="tr('面包屑', 'Breadcrumb')">
          <router-link to="/">{{ tr('首页', 'Home') }}</router-link><span>›</span><span>{{ pageTitle }}</span>
        </nav>
        <h1>{{ pageTitle }}</h1>
        <p>
          {{
            view === 'favorites'
              ? tr('收藏喜欢的剧集，把想看的故事留在这里。', 'Save your favorite dramas and the stories you want to watch.')
              : view === 'history'
                ? tr('接着上次的故事，继续你的精彩时刻。', 'Pick up where you left off and enjoy the next chapter.')
                : view === 'ranking'
                  ? tr('发现大家都在追的好剧，按播放热度为你呈现。', 'Discover what everyone is watching, ranked by popularity.')
                  : view === 'tags'
                    ? tr('按收录剧集数量排列，点击标签发现相关故事。', 'Explore tags ranked by the number of dramas in the collection.')
                    : view === 'addresses'
                      ? tr('收藏当前访问地址，随时回来发现精彩故事。', 'Bookmark this address and come back for more great stories.')
                      : tr('好故事不止一种。挑选喜欢的题材，发现你的下一部好剧。', 'Explore your favorite genres and discover your next great drama.')
          }}
        </p>
      </section>
      <form v-if="searchOpen" class="intro-search open" role="search" @submit.prevent="applySearch">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 5 5" />
        </svg>
        <input
          ref="input"
          v-model="keyword"
          type="search"
          :placeholder="tr('搜索剧名、剧情或标签', 'Search titles, stories or tags')"
          :aria-label="tr('搜索剧名、剧情或标签', 'Search titles, stories or tags')"
        />
        <button v-if="keyword" type="button" :aria-label="tr('清空搜索', 'Clear search')" @click="clearSearch">×</button>
        <button class="submit" type="submit">{{ tr('搜索', 'Search') }}</button>
      </form>
      <div v-if="error" class="error-banner" role="alert">
        {{ tr('加载失败：', 'Unable to load: ') }}{{ translateMessage(error) }} <button @click="load">{{ tr('重试', 'Retry') }}</button>
      </div>
      <template v-else-if="!loading">
        <template v-if="isOverview">
          <section v-if="featured.length" class="hero-section">
            <FeaturedCarousel :dramas="featured" />
          </section>
          <section v-if="ranking.length" class="home-section">
            <div class="section-head">
              <h2 class="section-heading">{{ tr('正在热播', 'Trending Now') }}</h2>
            </div>
            <div class="row-wrap">
              <button class="row-arrow prev" :aria-label="tr('向左滚动', 'Scroll left')" @click="scrollRow($event, -1)">‹</button>
              <div class="drama-row">
                <DramaCard v-for="drama in ranking" :key="drama.id" :drama="drama" />
              </div>
              <button class="row-arrow next" :aria-label="tr('向右滚动', 'Scroll right')" @click="scrollRow($event, 1)">›</button>
            </div>
          </section>
          <section v-if="latest.length" class="home-section">
            <div class="section-head">
              <h2 class="section-heading">{{ tr('最新上架', 'New Releases') }}</h2>
              <router-link class="section-more" :to="{ path: '/', query: { view: 'all', sort: 'new' } }"
                >{{ tr('更多', 'View all') }} <span>›</span></router-link
              >
            </div>
            <div class="row-wrap">
              <button class="row-arrow prev" :aria-label="tr('向左滚动', 'Scroll left')" @click="scrollRow($event, -1)">‹</button>
              <div class="drama-row">
                <DramaCard v-for="drama in latest" :key="drama.id" :drama="drama" />
              </div>
              <button class="row-arrow next" :aria-label="tr('向右滚动', 'Scroll right')" @click="scrollRow($event, 1)">›</button>
            </div>
          </section>
          <section v-if="topRated.length" class="home-section">
            <div class="section-head">
              <h2 class="section-heading">{{ tr('好评推荐', 'Highly Recommended') }}</h2>
              <router-link class="section-more" :to="{ path: '/', query: { view: 'all', sort: 'rating' } }"
                >{{ tr('更多', 'View all') }} <span>›</span></router-link
              >
            </div>
            <div class="row-wrap">
              <button class="row-arrow prev" :aria-label="tr('向左滚动', 'Scroll left')" @click="scrollRow($event, -1)">‹</button>
              <div class="drama-row">
                <DramaCard v-for="drama in topRated" :key="drama.id" :drama="drama" />
              </div>
              <button class="row-arrow next" :aria-label="tr('向右滚动', 'Scroll right')" @click="scrollRow($event, 1)">›</button>
            </div>
          </section>
          <section
            v-for="section in categorySections"
            :key="section.channel.id"
            class="home-section category-section"
          >
            <div class="section-head">
              <h2 class="section-heading">{{ section.channel.name }}</h2>
              <router-link
                class="section-more"
                :to="{ path: '/', query: { channel: section.channel.id } }"
                >{{ tr('更多', 'View all') }} <span>›</span></router-link
              >
            </div>
            <div class="row-wrap">
              <button class="row-arrow prev" :aria-label="tr('向左滚动', 'Scroll left')" @click="scrollRow($event, -1)">‹</button>
              <div class="drama-row">
                <DramaCard v-for="drama in section.dramas" :key="drama.id" :drama="drama" />
              </div>
              <button class="row-arrow next" :aria-label="tr('向右滚动', 'Scroll right')" @click="scrollRow($event, 1)">›</button>
            </div>
          </section>
          <div v-if="!dramas.length" class="empty-state">
            <h2>{{ tr('剧集准备中', 'Dramas coming soon') }}</h2>
            <p>{{ tr('精彩故事，即将登场。', 'More great stories are on the way.') }}</p>
          </div>
        </template>
        <section v-else-if="view === 'tags'" class="home-section">
          <div class="section-head">
            <h2 class="section-heading">
              {{ tr('热门标签', 'Popular tags') }}<small>{{ tr(`${rankedTags.length} 个`, `${rankedTags.length} tags`) }}</small>
            </h2>
          </div>
          <div v-if="rankedTags.length" class="tag-ranking">
            <router-link
              v-for="(tag, index) in rankedTags"
              :key="tag.name"
              :to="{ path: '/', query: { q: tag.name, search: '1' } }"
            >
              <span class="tag-rank" :class="{ leading: index < 3 }">{{ index + 1 }}</span>
              <strong>{{ tag.name }}</strong>
              <small>{{ tr(`${tag.count} 部`, `${tag.count} ${tag.count === 1 ? 'drama' : 'dramas'}`) }}</small>
            </router-link>
          </div>
          <div v-else class="empty-state">
            <h2>{{ tr('暂无标签', 'No tags yet') }}</h2>
            <p>{{ tr('剧集标签整理中。', 'We are organizing the drama tags.') }}</p>
          </div>
        </section>
        <section v-else-if="view === 'addresses'" class="home-section">
          <div class="address-card">
            <h2 class="section-heading">{{ tr('当前访问地址', 'Current address') }}</h2>
            <a :href="currentAddress" class="current-address">{{ currentAddress }}</a>
            <button class="button-primary" @click="copyAddress">
              {{ addressCopied ? tr('已复制地址', 'Address copied') : tr('复制地址', 'Copy address') }}
            </button>
            <p v-if="addressCopied" class="address-status" role="status">
              {{ tr('地址已复制，可保存到你的书签。', 'Address copied. Save it to your bookmarks.') }}
            </p>
            <p v-if="addressError" class="address-status" role="alert">{{ translateMessage(addressError) }}</p>
          </div>
        </section>
        <section v-else class="home-section catalog-section">
          <nav v-if="!isSpecialView" class="category-filters" :aria-label="tr('剧集分类', 'Drama categories')">
            <router-link
              :to="{ path: '/', query: channelQuery('all') }"
              :class="{ active: activeChannel === 'all' && activeCategory === 'all' }"
              >{{ tr('全部', 'All') }}</router-link
            >
            <router-link
              v-for="channel in contentChannels.filter((c) => c.available)"
              :key="channel.id"
              :to="{ path: '/', query: channelQuery(channel.id) }"
              :class="{ active: activeChannel === channel.id }"
              >{{ channel.name }}</router-link
            >
          </nav>
          <div id="catalog-heading" class="section-head">
            <h2 class="section-heading">
              {{
                isSpecialView
                  ? tr('我的剧集', 'My dramas')
                  : query
                    ? tr('搜索结果', 'Search results')
                    : unavailableType
                      ? tr(`${unavailableType}列表`, 'Novels')
                      : tr('剧集列表', 'Dramas')
              }}<small>{{ tr(`${displayList.length} 部`, `${displayList.length} titles`) }}</small>
            </h2>
            <div v-if="!isSpecialView && view !== 'ranking'" class="sorts">
              <button
                v-for="item in SORTS"
                :key="item.id"
                :class="{ active: sort === item.id }"
                :aria-pressed="sort === item.id"
                @click="changeSort(item.id)"
              >
                {{ item.name }}
              </button>
            </div>
          </div>
          <div v-if="displayList.length" class="drama-grid">
            <DramaCard
              v-for="(drama, i) in pagedDramas"
              :key="drama.id"
              :drama="drama"
              :rank="view === 'ranking' ? (page - 1) * pageSize + i + 1 : undefined"
            />
          </div>
          <div v-else class="empty-state">
            <h2>
              {{
                unavailableType
                  ? tr(`暂无${unavailableType}`, `No ${unavailableType} yet`)
                  : isSpecialView
                    ? tr('这里还没有剧集', 'No dramas here yet')
                    : tr('没有找到相关短剧', 'No matching dramas found')
              }}
            </h2>
            <p>
              {{
                unavailableType
                  ? tr(`${unavailableType}内容准备中，先去其他分类看看吧。`, 'New titles are coming soon. Explore another category for now.')
                  : isSpecialView
                    ? tr('去首页发现一部喜欢的故事吧。', 'Visit the homepage to find a story you will love.')
                    : tr('试试更换关键词或分类。', 'Try a different keyword or category.')
              }}
            </p>
            <router-link class="button-primary" to="/">{{ tr('发现好剧', 'Discover dramas') }}</router-link>
          </div>
          <nav v-if="totalPages > 1" class="pagination" :aria-label="tr('分页', 'Pagination')">
            <button :disabled="page === 1" :aria-label="tr('上一页', 'Previous page')" @click="goPage(page - 1)">‹</button>
            <button
              v-for="number in totalPages"
              :key="number"
              :class="{ active: page === number }"
              :aria-current="page === number ? 'page' : undefined"
              @click="goPage(number)"
            >
              {{ number }}
            </button>
            <button :disabled="page === totalPages" :aria-label="tr('下一页', 'Next page')" @click="goPage(page + 1)">
              ›
            </button>
          </nav>
        </section>
      </template>
      <div v-else class="loading-state" role="status">
        <span class="loading-spinner" />{{ tr('正在加载精彩内容…', 'Loading stories…') }}
      </div>
    </main>
    <SiteFooter />
  </div>
</template>
<style scoped>
.home-page {
  min-height: 100vh;
}
.home-page :deep(main.container),
main.container {
  padding-top: 88px;
  padding-bottom: 40px;
}
.home-intro {
  padding: 28px 0 4px;
}
.home-intro h1 {
  font-size: 26px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -0.2px;
}
.home-intro h1 span {
  color: var(--accent);
}
.home-intro p {
  margin-top: 8px;
  color: var(--fg-2);
  font-size: 14px;
  line-height: 1.7;
}
.hero-section {
  padding-top: 8px;
  padding-bottom: 32px;
}
.intro-search {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 0 1 320px;
  min-width: 250px;
  height: 44px;
  padding: 0 12px 0 14px;
  background: #1f1f1f;
  border: 1px solid var(--border);
  border-radius: 22px;
  transition: border-color 0.2s;
}
.intro-search:focus-within {
  border-color: var(--accent);
}
.intro-search svg {
  width: 17px;
  height: 17px;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  color: var(--fg-3);
}
.intro-search input {
  min-width: 0;
  flex: 1;
  color: var(--fg);
  background: transparent;
  border: 0;
  outline: 0;
  font-size: 14px;
}
.intro-search input::placeholder {
  color: var(--fg-3);
}
.intro-search > button:not(.submit) {
  color: var(--fg-3);
  font-size: 20px;
}
.intro-search .submit {
  padding: 7px 14px;
  border-radius: 15px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}
.home-section {
  padding: 0 0 40px;
}
.section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 16px;
}
.section-more {
  flex-shrink: 0;
  color: var(--fg-2);
  font-size: 14px;
  transition: color 0.15s;
}
.section-more:hover {
  color: var(--accent);
}
.section-more span {
  margin-left: 2px;
}
.tag-ranking {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.tag-ranking a {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  border-radius: var(--radius);
  background: var(--bg-2);
}
.tag-ranking a:hover {
  background: var(--bg-3);
}
.tag-rank {
  color: var(--fg-3);
  font-size: 17px;
  min-width: 22px;
  font-weight: 700;
}
.tag-rank.leading {
  color: var(--accent);
}
.tag-ranking strong {
  flex: 1;
  font-weight: 500;
}
.tag-ranking small {
  color: var(--fg-3);
  white-space: nowrap;
}
.address-card {
  padding: 26px;
  border-radius: var(--radius);
  background: var(--bg-2);
}
.current-address {
  display: block;
  width: fit-content;
  max-width: 100%;
  overflow-wrap: anywhere;
  margin: 20px 0;
  color: var(--accent);
  font-size: 18px;
}
.address-status {
  color: var(--fg-2);
  margin-top: 14px;
}
.sorts {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
}
.sorts button {
  color: var(--fg-2);
  font-size: 14px;
}
.sorts button.active,
.sorts button:hover {
  color: var(--accent);
  font-weight: 600;
}
.error-banner {
  margin-top: 20px;
  padding: 12px 16px;
  color: var(--accent-fg-soft);
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  border-radius: var(--radius);
}
.error-banner button {
  margin-left: 10px;
  color: #fff;
  text-decoration: underline;
}
.loading-state {
  display: flex;
  min-height: 300px;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--fg-2);
}
.loading-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid rgba(255, 255, 255, 0.16);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 768px) {
  .tag-ranking {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .home-page :deep(main.container),
  main.container {
    padding-top: 70px;
  }
  .home-intro {
    padding-top: 16px;
  }
  .home-intro h1 {
    font-size: 19px;
  }
  .home-intro p {
    font-size: 13px;
  }
  .home-section {
    padding-bottom: 26px;
  }
  .section-head {
    margin-bottom: 12px;
  }
  .sorts {
    gap: 12px;
  }
}
@media (max-width: 480px) {
  .tag-ranking {
    grid-template-columns: 1fr;
  }
  .intro-search {
    min-width: 0;
  }
}
.browse-head {
  padding: 18px 0 4px;
}
.breadcrumb {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
  color: var(--fg-3);
  margin-bottom: 14px;
}
.breadcrumb a:hover {
  color: var(--accent);
}
.browse-head h1 {
  font-size: 28px;
  line-height: 1.3;
  font-weight: 600;
  margin-bottom: 10px;
}
.browse-head p {
  color: var(--fg-2);
  font-size: 14px;
}
.intro-search.open {
  width: 100%;
  max-width: 620px;
  margin-top: 20px;
}
.category-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 22px;
}
.category-filters a {
  padding: 7px 16px;
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--fg-2);
  font-size: 14px;
}
.category-filters a.active,
.category-filters a:hover {
  background: var(--accent);
  color: #fff;
}
#catalog-heading {
  scroll-margin-top: 90px;
}
.pagination {
  display: flex;
  gap: 8px;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 32px;
}
.pagination button {
  min-width: 38px;
  height: 38px;
  padding-inline: 12px;
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--fg-2);
  font-size: 14px;
}
.pagination button.active {
  background: var(--accent);
  color: #fff;
}
@media (max-width: 768px) {
  .browse-head h1 {
    font-size: 22px;
  }
  .category-filters a {
    padding: 6px 13px;
    font-size: 13px;
  }
}
</style>
