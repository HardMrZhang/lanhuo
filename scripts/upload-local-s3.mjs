#!/usr/bin/env node
/**
 * 把 hls-output 里 media/imported（成人短剧/漫剧）来源的 HLS 上传到 S3。
 *
 * 与 scripts/video-upload-s3.mjs 的区别：
 *   - 数据源是 media/imported/<dramaId>/episode-N（不是 video-import-map.json）；
 *   - --force 用于重传去水印后重新转码的集（S3 上的 .ts 是同名覆盖）。
 *
 * S3 结构：s3://<bucket>/<prefix>/<dramaId>/episode-<N>/{index.m3u8,seg_*.ts}
 *
 * 用法：
 *   node scripts/upload-local-s3.mjs --work local-xxx
 *   node scripts/upload-local-s3.mjs --force --all
 *   node scripts/upload-local-s3.mjs --dry-run
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IMPORTED = path.join(ROOT, 'media/imported')
const OUT = path.join(ROOT, 'hls-output')

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

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    force: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    work: { type: 'string', multiple: true, default: [] },
    concurrency: { type: 'string', default: '3' },
  },
})

const ids = fs.existsSync(IMPORTED) ? fs.readdirSync(IMPORTED) : []
const selected = values.work.length ? ids.filter((id) => values.work.includes(id)) : ids

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

/** 列出远端已有的集（<id>/episode-N/index.m3u8）。 */
async function listRemoteEpisodes() {
  const have = new Set()
  let token
  do {
    const args = ['s3', 'ls', `s3://${BUCKET}/${PREFIX}/`, '--region', REGION, '--recursive']
    if (token) args.push('--page-size', '1000')
    const out = await aws(args)
    for (const line of out.split('\n')) {
      const m = line.trim().match(/\s(\S+index\.m3u8)$/)
      if (m) have.add(m[1])
    }
    token = undefined
  } while (token)
  return have
}

console.log('读取远端清单...')
const remote = await listRemoteEpisodes()
console.log(`远端已有 ${remote.size} 个集清单`)

const plan = []
for (const id of selected) {
  const localDir = path.join(OUT, id)
  if (!fs.existsSync(localDir)) continue
  const eps = fs.readdirSync(localDir).filter((d) => /^episode-\d+$/.test(d))
  const pending = eps.filter((ep) => {
    if (!fs.existsSync(path.join(localDir, ep, 'index.m3u8'))) return false
    if (values.force) return true
    return !remote.has(`${PREFIX}/${id}/${ep}/index.m3u8`)
  })
  if (pending.length) plan.push({ id, src: localDir, dest: `s3://${BUCKET}/${PREFIX}/${id}/`, eps: pending })
}

const totalEps = plan.reduce((n, p) => n + p.eps.length, 0)
console.log(`待上传 ${totalEps} 集（${plan.length} 部剧）`)
if (values['dry-run']) {
  for (const p of plan.slice(0, 40)) console.log(`  ${p.id}: ${p.eps.join(', ')}`)
  if (plan.length > 40) console.log(`  ... 其余 ${plan.length - 40} 部`)
  process.exit(0)
}
if (!plan.length) { console.log('无需上传'); process.exit(0) }

let done = 0
let failed = 0
const failures = []

async function run(p) {
  try {
    await aws(['s3', 'sync', p.src, p.dest, '--region', REGION,
      '--exclude', '*', '--include', '*.m3u8',
      '--content-type', 'application/vnd.apple.mpegurl',
      '--cache-control', 'public, max-age=10'])
    await aws(['s3', 'sync', p.src, p.dest, '--region', REGION,
      '--exclude', '*', '--include', '*.ts',
      '--content-type', 'video/mp2t',
      '--cache-control', 'public, max-age=31536000,immutable'])
    done++
  } catch (e) {
    failed++
    failures.push({ id: p.id, error: e.message })
  }
}

const concurrency = Math.max(1, Number(values.concurrency) || 3)
let cursor = 0
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (;;) {
    const i = cursor++
    if (i >= plan.length) return
    await run(plan[i])
    if ((done + failed) % 10 === 0) console.log(`  进度 ${done + failed}/${plan.length}`)
  }
}))

console.log(JSON.stringify({ done, failed, failures: failures.slice(0, 10) }, null, 2))
