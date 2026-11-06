/**
 * EVM 链（BSC / Base / Ethereum …）自建收款地址支持。
 *
 * 背景：站点自建一个**固定**的收款地址，所有订单共用它。这与 NOWPayments
 * 的「每单一个专属 TRC20 地址 + 回调通知」模型不同：
 * - 没有支付方回调，只能靠轮询链上日志发现到账；
 * - 地址共用，必须自己判断一笔转账属于哪个订单。
 *
 * 订单归属方案：给每笔订单分配一个**唯一的尾数偏移**（如 10.0123 USDT），
 * 尾数是订单的唯一标识，用户无需提供备注或 TxHash。
 *
 * 本模块只负责「链上事实」：读配置、算地址校验和、扫日志、按整数最小单位比金额。
 * 订单状态机与会员开通在 server/vip.js 中完成。
 */
import { createHash } from 'node:crypto'

/**
 * BSC 主网默认 RPC，按顺序做故障转移。
 *
 * 选点说明：
 * - bsc-rpc.publicnode.com 对 eth_getLogs 的范围限制最宽松，放在首位；
 * - binance.llamarpc.com 常年连不上，故不列入默认列表；
 * - dataseed 系列可正常读区块，但查询大范围日志会返回 limit exceeded。
 */
export const DEFAULT_RPC_URLS = [
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
]

/** BSC 主网 USDT（Binance-Peg Tether，decimals=18）。 */
export const BSC_USDT_CONTRACT = '0x55d398326f99059fF775485246999027B3197955'

/** BSC 主网 USDC（Circle 官方发行，decimals=18）。 */
export const BSC_USDC_CONTRACT = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'

/** 默认收款代币：USDT。 */
export const DEFAULT_CONTRACT = BSC_USDT_CONTRACT

/** Transfer(address,address,uint256) 事件签名，用于 eth_getLogs 过滤。 */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// ---------------------------------------------------------------------------
// keccak-256（EVM 用的哈希，与 SHA3-256 不同：填充字节为 0x01 而非 0x06）
// 仅用于算 EIP-55 地址校验和，不做通用哈希用途。
//
// 这里直接用经过验证的 js-sha3，而不是手写置换：keccak-f 的 ρ/π 索引极易写错，
// 而地址校验和错了会导致用户复制到错误的大小写地址，钱可能转丢。
// ---------------------------------------------------------------------------
import jsSha3 from 'js-sha3'

const { keccak256: sha3Keccak256 } = jsSha3

/** keccak-256 摘要（32 字节，hex 小写）。 */
export function keccak256(input) {
  return sha3Keccak256(typeof input === 'string' ? input : Buffer.from(input))
}

/** EIP-55 混合大小写校验和地址；非法格式返回 null。 */
export function toChecksumAddress(address) {
  if (typeof address !== 'string') return null
  const raw = address.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null
  const lower = raw.slice(2).toLowerCase()
  const hash = keccak256(lower)
  let out = '0x'
  for (let i = 0; i < lower.length; i++) {
    out += Number.parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i]
  }
  return out
}

/** 地址归一化为小写（比较用）。 */
export function normalizeAddress(address) {
  if (typeof address !== 'string') return null
  const raw = address.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null
  return raw.toLowerCase()
}

/**
 * 从 32 字节的日志 topic 里取出地址。
 * eth_getLogs 的 topic 是左补零的 32 字节值，直接喂给 normalizeAddress 会失败。
 */
export function addressFromTopic(topic) {
  if (typeof topic !== 'string') return null
  const raw = topic.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) return normalizeAddress(raw)
  const tail = raw.slice(-40)
  // 补零前缀必须全为零，否则不是合法地址。
  if (!/^0x0{24}/.test(raw)) return null
  return normalizeAddress(`0x${tail}`)
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/**
 * 读取 EVM 链自建收款配置。缺少地址或 RPC 时返回 null（该通道不启用）。
 *
 * 环境变量前缀由链决定（BSC_PAY_ADDRESS / BASE_PAY_ADDRESS …），
 * 找不到带前缀的变量时回退到通用变量名，保持单链部署时配置简单。
 *
 * @param {Record<string, string | undefined>} env
 */
export function chainConfig(env = process.env, prefix = 'BSC') {
  const read = (name, fallback = undefined) => env[`${prefix}_${name}`] ?? env[`CHAIN_${name}`] ?? fallback
  const address = normalizeAddress(read('PAY_ADDRESS', ''))
  if (!address) return null
  const token = normalizeAddress(read('TOKEN_CONTRACT', DEFAULT_CONTRACT))
  if (!token) throw new Error(`${prefix}_TOKEN_CONTRACT must be a 0x-prefixed 20-byte address`)
  const decimals = Number(read('TOKEN_DECIMALS', 18))
  if (!Number.isInteger(decimals) || decimals < 6 || decimals > 24) {
    throw new Error(`${prefix}_TOKEN_DECIMALS must be an integer between 6 and 24`)
  }
  const symbol = String(read('TOKEN_SYMBOL', 'USDT')).trim().slice(0, 16)
  // 应付金额的**展示精度**：固定 4 位小数。BSC 的 USDT 是 18 位精度，但用户核对的是
  // 「10.0123 USDT」这样的小数额，位数太多既难读也容易转错。
  const displayDecimals = Number(read('DISPLAY_DECIMALS', 4))
  if (!Number.isInteger(displayDecimals) || displayDecimals < 2 || displayDecimals > 10) {
    throw new Error(`${prefix}_DISPLAY_DECIMALS must be an integer between 2 and 10`)
  }
  if (displayDecimals > decimals) {
    throw new Error(`${prefix}_DISPLAY_DECIMALS cannot exceed the token's ${decimals} decimals`)
  }
  // 偏移步数上限：4 位小数下默认 100 步，即应付金额最多比套餐价多 0.01 USDT。
  const offsetMaxSteps = Number(read('OFFSET_MAX_STEPS', 100))
  if (!Number.isInteger(offsetMaxSteps) || offsetMaxSteps < 2 || offsetMaxSteps > 9999) {
    throw new Error(`${prefix}_OFFSET_MAX_STEPS must be an integer between 2 and 9999`)
  }
  const rpcUrls = String(read('RPC_URL', DEFAULT_RPC_URLS.join(',')))
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^https?:\/\//i.test(value))
  if (!rpcUrls.length) throw new Error(`${prefix}_RPC_URL must contain at least one http(s) URL`)
  const confirmations = Number(read('CONFIRMATIONS', 15))
  if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 500) {
    throw new Error(`${prefix}_CONFIRMATIONS must be an integer between 1 and 500`)
  }
  const pollIntervalMs = Number(read('POLL_INTERVAL_MS', 15_000))
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 3_000 || pollIntervalMs > 600_000) {
    throw new Error(`${prefix}_POLL_INTERVAL_MS must be an integer between 3000 and 600000`)
  }
  // 订单有效期：15 分钟。链上订单共用同一个收款地址，靠金额尾数定位订单，
  // 过期后订单作废（用户不再付款）。
  const orderTtlMs = Number(read('ORDER_TTL_MS', 15 * 60_000))
  if (!Number.isInteger(orderTtlMs) || orderTtlMs < 600_000) {
    throw new Error(`${prefix}_ORDER_TTL_MS must be at least 600000`)
  }
  // 迟到转账的宽限期：订单过期后，在这段窗口内到达的链上转账仍认领回原订单
  // （用户在截止前一刻发起、链上确认较慢的情况）。窗口外才不再认领。
  // 这个窗口同时决定金额尾数被占用的时长：尾数是订单的唯一标识，占用越久，
  // 可用尾数越少（4 位小数 + 100 步只有 90 个可用尾数），所以不宜过长。
  const latePaymentWindowMs = Number(read('LATE_PAYMENT_WINDOW_MS', 6 * 3600_000))
  if (!Number.isInteger(latePaymentWindowMs) || latePaymentWindowMs < 3_600_000 || latePaymentWindowMs > 90 * 24 * 3600_000) {
    throw new Error(`${prefix}_LATE_PAYMENT_WINDOW_MS must be between 3600000 and 7776000000`)
  }
  const lookbackBlocks = Number(read('LOOKBACK_BLOCKS', 200))
  if (!Number.isInteger(lookbackBlocks) || lookbackBlocks < 0 || lookbackBlocks > 100_000) {
    throw new Error(`${prefix}_LOOKBACK_BLOCKS must be between 0 and 100000`)
  }
  return {
    prefix,
    address,
    addressChecksum: toChecksumAddress(address),
    token,
    tokenChecksum: toChecksumAddress(token),
    decimals,
    displayDecimals,
    offsetMaxSteps,
    symbol,
    rpcUrls,
    confirmations,
    pollIntervalMs,
    orderTtlMs,
    latePaymentWindowMs,
    lookbackBlocks,
    chainId: Number(read('CHAIN_ID', 56)),
    /** 链的展示名，前端用来提醒用户「确认网络」。 */
    networkName: String(read('NETWORK_NAME', 'BSC')).trim().slice(0, 24),
  }
}

// ---------------------------------------------------------------------------
// 金额：全部用整数最小单位（BigInt）计算，避免浮点误差。
// ---------------------------------------------------------------------------

/** 把十进制金额字符串转成整数最小单位。 */
export function toUnits(amountText, decimals) {
  const text = String(amountText).trim()
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) throw new Error(`Invalid decimal amount: ${text}`)
  let fraction = match[2] || ''
  if (fraction.length > decimals) {
    // 允许多余的尾零（MySQL DECIMAL(20,8) 会返回 "10.00012300"），但不允许真实精度丢失。
    const extra = fraction.slice(decimals)
    if (!/^0+$/.test(extra)) throw new Error(`Amount ${text} exceeds ${decimals} decimals`)
    fraction = fraction.slice(0, decimals)
  }
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
}

/** 把整数最小单位格式化为十进制字符串（去掉多余的尾零）。 */
export function formatUnits(units, decimals) {
  const value = BigInt(units)
  const negative = value < 0n
  const abs = negative ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  const text = fraction ? `${whole}.${fraction}` : `${whole}`
  return negative ? `-${text}` : text
}

/**
 * 把整数最小单位格式化为**固定展示精度**的十进制字符串（保留尾零）。
 *
 * 应付金额必须原样展示给用户：尾数是订单的唯一标识，尾零被吞掉会让人工核对
 * 变得含糊。数值本身与 formatUnits 完全一致，只是显示形式不同。
 *
 * @param {bigint} units 整数最小单位
 * @param {number} decimals 代币精度
 * @param {number} [displayDecimals] 展示精度，默认与代币精度相同
 */
export function formatUnitsExact(units, decimals, displayDecimals = decimals) {
  const value = BigInt(units)
  const negative = value < 0n
  const abs = negative ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  // 展示精度可能小于代币精度：先截断到展示精度再格式化，尾部补零。
  const fraction = (abs % base).toString().padStart(decimals, '0').slice(0, displayDecimals).padEnd(displayDecimals, '0')
  const text = fraction ? `${whole}.${fraction}` : `${whole}`
  return negative ? `-${text}` : text
}

/**
 * 为订单分配唯一的金额尾数偏移（以最小单位计）。
 *
 * 偏移以 **展示精度**（默认 4 位小数）为粒度，如 10.0123 USDT，保证同地址不同
 * 订单的应付金额互不相同。
 *
 * 两个取舍：
 * - **偏移幅度受限**：maxSteps 限制偏移不超过 maxSteps × 10^-displayDecimals。
 *   4 位小数下默认 100 步，即最多多收 0.01 USDT。若放开到 9999 步，10 USDT 的
 *   套餐可能变成 10.99 USDT，用户会多付近 10%。
 * - **末位不为 0**：应付金额固定 4 位小数展示，末位为 0 会让金额的有效位数变少
 *   （例如 10.0120 显示成 10.012），尾数的辨识度下降。
 *
 * 代价是可用的金额位有限（4 位小数 + 100 步 = 90 个可用偏移），足以覆盖同时
 * 待支付的订单数量；实在不够时可调大 BSC_OFFSET_MAX_STEPS。
 *
 * @param {string} orderId 订单 ID（决定偏移，保证同一订单可重复算出同一结果）
 * @param {Set<string>} takenTotals 已被占用的**完整应付金额**（最小单位字符串）
 * @param {number} decimals 代币精度
 * @param {bigint} baseAmount 套餐价（最小单位）
 * @param {number} [displayDecimals] 展示精度（偏移粒度），默认 4
 * @param {number} [maxSteps] 偏移步数上限，默认 100
 */
export function allocateOffset(orderId, takenTotals, decimals, baseAmount = 0n, displayDecimals = 4, maxSteps = 100) {
  // 偏移以展示精度为粒度：10^(decimals - displayDecimals)。
  const scale = 10n ** BigInt(decimals - displayDecimals)
  const digest = createHash('sha256').update(String(orderId)).digest()
  const taken = takenTotals instanceof Set ? takenTotals : new Set(takenTotals)
  const limit = Math.max(2, Math.min(9999, Math.trunc(maxSteps)))
  // 步进到下一个末位不为 0 的候选偏移（末位为 0 会减少金额的有效小数位）。
  const nextStep = (value) => {
    let candidate = value
    for (let i = 0; i < 10; i++) {
      candidate = (candidate % limit) + 1
      if (candidate % 10 !== 0) return candidate
    }
    return candidate
  }
  let step = nextStep((digest.readUInt32BE(0) % limit) + 1)
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const offset = BigInt(step) * scale
    const total = baseAmount + offset
    if (!taken.has(total.toString())) return offset
    step = nextStep(step)
  }
  throw new Error('Unable to allocate a unique payment offset')
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

function rpcBody(method, params, id) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params })
}

/**
 * 单次 JSON-RPC 调用，失败抛错。
 *
 * `eth_getLogs` 被节点拒绝（区块范围过大 / 日志条数超限）时抛出 RangeError，
 * 与「节点连不上」区分开：前者可以靠缩小查询范围重试，后者只能换节点。
 */
export async function rpcCall(url, method, params, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rpcBody(method, params, 1),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`)
    const payload = await response.json().catch(() => null)
    if (!payload || payload.error) {
      const message = payload?.error?.message || 'unknown'
      // 节点明确表示查询范围/条数超限：可以用更小的分片重试。
      if (/limit exceeded|query returned more than|block range|too many results|response size exceeded|exceed maximum/i.test(message)) {
        throw Object.assign(new Error(`RPC ${method} range rejected: ${message}`), { name: 'RangeError', retryable: false })
      }
      throw new Error(`RPC ${method} failed: ${message}`)
    }
    return payload.result
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 依次尝试各 RPC 地址，直到有一个成功。
 *
 * 只有「节点不可用」的错误才换下一个节点；范围被拒（RangeError）时直接抛出，
 * 由调用方缩小范围分片重试 —— 换节点解决不了范围问题。
 */
export async function rpcWithFallback(config, method, params, options = {}) {
  let lastError = null
  for (const url of config.rpcUrls) {
    try {
      return await rpcCall(url, method, params, options)
    } catch (error) {
      if (error?.name === 'RangeError') throw error
      lastError = error
    }
  }
  throw lastError || new Error(`All RPC endpoints failed for ${method}`)
}

/** 当前链上最新区块号。 */
export async function getBlockNumber(config, options = {}) {
  const result = await rpcWithFallback(config, 'eth_blockNumber', [], options)
  const block = Number(BigInt(result))
  if (!Number.isSafeInteger(block) || block < 0) throw new Error('Invalid block number')
  return block
}

/**
 * 拉取「转出方任意、转入方为收款地址」的代币转账日志。
 *
 * BSC 上 USDT 的交易量极大，公共节点对 `eth_getLogs` 的查询范围有硬限制
 * （返回 `limit exceeded`）。这里按 **自适应分片** 逐段查询：
 * 遇到范围被拒就把区间对半再试，直到单段能过为止。
 *
 * @returns {Promise<Array<{txHash: string, logIndex: number, from: string, to: string, amountUnits: bigint, blockNumber: number}>>}
 */
export async function fetchIncomingTransfers(config, fromBlock, toBlock, options = {}) {
  const topic = '0x' + config.address.replace(/^0x/, '').padStart(64, '0')
  const filter = {
    address: config.token,
    topics: [TRANSFER_TOPIC, null, topic],
  }
  const transfers = []
  let cursor = fromBlock
  while (cursor <= toBlock) {
    let chunkEnd = toBlock
    let logs = null
    // 对半收缩，直到节点接受这个范围为止。
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        logs = await rpcWithFallback(config, 'eth_getLogs', [{
          ...filter,
          fromBlock: `0x${cursor.toString(16)}`,
          toBlock: `0x${chunkEnd.toString(16)}`,
        }], options)
        break
      } catch (error) {
        if (error?.name !== 'RangeError') throw error
        if (cursor === chunkEnd) throw error
        chunkEnd = cursor + Math.floor((chunkEnd - cursor) / 2)
      }
    }
    if (!logs) throw new Error('Failed to fetch transfer logs')
    for (const log of logs) {
      const to = addressFromTopic(log.topics?.[2])
      const from = addressFromTopic(log.topics?.[1])
      if (!to || !from || to !== config.address) continue
      let amountUnits
      try {
        amountUnits = BigInt(log.data && log.data !== '0x' ? log.data : '0x0')
      } catch { continue }
      if (amountUnits <= 0n) continue
      transfers.push({
        txHash: typeof log.transactionHash === 'string' ? log.transactionHash.toLowerCase() : '',
        logIndex: Number(log.logIndex ?? 0),
        from,
        to,
        amountUnits,
        blockNumber: Number(BigInt(log.blockNumber)),
      })
    }
    cursor = chunkEnd + 1
  }
  return transfers.filter((item) => item.txHash && Number.isSafeInteger(item.blockNumber))
}

// ---------------------------------------------------------------------------
// 支付信息与二维码
// ---------------------------------------------------------------------------

/**
 * 构造 EVM 链的支付 URI（EIP-681 / 通用钱包可识别格式）。
 *
 * 形如：
 * `ethereum:0x55d3…7955@56/transfer?address=0x86e5…f65c&uint256=10012300000000000000`
 *
 * - `ethereum:` 是 EVM 钱包通用的 scheme（Metamask、Trust Wallet 等均可识别）；
 * - 合约地址 @ chainId 明确了链，避免用户从以太坊主网打错；
 * - `uint256` 是最小单位整数，避免浮点精度问题。
 *
 * @param {object} config chainConfig 的返回值
 * @param {bigint} amountUnits 应付金额（最小单位）
 */
export function buildPaymentUri(config, amountUnits) {
  const scheme = 'ethereum'
  const token = config.tokenChecksum || config.token
  const recipient = config.addressChecksum || config.address
  const base = `${scheme}:${token}@${config.chainId}/transfer?address=${recipient}`
  return `${base}&uint256=${BigInt(amountUnits).toString()}`
}

/**
 * 生成付款二维码（SVG）。
 *
 * 二维码内容是上面的支付 URI：主流钱包扫码即可预填「代币 / 收款地址 / 金额」，
 * 用户仍需在钱包里确认，不会出现「扫了却转错链」的问题。
 *
 * @param {string} content 二维码内容
 * @param {{width?: number, margin?: number}} [options]
 */
export async function buildQrSvg(content, options = {}) {
  const { default: QRCode } = await import('qrcode')
  return QRCode.toString(content, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: options.margin ?? 1,
    width: options.width ?? 240,
    color: { dark: '#0f172a', light: '#ffffff' },
  })
}
