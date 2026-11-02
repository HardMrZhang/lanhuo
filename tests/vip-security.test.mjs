import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { request as httpRequest } from 'node:http'
import express from 'express'
import { createVipRouter } from '../server/vip.js'

const ORIGIN = 'https://vip-security.example.test'
const SECRET = 'isolated-security-test-secret'
const TIMESTAMP = Date.parse('2026-09-18T08:00:00.000Z')

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

async function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duanju-vip-security-'))
  const payments = new Map()
  let responseOverride = {}
  let base, router, server
  const dbSuffix = randomUUID().replace(/-/g, '').slice(0, 12)
  const env = {
    NODE_ENV: 'test', APP_URL: ORIGIN,
    NOWPAYMENTS_API_KEY: 'security-test-api-key', NOWPAYMENTS_IPN_SECRET: SECRET,
    MYSQL_HOST: process.env.MYSQL_HOST || '127.0.0.1',
    MYSQL_PORT: process.env.MYSQL_PORT || '3306',
    MYSQL_USER: process.env.MYSQL_USER || 'root',
    MYSQL_PASSWORD: process.env.MYSQL_PASSWORD ?? '123456',
    MYSQL_DATABASE: `duanju_test_sec_${dbSuffix}`,
    ...options.env,
  }
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://api.nowpayments.io/v1/payment')
    const request = JSON.parse(options.body)
    const response = {
      ...request, payment_id: String(8100 + payments.size), payment_status: 'waiting',
      pay_address: 'T' + '1'.repeat(33), expiration_estimate_date: '2026-09-25T08:00:00.000Z',
      ...responseOverride,
    }
    payments.set(request.order_id, response)
    return new Response(JSON.stringify(response), { status: 201 })
  }
  async function close() {
    if (!server) return
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await router.close?.()
    server = null
  }
  async function restart(changes = {}) {
    await close()
    Object.assign(env, changes)
    router = await createVipRouter({ env, fetchImpl, now: () => TIMESTAMP })
    const app = express()
    app.use('/api', router)
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
    })
    base = `http://127.0.0.1:${server.address().port}/api`
  }
  t.after(async () => { await close(); fs.rmSync(directory, { recursive: true, force: true }) })
  await restart()
  async function request(route, { cookie, body, headers = {} } = {}) {
    // Node fetch overwrites Host; raw HTTP lets this fixture model a TLS proxy.
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers, ...headers,
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
  const account = await request('/auth/register', { body: { email: `${randomUUID()}@example.test`, password: 'Security-Test-Password-983' } })
  assert.equal(account.status, 201)
  const cookie = account.headers.get('set-cookie').split(';')[0]
  const create = (planId = 'month', key = randomUUID()) => request('/vip/orders', { cookie, body: { planId }, headers: { 'Idempotency-Key': key } })
  const user = async () => (await request('/auth/me', { cookie })).body.user
  const getOrder = async (id) => (await request(`/vip/orders/${id}`, { cookie })).body.order
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
  return { request, account, create, user, getOrder, event, callback, restart, override: (value) => { responseOverride = value } }
}

test('production auth works without payment configuration and still rejects cross-site requests', async (t) => {
  const f = await setup(t, {
    env: { NODE_ENV: 'production', APP_URL: undefined, NOWPAYMENTS_API_KEY: undefined, NOWPAYMENTS_IPN_SECRET: undefined },
    headers: { Origin: 'https://site.example', Host: 'site.example' },
  })
  assert.equal(f.account.status, 201)
  assert.match(f.account.headers.get('set-cookie'), /; Secure(?:;|$)/)
  assert.match(f.account.headers.get('set-cookie'), /; HttpOnly(?:;|$)/)
  assert.equal((await f.request('/vip/plans')).body.payment.enabled, false)
  const body = { email: 'cross-site@example.test', password: 'Security-Test-Password-983' }
  assert.equal((await f.request('/auth/register', { body, headers: { Origin: 'https://evil.example' } })).status, 403)
  assert.equal((await f.request('/auth/register', { body, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
})

test('a refunded order cannot be fulfilled by a delayed finished notification, even after restart', async (t) => {
  const f = await setup(t)
  const { body: { order } } = await f.create()
  assert.equal((await f.callback(f.event(order, { payment_status: 'refunded' }))).status, 200)
  assert.equal((await f.getOrder(order.id)).status, 'refunded')
  await f.restart()
  await f.callback(f.event(order))
  await f.callback(f.event(order, { payment_status: 'confirmed' }))
  assert.equal((await f.user()).vipActive, false)
  assert.equal((await f.user()).vipExpiresAt, null)
  assert.equal((await f.getOrder(order.id)).status, 'refunded')
})

test('settlement uses the purchased plan snapshot and replay stays idempotent across restarts', async (t) => {
  const f = await setup(t)
  const key = randomUUID()
  const { body: { order } } = await f.create('month', key)
  assert.equal(order.amount, 10)
  assert.equal(order.days, 30)
  await f.restart({ VIP_PLANS_JSON: JSON.stringify([{ id: 'month', name: 'Changed plan', days: 1, price: 99, currency: 'USDT' }]) })
  assert.equal((await f.callback(f.event(order))).status, 200)
  const expiry = '2026-10-18T08:00:00.000Z'
  assert.equal((await f.user()).vipExpiresAt, expiry)
  await f.restart({ VIP_PLANS_JSON: JSON.stringify([{ id: 'year', name: 'Annual only', days: 365, price: 50, currency: 'USDT' }]) })
  const replay = await f.create('month', key)
  assert.equal(replay.status, 200)
  assert.equal(replay.body.order.id, order.id)
  assert.equal(replay.body.order.days, 30)
  await f.callback(f.event(order))
  assert.equal((await f.user()).vipExpiresAt, expiry)
  assert.equal((await f.getOrder(order.id)).amount, 10)
})

test('unexpected provider quotes cannot expose a deposit address or activate VIP', async (t) => {
  const f = await setup(t)
  const variants = [
    { pay_amount: 9.99 }, { pay_currency: 'usdterc20' }, { price_amount: 9 },
    { price_currency: 'eur' }, { order_id: 'different-store-order' }, { order_id: undefined },
    { pay_address: '0x0000000000000000000000000000000000000001' },
    { expiration_estimate_date: '2026-09-01T08:00:00.000Z' },
    { payin_extra_id: 'required-but-not-shown' },
  ]
  for (const variant of variants) {
    f.override(variant)
    const result = await f.create()
    assert.equal(result.status, 502, JSON.stringify(variant))
    assert.equal(result.body.order.payAddress, null)
    assert.equal(result.body.order.status, 'review')
    assert.equal((await f.getOrder(result.body.order.id)).payAddress, null)
  }
  assert.equal((await f.user()).vipActive, false)
})

test('decimal underpayment and invalid amounts never round up to a full payment', async (t) => {
  const f = await setup(t)
  const { body: { order } } = await f.create()
  for (const actually_paid of ['9.999999999999999999999999', '-1', 'NaN', '1e999', '0xA', null]) {
    await f.callback(f.event(order, { actually_paid }))
    assert.equal((await f.user()).vipActive, false, `accepted ${actually_paid}`)
  }
  assert.equal((await f.callback(f.event(order, { actually_paid: '1.000000000000000000e1' }))).status, 200)
  assert.equal((await f.user()).vipExpiresAt, '2026-10-18T08:00:00.000Z')
})
