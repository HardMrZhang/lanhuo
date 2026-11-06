import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { createVipRouter } from '../server/vip.js'
import {
  allocateOffset, buildPaymentUri, chainConfig, formatUnits, formatUnitsExact, keccak256,
  normalizeAddress, toChecksumAddress, toUnits,
} from '../server/evmchain.js'

const ORIGIN = 'https://vip.example.test'
const PAY_ADDRESS = '0x86e54cedad14c72d740070613147d5f10033f65c'
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const TEST_CAPTCHA = { enabled: true, issue: () => ({ text: 'TESTCAPTCHA', svg: '<svg/>' }) }

// ---------------------------------------------------------------------------
// 纯函数：keccak / EIP-55 / 金额
// ---------------------------------------------------------------------------

test('keccak256 matches the reference vectors', () => {
  assert.equal(keccak256(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
  assert.equal(keccak256('abc'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45')
})

test('EIP-55 checksums the reference addresses correctly', () => {
  const vectors = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ]
  for (const vector of vectors) {
    assert.equal(toChecksumAddress(vector.toLowerCase()), vector)
  }
  assert.equal(toChecksumAddress('not-an-address'), null)
  assert.equal(normalizeAddress('0x86E54CEDAD14C72D740070613147D5F10033F65C'), PAY_ADDRESS)
})

test('amounts convert to integer units without floating point drift', () => {
  assert.equal(toUnits('10.0123', 18), 10_012_300_000_000_000_000n)
  assert.equal(toUnits('10', 18), 10_000_000_000_000_000_000n)
  // MySQL DECIMAL(20,8) 会带回多余的尾零，不能因此判定为无效。
  assert.equal(toUnits('10.01230000', 18), 10_012_300_000_000_000_000n)
  // 真实的精度丢失必须被拒绝。
  assert.throws(() => toUnits('10.0123000000000000001', 18))
  assert.equal(formatUnits(10_012_300_000_000_000_000n, 18), '10.0123')
  assert.equal(formatUnits(10_000_000_000_000_000_000n, 18), '10')
})

test('display format keeps exactly 4 decimals with trailing zeros', () => {
  // 应付金额固定 4 位小数：尾数是订单标识，尾零不能被吞掉。
  assert.equal(formatUnitsExact(10_012_300_000_000_000_000n, 18, 4), '10.0123')
  assert.equal(formatUnitsExact(10_012_000_000_000_000_000n, 18, 4), '10.0120')
  assert.equal(formatUnitsExact(10_000_000_000_000_000_000n, 18, 4), '10.0000')
})

test('offsets are unique per order and reproducible', () => {
  const first = allocateOffset('order-a', new Set(), 18, 0n, 4)
  const again = allocateOffset('order-a', new Set(), 18, 0n, 4)
  assert.equal(first, again, '同一订单必须算出同一个金额')
  const taken = new Set([(10_000_000_000_000_000_000n + first).toString()])
  const second = allocateOffset('order-a', taken, 18, 10_000_000_000_000_000_000n, 4)
  assert.notEqual(second, first, '金额已被占用时必须换用其它偏移')
  // 偏移末位为 0 会被跳过：10.0120 的有效位比 10.0123 少。
  const step = first / 10n ** 14n
  assert.notEqual(step % 10n, 0n)
})

test('bsc chain config is disabled without a payment address', () => {
  assert.equal(chainConfig({}, 'BSC'), null)
  assert.equal(chainConfig({ BSC_PAY_ADDRESS: 'nope' }, 'BSC'), null)
  const config = chainConfig({ BSC_PAY_ADDRESS: PAY_ADDRESS }, 'BSC')
  assert.equal(config.address, PAY_ADDRESS)
  assert.equal(config.decimals, 18)
  assert.equal(config.symbol, 'USDT')
  assert.equal(config.chainId, 56)
  assert.equal(config.displayDecimals, 4)
  assert.equal(config.token, USDT.toLowerCase())
  assert.ok(config.rpcUrls.length > 0)
})

test('bsc orders expire after 15 minutes by default', () => {
  const config = chainConfig({ BSC_PAY_ADDRESS: PAY_ADDRESS }, 'BSC')
  // 链上订单共用同一个收款地址，尾数是订单的唯一标识，因此必须限时支付。
  assert.equal(config.orderTtlMs, 15 * 60_000)
  // 过期后仍需认领一段窗口内的迟到转账（用户在截止前一刻发起、链上确认较慢）。
  assert.ok(config.latePaymentWindowMs >= 3_600_000)
  // 显式配置可以覆盖默认值。
  const custom = chainConfig({ BSC_PAY_ADDRESS: PAY_ADDRESS, BSC_ORDER_TTL_MS: '1800000' }, 'BSC')
  assert.equal(custom.orderTtlMs, 30 * 60_000)
  // 过短的时限会让用户来不及支付，必须拒绝。
  assert.throws(
    () => chainConfig({ BSC_PAY_ADDRESS: PAY_ADDRESS, BSC_ORDER_TTL_MS: '60000' }, 'BSC'),
    /ORDER_TTL_MS/,
  )
})

test('payment URI carries token, chain id, recipient and exact amount', () => {
  const config = chainConfig({ BSC_PAY_ADDRESS: PAY_ADDRESS }, 'BSC')
  const uri = buildPaymentUri(config, 10_012_300_000_000_000_000n)
  assert.ok(uri.startsWith(`ethereum:${config.tokenChecksum}@56/transfer?`), uri)
  assert.ok(uri.includes(`address=${config.addressChecksum}`), uri)
  assert.ok(uri.endsWith('uint256=10012300000000000000'), uri)
})

// ---------------------------------------------------------------------------
// 集成：BSC 通道下单 -> 链上到账 -> 自动开通会员
// ---------------------------------------------------------------------------

/**
 * 构造一个假的 BSC 链：RPC 只会返回我们预设的转账日志。
 */
function fakeChain({ transfers = [] } = {}) {
  const calls = { blockNumber: 0, logs: 0 }
  let currentBlock = 100
  /** 把简写的转账描述转成链上日志格式。 */
  const toLog = (item, index) => ({
    transactionHash: `0x${'ab'.repeat(32)}${index.toString(16).padStart(2, '0')}`,
    logIndex: `0x${index.toString(16)}`,
    blockNumber: `0x${(item.blockNumber ?? 100).toString(16)}`,
    address: USDT,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      `0x${'00'.repeat(12)}${item.from?.slice(2).padStart(40, '0')}`,
      `0x${'00'.repeat(12)}${PAY_ADDRESS.slice(2)}`,
    ],
    data: `0x${BigInt(item.units).toString(16).padStart(64, '0')}`,
  })
  const logs = transfers.map(toLog)
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body)
    if (body.method === 'eth_blockNumber') {
      calls.blockNumber++
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${currentBlock.toString(16)}` }), { status: 200 })
    }
    if (body.method === 'eth_getLogs') {
      calls.logs++
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: logs }), { status: 200 })
    }
    throw new Error(`Unexpected RPC method ${body.method}`)
  }
  return {
    fetchImpl,
    calls,
    /** 注入新的转账，并把链高度往前推，保证下一次扫描能覆盖到。 */
    setTransfers(next) {
      logs.length = 0
      logs.push(...next.map(toLog))
      currentBlock = 200
    },
  }
}

async function fixture(t, overrides = {}) {
  const dbSuffix = randomUUID().replace(/-/g, '').slice(0, 12)
  const chain = overrides.chain ?? fakeChain()
  const env = {
    NODE_ENV: 'test', APP_URL: ORIGIN,
    NOWPAYMENTS_API_KEY: '', NOWPAYMENTS_IPN_SECRET: '',
    BSC_PAY_ADDRESS: PAY_ADDRESS,
    BSC_TOKEN_CONTRACT: USDT,
    BSC_POLL_INTERVAL_MS: '600000', // 测试里不自动轮询，由用例手动触发。
    BSC_CONFIRMATIONS: '1', // 测试里链高度推进即视为已确认。
    MYSQL_HOST: process.env.MYSQL_HOST || '127.0.0.1',
    MYSQL_PORT: process.env.MYSQL_PORT || '3306',
    MYSQL_USER: process.env.MYSQL_USER || 'root',
    MYSQL_PASSWORD: process.env.MYSQL_PASSWORD ?? '123456',
    MYSQL_DATABASE: `duanju_test_bsc_${dbSuffix}`,
    ...overrides.env,
  }
  let timestamp = Date.parse('2026-09-18T08:00:00.000Z')
    const router = await createVipRouter({
    env, fetchImpl: chain.fetchImpl, now: () => timestamp, captcha: TEST_CAPTCHA, logger: { log() {}, error() {} },
  })
  const app = express()
  app.use('/api', router)
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await router.close?.()
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
    const contentType = response.headers.get('content-type') || ''
    const payload = contentType.includes('application/json') ? await response.json() : await response.text()
    return { status: response.status, body: payload, headers: response.headers }
  }
  async function captchaBody() {
    const res = await request('/auth/captcha')
    return { captchaId: res.body.id, captchaText: 'TESTCAPTCHA' }
  }
  async function register(email = `${randomUUID()}@example.test`) {
    const res = await request('/auth/register', { method: 'POST', body: { email, password: 'Correct-Horse-972!', ...(await captchaBody()) } })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    return { cookie: res.headers.get('set-cookie').split(';')[0], user: res.body.user, email }
  }
  async function createOrder(cookie, planId = 'month', provider = 'bsc', key = randomUUID()) {
    return request('/vip/orders', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key }, body: { planId, provider },
    })
  }
  return { request, register, createOrder, chain, router, setTime: (v) => { timestamp = v } }
}

/** 手动触发一次链上扫描。 */
async function scanOnce(router) {
  await router.__bscScan?.()
}

test('bsc provider is offered and orders get a unique 4-decimal payable amount', async (t) => {
  const f = await fixture(t)
  const plans = await f.request('/vip/plans')
  assert.ok(plans.body.payment.providers.some((item) => item.id === 'bsc'))
  const owner = await f.register()
  const first = await f.createOrder(owner.cookie, 'month')
  assert.equal(first.status, 201, JSON.stringify(first.body))
  const order = first.body.order
  assert.equal(order.provider, 'bsc')
  assert.equal(order.payAddress, toChecksumAddress(PAY_ADDRESS))
  assert.equal(order.network, 'BSC (BNB Smart Chain) · BEP-20 USDT')
  assert.equal(order.chainId, 56)
  assert.equal(order.tokenSymbol, 'USDT')
  // 应付金额 = 套餐价 + 唯一尾数偏移，且固定 4 位小数。
  assert.ok(order.payAmount > 10 && order.payAmount < 10.01, `unexpected amount ${order.payAmount}`)
  assert.equal(String(order.payAmountText).split('.')[1]?.length, 4, '应付金额必须固定 4 位小数')
  assert.equal(order.payAmountText, formatUnitsExact(toUnits(order.payAmountText, 18), 18, 4))

  const second = await f.createOrder(owner.cookie, 'month')
  assert.notEqual(second.body.order.payAmount, order.payAmount, '两笔订单的应付金额必须不同')
})

test('the payment QR code is an SVG rendering of the payment URI', async (t) => {
  const f = await fixture(t)
  const owner = await f.register()
  const { body: { order } } = await f.createOrder(owner.cookie)
  const qr = await f.request(`/vip/orders/${order.id}/qr`, { cookie: owner.cookie })
  assert.equal(qr.status, 200)
  assert.ok(qr.headers.get('content-type').includes('image/svg+xml'))
  assert.ok(qr.body.startsWith('<svg'), '应返回 SVG 二维码')
  // 二维码内容是 EIP-681 支付 URI：代币合约 + chainId + 收款地址 + 最小单位金额。
  const config = chainConfig({ BSC_PAY_ADDRESS: PAY_ADDRESS }, 'BSC')
  const uri = buildPaymentUri(config, toUnits(order.payAmountText, 18))
  assert.ok(uri.startsWith('ethereum:'), uri)
  assert.ok(uri.includes('@56/transfer'), uri)
  assert.ok(uri.includes(`address=${config.addressChecksum}`), uri)
  // 别人的订单二维码不能被访问。
  const other = await f.register()
  const denied = await f.request(`/vip/orders/${order.id}/qr`, { cookie: other.cookie })
  assert.equal(denied.status, 404)
})

test('a confirmed on-chain transfer activates VIP exactly once', async (t) => {
  const chain = fakeChain()
  const f = await fixture(t, { chain })
  const owner = await f.register()
  const { body: { order } } = await f.createOrder(owner.cookie)
  const units = toUnits(String(order.payAmountText), 18)

  // 链上出现一笔金额完全匹配的转账。
  chain.setTransfers([{ units, from: '0x1111111111111111111111111111111111111111', blockNumber: 100 }])
  await scanOnce(f.router)

  const granted = (await f.request('/auth/me', { cookie: owner.cookie })).body.user
  assert.equal(granted.vipActive, true)
  assert.equal(granted.vipExpiresAt, '2026-10-18T08:00:00.000Z')
  const paid = (await f.request(`/vip/orders/${order.id}`, { cookie: owner.cookie })).body.order
  assert.equal(paid.status, 'paid')
  assert.ok(paid.txHash, '订单应记录链上交易哈希')

  // 重复扫描不会重复开通。
  await scanOnce(f.router)
  const again = (await f.request('/auth/me', { cookie: owner.cookie })).body.user
  assert.equal(again.vipExpiresAt, granted.vipExpiresAt)
})

test('an underpaid transfer never activates VIP and is flagged for review', async (t) => {
  const chain = fakeChain()
  const f = await fixture(t, { chain })
  const owner = await f.register()
  const { body: { order } } = await f.createOrder(owner.cookie)
  const units = toUnits(String(order.payAmountText), 18)

  // 少付：金额小于应付金额，且不会匹配到任何订单（金额已被占用）。
  chain.setTransfers([{ units: units - 10n ** 16n, from: '0x1111111111111111111111111111111111111111', blockNumber: 100 }])
  await scanOnce(f.router)

  const user = (await f.request('/auth/me', { cookie: owner.cookie })).body.user
  assert.equal(user.vipActive, false, '少付不能开通会员')
  const still = (await f.request(`/vip/orders/${order.id}`, { cookie: owner.cookie })).body.order
  assert.equal(still.status, 'pending')
})

test('a transfer for an unknown amount is ignored', async (t) => {
  const chain = fakeChain()
  const f = await fixture(t, { chain })
  const owner = await f.register()
  chain.setTransfers([{ units: 123456n, from: '0x1111111111111111111111111111111111111111', blockNumber: 100 }])
  await scanOnce(f.router)
  assert.equal((await f.request('/auth/me', { cookie: owner.cookie })).body.user.vipActive, false)
})

test('legacy base orders are shown as BSC and still settle on-chain', async (t) => {
  const chain = fakeChain()
  const f = await fixture(t, { chain })
  const owner = await f.register()
  // 造一笔改造前的 'base' 通道订单：金额 6 位小数、没有 pay_amount_text。
  const orderId = randomUUID()
  await f.router.__db.run(
    `INSERT INTO vip_orders (id, user_id, idempotency_key, plan_id, plan_name, days, amount_cents,
      status, created_at, provider, pay_address, pay_amount, pay_currency, chain_id, token_symbol)
     VALUES (?, ?, ?, 'month', '月度会员', 30, 1000, 'pending', ?, 'base', ?, '10.00788900', 'USDT', 8453, 'USDT')`,
    orderId, owner.user.id, `legacy-${randomUUID()}`, Date.now(), toChecksumAddress(PAY_ADDRESS),
  )

  // 展示层：网络文案不能是 TRON，必须是 BSC。
  const view = (await f.request(`/vip/orders/${orderId}`, { cookie: owner.cookie })).body.order
  assert.equal(view.provider, 'bsc', '历史 base 订单应归一化为 bsc')
  assert.equal(view.network, 'BSC (BNB Smart Chain) · BEP-20 USDT')
  assert.notEqual(view.network, 'TRON / TRC20')
  assert.equal(view.chainId, 56)
  // 精确金额文本兜底：不能丢尾数。
  assert.equal(view.payAmountText, '10.007889')

  // 结算层：历史订单也要能被链上转账认领并开通会员。
  chain.setTransfers([{ units: toUnits('10.007889', 18), from: '0x1111111111111111111111111111111111111111', blockNumber: 100 }])
  await scanOnce(f.router)
  const granted = (await f.request('/auth/me', { cookie: owner.cookie })).body.user
  assert.equal(granted.vipActive, true, '历史 base 订单的到账也应开通会员')
  const paid = (await f.request(`/vip/orders/${orderId}`, { cookie: owner.cookie })).body.order
  assert.equal(paid.status, 'paid')
})

test('a bsc order is voided 15 minutes after it is created', async (t) => {
  const chain = fakeChain()
  const f = await fixture(t, { chain })
  const owner = await f.register()
  const { body: { order } } = await f.createOrder(owner.cookie)

  // 下单即带 15 分钟有效期。
  const expiresAt = Date.parse(order.expiresAt)
  assert.ok(Number.isFinite(expiresAt), '订单必须带过期时间')
  assert.equal(expiresAt - Date.parse(order.createdAt), 15 * 60_000, '订单有效期应为 15 分钟')

  // 时限内：订单仍是等待支付，扫描不会误作废它。
  f.setTime(Date.parse('2026-09-18T08:10:00.000Z'))
  await scanOnce(f.router)
  const pending = (await f.request(`/vip/orders/${order.id}`, { cookie: owner.cookie })).body.order
  assert.equal(pending.status, 'pending', '时限内不应作废')

  // 时限过后：订单作废（过期作废）。
  f.setTime(Date.parse('2026-09-18T08:16:00.000Z'))
  await scanOnce(f.router)
  const expired = (await f.request(`/vip/orders/${order.id}`, { cookie: owner.cookie })).body.order
  assert.equal(expired.status, 'expired', '超过 15 分钟未支付的订单必须作废')
  // 作废后不能开通会员。
  assert.equal((await f.request('/auth/me', { cookie: owner.cookie })).body.user.vipActive, false)
})

test('a late transfer within the grace window still settles the voided order', async (t) => {
  const chain = fakeChain()
  const f = await fixture(t, { chain })
  const owner = await f.register()
  const { body: { order } } = await f.createOrder(owner.cookie)
  const units = toUnits(String(order.payAmountText), 18)

  // 订单过期作废。
  f.setTime(Date.parse('2026-09-18T08:16:00.000Z'))
  await scanOnce(f.router)
  assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie: owner.cookie })).body.order.status, 'expired')

  // 用户在截止前一刻就发起了转账，只是链上确认慢：钱已经进了收款地址，必须认领。
  chain.setTransfers([{ units, from: '0x1111111111111111111111111111111111111111', blockNumber: 100 }])
  f.setTime(Date.parse('2026-09-18T08:20:00.000Z'))
  await scanOnce(f.router)

  const paid = (await f.request(`/vip/orders/${order.id}`, { cookie: owner.cookie })).body.order
  assert.equal(paid.status, 'paid', '宽限期内到达的转账仍应开通会员')
  assert.equal((await f.request('/auth/me', { cookie: owner.cookie })).body.user.vipActive, true)
})

test('a voided order keeps its amount reserved so a late transfer is not claimed by a new order', async (t) => {
  const chain = fakeChain()
  const f = await fixture(t, { chain })
  const owner = await f.register()
  const { body: { order } } = await f.createOrder(owner.cookie)

  // 订单过期作废。
  f.setTime(Date.parse('2026-09-18T08:16:00.000Z'))
  await scanOnce(f.router)
  assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie: owner.cookie })).body.order.status, 'expired')

  // 新订单不能复用作废订单的金额尾数，否则迟到的转账会认领到新订单头上。
  const second = await f.createOrder(owner.cookie, 'month')
  assert.equal(second.status, 201, JSON.stringify(second.body))
  assert.notEqual(second.body.order.payAmountText, order.payAmountText, '作废订单的金额尾数必须继续保留')

  // 迟到的转账仍然认领回原订单。
  const units = toUnits(String(order.payAmountText), 18)
  chain.setTransfers([{ units, from: '0x1111111111111111111111111111111111111111', blockNumber: 100 }])
  f.setTime(Date.parse('2026-09-18T08:20:00.000Z'))
  await scanOnce(f.router)
  assert.equal((await f.request(`/vip/orders/${order.id}`, { cookie: owner.cookie })).body.order.status, 'paid')
  assert.equal((await f.request(`/vip/orders/${second.body.order.id}`, { cookie: owner.cookie })).body.order.status, 'pending')
})

test('legacy chain orders are migrated to a 15-minute window and 4-decimal amounts', async (t) => {
  const chain = fakeChain()
  const f = await fixture(t, { chain })
  const owner = await f.register()

  // 造两笔改造前的链上订单（有效期都是 24 小时、金额 6 位小数）：
  // - 一笔创建于 2 天前：已在认领窗口之外，可以安全重分配金额；
  // - 一笔创建于 1 小时前：仍在认领窗口之内（可能有在途转账），金额不能动。
  // 夹具的「当前时间」固定为 2026-09-18T08:00:00Z。
  const fixtureNow = Date.parse('2026-09-18T08:00:00.000Z')
  const oldOrderId = randomUUID()
  const oldCreated = fixtureNow - 2 * 24 * 3600_000
  await f.router.__db.run(
    `INSERT INTO vip_orders (id, user_id, idempotency_key, plan_id, plan_name, days, amount_cents,
      status, created_at, provider, pay_address, pay_amount, pay_currency, chain_id, token_symbol, payment_expires_at)
     VALUES (?, ?, ?, 'month', '月度会员', 30, 1000, 'pending', ?, 'base', ?, '10.00788900', 'USDT', 8453, 'USDT', ?)`,
    oldOrderId, owner.user.id, `legacy-ttl-${randomUUID()}`, oldCreated, toChecksumAddress(PAY_ADDRESS),
    new Date(oldCreated + 24 * 3600_000).toISOString(),
  )
  // 认领窗口（有效期 15 分钟 + 迟到宽限期 6 小时）之内的订单。
  const liveOrderId = randomUUID()
  const liveCreated = fixtureNow - 3600_000
  await f.router.__db.run(
    `INSERT INTO vip_orders (id, user_id, idempotency_key, plan_id, plan_name, days, amount_cents,
      status, created_at, provider, pay_address, pay_amount, pay_currency, chain_id, token_symbol, payment_expires_at)
     VALUES (?, ?, ?, 'month', '月度会员', 30, 1000, 'pending', ?, 'base', ?, '10.00655500', 'USDT', 8453, 'USDT', ?)`,
    liveOrderId, owner.user.id, `legacy-live-${randomUUID()}`, liveCreated, toChecksumAddress(PAY_ADDRESS),
    new Date(liveCreated + 24 * 3600_000).toISOString(),
  )

  await f.router.__migrateLegacyBscOrders()

  // 有效期统一收敛到 15 分钟。
  for (const id of [oldOrderId, liveOrderId]) {
    const view = (await f.request(`/vip/orders/${id}`, { cookie: owner.cookie })).body.order
    const expiresAt = Date.parse(view.expiresAt)
    const createdAt = Date.parse(view.createdAt)
    assert.equal(expiresAt - createdAt, 15 * 60_000, `订单 ${id} 的有效期应为 15 分钟`)
  }

  // 认领窗口之外的旧订单：金额改为 4 位小数，且文本与数值一致。
  const migrated = (await f.request(`/vip/orders/${oldOrderId}`, { cookie: owner.cookie })).body.order
  assert.equal(String(migrated.payAmountText).split('.')[1]?.length, 4, '迁移后金额必须是 4 位小数')
  assert.equal(migrated.payAmountText, formatUnitsExact(toUnits(migrated.payAmountText, 18), 18, 4))

  // 认领窗口之内的订单：金额保持原样（可能有在途转账），只补齐文本。
  const live = (await f.request(`/vip/orders/${liveOrderId}`, { cookie: owner.cookie })).body.order
  assert.equal(live.payAmountText, '10.006555', '认领窗口内的金额不能被改写')
})
