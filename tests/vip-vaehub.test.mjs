import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { createVipRouter } from '../server/vip.js'

const ORIGIN = 'https://vip.example.test'
// 测试用固定验证码：答案恒为 TESTCAPTCHA。
const TEST_CAPTCHA = { enabled: true, issue: () => ({ text: 'TESTCAPTCHA', svg: '<svg/>' }) }
const CAPTCHA_BODY = { captchaId: 'test-captcha', captchaText: 'TESTCAPTCHA' }
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
  let router = await createVipRouter({ env, fetchImpl, now: () => timestamp, captcha: TEST_CAPTCHA })
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
  async function captchaBody() {
    const res = await request('/auth/captcha')
    assert.equal(res.status, 200, JSON.stringify(res.body))
    return { captchaId: res.body.id, captchaText: 'TESTCAPTCHA' }
  }
  async function register(email = `${randomUUID()}@example.test`) {
    const res = await request('/auth/register', { method: 'POST', body: { email, password: 'Correct-Horse-972!', ...(await captchaBody()) } })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    return res.headers.get('set-cookie')?.split(';')[0]
  }
  return {
    request, raw, register, calls, captchaBody, router,
    // 绑定测试时钟的回调构造器：签名里的时间戳必须跟服务端当前时间一致，
    // 否则会因超出 10 分钟窗口被判为 INVALID_SIGNATURE。
    notify: (order, options = {}) => notify(order, { timestamp: String(Math.floor(timestamp / 1000)), ...options }),
    time: () => timestamp,
    setTime: (value) => { timestamp = value },
  }
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

test('the sandbox base url takes over when the sandbox is enabled', async (t) => {
  // 官方文档写明 Sandbox Base url 需向商务索取、未公开域名，
  // 所以沙箱地址只能来自配置；配了沙箱地址就必须真的用它建单。
  const calls = []
  const f = await fixture(t, {
    env: {
      VAEHUB_SANDBOX: 'true',
      VAEHUB_SANDBOX_API_BASE: 'https://sandbox.pay.example.test/api',
      VAEHUB_MOCK_RES: 'success',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      const body = JSON.parse(options.body)
      return new Response(JSON.stringify({
        code: 200,
        data: {
          open_id: `vaehub-${body.order_id}`, amount: body.amount, currency: body.currency,
          status: 3, status_text: 'Pending', cashier_link: `https://sandbox.pay.example.test/cashier/${body.order_id}`,
        },
        msg: 'Success', rid: 'v-test',
      }), { status: 201 })
    },
  })
  const cookie = await f.register()
  const created = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month' } })
  assert.equal(created.status, 201, JSON.stringify(created.body))

  assert.equal(calls.length, 1)
  // 请求必须打到沙箱地址，不能还打生产地址。
  assert.equal(calls[0].url, 'https://sandbox.pay.example.test/api/v1/trade/payin')
  // mock_res 让通道直接返回指定状态，用于不真实收款地跑通全链路。
  assert.equal(calls[0].body.mock_res, 'success')
})

test('production never sends mock_res even when the setting is present', async (t) => {
  // mock_res 只在测试环境有意义。生产带上它可能让对方按 mock 逻辑处理，
  // 造成「假成功」，所以生产环境必须不传。
  const f = await fixture(t, { env: { VAEHUB_MOCK_RES: 'success' } })
  const cookie = await f.register()
  const created = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month' } })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'https://pay.example.test/api/v1/trade/payin')
  assert.equal(f.calls[0].body.mock_res, undefined)
})

test('the sandbox can carry its own app key and secret', async (t) => {
  // 实测：同一个 App Key 在测试与生产环境都存在，但 App Secret 不同 ——
  // 表现为 "Signature verification failed." 而不是 "AppKey not found"。
  // 所以沙箱必须能用独立的凭据，否则永远签名不过。
  const calls = []
  const f = await fixture(t, {
    env: {
      VAEHUB_SANDBOX: 'true',
      VAEHUB_SANDBOX_API_BASE: 'https://sandbox.pay.example.test/api',
      VAEHUB_SANDBOX_APP_KEY: 'sandbox-key',
      VAEHUB_SANDBOX_APP_SECRET: 'sandbox-secret-0123456789abcdef',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization })
      const body = JSON.parse(options.body)
      return new Response(JSON.stringify({
        code: 200,
        data: {
          open_id: `vaehub-${body.order_id}`, amount: body.amount, currency: body.currency,
          status: 3, status_text: 'Pending', cashier_link: `https://sandbox.pay.example.test/cashier/${body.order_id}`,
        },
        msg: 'Success', rid: 'v-test',
      }), { status: 201 })
    },
  })
  const cookie = await f.register()
  const created = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month' } })
  assert.equal(created.status, 201, JSON.stringify(created.body))

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://sandbox.pay.example.test/api/v1/trade/payin')
  // Authorization 里必须带沙箱的 App Key，而不是生产的。
  const raw = Buffer.from(calls[0].auth.replace('Bearer ', ''), 'base64').toString('utf8')
  const parts = raw.split(':')
  assert.equal(parts[0], 'project')
  assert.equal(parts[2], 'sandbox-key')
  // 签名必须用沙箱的 secret 算，否则对端验签必然失败。
  const expected = createHash('sha256')
    .update(`sandbox-key${parts[1]}${parts[3]}sandbox-secret-0123456789abcdef`)
    .digest('hex')
  assert.equal(parts[4], expected)
})

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
  // 文档标注 user_hash 为必填：必须存在且不泄露用户标识明文。
  assert.match(f.calls[0].body.user_hash, /^[a-f0-9]{32}$/)
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

test('the channel stays hidden when the country code or the fiat rate is missing', async (t) => {
  // 非 ISO3 三字母国家码（如误填支付方式 CASHAPP）不得启用通道。
  const noCountry = await fixture(t, { env: { VAEHUB_COUNTRY: 'CASHAPP' } })
  const withoutCountry = await noCountry.request('/vip/plans')
  assert.deepEqual(withoutCountry.body.payment.providers, [])
  assert.equal(withoutCountry.body.payment.enabled, false)

  // 缺少法币汇率同样不得启用通道。
  const noRate = await fixture(t, { env: { VAEHUB_USDT_RATES_JSON: '' } })
  const withoutRate = await noRate.request('/vip/plans')
  assert.deepEqual(withoutRate.body.payment.providers, [])
  assert.equal(withoutRate.body.payment.enabled, false)
})

test('a business rejection fails the order instead of queueing it for manual review', async (t) => {
  // VaeHub 用 HTTP 200 + body.code 表达业务结果（实测：{"code":401,"msg":"IP not allowed"}）。
  // 这类拒绝是确定性的：订单根本没在对方侧生成，不存在「钱付了但状态不明」。
  // 落 review 会让用户对着「等待人工核实」干等，而人工也核实不出结果。
  const f = await fixture(t, {
    fetchImpl: async () => new Response(JSON.stringify({ code: 401, msg: 'IP not allowed', rid: 'v-test' }), { status: 200 }),
  })
  const cookie = await f.register()
  const created = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month', provider: 'vaehub' } })
  assert.equal(created.status, 502)
  assert.equal(created.body.order.status, 'failed')
  assert.equal((await f.request(`/vip/orders/${created.body.order.id}`, { cookie })).body.order.status, 'failed')
  assert.equal((await f.request('/auth/me', { cookie })).body.user.vipActive, false)
})

test('a terminal order is never dragged back into manual review by a late callback', async (t) => {
  const f = await fixture(t)
  const cookie = await f.register()
  const created = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month', provider: 'vaehub' } })
  const order = created.body.order
  assert.equal(order.status, 'pending')

  // 渠道明确取消（5=Canceled）：确定性失败，应落 failed。
  const canceled = notify(order, { status: 5 })
  assert.equal((await f.raw('/payments/vaehub/notify', canceled)).text, 'SUCCESS')
  assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie })).body.order.status, 'expired')

  // 迟到的回调不得把已作废的订单拖回「等待人工核实」。
  const late = notify(order, { status: 99 })
  assert.equal((await f.raw('/payments/vaehub/notify', late)).text, 'SUCCESS')
  assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie })).body.order.status, 'expired')
})

test('vaehub payment states map onto the order status machine', async (t) => {
  const f = await fixture(t)
  const cookie = await f.register()

  // 3=Pending（渠道处理中）与 4=Locked（风控锁单）都表示还在进行，应是「支付确认中」。
  for (const status of [3, 4]) {
    const created = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month', provider: 'vaehub' } })
    const order = created.body.order
    const pending = notify(order, { status })
    assert.equal((await f.raw('/payments/vaehub/notify', pending)).text, 'SUCCESS')
    assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie })).body.order.status, 'confirming')
  }

  // 2=Failed：确定性失败，不进人工队列。
  const failedOrder = (await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month', provider: 'vaehub' } })).body.order
  assert.equal((await f.raw('/payments/vaehub/notify', notify(failedOrder, { status: 2 }))).text, 'SUCCESS')
  assert.equal((await f.request(`/vip/orders/${failedOrder.id}`, { cookie })).body.order.status, 'failed')
})

test('an overdue order is voided instead of drifting into manual review', async (t) => {
  // 用户报的 bug：订单已经超时，刷新一下却变成「等待人工核实」。
  // 根因是订单到期后没人把它置为 expired，一直停在 pending，
  // 迟到的回调就能把它改写成 review。
  const f = await fixture(t)
  const cookie = await f.register()
  const created = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month', provider: 'vaehub' } })
  const order = created.body.order
  assert.equal(order.status, 'pending')

  // 渠道返回的收款单到期时间（qrcode_ttl / qrcode_expired）之后，订单必须作废。
  const expiredAt = new Date(Date.parse('2026-09-18T08:00:00.000Z') + 15 * 60_000).toISOString()
  await f.router.__db.run('UPDATE vip_orders SET payment_expires_at = ? WHERE id = ?', expiredAt, order.id)
  f.setTime(Date.parse(expiredAt) + 1_000)

  await f.router.__expirySweep()
  assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie })).body.order.status, 'expired')

  // 作废之后到达的回调（无论什么状态）都不能把订单改写成「等待人工核实」。
  for (const status of [3, 4, 99]) {
    const late = f.notify(order, { status })
    assert.equal((await f.raw('/payments/vaehub/notify', late)).text, 'SUCCESS')
    assert.equal(
      (await f.request(`/vip/orders/${order.id}`, { cookie })).body.order.status,
      'expired',
      `迟到的 status=${status} 回调不得改变已作废订单的状态`,
    )
  }
  assert.equal((await f.request('/auth/me', { cookie })).body.user.vipActive, false)
})

test('a late success callback still grants membership for a voided order', async (t) => {
  // 作废不等于丢钱：用户在截止前一刻付了钱、只是回调来得晚，
  // 会员必须开通。把这条钉死，避免为了防「人工核实」而误伤真实到账。
  const f = await fixture(t)
  const cookie = await f.register()
  const created = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month', provider: 'vaehub' } })
  const order = created.body.order
  const expiredAt = new Date(Date.parse('2026-09-18T08:00:00.000Z') + 15 * 60_000).toISOString()
  await f.router.__db.run('UPDATE vip_orders SET payment_expires_at = ? WHERE id = ?', expiredAt, order.id)
  f.setTime(Date.parse(expiredAt) + 1_000)
  await f.router.__expirySweep()
  assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie })).body.order.status, 'expired')

  const paid = f.notify(order, { status: 1 })
  assert.equal((await f.raw('/payments/vaehub/notify', paid)).text, 'SUCCESS')
  assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie })).body.order.status, 'paid')
  assert.equal((await f.request('/auth/me', { cookie })).body.user.vipActive, true)
})

test('a voided order with a wrong amount still goes to manual review', async (t) => {
  // 金额不符说明钱确实动了，只是数目不对 —— 这种必须人工核对，
  // 不能因为订单已过期就把用户的钱丢掉不管。
  const f = await fixture(t)
  const cookie = await f.register()
  const created = await f.request('/vip/orders', { method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month', provider: 'vaehub' } })
  const order = created.body.order
  const expiredAt = new Date(Date.parse('2026-09-18T08:00:00.000Z') + 15 * 60_000).toISOString()
  await f.router.__db.run('UPDATE vip_orders SET payment_expires_at = ? WHERE id = ?', expiredAt, order.id)
  f.setTime(Date.parse(expiredAt) + 1_000)
  await f.router.__expirySweep()
  assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie })).body.order.status, 'expired')

  const underpaid = f.notify(order, { status: 1 })
  underpaid.body.data.amount = 1
  underpaid.body.data.amount_paid = 1
  assert.equal((await f.raw('/payments/vaehub/notify', underpaid)).status, 422)
  assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie })).body.order.status, 'review')
})

test('VAEHUB_USDT_RATES_JSON 容忍 .env 的引号丢失与行尾注释', async () => {
  // `set -a && . ./.env` 会把引号剥掉变成 {USD:1}；--env-file 又不会覆盖已存在的环境变量，
  // 导致服务启动即崩。这两种写法都必须能正常解析出汇率。
  const { loadVaehubRates } = await import('../server/vip.js')
  assert.deepEqual(loadVaehubRates('{"USD":1}'), { USD: 1 })
  assert.deepEqual(loadVaehubRates('{USD:1}'), { USD: 1 })
  assert.deepEqual(loadVaehubRates('{"USD":1}  # 1 USDT 兑换多少法币'), { USD: 1 })
  assert.deepEqual(loadVaehubRates('{"USD":1,"EUR":0.9}'), { USD: 1, EUR: 0.9 })
  // 真正非法的值仍然要报错，不能静默降级。
  assert.throws(() => loadVaehubRates('garbage'), /must be valid JSON/)
})
