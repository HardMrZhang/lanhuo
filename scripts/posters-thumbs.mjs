#!/usr/bin/env node
/**
 * 生成封面缩略图（WebP）并上传到 S3。
 *
 * 背景：封面原图是 720×1280 的 JPG，单张 70~85KB。首页一次要渲染 100+ 张
 * （轮播 7 + 各分区），全部拉原图会拖慢首屏。缩略图 480 宽 WebP 约 18KB，
 * 体积降到原来的 1/4 左右。
 *
 * 产物：
 *   本地 public/posters/thumbs/<dramaId>.webp
 *   S3   s3://<bucket>/<S3_POSTER_PREFIX>/imported/<dramaId>.webp
 *
 * 前端按需取缩略图（/posters/imported/<id>.webp），详情页仍用原图。
 *
 * 用法：
 *   node scripts/posters-thumbs.mjs                 # 只生成本地缩略图
 *   node scripts/posters-thumbs.mjs --upload        # 生成并上传 S3
 *   node scripts/posters-thumbs.mjs --upload --force # 强制重生成/重传
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const POSTER_DIR = path.join(ROOT, 'public/posters/imported')
// 缩略图与原图同目录（同名 .webp），这样 /posters/imported/<id>.webp
// 在本地静态托管和 S3 中转两条链路上路径完全一致，前端不用区分来源。
const THUMB_DIR = POSTER_DIR

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    upload: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    width: { type: 'string', default: '480' },
    quality: { type: 'string', default: '72' },
  },
})

const WIDTH = Number(values.width) || 480
const QUALITY = Number(values.quality) || 72

// 自动加载 .env（调用方已设的环境变量优先）
function loadEnvFile(file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed
    const eq = body.indexOf('=')
    if (eq < 0) continue
    const k = body.slice(0, eq).trim()
    if (!k || process.env[k] !== undefined) continue
    let v = body.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else { const hash = v.indexOf(' #'); if (hash >= 0) v = v.slice(0, hash).trim() }
    process.env[k] = v
  }
}
loadEnvFile(path.join(ROOT, '.env'))

const BUCKET = process.env.S3_BUCKET || 'duanju-h5-hls-473041657070'
const REGION = process.env.AWS_REGION || 'ap-northeast-1'
const POSTER_PREFIX = (process.env.S3_POSTER_PREFIX || 'posters').replace(/^\/+|\/+$/g, '')

/** 有 cwebp 用 cwebp（体积更小），否则退回 ffmpeg。 */
function hasCommand(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' })
  return r.status === 0 && Boolean(String(r.stdout).trim())
}

const hasCwebp = hasCommand('cwebp')
const hasFfmpeg = hasCommand('ffmpeg')
if (!hasCwebp && !hasFfmpeg) {
  console.error('需要 cwebp 或 ffmpeg 才能生成缩略图')
  process.exit(1)
}

function toWebp(src, dest) {
  const tmp = `${dest}.tmp`
  if (hasCwebp) {
    const r = spawnSync(
      'cwebp',
      ['-q', String(QUALITY), '-resize', String(WIDTH), '0', src, '-o', tmp, '-quiet'],
      { encoding: 'utf8', timeout: 60000 },
    )
    if (r.status === 0 && fs.existsSync(tmp)) {
      fs.renameSync(tmp, dest)
      return true
    }
  }
  const r = spawnSync(
    'ffmpeg',
    ['-y', '-v', 'error', '-i', src, '-vf', `scale=${WIDTH}:-2`, '-c:v', 'mjpeg', '-q:v', '5', tmp],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
  )
  if (r.status === 0 && fs.existsSync(tmp)) {
    fs.renameSync(tmp, dest)
    return true
  }
  fs.rmSync(tmp, { force: true })
  return false
}

if (!fs.existsSync(POSTER_DIR)) {
  console.error(`封面目录不存在：${POSTER_DIR}`)
  process.exit(1)
}
fs.mkdirSync(THUMB_DIR, { recursive: true })

const files = fs.readdirSync(POSTER_DIR).filter((f) => f.endsWith('.jpg'))
let created = 0
let skipped = 0
let failed = 0
const uploadList = []

for (const file of files) {
  const src = path.join(POSTER_DIR, file)
  const id = file.replace(/\.jpg$/, '')
  const dest = path.join(THUMB_DIR, `${id}.webp`)
  if (!values.force && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    skipped++
    uploadList.push(dest)
    continue
  }
  if (!toWebp(src, dest)) {
    failed++
    console.error(`  失败：${file}`)
    continue
  }
  created++
  uploadList.push(dest)
}

const origSize = files.reduce((sum, f) => sum + fs.statSync(path.join(POSTER_DIR, f)).size, 0)
const thumbSize = uploadList.reduce((sum, f) => sum + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0)
console.log(
  `缩略图：${WIDTH}px WebP（${hasCwebp ? 'cwebp' : 'ffmpeg'}）· 新建 ${created}、跳过 ${skipped}、失败 ${failed}`,
)
console.log(
  `体积：原图 ${(origSize / 1024 / 1024).toFixed(1)}MB -> 缩略图 ${(thumbSize / 1024 / 1024).toFixed(1)}MB`,
)

if (!values.upload) {
  console.log('（加 --upload 上传到 S3）')
  process.exit(0)
}

function aws(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('aws', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`aws ${args[1]} exit=${code}: ${err.slice(-300)}`)),
    )
  })
}

console.log(`上传 ${uploadList.length} 张缩略图到 S3...`)
let done = 0
let upFailed = 0
const failures = []
const cursor = { i: 0 }
await Promise.all(Array.from({ length: 6 }, async () => {
  for (;;) {
    const i = cursor.i++
    if (i >= uploadList.length) return
    const file = uploadList[i]
    const id = path.basename(file).replace(/\.webp$/, '')
    const key = `${POSTER_PREFIX}/imported/${id}.webp`
    try {
      await aws([
        's3', 'cp', file, `s3://${BUCKET}/${key}`, '--region', REGION,
        '--content-type', 'image/webp',
        '--cache-control', 'public, max-age=31536000,immutable',
      ])
      done++
      if (done % 50 === 0) console.log(`  进度 ${done}/${uploadList.length}`)
    } catch (e) {
      upFailed++
      failures.push({ id, error: e.message })
    }
  }
}))

console.log(JSON.stringify({ done, failed: upFailed, failures: failures.slice(0, 10) }, null, 2))
