import express from 'express'
import compression from 'compression'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadData, watchData } from './data.js'
import { createDramaPool, loadDramasFromMysql } from './dramas-db.js'
import { createVipRouter } from './vip.js'
import { createS3HlsHandler } from './s3hls.js'
import { createS3PosterHandler } from './s3posters.js'
import { FREE_EPISODES, isEpisodeLocked, lockedMediaPaths } from './access.js'
import { createReferralService, initReferralSchema } from './referral.js'
import { createReferralRouter } from './referral-router.js'
import { createAdminAuth, initAdminSchema, requireSameOrigin } from './admin/auth.js'
import { createPaymentAdminRouter } from './admin/payment.js'
import { createRecommendAdminRouter, initRecommendSchema, createRecommendReader } from './admin/recommend.js'
import { createSharedPool, ensureDatabase, mysqlConfig } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(ROOT, 'media')
const DIST_DIR = path.join(ROOT, 'dist')
const PORT = Number(process.env.PORT) || 3001
const isProd = process.env.NODE_ENV === 'production'

// 封面 URL 版本号：封面路径曾返回过 404 HTML，而响应头带 immutable 会被浏览器长期缓存，
// 加版本参数让 URL 变化，强制浏览器与 CDN 重新拉取真实图片。
const POSTER_VERSION = process.env.POSTER_VERSION || 'v2'
const POSTER_PATH_RE = /^\/posters\/imported\/(local-[a-f0-9]{16}|xv-[a-z0-9]{8,})\.jpg$/

/** 给本地封面路径追加版本参数（已带参数的保持不变）。 */
function versionedCover(cover) {
  if (typeof cover !== 'string' || !POSTER_PATH_RE.test(cover)) return cover
  return `${cover}?v=${POSTER_VERSION}`
}

const app = express()
app.disable('x-powered-by')
app.use(compression({ filter: (req, res) => !/\.(ts|m4s|mp4)$/.test(req.path) && compression.filter(req, res) }))
const vip = await createVipRouter()
app.use('/api', vip)

// ---------- 邀请 / 后台共享的数据层 ----------
// 邀请模块、两个后台与会员模块共用同一个 MySQL 库，但各自建立连接池：
// 后台与前台流量特征不同，混在一个池里会让后台的慢查询拖住用户下单。
const sharedConfig = mysqlConfig(process.env)
await ensureDatabase(sharedConfig)
const referralPool = createSharedPool(process.env)
const adminPool = createSharedPool(process.env)

await initAdminSchema(adminPool)
await initReferralSchema(referralPool)
await initRecommendSchema(adminPool)

const referralService = createReferralService({ pool: referralPool })
app.use('/api/referral', createReferralRouter({ referralService }))

// 前台推荐位读取器：首页按后台配置渲染推荐位。
const readRecommendSlots = createRecommendReader({ pool: adminPool })

// ---------- 两个独立后台 ----------
// 支付后台与推荐后台各自独立：独立路径、独立 Cookie、独立管理员角色。
// 后台账号存在 admin_users 表里，与前台会员账号完全隔离。
const paymentAdminAuth = createAdminAuth({
  pool: adminPool,
  allowedRoles: ['payment', 'super'],
  cookieName: 'duanju_admin_payment',
  production: isProd,
})
const recommendAdminAuth = createAdminAuth({
  pool: adminPool,
  allowedRoles: ['referral', 'super'],
  cookieName: 'duanju_admin_recommend',
  production: isProd,
})
const paymentAdminRouter = createPaymentAdminRouter({ pool: adminPool, referralService })
const recommendAdminRouter = createRecommendAdminRouter({ pool: adminPool })
// 预置推荐位（幂等），首次启动时把首页分区落成可配置的推荐位。
await recommendAdminRouter.__seedSlots()

app.use('/admin-api/payment', requireSameOrigin, paymentAdminAuth)
app.use('/admin-api/payment', paymentAdminAuth.__requireAdmin, paymentAdminRouter)
app.use('/admin-api/recommend', requireSameOrigin, recommendAdminAuth)
app.use('/admin-api/recommend', recommendAdminAuth.__requireAdmin, recommendAdminRouter)

// ---------- 数据 ----------
// 短剧库主存 MySQL（categories/dramas/episodes/drama_categories）。
// data/dramas.json 仅作开发期兜底：MySQL 不可用或为空时回退，保证本地照常跑。
let db = loadData()
let lockedMedia = lockedMediaPaths(db.dramas)
const dramaPool = createDramaPool()
try {
  const fromMysql = await loadDramasFromMysql(dramaPool)
  if (fromMysql.dramas.length) {
    db = fromMysql
    lockedMedia = lockedMediaPaths(db.dramas)
    console.log(`[data] loaded from MySQL: ${db.dramas.length} dramas, ${db.categories.length} categories`)
  } else {
    console.log('[data] MySQL empty, fallback to data/dramas.json')
  }
  // 数据库写入（如后台脚本导剧）后无需重启：每 15s 刷新一次。
  setInterval(async () => {
    try {
      const next = await loadDramasFromMysql(dramaPool)
      if (!next.dramas.length) return
      db = next
      lockedMedia = lockedMediaPaths(db.dramas)
    } catch (e) {
      console.error('[data] mysql refresh failed:', e.message)
    }
  }, 15_000).unref?.()
} catch (e) {
  console.error('[data] MySQL unavailable, fallback to data/dramas.json:', e.message)
}
// 第 2 集起的媒体文件只有有效会员可取，防止绕过前端直接拉取地址（上面已初始化）。
// JSON 兜底模式下文件变更热重载（开发期改 JSON 不用重启）。
watchData(() => {
  if (db.dramas.length) return
  db = loadData()
  lockedMedia = lockedMediaPaths(db.dramas)
  console.log('[data] reloaded')
})

const toSummary = (d) => {
  const { episodes, ...rest } = d
  return { ...rest, cover: versionedCover(rest.cover), episodeCount: episodes.length }
}

/** 未开通会员时不下发付费集的播放地址。 */
const toDetail = (d, isVip) => {
  const base = { ...d, cover: versionedCover(d.cover) }
  if (isVip) return base
  return {
    ...base,
    episodes: base.episodes.map((episode) =>
      isEpisodeLocked(episode.no) ? { ...episode, src: '' } : episode,
    ),
  }
}


// ---------- API ----------
app.get('/api/categories', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60')
  res.json(db.categories)
})

app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60')
  res.json({ freeEpisodes: FREE_EPISODES, paywallStartEpisode: FREE_EPISODES + 1 })
})

const sorters = {
  hot: (a, b) => (b.views ?? 0) - (a.views ?? 0),
  new: (a, b) => new Date(b.publishedAt ?? 0) - new Date(a.publishedAt ?? 0),
  rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0),
}

app.get('/api/dramas', (req, res) => {
  const { category, q, sort } = req.query
  let list = db.dramas
  if (typeof category === 'string' && category) {
    list = list.filter((d) => d.categoryIds.includes(category))
  }
  if (typeof q === 'string' && q.trim()) {
    const kw = q.trim().toLowerCase()
    list = list.filter(
      (d) =>
        d.title.toLowerCase().includes(kw) ||
        d.description.toLowerCase().includes(kw) ||
        (d.tags ?? []).some((t) => t.toLowerCase().includes(kw)),
    )
  }
  if (typeof sort === 'string' && sorters[sort]) {
    list = [...list].sort(sorters[sort])
  }
  res.set('Cache-Control', 'public, max-age=30')
  res.json(list.map(toSummary))
})

app.get('/api/dramas/:id', async (req, res, next) => {
  try {
    const d = db.dramas.find((x) => x.id === req.params.id)
    if (!d) return res.status(404).json({ error: 'not found' })
    // 该响应随登录状态变化，必须禁用共享缓存，否则会员身份会被缓存串用。
    res.set('Cache-Control', 'private, no-store')
    res.json(toDetail(d, await vip.isVip(req)))
  } catch (error) { next(error) }
})

// ---------- 推荐位（前台） ----------
// 后台配置的推荐位：返回每个启用位里的剧 id 与权重。
// 前台按位渲染，没配置的位回落到原有排序逻辑。
app.get('/api/recommend/slots', async (_req, res) => {
  try {
    const slots = await readRecommendSlots()
    res.set('Cache-Control', 'public, max-age=30')
    res.json({ slots })
  } catch (error) {
    // 推荐位读失败不能影响首页可用性：返回空列表，前台走默认逻辑。
    console.error('[recommend] read slots failed:', error?.message || error)
    res.set('Cache-Control', 'public, max-age=30')
    res.json({ slots: [] })
  }
})

app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }))

// ---------- S3 私有桶 HLS 中转 ----------
// 组织 SCP 禁止公开桶策略，直链 S3 会 403；改走服务端 GetObject 中转，前端播 /s3-hls/...。
// 付费集（第 2 集起）同样要求有效 VIP 会员，和 /media 策略一致。
// 多码率 HLS 的档位子目录（720p/480p/1080p）走 /s3-hls/:id/:ep/:tier/:file。
app.get('/s3-hls/:id/:ep/:file', createS3HlsHandler({ isEpisodeLocked, checkVip: (req) => vip.isVip(req) }))
app.get('/s3-hls/:id/:ep/:tier/:file', createS3HlsHandler({ isEpisodeLocked, checkVip: (req) => vip.isVip(req) }))

// ---------- S3 私有桶封面中转 ----------
// 封面同在 HLS 私有桶里（组织 SCP 禁公开），走服务端 GetObject 中转。
// 前端封面地址形如 /posters/imported/<dramaId>.jpg（与本地静态路径一致，无需改数据）。
app.get('/posters/imported/:file', createS3PosterHandler())
app.get('/s3-posters/:file', createS3PosterHandler())

// ---------- 媒体文件 ----------
// express.static 原生支持 Range 请求（拖动进度条、分段加载），HLS 分片设长缓存。
// 付费集不允许被 CDN 或共享缓存留存，因此按是否付费集分别设置缓存策略。
const mediaStatic = (isPaid) =>
  express.static(MEDIA_DIR, {
    fallthrough: false,
    acceptRanges: true,
    setHeaders(res, filePath) {
      if (isPaid) {
        res.set('Cache-Control', 'private, no-store')
      } else if (filePath.endsWith('.m3u8')) {
        res.set('Content-Type', 'application/vnd.apple.mpegurl')
        res.set('Cache-Control', 'public, max-age=10')
      } else if (filePath.endsWith('.ts') || filePath.endsWith('.m4s')) {
        res.set('Cache-Control', 'public, max-age=31536000, immutable')
      } else if (filePath.endsWith('.mp4')) {
        res.set('Cache-Control', 'public, max-age=86400')
      }
    },
  })
const freeMedia = mediaStatic(false)
const paidMedia = mediaStatic(true)

app.use('/media', async (req, res, next) => {
  let pathname
  try {
    // 归一化后比对，避免 //、./、../ 等变体绕过付费集检查。
    pathname = path.posix.normalize(decodeURIComponent(req.path))
  } catch {
    return res.status(400).json({ error: '无效的媒体路径' })
  }
  if (pathname.startsWith('../')) return res.status(400).json({ error: '无效的媒体路径' })
  if (!lockedMedia.has(pathname)) return freeMedia(req, res, next)
  try {
    if (!(await vip.isVip(req))) {
      res.set('Cache-Control', 'no-store')
      return res.status(403).json({ error: '该集为 VIP 专享，请先开通会员' })
    }
  } catch (error) { return next(error) }
  return paidMedia(req, res, next)
})

// ---------- 生产环境托管前端 ----------
if (isProd && fs.existsSync(DIST_DIR)) {
  // 用户端与后台共用同一个 SPA 入口，后台走 /admin/* 路由，
  // 所以这里只需要托管静态资源 + SPA 兜底。
  app.use(express.static(DIST_DIR, { index: false, maxAge: '1y', immutable: true }))
  app.get('*', (_req, res) => {
    res.set('Cache-Control', 'no-cache')
    res.sendFile(path.join(DIST_DIR, 'index.html'))
  })
}

app.use((err, _req, res, _next) => {
  if (err?.status === 404) return res.status(404).end()
  console.error(err)
  res.status(500).json({ error: 'internal error' })
})

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}  media=${MEDIA_DIR}  ${isProd ? 'production' : 'dev'}`)
})
