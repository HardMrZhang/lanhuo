#!/usr/bin/env node
/**
 * 按清单批量下载 XVIDEOS 视频（高清），文件名带标题。
 *
 * 用法：
 *   node scripts/xvideos-download.mjs \
 *     --playlist data/xvideos/playlist.json \
 *     --cookie data/xvideos/cookies.txt \
 *     --outDir downloads/xvideos
 *
 * 选项：
 *   --limit N        只下前 N 个
 *   --quality best   best（默认，最高清）| 1080 | 720
 *   --maxHeight 1080 限制最高分辨率
 *   --concurrency 3  并发下载数
 *   --retries 3      单个视频重试次数
 *   --force          即使文件已存在也重新下载（默认跳过）
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { repairNetscape } from './lib/xvideos-cookies.mjs'

const { values } = parseArgs({
  options: {
    playlist: { type: 'string', default: 'data/xvideos/playlist.json' },
    cookie: { type: 'string', default: 'data/xvideos/cookies.txt' },
    outDir: { type: 'string', default: 'downloads/xvideos' },
    limit: { type: 'string', default: '' },
    quality: { type: 'string', default: 'best' },
    maxHeight: { type: 'string', default: '' },
    concurrency: { type: 'string', default: '5' },
    retries: { type: 'string', default: '5' },
    delay: { type: 'string', default: '2000' },
    force: { type: 'boolean', default: false },
  },
})

const PLAYLIST = path.resolve(process.cwd(), values.playlist)
const COOKIE = path.resolve(process.cwd(), values.cookie)
const OUT_DIR = path.resolve(process.cwd(), values.outDir)
const CONCURRENCY = Math.max(1, Number(values.concurrency) || 5)
const RETRIES = Math.max(0, Number(values.retries) || 0)
const DELAY = Math.max(0, Number(values.delay) || 0)

if (!fs.existsSync(PLAYLIST)) {
  console.error(`清单不存在：${PLAYLIST}\n先运行：node scripts/xvideos-crawl.mjs --limit 1000`)
  process.exit(1)
}
if (!fs.existsSync(COOKIE)) {
  console.error(`Cookie 不存在：${COOKIE}\n先运行：node scripts/xvideos-login.mjs`)
  process.exit(1)
}

/**
 * 启动前自愈 cookie 文件格式。
 * 旧版脚本把第 2 列标志位写反，Python cookiejar 会抛 AssertionError，
 * yt-dlp 报 "invalid Netscape format cookies file"。这里自动对齐。
 */
function healCookieFile() {
  const original = fs.readFileSync(COOKIE, 'utf8')
  const { text, changed, total } = repairNetscape(original)
  if (changed > 0) {
    fs.writeFileSync(COOKIE, text)
    console.log(`已自动修复 Cookie 格式：${changed}/${total} 条记录被修正`)
  }
}
healCookieFile()

fs.mkdirSync(OUT_DIR, { recursive: true })

const manifest = JSON.parse(fs.readFileSync(PLAYLIST, 'utf8'))
let items = manifest.items || []
if (values.limit) items = items.slice(0, Number(values.limit))

/** 选择格式：优先高分辨率 mp4，其次 hls 最高码率 */
function formatArgs() {
  const maxHeight = values.maxHeight ? Number(values.maxHeight) : null
  const q = values.quality
  if (q === 'best') {
    return maxHeight
      ? ['-f', `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`]
      : ['-f', 'bestvideo+bestaudio/best']
  }
  if (q === '1080') return ['-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best']
  if (q === '720') return ['-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best']
  return ['-f', 'best']
}

const FMT = formatArgs()

function runYtDlp(args) {
  return new Promise((resolve) => {
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code, out, err }))
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }))
  })
}

/** 取标题，失败时退回 id */
async function titleOf(url) {
  const res = await runYtDlp([
    '--cookies', COOKIE,
    '--no-warnings',
    '--skip-download',
    '--print', '%(title)s',
    url,
  ])
  const t = (res.out || '').trim().split('\n').pop()
  return t && t.length > 3 ? t : null
}

function sanitize(name) {
  return String(name)
    .normalize('NFC')
    .replace(/[-<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120)
}

async function downloadOne(item, index, total) {
  const prefix = `[${index + 1}/${total}]`
  const title = await titleOf(item.url)
  const stem = sanitize(title || item.id)

  const target = path.join(OUT_DIR, `${stem} [${item.id}].mp4`)
  if (!values.force && fs.existsSync(target) && fs.statSync(target).size > 0) {
    console.log(`${prefix} 已存在，跳过：${stem}`)
    return { ok: true, skipped: true }
  }

  const baseArgs = [
    '--cookies', COOKIE,
    '--no-warnings',
    '--no-playlist',
    '--newline',
    '--merge-output-format', 'mp4',
    '--retries', '10',
    '--fragment-retries', '20',
    '--socket-timeout', '30',
    '-o', target,
    ...FMT,
  ]

  // 轮换 User-Agent：站点对同一 UA 的高频请求更容易断连
  const UAS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  ]

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const ua = UAS[attempt % UAS.length]
    const res = await runYtDlp([...baseArgs, '--user-agent', ua, item.url])
    if (res.code === 0) {
      const size = fs.existsSync(target) ? (fs.statSync(target).size / 1048576).toFixed(1) : '?'
      console.log(`${prefix} 完成：${stem} (${size} MB)`)
      return { ok: true }
    }
    const lastErr = (res.err || '').trim().split('\n').filter(Boolean).pop() || '未知错误'
    if (attempt < RETRIES) {
      // 指数退避：SSL 断连、限流等需要更长的冷却时间
      const backoff = Math.min(60, 5 * 2 ** attempt)
      console.log(
        `${prefix} 失败，重试 ${attempt + 1}/${RETRIES}（${backoff}s 后，换 UA）：${stem}\n  ${lastErr}`,
      )
      await new Promise((r) => setTimeout(r, backoff * 1000))
    } else {
      console.error(`${prefix} 放弃：${stem}\n  ${lastErr}`)
      return { ok: false }
    }
  }
  return { ok: false }
}

async function main() {
  console.log(`待下载 ${items.length} 个视频 -> ${OUT_DIR}`)
  console.log(`格式策略：${FMT.join(' ')}`)
  console.log(`并发：${CONCURRENCY}\n`)

  let done = 0
  let failed = 0
  const failedItems = []
  const queue = items.map((it, i) => ({ it, i }))

  async function worker() {
    while (queue.length) {
      const { it, i } = queue.shift()
      const r = await downloadOne(it, i, items.length)
      done++
      if (!r.ok) {
        failed++
        failedItems.push(it)
      }
      console.log(`--- 进度 ${done - failed}/${items.length} 成功，${failed} 失败 ---`)
      // 每个视频之间留出间隔，避免高频请求触发站点限流/SSL 断连
      if (DELAY) await new Promise((r2) => setTimeout(r2, DELAY))
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  // 把失败的视频单独写一份清单，方便之后单独补下
  if (failedItems.length) {
    const failedPath = path.resolve(path.dirname(PLAYLIST), 'failed.json')
    fs.writeFileSync(
      failedPath,
      JSON.stringify(
        {
          version: 1,
          generatedAt: new Date().toISOString(),
          count: failedItems.length,
          items: failedItems,
        },
        null,
        2,
      ),
    )
    console.log(`\n失败清单已写入：${failedPath}`)
  }

  console.log(`\n全部结束：成功 ${done - failed}，失败 ${failed}`)
  if (failed) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
