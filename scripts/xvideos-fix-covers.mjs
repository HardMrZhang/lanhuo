#!/usr/bin/env node
/**
 * 补齐缺失的封面：部分视频抽帧时整段都是黑屏/白屏，被 signalstats 过滤掉了，
 * 于是封面缺失、前台显示「短剧剧场」占位图。
 *
 * 这些视频的源 mp4 已经被流水线删掉了，但 S3 上的 HLS 分片还在，
 * 所以直接从 S3 拉几个分片，用 ffmpeg 抽帧生成封面再传回 S3。
 *
 * 用法：
 *   node scripts/xvideos-fix-covers.mjs            # 预览
 *   node scripts/xvideos-fix-covers.mjs --apply    # 补齐并上传
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UPLOADED = path.join(ROOT, 'data/xvideos-uploaded.json')
const TMP = path.join(os.tmpdir(), 'xvideos-fix-covers')

const { values } = parseArgs({
  options: { apply: { type: 'boolean', default: false } },
})

// 读 .env
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (!m) continue
  const v = m[2].replace(/^["']|["']$/g, '')
  if (process.env[m[1]] === undefined) process.env[m[1]] = v
}

const BUCKET = process.env.S3_BUCKET || 'duanju-h5-hls-473041657070'
const REGION = process.env.AWS_REGION || 'ap-northeast-1'
const PREFIX = (process.env.S3_PREFIX || 'hls').replace(/^\/+|\/+$/g, '')
const POSTER_PREFIX = (process.env.S3_POSTER_PREFIX || 'posters').replace(/^\/+|\/+$/g, '')

/** aws cli 会读代理变量，沙箱注入的代理端口长跑时会失效，S3 本身可直连 */
function awsEnv() {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(k)) delete env[k]
  return env
}

function run(cmd, args, { env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: env ?? process.env })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (err += d))
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }))
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

/** S3 上某个剧的分片列表 */
function listSegments(id) {
  const r = spawnSync(
    'aws',
    ['s3', 'ls', `s3://${BUCKET}/${PREFIX}/${id}/episode-1/`, '--region', REGION],
    { env: awsEnv(), encoding: 'utf8' },
  )
  if (r.status !== 0) return []
  const segs = []
  for (const line of (r.stdout || '').split('\n')) {
    const parts = line.trim().split(/\s+/)
    const key = parts[parts.length - 1]
    if (key && key.endsWith('.ts')) segs.push(key)
  }
  return segs
}

/**
 * 从分片里挑一帧做封面。
 * 直接抽帧（不做亮度过滤），保证一定出图 —— 缺失封面比黑图更糟。
 *
 * 竖版视频（1080x1920）不能直接 pad 到 720x1080：目标比输入小，
 * ffmpeg 会报 "Padded dimensions cannot be smaller than input dimensions"。
 * 所以竖版缩放到 720 宽（高度自然按比例），横版才 pad 成 720x1080。
 */
function extractFrame(segFile, outFile) {
  const r = spawnSync(
    'ffmpeg',
    [
      '-y', '-v', 'error', '-i', segFile,
      '-frames:v', '1',
      '-vf',
      'scale=720:-2:force_original_aspect_ratio=decrease,setsar=1',
      '-q:v', '3', outFile,
    ],
    { encoding: 'utf8' },
  )
  return r.status === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0
}

async function fixOne(id) {
  const segs = listSegments(id)
  if (!segs.length) return { id, ok: false, error: 'no-segments' }

  fs.mkdirSync(TMP, { recursive: true })
  const outFile = path.join(TMP, `${id}.jpg`)

  // 取几个不同位置的片，拿到第一张成功抽帧的
  const picks = [0, Math.floor(segs.length / 4), Math.floor(segs.length / 2), segs.length - 1]
  let done = false
  for (const idx of picks) {
    const key = segs[idx]
    if (!key) continue
    const segFile = path.join(TMP, `${id}-${idx}.ts`)
    const dl = spawnSync(
      'aws',
      ['s3', 'cp', `s3://${BUCKET}/${PREFIX}/${id}/episode-1/${key}`, segFile, '--region', REGION],
      { env: awsEnv(), encoding: 'utf8' },
    )
    if (dl.status !== 0) continue
    if (extractFrame(segFile, outFile)) { done = true; break }
    try { fs.unlinkSync(segFile) } catch { /* ignore */ }
  }
  if (!done) return { id, ok: false, error: 'frame-extract-failed' }

  if (values.apply) {
    const up = spawnSync(
      'aws',
      [
        's3', 'cp', outFile, `s3://${BUCKET}/${POSTER_PREFIX}/imported/${id}.jpg`,
        '--region', REGION, '--content-type', 'image/jpeg',
        '--cache-control', 'public, max-age=31536000,immutable',
      ],
      { env: awsEnv(), encoding: 'utf8' },
    )
    if (up.status !== 0) return { id, ok: false, error: `upload: ${up.stderr.slice(-200)}` }
  }

  // 本地也留一份，供前端直连 public/posters 使用
  const localDir = path.join(ROOT, 'public/posters/imported')
  fs.mkdirSync(localDir, { recursive: true })
  try { fs.copyFileSync(outFile, path.join(localDir, `${id}.jpg`)) } catch { /* ignore */ }

  try { fs.unlinkSync(outFile) } catch { /* ignore */ }
  return { id, ok: true }
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(UPLOADED, 'utf8'))
  const entries = Object.values(catalog.uploaded || {})
  const missing = entries.filter((e) => !e.cover)

  console.log(JSON.stringify({ mode: values.apply ? 'apply' : 'preview', total: entries.length, missing: missing.length }))

  if (!missing.length) return

  const fixed = []
  const failed = []
  for (const e of missing) {
    const r = await fixOne(e.id)
    if (r.ok) {
      e.cover = `/posters/imported/${e.id}.jpg`
      fixed.push(r.id)
      console.log(`OK   ${r.id}`)
    } else {
      failed.push(r)
      console.error(`FAIL ${r.id}: ${r.error}`)
    }
  }

  if (values.apply && fixed.length) {
    fs.writeFileSync(UPLOADED, `${JSON.stringify(catalog, null, 2)}\n`)
    console.log(`\n已修复 ${fixed.length} 条，清单已更新`)
  }
  if (failed.length) console.log(`\n失败 ${failed.length} 条`)
}

main().catch((e) => { console.error(e); process.exit(1) })
