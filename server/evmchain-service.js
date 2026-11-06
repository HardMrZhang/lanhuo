/**
 * EVM 链固定收款地址的订单分配与到账扫描服务（BSC / Base / …）。
 *
 * 关键设计（地址共用场景下的订单归属）：
 * - 每笔订单分配一个唯一的金额尾数偏移（allocateOffset），例如 10.0123 USDT。
 *   链上转账金额唯一确定订单，用户既不需要填备注，也不需要提供 TxHash。
 * - 扫描器记录已消费过的 (txHash, logIndex)，同一笔转账不会被两个订单重复认领。
 * - 只有金额精确匹配的转账才会开通会员；金额不符进人工核对。
 *
 * 状态全部落在数据库（vip_orders.pay_amount / tx_hash），进程重启后重建，
 * 因此这里的内存状态只是缓存，不是唯一真相。
 */
import {
  allocateOffset, chainConfig, fetchIncomingTransfers, formatUnits, getBlockNumber, toUnits,
} from './evmchain.js'

/** 金额匹配的容差：只允许最小单位级别的误差，不允许少付。 */
const AMOUNT_TOLERANCE_UNITS = 1n

export function createChainService({ env = process.env, prefix = 'BSC', fetchImpl = globalThis.fetch, logger = console, now = Date.now } = {}) {
  const config = chainConfig(env, prefix)
  if (!config) return null

  const state = {
    /** 已认领的转账指纹 -> 订单 ID，防止同一笔转账被重复使用。 */
    claimed: new Map(),
    /** 确认数还不够的转账，等后续扫描凑够确认数再兑现。 */
    pendingConfirmations: new Map(),
    /** 已扫过的最高区块，null 表示还没扫过。 */
    scannedToBlock: null,
    lastError: null,
    lastScanAt: null,
    /** 扫描器注入的订单查询接口（由 vip.js 提供，避免此处反向依赖数据库层）。 */
    listOpenOrders: async () => [],
  }

  /**
   * 给订单分配唯一的应付金额（套餐价 + 唯一尾数偏移）。
   * @param {{id: string, amount_cents: number}} order
   * @param {Set<string>} takenTotals 其他未完成订单已占用的完整应付金额（最小单位字符串）
   */
  async function allocateForOrder(order, takenTotals = new Set()) {
    const base = toUnits((order.amount_cents / 100).toFixed(config.decimals), config.decimals)
    const offset = allocateOffset(order.id, takenTotals, config.decimals, base, config.displayDecimals, config.offsetMaxSteps)
    return base + offset
  }

  /**
   * 扫描链上到账，把匹配的订单标记为 paid。
   * @param {(orderId: string, info: {txHash: string, amountUnits: bigint, blockNumber: number}) => Promise<void>} onPaid
   * @param {(orderId: string, info: {txHash: string, receivedUnits: bigint, expectedUnits: bigint}) => Promise<void>} onMismatch
   */
  async function scan(onPaid, onMismatch) {
    const latest = await getBlockNumber(config, { fetchImpl })
    const from = state.scannedToBlock === null
      ? Math.max(0, latest - config.lookbackBlocks)
      : state.scannedToBlock + 1
    if (from > latest) {
      state.lastScanAt = now()
      return { latest, scanned: 0, matched: 0 }
    }
    const transfers = await fetchIncomingTransfers(config, from, latest, { fetchImpl })
    state.scannedToBlock = latest
    state.lastScanAt = now()
    // 待认领的订单：状态为 pending 的该链订单，按应付金额索引。
    const openOrders = await state.listOpenOrders()
    const byAmount = new Map()
    for (const order of openOrders) {
      if (order.pay_amount === null || order.pay_amount === undefined) continue
      let units
      try {
        units = toUnits(String(order.pay_amount), config.decimals)
      } catch { continue }
      if (!byAmount.has(units.toString())) byAmount.set(units.toString(), order)
    }
    // 先把本轮新发现的转账并入待确认队列（按指纹去重）。
    for (const transfer of transfers) {
      const fingerprint = `${transfer.txHash}:${transfer.logIndex}`
      if (state.claimed.has(fingerprint)) continue
      if (!state.pendingConfirmations.has(fingerprint)) state.pendingConfirmations.set(fingerprint, transfer)
    }
    let matched = 0
    // 逐笔处理待确认队列：确认数够了才兑现，未够则留到下一轮。
    for (const [fingerprint, transfer] of state.pendingConfirmations) {
      if (latest - transfer.blockNumber < config.confirmations) continue
      const order = byAmount.get(transfer.amountUnits.toString())
      // 找不到对应订单（订单已过期/已关闭）时丢弃这笔转账。
      if (!order) { state.pendingConfirmations.delete(fingerprint); continue }
      state.pendingConfirmations.delete(fingerprint)
      state.claimed.set(fingerprint, order.id)
      const expectedUnits = toUnits(String(order.pay_amount), config.decimals)
      const difference = transfer.amountUnits - expectedUnits
      if (difference >= -AMOUNT_TOLERANCE_UNITS && difference <= AMOUNT_TOLERANCE_UNITS) {
        matched++
        await onPaid(order.id, {
          txHash: transfer.txHash,
          amountUnits: transfer.amountUnits,
          blockNumber: transfer.blockNumber,
        })
      } else {
        await onMismatch(order.id, {
          txHash: transfer.txHash,
          receivedUnits: transfer.amountUnits,
          expectedUnits,
        })
      }
    }
    return { latest, scanned: transfers.length, matched }
  }

  return {
    config,
    allocateForOrder,
    scan,
    /** 由 vip.js 注入「查询待认领订单」的实现。 */
    setOrderSource(fn) { state.listOpenOrders = fn },
    get status() {
      return {
        scannedToBlock: state.scannedToBlock,
        lastScanAt: state.lastScanAt,
        lastError: state.lastError,
        claimedCount: state.claimed.size,
      }
    },
    /** 供测试重置内部状态。 */
    _reset() {
      state.claimed.clear()
      state.pendingConfirmations.clear()
      state.scannedToBlock = null
      state.lastError = null
    },
    _state: state,
  }
}

export { formatUnits }
