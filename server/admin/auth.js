import express from 'express'
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

/** 管理员会话有效期：8 小时，够用一整个工作日。 */
const ADMIN_SESSION_AGE = 8 * 60 * 60 * 1000
const ADMIN_COOKIE = 'duanju_admin_session'

/** 角色：支付后台与推荐后台可以分别授权，也可以给全能管理员。 */
export const ADMIN_ROLES = ['payment', 'referral', 'super']

/**
 * 管理员账号与会话。
 *
 * 与前台会员账号（vip_users / vip_sessions）完全分开：
 * 后台不应该复用用户表的登录态，否则一个普通会员账号就能通过加字段提权。
 */
export async function initAdminSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id VARCHAR(36) PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL,
      display_name VARCHAR(80) NULL,
      enabled TINYINT NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL,
      last_login_at BIGINT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash CHAR(64) PRIMARY KEY,
      admin_id VARCHAR(36) NOT NULL,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      CONSTRAINT fk_admin_sessions_admin FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  for (const sql of [
    'CREATE INDEX idx_admin_sessions_expiry ON admin_sessions(expires_at)',
    'CREATE INDEX idx_admin_sessions_admin ON admin_sessions(admin_id)',
  ]) {
    try {
      await pool.query(sql)
    } catch (error) {
      if (error?.code !== 'ER_DUP_KEYNAME') throw error
    }
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = await scryptAsync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  return `${salt}:${hash.toString('hex')}`
}

async function checkPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false
  const [salt, value] = stored.split(':')
  if (!salt || !value) return false
  const hash = await scryptAsync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  const expected = Buffer.from(value, 'hex')
  return expected.length === hash.length && timingSafeEqual(expected, hash)
}

function normalizeRole(role) {
  const value = typeof role === 'string' ? role.trim().toLowerCase() : ''
  return ADMIN_ROLES.includes(value) ? value : null
}

export function normalizeAdmin(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    displayName: row.display_name ?? row.username,
    enabled: Number(row.enabled) === 1,
    createdAt: Number(row.created_at),
    lastLoginAt: row.last_login_at === null || row.last_login_at === undefined ? null : Number(row.last_login_at),
  }
}

/**
 * 创建管理员账号。
 *
 * 允许显式指定 id，便于脚本重复执行时保持同一个管理员（而不是每次插入新账号）。
 */
export async function createAdminUser(pool, { username, password, role = 'super', displayName = null, id = null }) {
  const name = typeof username === 'string' ? username.trim().toLowerCase() : ''
  if (!/^[a-z0-9_.-]{3,64}$/.test(name)) throw new Error('Invalid admin username')
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new Error('Invalid admin password')
  const effectiveRole = normalizeRole(role)
  if (!effectiveRole) throw new Error('Invalid admin role')
  const passwordHash = await hashPassword(password)
  const adminId = id ?? randomUUID()
  await pool.execute(
    'INSERT INTO admin_users (id, username, password_hash, role, display_name, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    [adminId, name, passwordHash, effectiveRole, displayName ? String(displayName).slice(0, 80) : null, Date.now()],
  )
  return normalizeAdmin(await pool.execute('SELECT * FROM admin_users WHERE id = ?', [adminId]).then(([rows]) => rows[0]))
}

/**
 * 管理员路由。
 *
 * @param {object} options
 * @param {import('mysql2/promise').Pool} options.pool 数据库连接池
 * @param {string[]} options.allowedRoles 允许访问该后台的角色
 * @param {string} options.cookieName 会话 Cookie 名（两个后台各自独立）
 * @param {boolean} [options.production] 生产环境（Cookie 加 Secure）
 */
export function createAdminAuth({ pool, allowedRoles, cookieName = ADMIN_COOKIE, production = false, logger = console }) {
  const roles = new Set((allowedRoles ?? []).map((role) => normalizeRole(role)).filter(Boolean))
  const unwrap = (row) => (Array.isArray(row) ? row[0] ?? null : row ?? null)

  const query = async (sql, ...args) => {
    const [rows] = await pool.execute(sql, args)
    return unwrap(rows) ?? null
  }
  const queryAll = async (sql, ...args) => {
    const [rows] = await pool.execute(sql, args)
    return Array.isArray(rows) ? rows : []
  }
  const run = async (sql, ...args) => {
    const [result] = await pool.execute(sql, args)
    return { changes: Number(result?.affectedRows ?? 0) }
  }

  const tokenHash = (token) => createHash('sha256').update(token).digest('hex')

  /** 从 Cookie 里取出原始 token。 */
  const readToken = (req) => {
    const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${cookieName}=([a-f0-9]{64})(?:;|$)`))
    return match ? match[1] : null
  }

  /** 查询当前登录的管理员；会话过期或账号被禁用都返回 null。 */
  const currentAdmin = async (req) => {
    const raw = readToken(req)
    if (!raw) return null
    const row = await query(
      `SELECT a.* FROM admin_users a JOIN admin_sessions s ON s.admin_id = a.id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
      tokenHash(raw),
      Date.now(),
    )
    if (!row) return null
    if (Number(row.enabled) !== 1) return null
    const admin = normalizeAdmin(row)
    if (!roles.has(admin.role) && admin.role !== 'super') return null
    return admin
  }

  const issueSession = async (res, adminId) => {
    const token = randomBytes(32).toString('hex')
    await run('INSERT INTO admin_sessions (token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      tokenHash(token), adminId, Date.now() + ADMIN_SESSION_AGE, Date.now())
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: production,
      sameSite: 'strict',
      path: '/',
      maxAge: ADMIN_SESSION_AGE,
    })
  }

  const destroySession = async (req, res) => {
    const raw = readToken(req)
    if (raw) await run('DELETE FROM admin_sessions WHERE token_hash = ?', tokenHash(raw))
    res.clearCookie(cookieName, { httpOnly: true, secure: production, sameSite: 'strict', path: '/' })
  }

  /** 登录失败计数：同一账号/IP 连续失败后短暂锁定，抑制撞库。 */
  const failures = new Map()
  const FAILURE_LIMIT = 5
  const LOCK_WINDOW = 15 * 60_000
  const failureKey = (req, username) => `${req.ip}|${username}`
  const noteFailure = (req, username) => {
    const key = failureKey(req, username)
    const entry = failures.get(key)
    if (!entry || entry.reset <= Date.now()) {
      failures.set(key, { count: 1, reset: Date.now() + LOCK_WINDOW })
      return
    }
    entry.count++
  }
  const isLocked = (req, username) => {
    const entry = failures.get(failureKey(req, username))
    return Boolean(entry && entry.reset > Date.now() && entry.count >= FAILURE_LIMIT)
  }
  const clearFailures = (req, username) => failures.delete(failureKey(req, username))

  const router = express.Router()
  router.use(express.json({ limit: '64kb' }))

  router.post('/login', async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : ''
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' })
    if (isLocked(req, username)) {
      return res.status(429).json({ error: '登录失败次数过多，请稍后再试' })
    }
    const row = await query('SELECT * FROM admin_users WHERE username = ?', username)
    // 未知账号也走一次哈希校验，避免通过响应时间探测用户名是否存在。
    const dummy = `${'0'.repeat(32)}:${'0'.repeat(128)}`
    const valid = await checkPassword(password, row?.password_hash || dummy)
    if (!row || !valid || Number(row.enabled) !== 1) {
      noteFailure(req, username)
      return res.status(401).json({ error: '用户名或密码错误' })
    }
    const admin = normalizeAdmin(row)
    if (!roles.has(admin.role) && admin.role !== 'super') {
      return res.status(403).json({ error: '当前账号无权访问该后台' })
    }
    clearFailures(req, username)
    await run('UPDATE admin_users SET last_login_at = ? WHERE id = ?', Date.now(), admin.id)
    await issueSession(res, admin.id)
    return res.json({ admin })
  })

  router.post('/logout', async (req, res) => {
    await destroySession(req, res)
    return res.json({ ok: true })
  })

  router.get('/me', async (req, res) => {
    const admin = await currentAdmin(req)
    if (!admin) return res.status(401).json({ error: '请先登录' })
    return res.json({ admin })
  })

  /** 需要登录的管理员接口。 */
  const requireAdmin = async (req, res, next) => {
    const admin = await currentAdmin(req)
    if (!admin) return res.status(401).json({ error: '请先登录' })
    req.admin = admin
    next()
  }
  // 暴露给上层：业务路由挂在鉴权中间件之后。
  router.__requireAdmin = requireAdmin
  router.__currentAdmin = currentAdmin

  /** 清理过期会话。 */
  router.__purgeSessions = () => run('DELETE FROM admin_sessions WHERE expires_at <= ?', Date.now()).catch(() => {})

  router.__query = query
  router.__queryAll = queryAll
  router.__run = run
  router.__logger = logger
  return router
}

/**
 * 跨站请求防护：后台接口只接受同源表单提交。
 * 后台是内部工具，不接受第三方站点发起的写操作。
 */
export function requireSameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  const origin = req.get('Origin')
  if (!origin) return next()
  // 反向代理（Nginx / Vite dev proxy）会把真实域名放在 X-Forwarded-Host，
  // 而 Host 头可能已经被改写成上游地址。两边都认，才不会把同源请求误判成跨站。
  const host = req.get('x-forwarded-host') || req.get('host')
  if (!host) return res.status(403).json({ error: '不允许跨站请求' })
  try {
    const own = new URL(origin)
    if (own.host !== host) return res.status(403).json({ error: '不允许跨站请求' })
  } catch {
    return res.status(403).json({ error: '不允许跨站请求' })
  }
  next()
}
