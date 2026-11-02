import mysql from 'mysql2/promise'

export function mysqlConfig(env = process.env) {
  const database = env.MYSQL_DATABASE?.trim() || 'duanju_h5'
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) throw new Error('Invalid MYSQL_DATABASE')
  return {
    host: env.MYSQL_HOST?.trim() || '127.0.0.1',
    port: Number(env.MYSQL_PORT) || 3306,
    user: env.MYSQL_USER?.trim() || 'root',
    password: env.MYSQL_PASSWORD ?? '',
    database,
  }
}

export function createDramaPool(env = process.env) {
  return mysql.createPool({
    ...mysqlConfig(env),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    supportBigNumbers: true,
  })
}

/**
 * 从 MySQL 读取短剧库，组装成与 data/dramas.json 完全同构的 { categories, dramas }。
 * 表结构由 scripts/init-mysql-dramas.mjs 创建：categories / dramas / episodes / drama_categories。
 */
export async function loadDramasFromMysql(pool) {
  const [catRows] = await pool.query('SELECT id, name FROM categories ORDER BY id')
  const [dramaRows] = await pool.query(
    'SELECT id, title, cover, description, tags, status, views, rating, published_at, channel_id, hd, episode_count FROM dramas ORDER BY id',
  )
  const [epRows] = await pool.query(
    'SELECT drama_id, `no`, title, src, duration FROM episodes ORDER BY drama_id, `no`',
  )
  const [dcRows] = await pool.query('SELECT drama_id, category_id FROM drama_categories ORDER BY drama_id, category_id')

  const categories = catRows.map((r) => ({ id: String(r.id), name: String(r.name) }))
  const catIds = new Set(categories.map((c) => c.id))

  const epsByDrama = new Map()
  for (const r of epRows) {
    const id = String(r.drama_id)
    if (!epsByDrama.has(id)) epsByDrama.set(id, [])
    epsByDrama.get(id).push({
      no: Number(r.no),
      title: r.title ?? `第${r.no}集`,
      src: String(r.src ?? ''),
      ...(r.duration === null || r.duration === undefined ? {} : { duration: Number(r.duration) }),
    })
  }
  const catsByDrama = new Map()
  for (const r of dcRows) {
    const id = String(r.drama_id)
    if (!catsByDrama.has(id)) catsByDrama.set(id, [])
    catsByDrama.get(id).push(String(r.category_id))
  }

  const parseTags = (value) => {
    if (Array.isArray(value)) return value.map(String)
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed.map(String) : []
      } catch { return [] }
    }
    return []
  }

  const dramas = dramaRows.map((r) => {
    const id = String(r.id)
    return {
      id,
      title: String(r.title ?? id),
      cover: r.cover ?? '',
      description: r.description ?? '',
      tags: parseTags(r.tags),
      status: r.status ?? 'completed',
      views: Number(r.views ?? 0) || 0,
      rating: Number(r.rating ?? 0) || 0,
      ...(r.published_at ? { publishedAt: String(r.published_at) } : {}),
      ...(r.channel_id ? { channelId: String(r.channel_id) } : {}),
      categoryIds: (catsByDrama.get(id) ?? []).filter((cid) => catIds.has(cid)),
      hd: Boolean(r.hd),
      episodes: (epsByDrama.get(id) ?? []).sort((a, b) => a.no - b.no),
    }
  })

  return { categories, dramas }
}
