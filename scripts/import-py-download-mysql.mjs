import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import mysql from 'mysql2/promise'
import { ensureDramaSchema, syncDramasToMysql, mysqlConfig } from './init-mysql-dramas.mjs'
import { designPoster, designedCoverPath } from './import-downloads.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DEFAULT = '/Users/zhangchaoyin/zhangzhaoyin/py_project/download'
const OUT_DEFAULT = path.join(ROOT, 'hls-output')
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data/dramas.json')

const sha16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)

// 与 scripts/transcode-py-download.sh 同源：local-<sha256('py-download/<剧目录>/metadata.json')[:16]>
export const dramaIdOf = (rawDir) => `local-${sha16(`py-download/${rawDir}/metadata.json`)}`

export function cleanTitle(raw) {
  return String(raw)
    .replace(/\s*[–-]\s*Free NSFW Short Drama\s*$/i, '')
    .replace(/\s*Episode\s*\d+\s*$/i, '')
    .replace(/\s*-\s*Full Episodes Free Online\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || String(raw).trim()
}

function probeDuration(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 })
  if (r.status !== 0) return null
  const d = Number(String(r.stdout).trim())
  return Number.isFinite(d) && d > 0 ? Math.round(d * 100) / 100 : null
}

export function scanPyDownload({ src = SRC_DEFAULT, out = OUT_DEFAULT, probe = probeDuration } = {}) {
  const dirs = fs.readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  const dramas = []
  for (const rawDir of dirs) {
    const dir = path.join(src, rawDir)
    const files = fs.readdirSync(dir).filter((f) => /^第0*\d+集\.mp4$/.test(f)).sort()
    const nums = []
    for (const f of files) {
      const m = /^第0*(\d+)集\.mp4$/.exec(f)
      if (m) nums.push({ file: path.join(dir, f), no: Number(m[1]) })
    }
    nums.sort((a, b) => a.no - b.no)
    if (!nums.length) continue
    const id = dramaIdOf(rawDir)
    const title = cleanTitle(rawDir)
    const episodes = nums.map(({ file, no }) => {
      const dest = path.join(out, id, `episode-${no}`, 'index.m3u8')
      void dest
      // 链接固定指向 /s3-hls/...（私桶中转），转码/上传进度不影响入库，先占位后生效
      let duration
      try { duration = probe(file) } catch { duration = null }
      return {
        no, title: `第${no}集`,
        src: `/s3-hls/${id}/episode-${no}/index.m3u8`,
        ...(duration ? { duration } : {}),
      }
    })
    dramas.push({
      id,
      title,
      cover: designedCoverPath(id),
      description: `${title}（全${episodes.length}集）。`,
      tags: ['py-download'],
      status: 'completed',
      views: 1000 + (parseInt(sha16(id).slice(0, 4), 16) % 9000),
      rating: 70 + (parseInt(sha16(id).slice(4, 6), 16) % 30),
      publishedAt: new Date().toISOString(),
      channelId: 'shorts',
      categoryIds: ['shorts'],
      hd: true,
      episodes,
      _rawDir: rawDir,
    })
  }
  return dramas
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      src: { type: 'string', default: SRC_DEFAULT },
      apply: { type: 'boolean', default: false },
      'skip-probe': { type: 'boolean', default: false },
    },
  })
  const probe = values['skip-probe'] ? () => null : probeDuration
  const dramas = scanPyDownload({ src: path.resolve(values.src), probe })
  console.log(JSON.stringify({
    mode: values.apply ? 'applied' : 'preview',
    works: dramas.length,
    episodes: dramas.reduce((n, d) => n + d.episodes.length, 0),
    sample: dramas.slice(0, 3).map((d) => ({ id: d.id, title: d.title, episodes: d.episodes.length })),
  }, null, 2))
  if (!values.apply) process.exit(0)
  if (!dramas.length) throw new Error('py-download 下没有可导入的剧')

  // 1) 写封面 SVG（不存在才写，不覆盖人工 jpg）
  for (const d of dramas) {
    const svgFile = path.join(ROOT, 'public', d.cover)
    const jpgFile = svgFile.replace(/\.designed-v1\.svg$/, '.jpg')
    if (!fs.existsSync(svgFile) && !fs.existsSync(jpgFile)) {
      fs.mkdirSync(path.dirname(svgFile), { recursive: true })
      fs.writeFileSync(svgFile, designPoster(d, ROOT).svg)
    }
    delete d._rawDir
  }

  // 2) MySQL：建表 + upsert（短剧库主存 MySQL）
  const config = mysqlConfig()
  const admin = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password })
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`)
  } finally { await admin.end() }
  const pool = mysql.createPool({ ...config, waitForConnections: true, connectionLimit: 10, supportBigNumbers: true })
  try {
    await ensureDramaSchema(pool)
    const res = await syncDramasToMysql(pool, { categories: [{ id: 'shorts', name: '成人短剧' }], dramas })
    const [[c]] = await pool.query('SELECT COUNT(*) n FROM categories')
    const [[dd]] = await pool.query('SELECT COUNT(*) n FROM dramas')
    const [[e]] = await pool.query('SELECT COUNT(*) n FROM episodes')
    console.log(JSON.stringify({ ok: true, imported: res, mysql: { categories: Number(c.n), dramas: Number(dd.n), episodes: Number(e.n) } }))
  } finally { await pool.end() }

  // 3) 同步 data/dramas.json（兜底 + 备份），保持与 MySQL 一致
  const previousText = fs.readFileSync(DATA_FILE, 'utf8')
  const previous = JSON.parse(previousText)
  const prevIds = new Set(previous.dramas.map((d) => d.id))
  const merged = [...previous.dramas]
  for (const d of dramas) {
    const i = merged.findIndex((x) => x.id === d.id)
    if (i >= 0) merged[i] = d
    else merged.push(d)
    void prevIds
  }
  const next = `${JSON.stringify({ categories: previous.categories?.length ? previous.categories : [{ id: 'shorts', name: '成人短剧' }], dramas: merged }, null, 2)}\n`
  if (next !== previousText) {
    const { createHash: ch } = await import('node:crypto')
    const backup = path.join(ROOT, 'data/backups', `dramas-${ch('sha256').update(previousText).digest('hex').slice(0, 16)}.json`)
    if (!fs.existsSync(backup)) {
      fs.mkdirSync(path.dirname(backup), { recursive: true })
      fs.writeFileSync(backup, previousText)
    }
    fs.writeFileSync(DATA_FILE, next)
    console.log(`[json] merged ${dramas.length} works -> ${DATA_FILE}`)
  } else {
    console.log('[json] no change')
  }
}
