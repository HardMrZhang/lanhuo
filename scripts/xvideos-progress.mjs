#!/usr/bin/env node
/**
 * XVIDEOS 流水线进度条：实时显示处理进度、速度、ETA、磁盘与失败数。
 *
 * 用法：
 *   node scripts/xvideos-progress.mjs          # 打印一次
 *   node scripts/xvideos-progress.mjs --watch  # 每 10 秒刷新（Ctrl-C 退出）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAP = path.join(ROOT, 'data/xvideos-import-map.json')
const UPLOADED = path.join(ROOT, 'data/xvideos-uploaded.json')
const LOG = process.env.XV_PROGRESS_LOG || '/tmp/xvpipeline.log'

const { values } = parseArgs({
  options: { watch: { type: 'boolean', default: false } },
})

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 从日志里解析成功/失败计数与日志最后修改时间 */
function parseLog() {
  let ok = 0
  let fail = 0
  let lastLine = ''
  let mtime = 0
  try {
    const text = fs.readFileSync(LOG, 'utf8')
    const lines = text.split('\n')
    for (const line of lines) {
      if (/\]\s+OK\s+/.test(line)) ok++
      else if (/\]\s+FAIL\s+/.test(line)) fail++
      if (/\]\s+(OK|FAIL)\s+/.test(line)) lastLine = line.trim()
    }
    mtime = fs.statSync(LOG).mtimeMs
  } catch { /* 日志还没生成 */ }
  return { ok, fail, lastLine, mtime }
}

/** 已完成时间戳：清单里的 uploadedAt */
function uploadedStats() {
  const data = readJson(UPLOADED, { uploaded: {} })
  const list = Object.values(data.uploaded || {})
  const times = list
    .map((e) => Date.parse(e.uploadedAt || e.publishedAt || ''))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)
  return { count: list.length, first: times[0] || 0, last: times[times.length - 1] || 0, times }
}

/** 本地磁盘剩余 */
function diskFreeGb() {
  try {
    const out = execFileSync('df', ['-k', ROOT], { encoding: 'utf8' })
    const lines = out.trim().split('\n')
    const cols = lines[lines.length - 1].trim().split(/\s+/)
    return Math.round((Number(cols[3]) / 1024 / 1024) * 10) / 10
  } catch { return null }
}

/** 本地待处理的源文件数与体积 */
function localSources() {
  const dir = path.join(ROOT, 'downloads/xvideos')
  let count = 0
  try {
    count = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')).length
  } catch { /* ignore */ }
  return count
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--:--'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

function bar(percent, width = 32) {
  const filled = Math.round((percent / 100) * width)
  const done = '█'.repeat(Math.min(filled, width))
  const rest = '░'.repeat(Math.max(0, width - filled))
  return `[${done}${rest}]`
}

/** 流水线进程是否存活：优先 pgrep，沙箱不允许时退回日志时间戳判断 */
function pipelineAlive(logMtime) {
  try {
    const out = execFileSync('pgrep', ['-f', 'xvideos-pipeline.mjs'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim().split('\n').filter(Boolean).length > 0
  } catch {
    // pgrep 不可用时，用日志最后更新时间兜底：3 分钟内有新产出即视为运行中
    return logMtime > 0 && Date.now() - logMtime < 180000
  }
}

function render() {
  const map = readJson(MAP, {})
  const total = Array.isArray(map) ? map.length : (map.works?.length ?? 0)
  const stats = uploadedStats()
  const log = parseLog()
  const done = stats.count
  const pct = total ? (done / total) * 100 : 0

  // 用最近 20 条的完成速率估算 ETA（排除早期慢速阶段，拉低估算值）
  const window = stats.times.slice(-20)
  const span = window.length > 1 ? (window[window.length - 1] - window[0]) / 1000 : 0
  const rate = window.length > 1 && span > 0 ? (window.length - 1) / span : 0
  const eta = rate > 0 ? (total - done) / rate : NaN

  const free = diskFreeGb()
  const remaining = localSources()
  const alive = pipelineAlive(log.mtime)

  console.clear()
  console.log('XVIDEOS → S3 → MySQL 流水线')
  console.log('─'.repeat(62))
  console.log(`${bar(pct)} ${pct.toFixed(1)}%  ${done}/${total}`)
  console.log('')
  console.log(`状态    ${alive ? '● 运行中' : '○ 已停止（重跑 npm run xvideos:pipeline 续跑）'}`)
  console.log(`失败    ${log.fail}`)
  console.log(`速度    ${rate > 0 ? (rate * 60).toFixed(1) + ' 条/分钟' : '统计中...'}`)
  console.log(`剩余    ${remaining} 个本地源文件待删`)
  console.log(`ETA     ${Number.isFinite(eta) ? fmtDuration(eta) : '--:--:--'}`)
  if (free !== null) console.log(`磁盘    ${free} GB 可用`)
  if (log.lastLine) console.log(`\n最近   ${log.lastLine.slice(0, 66)}`)
  console.log('─'.repeat(62))
}

if (values.watch) {
  render()
  setInterval(render, 10000)
} else {
  render()
}
