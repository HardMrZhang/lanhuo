#!/usr/bin/env node
/**
 * 把 py_project/video 目录映射成短剧入库清单（data/video-import-map.json）。
 *
 * 目录结构：video/<剧名>/第00N集.mp4 + video/<剧名>/cover.png
 * 元数据：video/all_series.csv（title / description / series_url / episode_count）
 *
 * 剧 ID 规则：
 * - 剧名（规范化后）能匹配到现有库存 data/dramas.json -> 复用现有 drama.id
 *   （这批是欧美剧，原始来源是 py_project/download，ID 由 py-download/<目录>/metadata.json 哈希而来）
 * - 匹配不到 -> 新剧，ID = local-<sha256('video/<剧目录>')[:16]>（与 s3hls.js 的 local-[a-f0-9]{16} 规则一致）
 *
 * 封面：整部剧只抽一帧（第 1 集里挑一张非黑屏画面），不是每集各抽一张。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VIDEO_DIR = '/Users/zhangchaoyin/zhangzhaoyin/py_project/video'
const DATA_FILE = path.join(ROOT, 'data/dramas.json')
const OUT_FILE = path.join(ROOT, 'data/video-import-map.json')

const sha16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** 标题规范化：统一撇号/破折号、大小写、空白，用于跨来源匹配同一剧。 */
const normTitle = (s) =>
  String(s)
    .replace(/[’‘`]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

/** 读 CSV（支持带引号字段与转义双引号）。 */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"') { inQuotes = true; continue }
    if (c === ',') { row.push(field); field = ''; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    if (c === '\r') continue
    field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  const header = rows.shift() ?? []
  return rows
    .filter((r) => r.some((v) => v !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
}

/** 解析 csv 里的剧集清单：只取已下载成功且文件确实存在的集。 */
function readEpisodeCsv(file) {
  const bySeries = new Map()
  for (const r of parseCsv(fs.readFileSync(file, 'utf8'))) {
    const series = String(r.series ?? '').trim()
    const episode = Number(r.episode)
    const status = String(r.status ?? '').trim()
    if (!series || !Number.isInteger(episode) || episode < 1) continue
    if (status !== 'downloaded' && status !== 'already_downloaded') continue
    const list = bySeries.get(series) ?? []
    if (!list.includes(episode)) list.push(episode)
    bySeries.set(series, list)
  }
  for (const list of bySeries.values()) list.sort((a, b) => a - b)
  return bySeries
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    video: { type: 'string', default: VIDEO_DIR },
    out: { type: 'string', default: OUT_FILE },
  },
})

const videoDir = path.resolve(values.video)
if (!fs.existsSync(videoDir)) throw new Error(`视频目录不存在：${videoDir}`)

const catalog = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
const existingByNorm = new Map()
for (const d of catalog.dramas ?? []) {
  const key = normTitle(d.title)
  if (!existingByNorm.has(key)) existingByNorm.set(key, d)
}

const seriesCsv = parseCsv(fs.readFileSync(path.join(videoDir, 'all_series.csv'), 'utf8'))
const metaByNorm = new Map()
for (const r of seriesCsv) {
  const title = String(r.title ?? '').trim()
  if (!title) continue
  metaByNorm.set(normTitle(title), r)
}

const episodeCsv = readEpisodeCsv(path.join(videoDir, 'all_episodes.csv'))

const works = []
let reused = 0
let created = 0
let skippedNoVideo = 0

for (const dirName of fs.readdirSync(videoDir).sort()) {
  const dir = path.join(videoDir, dirName)
  if (!fs.statSync(dir).isDirectory()) continue

  const files = fs.readdirSync(dir).filter((f) => /^第0*(\d+)集\.mp4$/.test(f))
  const episodes = files
    .map((f) => ({ no: Number(/^第0*(\d+)集\.mp4$/.exec(f)[1]), file: path.join(dir, f) }))
    .sort((a, b) => a.no - b.no)
  if (!episodes.length) { skippedNoVideo++; continue }

  const key = normTitle(dirName)
  const existing = existingByNorm.get(key)
  const meta = metaByNorm.get(key) ?? {}
  const id = existing ? existing.id : `local-${sha16(`video/${dirName}`)}`
  if (existing) reused++
  else created++

  // csv 里标记下载成功、但本地文件缺失的集，视为该集不可用，不写进清单。
  const csvEps = episodeCsv.get(meta.title ? String(meta.title) : dirName)
  const episodesFinal = csvEps
    ? episodes.filter((e) => csvEps.includes(e.no))
    : episodes

  works.push({
    id,
    dirName,
    title: dirName,
    source: existing ? 'reused' : 'new',
    description: String(meta.description ?? '').trim(),
    seriesUrl: String(meta.series_url ?? '').trim(),
    csvEpisodeCount: Number(meta.episode_count ?? 0) || null,
    csvEpisodes: csvEps ?? null,
    episodes: episodesFinal.map((e) => ({ no: e.no, file: e.file })),
  })
}

const payload = {
  generatedAt: new Date().toISOString(),
  videoDir,
  stats: {
    dirs: works.length + skippedNoVideo,
    withVideo: works.length,
    skippedNoVideo,
    reused,
    created,
    episodes: works.reduce((n, w) => n + w.episodes.length, 0),
    episodesReused: works.filter((w) => w.source === 'reused').reduce((n, w) => n + w.episodes.length, 0),
    episodesNew: works.filter((w) => w.source === 'new').reduce((n, w) => n + w.episodes.length, 0),
  },
  works,
}
fs.mkdirSync(path.dirname(values.out), { recursive: true })
fs.writeFileSync(values.out, `${JSON.stringify(payload, null, 2)}\n`)
console.log(JSON.stringify({ out: values.out, ...payload.stats }, null, 2))
