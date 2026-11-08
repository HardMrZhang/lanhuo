import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

/**
 * VaeHub 自检脚本的契约。
 *
 * 这个脚本是联调时唯一能直接看到平台真实报错的工具（服务端只在日志里打印），
 * 所以它必须把服务端会发的参数都发出去 —— 少发一个参数，测试结论就是错的。
 */
test('the probe sends the paycode so channel routing is actually exercised', () => {
  const probe = read('scripts/vaehub-probe.mjs')
  // 不传 paycode 的话，平台会走自动路由，报错信息与指定通道时完全不同，
  // 曾经因此误判「所有 paycode 报错一致」。
  assert.ok(probe.includes('VAEHUB_PAYCODE'), '探针必须读取 VAEHUB_PAYCODE')
  assert.ok(
    /body\.paycode\s*=\s*paycode/.test(probe),
    '探针必须把 paycode 放进建单请求体',
  )
  assert.ok(/if\s*\(!pingOnly\s*&&\s*paycode\)/.test(probe), '只有建单才带 paycode，验签端点不带')
})

test('the probe reads the sandbox credentials independently from production', () => {
  const probe = read('scripts/vaehub-probe.mjs')
  assert.ok(probe.includes('VAEHUB_SANDBOX_APP_KEY'), '探针必须支持沙箱专用 App Key')
  assert.ok(probe.includes('VAEHUB_SANDBOX_APP_SECRET'), '探针必须支持沙箱专用 App Secret')
  assert.ok(probe.includes('VAEHUB_SANDBOX_API_BASE'), '探针必须支持沙箱地址')
})

test('the server only sends mock_res inside the sandbox', () => {
  const vip = read('server/vip.js')
  // mock_res 文档明确写只作用于测试环境；生产带上它没意义且容易被误解。
  assert.ok(
    /if\s*\(vaehub\.sandbox\s*&&\s*vaehub\.mockRes\)\s*body\.mock_res\s*=/.test(vip),
    'mock_res 只能在沙箱发送',
  )
})

test('sandbox mode selects the sandbox base and the sandbox secret', () => {
  const vip = read('server/vip.js')
  // 沙箱开启时优先用沙箱地址与沙箱凭据，取不到才回退生产配置。
  assert.ok(
    /vaehubEffectiveBase\s*=\s*vaehubSandbox\s*&&\s*vaehubSandboxBase\s*\?\s*vaehubSandboxBase\s*:\s*vaehubBase/.test(vip),
    '沙箱开启时必须使用沙箱地址',
  )
  assert.ok(
    /vaehubEffectiveAppSecret\s*=\s*vaehubSandbox\s*&&\s*vaehubSandboxAppSecret\s*\?\s*vaehubSandboxAppSecret\s*:\s*vaehubAppSecret/.test(vip),
    '沙箱开启时必须使用沙箱 App Secret',
  )
})
