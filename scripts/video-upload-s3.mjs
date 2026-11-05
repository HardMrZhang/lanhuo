#!/usr/bin/env node
/**
 * 把 video 导入的 HLS 与封面传到 S3（东京私有桶）。
 *
 * HLS:  s3://<bucket>/<S3_PREFIX>/<dramaId>/episode-<no>/{index.m3u8,seg_*.ts}
 * 封面: s3://<bucket>/posters/imported/<dramaId>.jpg
 *
 * 前端播放走服务端私有桶中转 /s3-hls/<dramaId>/episode-<no>/index.m3u8，
 * 封面走 /posters/imported/<dramaId>.jpg 中转，桶保持私有即可。
 *
 * 性能：先一次性 aws s3 ls 列出远端已有 key，再按剧目录整体 aws s3 sync，
 * 避免每集单独起进程（原来 393 集要起上千个 aws 进程）。
 *
 * 用法：
 *   node scripts/video-upload-s3.mjs                # 只传缺失的
 *   node scripts/video-upload-s3.mjs --force        # 强制重传
 *   node scripts/video-upload-s3.mjs --dry-run
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAP = path.join(ROOT, 'data/video-import-map.json')
const OUT = path.join(ROOT, 'hls-output')
const POSTER_DIR = path.join(ROOT, 'public/posters/imported')

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
const PREFIX = (process.env.S3_PREFIX || 'hls').replace(/^\/+|\/+$/g, '')
const POSTER_PREFIX = (process.env.S3_POSTER_PREFIX || 'posters').replace(/^\/+|\/+$/g, '')

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    force: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    work: { type: 'string', multiple: true, default: [] },
    'skip-hls': { type: 'boolean', default: false },
    'skip-posters': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
  },
})

const map = JSON.parse(fs.readFileSync(MAP, 'utf8'))
const works = values.work.length ? map.works.filter((w) => values.work.includes(w.id)) : map.works

function aws(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('aws', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`aws ${args[1]} exit=${code}: ${err.slice(-400)}`))))
  })
}

/** 一次性列出远端已有的 key（相对 S3_PREFIX / POSTER_PREFIX）。 */
async function listRemote(prefix) {
  const keys = new Set()
  let token
  do {
    const args = ['s3', 'ls', `s3://${BUCKET}/${prefix}/`, '--region', REGION, '--recursive']
    if (token) args.push('--page-size', '1000')
    const out = await aws(args)
    for (const line of out.split('\n')) {
      const m = line.trim().match(/\s(\S+)$/)
      if (m) keys.add(m[1])
    }
    token = undefined
  } while (token)
  return keys
}

console.log('读取远端清单...')
const [remoteHls, remotePosters] = await Promise.all([
  values['skip-hls'] ? Promise.resolve(new Set()) : listRemote(PREFIX),
  values['skip-posters'] ? Promise.resolve(new Set()) : listRemote(POSTER_PREFIX),
])
console.log(`远端已有 HLS ${remoteHls.size} 个对象、封面 ${remotePosters.size} 张`)

// 组装上传计划：按剧目录整体同步（一次 aws s3 sync 传完一部剧的若干集）。
const plan = []
let hlsEpisodes = 0
let posterCount = 0

for (const work of works) {
  if (!values['skip-hls']) {
    const localDir = path.join(OUT, work.id)
    if (fs.existsSync(localDir)) {
      const eps = fs.readdirSync(localDir).filter((d) => /^episode-\d+$/.test(d))
      const pending = eps.filter((ep) => {
        if (!fs.existsSync(path.join(localDir, ep, 'index.m3u8'))) return false
        if (values.force) return true
        return !remoteHls.has(`${PREFIX}/${work.id}/${ep}/index.m3u8`)
      })
      if (pending.length) {
        plan.push({ type: 'hls', id: work.id, src: localDir, dest: `s3://${BUCKET}/${PREFIX}/${work.id}/`, eps: pending })
        hlsEpisodes += pending.length
      }
    }
  }
  if (!values['skip-posters']) {
    const poster = path.join(POSTER_DIR, `${work.id}.jpg`)
    const key = `${POSTER_PREFIX}/imported/${work.id}.jpg`
    if (fs.existsSync(poster) && (values.force || !remotePosters.has(key))) {
      plan.push({ type: 'poster', id: work.id, src: poster, dest: `s3://${BUCKET}/${key}` })
      posterCount++
    }
  }
}

console.log(`待上传：${hlsEpisodes} 个剧集（${plan.filter((p) => p.type === 'hls').length} 部剧）、${posterCount} 张封面`)
if (values['dry-run']) {
  for (const p of plan.slice(0, 30)) console.log(`  ${p.type} ${p.src} -> ${p.dest}`)
  if (plan.length > 30) console.log(`  ... 其余 ${plan.length - 30} 项`)
  process.exit(0)
}
if (!plan.length) { console.log('无需上传，全部已存在'); process.exit(0) }

let done = 0
let failed = 0
const failures = []

async function run(p) {
  try {
    if (p.type === 'hls') {
      await aws(['s3', 'sync', p.src, p.dest, '--region', REGION,
        '--exclude', '*', '--include', '*.m3u8',
        '--content-type', 'application/vnd.apple.mpegurl',
        '--cache-control', 'public, max-age=10'])
      await aws(['s3', 'sync', p.src, p.dest, '--region', REGION,
        '--exclude', '*', '--include', '*.ts',
        '--content-type', 'video/mp2t',
        '--cache-control', 'public, max-age=31536000,immutable'])
    } else {
      await aws(['s3', 'cp', p.src, p.dest, '--region', REGION,
        '--content-type', 'image/jpeg',
        '--cache-control', 'public, max-age=31536000,immutable'])
    }
    done++
  } catch (e) {
    failed++
    failures.push({ id: p.id, type: p.type, error: e.message })
  }
}

const concurrency = Math.max(1, Number(values.concurrency) || 4)
let cursor = 0
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (;;) {
    const i = cursor++
    if (i >= plan.length) return
    await run(plan[i])
    if ((done + failed) % 15 === 0) console.log(`  进度 ${done + failed}/${plan.length}`)
  }
}))

console.log(JSON.stringify({ done, failed, failures: failures.slice(0, 10) }, null, 2))
