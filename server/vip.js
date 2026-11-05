import express from 'express'
import mysql from 'mysql2/promise'
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { createMailer, resetEmail, verificationEmail } from './mail.js'
import { createCaptchaChallenge, normalizeCaptcha } from './captcha.js'

const scryptAsync = promisify(scrypt)
const DAY = 86_400_000
const SESSION_AGE = 30 * DAY
const COOKIE = 'duanju_session'
const DEFAULT_PLANS = [
  { id: 'month', name: '月度会员', days: 30, price: 10, currency: 'USDT', recommended: false },
  { id: 'halfyear', name: '半年会员', days: 180, price: 20, currency: 'USDT', recommended: true },
  { id: 'year', name: '年度会员', days: 365, price: 20, currency: 'USDT', recommended: false },
]

function loadPlans(value) {
  const plans = value ? JSON.parse(value) : DEFAULT_PLANS
  if (!Array.isArray(plans) || !plans.length || plans.length > 12) throw new Error('VIP_PLANS_JSON must contain 1–12 plans')
  const ids = new Set()
  return plans.map((plan) => {
    if (!plan || !/^[a-z0-9_-]{1,40}$/.test(plan.id) || ids.has(plan.id) ||
      typeof plan.name !== 'string' || !plan.name.trim() || plan.name.length > 80 ||
      !Number.isInteger(plan.days) || plan.days < 1 || plan.days > 3650 ||
      typeof plan.price !== 'number' || !Number.isFinite(plan.price) || plan.price < 1 || plan.price > 100_000 ||
      Math.abs(plan.price * 100 - Math.round(plan.price * 100)) > 1e-7 ||
      (plan.currency && plan.currency !== 'USDT')) throw new Error('Invalid VIP_PLANS_JSON plan')
    ids.add(plan.id)
    return { id: plan.id, name: plan.name.trim(), days: plan.days, price: plan.price, currency: 'USDT', recommended: plan.recommended === true }
  })
}

function loadVaehubRates(value) {
  if (!value) return {}
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('VAEHUB_USDT_RATES_JSON must be valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('VAEHUB_USDT_RATES_JSON must be valid JSON')
  const rates = {}
  for (const [code, rate] of Object.entries(parsed)) {
    if (!/^[A-Z]{3,10}$/.test(code) || typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 1_000_000) {
      throw new Error('Invalid VAEHUB_USDT_RATES_JSON rate')
    }
    rates[code] = rate
  }
  return rates
}

function publicOrigin(value, sandbox) {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(sandbox && loopback && url.protocol === 'http:')) return null
    return url.origin
  } catch { return null }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
  }
  return value
}

// Compare provider decimal amounts exactly, including small crypto quantities.
function decimal(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value)
  if (text.length > 100) return null
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text)
  if (!match) return null
  const exponent = Number(match[3] || 0)
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) return null
  let units = BigInt(match[1] + (match[2] || ''))
  let scale = (match[2] || '').length - exponent
  if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0 }
  return { units, scale }
}

function compareAmounts(a, b) {
  const left = decimal(a)
  const right = decimal(b)
  if (!left || !right) return null
  const scale = Math.max(left.scale, right.scale)
  const difference = left.units * 10n ** BigInt(scale - left.scale) - right.units * 10n ** BigInt(scale - right.scale)
  return difference < 0n ? -1 : difference > 0n ? 1 : 0
}

function providerId(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const id = String(value)
  return /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : null
}

function providerExpiry(value) {
  if (!value) return null
  let date
  if (typeof value === 'number') date = new Date(value < 1e12 ? value * 1000 : value)
  else if (typeof value === 'string') {
    const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value}Z` : value
    date = new Date(timestamp)
  }
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function httpsUrl(value) {
  if (typeof value !== 'string' || !value.length || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch { return null }
}

/** VaeHub 接口地址需包含协议与路径（如 https://example.top/api），末尾斜杠会被去掉。 */
function vaehubBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch { return null }
}

function vaehubAuthHeader(config, timestamp, nonce) {
  const signature = createHash('sha256').update(`${config.appKey}${timestamp}${nonce}${config.appSecret}`).digest('hex')
  return `Bearer ${Buffer.from(`${config.appTag}:${timestamp}:${config.appKey}:${nonce}:${signature}`, 'utf8').toString('base64')}`
}

/**
 * 校验 VaeHub 回调的 Authorization Token（与请求签名同一机制）。
 * 校验通过返回解析出的随机串，用于后续重放判定；失败返回 null。
 */
function verifyVaehubToken(header, config, nowMs) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
  let raw
  try {
    raw = Buffer.from(header.slice('Bearer '.length).trim(), 'base64').toString('utf8')
  } catch { return null }
  const parts = raw.split(':')
  if (parts.length !== 5) return null
  const [tag, timestamp, appKey, nonce, signature] = parts
  if (!tag || !/^\d{1,12}$/.test(timestamp) || !appKey || !nonce || !nonce.length || nonce.length > 128 ||
    !/^[a-f0-9]{64}$/i.test(signature)) return null
  if (Math.abs(nowMs - Number(timestamp) * 1000) > 600_000) return null
  if (appKey !== config.appKey) return null
  const expected = createHash('sha256').update(`${appKey}${timestamp}${nonce}${config.appSecret}`).digest('hex')
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature.toLowerCase(), 'hex'))) return null
  return { nonce }
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = await scryptAsync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  return `${salt}:${hash.toString('hex')}`
}

async function checkPassword(password, stored) {
  const [salt, value] = stored.split(':')
  const hash = await scryptAsync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  const expected = Buffer.from(value, 'hex')
  return expected.length === hash.length && timingSafeEqual(expected, hash)
}

function credentials(body) {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = body?.password
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    typeof password !== 'string' || password.length < 8 || password.length > 128) return null
  return { email, password }
}

/** Mounted at /api. No browser redirect or client-supplied status grants membership. */
function mysqlConfig(env) {
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

const numOrNull = (value) => (value === null || value === undefined ? null : Number(value))

function normalizeUser(row) {
  if (!row) return null
  return {
    ...row,
    vip_expires_at: numOrNull(row.vip_expires_at),
    created_at: Number(row.created_at),
    email_verified: row.email_verified === null || row.email_verified === undefined ? 1 : Number(row.email_verified),
  }
}

function normalizeOrder(row) {
  if (!row) return null
  return {
    ...row,
    days: Number(row.days),
    amount_cents: Number(row.amount_cents),
    created_at: Number(row.created_at),
    paid_at: numOrNull(row.paid_at),
    refunded_at: numOrNull(row.refunded_at),
    pay_amount: row.pay_amount === null || row.pay_amount === undefined ? null : Number(row.pay_amount),
  }
}

async function ensureDatabase(config) {
  const admin = await mysql.createConnection({
    host: config.host, port: config.port, user: config.user, password: config.password,
  })
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`)
  } finally {
    await admin.end()
  }
}

async function initSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vip_users (
      id VARCHAR(36) PRIMARY KEY,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      vip_expires_at BIGINT NULL,
      created_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  // 邮箱验证状态：默认 1 让存量账号直接视为已验证；新注册时显式写入 0。
  for (const sql of [
    'ALTER TABLE vip_users ADD COLUMN email_verified TINYINT NOT NULL DEFAULT 1',
  ]) {
    try {
      await pool.query(sql)
    } catch (error) {
      if (error?.code !== 'ER_DUP_FIELDNAME') throw error
    }
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vip_auth_tokens (
      id CHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      kind VARCHAR(20) NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at BIGINT NOT NULL,
      used_at BIGINT NULL,
      created_at BIGINT NOT NULL,
      CONSTRAINT fk_auth_tokens_user FOREIGN KEY (user_id) REFERENCES vip_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vip_sessions (
      token_hash CHAR(64) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      expires_at BIGINT NOT NULL,
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES vip_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vip_orders (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      idempotency_key VARCHAR(128) NOT NULL,
      plan_id VARCHAR(40) NOT NULL,
      plan_name VARCHAR(80) NOT NULL,
      days INT NOT NULL,
      amount_cents INT NOT NULL,
      status VARCHAR(20) NOT NULL,
      created_at BIGINT NOT NULL,
      paid_at BIGINT NULL,
      refunded_at BIGINT NULL,
      checkout_url VARCHAR(2048) NULL,
      invoice_id VARCHAR(100) NULL UNIQUE,
      review_reason VARCHAR(128) NULL,
      payment_id VARCHAR(100) NULL UNIQUE,
      pay_address VARCHAR(64) NULL,
      pay_amount DECIMAL(20,8) NULL,
      pay_currency VARCHAR(10) NULL,
      payment_expires_at VARCHAR(64) NULL,
      provider VARCHAR(20) NULL,
      qr_string TEXT NULL,
      qr_expires_at VARCHAR(64) NULL,
      UNIQUE KEY uq_orders_user_key (user_id, idempotency_key),
      CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES vip_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vip_provider_payments (
      payment_id VARCHAR(100) PRIMARY KEY,
      order_id VARCHAR(36) NOT NULL,
      invoice_id VARCHAR(100) NOT NULL,
      last_status VARCHAR(80) NOT NULL,
      expected_amount VARCHAR(100) NULL,
      actual_amount VARCHAR(100) NULL,
      updated_at BIGINT NOT NULL,
      CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES vip_orders(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vip_vaehub_nonces (
      nonce VARCHAR(128) PRIMARY KEY,
      created_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  // MySQL 不支持 CREATE INDEX IF NOT EXISTS，重复建索引时忽略重名错误。
  for (const sql of [
    'CREATE INDEX idx_sessions_expiry ON vip_sessions(expires_at)',
    'CREATE INDEX idx_orders_user_created ON vip_orders(user_id, created_at DESC)',
    'CREATE INDEX idx_nonces_created ON vip_vaehub_nonces(created_at)',
    'CREATE INDEX idx_auth_tokens_user_kind ON vip_auth_tokens(user_id, kind)',
    'CREATE INDEX idx_auth_tokens_expiry ON vip_auth_tokens(expires_at)',
  ]) {
    try {
      await pool.query(sql)
    } catch (error) {
      if (error?.code !== 'ER_DUP_KEYNAME') throw error
    }
  }
}

export async function createVipRouter({
  dbPath, pool: injectedPool, env = process.env, fetchImpl = globalThis.fetch, now = Date.now,
  mail: injectedMail, captcha: injectedCaptcha, logger = console,
} = {}) {
  void dbPath
  const plans = loadPlans(env.VIP_PLANS_JSON)
  const production = env.NODE_ENV === 'production'
  const sandbox = env.NOWPAYMENTS_SANDBOX === 'true'
  const appOrigin = publicOrigin(env.APP_URL, sandbox)
  const apiKey = env.NOWPAYMENTS_API_KEY?.trim()
  const ipnSecret = env.NOWPAYMENTS_IPN_SECRET?.trim()
  const enabled = Boolean(apiKey && ipnSecret && appOrigin)
  const apiBase = sandbox ? 'https://api-sandbox.nowpayments.io/v1' : 'https://api.nowpayments.io/v1'
  // VaeHub 支付通道（可选，与 NOWPayments 并存）。接口地址与签名密钥找商务获取。
  const vaehubBase = vaehubBaseUrl(env.VAEHUB_API_BASE)
  const vaehubAppTag = env.VAEHUB_APP_TAG?.trim() || 'project'
  const vaehubAppKey = env.VAEHUB_APP_KEY?.trim()
  const vaehubAppSecret = env.VAEHUB_APP_SECRET?.trim()
  const vaehubCurrency = /^[A-Z]{3,10}$/.test(env.VAEHUB_CURRENCY?.trim() || '') ? env.VAEHUB_CURRENCY.trim() : 'USD'
  const vaehubCountry = /^[A-Za-z]{3}$/.test(env.VAEHUB_COUNTRY?.trim() || '') ? env.VAEHUB_COUNTRY.trim().toUpperCase() : ''
  const vaehubPaycode = /^[a-zA-Z0-9_-]{1,64}$/.test(env.VAEHUB_PAYCODE?.trim() || '') ? env.VAEHUB_PAYCODE.trim() : ''
  const vaehubReturnType = env.VAEHUB_RETURN_TYPE === 'qrcode' ? 'qrcode' : 'cashier'
  // VaeHub 做法币代收：USDT 套餐价按配置的汇率换成法币金额（小数点后两位向上取整）。
  const vaehubRates = loadVaehubRates(env.VAEHUB_USDT_RATES_JSON)
  const vaehub = vaehubBase && vaehubAppKey && vaehubAppSecret && vaehubCountry && vaehubRates[vaehubCurrency] ? {
    base: vaehubBase, appTag: vaehubAppTag, appKey: vaehubAppKey, appSecret: vaehubAppSecret,
    currency: vaehubCurrency, country: vaehubCountry, paycode: vaehubPaycode, returnType: vaehubReturnType,
    rate: vaehubRates[vaehubCurrency],
  } : null
  const providers = []
  if (enabled) providers.push({ id: 'nowpayments', name: 'NOWPayments' })
  if (vaehub) providers.push({ id: 'vaehub', name: 'VaeHub' })
  // 账号增强能力：邮件、图形验证码、第三方登录。三者都按配置自动启用/关闭。
  const mail = injectedMail || createMailer(env, { logger })
  const captcha = injectedCaptcha || { enabled: true, issue: createCaptchaChallenge }
  const authOrigin = appOrigin || (env.APP_URL?.trim().replace(/\/+$/, '') || '')
  // 邮件、找回密码链接需要可达的站点地址，缺失时无法发送带链接的邮件。
  const mailLinksEnabled = mail.enabled && Boolean(authOrigin)
  // AUTH_CAPTCHA=off 可关闭图形验证码（仅建议在开发或内网环境使用）。
  const captchaRequired = env.AUTH_CAPTCHA !== 'off' && captcha.enabled !== false
  const dbConfig = mysqlConfig(env)
  if (!injectedPool) await ensureDatabase(dbConfig)
  const pool = injectedPool || mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // BIGINT 以字符串返回时统一由 normalize* 转回数字，避免精度语义漂移。
    supportBigNumbers: true,
  })
  await initSchema(pool)
  const unwrap = (row) => (Array.isArray(row) ? row[0] ?? null : row ?? null)
  const query = async (sql, ...args) => {
    const [rows] = await pool.execute(sql, args)
    return unwrap(rows) ?? null
  }
  query.all = async (sql, ...args) => {
    const [rows] = await pool.execute(sql, args)
    return Array.isArray(rows) ? rows : []
  }
  const run = async (sql, ...args) => {
    const [result] = await pool.execute(sql, args)
    return { changes: Number(result?.affectedRows ?? 0) }
  }
  const transaction = async (fn) => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const queryTx = async (sql, ...args) => {
        const [rows] = await conn.execute(sql, args)
        return (Array.isArray(rows) ? rows[0] : rows) ?? null
      }
      queryTx.all = async (sql, ...args) => {
        const [rows] = await conn.execute(sql, args)
        return Array.isArray(rows) ? rows : []
      }
      const runTx = async (sql, ...args) => {
        const [result] = await conn.execute(sql, args)
        return { changes: Number(result?.affectedRows ?? 0) }
      }
      const result = await fn({ query: queryTx, run: runTx })
      await conn.commit()
      return result
    } catch (error) {
      try { await conn.rollback() } catch { /* ignore rollback errors */ }
      throw error
    } finally {
      conn.release()
    }
  }
  const userView = (user) => user ? {
    id: user.id, email: user.email,
    vipActive: Boolean(user.vip_expires_at && user.vip_expires_at > now()),
    vipExpiresAt: user.vip_expires_at ? new Date(user.vip_expires_at).toISOString() : null,
    // 老账号没有 email_verified 记录时按已验证处理，避免上线后老用户被锁。
    emailVerified: Number(user.email_verified ?? 1) === 1,
  } : null
  const orderView = (order) => {
    const provider = order.provider === 'vaehub' ? 'vaehub' : 'nowpayments'
    const network = provider === 'vaehub'
      ? `${vaehub?.currency || order.pay_currency || 'USDT'} · ${vaehub?.country || ''}`.trim()
      : 'TRON / TRC20'
    return {
      id: order.id, planId: order.plan_id, planName: order.plan_name, days: order.days,
      amount: order.amount_cents / 100, currency: 'USDT', status: order.status, provider,
      createdAt: new Date(order.created_at).toISOString(),
      paidAt: order.paid_at === null ? null : new Date(order.paid_at).toISOString(),
      checkoutUrl: provider === 'vaehub' ? (order.checkout_url || null) : null,
      payAddress: order.pay_address, payAmount: order.pay_amount, payCurrency: order.pay_currency,
      qrString: provider === 'vaehub' ? (order.qr_string || null) : null,
      qrExpiresAt: provider === 'vaehub' && order.qr_expires_at ? order.qr_expires_at : null,
      network, expiresAt: order.payment_expires_at,
    }
  }
  const sessionToken = (req) => {
    const match = (req.headers.cookie || '').match(/(?:^|;\s*)duanju_session=([a-f0-9]{64})(?:;|$)/)
    return match ? createHash('sha256').update(match[1]).digest('hex') : null
  }
  const getUser = async (req) => {
    const hash = sessionToken(req)
    if (!hash) return null
    const row = await query('SELECT u.* FROM vip_users u JOIN vip_sessions s ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ?', hash, now())
    return normalizeUser(row)
  }
  const cookieOptions = { httpOnly: true, secure: production, sameSite: 'lax', path: '/', maxAge: SESSION_AGE }
  const issueSession = async (req, res, userId) => {
    const token = randomBytes(32).toString('hex')
    await transaction(async ({ run: runTx }) => {
      const old = sessionToken(req)
      if (old) await runTx('DELETE FROM vip_sessions WHERE token_hash = ?', old)
      await runTx('DELETE FROM vip_sessions WHERE expires_at <= ?', now())
      await runTx('INSERT INTO vip_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', createHash('sha256').update(token).digest('hex'), userId, now() + SESSION_AGE)
    })
    res.cookie(COOKIE, token, cookieOptions)
  }
  const limits = new Map()
  const rateLimit = (scope, limit, duration) => (req, res, next) => {
    const time = now()
    if (limits.size > 5000) for (const [key, entry] of limits) if (entry.reset <= time) limits.delete(key)
    const key = `${scope}:${scope === 'auth' ? req.ip : req.vipUser?.id || req.ip}`
    let entry = limits.get(key)
    if (!entry || entry.reset <= time) { entry = { count: 0, reset: time + duration }; limits.set(key, entry) }
    if (++entry.count > limit) return res.status(429).set('Retry-After', String(Math.ceil((entry.reset - time) / 1000))).json({ error: '操作过于频繁，请稍后再试' })
    next()
  }
  const requireUser = (req, res, next) => req.vipUser ? next() : res.status(401).json({ error: '请先登录' })
  // 未验证邮箱的账号不能付费开通会员，避免用无法收信的邮箱下单。
  const requireVerified = (req, res, next) => {
    if (!req.vipUser) return res.status(401).json({ error: '请先登录' })
    if (Number(req.vipUser.email_verified ?? 1) !== 1) {
      return res.status(403).json({ error: '请先验证邮箱后再开通会员', needsVerification: true })
    }
    next()
  }
  const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  const asyncMiddleware = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  const router = express.Router()
  router.close = async () => { if (!injectedPool) await pool.end() }
  router.getUser = async (req) => userView(await getUser(req))
  /** 服务端媒体鉴权：仅凭有效会话且会员未过期才返回 true。 */
  router.isVip = async (req) => {
    const user = await getUser(req)
    return Boolean(user?.vip_expires_at && user.vip_expires_at > now())
  }
  router.plans = plans

  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || req.path === '/payments/nowpayments/ipn' || req.path === '/payments/vaehub/notify') return next()
    if (req.get('Sec-Fetch-Site') === 'cross-site') return res.status(403).json({ error: '不允许跨站请求' })
    const allowed = new Set(appOrigin ? [appOrigin] : [])
    // Authentication remains available without payment credentials. Production is
    // normally behind a TLS proxy, so use HTTPS without trusting forwarded headers.
    const host = req.get('host')
    if (host) {
      try {
        const ownOrigin = new URL(`${production ? 'https' : req.protocol}://${host}`)
        if (!ownOrigin.username && !ownOrigin.password && ownOrigin.pathname === '/' && !ownOrigin.search && !ownOrigin.hash) allowed.add(ownOrigin.origin)
      } catch { /* Malformed Host cannot authorize a browser origin. */ }
    }
    if (!production) {
      allowed.add('http://localhost:5173')
      allowed.add('http://127.0.0.1:5173')
    }
    const origin = req.get('Origin')
    if (origin && !allowed.has(origin)) return res.status(403).json({ error: '不允许跨站请求' })
    if (!req.is('application/json')) return res.status(415).json({ error: '请使用 JSON 请求' })
    next()
  })
  router.use(express.json({ limit: '32kb', strict: true }))
  router.use(asyncMiddleware(async (req, _res, next) => { req.vipUser = await getUser(req); next() }))

  // ---------- 图形验证码 ----------
  // 答案只存哈希、短时有效，校验一次即失效，防止暴力枚举。
  const captchaStore = new Map()
  const CAPTCHA_TTL = 5 * 60_000
  const purgeCaptchas = () => {
    const time = now()
    for (const [id, entry] of captchaStore) if (entry.expiresAt <= time) captchaStore.delete(id)
  }
  const issueCaptcha = () => {
    purgeCaptchas()
    const challenge = captcha.issue()
    const id = randomBytes(16).toString('hex')
    captchaStore.set(id, {
      answerHash: createHash('sha256').update(normalizeCaptcha(challenge.text)).digest('hex'),
      expiresAt: now() + CAPTCHA_TTL,
    })
    return { id, svg: Buffer.from(challenge.svg, 'utf8').toString('base64') }
  }
  const consumeCaptcha = (id, text) => {
    if (!id || typeof id !== 'string' || typeof text !== 'string') return false
    purgeCaptchas()
    const entry = captchaStore.get(id)
    if (!entry) return false
    captchaStore.delete(id)
    const given = createHash('sha256').update(normalizeCaptcha(text)).digest('hex')
    return given.length === entry.answerHash.length && timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(entry.answerHash, 'hex'))
  }
  // 定期清理过期验证码，避免长时间空闲后 Map 持续膨胀。
  const captchaTimer = setInterval(purgeCaptchas, 5 * 60_000)
  captchaTimer.unref?.()
  /** 从请求体取出验证码答案；缺失或错误时统一返回 400。 */
  const requireCaptcha = (req, res) => {
    if (!captchaRequired) return true
    if (!consumeCaptcha(req.body?.captchaId, req.body?.captchaText)) {
      res.status(400).json({ error: '请完成图形验证码', captchaRequired: true })
      return false
    }
    return true
  }

  // ---------- 一次性令牌（邮箱验证 / 密码重置） ----------
  const TOKEN_TTL = 30 * 60_000
  const issueAuthToken = async (userId, kind) => {
    const token = randomBytes(32).toString('hex')
    const hash = createHash('sha256').update(token).digest('hex')
    await run('DELETE FROM vip_auth_tokens WHERE user_id = ? AND kind = ?', userId, kind)
    await run('INSERT INTO vip_auth_tokens (id, user_id, kind, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      randomUUID(), userId, kind, hash, now() + TOKEN_TTL, now())
    return token
  }
  /** 令牌只能用一次；校验通过后在同一事务里标记已用。 */
  const consumeAuthToken = async (token, kind) => {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null
    const hash = createHash('sha256').update(token).digest('hex')
    return transaction(async ({ query: queryTx, run: runTx }) => {
      const row = await queryTx('SELECT * FROM vip_auth_tokens WHERE token_hash = ? AND kind = ? FOR UPDATE', hash, kind)
      if (!row || row.used_at !== null || Number(row.expires_at) <= now()) return null
      await runTx('UPDATE vip_auth_tokens SET used_at = ? WHERE id = ?', now(), row.id)
      return { userId: row.user_id }
    })
  }
  const purgeAuthTokens = () => run('DELETE FROM vip_auth_tokens WHERE expires_at <= ?', now() - TOKEN_TTL).catch(() => {})

  /** 登录失败计数：连续失败后要求图形验证码，抑制撞库。 */
  const loginFailures = new Map()
  const FAILURE_LIMIT = 3
  const failureKey = (req, email) => `${req.ip}|${email}`
  const noteLoginFailure = (req, email) => {
    const key = failureKey(req, email)
    const entry = loginFailures.get(key)
    if (!entry || entry.reset <= now()) {
      loginFailures.set(key, { count: 1, reset: now() + 15 * 60_000 })
      return
    }
    entry.count++
  }
  const clearLoginFailures = (req, email) => loginFailures.delete(failureKey(req, email))
  const loginNeedsCaptcha = (req, email) => {
    const entry = loginFailures.get(failureKey(req, email))
    return Boolean(entry && entry.reset > now() && entry.count >= FAILURE_LIMIT)
  }
  /** 定期清理过期的失败计数，避免长期运行时内存无限增长。 */
  const purgeLoginFailures = () => {
    const time = now()
    for (const [key, entry] of loginFailures) if (entry.reset <= time) loginFailures.delete(key)
  }
  const loginFailureTimer = setInterval(purgeLoginFailures, 10 * 60_000)
  loginFailureTimer.unref?.()

  router.get('/auth/captcha', rateLimit('captcha', 60, 10 * 60_000), (_req, res) => {
    if (!captchaRequired) return res.json({ id: null, svg: null, required: false })
    const challenge = issueCaptcha()
    return res.json({ id: challenge.id, svg: challenge.svg, required: true })
  })

  router.get('/auth/providers', (_req, res) => {
    res.json({
      captcha: captchaRequired,
      // 只有 SMTP 与站点地址都就绪，邮件类能力才对外可用。
      passwordReset: mailLinksEnabled,
      emailVerification: mailLinksEnabled,
    })
  })

  router.post('/auth/register', rateLimit('auth', 15, 15 * 60_000), asyncRoute(async (req, res) => {
    const input = credentials(req.body)
    if (!input) return res.status(400).json({ error: '请输入有效邮箱及 8–128 位密码' })
    if (!requireCaptcha(req, res)) return
    if (await query('SELECT id FROM vip_users WHERE email = ?', input.email)) return res.status(409).json({ error: '该邮箱已注册，请登录' })
    const passwordHash = await hashPassword(input.password)
    const id = randomUUID()
    // 邮件不可用时不做邮箱验证，避免注册后无法登录。
    const verificationRequired = mailLinksEnabled
    try {
      await run('INSERT INTO vip_users (id, email, password_hash, email_verified, created_at) VALUES (?, ?, ?, ?, ?)',
        id, input.email, passwordHash, verificationRequired ? 0 : 1, now())
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '该邮箱已注册，请登录' })
      throw error
    }
    let verificationSent = false
    if (verificationRequired) {
      try {
        const token = await issueAuthToken(id, 'verify')
        const url = `${authOrigin}/verify-email?token=${encodeURIComponent(token)}`
        const message = verificationEmail({ email: input.email, url, lang: req.body?.lang === 'en' ? 'en' : 'zh' })
        await mail.send({ to: input.email, subject: message.subject, html: message.html, text: message.text })
        verificationSent = true
      } catch (error) {
        logger.error('[auth] verification email failed:', error?.message || error)
        // 邮件发不出去时直接标记为已验证，否则用户会卡在无法登录的状态。
        await run('UPDATE vip_users SET email_verified = 1 WHERE id = ?', id)
      }
    }
    const user = normalizeUser(await query('SELECT * FROM vip_users WHERE id = ?', id))
    await issueSession(req, res, id)
    return res.status(201).json({
      user: userView(user),
      verificationSent,
      needsVerification: Number(user?.email_verified) !== 1,
    })
  }))

  router.post('/auth/login', rateLimit('auth', 15, 15 * 60_000), asyncRoute(async (req, res) => {
    const input = credentials(req.body)
    if (!input) return res.status(400).json({ error: '请输入有效邮箱及 8–128 位密码' })
    if (loginNeedsCaptcha(req, input.email) && !requireCaptcha(req, res)) return
    const user = normalizeUser(await query('SELECT * FROM vip_users WHERE email = ?', input.email))
    // The dummy hash keeps unknown accounts on the same expensive verification path.
    const dummy = `${'0'.repeat(32)}:${'0'.repeat(128)}`
    const valid = await checkPassword(input.password, user?.password_hash || dummy)
    if (!user || !valid) {
      noteLoginFailure(req, input.email)
      return res.status(401).json({ error: '邮箱或密码错误' })
    }
    clearLoginFailures(req, input.email)
    await issueSession(req, res, user.id)
    // 未验证邮箱允许登录，但开通会员等操作会被拦截，前端据此提示去查收邮件。
    const needsVerification = Number(user.email_verified) !== 1
    return res.json({ user: userView(user), needsVerification })
  }))

  router.post('/auth/logout', asyncRoute(async (req, res) => {
    const token = sessionToken(req)
    if (token) await run('DELETE FROM vip_sessions WHERE token_hash = ?', token)
    res.clearCookie(COOKIE, { httpOnly: true, secure: production, sameSite: 'lax', path: '/' })
    res.json({ user: null })
  }))
  router.get('/auth/me', (req, res) => res.json({ user: userView(req.vipUser) }))

  // ---------- 邮箱验证 ----------
  router.post('/auth/verify-email', rateLimit('auth', 20, 15 * 60_000), asyncRoute(async (req, res) => {
    const consumed = await consumeAuthToken(req.body?.token, 'verify')
    if (!consumed) return res.status(400).json({ error: '验证链接无效或已过期' })
    await run('UPDATE vip_users SET email_verified = 1 WHERE id = ?', consumed.userId)
    return res.json({ verified: true })
  }))

  router.post('/auth/resend-verification', requireUser, rateLimit('auth', 10, 15 * 60_000), asyncRoute(async (req, res) => {
    if (Number(req.vipUser.email_verified) === 1) return res.json({ sent: false, alreadyVerified: true })
    if (!mailLinksEnabled) return res.status(503).json({ error: '邮件服务暂未配置，请稍后再试' })
    const token = await issueAuthToken(req.vipUser.id, 'verify')
    const url = `${authOrigin}/verify-email?token=${encodeURIComponent(token)}`
    const message = verificationEmail({ email: req.vipUser.email, url, lang: req.body?.lang === 'en' ? 'en' : 'zh' })
    await mail.send({ to: req.vipUser.email, subject: message.subject, html: message.html, text: message.text })
    return res.json({ sent: true })
  }))

  // ---------- 密码找回 ----------
  router.post('/auth/password/forgot', rateLimit('auth', 10, 15 * 60_000), asyncRoute(async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: '请输入有效邮箱' })
    if (!requireCaptcha(req, res)) return
    // 无论邮箱是否存在都返回同样结果，避免探测账号。
    const user = normalizeUser(await query('SELECT * FROM vip_users WHERE email = ?', email))
    if (user && mailLinksEnabled) {
      try {
        const token = await issueAuthToken(user.id, 'reset')
        const url = `${authOrigin}/reset-password?token=${encodeURIComponent(token)}`
        const message = resetEmail({ email: user.email, url, lang: req.body?.lang === 'en' ? 'en' : 'zh' })
        await mail.send({ to: user.email, subject: message.subject, html: message.html, text: message.text })
      } catch (error) {
        logger.error('[auth] reset email failed:', error?.message || error)
      }
    }
    return res.json({ sent: true })
  }))

  router.post('/auth/password/reset', rateLimit('auth', 15, 15 * 60_000), asyncRoute(async (req, res) => {
    const password = req.body?.password
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: '请输入 8–128 位密码' })
    }
    const consumed = await consumeAuthToken(req.body?.token, 'reset')
    if (!consumed) return res.status(400).json({ error: '重置链接无效或已过期' })
    const passwordHash = await hashPassword(password)
    await transaction(async ({ run: runTx }) => {
      await runTx('UPDATE vip_users SET password_hash = ? WHERE id = ?', passwordHash, consumed.userId)
      // 改密后注销全部旧会话，强制重新登录。
      await runTx('DELETE FROM vip_sessions WHERE user_id = ?', consumed.userId)
    })
    return res.json({ reset: true })
  }))

  router.get('/vip/plans', (_req, res) => res.json({
    plans,
    payment: { providers, enabled: providers.length > 0, currencies: ['USDT'], network: 'TRON / TRC20' },
  }))
  purgeAuthTokens()

  async function createNowpaymentsOrder({ order, plan, key }) {
    if (!enabled) throw Object.assign(new Error('加密货币支付暂未开放，请稍后再试'), { status: 503 })
    const response = await fetchImpl(`${apiBase}/payment`, {
      method: 'POST', headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        price_amount: plan.price, price_currency: 'usd', pay_amount: plan.price, pay_currency: 'usdttrc20',
        order_id: order.id, order_description: `${plan.name} · ${plan.days} 天 VIP`,
        ipn_callback_url: `${appOrigin}/api/payments/nowpayments/ipn`,
      }),
    })
    if (!response.ok) {
      // Never resubmit this order: a timeout or upstream error may still have created a payment.
      await run('UPDATE vip_orders SET status = ?, review_reason = ? WHERE id = ?', response.status >= 400 && response.status < 500 ? 'failed' : 'review', `payment_http_${response.status}`, order.id)
      throw Object.assign(new Error('暂时无法创建支付订单，请在订单记录中查看状态'), { status: 502 })
    }
    const payment = await response.json()
    const paymentId = providerId(payment.payment_id)
    const address = typeof payment.pay_address === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(payment.pay_address) ? payment.pay_address : null
    // pay_amount is explicitly supplied in USDT: never display an approximate USD conversion.
    if (!paymentId || !address || payment.pay_currency !== 'usdttrc20' || compareAmounts(payment.pay_amount, plan.price) !== 0 ||
      String(payment.price_currency).toLowerCase() !== 'usd' || compareAmounts(payment.price_amount, plan.price) !== 0 ||
      payment.order_id !== order.id || payment.payin_extra_id) throw new Error('Invalid provider payment')
    const expiresAt = providerExpiry(payment.expiration_estimate_date) || providerExpiry(payment.valid_until)
    if (expiresAt && Date.parse(expiresAt) <= now()) throw new Error('Expired provider payment')
    await run("UPDATE vip_orders SET payment_id = ?, pay_address = ?, pay_amount = ?, pay_currency = ?, payment_expires_at = ?, status = 'pending', provider = 'nowpayments' WHERE id = ?",
      paymentId, address, plan.price, 'usdttrc20', expiresAt, order.id)
  }

  async function createVaehubOrder({ order, plan, key }) {
    if (!vaehub) throw Object.assign(new Error('VaeHub 支付暂未开放，请稍后再试'), { status: 503 })
    const returnType = vaehubReturnType
    // 法币金额 = USDT 套餐价 × 汇率，向上取整到分，避免少收。
    const fiatAmount = Math.ceil(plan.price * vaehub.rate * 100) / 100
    const body = {
      order_id: order.id, country: vaehub.country, currency: vaehub.currency,
      amount: fiatAmount, return_type: returnType,
    }
    if (vaehubPaycode) body.paycode = vaehubPaycode
    if (appOrigin) body.callback_url = `${appOrigin}/api/payments/vaehub/notify`
    const timestamp = String(Math.floor(now() / 1000))
    const nonce = randomBytes(8).toString('hex')
    const response = await fetchImpl(`${vaehub.base}/v1/trade/payin`, {
      method: 'POST',
      headers: { Authorization: vaehubAuthHeader(vaehub, timestamp, nonce), 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      await run('UPDATE vip_orders SET status = ?, review_reason = ? WHERE id = ?', response.status >= 400 && response.status < 500 ? 'failed' : 'review', `vaehub_http_${response.status}`, order.id)
      throw Object.assign(new Error('暂时无法创建支付订单，请在订单记录中查看状态'), { status: 502 })
    }
    const payload = await response.json().catch(() => null)
    if (!payload || payload.code !== 200 || !payload.data || typeof payload.data !== 'object') {
      throw new Error('Invalid vaehub payment')
    }
    const data = payload.data
    const openId = typeof data.open_id === 'string' && data.open_id.length <= 100 ? data.open_id : null
    if (!openId || compareAmounts(data.amount, fiatAmount) !== 0) throw new Error('Invalid vaehub payment')
    const checkoutUrl = httpsUrl(data.cashier_link)
    // return_type=cashier 时必须给收银台跳转链接；qrcode 模式必须给二维码串。
    if (returnType === 'cashier' && !checkoutUrl) throw new Error('Invalid vaehub payment')
    const qrString = typeof data.qrcode_string === 'string' && data.qrcode_string.length <= 4096 ? data.qrcode_string : null
    if (returnType === 'qrcode' && !qrString) throw new Error('Invalid vaehub payment')
    const qrExpires = Number.isFinite(Number(data.qrcode_expired)) && Number(data.qrcode_expired) > 0
      ? new Date(Number(data.qrcode_expired) * 1000).toISOString() : null
    const qrTtl = Number.isFinite(Number(data.qrcode_ttl)) && Number(data.qrcode_ttl) > 0 ? Number(data.qrcode_ttl) : null
    const expiresAt = qrExpires || (qrTtl ? new Date(now() + qrTtl * 1000).toISOString() : null)
    await run(`UPDATE vip_orders SET provider = 'vaehub', payment_id = ?, pay_amount = ?, pay_currency = ?,
      checkout_url = ?, qr_string = ?, qr_expires_at = ?, payment_expires_at = ?, status = 'pending' WHERE id = ?`,
    openId, Number(fiatAmount), vaehub.currency, checkoutUrl, qrString, qrExpires, expiresAt, order.id)
  }

  router.post('/vip/orders', requireVerified, rateLimit('orders', 10, 10 * 60_000), asyncRoute(async (req, res) => {
    const key = req.get('Idempotency-Key')
    if (!key || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) return res.status(400).json({ error: '缺少有效的 Idempotency-Key' })
    const existingRow = await query('SELECT * FROM vip_orders WHERE user_id = ? AND idempotency_key = ?', req.vipUser.id, key)
    const existing = normalizeOrder(existingRow)
    if (existing) {
      if (existing.plan_id !== req.body?.planId) return res.status(409).json({ error: '同一请求编号不能用于不同套餐' })
      const existingRequested = typeof req.body?.provider === 'string' ? req.body.provider : undefined
      if (existing.provider && existingRequested && existing.provider !== existingRequested) {
        return res.status(409).json({ error: '同一请求编号不能用于不同支付通道' })
      }
      return res.json({ order: orderView(existing) })
    }
    const plan = plans.find((item) => item.id === req.body?.planId)
    if (!plan) return res.status(400).json({ error: '会员套餐不存在' })
    if (providers.length === 0) return res.status(503).json({ error: '加密货币支付暂未开放，请稍后再试' })
    const requestedProvider = typeof req.body?.provider === 'string' ? req.body.provider : undefined
    let useProvider = requestedProvider
    if (!useProvider) {
      if (providers.length !== 1) return res.status(400).json({ error: '请选择支付通道' })
      useProvider = providers[0].id
    }
    if (useProvider !== 'nowpayments' && useProvider !== 'vaehub') return res.status(400).json({ error: '支付通道不可用' })
    if (useProvider === 'nowpayments' && !enabled) return res.status(503).json({ error: '加密货币支付暂未开放，请稍后再试' })
    if (useProvider === 'vaehub' && !vaehub) return res.status(503).json({ error: '加密货币支付暂未开放，请稍后再试' })
    const id = randomUUID()
    let inserted
    try {
      inserted = await run(`INSERT INTO vip_orders (id, user_id, idempotency_key, plan_id, plan_name, days, amount_cents, status, created_at, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)`,
      id, req.vipUser.id, key, plan.id, plan.name, plan.days, Math.round(plan.price * 100), now(), useProvider)
    } catch (error) {
      if (error?.code !== 'ER_DUP_ENTRY') throw error
      inserted = { changes: 0 }
    }
    if (!inserted.changes) {
      const concurrentRow = await query('SELECT * FROM vip_orders WHERE user_id = ? AND idempotency_key = ?', req.vipUser.id, key)
      const concurrent = normalizeOrder(concurrentRow)
      if (!concurrent) throw Object.assign(new Error('订单创建冲突，请重试'), { status: 409 })
      if (concurrent.plan_id !== plan.id) return res.status(409).json({ error: '同一请求编号不能用于不同套餐' })
      if (concurrent.provider && concurrent.provider !== useProvider) return res.status(409).json({ error: '同一请求编号不能用于不同支付通道' })
      return res.json({ order: orderView(concurrent) })
    }
    const orderOf = async (orderId) => normalizeOrder(await query('SELECT * FROM vip_orders WHERE id = ?', orderId))
    try {
      const created = await orderOf(id)
      if (useProvider === 'vaehub') await createVaehubOrder({ order: created, plan, key })
      else await createNowpaymentsOrder({ order: created, plan, key })
      return res.status(201).json({ order: orderView(await orderOf(id)) })
    } catch (error) {
      // Invalid provider response uncertain: keep the order for manual review, never auto-resubmit.
      if (error?.status === 502 || error?.status === 503) {
        return res.status(error.status).json({ error: error.message, order: orderView(await orderOf(id)) })
      }
      await run("UPDATE vip_orders SET status = 'review', review_reason = 'payment_response_uncertain' WHERE id = ? AND paid_at IS NULL", id)
      return res.status(502).json({ error: '支付订单创建结果待核实，请勿重复付款', order: orderView(await orderOf(id)) })
    }
  }))
  router.get('/vip/orders', requireUser, asyncRoute(async (req, res) => {
    const rows = await query.all('SELECT * FROM vip_orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', req.vipUser.id)
    res.json({ orders: rows.map((row) => normalizeOrder(row)).map(orderView) })
  }))
  router.get('/vip/orders/:id', requireUser, asyncRoute(async (req, res) => {
    const order = normalizeOrder(await query('SELECT * FROM vip_orders WHERE id = ? AND user_id = ?', req.params.id, req.vipUser.id))
    if (!order) return res.status(404).json({ error: '订单不存在' })
    return res.json({ order: orderView(order), user: userView(req.vipUser) })
  }))

  router.post('/payments/nowpayments/ipn', asyncRoute(async (req, res) => {
    if (!ipnSecret) return res.status(503).json({ error: '支付回调尚未配置' })
    const signature = req.get('x-nowpayments-sig') || ''
    if (!/^[a-fA-F0-9]{128}$/.test(signature) || !req.body || Array.isArray(req.body) || typeof req.body !== 'object') {
      return res.status(401).json({ error: '无效的支付签名' })
    }
    const expected = createHmac('sha512', ipnSecret).update(JSON.stringify(sortKeys(req.body))).digest()
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return res.status(401).json({ error: '无效的支付签名' })
    const event = req.body
    const orderId = typeof event.order_id === 'string' ? event.order_id : ''
    const paymentId = providerId(event.payment_id)
    const invoiceId = providerId(event.invoice_id) || ''
    if (!orderId || !paymentId || typeof event.payment_status !== 'string') return res.status(400).json({ error: '支付回调数据不完整' })
    const result = await transaction(async ({ query: queryTx, run: runTx }) => {
      const order = normalizeOrder(await queryTx('SELECT * FROM vip_orders WHERE id = ? FOR UPDATE', orderId))
      if (!order) return { code: 404, error: '订单不存在' }
      // NOWPayments can call back before the asynchronous payment request returns.
      if (!order.payment_id) return { code: 503, error: '订单正在同步，请重试' }
      const review = async (reason) => {
        await runTx("UPDATE vip_orders SET status = 'review', review_reason = ? WHERE id = ? AND paid_at IS NULL AND refunded_at IS NULL", reason, order.id)
      }
      if (paymentId !== order.payment_id || (event.parent_payment_id !== undefined && event.parent_payment_id !== null) ||
        String(event.price_currency).toLowerCase() !== 'usd' ||
        compareAmounts(event.price_amount, (order.amount_cents / 100).toFixed(2)) !== 0 ||
        event.pay_currency !== 'usdttrc20' || compareAmounts(event.pay_amount, (order.amount_cents / 100).toFixed(2)) !== 0) {
        await review('payment_or_price_mismatch')
        return { code: 422, error: '订单支付信息不匹配' }
      }
      const payment = await queryTx('SELECT * FROM vip_provider_payments WHERE payment_id = ?', paymentId)
      if (payment && (payment.order_id !== order.id || payment.invoice_id !== invoiceId)) {
        await review('payment_id_reused')
        return { code: 409, error: '支付编号不匹配' }
      }
      await runTx(`INSERT INTO vip_provider_payments (payment_id, order_id, invoice_id, last_status, expected_amount, actual_amount, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE
        last_status = VALUES(last_status), expected_amount = VALUES(expected_amount),
        actual_amount = VALUES(actual_amount), updated_at = VALUES(updated_at)`,
      paymentId, order.id, invoiceId, event.payment_status.slice(0, 80), String(event.pay_amount ?? ''), String(event.actually_paid ?? ''), now())
      if (event.payment_status === 'refunded') {
        // Retain a tombstone even if delayed callbacks subsequently report finished.
        await runTx(`UPDATE vip_orders SET refunded_at = COALESCE(refunded_at, ?),
          status = 'refunded',
          review_reason = CASE WHEN paid_at IS NOT NULL THEN 'refund_requires_entitlement_review' ELSE review_reason END WHERE id = ?`, now(), order.id)
        return { code: 200 }
      }
      if (order.refunded_at !== null) return { code: 200 }
      if (order.paid_at !== null) return { code: 200 }
      if (event.payment_status === 'finished') {
        if (compareAmounts(event.actually_paid, (order.amount_cents / 100).toFixed(2)) === null ||
          compareAmounts(event.actually_paid, (order.amount_cents / 100).toFixed(2)) === -1) {
          await review('payment_amount_unverified')
          return { code: 200 }
        }
        const user = normalizeUser(await queryTx('SELECT * FROM vip_users WHERE id = ? FOR UPDATE', order.user_id))
        const paidAt = now()
        const expiresAt = Math.max(paidAt, user.vip_expires_at || 0) + order.days * DAY
        await runTx('UPDATE vip_users SET vip_expires_at = ? WHERE id = ?', expiresAt, user.id)
        await runTx("UPDATE vip_orders SET status = 'paid', paid_at = ?, review_reason = NULL WHERE id = ? AND paid_at IS NULL", paidAt, order.id)
        return { code: 200 }
      }
      const states = { waiting: 'pending', confirming: 'confirming', confirmed: 'confirming', sending: 'confirming', partially_paid: 'partially_paid', failed: 'failed', expired: 'expired', refunded: 'refunded' }
      const status = states[event.payment_status]
      if (!status) { await review('unknown_payment_status'); return { code: 200 } }
      // Delayed waiting/confirming messages must not hide a terminal or review state.
      const priority = { creating: 0, pending: 1, confirming: 2, partially_paid: 3, failed: 4, expired: 4, refunded: 5, review: 6 }
      if (priority[status] >= priority[order.status]) await runTx('UPDATE vip_orders SET status = ? WHERE id = ?', status, order.id)
      return { code: 200 }
    })
    if (result.code === 503) res.set('Retry-After', '5')
    return res.status(result.code).json(result.error ? { error: result.error } : { received: true })
  }))

  router.post('/payments/vaehub/notify', asyncRoute(async (req, res) => {
    // VaeHub 回调按 text/plain 返回 SUCCESS，不是 JSON；重试间隔见其 Webhook 文档。
    const sendPlain = (code, text) => res.status(code).set('Content-Type', 'text/plain; charset=utf-8').send(text)
    if (!vaehub) return sendPlain(503, 'NOT_CONFIGURED')
    const token = verifyVaehubToken(req.get('authorization'), vaehub, now())
    if (!token) return sendPlain(401, 'INVALID_SIGNATURE')
    const event = req.body
    if (!event || Array.isArray(event) || typeof event !== 'object') return sendPlain(400, 'INVALID_BODY')
    if (event.type !== 'payin_notify' || typeof event.data !== 'object' || !event.data) return sendPlain(200, 'SUCCESS')
    const data = event.data
    const orderId = typeof data.out_trade_no === 'string' ? data.out_trade_no : ''
    const paymentId = typeof data.open_id === 'string' ? providerId(data.open_id) : null
    if (!orderId || !paymentId) return sendPlain(400, 'INVALID_BODY')
    // 同一随机串只处理一次：VaeHub 按 15s / 300s / 3000s 重试，重复回调直接回 SUCCESS。
    let result
    try {
      result = await transaction(async ({ query: queryTx, run: runTx }) => {
        let deduped = { changes: 0 }
        try {
          deduped = await runTx('INSERT INTO vip_vaehub_nonces (nonce, created_at) VALUES (?, ?)', token.nonce, now())
        } catch (error) {
          if (error?.code !== 'ER_DUP_ENTRY') throw error
        }
        await runTx('DELETE FROM vip_vaehub_nonces WHERE created_at < ?', now() - 24 * 60 * 60 * 1000)
        // 完全相同的回调被重试时直接回 SUCCESS，避免重复记账；新的状态通知会带新的随机串。
        if (!deduped.changes) return { code: 200 }
        const order = normalizeOrder(await queryTx('SELECT * FROM vip_orders WHERE id = ? FOR UPDATE', orderId))
        if (!order) return { code: 404, error: 'NOT_FOUND' }
        if (order.provider && order.provider !== 'vaehub') {
          await runTx("UPDATE vip_orders SET status = 'review', review_reason = 'payment_or_price_mismatch' WHERE id = ? AND paid_at IS NULL AND refunded_at IS NULL", order.id)
          return { code: 422, error: 'ORDER_MISMATCH' }
        }
        // VaeHub may notify before the asynchronous create response returns.
        if (!order.payment_id) return { code: 503, error: 'ORDER_SYNCING' }
        if (paymentId !== order.payment_id) {
          await runTx("UPDATE vip_orders SET status = 'review', review_reason = 'payment_or_price_mismatch' WHERE id = ? AND paid_at IS NULL AND refunded_at IS NULL", order.id)
          return { code: 422, error: 'ORDER_MISMATCH' }
        }
        const vaehubExpected = (order.pay_currency || '').toUpperCase() === 'USDT'
          ? (order.amount_cents / 100).toFixed(2)
          : Number(order.pay_amount).toFixed(2)
        const amountOk = compareAmounts(data.amount, vaehubExpected) === 0
        // 回调货币字段必须与建单币种一致；会员天数账本仍按订单的 USDT 套餐价结算。
        const currencyOk = typeof data.currency === 'string' && data.currency.toUpperCase() === String(order.pay_currency || vaehub.currency).toUpperCase()
        if (!amountOk || !currencyOk) {
          await runTx("UPDATE vip_orders SET status = 'review', review_reason = 'payment_or_price_mismatch' WHERE id = ? AND paid_at IS NULL AND refunded_at IS NULL", order.id)
          return { code: 422, error: 'ORDER_MISMATCH' }
        }
        const payment = await queryTx('SELECT * FROM vip_provider_payments WHERE payment_id = ?', paymentId)
        if (payment && payment.order_id !== order.id) {
          await runTx("UPDATE vip_orders SET status = 'review', review_reason = 'payment_id_reused' WHERE id = ? AND paid_at IS NULL AND refunded_at IS NULL", order.id)
          return { code: 409, error: 'PAYMENT_REUSED' }
        }
        await runTx(`INSERT INTO vip_provider_payments (payment_id, order_id, invoice_id, last_status, expected_amount, actual_amount, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE
          last_status = VALUES(last_status), expected_amount = VALUES(expected_amount),
          actual_amount = VALUES(actual_amount), updated_at = VALUES(updated_at)`,
        paymentId, order.id, paymentId, `vaehub:${String(data.status)}`.slice(0, 80), String(data.amount ?? ''), String(data.amount_paid ?? data.amount ?? ''), now())
        if (order.refunded_at !== null) return { code: 200 }
        if (order.paid_at !== null) return { code: 200 }
        if (Number(data.status) === 1) {
          const user = normalizeUser(await queryTx('SELECT * FROM vip_users WHERE id = ? FOR UPDATE', order.user_id))
          const paidAt = now()
          const expiresAt = Math.max(paidAt, user.vip_expires_at || 0) + order.days * DAY
          await runTx('UPDATE vip_users SET vip_expires_at = ? WHERE id = ?', expiresAt, user.id)
          await runTx("UPDATE vip_orders SET status = 'paid', paid_at = ?, review_reason = NULL WHERE id = ? AND paid_at IS NULL", paidAt, order.id)
          return { code: 200 }
        }
        if (Number(data.status) === 2 || Number(data.status) === 5) {
          await runTx("UPDATE vip_orders SET status = ? WHERE id = ? AND paid_at IS NULL AND refunded_at IS NULL",
            Number(data.status) === 2 ? 'failed' : 'expired', order.id)
          return { code: 200 }
        }
        if (Number(data.status) === 3 || Number(data.status) === 4) {
          const statement = order.status === 'creating' || order.status === 'pending' || order.status === 'confirming'
            ? "UPDATE vip_orders SET status = 'confirming' WHERE id = ?" : null
          if (statement) await runTx(statement, order.id)
          return { code: 200 }
        }
        await runTx("UPDATE vip_orders SET status = 'review', review_reason = 'unknown_payment_status' WHERE id = ? AND paid_at IS NULL AND refunded_at IS NULL", order.id)
        return { code: 200 }
      })
    } catch {
      return sendPlain(500, 'ERROR')
    }
    if (result.code === 503) res.set('Retry-After', '5')
    if (result.code !== 200) return sendPlain(result.code, result.error || 'ERROR')
    return sendPlain(200, 'SUCCESS')
  }))

  router.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: '请求内容过大' })
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: '无效的 JSON 请求' })
    console.error('[vip] request failed:', error?.code || error?.name || 'Error')
    return res.status(500).json({ error: '服务暂时不可用，请稍后再试' })
  })
  return router
}
