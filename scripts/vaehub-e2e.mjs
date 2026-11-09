#!/usr/bin/env node
/**
 * 端到端建单自检：在服务器上验证 VaeHub 生产通道完整跑通。
 *
 * 走的是真实建单逻辑（同样的请求体、同样的签名、带上 callback_url），
 * 只是不走用户会话 —— 目的是验证「服务端发出的 callback_url 是否正确」。
 *
 * 用法：node --env-file-if-exists=.env scripts/vaehub-e2e.mjs
 */
import { createHash, randomBytes } from 'node:crypto'

const base = (process.env.VAEHUB_API_BASE || '').replace(/\/+$/, '')
const appTag = process.env.VAEHUB_APP_TAG?.trim() || 'project'
const appKey = process.env.VAEHUB_APP_KEY?.trim()
const appSecret = process.env.VAEHUB_APP_SECRET?.trim()
const country = process.env.VAEHUB_COUNTRY?.trim().toUpperCase() || 'USA'
const currency = process.env.VAEHUB_CURRENCY?.trim() || 'USD'
const paycode = process.env.VAEHUB_PAYCODE?.trim() || ''
const sandbox = process.env.VAEHUB_SANDBOX === 'true'
const sandboxBase = (process.env.VAEHUB_SANDBOX_API_BASE || '').replace(/\/+$/, '')
const sandboxKey = process.env.VAEHUB_SANDBOX_APP_KEY?.trim()
const sandboxSecret = process.env.VAEHUB_SANDBOX_APP_SECRET?.trim()

const target = sandbox && sandboxBase ? sandboxBase : base
const effectiveKey = sandbox && sandboxKey ? sandboxKey : appKey
const effectiveSecret = sandbox && sandboxSecret ? sandboxSecret : appSecret

if (!target || !effectiveKey || !effectiveSecret) {
  console.error('✗ VaeHub 配置不完整')
  process.exit(1)
}

const timestamp = String(Math.floor(Date.now() / 1000))
const nonce = randomBytes(8).toString('hex')
const signature = createHash('sha256')
  .update(`${effectiveKey}${timestamp}${nonce}${effectiveSecret}`)
  .digest('hex')
const raw = `${appTag}:${timestamp}:${effectiveKey}:${nonce}:${signature}`

// 与 server/vip.js 一致：callback_url 指向本站回调端点。
const origin = (process.env.APP_URL || '').replace(/\/+$/, '')
const callbackUrl = origin ? `${origin}/api/payments/vaehub/notify` : ''

const body = {
  order_id: `e2e-${Date.now()}`,
  country,
  currency,
  amount: 1,
  return_type: 'cashier',
  user_hash: createHash('sha256').update('e2e-user').digest('hex').slice(0, 32),
}
if (paycode) body.paycode = paycode
if (callbackUrl) body.callback_url = callbackUrl

console.log(`环境      : ${sandbox ? 'sandbox' : 'production'}`)
console.log(`接口地址  : ${target}`)
console.log(`国家/币种 : ${country}/${currency}${paycode ? `  paycode=${paycode}` : ''}`)
console.log(`callback_url: ${callbackUrl || '(未配置 APP_URL，不传)'}`)
console.log('')

const response = await fetch(`${target}/v1/trade/payin`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${Buffer.from(raw, 'utf8').toString('base64')}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
})

const text = await response.text()
console.log(`HTTP ${response.status}`)
console.log(text)

let payload = null
try { payload = JSON.parse(text) } catch { /* 保持原样 */ }
if (Number(payload?.code) === 200) {
  console.log('\n✓ 生产建单成功')
  console.log(`  open_id     : ${payload?.data?.open_id}`)
  console.log(`  cashier_link: ${payload?.data?.cashier_link}`)
  console.log(`  status      : ${payload?.data?.status_text} (${payload?.data?.status})`)
  process.exit(0)
}
console.log('\n✗ 建单失败')
process.exit(1)
