import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { createVipRouter } from '../server/vip.js'

const ORIGIN = 'https://vip.example.test'
const VAEHUB = {
  VAEHUB_API_BASE: 'https://pay.example.test/api/',
  VAEHUB_APP_TAG: 'project',
  VAEHUB_APP_KEY: 'test-app-key',
  VAEHUB_APP_SECRET: 'test-app-secret-0123456789',
  VAEHUB_CURRENCY: 'USD',
  VAEHUB_COUNTRY: 'USA',
  VAEHUB_USDT_RATES_JSON: '{"USD":1.08}',
}

function signToken({ timestamp, nonce, appKey = VAEHUB.VAEHUB_APP_KEY, appSecret = VAEHUB.VAEHUB_APP_SECRET }) {
  const signature = createHash('sha256').update(`${appKey}${timestamp}${nonce}${appSecret}`).digest('hex')
  return `Bearer ${Buffer.from(`project:${timestamp}:${appKey}:${nonce}:${signature}`, 'utf8').toString('base64')}`
}

async function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duanju-vaehub-test-'))
  const dbSuffix = randomUUID().replace(/-/g, '').slice(0, 12)
  let timestamp = Date.parse('2026-09-18T08:00:00.000Z')
  const calls = []
  const env = {
    NODE_ENV: 'test', APP_URL: ORIGIN,
    NOWPAYMENTS_API_KEY: '', NOWPAYMENTS_IPN_SECRET: '',
    MYSQL_HOST: process.env.MYSQL_HOST || '127.0.0.1',
    MYSQL_PORT: process.env.MYSQL_PORT || '3306',
    MYSQL_USER: process.env.MYSQL_USER || 'root',
    MYSQL_PASSWORD: process.env.MYSQL_PASSWORD ?? '123456',
    MYSQL_DATABASE: `duanju_test_vaehub_${dbSuffix}`,
    ...VAEHUB,
    ...overrides.env,
  }
  const fetchImpl = overrides.fetchImpl ?? (async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization })
    const body = JSON.parse(options.body)
    assert.equal(url, 'https://pay.example.test/api/v1/trade/payin')
    assert.ok(options.headers.Authorization.startsWith('Bearer '))
    return new Response(JSON.stringify({
      code: 200,
      data: {
        open_id: `vaehub-${body.order_id}`, amount: body.amount, currency: body.currency,
        status: 3, status_text: 'Pending', cashier_link: `https://pay.example.test/cashier/${body.order_id}`,
      },
      msg: 'Success', rid: 'v-test',
    }), { status: 201 })
  })
  let router = await createVipRouter({ env, fetchImpl, now: () => timestamp })
  const app = express()
  app.use('/api', router)
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await router.close?.()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}/api`
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
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* VaeHub notify replies with plain text */ }
    return { status: response.status, body: json, text, headers: response.headers }
  }
  async function raw(route, { body, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return { status: response.status, text: await response.text(), type: response.headers.get('content-type') }
  }
  async function register(email = `${randomUUID()}@example.test`) {
    const res = await request('/auth/register', { method: 'POST', body: { email, password: 'Correct-Horse-972!' } })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    return res.headers.get('set-cookie')?.split(';')[0]
  }
  return { request, raw, register, calls, setTime: (value) => { timestamp = value } }
}

function notify(order, { status = 1, nonce = randomUUID().replace(/-/g, '').slice(0, 16), timestamp, key, secret } = {}) {
  const ts = timestamp ?? String(Math.floor(Date.parse('2026-09-18T08:00:00.000Z') / 1000))
  return {
    headers: { Authorization: signToken({ timestamp: ts, nonce, appKey: key, appSecret: secret }) },
    body: {
      type: 'payin_notify', gateway: 'thirdpay_center', env: 'prod', app_key: VAEHUB.VAEHUB_APP_KEY,
      data: {
        open_id: `vaehub-${order.id}`, out_trade_no: order.id, status,
        amount: order.payAmount, amount_paid: order.payAmount, currency: 'USD', message: 'Payin success',
      },
    },
  }
}

test('vaehub catalog lists the channel and orders carry the cashier link', async (t) => {
  const f = await fixture(t)
  const plans = await f.request('/vip/plans')
  assert.deepEqual(plans.body.payment.providers, [{ id: 'vaehub', name: 'VaeHub' }])
  assert.equal(plans.body.payment.enabled, true)
  const cookie = await f.register()
  const key = randomUUID()
  const created = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': key }, body: { planId: 'month' } })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const order = created.body.order
  assert.equal(order.provider, 'vaehub')
  assert.ok(order.checkoutUrl.startsWith('https://pay.example.test/cashier/'))
  assert.equal(order.payAmount, 10.8)
  assert.equal(order.payCurrency, 'USD')
  assert.equal(order.amount, 10)
  assert.equal(f.calls[0].body.order_id, order.id)
  assert.equal(f.calls[0].body.country, 'USA')
  assert.equal(f.calls[0].body.currency, 'USD')
  assert.equal(f.calls[0].body.amount, 10.8)
  assert.equal(f.calls[0].body.return_type, 'cashier')
  assert.equal(f.calls[0].body.callback_url, `${ORIGIN}/api/payments/vaehub/notify`)
  const again = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': key }, body: { planId: 'month' } })
  assert.equal(again.body.order.id, order.id)
  assert.equal(f.calls.length, 1)
})

test('vaehub success notification grants membership exactly once and replies SUCCESS', async (t) => {
  const f = await fixture(t)
  const cookie = await f.register()
  const created = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month', provider: 'vaehub' } })
  const order = created.body.order
  const first = notify(order)
  const ok = await f.raw('/payments/vaehub/notify', first)
  assert.equal(ok.status, 200)
  assert.equal(ok.text, 'SUCCESS')
  assert.equal(ok.type, 'text/plain; charset=utf-8')
  assert.equal((await f.request('/auth/me', { cookie })).body.user.vipActive, true)
  assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie })).body.order.status, 'paid')
  const replay = await f.raw('/payments/vaehub/notify', first)
  assert.equal(replay.text, 'SUCCESS')
  const other = notify(order, { status: 3 })
  assert.equal((await f.raw('/payments/vaehub/notify', other)).text, 'SUCCESS')
  assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie })).body.order.status, 'paid')
})

test('vaehub rejects bad signatures, mismatched amounts and reused payments', async (t) => {
  const f = await fixture(t)
  const cookie = await f.register()
  const created = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month', provider: 'vaehub' } })
  const order = created.body.order
  const badSig = notify(order)
  badSig.headers.Authorization = signToken({ timestamp: String(Math.floor(Date.parse('2026-09-18T08:00:00.000Z') / 1000)), nonce: 'badnonce00000001', appKey: VAEHUB.VAEHUB_APP_KEY, appSecret: 'wrong-secret' })
  assert.equal((await f.raw('/payments/vaehub/notify', badSig)).status, 401)
  const underpaid = notify(order)
  underpaid.body.data.amount = 1
  underpaid.body.data.amount_paid = 1
  assert.equal((await f.raw('/payments/vaehub/notify', underpaid)).status, 422)
  assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie })).body.order.status, 'review')
  const second = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month', provider: 'vaehub' } })
  const reused = notify(second.body.order)
  reused.body.data.open_id = `vaehub-${order.id}`
  assert.equal((await f.raw('/payments/vaehub/notify', reused)).status, 422)
  assert.equal((await f.request('/auth/me', { cookie })).body.user.vipActive, false)
})

test('both channels coexist and provider choice is validated', async (t) => {
  const f = await fixture(t, { env: { NOWPAYMENTS_API_KEY: 'now-key', NOWPAYMENTS_IPN_SECRET: 'now-secret' } })
  const plans = await f.request('/vip/plans')
  assert.deepEqual(plans.body.payment.providers.map((item) => item.id), ['nowpayments', 'vaehub'])
  const cookie = await f.register()
  const missing = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month' } })
  assert.equal(missing.status, 400)
  const unknown = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month', provider: 'stripe' } })
  assert.equal(unknown.status, 400)
  const key = randomUUID()
  const first = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': key }, body: { planId: 'month', provider: 'vaehub' } })
  assert.equal(first.status, 201)
  const conflict = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': key }, body: { planId: 'month', provider: 'nowpayments' } })
  assert.equal(conflict.status, 409)
})
