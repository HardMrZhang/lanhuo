import fs from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data/dramas.json')

export function mysqlConfig(env = process.env) {
  const database = env.MYSQL_DATABASE?.trim() || 'duanju_h5'
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) throw new Error('Invalid MYSQL_DATABASE')
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) throw new Error('Invalid MYSQL_DATABASE')
  return {
    host: env.MYSQL_HOST?.trim() || '127.0.0.1',
    port: Number(env.MYSQL_PORT) || 3306,
    user: env.MYSQL_USER?.trim() || 'root',
    password: env.MYSQL_PASSWORD ?? '',
    database,
  }
}

export const DRAMA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS categories (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(80) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS dramas (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  cover VARCHAR(1024) NULL,
  description MEDIUMTEXT NULL,
  tags JSON NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'completed',
  views INT NOT NULL DEFAULT 0,
  rating INT NOT NULL DEFAULT 0,
  published_at VARCHAR(64) NULL,
  channel_id VARCHAR(64) NULL,
  hd TINYINT(1) NOT NULL DEFAULT 0,
  episode_count INT NOT NULL DEFAULT 0,
  created_at BIGINT NULL,
  updated_at BIGINT NULL,
  INDEX idx_dramas_channel (channel_id),
  INDEX idx_dramas_status (status),
  INDEX idx_dramas_views (views),
  FULLTEXT INDEX ft_dramas_title_desc (title, description)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS episodes (
  drama_id VARCHAR(64) NOT NULL,
  no INT NOT NULL,
  title VARCHAR(255) NULL,
  src VARCHAR(1024) NOT NULL,
  duration DECIMAL(10,2) NULL,
  PRIMARY KEY (drama_id, no),
  CONSTRAINT fk_episodes_drama FOREIGN KEY (drama_id) REFERENCES dramas(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS drama_categories (
  drama_id VARCHAR(64) NOT NULL,
  category_id VARCHAR(64) NOT NULL,
  PRIMARY KEY (drama_id, category_id),
  CONSTRAINT fk_dc_drama FOREIGN KEY (drama_id) REFERENCES dramas(id) ON DELETE CASCADE,
  CONSTRAINT fk_dc_cat FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
`

export async function ensureDramaSchema(pool) {
  // mysql2 不支持多语句，逐条拆分执行
  for (const stmt of DRAMA_SCHEMA_SQL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await pool.query(stmt)
  }
}

export async function syncDramasToMysql(pool, { categories, dramas }) {
  const now = Date.now()
  for (const c of categories ?? []) {
    if (!c?.id) continue
    await pool.execute(
      'INSERT INTO categories (id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
      [String(c.id), String(c.name ?? c.id)],
    )
  }
  let epTotal = 0
  for (const d of dramas ?? []) {
    if (!d?.id) continue
    const tags = Array.isArray(d.tags) ? d.tags : []
    await pool.execute(
      `INSERT INTO dramas (id, title, cover, description, tags, status, views, rating, published_at, channel_id, hd, episode_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE title=VALUES(title), cover=VALUES(cover), description=VALUES(description), tags=VALUES(tags),
         status=VALUES(status), views=VALUES(views), rating=VALUES(rating), published_at=VALUES(published_at),
         channel_id=VALUES(channel_id), hd=VALUES(hd), episode_count=VALUES(episode_count), updated_at=VALUES(updated_at)`,
      [
        String(d.id),
        String(d.title ?? d.id),
        d.cover ?? null,
        d.description ?? null,
        JSON.stringify(tags),
        d.status ?? 'completed',
        Number(d.views ?? 0) || 0,
        Number(d.rating ?? 0) || 0,
        d.publishedAt ?? null,
        d.channelId ?? null,
        d.hd ? 1 : 0,
        (d.episodes ?? []).length,
        now,
        now,
      ],
    )
    // 先清后插，保证删除的集数也会同步掉
    await pool.execute('DELETE FROM episodes WHERE drama_id = ?', [String(d.id)])
    for (const e of d.episodes ?? []) {
      await pool.execute(
        'INSERT INTO episodes (drama_id, no, title, src, duration) VALUES (?, ?, ?, ?, ?)',
        [String(d.id), Number(e.no), e.title ?? `第${e.no}集`, e.src ?? '', e.duration ?? null],
      )
      epTotal++
    }
    await pool.execute('DELETE FROM drama_categories WHERE drama_id = ?', [String(d.id)])
    for (const cid of d.categoryIds ?? []) {
      try {
        await pool.execute('INSERT INTO drama_categories (drama_id, category_id) VALUES (?, ?)', [String(d.id), String(cid)])
      } catch (err) {
        // 分类不存在时先补分类再关联
        if (err?.code === 'ER_NO_REFERENCED_ROW_2' || err?.code === 'ER_FK') {
          await pool.execute('INSERT IGNORE INTO categories (id, name) VALUES (?, ?)', [String(cid), String(cid)])
          await pool.execute('INSERT IGNORE INTO drama_categories (drama_id, category_id) VALUES (?, ?)', [String(d.id), String(cid)])
        } else throw err
      }
    }
  }
  return { dramas: dramas?.length ?? 0, episodes: epTotal }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = mysqlConfig()
  const admin = await mysql.createConnection({
    host: config.host, port: config.port, user: config.user, password: config.password,
  })
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`)
  } finally {
    await admin.end()
  }
  const pool = mysql.createPool({ ...config, waitForConnections: true, connectionLimit: 10, supportBigNumbers: true })
  try {
    await ensureDramaSchema(pool)
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    const res = await syncDramasToMysql(pool, raw)
    const [[c]] = await pool.query('SELECT COUNT(*) n FROM categories')
    const [[d]] = await pool.query('SELECT COUNT(*) n FROM dramas')
    const [[e]] = await pool.query('SELECT COUNT(*) n FROM episodes')
    console.log(JSON.stringify({ ok: true, imported: res, mysql: { categories: Number(c.n), dramas: Number(d.n), episodes: Number(e.n) } }))
  } finally {
    await pool.end()
  }
}
