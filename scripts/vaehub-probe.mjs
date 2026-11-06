/**
 * VaeHub 通道自检脚本。
 *
 * 用途：白名单、签名、地址任一有问题时，用它拿到真实报错，而不是靠下单试错。
 * 只做「建单」这一步，不碰真实收款（测试环境可配合 mock_res）。
 *
 * 用法：
 *   # 自检当前 .env 配置的地址
 *   node --env-file-if-exists=.env scripts/vaehub-probe.mjs
 *
 *   # 临时换地址（不改动 .env）
 *   VAEHUB_API_BASE=https://sandbox.example.com/api node --env-file=.env scripts/vaehub-probe.mjs
 *
 *   # 只验签（用官方 /v1/hello/world 端点，不建单）
 *   node --env-file-if-exists=.env scripts/vaehub-probe.mjs --ping
 */
import { createHash, randomBytes } from 'node:crypto'

const args = process.argv.slice(2)
const pingOnly = args.includes('--ping')
const mockRes = (() => {
  const hit = args.find((a) => a.startsWith('--mock='))
  return hit ? hit.slice('--mock='.length) : ''
})()

/** 与 server/vip.js 保持一致的签名算法：SHA256(APP_KEY+TIMESTAMP+NONCE+APP_SECRET)。 */
function authHeader(config, timestamp, nonce) {
  const signature = createHash('sha256')
    .update(`${config.appKey}${timestamp}${nonce}${config.appSecret}`)
    .digest('hex')
  const raw = `${config.appTag}:${timestamp}:${config.appKey}:${nonce}:${signature}`
  return `Bearer ${Buffer.from(raw, 'utf8').toString('base64')}`
}

/** 与 server/vip.js 的 vaehubBaseUrl 一致：只保留 origin + pathname。 */
function baseUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch { return null }
}

const base = baseUrl(process.env.VAEHUB_API_BASE)
const appTag = process.env.VAEHUB_APP_TAG?.trim() || 'project'
const appKey = process.env.VAEHUB_APP_KEY?.trim()
const appSecret = process.env.VAEHUB_APP_SECRET?.trim()
const currency = process.env.VAEHUB_CURRENCY?.trim() || 'USD'
const country = process.env.VAEHUB_COUNTRY?.trim()?.toUpperCase() || 'USA'
const sandbox = process.env.VAEHUB_SANDBOX === 'true'
const sandboxBase = baseUrl(process.env.VAEHUB_SANDBOX_API_BASE)
// 沙箱凭据独立配置：测试环境的 App Key / Secret 通常与生产不同。
const sandboxAppKey = process.env.VAEHUB_SANDBOX_APP_KEY?.trim()
const sandboxAppSecret = process.env.VAEHUB_SANDBOX_APP_SECRET?.trim()

if (!base && !sandboxBase) {
  console.error('✗ VAEHUB_API_BASE / VAEHUB_SANDBOX_API_BASE 未配置或格式不正确（需含协议，如 https://xxx.top/api）')
  process.exit(1)
}

const target = sandbox && sandboxBase ? sandboxBase : base
const effectiveKey = sandbox && sandboxAppKey ? sandboxAppKey : appKey
const effectiveSecret = sandbox && sandboxAppSecret ? sandboxAppSecret : appSecret

if (!effectiveKey || !effectiveSecret) {
  console.error('✗ APP_KEY / APP_SECRET 未配置')
  process.exit(1)
}

const config = { appTag, appKey: effectiveKey, appSecret: effectiveSecret }
console.log(`目标地址 : ${target}`)
console.log(`环境     : ${sandbox ? 'sandbox' : 'production'}`)
console.log(`App Key  : ${effectiveKey}`)
if (sandbox && sandboxAppSecret) console.log('凭据     : 沙箱专用（VAEHUB_SANDBOX_APP_SECRET）')
console.log('')

const timestamp = String(Math.floor(Date.now() / 1000))
const nonce = randomBytes(8).toString('hex')

// /v1/hello/world 是文档提供的签名验证端点，不建单、不产生任何订单。
const endpoint = pingOnly ? '/v1/hello/world' : '/v1/trade/payin'
const body = pingOnly
  ? { myName: 'JACK', myHome: 'EARTH' }
  : {
    order_id: `probe-${Date.now()}`,
    country,
    currency,
    amount: 1,
    return_type: 'cashier',
    user_hash: createHash('sha256').update('probe-user').digest('hex').slice(0, 32),
  }
if (!pingOnly && mockRes) body.mock_res = mockRes

let response
try {
  response = await fetch(`${target}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(config, timestamp, nonce),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
} catch (error) {
  console.error(`✗ 网络请求失败：${error?.message || error}`)
  console.error('  检查 DNS / 代理 / 出网是否正常')
  process.exit(2)
}

const text = await response.text()
console.log(`HTTP ${response.status}`)
console.log(text)

let payload = null
try { payload = JSON.parse(text) } catch { /* 非 JSON 响应保持原样打印 */ }

if (pingOnly) {
  const code = Number(payload?.code)
  const msg = String(payload?.msg || '')
  const ok = code === 200
  console.log(`\n${ok ? '✓ 签名验证通过' : '✗ 签名验证失败'}`)
  if (!ok) {
    if (/IP not allowed/i.test(msg)) {
      // 关键区分：IP 拦截发生在凭据校验之前，此时报「签名错误」是误导。
      const ip = msg.match(/\[([^\]]+)\]/)?.[1] || '未知'
      console.log(`  实际原因：出口 IP 未在白名单（${ip}），请求根本没进入凭据校验`)
      console.log('  → 先加白名单，再验签；此时改 APP_SECRET 没有意义')
    } else {
      console.log('  → 检查 APP_KEY / APP_SECRET / APP_TAG')
    }
  }
  process.exit(ok ? 0 : 1)
}

const code = Number(payload?.code)
if (code === 200) {
  console.log('\n✓ 建单成功 —— 白名单与签名均已生效')
  console.log(`  open_id     : ${payload?.data?.open_id}`)
  console.log(`  cashier_link: ${payload?.data?.cashier_link}`)
  process.exit(0)
}

// 已知错误码给出可执行的下一步，避免只看到一句报错干瞪眼。
const msg = String(payload?.msg || '')
console.log(`\n✗ 建单失败 code=${code}`)
if (/IP not allowed/i.test(msg)) {
  const ip = msg.match(/\[([^\]]+)\]/)?.[1] || '未知'
  console.log(`  被拒绝的出口 IP：${ip}`)
  console.log('  → 把该 IP（或其所属网段）加入 VaeHub 白名单后重试')
  console.log('  → 若出口 IP 是动态的，请对方按 CIDR 网段放行')
} else if (/AppTag or AppKey not found|AppSecret not configured/i.test(msg)) {
  // 这一条说明 App Key / App Tag 在对方侧根本不存在 —— 还没走到验签那一步。
  console.log('  → App Key / App Tag 在对方侧不存在（未进入验签环节）')
  console.log(`  → 确认 App Key=${appKey}、App Tag=${appTag} 是否适用于当前环境`)
  console.log('  → 测试环境与生产环境的 App Key 可能不同，需分别确认')
} else if (/Signature verification failed/i.test(msg)) {
  // 这一条说明 App Key 是存在的（否则报 "not found"），只是签名算不对。
  console.log('  → App Key 存在，但签名校验未通过 —— 基本可判定为 APP_SECRET 不匹配')
  console.log('  → 测试环境与生产环境的 APP_SECRET 通常不同，需向对方索取测试环境的值')
  console.log('  → 签名算法已按文档核对无误（SHA256(APP_KEY+TIMESTAMP+NONCE+APP_SECRET)）')
} else if (code === 401) {
  console.log('  → 401 可能是白名单拦截，也可能是凭据问题')
  console.log('  → 先用 --ping 单独验证签名，排除 APP_KEY / APP_SECRET')
} else {
  console.log('  → 按文档核对请求参数（country / currency / amount / user_hash）')
}
process.exit(1)
