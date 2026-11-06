import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

/**
 * 前端与服务端的接口契约测试。
 * 前后端字段名一旦错配，运行时只会表现为「验证码一直提示错误」这类难以定位的问题，
 * 这里用静态检查把契约固定下来，避免回归。
 */
const CAPTCHA_CONTRACT = ['captchaId', 'captchaText']

test('the captcha answer uses the field names the server verifies', () => {
  const captchaField = read('src/components/CaptchaField.vue')
  // 组件返回的验证码答案必须使用服务端校验的字段名。
  for (const field of CAPTCHA_CONTRACT) {
    assert.ok(
      captchaField.includes(field),
      `CaptchaField.vue must send "${field}" to the server`,
    )
  }
  // 旧字段名 id / text 会被当成无关字段丢弃，导致校验永远失败。
  assert.ok(
    !/return\s*\{\s*id:\s*challenge/.test(captchaField),
    'CaptchaField.vue must not return the legacy { id, text } shape',
  )
})

test('no source file sends the legacy captcha field names', () => {
  const files = [
    'src/components/CaptchaField.vue',
    'src/vip-api.ts',
    'src/account.ts',
    'src/components/AccountPanel.vue',
  ]
  for (const file of files) {
    const source = read(file)
    assert.ok(
      !/\bcaptchaId\s*:\s*[^,]*\.id\b\s*,\s*text\s*:/.test(source),
      `${file} must not send { captchaId, text }`,
    )
    assert.ok(
      !/\{[^}]*\btext:\s*(?:answer|text)\b[^}]*\}\s*(?:as|:)/.test(source) || file === 'src/components/CaptchaField.vue',
      `${file} must not build a captcha payload with a bare "text" key`,
    )
  }
})

test('the captcha payload type is declared once and reused', () => {
  const api = read('src/vip-api.ts')
  assert.ok(api.includes('export interface CaptchaAnswer'), 'vip-api.ts must export CaptchaAnswer')
  assert.ok(api.includes('captchaId: string'), 'CaptchaAnswer must declare captchaId')
  assert.ok(api.includes('captchaText: string'), 'CaptchaAnswer must declare captchaText')

  // 组件与账号模块都应复用该类型，避免各自拼装字段名。
  assert.ok(read('src/components/CaptchaField.vue').includes('type CaptchaAnswer'))
  assert.ok(read('src/account.ts').includes('type CaptchaAnswer'))
})

test('the payment page shows a countdown and voids the order when it expires', () => {
  const vip = read('src/views/Vip.vue')
  // 倒计时必须由服务端下发的 expiresAt 驱动，不能用本地常量。
  assert.ok(vip.includes('order.expiresAt'), '倒计时必须基于服务端下发的 expiresAt')
  assert.ok(/remainingMs\s*\(/.test(vip), 'Vip.vue 必须有剩余时间计算')
  assert.ok(/countdownText\s*\(/.test(vip), 'Vip.vue 必须有倒计时文案')
  // 倒计时要走一个每秒推进的时钟，模板才能随时间重新渲染。
  assert.ok(/setInterval/.test(vip), '倒计时需要定时器驱动')
  // 过期作废：倒计时归零后不再展示收款地址与二维码。
  assert.ok(vip.includes('currentExpired'), 'Vip.vue 必须有过期状态')
  assert.ok(/currentExpired\s*\|\|\s*currentOrder\.status === 'expired'/.test(vip), '过期订单必须展示作废提示')
  // 过期后不允许继续支付（canContinue 要拦掉）。
  const canContinue = vip.match(/function canContinue[\s\S]*?\n}/)?.[0] || ''
  assert.ok(canContinue.includes('remainingMs'), 'canContinue 必须判断剩余时间，过期订单不得继续支付')
})

test('the payable amount is rendered from the exact text, never from a float', () => {
  const vip = read('src/views/Vip.vue')
  // 链上通道的应付金额必须用 payAmountText（服务端下发的精确文本）。
  // 用 payAmount（number）会把尾零抹掉，用户按显示金额转账反而认领不到订单。
  assert.ok(vip.includes('payAmountText'), '应付金额必须使用 payAmountText')
  const bscPanel = vip.match(/bscActive\(currentOrder\)[\s\S]*?transfer-panel/)?.[0] || ''
  assert.ok(
    bscPanel.includes('payAmountText(currentOrder)'),
    'BSC 面板的应付金额必须用 payAmountText',
  )
  // 复制到剪贴板的也必须是精确文本。
  assert.ok(
    vip.includes('copyPayment(payAmountText(currentOrder)'),
    '复制的金额必须是精确文本',
  )
  // 订单标题行同样不能用 number。
  assert.ok(
    /bscActive\(currentOrder\) \? payAmountText\(currentOrder\)/.test(vip),
    '订单摘要的金额必须用 payAmountText',
  )
})

test('the server issues a 15-minute window and 4-decimal amounts for chain orders', () => {
  const chain = read('server/evmchain.js')
  const vip = read('server/vip.js')
  // 默认订单有效期必须是 15 分钟。
  assert.ok(
    chain.includes("read('ORDER_TTL_MS', 15 * 60_000)"),
    '链上订单默认有效期必须是 15 分钟',
  )
  // 默认展示精度必须是 4 位小数。
  assert.ok(
    chain.includes("read('DISPLAY_DECIMALS', 4)"),
    '应付金额默认展示精度必须是 4 位小数',
  )
  // 建单时必须按展示精度格式化，且把精确文本一起落库。
  assert.ok(vip.includes('formatUnitsExact(units, config.decimals, config.displayDecimals)'), '建单必须按展示精度格式化金额')
  assert.ok(vip.includes('pay_amount_text = ?'), '建单必须写入 pay_amount_text 精确文本')
  // 存量订单迁移：有效期收敛到 15 分钟、金额统一 4 位小数。
  assert.ok(vip.includes('migrateLegacyBscOrders'), '必须有存量链上订单的收敛迁移')
})

test('third-party checkout redirects automatically instead of leaving the user on the order page', () => {
  const vip = read('src/views/Vip.vue')
  // 第三方代收的语义是「点支付 → 进收银台付款」。只给一个链接让用户自己找，
  // 等于漏掉了一步，必须在下单成功后自动跳过去。
  assert.ok(vip.includes('redirectToCashier'), '必须有收银台自动跳转逻辑')
  assert.ok(
    /window\.location\.assign\(/.test(vip),
    '收银台跳转必须真的发生，不能只是显示链接',
  )
  // 跳转要发生在下单成功之后，且只对 VaeHub 生效。
  const createOrder = vip.match(/async function createOrder[\s\S]*?\n}/)?.[0] || ''
  assert.ok(createOrder.includes('redirectToCashier'), '下单成功后必须触发收银台跳转')
  assert.ok(createOrder.includes("order.provider === 'vaehub'"), '只有 VaeHub 走收银台跳转')
  // 同一笔订单不能反复跳（刷新页面会被弹走）。
  assert.ok(vip.includes('cashierRedirected'), '必须有防重复跳转的标记')
  // 跳转前记录订单 id，收银台返回后能定位回这笔订单。
  assert.ok(vip.includes('PENDING_ORDER_KEY'), '跳转前必须记录待支付订单 id')
  assert.ok(vip.includes('sessionStorage.setItem(PENDING_ORDER_KEY'), '待支付订单 id 必须写入 sessionStorage')
  // 订单终态后清理记录，避免下次打开又回到已完结的订单。
  assert.ok(vip.includes('clearPendingOrder'), '订单终态后必须清理待支付订单记录')
})
