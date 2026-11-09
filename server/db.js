import mysql from 'mysql2/promise'

/** MySQL 连接配置；与 server/dramas-db.js 保持一致。 */
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

/** 确保目标数据库存在（幂等）。 */
export async function ensureDatabase(config) {
  const admin = await mysql.createConnection({
    host: config.host, port: config.port, user: config.user, password: config.password,
  })
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`)
  } finally {
    await admin.end()
  }
}

/**
 * 共享连接池。
 *
 * 会员、邀请、两个后台都跑在同一个 MySQL 库里，共用一个池避免连接数膨胀。
 */
export function createSharedPool(env = process.env) {
  const config = mysqlConfig(env)
  return mysql.createPool({
    ...config,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    supportBigNumbers: true,
  })
}
