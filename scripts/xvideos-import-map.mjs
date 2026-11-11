#!/usr/bin/env node
/**
 * 把 downloads/xvideos 下的 mp4 映射成入库清单（data/xvideos-import-map.json）。
 *
 * 命名与 id：
 *   - id   = xv-<xvideos 视频 id>，例如 xv-oluktcb47fb
 *   - 文件名格式：<标题> [<id>].mp4，id 用中括号提取
 *   - 标题去掉尾部 " [id]" 后缀，作为剧名展示
 *
 * 每个 mp4 = 一部单集剧（episodes 只有第 1 集）。
 *
 * 用法：
 *   node scripts/xvideos-import-map.mjs                    # 生成
 *   node scripts/xvideos-import-map.mjs --limit 20         # 只取前 20 个
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VIDEO_DIR = path.join(ROOT, 'downloads/xvideos')
const OUT_FILE = path.join(ROOT, 'data/xvideos-import-map.json')

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: VIDEO_DIR },
    out: { type: 'string', default: OUT_FILE },
    limit: { type: 'string', default: '0' },
  },
})

const videoDir = path.resolve(values.dir)
if (!fs.existsSync(videoDir)) throw new Error(`视频目录不存在：${videoDir}`)

/** 从文件名尾部提取 xvideos id：xxx [oluktcb47fb].mp4 */
const ID_RE = /\s*\[([a-z0-9]{8,})\]\.mp4$/i

const works = []
const skipped = []

for (const name of fs.readdirSync(videoDir).sort()) {
  if (!name.toLowerCase().endsWith('.mp4')) continue
  // 跳过未完成的分片残留
  if (name.includes('.part') || name.endsWith('.ytdl')) continue

  const m = ID_RE.exec(name)
  if (!m) {
    skipped.push({ name, reason: '文件名缺少 [id]' })
    continue
  }
  const id = m[1]
  const title = name.slice(0, m.index).trim()
  if (!title) {
    skipped.push({ name, reason: '标题为空' })
    continue
  }

  works.push({
    id: `xv-${id}`,
    xvId: id,
    title,
    file: path.join(videoDir, name),
    source: 'xvideos',
  })
}

const limit = Number(values.limit) || 0
const finalWorks = limit > 0 ? works.slice(0, limit) : works

const payload = {
  generatedAt: new Date().toISOString(),
  videoDir,
  stats: {
    files: works.length + skipped.length,
    mapped: works.length,
    skipped: skipped.length,
    episodes: works.length,
  },
  works: finalWorks,
  skipped: skipped.slice(0, 50),
}

fs.mkdirSync(path.dirname(values.out), { recursive: true })
fs.writeFileSync(values.out, `${JSON.stringify(payload, null, 2)}\n`)
console.log(JSON.stringify({ out: values.out, ...payload.stats, limit: limit || null }, null, 2))
