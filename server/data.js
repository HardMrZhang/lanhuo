import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DATA_FILE = process.env.DATA_FILE || path.resolve(__dirname, '../data/dramas.json')

/**
 * 读取并校验 data/dramas.json。
 * 结构：{ categories: Category[], dramas: Drama[] }
 * - episodes 若只给了 src 数组，会自动补 no。
 * - 每部剧按 no 排序，剔除未知分类。
 */
export function loadData() {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  const categories = Array.isArray(raw.categories) ? raw.categories : []
  const catIds = new Set(categories.map((c) => c.id))

  const dramas = (raw.dramas ?? []).map((d) => {
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
  fs.watch(DATA_FILE, () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        onChange()
      } catch (e) {
        console.error('[data] reload failed:', e.message)
      }
    }, 200)
  })
}
