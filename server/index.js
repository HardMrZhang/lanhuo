import express from 'express'
import compression from 'compression'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadData, watchData } from './data.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(ROOT, 'media')
const DIST_DIR = path.join(ROOT, 'dist')
const PORT = Number(process.env.PORT) || 3001
const isProd = process.env.NODE_ENV === 'production'

const app = express()
app.disable('x-powered-by')
app.use(cors())
app.use(compression({ filter: (req, res) => !/\.(ts|m4s|mp4)$/.test(req.path) && compression.filter(req, res) }))

// ---------- 数据 ----------
let db = loadData()
watchData(() => {
  db = loadData()
  console.log('[data] reloaded')
})

const toSummary = (d) => {
  const { episodes, ...rest } = d
  return { ...rest, episodeCount: episodes.length }
}

// ---------- API ----------
app.get('/api/categories', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60')
  res.json(db.categories)
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

app.get('/api/dramas/:id', (req, res) => {
  const d = db.dramas.find((x) => x.id === req.params.id)
  if (!d) return res.status(404).json({ error: 'not found' })
  res.set('Cache-Control', 'public, max-age=30')
  res.json(d)
})

// ---------- 媒体文件 ----------
// express.static 原生支持 Range 请求（拖动进度条、分段加载），HLS 分片设长缓存。
app.use(
  '/media',
  express.static(MEDIA_DIR, {
    fallthrough: false,
    acceptRanges: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.m3u8')) {
        res.set('Content-Type', 'application/vnd.apple.mpegurl')
        res.set('Cache-Control', 'public, max-age=10')
      } else if (filePath.endsWith('.ts') || filePath.endsWith('.m4s')) {
        res.set('Cache-Control', 'public, max-age=31536000, immutable')
      } else if (filePath.endsWith('.mp4')) {
        res.set('Cache-Control', 'public, max-age=86400')
      }
    },
  }),
)

// ---------- 生产环境托管前端 ----------
if (isProd && fs.existsSync(DIST_DIR)) {
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
