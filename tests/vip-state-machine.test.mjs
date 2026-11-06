/**
 * 订单状态机的回归测试。
 *
 * 用户报的 bug：订单已经超时，刷新一下却变成「等待人工核实」。
 * 根因不在扫描，而在状态扭转：
 *   - 订单到期后没人把它置为 expired，一直停在 pending；
 *   - 迟到的回调把已作废的订单改写成 review；
 *   - 已失败的订单又被改写成 confirming / pending。
 *
 * 这些测试把状态机的每条边都钉死，防止以后再被改回去。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { request as httpRequest } from 'node:http'
import express from 'express'
import { createVipRouter } from '../server/vip.js'

const ORIGIN = 'https://vip-state-machine.example.test'
const SECRET = 'state-machine-test-secret'
const TIMESTAMP = Date.parse('2026-09-18T08:00:00.000Z')
const TEST_CAPTCHA = { enabled: true, issue: () => ({ text: 'TESTCAPTCHA', svg: '<svg/>' }) }

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

async function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duanju-vip-state-'))
  const payments = new Map()
  let responseOverride = {}
  let base, router, server
  let timestamp = TIMESTAMP
  const env = {
    NODE_ENV: 'test', APP_URL: ORIGIN,
    NOWPAYMENTS_API_KEY: 'now-key', NOWPAYMENTS_IPN_SECRET: SECRET,
    MYSQL_HOST: process.env.MYSQL_HOST || '127.0.0.1',
    MYSQL_PORT: process.env.MYSQL_PORT || '3306',
    MYSQL_USER: process.env.MYSQL_USER || 'root',
    MYSQL_PASSWORD: process.env.MYSQL_PASSWORD ?? '123456',
    MYSQL_DATABASE: `duanju_test_state_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    ...options.env,
  }
  const fetchImpl = async (url, request) => {
    const body = JSON.parse(request.body)
    const response = {
      ...body, payment_id: String(9100 + payments.size), payment_status: 'waiting',
      pay_address: 'T' + '2'.repeat(33), expiration_estimate_date: '2026-09-25T08:00:00.000Z',
      ...responseOverride,
    }
    payments.set(body.order_id, response)
    return new Response(JSON.stringify(response), { status: 201 })
  }
  async function close() {
    if (!server) return
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await router.close?.()
    server = null
  }
  async function start() {
    router = await createVipRouter({ env, fetchImpl, now: () => timestamp, captcha: TEST_CAPTCHA })
    const app = express()
    app.use('/api', router)
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
    })
    base = `http://127.0.0.1:${server.address().port}/api`
  }
  t.after(async () => { await close(); fs.rmSync(directory, { recursive: true, force: true }) })
  await start()
  async function request(route, { cookie, body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
        },
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => resolve({
          status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), headers: new Headers(response.headers),
        }))
      })
      outgoing.on('error', reject)
      outgoing.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  async function captchaBody() {
    const res = await request('/auth/captcha')
    assert.equal(res.status, 200, JSON.stringify(res.body))
    return { captchaId: res.body.id, captchaText: 'TESTCAPTCHA' }
  }
  const account = await request('/auth/register', { body: { email: `${randomUUID()}@example.test`, password: 'State-Machine-Test-983', ...(await captchaBody()) } })
  assert.equal(account.status, 201)
  const cookie = account.headers.get('set-cookie').split(';')[0]
  async function create(planId = 'month') {
    const res = await request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId, provider: 'nowpayments' } })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    return res.body.order
  }
  async function getOrder(id) {
    const res = await request(`/vip/orders/${id}`, { cookie })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    return res.body.order
  }
  function event(order, changes = {}) {
    const payment = payments.get(order.id)
    return {
      order_id: order.id, payment_id: payment.payment_id, invoice_id: null,
      parent_payment_id: null, payment_status: 'finished', price_amount: order.amount,
      price_currency: 'usd', pay_amount: order.amount, pay_currency: 'usdttrc20',
      actually_paid: order.amount, ...changes,
    }
  }
  async function callback(payload) {
    const signature = createHmac('sha512', SECRET).update(JSON.stringify(canonical(payload))).digest('hex')
    return request('/payments/nowpayments/ipn', { body: payload, headers: { 'x-nowpayments-sig': signature } })
  }
  return {
    request, cookie, create, getOrder, event, callback, router,
    user: async () => (await request('/auth/me', { cookie })).body.user,
    override: (value) => { responseOverride = value },
    setTime: (value) => { timestamp = value },
    /** 把订单的支付截止时间改到过去，模拟「用户下单后放着不管」。 */
    ageOrder: async (id, iso) => {
      await router.__db.run('UPDATE vip_orders SET payment_expires_at = ? WHERE id = ?', iso, id)
    },
    sweep: () => router.__expirySweep(),
  }
}

test('an overdue third-party order is voided by the server sweep', async (t) => {
  const f = await setup(t)
  const order = await f.create()
  assert.equal(order.status, 'pending')

  // 渠道给的收款单到期时间已过 → 订单必须作废，而不是继续停在「等待支付」。
  const expiredAt = new Date(TIMESTAMP + 60_000).toISOString()
  await f.ageOrder(order.id, expiredAt)
  f.setTime(TIMESTAMP + 120_000)
  await f.sweep()

  assert.equal((await f.getOrder(order.id)).status, 'expired')
  assert.equal((await f.user()).vipActive, false)
})

test('a late callback never revives a voided order into manual review', async (t) => {
  const f = await setup(t)
  const order = await f.create()
  const expiredAt = new Date(TIMESTAMP + 60_000).toISOString()
  await f.ageOrder(order.id, expiredAt)
  f.setTime(TIMESTAMP + 120_000)
  await f.sweep()
  assert.equal((await f.getOrder(order.id)).status, 'expired')

  // 迟到的各种状态回调都不得把已作废的订单改写成「等待人工核实」。
  for (const payment_status of ['waiting', 'confirming', 'confirmed', 'sending', 'partially_paid']) {
    await f.callback(f.event(order, { payment_status, actually_paid: '' }))
    assert.equal(
      (await f.getOrder(order.id)).status,
      'expired',
      `迟到的 ${payment_status} 回调不得改变已作废订单的状态`,
    )
  }
  // 未知状态码同样不得改写。
  await f.callback(f.event(order, { payment_status: 'totally-unknown' }))
  assert.equal((await f.getOrder(order.id)).status, 'expired')
  assert.equal((await f.user()).vipActive, false)
})

test('a late success callback still grants membership for a voided order', async (t) => {
  // 作废不等于丢钱：用户在截止前一刻付了钱、只是回调来得晚，会员必须开通。
  const f = await setup(t)
  const order = await f.create()
  const expiredAt = new Date(TIMESTAMP + 60_000).toISOString()
  await f.ageOrder(order.id, expiredAt)
  f.setTime(TIMESTAMP + 120_000)
  await f.sweep()
  assert.equal((await f.getOrder(order.id)).status, 'expired')

  await f.callback(f.event(order))
  assert.equal((await f.getOrder(order.id)).status, 'paid')
  assert.equal((await f.user()).vipActive, true)
})

test('a voided order with a wrong amount still goes to manual review', async (t) => {
  // 金额不符说明钱确实动了，只是数目不对 —— 必须人工核对，
  // 不能因为订单已过期就把用户的钱丢掉不管。
  const f = await setup(t)
  const order = await f.create()
  const expiredAt = new Date(TIMESTAMP + 60_000).toISOString()
  await f.ageOrder(order.id, expiredAt)
  f.setTime(TIMESTAMP + 120_000)
  await f.sweep()
  assert.equal((await f.getOrder(order.id)).status, 'expired')

  await f.callback(f.event(order, { actually_paid: '1' }))
  assert.equal((await f.getOrder(order.id)).status, 'review')
  assert.equal((await f.user()).vipActive, false)
})

test('a failed order is never dragged back into progress or review', async (t) => {
  const f = await setup(t)
  const order = await f.create()
  await f.callback(f.event(order, { payment_status: 'failed' }))
  assert.equal((await f.getOrder(order.id)).status, 'failed')

  // 迟到的进度类回调不得把已失败的订单改回「等待支付 / 支付确认中」。
  for (const payment_status of ['waiting', 'confirming', 'confirmed', 'sending']) {
    await f.callback(f.event(order, { payment_status, actually_paid: '' }))
    assert.equal((await f.getOrder(order.id)).status, 'failed', `迟到的 ${payment_status} 不得复活已失败订单`)
  }
  assert.equal((await f.user()).vipActive, false)
})

test('a refunded order keeps its tombstone against late callbacks', async (t) => {
  const f = await setup(t)
  const order = await f.create()
  await f.callback(f.event(order, { payment_status: 'refunded' }))
  assert.equal((await f.getOrder(order.id)).status, 'refunded')

  await f.callback(f.event(order))
  await f.callback(f.event(order, { payment_status: 'confirmed' }))
  assert.equal((await f.getOrder(order.id)).status, 'refunded')
  assert.equal((await f.user()).vipActive, false)
  assert.equal((await f.user()).vipExpiresAt, null)
})

test('a deterministically rejected order is converged from review to failed', async (t) => {
  // 早期版本把 VaeHub 这类「HTTP 200 + 业务码拒绝」误判成了结果不明，
  // 于是订单停在 review，用户看到「等待人工核实」—— 但对方压根没建单。
  // 扫��必须把这种没有第三方凭证的 review 收敛成 failed，不占用人工队列。
  const f = await setup(t)
  const order = await f.create()
  // 抹掉所有第三方侧凭证，模拟「对方侧根本没生成这笔单」。
  await f.router.__db.run(
    `UPDATE vip_orders SET status = 'review', review_reason = 'payment_response_uncertain',
      payment_id = NULL, checkout_url = NULL, qr_string = NULL WHERE id = ?`,
    order.id,
  )
  assert.equal((await f.getOrder(order.id)).status, 'review')

  await f.sweep()
  const fixed = await f.getOrder(order.id)
  assert.equal(fixed.status, 'failed')
  // reason 是内部运维字段，不对外暴露，直接查库确认。
  const rows = await f.router.__db.query.all('SELECT review_reason FROM vip_orders WHERE id = ?', order.id)
  assert.equal(rows[0]?.review_reason, 'provider_rejected_request')
  assert.equal((await f.user()).vipActive, false)
})

test('a review order that carries real third-party evidence is left alone', async (t) => {
  // 有 payment_id / 收银台链接说明对方侧真的建过单 —— 可能已经收到钱，
  // 这种情况必须保留给人工核对，不能自动改成 failed。
  const f = await setup(t)
  const order = await f.create()
  await f.router.__db.run(
    `UPDATE vip_orders SET status = 'review', review_reason = 'payment_response_uncertain' WHERE id = ?`,
    order.id,
  )
  // 这笔订单身上还有 payment_id（建单时写入的），所以不满足收敛条件。
  await f.sweep()
  assert.equal((await f.getOrder(order.id)).status, 'review')
})
