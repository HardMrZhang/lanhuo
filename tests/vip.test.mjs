import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { createVipRouter } from '../server/vip.js'

const SECRET = 'test-ipn-secret-not-for-production'
const ORIGIN = 'https://vip.example.test'
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]))
  }
  return value
}
function sign(payload) {
  return createHmac('sha512', SECRET).update(JSON.stringify(sorted(payload))).digest('hex')
}

async function fixture(t, overrides = {}) {
  let timestamp = Date.parse('2026-09-18T08:00:00.000Z')
  const providerPayments = []
  const dbSuffix = randomUUID().replace(/-/g, '').slice(0, 12)
  const env = {
    NODE_ENV: 'test', APP_URL: ORIGIN,
    NOWPAYMENTS_API_KEY: 'test-key', NOWPAYMENTS_IPN_SECRET: SECRET,
    MYSQL_HOST: process.env.MYSQL_HOST || '127.0.0.1',
    MYSQL_PORT: process.env.MYSQL_PORT || '3306',
    MYSQL_USER: process.env.MYSQL_USER || 'root',
    MYSQL_PASSWORD: process.env.MYSQL_PASSWORD ?? '123456',
    MYSQL_DATABASE: `duanju_test_vip_${dbSuffix}`,
    ...overrides.env,
  }
  const fetchImpl = overrides.fetchImpl ?? (async (url, options) => {
    assert.equal(url, 'https://api.nowpayments.io/v1/payment')
    const body = JSON.parse(options.body)
    const id = String(7000 + providerPayments.length)
    providerPayments.push({ ...body, id })
    return new Response(JSON.stringify({ payment_id: id, payment_status: 'waiting', pay_address: 'T' + '1'.repeat(33), pay_amount: body.pay_amount, pay_currency: body.pay_currency, price_amount: body.price_amount, price_currency: body.price_currency, order_id: body.order_id, expiration_estimate_date: new Date(timestamp + 7 * 86400000).toISOString() }), { status: 201 })
  })
  let router = await createVipRouter({ env, fetchImpl, now: () => timestamp })
  async function listen() {
    const app = express()
    app.use('/api', router)
    return new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
    })
  }
  let server = await listen()
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await router.close?.()
  })
  let base = `http://127.0.0.1:${server.address().port}/api`
  async function restart() {
    await new Promise((resolve) => server.close(resolve))
    await router.close()
    router = await createVipRouter({ env, fetchImpl, now: () => timestamp })
    server = await listen()
    base = `http://127.0.0.1:${server.address().port}/api`
  }
  async function request(route, { method = 'GET', cookie, body, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method,
      headers: {
        Origin: ORIGIN,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await response.json()
    return { status: response.status, body: json, headers: response.headers }
  }
  async function register(email = `${randomUUID()}@example.test`) {
    const res = await request('/auth/register', { method: 'POST', body: { email, password: 'Correct-Horse-972!' } })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const cookie = res.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    return { cookie, user: res.body.user, email }
  }
  async function createOrder(cookie, planId = 'month', key = randomUUID(), extras = {}) {
    return request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': key }, body: { planId, ...extras } })
  }
  function payment(order, changes = {}) {
    const providerPayment = providerPayments.find((item) => item.order_id === order.id)
    assert.ok(providerPayment)
    return {
      payment_id: providerPayment.id, order_id: order.id,
      payment_status: 'finished', price_amount: order.amount, price_currency: 'usd',
      pay_amount: order.amount, actually_paid: order.amount, pay_currency: 'usdttrc20',
      ...changes,
    }
  }
  async function ipn(payload, signature = sign(payload)) {
    return request('/payments/nowpayments/ipn', { method: 'POST', body: payload, headers: { 'x-nowpayments-sig': signature } })
  }
  return { restart, request, register, createOrder, payment, ipn, providerPayments, setTime: (value) => { timestamp = value } }
}

test('accounts use server sessions, reject bad passwords and invalidate logout', async (t) => {
  const f = await fixture(t)
  const { cookie, user, email } = await f.register()
  assert.equal(user.vipActive, false)
  assert.equal(user.vipExpiresAt, null)
  assert.equal((await f.request('/auth/me', { cookie })).body.user.id, user.id)
  assert.equal((await f.request('/auth/me')).body.user, null)
  const bad = await f.request('/auth/login', { method: 'POST', body: { email, password: 'incorrect-password' } })
  assert.equal(bad.status, 401)
  const login = await f.request('/auth/login', { method: 'POST', body: { email, password: 'Correct-Horse-972!' } })
  assert.equal(login.status, 200)
  assert.match(login.headers.get('set-cookie'), /HttpOnly/i)
  assert.match(login.headers.get('set-cookie'), /SameSite=Lax/i)
  await f.request('/auth/logout', { method: 'POST', cookie, body: {} })
  assert.equal((await f.request('/auth/me', { cookie })).body.user, null)
})

test('cross-site mutations and unauthenticated orders are rejected', async (t) => {
  const f = await fixture(t)
  const evil = await f.request('/auth/register', {
    method: 'POST', body: { email: 'evil@example.test', password: 'Correct-Horse-972!' }, headers: { Origin: 'https://evil.example' },
  })
  assert.equal(evil.status, 403)
  assert.equal((await f.createOrder(undefined)).status, 401)
  assert.equal(f.providerPayments.length, 0)
})

test('missing payment credentials disables checkout without creating provider payments', async (t) => {
  const f = await fixture(t, { env: { NOWPAYMENTS_API_KEY: '', NOWPAYMENTS_IPN_SECRET: '' } })
  const { cookie } = await f.register()
  const plans = await f.request('/vip/plans')
  assert.equal(plans.body.payment.enabled, false)
  assert.deepEqual(plans.body.plans.map(({ price, days, currency }) => ({ price, days, currency })), [{ price: 10, days: 30, currency: 'USDT' }, { price: 20, days: 180, currency: 'USDT' }, { price: 20, days: 365, currency: 'USDT' }])
  assert.equal((await f.createOrder(cookie)).status, 503)
  assert.equal(f.providerPayments.length, 0)
})

test('orders use server prices, deduplicate creation, and stay private to their owner', async (t) => {
  const f = await fixture(t)
  const owner = await f.register()
  const other = await f.register()
  const key = randomUUID()
  const result = await f.createOrder(owner.cookie, 'month', key, { amount: 0.01, days: 99999, userId: other.user.id })
  assert.ok([200, 201].includes(result.status), JSON.stringify(result.body))
  const order = result.body.order
  assert.equal(order.amount, 10)
  assert.equal(order.currency, 'USDT')
  assert.equal(order.payAmount, 10)
  assert.equal(order.payCurrency, 'usdttrc20')
  assert.equal(f.providerPayments[0].pay_amount, 10)
  assert.equal(f.providerPayments[0].pay_currency, 'usdttrc20')
  assert.equal(order.days, 30)
  assert.equal(f.providerPayments[0].price_amount, 10)
  assert.equal(f.providerPayments[0].ipn_callback_url, `${ORIGIN}/api/payments/nowpayments/ipn`)
  assert.equal((await f.createOrder(owner.cookie, 'month', key)).body.order.id, order.id)
  assert.equal(f.providerPayments.length, 1)
  assert.equal((await f.createOrder(owner.cookie, 'year', key)).status, 409)
  assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie: other.cookie })).status, 404)
  assert.deepEqual((await f.request('/vip/orders', { cookie: other.cookie })).body.orders, [])
  assert.equal((await f.request('/auth/me', { cookie: owner.cookie })).body.user.vipActive, false)
})

test('only correctly signed, fully paid matching notifications grant VIP, exactly once', async (t) => {
  const f = await fixture(t)
  const owner = await f.register()
  const { body: { order } } = await f.createOrder(owner.cookie)
  const payload = f.payment(order)
  assert.ok((await f.ipn(payload, '0'.repeat(128))).status >= 400)
  assert.equal((await f.request('/auth/me', { cookie: owner.cookie })).body.user.vipActive, false)
  await f.ipn(f.payment(order, { payment_status: 'confirming' }))
  assert.equal((await f.request('/auth/me', { cookie: owner.cookie })).body.user.vipActive, false)
  assert.equal((await f.ipn(payload)).status, 200)
  const granted = (await f.request('/auth/me', { cookie: owner.cookie })).body.user
  assert.equal(granted.vipActive, true)
  assert.equal(granted.vipExpiresAt, '2026-10-18T08:00:00.000Z')
  await Promise.all(Array.from({ length: 5 }, () => f.ipn(payload)))
  await f.ipn(f.payment(order, { payment_status: 'waiting' }))
  assert.equal((await f.request('/auth/me', { cookie: owner.cookie })).body.user.vipExpiresAt, granted.vipExpiresAt)
  assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie: owner.cookie })).body.order.status, 'paid')
})

test('wrong amount, payment, currency, partial payments and reused payment IDs cannot grant membership', async (t) => {
  const variants = [
    { price_amount: 0.01 }, { payment_id: 'wrong-payment' }, { price_currency: 'eur' },
    { actually_paid: 1 }, { pay_currency: 'btc' }, { pay_amount: 1, actually_paid: 1 }, { parent_payment_id: 'parent-payment' }, { payment_status: 'partially_paid', actually_paid: 1 },
  ]
  for (const [i, variant] of variants.entries()) {
    await t.test(`invalid payment ${i + 1}`, async (sub) => {
      const f = await fixture(sub)
      const owner = await f.register()
      const { body: { order } } = await f.createOrder(owner.cookie)
      await f.ipn(f.payment(order, variant))
      assert.equal((await f.request('/auth/me', { cookie: owner.cookie })).body.user.vipActive, false)
    })
  }
  await t.test('a payment cannot pay for two orders', async (sub) => {
    const f = await fixture(sub)
    const owner = await f.register()
    const first = (await f.createOrder(owner.cookie)).body.order
    const second = (await f.createOrder(owner.cookie)).body.order
    await f.ipn(f.payment(first))
    const expiry = (await f.request('/auth/me', { cookie: owner.cookie })).body.user.vipExpiresAt
    await f.ipn(f.payment(second, { payment_id: f.payment(first).payment_id }))
    assert.equal((await f.request('/auth/me', { cookie: owner.cookie })).body.user.vipExpiresAt, expiry)
  })
})

test('renewals extend existing expiry and expired members start from payment time', async (t) => {
  const f = await fixture(t)
  const owner = await f.register()
  const first = (await f.createOrder(owner.cookie)).body.order
  await f.ipn(f.payment(first))
  const second = (await f.createOrder(owner.cookie, 'halfyear')).body.order
  await f.ipn(f.payment(second))
  assert.equal((await f.request('/auth/me', { cookie: owner.cookie })).body.user.vipExpiresAt, '2027-04-16T08:00:00.000Z')
  f.setTime(Date.parse('2027-05-01T08:00:00.000Z'))
  // Old sessions have expired too; log in again before the next purchase.
  const login = await f.request('/auth/login', { method: 'POST', body: { email: owner.email, password: 'Correct-Horse-972!' } })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal(login.body.user.vipActive, false)
  const third = (await f.createOrder(cookie)).body.order
  await f.ipn(f.payment(third))
  assert.equal((await f.request('/auth/me', { cookie })).body.user.vipExpiresAt, '2027-05-31T08:00:00.000Z')
})

test('uncertain provider failures cannot create a second payment on an idempotent retry', async (t) => {
  let calls = 0
  const f = await fixture(t, { fetchImpl: async () => { calls++; throw new Error('network interrupted after sending request') } })
  const owner = await f.register()
  const key = randomUUID()
  await f.createOrder(owner.cookie, 'month', key)
  await f.createOrder(owner.cookie, 'month', key)
  assert.equal(calls, 1)
  assert.equal((await f.request('/auth/me', { cookie: owner.cookie })).body.user.vipActive, false)
})


test('accounts, payment orders and exactly-once grants survive a server restart', async (t) => {
  const f = await fixture(t)
  const owner = await f.register()
  const { body: { order } } = await f.createOrder(owner.cookie, 'year')
  await f.ipn(f.payment(order))
  const before = (await f.request('/auth/me', { cookie: owner.cookie })).body.user
  await f.restart()
  assert.deepEqual((await f.request('/auth/me', { cookie: owner.cookie })).body.user, before)
  assert.equal((await f.request('/vip/orders', { cookie: owner.cookie })).body.orders[0].status, 'paid')
  await f.ipn(f.payment(order))
  assert.deepEqual((await f.request('/auth/me', { cookie: owner.cookie })).body.user, before)
})
