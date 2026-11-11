#!/usr/bin/env node
/**
 * 把已上传的 XVIDEOS 视频写入 MySQL + data/dramas.json。
 *
 * 数据来源：data/xvideos-uploaded.json（流水线记录的已上传条目）
 * - 剧 id  = xv-<xvideos id>，与 S3 上的目录一一对应
 * - 剧名   = 原标题
 * - 封面   = /posters/imported/<id>.jpg
 * - 播放   = /s3-hls/<id>/episode-1/index.m3u8（服务端私有桶中转）
 * - 频道   = videos（对应前端「成人视频」导航栏）
 *
 * 用法：
 *   node scripts/xvideos-import-mysql.mjs            # 预览
 *   node scripts/xvideos-import-mysql.mjs --apply    # 写库
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import mysql from 'mysql2/promise'
import { ensureDramaSchema, syncDramasToMysql, mysqlConfig } from './init-mysql-dramas.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UPLOADED = path.join(ROOT, 'data/xvideos-uploaded.json')
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data/dramas.json')

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    limit: { type: 'string', default: '0' },
  },
})

if (!fs.existsSync(UPLOADED)) {
  console.error(`找不到 ${UPLOADED}\n先运行：node scripts/xvideos-pipeline.mjs`)
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(UPLOADED, 'utf8'))
let entries = Object.values(manifest.uploaded || {})
entries.sort((a, b) => String(a.uploadedAt).localeCompare(String(b.uploadedAt)))
const limit = Number(values.limit) || 0
if (limit > 0) entries = entries.slice(0, limit)

const catalog = fs.existsSync(DATA_FILE)
  ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  : { categories: [], dramas: [] }
const byId = new Map((catalog.dramas ?? []).map((d) => [d.id, d]))

const CATEGORY = { id: 'videos', name: '成人视频' }
const CHANNEL = 'videos'

const dramas = []
for (const e of entries) {
  const id = e.id
  const existing = byId.get(id)
  const cover = e.cover || existing?.cover || ''
  const episode = {
    no: 1,
    title: e.title,
    src: `/s3-hls/${id}/episode-1/index.m3u8`,
  }
  dramas.push({
    id,
    title: e.title,
    cover,
    description: existing?.description || `${e.title}（${e.tier || 720}p）`,
    tags: ['xvideos'],
    status: 'completed',
    views: e.views ?? existing?.views ?? 6000,
    rating: e.rating ?? existing?.rating ?? 80,
    publishedAt: e.publishedAt ?? new Date().toISOString(),
    channelId: CHANNEL,
    categoryIds: [CATEGORY.id],
    hd: (e.tier ?? 720) >= 720,
    episodes: [episode],
  })
}

console.log(JSON.stringify({
  mode: values.apply ? 'applied' : 'preview',
  entries: entries.length,
  toWrite: dramas.length,
  existing: dramas.filter((d) => byId.has(d.id)).length,
  sample: dramas.slice(0, 5).map((d) => ({ id: d.id, title: d.title, cover: d.cover, src: d.episodes[0].src })),
}, null, 2))

if (!values.apply) process.exit(0)
if (!dramas.length) throw new Error('没有可导入的记录')

// 1) MySQL
const config = mysqlConfig()
const admin = await mysql.createConnection({
  host: config.host, port: config.port, user: config.user, password: config.password,
})
try {
  await admin.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  )
} finally {
  await admin.end()
}

const pool = mysql.createPool({
  ...config, waitForConnections: true, connectionLimit: 10, supportBigNumbers: true,
})
try {
  await ensureDramaSchema(pool)
  const res = await syncDramasToMysql(pool, { categories: [CATEGORY], dramas })
  const [[c]] = await pool.query('SELECT COUNT(*) n FROM categories')
  const [[dd]] = await pool.query('SELECT COUNT(*) n FROM dramas')
  const [[e]] = await pool.query('SELECT COUNT(*) n FROM episodes')
  console.log(JSON.stringify({
    ok: true,
    imported: res,
    mysql: { categories: Number(c.n), dramas: Number(dd.n), episodes: Number(e.n) },
  }))
} finally {
  await pool.end()
}

// 2) data/dramas.json 兜底（合并 + 备份）
const previousText = fs.readFileSync(DATA_FILE, 'utf8')
const previous = JSON.parse(previousText)
const merged = [...previous.dramas]
for (const d of dramas) {
  const i = merged.findIndex((x) => x.id === d.id)
  if (i >= 0) merged[i] = d
  else merged.push(d)
}
const categories = previous.categories?.length ? previous.categories : []
if (!categories.some((x) => x.id === CATEGORY.id)) categories.push(CATEGORY)
fs.mkdirSync(path.join(ROOT, 'data/backups'), { recursive: true })
const next = `${JSON.stringify({ categories, dramas: merged }, null, 2)}\n`
if (next !== previousText) {
  const { createHash } = await import('node:crypto')
  const digest = createHash('sha256').update(previousText).digest('hex').slice(0, 16)
  const backup = path.join(ROOT, 'data/backups', `dramas-${digest}.json`)
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, previousText)
  fs.writeFileSync(DATA_FILE, next)
  console.log(`[json] merged ${dramas.length} works -> ${DATA_FILE}`)
} else {
  console.log('[json] no change')
}
