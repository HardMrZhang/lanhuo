#!/usr/bin/env node
/**
 * 抓取 XVIDEOS 首页（Newest 排序）前 N 个视频链接，输出为 JSON 清单。
 *
 * 用法：
 *   node scripts/xvideos-crawl.mjs --limit 1000 --out data/xvideos/playlist.json
 *
 * 说明：
 *   - 列表页分页地址形如 /new/0、/new/1、/new/2 ...（首页等价于 /new/0）
 *   - 每页约 27~48 个视频，按需翻页直到凑够 limit 或没有新条目
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const { values } = parseArgs({
  options: {
    limit: { type: 'string', default: '1000' },
    out: { type: 'string', default: 'data/xvideos/playlist.json' },
    maxPages: { type: 'string', default: '120' },
    cookie: { type: 'string', default: '' },
    delay: { type: 'string', default: '1200' },
  },
})

const LIMIT = Math.max(1, Number(values.limit) || 1000)
const MAX_PAGES = Math.max(1, Number(values.maxPages) || 120)
const DELAY = Math.max(0, Number(values.delay) || 0)
const OUT = path.resolve(process.cwd(), values.out)

/** 从 HTML 中提取 /video.<id>/<slug> 形式的链接，保持页面出现顺序并去重 */
export function extractVideoLinks(html) {
  const seen = new Set()
  const out = []
  const re = /href="\/video\.([a-z0-9]+)\/([^"?#]*)"/g
  let m
  while ((m = re.exec(html))) {
    const id = m[1]
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      url: `https://www.xvideos.com/video.${id}/${m[2] || ''}`,
    })
  }
  return out
}

async function fetchPage(pageIndex, cookie) {
  const url = pageIndex === 0 ? 'https://www.xvideos.com/' : `https://www.xvideos.com/new/${pageIndex}`
  const headers = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
  if (cookie) headers.Cookie = cookie
  const res = await fetch(url, { headers, redirect: 'follow' })
  if (!res.ok) throw new Error(`列表页请求失败 ${res.status}：${url}`)
  return res.text()
}

async function main() {
  const cookie = values.cookie ? fs.readFileSync(values.cookie, 'utf8') : ''
  const seen = new Set()
  const items = []
  let pages = 0

  for (let p = 0; p < MAX_PAGES && items.length < LIMIT; p++) {
    let html
    try {
      html = await fetchPage(p, cookie)
    } catch (err) {
      console.error(`[第 ${p + 1} 页] ${err.message}`)
      break
    }
    pages++
    const links = extractVideoLinks(html)
    let added = 0
    for (const item of links) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
      added++
      if (items.length >= LIMIT) break
    }
    console.error(`[第 ${p + 1} 页] 抓到 ${links.length} 个，新增 ${added} 个，累计 ${items.length}/${LIMIT}`)
    if (links.length === 0) break
    if (DELAY) await new Promise((r) => setTimeout(r, DELAY))
  }

  const manifest = {
    version: 1,
    source: 'xvideos-home',
    generatedAt: new Date().toISOString(),
    pages,
    count: items.length,
    items,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2))
  console.error(`已写入 ${OUT}，共 ${items.length} 个视频（抓取 ${pages} 页）`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
