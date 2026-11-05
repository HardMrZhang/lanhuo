#!/usr/bin/env node
/**
 * 为每部剧抽一帧作为封面（整部剧一张，不按集抽）。
 *
 * 规则：
 * - 每部剧只在第 1 集里挑一帧（若第 1 集缺失则退到第 2 集）。
 * - 用 ffmpeg signalstats 跳过黑屏/过曝帧，按步长在时长区间采样，取第一张可用画面。
 * - 输出 public/posters/imported/<dramaId>.jpg（720 宽竖版），供前端和 S3 上传使用。
 * - 已有 jpg 的剧默认跳过，除非传 --force。
 *
 * 用法：
 *   node scripts/video-covers.mjs             # 预览
 *   node scripts/video-covers.mjs --apply     # 实际抽帧
 *   node scripts/video-covers.mjs --apply --force   # 覆盖已有封面
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAP = path.join(ROOT, 'data/video-import-map.json')
const POSTER_DIR = path.join(ROOT, 'public/posters/imported')

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    apply: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    work: { type: 'string', multiple: true, default: [] },
  },
})

const map = JSON.parse(fs.readFileSync(MAP, 'utf8'))
const works = values.work.length ? map.works.filter((w) => values.work.includes(w.id)) : map.works

function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
    encoding: 'utf8', timeout: 20000,
  })
  if (r.status !== 0) return null
  const d = Number(String(r.stdout).trim())
  return Number.isFinite(d) && d > 0 ? d : null
}

/** 该帧是否可用（亮度在合理区间，排除纯黑/纯白）。 */
function frameLooksValid(file, second) {
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-ss', String(second), '-i', file,
    '-frames:v', '1', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
  if (r.status !== 0) return false
  const yavg = Number(/lavfi\.signalstats\.YAVG=([\d.]+)/.exec(String(r.stdout || ''))?.[1])
  if (!Number.isFinite(yavg)) return false
  return yavg > 24 && yavg < 235
}

/** 抽帧存 jpg。 */
function captureFrame(file, second, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  const tmp = `${outFile}.tmp.jpg`
  const r = spawnSync('ffmpeg', [
    '-y', '-ss', String(second), '-i', file,
    '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '2', tmp,
  ], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
  if (r.status !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1024) {
    fs.rmSync(tmp, { force: true })
    return false
  }
  fs.renameSync(tmp, outFile)
  return true
}

/** 在时长区间内采样，挑第一张亮度正常的帧。 */
function pickFrame(file, duration) {
  const start = Math.min(Math.max(duration * 0.1, 0.5), duration - 0.5)
  const candidates = [start]
  for (let s = start + 5; s < duration - 0.5; s += 5) candidates.push(s)
  candidates.push(Math.min(Math.max(duration * 0.5, 0.5), duration - 0.5))
  for (const second of candidates) {
    if (!Number.isFinite(second) || second < 0 || second >= duration) continue
    if (!frameLooksValid(file, second)) continue
    return second
  }
  return Number.isFinite(duration) && duration > 1 ? Math.min(duration / 2, duration - 0.5) : null
}

const results = []
let captured = 0
let skipped = 0
let failed = 0

for (const work of works) {
  const outFile = path.join(POSTER_DIR, `${work.id}.jpg`)
  if (!values.force && fs.existsSync(outFile)) {
    skipped++
    results.push({ id: work.id, title: work.title, status: 'exists' })
    continue
  }
  // 整部剧只用第 1 集抽帧；第 1 集没有则退到后面的集。
  const episodes = [...work.episodes].sort((a, b) => a.no - b.no)
  const source = episodes[0]
  if (!source) {
    failed++
    results.push({ id: work.id, title: work.title, status: 'no-episode' })
    continue
  }
  const duration = probeDuration(source.file)
  if (!duration) {
    failed++
    results.push({ id: work.id, title: work.title, status: 'probe-failed' })
    continue
  }
  const second = pickFrame(source.file, duration)
  if (second === null) {
    failed++
    results.push({ id: work.id, title: work.title, status: 'no-frame' })
    continue
  }
  if (!values.apply) {
    results.push({ id: work.id, title: work.title, status: 'planned', second: Number(second.toFixed(2)) })
    continue
  }
  if (!captureFrame(source.file, second, outFile)) {
    failed++
    results.push({ id: work.id, title: work.title, status: 'capture-failed' })
    continue
  }
  captured++
  results.push({ id: work.id, title: work.title, status: 'captured', second: Number(second.toFixed(2)) })
}

const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc }, {})
console.log(JSON.stringify({
  mode: values.apply ? 'applied' : 'preview',
  works: works.length,
  counts,
  failed: results.filter((r) => !['exists', 'planned', 'captured'].includes(r.status)).slice(0, 20),
}, null, 2))
