#!/usr/bin/env node
/**
 * 从剧集视频里切一张真实画面作为封面。
 *
 * 背景：data/dramas.json 里不少剧还指向 .designed-v1.svg（风景占位图），
 * 首页看不到真实内容。这里对每部剧从第 1 集（缺则后续集）里挑一帧存成
 * public/posters/imported/<id>.jpg，并把 drama.cover 指过去。
 *
 * 选帧策略：跳过开头黑屏/纯色帧，在视频时长区间内按步长采样多帧，
 * 用 ffmpeg 的 signalstats 过滤掉过暗/过曝的帧，取第一张可用画面。
 *
 * 用法：
 *   node scripts/capture-covers.mjs            # 预览，不写文件
 *   node scripts/capture-covers.mjs --apply    # 实际抽帧并更新 data/dramas.json
 *   node scripts/capture-covers.mjs --apply --id local-xxx  # 只处理指定剧
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data/dramas.json')
const POSTER_DIR = path.join(ROOT, 'public/posters/imported')
const PY_DOWNLOAD = '/Users/zhangchaoyin/zhangzhaoyin/py_project/download'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    apply: { type: 'boolean', default: false },
    id: { type: 'string', multiple: true, default: [] },
    'quality': { type: 'string', default: '2' },
  },
})

/** drama id -> 本地 mp4 路径候选（按集数升序）。 */
function localVideoCandidates(drama) {
  const out = []
  const mediaDir = path.join(ROOT, 'media/imported', drama.id)
  if (fs.existsSync(mediaDir)) {
    for (const file of fs.readdirSync(mediaDir).sort()) {
      if (/\.mp4$/i.test(file)) out.push(path.join(mediaDir, file))
    }
  }
  // py_project/download 里的作品按标题匹配（导入脚本用同一个标题清洗规则）
  if (!out.length && fs.existsSync(PY_DOWNLOAD)) {
    const title = String(drama.title ?? '').trim().toLowerCase()
    for (const dir of fs.readdirSync(PY_DOWNLOAD)) {
      const full = path.join(PY_DOWNLOAD, dir)
      if (!fs.statSync(full).isDirectory()) continue
      const cleaned = dir
        .replace(/\s*[–-]\s*Free NSFW Short Drama\s*$/i, '')
        .replace(/\s*Episode\s*\d+\s*$/i, '')
        .replace(/\s*-\s*Full Episodes Free Online\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
      if (cleaned === title) {
        for (const file of fs.readdirSync(full).sort()) {
          if (/\.mp4$/i.test(file)) out.push(path.join(full, file))
        }
        break
      }
    }
  }
  return out
}

function probeDuration(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8', timeout: 20000 })
  if (r.status !== 0) return null
  const d = Number(String(r.stdout).trim())
  return Number.isFinite(d) && d > 0 ? d : null
}

/**
 * 抽一帧存成 jpg。返回 true 表示成功。
 * -ss 放在 -i 前做快速定位；再叠加 -vf scale 限制宽度，保持竖版海报观感。
 */
function captureFrame(video, second, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  const tmp = `${outFile}.tmp.jpg`
  const r = spawnSync('ffmpeg', [
    '-y',
    '-ss', String(second),
    '-i', video,
    '-frames:v', '1',
    '-vf', 'scale=720:-2',
    '-q:v', values.quality,
    tmp,
  ], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
  if (r.status !== 0) {
    fs.rmSync(tmp, { force: true })
    return false
  }
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 1024) {
    fs.rmSync(tmp, { force: true })
    return false
  }
  fs.renameSync(tmp, outFile)
  return true
}

/** 用 ffmpeg 检测该帧是否过暗/过曝，避免抽到黑屏或白屏。 */
function frameLooksValid(video, second) {
  const r = spawnSync('ffmpeg', [
    '-v', 'error',
    '-ss', String(second),
    '-i', video,
    '-frames:v', '1',
    '-vf', 'signalstats,metadata=print:file=-',
    '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
  if (r.status !== 0) return false
  const text = String(r.stdout || '')
  const yavg = Number(/lavfi\.signalstats\.YAVG=([\d.]+)/.exec(text)?.[1])
  if (!Number.isFinite(yavg)) return false
  return yavg > 24 && yavg < 235
}

function pickFrame(video, duration) {
  // 避开片头黑屏（0~3s）和片尾，从 10% 位置起按步长往后找。
  const start = Math.min(Math.max(duration * 0.1, 0.5), duration - 0.5)
  const candidates = [start]
  for (let s = start + 5; s < duration - 0.5; s += 5) candidates.push(s)
  candidates.push(Math.max(duration * 0.5, 0.5))
  for (const second of candidates) {
    if (!Number.isFinite(second) || second < 0 || second >= duration) continue
    if (!frameLooksValid(video, second)) continue
    return second
  }
  // 没有通过亮度检测的帧，退回中间位置（总比没有封面好）
  return Number.isFinite(duration) && duration > 1 ? Math.min(duration / 2, duration - 0.5) : null
}

const previousText = fs.readFileSync(DATA_FILE, 'utf8')
const catalog = JSON.parse(previousText)
const dramas = catalog.dramas ?? catalog

const targets = dramas.filter((d) => {
  if (values.id.length) return values.id.includes(d.id)
  // 只处理还在用占位图（designed svg）的剧
  return /\.designed-v1\.svg$/.test(d.cover ?? '')
})

const results = []
let changed = 0
for (const drama of targets) {
  const candidates = localVideoCandidates(drama)
  if (!candidates.length) {
    results.push({ id: drama.id, status: 'no-source' })
    continue
  }
  const video = candidates[0]
  const duration = probeDuration(video)
  if (!duration) {
    results.push({ id: drama.id, status: 'probe-failed' })
    continue
  }
  const second = pickFrame(video, duration)
  if (second === null) {
    results.push({ id: drama.id, status: 'no-frame' })
    continue
  }
  const outFile = path.join(POSTER_DIR, `${drama.id}.jpg`)
  if (values.apply) {
    if (!captureFrame(video, second, outFile)) {
      results.push({ id: drama.id, status: 'capture-failed' })
      continue
    }
    drama.cover = `/posters/imported/${drama.id}.jpg`
    changed++
    results.push({ id: drama.id, status: 'captured', second: Number(second.toFixed(2)) })
  } else {
    results.push({ id: drama.id, status: 'planned', second: Number(second.toFixed(2)) })
  }
}

if (values.apply && changed) {
  const digest = createHash('sha256').update(previousText).digest('hex').slice(0, 16)
  const backup = path.join(ROOT, 'data/backups', `dramas-${digest}.json`)
  fs.mkdirSync(path.dirname(backup), { recursive: true })
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, previousText)
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(catalog, null, 2)}\n`)
}

const counts = results.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1
  return acc
}, {})
console.log(JSON.stringify({
  mode: values.apply ? 'applied' : 'preview',
  targets: targets.length,
  counts,
  failed: results.filter((r) => !['captured', 'planned'].includes(r.status)).slice(0, 20),
}, null, 2))
