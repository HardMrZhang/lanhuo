#!/usr/bin/env node
/**
 * 把 video 导入的剧写入 MySQL + data/dramas.json。
 *
 * 数据来源：data/video-import-map.json
 * - 剧名 = 视频目录名（原样显示在前端，保留英文/符号）
 * - 简介 = all_series.csv 的 description
 * - 封面 = public/posters/imported/<id>.jpg（整部剧抽一帧）
 * - 播放地址 = /s3-hls/<id>/episode-<no>/index.m3u8（服务端私有桶中转）
 * - 分类：欧美短剧（western）
 *
 * 重复剧（与现有库存同名）复用原 drama.id，只更新集数/封面/简介，不新建记录。
 *
 * 用法：
 *   node scripts/video-import-mysql.mjs            # 预览
 *   node scripts/video-import-mysql.mjs --apply    # 写库
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import mysql from 'mysql2/promise'
import { ensureDramaSchema, syncDramasToMysql, mysqlConfig } from './init-mysql-dramas.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAP = path.join(ROOT, 'data/video-import-map.json')
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data/dramas.json')

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    apply: { type: 'boolean', default: false },
    work: { type: 'string', multiple: true, default: [] },
  },
})

const map = JSON.parse(fs.readFileSync(MAP, 'utf8'))
const works = values.work.length ? map.works.filter((w) => values.work.includes(w.id)) : map.works

const catalog = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
const byId = new Map((catalog.dramas ?? []).map((d) => [d.id, d]))

// 剧集号 -> 播放地址：只有 hls-output 里已有 index.m3u8 的集才写地址。
function episodesOf(work) {
  const out = []
  for (const e of [...work.episodes].sort((a, b) => a.no - b.no)) {
    const ready = fs.existsSync(path.join(ROOT, 'hls-output', work.id, `episode-${e.no}`, 'index.m3u8'))
    out.push({
      no: e.no,
      title: `第${e.no}集`,
      src: ready ? `/s3-hls/${work.id}/episode-${e.no}/index.m3u8` : '',
      _ready: ready,
    })
  }
  return out
}

/**
 * 复用剧的集数取并集：video/ 目录只有部分集时，保留原有库存里更多的集。
 * （例：Accident with my Stepmom 原有 10 集来自 py_project/download，video/ 里只有 2 集）
 */
function mergeEpisodes(work, existing) {
  const fresh = episodesOf(work)
  const byNo = new Map()
  for (const e of existing?.episodes ?? []) byNo.set(Number(e.no), { ...e, _ready: true })
  for (const e of fresh) if (e._ready) byNo.set(e.no, e)
  return [...byNo.values()].sort((a, b) => a.no - b.no)
}

const CATEGORY = { id: 'western', name: '欧美短剧' }

const dramas = []
for (const work of works) {
  const existing = byId.get(work.id)
  const readyEpisodes = existing ? mergeEpisodes(work, existing) : episodesOf(work).filter((e) => e._ready)
  if (!readyEpisodes.length) continue

  const coverFile = path.join(ROOT, 'public/posters/imported', `${work.id}.jpg`)
  const cover = fs.existsSync(coverFile) ? `/posters/imported/${work.id}.jpg` : (existing?.cover ?? '')

  const description = work.description
    ? work.description
    : `${work.title}（全${readyEpisodes.length}集）。`

  if (existing) {
    dramas.push({
      ...existing,
      title: work.title,
      cover,
      description: work.description || existing.description,
      status: 'completed',
      hd: true,
      channelId: 'western',
      categoryIds: Array.from(new Set([...(existing.categoryIds ?? []), 'western'])),
      episodes: readyEpisodes.map(({ _ready, ...e }) => e),
    })
  } else {
    const hash = createHash('sha256').update(work.id).digest('hex')
    dramas.push({
      id: work.id,
      title: work.title,
      cover,
      description,
      tags: ['py-video'],
      status: 'completed',
      views: 1000 + (parseInt(hash.slice(0, 4), 16) % 9000),
      rating: 70 + (parseInt(hash.slice(4, 6), 16) % 30),
      publishedAt: new Date().toISOString(),
      channelId: 'western',
      categoryIds: ['western'],
      hd: true,
      episodes: readyEpisodes.map(({ _ready, ...e }) => e),
    })
  }
}

const reused = dramas.filter((d) => byId.has(d.id)).length
const created = dramas.length - reused
const episodeTotal = dramas.reduce((n, d) => n + d.episodes.length, 0)

console.log(JSON.stringify({
  mode: values.apply ? 'applied' : 'preview',
  works: works.length,
  imported: dramas.length,
  reused,
  created,
  episodes: episodeTotal,
  sample: dramas.slice(0, 5).map((d) => ({ id: d.id, title: d.title, episodes: d.episodes.length, cover: d.cover })),
}, null, 2))

if (!values.apply) process.exit(0)
if (!dramas.length) throw new Error('没有可导入的剧')

// 1) MySQL
const config = mysqlConfig()
const admin = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password })
try {
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`)
} finally { await admin.end() }
const pool = mysql.createPool({ ...config, waitForConnections: true, connectionLimit: 10, supportBigNumbers: true })
try {
  await ensureDramaSchema(pool)
  const res = await syncDramasToMysql(pool, { categories: [CATEGORY], dramas })
  const [[c]] = await pool.query('SELECT COUNT(*) n FROM categories')
  const [[dd]] = await pool.query('SELECT COUNT(*) n FROM dramas')
  const [[e]] = await pool.query('SELECT COUNT(*) n FROM episodes')
  console.log(JSON.stringify({ ok: true, imported: res, mysql: { categories: Number(c.n), dramas: Number(dd.n), episodes: Number(e.n) } }))
} finally { await pool.end() }

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
const next = `${JSON.stringify({ categories, dramas: merged }, null, 2)}\n`
if (next !== previousText) {
  const digest = createHash('sha256').update(previousText).digest('hex').slice(0, 16)
  const backup = path.join(ROOT, 'data/backups', `dramas-${digest}.json`)
  fs.mkdirSync(path.join(ROOT, 'data/backups'), { recursive: true })
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, previousText)
  fs.writeFileSync(DATA_FILE, next)
  console.log(`[json] merged ${dramas.length} works -> ${DATA_FILE}`)
} else {
  console.log('[json] no change')
}
