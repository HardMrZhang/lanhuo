import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DATA_FILE = process.env.DATA_FILE || path.resolve(__dirname, '../data/dramas.json')
const importChannels = new Set(['shorts', 'anime', 'western', 'videos'])

/**
 * 读取并校验 data/dramas.json。
 * 结构：{ categories: Category[], dramas: Drama[] }
 * - episodes 若只给了 src 数组，会自动补 no。
 * - 每部剧按 no 排序，剔除未知分类。
 * - 显式 channelId 仅接受导入支持的栏目，保留用于前端严格匹配。
 */
export function loadData() {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  const categories = Array.isArray(raw.categories) ? raw.categories : []
  const catIds = new Set(categories.map((c) => c.id))

  const dramas = (raw.dramas ?? []).map((d) => {
    if (d.channelId !== undefined && !importChannels.has(d.channelId)) {
      throw new Error(`Invalid channelId for drama ${d.id ?? '(unknown)'}: ${d.channelId}`)
    }
    const episodes = (d.episodes ?? [])
      .map((e, i) => (typeof e === 'string' ? { no: i + 1, src: e } : { no: e.no ?? i + 1, ...e }))
      .sort((a, b) => a.no - b.no)
    return {
      status: 'completed',
      tags: [],
      ...d,
      categoryIds: (d.categoryIds ?? []).filter((id) => catIds.has(id)),
      episodes,
    }
  })

  return { categories, dramas }
}

/** 文件变更时热重载（开发期改 JSON 不用重启） */
export function watchData(onChange) {
  let timer
  const dataName = path.basename(DATA_FILE)
  let watcher
  try {
    // 原子写入会替换文件 inode，监听父目录才能持续接收后续 rename。
    // data/ 下 backups 很多时监听目录可能 EMFILE，打不开监听就跳过热重载。
    watcher = fs.watch(path.dirname(DATA_FILE), (_event, filename) => {
      if (filename && filename.toString() !== dataName) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        try {
          onChange()
        } catch (e) {
          console.error('[data] reload failed:', e.message)
        }
      }, 200)
    })
  } catch (e) {
    console.warn('[data] watch disabled:', e.message)
    return { close() {}, on() {}, unref() {} }
  }
  watcher.on('error', (e) => console.warn('[data] watch error:', e.message))
  watcher.on('close', () => clearTimeout(timer))
  return watcher
}
