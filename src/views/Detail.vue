<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { locale, tr, translateCategory } from '../i18n'
import type { Category, Drama, DramaSummary, Episode } from '../types'
import { favorites, history } from '../storage'
import { account, refreshAccount } from '../account'
import { isPaidEpisode } from '../access'
import DramaCard from '../components/DramaCard.vue'
import CoverImage from '../components/CoverImage.vue'
import SiteHeader from '../components/SiteHeader.vue'
import SiteFooter from '../components/SiteFooter.vue'

const props = defineProps<{ id: string }>()
const router = useRouter()
const drama = ref<Drama | null>(null)
const related = ref<DramaSummary[]>([])
const categories = ref<Category[]>([])
const loading = ref(true)
const error = ref<'' | 'not-found' | 'load-failed'>('')
const errorText = computed(() => error.value === 'not-found'
  ? tr('这部剧集暂时无法找到，去首页发现更多精彩故事。', 'This series could not be found. Discover more stories on the home page.')
  : tr('剧集加载失败，请检查网络后重试。', 'Unable to load this series. Check your connection and try again.'))
const expanded = ref(false)
const fav = ref(false)
const lastEp = ref<number | null>(null)
const episodeGroup = ref(0)
const paywallEpisode = ref<number | null>(null)
const vipActive = computed(() => account.user?.vipActive === true)
const isLocked = (no: number | null | undefined) =>
  typeof no === 'number' && isPaidEpisode(no) && !vipActive.value
const shareFeedback = ref<'' | 'copied' | 'failed'>('')
const shareFeedbackText = computed(() => shareFeedback.value === 'copied'
  ? tr('链接已复制', 'Link copied')
  : tr('复制失败，请手动复制浏览器地址', 'Could not copy. Copy the link from your browser’s address bar.'))
let request = 0
let shareTimer: ReturnType<typeof setTimeout> | undefined

const total = computed(() => drama.value?.episodes.length ?? 0)
const latestEpisode = computed(() =>
  drama.value?.episodes.reduce((latest, episode) => Math.max(latest, episode.no), 0) ?? 0,
)
const statusText = computed(() =>
  !total.value
    ? tr('待更新 · 暂无可播放剧集', 'Coming soon · No episodes available')
    : drama.value?.status === 'completed'
      ? tr(`已完结 · 共${total.value}集`, `Completed · ${total.value} episodes`)
      : tr(`更新中 · 更至${latestEpisode.value}集`, `Ongoing · Updated to episode ${latestEpisode.value}`),
)
const episodeGroups = computed<Episode[][]>(() => {
  const episodes = drama.value?.episodes ?? []
  const groups: Episode[][] = []
  for (let i = 0; i < episodes.length; i += 20)
    groups.push(episodes.slice(i, i + 20))
  return groups
})
const visibleEpisodes = computed(
  () => episodeGroups.value[episodeGroup.value] ?? [],
)
const dramaCategories = computed(() =>
  categories.value.filter((category) =>
    drama.value?.categoryIds.includes(category.id),
  ),
)
const hasLongDescription = computed(
  () => (drama.value?.description.length ?? 0) > 90,
)
const nextEpisode = computed(() => {
  const episodes = drama.value?.episodes ?? []
  return episodes.find((ep) => ep.no === lastEp.value)?.no ?? episodes[0]?.no
})

watchEffect(() => {
  document.title = `${drama.value?.title || tr('剧集详情', 'Series details')} · ${tr('短剧剧场', 'Drama Theater')}`
})

function formatViews(n: number) {
  if (locale.value === 'en') {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
    if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`
    return String(n)
  }
  if (n >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/, '')}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, '')}万`
  return String(n)
}

function refreshLocal() {
  fav.value = favorites.has(props.id)
  lastEp.value = history.get(props.id)?.ep ?? null
}

async function load() {
  const currentRequest = ++request
  loading.value = true
  error.value = ''
  drama.value = null
  related.value = []
  episodeGroup.value = 0
  expanded.value = false
  shareFeedback.value = ''
  refreshLocal()
  try {
    const [detail, categoryList] = await Promise.all([
      api.drama(props.id),
      api.categories().catch(() => []),
    ])
    if (currentRequest !== request) return
    drama.value = detail
    categories.value = categoryList
    refreshLocal()
    loading.value = false
    const lastIndex = detail.episodes.findIndex((ep) => ep.no === lastEp.value)
    if (lastIndex >= 0) episodeGroup.value = Math.floor(lastIndex / 20)
    const category = detail.categoryIds[0]
    if (category) {
      try {
        const list = await api.dramas({ category, sort: 'hot' })
        if (currentRequest === request)
          related.value = list
            .filter((item) => item.id !== detail.id)
            .slice(0, 6)
      } catch {
        // A failed recommendation request should not hide an available drama.
      }
    }
  } catch (cause) {
    if (currentRequest !== request) return
    error.value =
      cause instanceof Error && cause.message.startsWith('404')
        ? 'not-found'
        : 'load-failed'
  } finally {
    if (currentRequest === request) loading.value = false
  }
}

watch(() => props.id, load, { immediate: true })
onActivated(refreshLocal)
onMounted(() => { void refreshAccount() })
onBeforeUnmount(() => {
  request++
  clearTimeout(shareTimer)
})

function play(ep: number) {
  if (isLocked(ep)) {
    paywallEpisode.value = ep
    return
  }
  router.push({ name: 'play', params: { id: props.id, ep } })
}
function goVip() {
  paywallEpisode.value = null
  router.push({ name: 'vip' })
}
function playMain() {
  if (nextEpisode.value != null) play(nextEpisode.value)
}
function toggleFav() {
  fav.value = favorites.toggle(props.id)
}
async function share() {
  clearTimeout(shareTimer)
  try {
    await navigator.clipboard.writeText(window.location.href)
    shareFeedback.value = 'copied'
  } catch {
    shareFeedback.value = 'failed'
  }
  shareTimer = setTimeout(() => {
    shareFeedback.value = ''
  }, 3000)
}
</script>

<template>
  <div class="detail-page">
    <SiteHeader />
    <main class="container page-main">
      <nav class="breadcrumb" :aria-label="tr('当前位置', 'Breadcrumb')">
        <RouterLink to="/">{{ tr('首页', 'Home') }}</RouterLink>
        <span aria-hidden="true">/</span>
        <span>{{ tr('剧集详情', 'Series details') }}</span>
        <template v-if="drama"
          ><span aria-hidden="true">/</span
          ><strong>{{ drama.title }}</strong></template
        >
      </nav>
      <div v-if="loading" class="state" role="status">
        <span class="spinner" aria-hidden="true" /> {{ tr('正在加载剧集…', 'Loading series…') }}
      </div>
      <section v-else-if="error" class="state state-error" role="alert">
        <p>{{ errorText }}</p>
        <button
          class="button-secondary state-retry"
          type="button"
          @click="load"
        >
          {{ tr('重新加载', 'Try again') }}
        </button>
        <RouterLink class="back-link" to="/">{{ tr('返回首页', 'Back to home') }}</RouterLink>
      </section>
      <template v-else-if="drama">
        <h1 class="detail-title">{{ drama.title }}</h1>
        <section class="detail-layout" :aria-label="tr('剧集信息', 'Series information')">
          <div class="d-poster">
            <CoverImage :src="drama.cover" :alt="tr(`${drama.title} 海报`, `${drama.title} poster`)" />
            <span v-if="drama.hd" class="poster-badge">HD</span>
          </div>
          <div class="d-info">
            <section
              class="video-intro"
              :class="{ 'is-open': expanded }"
              aria-labelledby="intro-heading"
            >
              <h2 id="intro-heading" class="section-heading">{{ tr('剧集介绍', 'About this series') }}</h2>
              <p
                id="drama-description"
                class="vi-text"
                :class="{ clamp: !expanded && hasLongDescription }"
              >
                {{ drama.description || tr('暂无剧集介绍', 'No description available') }}
              </p>
              <button
                v-if="hasLongDescription"
                class="vi-toggle"
                type="button"
                :aria-expanded="expanded"
                aria-controls="drama-description"
                @click="expanded = !expanded"
              >
                {{ expanded ? tr('收起', 'Show less') : tr('展开', 'Read more') }}
              </button>
            </section>
            <div class="d-meta">
              <span class="meta-status">{{ statusText }}</span>
              <span v-if="drama.hd">{{ tr('高清短剧', 'HD series') }}</span>
            </div>
            <dl class="work-meta">
              <div v-if="dramaCategories.length" class="category-meta">
                <dt>{{ tr('分类', 'Genres') }}</dt>
                <dd>
                  <RouterLink
                    v-for="category in dramaCategories"
                    :key="category.id"
                    :to="{ name: 'home', query: { category: category.id } }"
                    >{{ translateCategory(category.name) }}</RouterLink
                  >
                </dd>
              </div>
              <div>
                <dt>{{ tr('集数', 'Episodes') }}</dt>
                <dd>{{ total ? tr(`${total} 集`, `${total} episodes`) : tr('待更新', 'Coming soon') }}</dd>
              </div>
              <div>
                <dt>{{ tr('状态', 'Status') }}</dt>
                <dd>
                  {{ !total ? tr('待更新', 'Coming soon') : drama.status === 'completed' ? tr('已完结', 'Completed') : tr('更新中', 'Ongoing') }}
                </dd>
              </div>
              <div v-if="drama.views != null">
                <dt>{{ tr('播放', 'Views') }}</dt>
                <dd>{{ formatViews(drama.views) }}{{ tr('次', '') }}</dd>
              </div>
              <div v-if="drama.publishedAt">
                <dt>{{ tr('上线', 'Released') }}</dt>
                <dd>{{ drama.publishedAt.slice(0, 10) }}</dd>
              </div>
            </dl>
            <div v-if="drama.rating != null" class="rating-block">
              <h2 class="d-sub">{{ tr('好评率', 'Approval rating') }}</h2>
              <div class="d-rating">
                <span class="stars" aria-hidden="true"
                  ><i
                    :style="{
                      width: `${Math.min(100, Math.max(0, drama.rating))}%`,
                    }"
                /></span>
                <strong class="rv">{{ drama.rating }}%</strong>
              </div>
            </div>
            <div v-if="drama.tags?.length" class="tag-block">
              <h2 class="d-sub">{{ tr('标签', 'Tags') }}</h2>
              <div class="d-tags">
                <span v-for="tag in drama.tags" :key="tag">{{ tag }}</span>
              </div>
            </div>
            <div class="d-actions">
              <button
                class="button-primary"
                type="button"
                :disabled="!total"
                @click="playMain"
              >
                <svg
                  v-if="total"
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  aria-hidden="true"
                >
                  <path fill="currentColor" d="M8 5v14l11-7z" />
                </svg>
                {{
                  !total
                    ? tr('待更新', 'Coming soon')
                    : lastEp === nextEpisode
                      ? tr(`继续观看 第${nextEpisode}集`, `Resume episode ${nextEpisode}`)
                      : tr('立即播放', 'Watch now')
                }}
              </button>
              <button
                class="button-secondary"
                type="button"
                :aria-pressed="fav"
                @click="toggleFav"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="17"
                  height="17"
                  aria-hidden="true"
                >
                  <path
                    :fill="fav ? 'currentColor' : 'none'"
                    stroke="currentColor"
                    stroke-width="1.8"
                    d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"
                  />
                </svg>
                {{ fav ? tr('已收藏', 'Saved') : tr('收藏', 'Save') }}
              </button>
              <button class="button-secondary" type="button" @click="share">
                <svg
                  viewBox="0 0 24 24"
                  width="17"
                  height="17"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                >
                  <path d="M8 12a9 9 0 0 1 9-7V2l5 5-5 5V9c-4 0-6 1-9 3Z" />
                  <path d="M6 5H3v16h16v-7" /></svg
                >{{ tr('分享', 'Share') }}
              </button>
              <span v-if="shareFeedback" class="share-feedback" role="status">{{
                shareFeedbackText
              }}</span>
            </div>
          </div>
        </section>
        <section
          class="ep-panel content-section"
          aria-labelledby="episode-heading"
        >
          <div class="section-heading-row">
            <h2 id="episode-heading" class="section-heading">{{ tr('选集', 'Episodes') }}</h2>
            <span class="section-muted">{{ statusText }}</span>
          </div>
          <p v-if="!vipActive && total > 1" class="paywall-note">
            {{ tr('第 1 集免费观看，第 2 集起为 VIP 专享。', 'Episode 1 is free. Episode 2 onward is for VIP members.') }}
            <RouterLink to="/vip">{{ tr('开通会员', 'Join VIP') }}</RouterLink>
          </p>
          <div
            v-if="episodeGroups.length > 1"
            class="ep-tabs"
            :aria-label="tr('集数范围', 'Episode ranges')"
          >
            <button
              v-for="(group, index) in episodeGroups"
              :key="index"
              class="ep-tab"
              :class="{ active: episodeGroup === index }"
              type="button"
              :aria-pressed="episodeGroup === index"
              @click="episodeGroup = index"
            >
              {{ tr(`${group[0]?.no}-${group[group.length - 1]?.no}集`, `Episodes ${group[0]?.no}–${group[group.length - 1]?.no}`) }}
            </button>
          </div>
          <div v-if="visibleEpisodes.length" class="ep-grid">
            <button
              v-for="ep in visibleEpisodes"
              :key="ep.no"
              class="ep-item"
              :class="{ cur: ep.no === lastEp, locked: isLocked(ep.no) }"
              type="button"
              :aria-label="isLocked(ep.no)
                ? tr(`第${ep.no}集为 VIP 专享`, `Episode ${ep.no} is for VIP members`)
                : tr(`播放第${ep.no}集`, `Play episode ${ep.no}`)"
              @click="play(ep.no)"
            >
              {{ ep.no
              }}<span v-if="ep.no === lastEp" class="ep-mark">{{ tr('已看', 'Watched') }}</span>
              <span v-else-if="isLocked(ep.no)" class="ep-lock" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="9" height="9">
                  <path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm3 8H9V7a3 3 0 0 1 6 0v3Z" />
                </svg>
              </span>
            </button>
          </div>
          <p v-else class="empty-copy">{{ tr('暂无可播放集数', 'No episodes available') }}</p>
        </section>
        <section
          v-if="related.length"
          class="content-section related-section"
          aria-labelledby="related-heading"
        >
          <div class="section-heading-row">
            <h2 id="related-heading" class="section-heading">{{ tr('相关推荐', 'You may also like') }}</h2>
            <RouterLink class="more-link" to="/">{{ tr('查看更多', 'View more') }}</RouterLink>
          </div>
          <div class="drama-grid">
            <DramaCard v-for="item in related" :key="item.id" :drama="item" />
          </div>
        </section>
      </template>
    </main>
    <Teleport to="body">
      <div
        v-if="paywallEpisode !== null"
        class="paywall-mask"
        role="dialog"
        aria-modal="true"
        :aria-label="tr('VIP 专享剧集', 'VIP episode')"
        @click.self="paywallEpisode = null"
      >
        <div class="paywall-card">
          <button class="paywall-close" type="button" :aria-label="tr('关闭', 'Close')" @click="paywallEpisode = null">✕</button>
          <span class="paywall-badge" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="15" height="15">
              <path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm3 8H9V7a3 3 0 0 1 6 0v3Z" />
            </svg>
            VIP
          </span>
          <h2>{{ tr(`第${paywallEpisode}集为 VIP 专享`, `Episode ${paywallEpisode} is for VIP members`) }}</h2>
          <p>{{ tr('每部剧第 1 集免费观看，开通 VIP 会员即可解锁第 2 集起的全部剧集。', 'Episode 1 of every series is free. Join VIP to unlock every episode from episode 2 onward.') }}</p>
          <ul class="paywall-plans">
            <li><span>{{ tr('月度会员', 'Monthly') }}</span><strong>10 USDT</strong></li>
            <li><span>{{ tr('半年会员', '6 months') }}</span><strong>20 USDT</strong></li>
            <li><span>{{ tr('年度会员', '12 months') }}</span><strong>20 USDT</strong></li>
          </ul>
          <button class="button-primary paywall-cta" type="button" @click="goVip">{{ tr('开通 VIP 会员', 'Join VIP') }}</button>
          <button class="paywall-later" type="button" @click="paywallEpisode = null">{{ tr('稍后再说', 'Not now') }}</button>
        </div>
      </div>
    </Teleport>
    <SiteFooter />
  </div>
</template>

<style scoped>
.detail-page {
  min-height: 100%;
}
.page-main {
  padding-top: 90px;
  padding-bottom: 56px;
}
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 0 15px;
  color: var(--fg-3);
  font-size: 13px;
}
.breadcrumb a {
  color: var(--fg-2);
}
.breadcrumb a:hover,
.breadcrumb strong {
  color: var(--accent);
}
.breadcrumb strong {
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-title {
  margin: 0 0 20px;
  color: var(--fg);
  font-size: 28px;
  font-weight: 600;
  line-height: 1.3;
}
.detail-layout {
  display: grid;
  grid-template-columns: 321px minmax(0, 1fr);
  align-items: stretch;
  gap: 32px;
}
.d-poster {
  position: relative;
  width: 100%;
  aspect-ratio: 9/16;
  overflow: hidden;
  align-self: start;
  border-radius: var(--radius);
  background: var(--bg-2);
  box-shadow: 0 18px 40px -24px #000;
}
.d-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.poster-badge {
  position: absolute;
  top: 12px;
  left: 12px;
  padding: 4px 7px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  font-weight: 800;
}
.d-info {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.d-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 0 0 18px;
}
.d-meta span {
  padding: 5px 13px;
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--fg-2);
  font-size: 13px;
}
.d-meta .meta-status {
  color: var(--accent);
}
.rating-block,
.tag-block {
  margin-top: 19px;
}
.d-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  color: var(--fg);
  font-size: 15px;
}
.d-sub::before {
  width: 3px;
  height: 15px;
  border-radius: 2px;
  background: var(--gradient);
  content: '';
}
.d-rating {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 10px;
}
.stars {
  position: relative;
  display: inline-block;
  overflow: hidden;
  color: var(--bg-3);
  font-size: 20px;
  letter-spacing: 3px;
  line-height: 1;
  white-space: nowrap;
}
.stars::before,
.stars i::before {
  content: '★★★★★';
}
.stars i {
  position: absolute;
  top: 0;
  left: 0;
  overflow: hidden;
  color: var(--gold);
  font-style: normal;
  white-space: nowrap;
}
.rv {
  color: var(--gold);
  font-size: 22px;
  line-height: 1;
}
.d-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
}
.d-tags span {
  padding: 5px 13px;
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--fg-2);
  font-size: 13px;
}
.d-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: auto;
  padding-top: 24px;
}
.d-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 42px;
  padding: 10px 17px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 700;
  white-space: nowrap;
}
.d-actions .button-primary {
  min-width: 145px;
}
.share-feedback {
  color: var(--fg-2);
  font-size: 12px;
}
.content-section {
  position: relative;
  margin-top: 40px;
}
.section-heading-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 14px;
}
.section-heading {
  margin: 0;
}
.video-intro {
  position: relative;
  margin-bottom: 20px;
}
.video-intro .section-heading {
  margin-bottom: 10px;
}
.video-intro.is-open .vi-toggle {
  position: static;
  display: block;
  margin-top: 8px;
}
.work-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 18px;
  margin: 0;
  padding: 15px 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.work-meta div {
  display: grid;
  grid-template-columns: 5em 1fr;
  gap: 8px;
}
.work-meta a {
  color: var(--accent);
  margin-right: 12px;
}
.category-meta {
  grid-column: 1/-1;
}
.work-meta dt {
  color: var(--fg-3);
}
.work-meta dd {
  margin: 0;
  color: var(--fg);
}
.section-muted {
  color: var(--fg-3);
  font-size: 13px;
}
.vi-text {
  color: var(--fg-2);
  font-size: 14.5px;
  line-height: 1.78;
}
.vi-text.clamp {
  display: -webkit-box;
  overflow: hidden;
  padding-right: 3.8em;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.vi-toggle {
  position: absolute;
  right: 0;
  bottom: 0;
  color: var(--accent);
  font-size: 13px;
  font-weight: 700;
}
.ep-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  margin-bottom: 14px;
}
.ep-tab {
  padding: 7px 15px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-2);
  color: var(--fg-2);
  font-size: 13px;
}
.ep-tab.active {
  border-color: transparent;
  background: var(--gradient);
  color: #fff;
}
.ep-grid {
  display: grid;
  grid-template-columns: repeat(10, minmax(0, 1fr));
  gap: 10px;
}
.ep-item {
  position: relative;
  min-height: 47px;
  padding: 10px 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-2);
  color: var(--fg);
  font-size: 14px;
  font-weight: 700;
  transition: 0.15s;
}
.ep-item:hover {
  border-color: var(--accent);
  background: var(--bg-3);
  transform: translateY(-1px);
}
.ep-item.cur {
  border-color: transparent;
  background: var(--gradient);
}
.ep-item.locked {
  color: var(--fg-2);
}
.ep-item.locked:hover {
  border-color: var(--gold);
}
.ep-lock {
  position: absolute;
  top: 4px;
  right: 4px;
  display: grid;
  place-items: center;
  color: var(--gold);
}
.ep-item.cur .ep-lock {
  color: #fff;
}
.paywall-note {
  margin: -4px 0 14px;
  padding: 11px 14px;
  border: 1px solid var(--accent-line);
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent-fg-soft);
  font-size: 13px;
}
.paywall-note a {
  margin-left: 6px;
  color: #fff;
  font-weight: 700;
  text-decoration: underline;
}
.paywall-mask {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.72);
}
.paywall-card {
  position: relative;
  width: min(400px, 100%);
  padding: 28px 24px 22px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: #1b1b1b;
  box-shadow: 0 28px 70px -24px rgba(0, 0, 0, 0.85);
  text-align: center;
}
.paywall-close {
  position: absolute;
  top: 8px;
  right: 12px;
  color: var(--fg-3);
  font-size: 20px;
  line-height: 1;
}
.paywall-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 999px;
  background: linear-gradient(100deg, #f6dca8, #d9ae68);
  color: #33251a;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.6px;
}
.paywall-card h2 {
  margin: 14px 0 8px;
  font-size: 18px;
  font-weight: 700;
}
.paywall-card > p {
  color: var(--fg-2);
  font-size: 13px;
  line-height: 1.75;
}
.paywall-plans {
  display: grid;
  gap: 8px;
  margin: 18px 0 20px;
}
.paywall-plans li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #232323;
  font-size: 13px;
}
.paywall-plans span {
  color: var(--fg-2);
}
.paywall-plans strong {
  color: var(--gold);
  font-size: 14px;
}
.paywall-cta {
  width: 100%;
  min-height: 44px;
  border-radius: 10px;
  font-size: 15px;
  font-weight: 700;
}
.paywall-later {
  margin-top: 12px;
  color: var(--fg-3);
  font-size: 13px;
}
.paywall-later:hover {
  color: var(--fg-2);
}
.ep-mark {
  position: absolute;
  right: 5px;
  bottom: 4px;
  color: #ffffffb8;
  font-size: 9px;
  font-weight: 500;
}
.empty-copy {
  margin: 0;
  padding: 24px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--fg-3);
  text-align: center;
}
.more-link {
  color: var(--fg-2);
  font-size: 13px;
}
.more-link:hover {
  color: var(--accent);
}
.state {
  display: flex;
  min-height: 360px;
  align-items: center;
  justify-content: center;
  gap: 11px;
  color: var(--fg-2);
  text-align: center;
}
.state-error {
  flex-direction: column;
}
.state-error p {
  max-width: 560px;
  margin: 0;
}
.state-retry {
  min-height: 40px;
  padding: 0 18px;
  border-radius: 9px;
}
.back-link {
  color: var(--fg-3);
  font-size: 13px;
}
.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border);
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
  .page-main {
    padding-top: 76px;
    padding-bottom: 38px;
  }
  .detail-title {
    margin-bottom: 15px;
    font-size: 26px;
  }
  .detail-layout {
    grid-template-columns: 1fr;
    gap: 20px;
  }
  .d-poster {
    width: 200px;
    max-width: 70%;
    margin: 0 auto;
  }
  .d-actions {
    margin-top: 22px;
    padding-top: 0;
  }
  .d-actions button {
    flex: 1 1 0;
    min-width: 0;
    padding-right: 9px;
    padding-left: 9px;
  }
  .d-actions .button-primary {
    white-space: normal;
  }
  .d-actions .button-primary {
    flex: 1.7 1 0;
    min-width: 0;
  }
  .share-feedback {
    flex-basis: 100%;
  }
  .content-section {
    margin-top: 32px;
  }
  .ep-grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
  }
}
@media (max-width: 480px) {
  .breadcrumb {
    font-size: 12px;
  }
  .d-meta {
    gap: 7px;
  }
  .d-meta span {
    padding-right: 10px;
    padding-left: 10px;
    font-size: 12px;
  }
  .d-actions button {
    font-size: 13px;
  }
  .work-meta {
    grid-template-columns: 1fr;
  }
  .ep-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
