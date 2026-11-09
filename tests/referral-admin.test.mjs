import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import express from 'express'
import mysql from 'mysql2/promise'
import { createReferralService, initReferralSchema, maskEmail, isValidCode } from '../server/referral.js'
import { createReferralRouter } from '../server/referral-router.js'
import { createAdminAuth, initAdminSchema, createAdminUser } from '../server/admin/auth.js'
import { createPaymentAdminRouter } from '../server/admin/payment.js'
import { createRecommendAdminRouter, initRecommendSchema, createRecommendReader } from '../server/admin/recommend.js'
import { requireSameOrigin } from '../server/admin/auth.js'
import { mysqlConfig } from '../server/db.js'

/**
 * 邀请模块 + 两个后台的集成测试。
 *
 * 全部跑在独立的临时 MySQL 库上，测试结束后删库。
 * 依赖真实 MySQL：这些模块的核心约束（唯一索引、外键、事务）靠数据库保证，
 * 用内存替身测不出来。
 */

async function withDatabase(run) {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  const env = {
    ...process.env,
    MYSQL_HOST: process.env.MYSQL_HOST || '127.0.0.1',
    MYSQL_PORT: process.env.MYSQL_PORT || '3306',
    MYSQL_USER: process.env.MYSQL_USER || 'root',
    MYSQL_PASSWORD: process.env.MYSQL_PASSWORD ?? '123456',
    MYSQL_DATABASE: `duanju_test_referral_${suffix}`,
  }
  const config = mysqlConfig(env)
  const admin = await mysql.createConnection({
    host: config.host, port: config.port, user: config.user, password: config.password,
  })
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`)
  await admin.end()
  const pool = mysql.createPool({ ...config, supportBigNumbers: true, connectionLimit: 5 })
  try {
    return await run(pool)
  } finally {
    await pool.end()
    const cleanup = await mysql.createConnection({
      host: config.host, port: config.port, user: config.user, password: config.password,
    })
    await cleanup.query(`DROP DATABASE IF EXISTS \`${config.database}\``)
    await cleanup.end()
  }
}

/** 建一个前台用户（只用到 id 与邮箱）。 */
async function createUser(pool, email) {
  const id = randomUUID()
  await pool.execute(
    'INSERT INTO vip_users (id, email, password_hash, email_verified, created_at) VALUES (?, ?, ?, 1, ?)',
    [id, email, 'salt:hash', Date.now()],
  )
  return { id, email }
}

async function fixture(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vip_users (
      id VARCHAR(36) PRIMARY KEY,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      vip_expires_at BIGINT NULL,
      email_verified TINYINT NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL
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
      invoice_id VARCHAR(100) NULL,
      review_reason VARCHAR(128) NULL,
      payment_id VARCHAR(100) NULL,
      pay_address VARCHAR(64) NULL,
      pay_amount DECIMAL(20,8) NULL,
      pay_currency VARCHAR(10) NULL,
      payment_expires_at VARCHAR(64) NULL,
      provider VARCHAR(20) NULL,
      qr_string TEXT NULL,
      qr_expires_at VARCHAR(64) NULL,
      chain_id INT NULL,
      token_symbol VARCHAR(16) NULL,
      pay_amount_text VARCHAR(64) NULL,
      tx_hash VARCHAR(80) NULL,
      UNIQUE KEY uq_orders_user_key (user_id, idempotency_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dramas (
      id VARCHAR(128) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      cover VARCHAR(512) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  await initReferralSchema(pool)
  await initAdminSchema(pool)
  await initRecommendSchema(pool)
  return { referral: createReferralService({ pool }) }
}

test('every user gets a stable invite code', async () => {
  await withDatabase(async (pool) => {
    const { referral } = await fixture(pool)
    const user = await createUser(pool, 'a@example.test')
    const first = await referral.ensureCode(user.id)
    const second = await referral.ensureCode(user.id)
    assert.equal(first, second)
    assert.ok(isValidCode(first))
    // 不同用户拿到不同的码。
    const other = await createUser(pool, 'b@example.test')
    assert.notEqual(await referral.ensureCode(other.id), first)
  })
})

test('a referral can only be bound once and never loops back', async () => {
  await withDatabase(async (pool) => {
    const { referral } = await fixture(pool)
    const inviter = await createUser(pool, 'inviter@example.test')
    const invitee = await createUser(pool, 'invitee@example.test')
    const code = await referral.ensureCode(inviter.id)

    const first = await referral.bind({ inviterUserId: inviter.id, inviteeUserId: invitee.id, code })
    assert.equal(first.bound, true)
    // 重复绑定保持原关系，不覆盖。
    const again = await referral.bind({ inviterUserId: inviter.id, inviteeUserId: invitee.id, code })
    assert.equal(again.bound, false)
    assert.equal(again.reason, 'already_bound')

    // 不能邀请自己。
    const self = await referral.bind({ inviterUserId: invitee.id, inviteeUserId: invitee.id, code })
    assert.equal(self.reason, 'self_invite')

    // A 邀 B 之后，B 不能反过来邀 A（否则成环）。
    const cycle = await referral.bind({ inviterUserId: invitee.id, inviteeUserId: inviter.id, code: await referral.ensureCode(invitee.id) })
    assert.equal(cycle.bound, false)
  })
})

test('deep referral chains stay trees: a descendant cannot be re-bound to an ancestor', async () => {
  await withDatabase(async (pool) => {
    const { referral } = await fixture(pool)
    const a = await createUser(pool, 'chain-a@example.test')
    const b = await createUser(pool, 'chain-b@example.test')
    const c = await createUser(pool, 'chain-c@example.test')
    const d = await createUser(pool, 'chain-d@example.test')

    // A → B → C → D 是一条链。
    assert.equal((await referral.bind({ inviterUserId: a.id, inviteeUserId: b.id, code: await referral.ensureCode(a.id) })).bound, true)
    assert.equal((await referral.bind({ inviterUserId: b.id, inviteeUserId: c.id, code: await referral.ensureCode(b.id) })).bound, true)
    assert.equal((await referral.bind({ inviterUserId: c.id, inviteeUserId: d.id, code: await referral.ensureCode(c.id) })).bound, true)

    // D 已经绑给 C，不能再改绑给链上游的 A（否则会成环）。
    const reparent = await referral.bind({ inviterUserId: a.id, inviteeUserId: d.id, code: await referral.ensureCode(a.id) })
    assert.equal(reparent.bound, false)
    assert.equal(reparent.reason, 'already_bound')

    // 链上的每个人依然只有一个邀请人，且关系保持原样。
    const rows = await referral.__queryAll(
      'SELECT inviter_user_id, invitee_user_id FROM referral_relations WHERE invitee_user_id IN (?, ?, ?, ?)',
      a.id, b.id, c.id, d.id,
    )
    const edges = rows.map((row) => `${row.inviter_user_id}->${row.invitee_user_id}`)
    assert.ok(edges.includes(`${a.id}->${b.id}`))
    assert.ok(edges.includes(`${b.id}->${c.id}`))
    assert.ok(edges.includes(`${c.id}->${d.id}`))
  })
})

test('a referral code only binds to its own owner', async () => {
  await withDatabase(async (pool) => {
    const { referral } = await fixture(pool)
    const owner = await createUser(pool, 'code-owner@example.test')
    const other = await createUser(pool, 'code-other@example.test')
    const invitee = await createUser(pool, 'code-invitee@example.test')
    const code = await referral.ensureCode(owner.id)

    // 拿着 A 的码，却声称邀请人是 B —— 绑定必须拒绝。
    const forged = await referral.bind({ inviterUserId: other.id, inviteeUserId: invitee.id, code })
    assert.equal(forged.bound, false)
    assert.equal(forged.reason, 'invalid_code')

    // 真正的邀请人能绑上。
    const real = await referral.bind({ inviterUserId: owner.id, inviteeUserId: invitee.id, code })
    assert.equal(real.bound, true)
  })
})

test('the invite overview masks emails and counts invitations', async () => {
  await withDatabase(async (pool) => {
    const { referral } = await fixture(pool)
    const inviter = await createUser(pool, 'inviter@example.test')
    const invitee = await createUser(pool, 'secret@example.test')
    const code = await referral.ensureCode(inviter.id)
    await referral.bind({ inviterUserId: inviter.id, inviteeUserId: invitee.id, code })

    const overview = await referral.overview(inviter.id)
    assert.equal(overview.code, code)
    assert.equal(overview.invitedCount, 1)
    assert.equal(overview.invited.length, 1)
    // 邮箱必须脱敏，不能把完整邮箱下发给前端列表。
    assert.ok(!overview.invited[0].email.includes('secret@example.test'))
    assert.ok(overview.invited[0].email.endsWith('@example.test'))

    // 被邀请人能看到自己的邀请人。
    const inviteeView = await referral.overview(invitee.id)
    assert.equal(inviteeView.invitedBy.code, code)
  })
})

test('maskEmail keeps the domain and hides the local part', () => {
  assert.equal(maskEmail('user@example.com'), 'u***@example.com')
  assert.equal(maskEmail('a@example.com'), 'a*@example.com')
  assert.equal(maskEmail('not-an-email'), '')
})

test('the referral router requires a signed-in user', async () => {
  await withDatabase(async (pool) => {
    const { referral } = await fixture(pool)
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => { req.vipUser = null; next() })
    app.use('/api/referral', createReferralRouter({ referral }))
    const server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}/api/referral`
    try {
      const overview = await fetch(`${base}/overview`)
      assert.equal(overview.status, 401)
      const bind = await fetch(`${base}/bind`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'ABC234' }),
      })
      assert.equal(bind.status, 401)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

test('admin accounts authenticate and are scoped by role', async () => {
  await withDatabase(async (pool) => {
    await initAdminSchema(pool)
    const paymentAuth = createAdminAuth({ pool, allowedRoles: ['payment', 'super'], cookieName: 'duanju_admin_payment' })
    const recommendAuth = createAdminAuth({ pool, allowedRoles: ['referral', 'super'], cookieName: 'duanju_admin_recommend' })
    await createAdminUser(pool, { username: 'pay', password: 'Correct-Horse-972!', role: 'payment' })
    await createAdminUser(pool, { username: 'ref', password: 'Correct-Horse-972!', role: 'referral' })

    const app = express()
    app.use(express.json())
    app.use('/admin-api/payment', paymentAuth)
    app.use('/admin-api/recommend', recommendAuth)
    const server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    try {
      const bad = await fetch(`${base}/admin-api/payment/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'pay', password: 'wrong-password' }),
      })
      assert.equal(bad.status, 401)

      const login = await fetch(`${base}/admin-api/payment/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'pay', password: 'Correct-Horse-972!' }),
      })
      assert.equal(login.status, 200)
      const cookie = login.headers.get('set-cookie').split(';')[0]
      assert.match(login.headers.get('set-cookie'), /HttpOnly/i)

      // 支付角色不能进推荐后台。
      const cross = await fetch(`${base}/admin-api/recommend/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'pay', password: 'Correct-Horse-972!' }),
      })
      assert.equal(cross.status, 403)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

test('the payment admin can confirm a reviewed order and grant membership', async () => {
  await withDatabase(async (pool) => {
    const { referral } = await fixture(pool)
    const user = await createUser(pool, 'buyer@example.test')
    const orderId = randomUUID()
    await pool.execute(
      `INSERT INTO vip_orders (id, user_id, idempotency_key, plan_id, plan_name, days, amount_cents, status, created_at, provider, review_reason)
       VALUES (?, ?, ?, 'month', '月度会员', 30, 1000, 'review', ?, 'bsc', 'bsc_amount_mismatch:9.5')`,
      [orderId, user.id, randomUUID(), Date.now()],
    )

    const auth = createAdminAuth({ pool, allowedRoles: ['payment', 'super'], cookieName: 'duanju_admin_payment' })
    await createAdminUser(pool, { username: 'pay', password: 'Correct-Horse-972!', role: 'payment' })
    const app = express()
    app.use(express.json())
    app.use('/admin-api/payment', auth)
    app.use('/admin-api/payment', auth.__requireAdmin, createPaymentAdminRouter({ pool, referral }))
    const server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}/admin-api/payment`
    try {
      const login = await fetch(`${base}/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'pay', password: 'Correct-Horse-972!' }),
      })
      const cookie = login.headers.get('set-cookie').split(';')[0]

      const confirm = await fetch(`${base}/orders/${orderId}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ action: 'confirm' }),
      })
      assert.equal(confirm.status, 200)

      // 会员时长必须真的开通（后台确认走的是与支付回调相同的账本）。
      const [rows] = await pool.execute('SELECT vip_expires_at FROM vip_users WHERE id = ?', [user.id])
      assert.ok(Number(rows[0].vip_expires_at) > Date.now())

      // 订单进入人工队列前必须先登录。
      const anonymous = await fetch(`${base}/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      assert.equal(anonymous.status, 401)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

test('the recommend admin creates slots and items', async () => {
  await withDatabase(async (pool) => {
    await fixture(pool)
    const auth = createAdminAuth({ pool, allowedRoles: ['referral', 'super'], cookieName: 'duanju_admin_recommend' })
    await createAdminUser(pool, { username: 'ref', password: 'Correct-Horse-972!', role: 'referral' })
    const recommendRouter = createRecommendAdminRouter({ pool })
    const app = express()
    app.use(express.json())
    app.use('/admin-api/recommend', auth)
    app.use('/admin-api/recommend', auth.__requireAdmin, recommendRouter)
    const server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}/admin-api/recommend`
    try {
      const login = await fetch(`${base}/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ref', password: 'Correct-Horse-972!' }),
      })
      const cookie = login.headers.get('set-cookie').split(';')[0]

      const created = await fetch(`${base}/slots`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ key: 'home_test', name: '测试位', weight: 50, itemLimit: 5 }),
      })
      assert.equal(created.status, 201)
      const slot = (await created.json()).slot

      await pool.execute('INSERT INTO dramas (id, title, cover) VALUES (?, ?, ?)', ['drama-1', '第一部剧', null])
      const added = await fetch(`${base}/slots/${slot.id}/items`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ dramaId: 'drama-1', weight: 10 }),
      })
      assert.equal(added.status, 201)
      const item = (await added.json()).item
      assert.equal(item.title, '第一部剧')

      // 同一剧不能重复加入同一位。
      const duplicate = await fetch(`${base}/slots/${slot.id}/items`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ dramaId: 'drama-1' }),
      })
      assert.equal(duplicate.status, 409)

      const items = await fetch(`${base}/slots/${slot.id}/items`, { headers: { Cookie: cookie } })
      assert.equal((await items.json()).items.length, 1)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

test('推荐位读取器返回启用位里的条目（回归：mysql2 绑定参数必须是数组）', async () => {
  await withDatabase(async (pool) => {
    await initRecommendSchema(pool)
    const router = createRecommendAdminRouter({ pool })
    await router.__seedSlots()

    const [slots] = await pool.execute('SELECT * FROM recommend_slots WHERE slot_key = ?', ['home_featured'])
    const slot = slots[0]
    await pool.execute(
      'INSERT INTO recommend_items (id, slot_id, drama_id, weight, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)',
      ['item-1', slot.id, 'drama-a', 5, Date.now(), Date.now()],
    )
    // 停用的条目不应该被推给前台。
    await pool.execute(
      'INSERT INTO recommend_items (id, slot_id, drama_id, weight, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?)',
      ['item-2', slot.id, 'drama-b', 9, Date.now(), Date.now()],
    )

    const readSlots = createRecommendReader({ pool })
    const result = await readSlots()
    const featured = result.find((slot) => slot.key === 'home_featured')
    assert.ok(featured, '应读到 home_featured 推荐位')
    assert.equal(featured.items.length, 1)
    assert.equal(featured.items[0].dramaId, 'drama-a')
  })
})

test('同源校验：认 X-Forwarded-Host，反代下的同源请求不应被误判为跨站', () => {
  const call = (headers) => {
    const req = {
      method: 'POST',
      get: (name) => headers[name.toLowerCase()],
    }
    let status = 200
    let body = null
    const res = { status: (code) => { status = code; return res }, json: (payload) => { body = payload; return res } }
    requireSameOrigin(req, res, () => {})
    return { status, body }
  }

  // 直连：Origin 与 Host 一致 → 放行。
  assert.equal(call({ origin: 'https://admin.example.com', host: 'admin.example.com' }).status, 200)
  // 反代：Host 被改写成上游，真实域名在 X-Forwarded-Host → 放行。
  assert.equal(call({
    origin: 'https://admin.example.com',
    host: 'localhost:3001',
    'x-forwarded-host': 'admin.example.com',
  }).status, 200)
  // 真跨站 → 拒绝。
  assert.equal(call({ origin: 'https://evil.example.com', host: 'admin.example.com' }).status, 403)
  // GET 不做校验。
  const getReq = { method: 'GET', get: () => 'admin.example.com' }
  let passed = false
  requireSameOrigin(getReq, { status: () => ({ json: () => ({}) }) }, () => { passed = true })
  assert.equal(passed, true)
})
