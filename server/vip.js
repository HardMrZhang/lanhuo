import express from 'express'
import mysql from 'mysql2/promise'
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { createMailer, resetEmail, verificationEmail } from './mail.js'
import { createCaptchaChallenge, normalizeCaptcha } from './captcha.js'
import { createChainService } from './evmchain-service.js'
import { buildPaymentUri, buildQrSvg, formatUnits, formatUnitsExact, toUnits } from './evmchain.js'

const scryptAsync = promisify(scrypt)
const DAY = 86_400_000
const SESSION_AGE = 30 * DAY
const COOKIE = 'duanju_session'
/**
 * 第三方通道订单的本地兜底有效期（毫秒）。
 *
 * 渠道没返回 qrcode_ttl / expiration_estimate_date 时用它兜底 ——
 * 没有截止时间的订单永远不会作废，迟到的回调就能一直把它改成「等待人工核实」。
 */
const PROVIDER_ORDER_TTL_MS = 15 * 60_000
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

export function loadVaehubRates(value) {
  if (!value) return {}
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    // 容错：`.env` 里常见的两种踩坑——
    //   1) 行尾注释（`{"USD":1}  # 说明`）被 --env-file 当成值的一部分；
    //   2) 用 `set -a && . ./.env` 源入 shell 时引号被剥掉，变成 `{USD:1}`。
    // 两种都尝试还原，合法就用，仍非法才报错。
    const candidates = [
      String(value).replace(/\s+#.*$/, '').trim(),
      String(value).trim().replace(/([{,]\s*)([A-Za-z_]\w*)(\s*:)/g, '$1"$2"$3'),
    ]
    for (const candidate of candidates) {
      try {
        parsed = JSON.parse(candidate)
        break
      } catch {
        // 继续尝试下一个
      }
    }
    if (parsed === undefined) throw new Error('VAEHUB_USDT_RATES_JSON must be valid JSON')
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

/**
 * VaeHub 支付状态枚举（文档 payment-status / payin-notify 章节）。
 *
 * 1=Success 2=Failed 3=Pending 4=Locked 5=Canceled
 *
 * 4=Locked 与 5=Canceled 是终态：钱没到账、订单不可能再成功，
 * 不应该停留在「等待人工核实」——人工也没法凭空把它变成成功。
 */
const VAEHUB_PAYMENT_STATUS = {
  SUCCESS: 1,
  FAILED: 2,
  PENDING: 3,
  LOCKED: 4,
  CANCELED: 5,
}

/** 把 VaeHub 的数字状态映射到本站订单状态；未知状态返回 null（交人工判断）。 */
function vaehubOrderStatus(status) {
  const value = Number(status)
  if (value === VAEHUB_PAYMENT_STATUS.SUCCESS) return 'paid'
  if (value === VAEHUB_PAYMENT_STATUS.FAILED) return 'failed'
  // 3=Pending 与 4=Locked 都表示渠道侧仍在处理（Locked 是被风控暂时锁住），
  // 订单应停在「支付确认中」等后续回调，不能当成失败。
  if (value === VAEHUB_PAYMENT_STATUS.PENDING || value === VAEHUB_PAYMENT_STATUS.LOCKED) return 'confirming'
  // 5=Canceled：渠道明确取消，等同于作废。
  if (value === VAEHUB_PAYMENT_STATUS.CANCELED) return 'expired'
  return null
}

/**
 * 订单状态机的合法迁移表。
 *
 * 之前的实现只靠零散的 WHERE 条件散落着判断，导致几个真实的坏迁移：
 *   - 订单超时后没人把它置为 expired，一直停在 pending；
 *   - 迟到的回调把已作废的订单改写成 review（用户看到「等待人工核实」）；
 *   - 已失败的订单又被改写成 confirming / pending。
 *
 * 收敛成一张表后，任何一次状态写入都必须先过这张表，非法迁移一律拒绝。
 * key = 目标状态，value = 允许的来源状态集合。
 */
const ORDER_STATUS_TRANSITIONS = {
  creating: new Set(['creating']),
  pending: new Set(['creating', 'pending', 'confirming']),
  confirming: new Set(['creating', 'pending', 'confirming', 'partially_paid']),
  partially_paid: new Set(['creating', 'pending', 'confirming', 'partially_paid']),
  // paid：钱确实到账。允许从 expired 进入 —— 迟到的转账仍必须认领，
  // 用户付了钱却拿不到会员，比状态显示难看严重得多。
  paid: new Set(['creating', 'pending', 'confirming', 'partially_paid', 'review', 'expired']),
  // failed：确定性失败。只允许从「还没成功」的状态进入。
  failed: new Set(['creating', 'pending', 'confirming', 'partially_paid']),
  // expired：过期作废。可从任何未成功状态进入（含 review：作废同样终结人工队列）。
  expired: new Set(['creating', 'pending', 'confirming', 'partially_paid', 'review']),
  // refunded：已退款。走的是专门的墓碑通道（见 ipn 处理），
  // 不经过这张表 —— 退款可能发生在任何阶段，必须无条件留墓碑。
  refunded: new Set(['paid']),
  // review：结果不明、需要人工核实。只允许从「未成功」的状态进入 ——
  // 已失败 / 已过期 / 已退款的订单不该再被拖进人工队列。
  //
  // 例外：已过期但「确实收到钱、金额不符」的订单仍要进人工队列，
  // 这类情况用 transitionOrder 的 moneyReceived 开关显式放行。
  review: new Set(['creating', 'pending', 'confirming', 'partially_paid']),
}

/**
 * 判断一次状态迁移是否合法。
 *
 * 目标状态与当前状态相同永远合法（幂等重放）。
 */
function canTransitionOrderStatus(from, to) {
  if (!to) return false
  if (from === to) return true
  const allowed = ORDER_STATUS_TRANSITIONS[to]
  // 目标状态不在表里：未知状态一律拒绝，避免把脏数据写进状态机。
  if (!allowed) return false
  return allowed.has(from)
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
 * 生成 VaeHub 建单必需的 user_hash：用户 id 的 SHA256 前 32 位十六进制。
 * 不传邮箱等明文，避免第三方侧留存可识别信息；同一用户恒定不变，便于对账。
 */
function vaehubUserHash(userId) {
  return createHash('sha256').update(String(userId || '')).digest('hex').slice(0, 32)
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
    // 精确文本：链上通道的应付金额尾数是订单标识，不能被 JS number 抹掉尾零。
    pay_amount_text: row.pay_amount_text ?? null,
    // 原始 DECIMAL 字符串：mysql2 在 supportBigNumbers 下可能返回字符串，
    // 用来在没有 pay_amount_text 时还原出精确金额。
    pay_amount_raw: row.pay_amount === null || row.pay_amount === undefined ? null : String(row.pay_amount),
  }
}

/**
 * 取订单应付金额的精确文本。
 *
 * 优先用 pay_amount_text（BSC 通道写入的 4 位小数文本）；历史订单没有该字段时，
 * 回退到数据库的原始 DECIMAL 字符串，再去掉 MySQL DECIMAL 补的尾零。
 *
 * 关键约束：展示文本必须与**应付金额完全一致**，不能为了好看去截断小数位。
 * 链上认领按 pay_amount 的原始数值比对（10.007889 就只认 10.007889），
 * 若把展示文本改成 10.0079，用户按显示金额转账反而认领不到订单。
 */
function rawPayAmount(order) {
  if (order.pay_amount === null || order.pay_amount === undefined) return null
  const raw = String(order.pay_amount_raw ?? order.pay_amount).trim()
  if (!/^\d+(\.\d+)?$/.test(raw)) return String(order.pay_amount)
  // 去掉尾零，但至少保留一位小数（10 → 10.0）。
  const trimmed = raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw
  return trimmed.includes('.') ? trimmed : `${trimmed}.0`
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
      chain_id INT NULL,
      token_symbol VARCHAR(16) NULL,
      tx_hash VARCHAR(80) NULL,
      UNIQUE KEY uq_orders_user_key (user_id, idempotency_key),
      CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES vip_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  // 链上自建通道需要记录链 ID / 代币符号 / 精确应付金额文本 / 链上交易哈希。
  for (const sql of [
    'ALTER TABLE vip_orders ADD COLUMN chain_id INT NULL',
    'ALTER TABLE vip_orders ADD COLUMN token_symbol VARCHAR(16) NULL',
    'ALTER TABLE vip_orders ADD COLUMN pay_amount_text VARCHAR(64) NULL',
    'ALTER TABLE vip_orders ADD COLUMN tx_hash VARCHAR(80) NULL',
  ]) {
    try {
      await pool.query(sql)
    } catch (error) {
      if (error?.code !== 'ER_DUP_FIELDNAME') throw error
    }
  }
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
  // 国家必须是 ISO3 三字母码（文档示例 SGP / USA）。支付方式代码请填在 VAEHUB_PAYCODE。
  const vaehubCountry = /^[A-Za-z]{3}$/.test(env.VAEHUB_COUNTRY?.trim() || '') ? env.VAEHUB_COUNTRY.trim().toUpperCase() : ''
  const vaehubPaycode = /^[a-zA-Z0-9_-]{1,64}$/.test(env.VAEHUB_PAYCODE?.trim() || '') ? env.VAEHUB_PAYCODE.trim() : ''
  const vaehubReturnType = env.VAEHUB_RETURN_TYPE === 'qrcode' ? 'qrcode' : 'cashier'
  // VaeHub 文档（API Signature 页）写明 Sandbox / Product Base url 都需向商务索取，
  // 官方未公开测试环境域名。所以测试环境地址完全由配置决定：
  //   VAEHUB_API_BASE       —— 生产地址
  //   VAEHUB_SANDBOX_API_BASE —— 测试地址（填了就优先用）
  //   VAEHUB_SANDBOX=true     —— 启用测试环境
  const vaehubSandboxBase = vaehubBaseUrl(env.VAEHUB_SANDBOX_API_BASE)
  const vaehubSandbox = env.VAEHUB_SANDBOX === 'true'
  // 测试环境通常有独立的 App Key / App Secret（实测：同一个 App Key 在两个环境都存在，
  // 但 Secret 不同，表现为 "Signature verification failed."）。
  // 所以沙箱开启时，key/secret 优先取沙箱专用的配置项，取不到才回退到生产配置。
  const vaehubSandboxAppKey = env.VAEHUB_SANDBOX_APP_KEY?.trim()
  const vaehubSandboxAppSecret = env.VAEHUB_SANDBOX_APP_SECRET?.trim()
  const vaehubEffectiveAppKey = vaehubSandbox && vaehubSandboxAppKey ? vaehubSandboxAppKey : vaehubAppKey
  const vaehubEffectiveAppSecret = vaehubSandbox && vaehubSandboxAppSecret ? vaehubSandboxAppSecret : vaehubAppSecret
  // 测试环境用 mock_res 让通道直接返回指定状态，从而在不真实收款的前提下
  // 跑通「建单 → 跳转收银台 → 回调 → 开通会员」全链路。
  const vaehubMockRes = env.VAEHUB_MOCK_RES === 'success' || env.VAEHUB_MOCK_RES === 'fail'
    ? env.VAEHUB_MOCK_RES : ''
  const vaehubEffectiveBase = vaehubSandbox && vaehubSandboxBase ? vaehubSandboxBase : vaehubBase
  // VaeHub 做法币代收：USDT 套餐价按配置的汇率换成法币金额（小数点后两位向上取整）。
  const vaehubRates = loadVaehubRates(env.VAEHUB_USDT_RATES_JSON)
  const vaehub = vaehubEffectiveBase && vaehubEffectiveAppKey && vaehubEffectiveAppSecret && vaehubCountry && vaehubRates[vaehubCurrency] ? {
    base: vaehubEffectiveBase, appTag: vaehubAppTag, appKey: vaehubEffectiveAppKey, appSecret: vaehubEffectiveAppSecret,
    currency: vaehubCurrency, country: vaehubCountry, paycode: vaehubPaycode, returnType: vaehubReturnType,
    rate: vaehubRates[vaehubCurrency],
    sandbox: vaehubSandbox, mockRes: vaehubMockRes,
  } : null
  // 通道未启用时给出可定位的原因，避免「配置了却不出现」的黑箱。
  if (vaehubEffectiveBase && vaehubEffectiveAppKey && vaehubEffectiveAppSecret && !vaehub) {
    const missing = []
    if (!vaehubCountry) missing.push('VAEHUB_COUNTRY（需 ISO3 三字母国家码，如 SGP / USA）')
    if (!vaehubRates[vaehubCurrency]) missing.push(`VAEHUB_USDT_RATES_JSON（需含 "${vaehubCurrency}" 汇率，如 {"${vaehubCurrency}":1}）`)
    if (missing.length) logger.warn(`[vaehub] 通道未启用，缺少：${missing.join('、')}`)
  }
  // 开了测试环境但没给测试地址 —— 直接在日志里点明，否则表现为「配置了却不生效」。
  if (vaehubSandbox && !vaehubSandboxBase) {
    logger.warn('[vaehub] VAEHUB_SANDBOX=true 但未配置 VAEHUB_SANDBOX_API_BASE，仍使用生产地址')
  }
  const providers = []
  if (enabled) providers.push({ id: 'nowpayments', name: 'NOWPayments' })
  if (vaehub) providers.push({ id: 'vaehub', name: 'VaeHub' })
  // BSC 链自建固定地址通道：配置了收款地址即可用，无需第三方商户账号。
  const bscChain = createChainService({ env, prefix: 'BSC', fetchImpl, logger })
  if (bscChain) providers.push({ id: 'bsc', name: 'BSC 链自建地址' })
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
  /**
   * 开通会员并把订单标记为已支付。幂等：已支付/已退款的订单不再重复加时长。
   *
   * 所有「确认到账」的入口（VaeHub 回调、BSC 链上扫描、建单即成功）都走这里，
   * 保证时长账本只有一处实现。
   */
  const markOrderPaid = async (orderId, { txHash = null, paidAt = now() } = {}) => {
    await transaction(async ({ query: queryTx, run: runTx }) => {
      const order = normalizeOrder(await queryTx('SELECT * FROM vip_orders WHERE id = ? FOR UPDATE', orderId))
      if (!order) return false
      if (order.paid_at !== null) return false
      if (order.refunded_at !== null) return false
      const user = normalizeUser(await queryTx('SELECT * FROM vip_users WHERE id = ? FOR UPDATE', order.user_id))
      const expiresAt = Math.max(paidAt, user.vip_expires_at || 0) + order.days * DAY
      await runTx('UPDATE vip_users SET vip_expires_at = ? WHERE id = ?', expiresAt, user.id)
      await runTx("UPDATE vip_orders SET status = 'paid', paid_at = ?, tx_hash = COALESCE(?, tx_hash), review_reason = NULL WHERE id = ? AND paid_at IS NULL",
        paidAt, txHash, order.id)
      return true
    })
  }
  /**
   * 按状态机迁移订单状态。
   *
   * 所有状态写入的唯一入口：先查当前状态，再按 ORDER_STATUS_TRANSITIONS 判断
   * 这次迁移是否合法，非法就原样保留当前状态（并返回 false）。
   *
   * 这样「迟到的回调把过期订单改成等待人工核实」这类坏迁移就不可能发生 ——
   * 不再依赖每个调用点自己记得加 WHERE 条件。
   *
   * @param {object} options
   * @param {string} options.id 订单 ID
   * @param {string} options.to 目标状态
   * @param {string|null} [options.reason] 人工核实原因（写 review_reason）
   * @param {string|null} [options.txHash] 链上交易哈希
   * @param {boolean} [options.clearReason] 是否清空 review_reason
   * @param {boolean} [options.moneyReceived] 是否确认「确实收到了钱」。
   *   为 true 时允许从 expired / review 进入 review —— 金额不符这类情况
   *   需要人工核对，即使订单已过期也不能直接丢弃。
   * @param {object} [options.tx] 事务内的 query/run（回调场景传入，避免嵌套事务）
   */
  const transitionOrder = async ({ id, to, reason = null, txHash = null, clearReason = false, moneyReceived = false, tx = null }) => {
    const exec = tx || { query, run }
    const current = normalizeOrder(await exec.query('SELECT * FROM vip_orders WHERE id = ?', id))
    if (!current) return false
    // paid / refunded 有专门的账本逻辑，不能走这条通用通道。
    if (to === 'paid' || to === 'refunded') return false
    const legal = canTransitionOrderStatus(current.status, to)
    // 唯一的例外：确认收到钱、但金额对不上 —— 这种情况必须人工核对，
    // 即使订单已经过期，也不能因为「过期」就把用户的钱丢掉不管。
    const mismatchNeedsReview = moneyReceived && to === 'review' && current.status === 'expired'
    if (!legal && !mismatchNeedsReview) return false
    const sets = ['status = ?']
    const params = [to]
    if (clearReason) { sets.push('review_reason = NULL') }
    else if (reason !== null) { sets.push('review_reason = ?'); params.push(String(reason).slice(0, 128)) }
    if (txHash) { sets.push('tx_hash = ?'); params.push(String(txHash).slice(0, 80)) }
    params.push(id, current.status)
    // 把来源状态也写进 WHERE：并发回调同时到达时，只有一个能改成功，
    // 避免「读到旧状态 → 两个回调都通过校验 → 写两次」的竞态。
    const result = await exec.run(
      `UPDATE vip_orders SET ${sets.join(', ')} WHERE id = ? AND status = ? AND paid_at IS NULL AND refunded_at IS NULL`,
      ...params,
    )
    return result.changes > 0
  }
  /**
   * 把超时未支付的订单置为 expired（过期作废）。
   *
   * 之前只有 BSC 通道有这一步，VaeHub / NOWPayments 订单到期后一直停在 pending，
   * 迟到的回调就能把它改写成 review —— 用户看到「等待人工核实」，实际无事可做。
   *
   * 只处理第三方通道（BSC 通道由自己的扫描器负责，它还要保留迟到认领窗口）。
   */
  const expireStaleOrders = async () => {
    const rows = await query.all(
      `SELECT id, payment_expires_at FROM vip_orders
        WHERE provider IN ('vaehub','nowpayments') AND status IN ('pending','confirming','creating')
          AND payment_expires_at IS NOT NULL`,
    )
    const deadline = now()
    let expired = 0
    for (const row of rows) {
      const timestamp = Date.parse(String(row.payment_expires_at))
      // 解析失败的时间不能当成已过期，否则会误作废还能正常支付的订单。
      if (!Number.isFinite(timestamp) || timestamp > deadline) continue
      const result = await run(
        "UPDATE vip_orders SET status = 'expired' WHERE id = ? AND status IN ('pending','confirming','creating') AND paid_at IS NULL AND refunded_at IS NULL",
        row.id,
      )
      expired += result.changes
    }
    return expired
  }

  /**
   * 把「通道已明确拒绝、但旧代码误判成 review」的第三方订单收敛成 failed。
   *
   * 背景：早期版本只在「响应体解析不出来」时才落 review，而 VaeHub 的业务级
   * 拒绝（HTTP 200 + body.code != 200，例如 IP 白名单拦截）也会走进那个分支，
   * 于是明明是「对方根本没建单」的确定性失败，却被记成「结果不明、等人工核实」。
   * 用户看到的是「等待人工核实」，而实际上无事可做 —— 纯浪费人工队列。
   *
   * 收敛条件必须够硬，不能只看 review_reason：
   *   - provider 是第三方通道（VaeHub / NOWPayments）；
   *   - 没有第三方侧凭证（payment_id / checkout_url / qr_string 全部为空）
   *     —— 说明对方侧压根没生成这笔单；
   *   - 没有收银台链接 —— 用户不可能付到这笔单上；
   *   - 未支付、未退款；
   *   - review_reason 是旧代码留下的那一个。
   *
   * 满足全部条件时改成 failed 并写明原因。已经是 paid 的（有真实凭证）绝不碰。
   */
  const resolveRejectedThirdPartyOrders = async () => {
    const rows = await query.all(
      `SELECT id FROM vip_orders
        WHERE provider IN ('vaehub','nowpayments') AND status = 'review'
          AND review_reason IN ('payment_response_uncertain','legacy_payment_response_uncertain')
          AND payment_id IS NULL AND checkout_url IS NULL AND qr_string IS NULL
          AND paid_at IS NULL AND refunded_at IS NULL`,
    )
    let resolved = 0
    for (const row of rows) {
      const result = await run(
        `UPDATE vip_orders SET status = 'failed', review_reason = 'provider_rejected_request'
          WHERE id = ? AND status = 'review' AND paid_at IS NULL AND refunded_at IS NULL`,
        row.id,
      )
      resolved += result.changes
    }
    return resolved
  }
  const userView = (user) => user ? {
    id: user.id, email: user.email,
    vipActive: Boolean(user.vip_expires_at && user.vip_expires_at > now()),
    vipExpiresAt: user.vip_expires_at ? new Date(user.vip_expires_at).toISOString() : null,
    // 老账号没有 email_verified 记录时按已验证处理，避免上线后老用户被锁。
    emailVerified: Number(user.email_verified ?? 1) === 1,
  } : null
  const orderView = (order) => {
    // 历史订单可能仍是改造前的 'base'（Base 链）通道。收款地址、链上收款方式都
    // 与现在的 BSC 通道一致，只是文案不同；这里统一按 BSC 呈现，避免旧订单
    // 落到 fallback 分支被显示成 TRON / TRC20，误导用户往错误的网络转账。
    const provider = order.provider === 'vaehub' ? 'vaehub'
      : order.provider === 'bsc' || order.provider === 'base' ? 'bsc'
      : 'nowpayments'
    const network = provider === 'vaehub'
      ? `${vaehub?.currency || order.pay_currency || 'USDT'} · ${vaehub?.country || ''}`.trim()
      : provider === 'bsc'
        ? `BSC (BNB Smart Chain) · BEP-20 ${order.token_symbol || bscChain?.config.symbol || 'USDT'}`
        : 'TRON / TRC20'
    return {
      id: order.id, planId: order.plan_id, planName: order.plan_name, days: order.days,
      amount: order.amount_cents / 100, currency: 'USDT', status: order.status, provider,
      createdAt: new Date(order.created_at).toISOString(),
      paidAt: order.paid_at === null ? null : new Date(order.paid_at).toISOString(),
      checkoutUrl: provider === 'vaehub' ? (order.checkout_url || null) : null,
      payAddress: order.pay_address, payAmount: order.pay_amount, payCurrency: order.pay_currency,
      // 链上通道的应付金额精确文本：尾数是订单唯一标识，不能被 JSON number 抹掉尾零。
      // 历史 'base' 订单没有这个字段，用数据库里的原始字符串兜底。
      payAmountText: order.pay_amount_text ?? (provider === 'bsc' ? rawPayAmount(order) : null),
      qrString: provider === 'vaehub' ? (order.qr_string || null) : null,
      qrExpiresAt: provider === 'vaehub' && order.qr_expires_at ? order.qr_expires_at : null,
      network, expiresAt: order.payment_expires_at,
      // 链上通道：链上凭据与网络信息，前端据此提示用户核对网络。
      // 历史 'base' 订单里的 chain_id 是 Base 的 8453，统一按当前链（56）呈现，
      // 否则前端会显示与 BSC 收款地址矛盾的链 ID。
      tokenSymbol: provider === 'bsc' ? (order.token_symbol || bscChain?.config.symbol || 'USDT') : null,
      chainId: provider === 'bsc' ? (bscChain?.config.chainId ?? order.chain_id ?? null) : null,
      tokenContract: provider === 'bsc' ? (bscChain?.config.tokenChecksum ?? null) : null,
      txHash: order.tx_hash || null,
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
  // 供测试直接读写库（造历史订单等场景）。
  router.__db = { query, run, transaction }
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

  /**
   * BSC 链通道建单：地址共用，靠「套餐价 + 唯一尾数偏移」区分订单。
   * 无第三方回调，下单只写库，链上到账由扫描器确认。
   */
  async function createBscOrder({ order }) {
    if (!bscChain) throw Object.assign(new Error('BSC 链支付暂未开放，请稍后再试'), { status: 503 })
    const config = bscChain.config
    const expiresAt = new Date(now() + config.orderTtlMs).toISOString()
    // 金额尾数必须在「可认领窗口」内保持唯一：
    // - 窗口 = 订单有效期 + 迟到宽限期。过期订单在宽限期内仍会被链上扫描认领，
    //   这段时间它的金额不能被新订单复用，否则迟到的转账会认领到新订单头上。
    // - 历史 'base' 通道与 'bsc' 共用同一个收款地址，金额同样不能撞车。
    const reserveBefore = now() - (config.orderTtlMs + config.latePaymentWindowMs)
    let assigned = null
    for (let attempt = 0; attempt < 5; attempt++) {
      const takenRows = await query.all(
        `SELECT pay_amount FROM vip_orders WHERE provider IN ('bsc','base') AND pay_amount IS NOT NULL AND created_at > ?`,
        reserveBefore,
      )
      const takenTotals = new Set()
      for (const row of takenRows) {
        try { takenTotals.add(toUnits(String(row.pay_amount), config.decimals).toString()) } catch { /* 忽略非法金额 */ }
      }
      const units = await bscChain.allocateForOrder(order, takenTotals)
      // 固定 4 位小数：尾数是订单唯一标识，尾零必须原样展示给用户。
      const amount = formatUnitsExact(units, config.decimals, config.displayDecimals)
      // 条件更新：只有金额仍未被占用时才落库，避免并发写同一个金额。
      // 这里用 status = 'creating' 作为并发守卫是刻意的：金额分配必须原子完成，
      // 所以先在同一句 SQL 里把状态推进到 pending，再由状态机接手后续迁移。
      const result = await run(`UPDATE vip_orders SET provider = 'bsc', pay_address = ?, pay_amount = ?, pay_amount_text = ?, pay_currency = ?,
        chain_id = ?, token_symbol = ?, payment_expires_at = ?, status = 'pending'
        WHERE id = ? AND status = 'creating' AND pay_amount IS NULL
          AND NOT EXISTS (SELECT 1 FROM (SELECT pay_amount FROM vip_orders WHERE provider IN ('bsc','base') AND created_at > ?) AS taken
            WHERE taken.pay_amount IS NOT NULL AND taken.pay_amount = ?)`,
      config.addressChecksum, amount, amount, config.symbol, config.chainId, config.symbol, expiresAt, order.id, reserveBefore, amount)
      if (result.changes) { assigned = amount; break }
    }
    if (!assigned) throw Object.assign(new Error('暂时无法分配支付金额，请重试'), { status: 409 })
  }

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
      // 4xx 是确定性拒绝（请求没被受理）→ failed；5xx 可能已经建单成功 → review。
      await transitionOrder({
        id: order.id,
        to: response.status >= 400 && response.status < 500 ? 'failed' : 'review',
        reason: `payment_http_${response.status}`,
      })
      throw Object.assign(new Error('暂时无法创建支付订单，请在订单记录中查看状态'), { status: 502 })
    }
    const payment = await response.json()
    const paymentId = providerId(payment.payment_id)
    const address = typeof payment.pay_address === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(payment.pay_address) ? payment.pay_address : null
    // pay_amount is explicitly supplied in USDT: never display an approximate USD conversion.
    if (!paymentId || !address || payment.pay_currency !== 'usdttrc20' || compareAmounts(payment.pay_amount, plan.price) !== 0 ||
      String(payment.price_currency).toLowerCase() !== 'usd' || compareAmounts(payment.price_amount, plan.price) !== 0 ||
      payment.order_id !== order.id || payment.payin_extra_id) throw new Error('Invalid provider payment')
    const providerExpiresAt = providerExpiry(payment.expiration_estimate_date) || providerExpiry(payment.valid_until)
    if (providerExpiresAt && Date.parse(providerExpiresAt) <= now()) throw new Error('Expired provider payment')
    // 渠道没给有效期时用本地兜底时长：没有截止时间的订单永远不会作废。
    const expiresAt = providerExpiresAt || new Date(now() + PROVIDER_ORDER_TTL_MS).toISOString()
    await run("UPDATE vip_orders SET payment_id = ?, pay_address = ?, pay_amount = ?, pay_currency = ?, payment_expires_at = ?, provider = 'nowpayments' WHERE id = ?",
      paymentId, address, plan.price, 'usdttrc20', expiresAt, order.id)
    await transitionOrder({ id: order.id, to: 'pending' })
  }

  async function createVaehubOrder({ order, plan, key }) {
    if (!vaehub) throw Object.assign(new Error('VaeHub 支付暂未开放，请稍后再试'), { status: 503 })
    const returnType = vaehubReturnType
    // 法币金额 = USDT 套餐价 × 汇率，向上取整到分，避免少收。
    const fiatAmount = Math.ceil(plan.price * vaehub.rate * 100) / 100
    const body = {
      order_id: order.id, country: vaehub.country, currency: vaehub.currency,
      amount: fiatAmount, return_type: returnType,
      // 文档标注 user_hash 为必填：用本站用户 id 做稳定哈希，避免外泄邮箱等明文。
      user_hash: vaehubUserHash(order.user_id),
    }
    if (vaehubPaycode) body.paycode = vaehubPaycode
    // mock_res 只在测试环境有意义，文档明确写「only applies in the test environment」。
    // 生产环境带上它会被忽略，但为了避免误解，不主动传。
    if (vaehub.sandbox && vaehub.mockRes) body.mock_res = vaehub.mockRes
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
      // HTTP 层失败：4xx 是确定性拒绝（请求没被受理），5xx 可能已经建单成功。
      await transitionOrder({
        id: order.id,
        to: response.status >= 400 && response.status < 500 ? 'failed' : 'review',
        reason: `vaehub_http_${response.status}`,
      })
      throw Object.assign(new Error('暂时无法创建支付订单，请在订单记录中查看状态'), { status: 502 })
    }
    const payload = await response.json().catch(() => null)
    // VaeHub 用 HTTP 200 + body.code 表达业务结果（实测：{"code":401,"msg":"IP not allowed"}）。
    // 业务级拒绝是确定性结论 —— 订单根本没在对方侧生成，不存在「钱付了但状态不明」，
    // 因此必须落 failed，而不是笼统的 review（review 会让用户干等人工核实）。
    if (payload && typeof payload === 'object' && Number(payload.code) !== 200) {
      const code = Number(payload.code)
      const reason = `vaehub_code_${Number.isFinite(code) ? code : 'unknown'}`
      await transitionOrder({ id: order.id, to: 'failed', reason })
      throw Object.assign(new Error('支付通道拒绝了本次建单请求，请稍后重试或更换支付方式。'), { status: 502, failed: true })
    }
    if (!payload || !payload.data || typeof payload.data !== 'object') {
      // 响应体损坏：无法判断对方是否已建单，属于真正需要人工核实的歧义情况。
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
    // 渠道没给有效期时用本地兜底时长：没有截止时间的订单永远不会作废，
    // 迟到的回调就能一直把它改成「等待人工核实」。
    const expiresAt = qrExpires || new Date(now() + (qrTtl || PROVIDER_ORDER_TTL_MS) * 1000).toISOString()
    // 建单响应自带状态：1=Success 2=Failed 3=Pending。
    // 建单返回 3=Pending 的语义是「已生成收款单，等客户付款」，所以留在 pending；
    // 只有 1（秒付成功）/ 2（渠道明确失败）才是终态，不能笼统写成 pending。
    const createdStatus = Number(data.status)
    const nextStatus = createdStatus === VAEHUB_PAYMENT_STATUS.SUCCESS ? 'paid'
      : createdStatus === VAEHUB_PAYMENT_STATUS.FAILED ? 'failed'
        : 'pending'
    // 先落支付信息，状态单独走状态机迁移，避免把 paid/failed 混进普通字段更新里绕过校验。
    await run(`UPDATE vip_orders SET provider = 'vaehub', payment_id = ?, pay_amount = ?, pay_currency = ?,
      checkout_url = ?, qr_string = ?, qr_expires_at = ?, payment_expires_at = ? WHERE id = ?`,
    openId, Number(fiatAmount), vaehub.currency, checkoutUrl, qrString, qrExpires, expiresAt, order.id)
    // 建单即成功（通道秒付）时直接开通会员，避免用户看到「等待支付」却钱已付。
    if (nextStatus === 'paid') {
      await markOrderPaid(order.id)
    } else {
      await transitionOrder({ id: order.id, to: nextStatus })
    }
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
    if (useProvider !== 'nowpayments' && useProvider !== 'vaehub' && useProvider !== 'bsc') return res.status(400).json({ error: '支付通道不可用' })
    if (useProvider === 'nowpayments' && !enabled) return res.status(503).json({ error: '加密货币支付暂未开放，请稍后再试' })
    if (useProvider === 'vaehub' && !vaehub) return res.status(503).json({ error: '加密货币支付暂未开放，请稍后再试' })
    if (useProvider === 'bsc' && !bscChain) return res.status(503).json({ error: '加密货币支付暂未开放，请稍后再试' })
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
      else if (useProvider === 'bsc') await createBscOrder({ order: created })
      else await createNowpaymentsOrder({ order: created, plan, key })
      return res.status(201).json({ order: orderView(await orderOf(id)) })
    } catch (error) {
      // 通道已明确拒绝（业务级错误码）：订单确定没建成功，落 failed 而不是 review。
      // review 的语义是「结果不明、需要人工核实」，确定性失败不该占用人工队列，
      // 更不该让用户对着「等待人工核实」干等。
      if (error?.failed) {
        return res.status(502).json({ error: error.message, order: orderView(await orderOf(id)) })
      }
      // Invalid provider response uncertain: keep the order for manual review, never auto-resubmit.
      if (error?.status === 502 || error?.status === 503) {
        return res.status(error.status).json({ error: error.message, order: orderView(await orderOf(id)) })
      }
      // 响应无法解析：对方是否已建单不明，属于真正的歧义 → 走人工核实。
      await transitionOrder({ id, to: 'review', reason: 'payment_response_uncertain' })
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

  // BSC 通道的付款二维码：内容是 EIP-681 支付 URI（代币 + 收款地址 + 金额 + chainId）。
  // 只允许本人查看自己的订单二维码，避免二维码被公开传播。
  router.get('/vip/orders/:id/qr', requireUser, asyncRoute(async (req, res) => {
    if (!bscChain) return res.status(503).json({ error: 'BSC 链支付暂未开放，请稍后再试' })
    const order = normalizeOrder(await query('SELECT * FROM vip_orders WHERE id = ? AND user_id = ?', req.params.id, req.vipUser.id))
    if (!order) return res.status(404).json({ error: '订单不存在' })
    if ((order.provider !== 'bsc' && order.provider !== 'base') || !order.pay_amount) {
      return res.status(400).json({ error: '该订单没有可用的付款二维码' })
    }
    const config = bscChain.config
    let units
    try {
      units = toUnits(String(order.pay_amount), config.decimals)
    } catch {
      return res.status(400).json({ error: '订单金额异常，请联系客服' })
    }
    const uri = buildPaymentUri(config, units)
    const svg = await buildQrSvg(uri)
    res.set('Content-Type', 'image/svg+xml; charset=utf-8')
    res.set('Cache-Control', 'private, max-age=300')
    return res.send(svg)
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
      // 状态机入口：非法迁移会被拒绝，订单保持原状态。
      const tx = { query: queryTx, run: runTx }
      // moneyReceived：确实收到了钱，只是金额/币种对不上 —— 这种必须人工核对，
      // 即使订单已过期也不能丢弃（否则用户的钱就没人管了）。
      const review = async (reason, moneyReceived = false) => transitionOrder({ id: order.id, to: 'review', reason, moneyReceived, tx })
      if (paymentId !== order.payment_id || (event.parent_payment_id !== undefined && event.parent_payment_id !== null) ||
        String(event.price_currency).toLowerCase() !== 'usd' ||
        compareAmounts(event.price_amount, (order.amount_cents / 100).toFixed(2)) !== 0 ||
        event.pay_currency !== 'usdttrc20' || compareAmounts(event.pay_amount, (order.amount_cents / 100).toFixed(2)) !== 0) {
        await review('payment_or_price_mismatch', true)
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
        // 退款一定要留墓碑：即使之后有迟到的 finished 回调，也不能把订单翻回已支付。
        // 退款可能发生在任何阶段（已支付 / 部分支付 / 渠道侧直接撤销），
        // 所以这里直接落终态，不走状态机的来源限制。
        await runTx(`UPDATE vip_orders SET refunded_at = COALESCE(refunded_at, ?),
          status = 'refunded',
          review_reason = CASE WHEN paid_at IS NOT NULL THEN 'refund_requires_entitlement_review' ELSE review_reason END WHERE id = ?`, now(), order.id)
        return { code: 200 }
      }
      if (order.refunded_at !== null) return { code: 200 }
      if (order.paid_at !== null) return { code: 200 }
      if (event.payment_status === 'finished') {
        // finished 是「钱确实到账」，即使订单已过期也必须承认 ——
        // 用户在截止前付了钱却拿不到会员，比状态显示难看严重得多。
        if (compareAmounts(event.actually_paid, (order.amount_cents / 100).toFixed(2)) === null ||
          compareAmounts(event.actually_paid, (order.amount_cents / 100).toFixed(2)) === -1) {
          await review('payment_amount_unverified', true)
          return { code: 200 }
        }
        const user = normalizeUser(await queryTx('SELECT * FROM vip_users WHERE id = ? FOR UPDATE', order.user_id))
        const paidAt = now()
        const expiresAt = Math.max(paidAt, user.vip_expires_at || 0) + order.days * DAY
        await runTx('UPDATE vip_users SET vip_expires_at = ? WHERE id = ?', expiresAt, user.id)
        await runTx("UPDATE vip_orders SET status = 'paid', paid_at = ?, review_reason = NULL WHERE id = ? AND paid_at IS NULL", paidAt, order.id)
        return { code: 200 }
      }
      const states = { waiting: 'pending', confirming: 'confirming', confirmed: 'confirming', sending: 'confirming', partially_paid: 'partially_paid', failed: 'failed', expired: 'expired' }
      const status = states[event.payment_status]
      if (!status) { await review('unknown_payment_status'); return { code: 200 } }
      // 状态机统一裁决：迟到的 waiting / confirming 不会把已失败、已过期、
      // 已退款或已进人工队列的订单拖回「进行中」。
      await transitionOrder({ id: order.id, to: status, tx })
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
        // 状态机入口：非法迁移会被拒绝，订单保持原状态。
        const tx = { query: queryTx, run: runTx }
        // moneyReceived：确实收到了钱，只是金额/币种对不上 —— 这种必须人工核对，
        // 即使订单已过期也不能丢弃（否则用户的钱就没人管了）。
        const review = async (reason, moneyReceived = false) => transitionOrder({ id: order.id, to: 'review', reason, moneyReceived, tx })
        if (order.refunded_at !== null) return { code: 200 }
        if (order.paid_at !== null) return { code: 200 }
        if (order.provider && order.provider !== 'vaehub') {
          await review('payment_or_price_mismatch')
          return { code: 422, error: 'ORDER_MISMATCH' }
        }
        // VaeHub may notify before the asynchronous create response returns.
        if (!order.payment_id) return { code: 503, error: 'ORDER_SYNCING' }
        if (paymentId !== order.payment_id) {
          await review('payment_or_price_mismatch')
          return { code: 422, error: 'ORDER_MISMATCH' }
        }
        const vaehubExpected = (order.pay_currency || '').toUpperCase() === 'USDT'
          ? (order.amount_cents / 100).toFixed(2)
          : Number(order.pay_amount).toFixed(2)
        const amountOk = compareAmounts(data.amount, vaehubExpected) === 0
        // 回调货币字段必须与建单币种一致；会员天数账本仍按订单的 USDT 套餐价结算。
        const currencyOk = typeof data.currency === 'string' && data.currency.toUpperCase() === String(order.pay_currency || vaehub.currency).toUpperCase()
        if (!amountOk || !currencyOk) {
          // 渠道报了金额，说明钱是动了的 —— 金额不符要人工核对，不能默默丢掉。
          await review('payment_or_price_mismatch', true)
          return { code: 422, error: 'ORDER_MISMATCH' }
        }
        const payment = await queryTx('SELECT * FROM vip_provider_payments WHERE payment_id = ?', paymentId)
        if (payment && payment.order_id !== order.id) {
          await review('payment_id_reused')
          return { code: 409, error: 'PAYMENT_REUSED' }
        }
        await runTx(`INSERT INTO vip_provider_payments (payment_id, order_id, invoice_id, last_status, expected_amount, actual_amount, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE
          last_status = VALUES(last_status), expected_amount = VALUES(expected_amount),
          actual_amount = VALUES(actual_amount), updated_at = VALUES(updated_at)`,
        paymentId, order.id, paymentId, `vaehub:${String(data.status)}`.slice(0, 80), String(data.amount ?? ''), String(data.amount_paid ?? data.amount ?? ''), now())
        const mapped = vaehubOrderStatus(data.status)
        if (mapped === 'paid') {
          // 1=Success：钱确实到账。即使订单已过期也必须承认 ——
          // 用户在截止前付了钱却拿不到会员，比状态显示难看严重得多。
          const user = normalizeUser(await queryTx('SELECT * FROM vip_users WHERE id = ? FOR UPDATE', order.user_id))
          const paidAt = now()
          const expiresAt = Math.max(paidAt, user.vip_expires_at || 0) + order.days * DAY
          await runTx('UPDATE vip_users SET vip_expires_at = ? WHERE id = ?', expiresAt, user.id)
          await runTx("UPDATE vip_orders SET status = 'paid', paid_at = ?, review_reason = NULL WHERE id = ? AND paid_at IS NULL", paidAt, order.id)
          return { code: 200 }
        }
        // 2=Failed / 5=Canceled：确定性失败，钱没到账，不需要人工核实。
        if (mapped === 'failed' || mapped === 'expired') {
          await transitionOrder({ id: order.id, to: mapped, clearReason: true, tx })
          return { code: 200 }
        }
        // 3=Pending / 4=Locked：渠道还在处理中，订单停在「支付确认中」等后续回调。
        if (mapped === 'confirming') {
          await transitionOrder({ id: order.id, to: 'confirming', tx })
          return { code: 200 }
        }
        // 未知状态码：确实需要人工判断，保留 review。
        await review('unknown_payment_status')
        return { code: 200 }
      })
    } catch {
      return sendPlain(500, 'ERROR')
    }
    if (result.code === 503) res.set('Retry-After', '5')
    if (result.code !== 200) return sendPlain(result.code, result.error || 'ERROR')
    return sendPlain(200, 'SUCCESS')
  }))

  // ---------- BSC 链到账扫描器 ----------
  // 地址共用 + 无第三方回调，只能靠扫链上日志发现到账，再按金额尾数定位订单。
  if (bscChain) {
    const config = bscChain.config
    /** 连续扫描失败次数：用于日志收敛，避免同一个错误每轮刷屏。 */
    let bscScanFailures = 0
    /** 可认领订单：链上通道订单里，还在「可认领窗口」内的那些。
     *
     *  窗口 = 订单有效期（15 分钟）+ 迟到宽限期（默认 24 小时）。
     *  - 包含历史 'base' 通道订单：收款地址相同、金额数值相同，用户可能仍在按
     *    这些订单付款，不认领的话钱到了却不开通会员。
     *  - 包含已过期（expired）但仍在宽限期的订单：用户在截止前一刻发起转账、
     *    链上确认偏慢是常态，钱已经进了收款地址，不能不认领。
     *  - 超过宽限期的订单不再认领：此时链上转账也早已被扫过。 */
    const listOpenBscOrders = async () => query.all(
      `SELECT id, user_id, days, pay_amount, status FROM vip_orders
        WHERE provider IN ('bsc','base') AND status IN ('pending','expired') AND pay_amount IS NOT NULL
          AND created_at > ?`,
      now() - (config.orderTtlMs + config.latePaymentWindowMs),
    )
    bscChain.setOrderSource(listOpenBscOrders)

    /**
     * 一次性迁移：把改造前留下的链上订单收敛到当前的订单约定。
     *
     * 改造前（'base' 通道）链上订单有两个与现在不一致的地方：
     * 1. 有效期写的是「创建时间 + 24 小时」，而不是现在的 15 分钟；
     * 2. 应付金额用的是 8 位小数尾数，且没有 pay_amount_text 精确文本。
     *
     * 这两类订单在页面上表现为「倒计时还有 2 小时」和「金额 10.007889」，
     * 与用户预期（15 分钟、4 位小数）不符。
     *
     * 金额能不能改，取决于**有没有在途转账**：
     * - 认领窗口（有效期 + 迟到宽限期）之内：可能有转账正在路上，金额必须原样保留。
     *   链上认领按 pay_amount 的数值比对，改一分钱用户按旧金额转的账就认领不到。
     * - 认领窗口之外：扫描器根本不会再看这些订单，不存在在途转账，
     *   此时可以安全地重新分配一个 4 位小数的金额，让展示与新约定一致。
     */
    const migrateLegacyBscOrders = async () => {
      const rows = await query.all(
        `SELECT id, amount_cents, created_at, pay_amount, pay_amount_text FROM vip_orders
          WHERE provider IN ('bsc','base') AND status IN ('pending','confirming','creating','expired')`,
      )
      // 认领窗口的起点：早于这个时间的订单，链上扫描器不会再认领。
      const claimCutoff = now() - (config.orderTtlMs + config.latePaymentWindowMs)
      let ttlFixed = 0
      let textFilled = 0
      let amountReallocated = 0
      for (const row of rows) {
        const createdAt = Number(row.created_at)
        // 1) 有效期统一收敛到「创建时间 + 15 分钟」。
        //    已经过了 15 分钟的订单会被过期扫描立即作废 —— 这正是「过期作废」的预期。
        if (Number.isFinite(createdAt)) {
          const expiresAt = new Date(createdAt + config.orderTtlMs).toISOString()
          const result = await run(
            'UPDATE vip_orders SET payment_expires_at = ? WHERE id = ? AND payment_expires_at <> ?',
            expiresAt, row.id, expiresAt,
          )
          ttlFixed += result.changes
        }
        if (row.pay_amount === null || row.pay_amount === undefined) continue
        // 2) 认领窗口之外的旧订单：重新分配一个 4 位小数的金额，与新约定对齐。
        //    窗口之内的跳过 —— 那里的金额可能对应着一笔在途转账。
        const outsideClaimWindow = Number.isFinite(createdAt) && createdAt < claimCutoff
        const decimals = String(row.pay_amount).includes('.')
          ? String(row.pay_amount).split('.')[1].replace(/0+$/, '').length
          : 0
        if (outsideClaimWindow && decimals > config.displayDecimals) {
          const reallocated = await reallocateLegacyAmount(row, config, claimCutoff)
          if (reallocated) { amountReallocated += 1; continue }
        }
        // 3) 金额文本缺失时补一份，数值不变 —— 展示文本必须与应付金额完全一致，
        //    否则用户按显示的金额转账反而认领不到订单。
        if (!row.pay_amount_text) {
          const text = rawPayAmount({ pay_amount: row.pay_amount, pay_amount_raw: String(row.pay_amount) })
          if (text) {
            const result = await run(
              'UPDATE vip_orders SET pay_amount_text = ? WHERE id = ? AND pay_amount_text IS NULL',
              text, row.id,
            )
            textFilled += result.changes
          }
        }
      }
      return { ttlFixed, textFilled, amountReallocated }
    }

    /**
     * 给一笔旧订单重新分配 4 位小数的应付金额。
     *
     * 复用链上通道同一套偏移分配逻辑，保证新金额的尾数规则与新订单一致，
     * 并且避开已被占用的金额（占用表按认领窗口计算，旧金额此时已释放）。
     */
    const reallocateLegacyAmount = async (row, config, claimCutoff) => {
      const takenRows = await query.all(
        `SELECT pay_amount FROM vip_orders
          WHERE provider IN ('bsc','base') AND pay_amount IS NOT NULL AND created_at > ?
            AND id <> ?`,
        claimCutoff, row.id,
      )
      const takenTotals = new Set()
      for (const taken of takenRows) {
        try { takenTotals.add(toUnits(String(taken.pay_amount), config.decimals).toString()) } catch { /* 忽略非法金额 */ }
      }
      let units
      try {
        units = await bscChain.allocateForOrder({ id: row.id, amount_cents: Number(row.amount_cents) }, takenTotals)
      } catch {
        return false
      }
      const amount = formatUnitsExact(units, config.decimals, config.displayDecimals)
      const result = await run(
        'UPDATE vip_orders SET pay_amount = ?, pay_amount_text = ? WHERE id = ? AND pay_amount = ?',
        amount, amount, row.id, row.pay_amount,
      )
      return result.changes > 0
    }

    /**
     * 把超时未支付的链上订单置为 expired（过期作废）。
     *
     * 链上通道没有第三方回调，订单过期只能由本地判定。过期后：
     * - 前端不再展示收款地址与二维码，倒计时归零即作废；
     * - 金额尾数在迟到宽限期内仍被保留，不会被新订单抢走。
     *
     * payment_expires_at 是字符串列，历史数据的格式不完全一致（ISO 与
     * 'YYYY-MM-DD HH:mm:ss' 都存在），所以这里取回后在 JS 里用 Date.parse
     * 判定，而不是在 SQL 里做字符串比较。
     */
    const expireBscOrders = async () => {
      const rows = await query.all(
        `SELECT id, payment_expires_at FROM vip_orders
          WHERE provider IN ('bsc','base') AND status = 'pending' AND payment_expires_at IS NOT NULL`,
      )
      const deadline = now()
      let expired = 0
      for (const row of rows) {
        const timestamp = Date.parse(String(row.payment_expires_at))
        // 解析失败的时间不能当成已过期，否则会误作废还能正常支付的订单。
        if (!Number.isFinite(timestamp) || timestamp > deadline) continue
        const result = await run(
          "UPDATE vip_orders SET status = 'expired' WHERE id = ? AND status = 'pending' AND paid_at IS NULL AND refunded_at IS NULL",
          row.id,
        )
        expired += result.changes
      }
      return expired
    }

    /** 开通会员 + 订单置为已支付。幂等：已支付的订单不再重复加时长。 */
    const markBscPaid = async (orderId, info) => {
      const order = normalizeOrder(await query('SELECT * FROM vip_orders WHERE id = ?', orderId))
      if (!order) return
      if (order.provider !== 'bsc' && order.provider !== 'base') return
      await markOrderPaid(orderId, { txHash: info.txHash })
    }

    /** 金额不符：转人工核对，绝不自动开通。 */
    const markBscMismatch = async (orderId, info) => {
      // 走状态机：已失败 / 已退款的订单不再被拖进人工队列。
      // 链上确实收到了钱但金额不符，即使订单已过期也要人工核对
      // （用户的钱不能因为超时就不管了），moneyReceived 放行 expired -> review。
      await transitionOrder({
        id: orderId,
        to: 'review',
        reason: `bsc_amount_mismatch:${formatUnits(info.receivedUnits, config.decimals)}`,
        txHash: info.txHash,
        moneyReceived: true,
      })
    }

    /** 跑一轮扫描；出错只记录日志，不影响服务。 */
    const runBscScan = async () => {
      // 先把超时未支付的订单作废，再扫描链上到账。
      // 顺序很重要：过期作废后订单进入 expired 状态，但仍在迟到宽限期内，
      // 迟到的转账依旧能认领回原订单。
      try {
        const expired = await expireBscOrders()
        if (expired > 0) logger.log(`[bsc] ${expired} 笔订单已超时作废`)
      } catch (error) {
        logger.error('[bsc] expire failed:', error?.stack || error?.message || error)
      }
      try {
        const result = await bscChain.scan(markBscPaid, markBscMismatch)
        bscScanFailures = 0
        if (result.matched > 0) logger.log(`[bsc] ${result.matched} 笔到账已确认`)
      } catch (error) {
        // 扫描失败往往是节点不可用（网络抖动 / 全部 RPC 挂掉），会每轮重复。
        // 连续失败只打一次日志，恢复后也不重复刷屏 —— 否则日志会被同一个错误刷满。
        bscScanFailures += 1
        if (bscScanFailures === 1 || bscScanFailures % 20 === 0) {
          logger.error(`[bsc] scan failed (${bscScanFailures} consecutive):`, error?.message || error)
        }
      }
    }

    // 首次扫描在启动后稍作延迟，避免与数据库初始化抢占资源。
    const bscTimer = setInterval(() => { void runBscScan() }, config.pollIntervalMs)
    bscTimer.unref?.()
    // 启动时先收敛改造前留下的链上订单（有效期 15 分钟、金额 4 位小数），
    // 再开始扫描 —— 否则页面上的倒计时会一直按旧的 24 小时显示。
    setTimeout(() => {
      void migrateLegacyBscOrders()
        .then((result) => {
          if (result.ttlFixed > 0 || result.textFilled > 0 || result.amountReallocated > 0) {
            logger.log(`[bsc] 存量订单已收敛：${result.ttlFixed} 笔有效期改为 15 分钟，${result.amountReallocated} 笔金额改为 4 位小数，${result.textFilled} 笔补齐金额文本`)
          }
        })
        .catch((error) => logger.error('[bsc] legacy migration failed:', error?.message || error))
    }, 500).unref?.()
    setTimeout(() => { void runBscScan() }, 2_000).unref?.()
    // 供测试手动触发一次扫描。
    router.__bscScan = runBscScan
    router.__migrateLegacyBscOrders = migrateLegacyBscOrders
    router.__bscService = bscChain
    logger.log(`[bsc] 收款地址 ${config.addressChecksum} · ${config.symbol} · chain ${config.chainId} · ${config.displayDecimals} 位小数`)
  }

  // 第三方通道（VaeHub / NOWPayments）的订单到期作废。
  // 定时把超时的订单置为 expired，订单状态才与页面上的倒计时一致；
  // 否则订单会一直停在 pending，迟到的回调就能把它改写成「等待人工核实」。
  /** 连续失败次数：用于日志收敛。 */
  let expirySweepFailures = 0
  const runExpirySweep = async () => {
    try {
      const expired = await expireStaleOrders()
      expirySweepFailures = 0
      if (expired > 0) logger.log(`[vip] ${expired} 笔超时订单已作废`)
      // 顺手把旧代码误判成 review 的确定性失败收敛掉。
      const resolved = await resolveRejectedThirdPartyOrders()
      if (resolved > 0) logger.log(`[vip] ${resolved} 笔通道已拒绝的订单已标记为失败`)
    } catch (error) {
      // 同上：连续失败只打一次日志，避免刷屏。
      expirySweepFailures += 1
      if (expirySweepFailures === 1 || expirySweepFailures % 20 === 0) {
        logger.error(`[vip] expiry sweep failed (${expirySweepFailures} consecutive):`, error?.message || error)
      }
    }
  }
  const expiryTimer = setInterval(() => { void runExpirySweep() }, 30_000)
  expiryTimer.unref?.()
  setTimeout(() => { void runExpirySweep() }, 3_000).unref?.()
  // 供测试手动触发一次过期扫描。
  router.__expirySweep = runExpirySweep

  router.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: '请求内容过大' })
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: '无效的 JSON 请求' })
    console.error('[vip] request failed:', error?.code || error?.name || 'Error')
    return res.status(500).json({ error: '服务暂时不可用，请稍后再试' })
  })
  return router
}
