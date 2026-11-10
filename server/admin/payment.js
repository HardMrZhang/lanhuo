import express from 'express'

/**
 * 支付后台 API。
 *
 * 只读订单与用户数据 + 处理「等待人工核实」的订单。
 * 关键约束：后台永远不直接开通会员 —— 开通会员的唯一入口仍是订单状态机的 markOrderPaid，
 * 后台只能驱动订单状态，避免出现「后台显示已支付但会员没开通」的两套真相。
 */
export function createPaymentAdminRouter({ pool, referralService, logger = console }) {
  const unwrap = (row) => (Array.isArray(row) ? row[0] ?? null : row ?? null)
  const query = async (sql, ...args) => {
    const [rows] = await pool.execute(sql, args)
    return unwrap(rows) ?? null
  }
  const queryAll = async (sql, ...args) => {
    const [rows] = await pool.execute(sql, args)
    return Array.isArray(rows) ? rows : []
  }
  const run = async (sql, ...args) => {
    const [result] = await pool.execute(sql, args)
    return { changes: Number(result?.affectedRows ?? 0) }
  }

  const router = express.Router()
  const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

  /** 订单状态 → 中文标签，前端直接用。 */
  const STATUS_LABELS = {
    creating: '创建中',
    pending: '等待支付',
    confirming: '支付确认中',
    partially_paid: '待补足金额',
    paid: '支付成功',
    failed: '支付失败',
    expired: '已过期作废',
    refunded: '已退款',
    review: '等待人工核实',
  }
  const PROVIDER_LABELS = {
    nowpayments: 'NOWPayments (USDT)',
    vaehub: 'VaeHub (法币)',
    bsc: 'BSC 链自建地址 (USDT)',
    base: 'BSC 链自建地址 (USDT)',
  }

  /**
   * 支付方式分类（后台最关心的维度）。
   *
   * 用户问的「是 USDT 充值的还是 VaeHub」对应两类：
   *   - usdt：加密货币充值（NOWPayments / BSC 链自建地址），计价币种是 USDT；
   *   - vaehub：VaeHub 法币收款（收银台 / 二维码），计价币种是当地法币（USD 等）。
   *
   * 两者金额单位不同，美元与 USDT 不能相加，因此统计按 channel 分开累加，
   * 订单上额外给出 channel / channelLabel / channelKind 供前端打标签。
   */
  const CHANNELS = {
    usdt: { label: 'USDT 充值', short: 'USDT', kind: 'crypto' },
    vaehub: { label: 'VaeHub 法币', short: 'VaeHub', kind: 'fiat' },
  }
  const providerChannel = (provider) => (provider === 'vaehub' ? 'vaehub' : 'usdt')

  /** 通道原始 pay_currency → 人类可读币种（nowpayments 用的是 usdttrc20 这类小写网络标识）。 */
  const currencyLabel = (value) => {
    if (!value) return null
    const text = String(value).trim()
    if (!text) return null
    if (/^usdt/i.test(text)) return 'USDT'
    if (/^usd/i.test(text)) return 'USD'
    if (/^sgd/i.test(text)) return 'SGD'
    if (/^myr/i.test(text)) return 'MYR'
    if (/^php/i.test(text)) return 'PHP'
    if (/^idr/i.test(text)) return 'IDR'
    if (/^thb/i.test(text)) return 'THB'
    if (/^vnd/i.test(text)) return 'VND'
    return text.toUpperCase()
  }

  const orderRow = (row) => {
    const provider = row.provider ?? null
    const channel = providerChannel(provider)
    return {
      id: row.id,
      userId: row.user_id,
      email: row.email ?? null,
      planId: row.plan_id,
      planName: row.plan_name,
      days: Number(row.days),
      amount: Number(row.amount_cents) / 100,
      currency: 'USDT',
      status: row.status,
      statusLabel: STATUS_LABELS[row.status] ?? row.status,
      provider,
      providerLabel: PROVIDER_LABELS[provider] ?? provider ?? '-',
      // 通道分类：usdt（加密货币）/ vaehub（法币）。
      channel,
      channelLabel: CHANNELS[channel].label,
      channelKind: CHANNELS[channel].kind,
      payAmount: row.pay_amount === null || row.pay_amount === undefined ? null : Number(row.pay_amount),
      payCurrency: currencyLabel(row.pay_currency),
      // 链上通道的应付金额精确文本（尾数是订单标识，不能被 number 抹掉）。
      payAmountText: row.pay_amount_text ?? null,
      payAddress: row.pay_address ?? null,
      txHash: row.tx_hash ?? null,
      reviewReason: row.review_reason ?? null,
      checkoutUrl: row.checkout_url ?? null,
      invoiceId: row.invoice_id ?? null,
      paymentId: row.payment_id ?? null,
      createdAt: Number(row.created_at),
      paidAt: row.paid_at === null || row.paid_at === undefined ? null : Number(row.paid_at),
      refundedAt: row.refunded_at === null || row.refunded_at === undefined ? null : Number(row.refunded_at),
      expiresAt: row.payment_expires_at ?? null,
    }
  }

  /** 订单列表：支持状态、通道、关键词与分页筛选。 */
  router.get('/orders', asyncRoute(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20))
    const status = typeof req.query.status === 'string' && STATUS_LABELS[req.query.status] ? req.query.status : null
    const provider = typeof req.query.provider === 'string' && PROVIDER_LABELS[req.query.provider] ? req.query.provider : null
    // 通道筛选：USDT（加密货币）还是 VaeHub（法币）。
    const channel = typeof req.query.channel === 'string' && CHANNELS[req.query.channel] ? req.query.channel : null
    const keyword = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const where = []
    const args = []
    if (status) { where.push('o.status = ?'); args.push(status) }
    if (provider) { where.push('o.provider = ?'); args.push(provider) }
    if (channel === 'vaehub') { where.push("o.provider = 'vaehub'") }
    else if (channel === 'usdt') { where.push("(o.provider IS NULL OR o.provider <> 'vaehub')") }
    if (keyword) {
      where.push('(o.id = ? OR u.email LIKE ? OR o.invoice_id = ? OR o.payment_id = ? OR o.tx_hash = ?)')
      args.push(keyword, `%${keyword}%`, keyword, keyword, keyword)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const totalRow = await query(
      `SELECT COUNT(*) AS total FROM vip_orders o LEFT JOIN vip_users u ON u.id = o.user_id ${clause}`,
      ...args,
    )
    const rows = await queryAll(
      `SELECT o.*, u.email FROM vip_orders o LEFT JOIN vip_users u ON u.id = o.user_id
        ${clause} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
      ...args, pageSize, (page - 1) * pageSize,
    )
    return res.json({
      orders: rows.map(orderRow),
      total: Number(totalRow?.total ?? 0),
      page,
      pageSize,
    })
  }))

  /** 单个订单详情。 */
  router.get('/orders/:id', asyncRoute(async (req, res) => {
    const row = await query(
      `SELECT o.*, u.email FROM vip_orders o LEFT JOIN vip_users u ON u.id = o.user_id WHERE o.id = ?`,
      req.params.id,
    )
    if (!row) return res.status(404).json({ error: '订单不存在' })
    return res.json({ order: orderRow(row) })
  }))

  /**
   * 订单统计：总览 + 按状态分布 + 按通道分布 + 近 30 天趋势。
   */
  router.get('/stats', asyncRoute(async (_req, res) => {
    const totalRow = await query('SELECT COUNT(*) AS total FROM vip_orders')
    const paidRow = await query("SELECT COUNT(*) AS total FROM vip_orders WHERE status = 'paid'")
    const revenueRow = await query("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM vip_orders WHERE status = 'paid'")
    const reviewRow = await query("SELECT COUNT(*) AS total FROM vip_orders WHERE status = 'review'")
    const pendingRow = await query("SELECT COUNT(*) AS total FROM vip_orders WHERE status IN ('creating','pending','confirming','partially_paid')")
    const membersRow = await query('SELECT COUNT(*) AS total FROM vip_users WHERE vip_expires_at > ?', Date.now())
    const statusRows = await queryAll('SELECT status, COUNT(*) AS total FROM vip_orders GROUP BY status')
    const providerRows = await queryAll('SELECT provider, COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = \'paid\' THEN amount_cents ELSE 0 END), 0) AS revenue FROM vip_orders GROUP BY provider')
    // 按通道（USDT 加密货币 / VaeHub 法币）分组统计。
    // 法币通道的收入取 pay_amount（真实收到的法币金额），USDT 通道取 amount_cents。
    const channelRows = await queryAll(
      `SELECT IF(provider = 'vaehub', 'vaehub', 'usdt') AS channel,
              COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END), 0) AS revenue,
              COALESCE(SUM(CASE WHEN status = 'paid' AND provider = 'vaehub' THEN pay_amount ELSE 0 END), 0) AS fiat_revenue,
              MAX(pay_currency) AS pay_currency
        FROM vip_orders GROUP BY channel`,
    )
    const dailyRows = await queryAll(
      `SELECT DATE(FROM_UNIXTIME(created_at / 1000)) AS day, COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END), 0) AS revenue,
              COALESCE(SUM(CASE WHEN status = 'paid' AND provider = 'vaehub' THEN pay_amount ELSE 0 END), 0) AS fiat_revenue,
              COALESCE(SUM(CASE WHEN status = 'paid' AND provider <> 'vaehub' THEN 1 ELSE 0 END), 0) AS usdt_paid,
              COALESCE(SUM(CASE WHEN status = 'paid' AND provider = 'vaehub' THEN 1 ELSE 0 END), 0) AS vaehub_paid
        FROM vip_orders WHERE created_at >= ? GROUP BY day ORDER BY day`,
      Date.now() - 30 * 86400_000,
    )
    const days = []
    for (let i = 29; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86400_000)
      const key = date.toISOString().slice(0, 10)
      const found = dailyRows.find((row) => String(row.day) === key)
      days.push({
        day: key,
        orders: Number(found?.total ?? 0),
        revenue: Number(found?.revenue ?? 0) / 100,
        usdtPaid: Number(found?.usdt_paid ?? 0),
        vaehubPaid: Number(found?.vaehub_paid ?? 0),
      })
    }
    // 通道维度的小结：USDT 通道收入单位是 USDT，VaeHub 通道收入单位是法币，两者分开展示。
    const byChannel = Object.keys(CHANNELS).map((key) => {
      const row = channelRows.find((item) => item.channel === key)
      const meta = CHANNELS[key]
      const isFiat = key === 'vaehub'
      return {
        channel: key,
        label: meta.label,
        short: meta.short,
        kind: meta.kind,
        count: Number(row?.total ?? 0),
        // USDT 通道：套餐计价（USDT）；VaeHub 通道：实际收取的法币金额。
        revenue: isFiat ? Number(row?.fiat_revenue ?? 0) : Number(row?.revenue ?? 0) / 100,
        revenueCurrency: isFiat ? (currencyLabel(row?.pay_currency) ?? 'USD') : 'USDT',
        // 套餐计价总和（统一 USDT），方便横向对比「卖出去多少额度」。
        planRevenue: Number(row?.revenue ?? 0) / 100,
      }
    })
    return res.json({
      totals: {
        orders: Number(totalRow?.total ?? 0),
        paid: Number(paidRow?.total ?? 0),
        revenue: Number(revenueRow?.total ?? 0) / 100,
        review: Number(reviewRow?.total ?? 0),
        pending: Number(pendingRow?.total ?? 0),
        members: Number(membersRow?.total ?? 0),
      },
      byStatus: statusRows.map((row) => ({ status: row.status, label: STATUS_LABELS[row.status] ?? row.status, count: Number(row.total) })),
      byProvider: providerRows.map((row) => ({
        provider: row.provider ?? '-',
        label: PROVIDER_LABELS[row.provider] ?? row.provider ?? '-',
        channel: providerChannel(row.provider),
        count: Number(row.total),
        revenue: Number(row.revenue) / 100,
      })),
      byChannel,
      daily: days,
    })
  }))

  /**
   * 人工核实队列：只列出「等待人工核实」的订单。
   * 后台在这里能看到渠道回调说不清、金额对不上这类需要人工处理的单子。
   */
  router.get('/review', asyncRoute(async (_req, res) => {
    const rows = await queryAll(
      `SELECT o.*, u.email FROM vip_orders o LEFT JOIN vip_users u ON u.id = o.user_id
        WHERE o.status = 'review' ORDER BY o.created_at ASC LIMIT 200`,
    )
    return res.json({ orders: rows.map(orderRow) })
  }))

  /**
   * 人工核实结论。
   *
   * 两种动作：
   *   - confirm：确认已收到钱。走订单状态机的合法迁移（review → paid），
   *     并调用与支付回调完全相同的开通逻辑，保证时长账本只有一处实现。
   *   - reject：确认没收到钱。review → failed。
   *
   * 两种都走 markOrderPaid / 状态机，不会绕过订单状态直接改会员表。
   */
  router.post('/orders/:id/review', asyncRoute(async (req, res) => {
    const action = req.body?.action
    if (action !== 'confirm' && action !== 'reject') {
      return res.status(400).json({ error: '请选择核实结论' })
    }
    const order = await query('SELECT * FROM vip_orders WHERE id = ?', req.params.id)
    if (!order) return res.status(404).json({ error: '订单不存在' })
    if (order.status !== 'review') {
      return res.status(409).json({ error: `订单当前状态为「${STATUS_LABELS[order.status] ?? order.status}」，不在人工核实队列中` })
    }
    if (action === 'reject') {
      const result = await run(
        "UPDATE vip_orders SET status = 'failed', review_reason = ? WHERE id = ? AND status = 'review' AND paid_at IS NULL AND refunded_at IS NULL",
        'manual_review_rejected', order.id,
      )
      if (!result.changes) return res.status(409).json({ error: '订单状态已变化，请刷新后重试' })
      return res.json({ ok: true, status: 'failed' })
    }
    // 确认到账：复用会员时长账本（markOrderPaid 语义）。
    const granted = await markOrderPaid(order.id)
    if (!granted) return res.status(409).json({ error: '订单状态已变化，请刷新后重试' })
    return res.json({ ok: true, status: 'paid' })
  }))

  /** 会员用户列表：用于核对某个用户的会员状态与订单。 */
  router.get('/users', asyncRoute(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20))
    const keyword = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const where = []
    const args = []
    if (keyword) { where.push('(u.email LIKE ? OR u.id = ?)'); args.push(`%${keyword}%`, keyword) }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const totalRow = await query(`SELECT COUNT(*) AS total FROM vip_users u ${clause}`, ...args)
    const rows = await queryAll(
      `SELECT u.id, u.email, u.vip_expires_at, u.email_verified, u.created_at,
              (SELECT COUNT(*) FROM vip_orders o WHERE o.user_id = u.id) AS order_count,
              (SELECT COALESCE(SUM(amount_cents),0) FROM vip_orders o WHERE o.user_id = u.id AND o.status = 'paid') AS paid_cents,
              (SELECT COALESCE(SUM(o.pay_amount),0) FROM vip_orders o WHERE o.user_id = u.id AND o.status = 'paid' AND o.provider = 'vaehub') AS vaehub_fiat,
              (SELECT COUNT(*) FROM vip_orders o WHERE o.user_id = u.id AND o.status = 'paid' AND o.provider = 'vaehub') AS vaehub_count,
              (SELECT COUNT(*) FROM vip_orders o WHERE o.user_id = u.id AND o.status = 'paid' AND (o.provider IS NULL OR o.provider <> 'vaehub')) AS usdt_count
        FROM vip_users u ${clause} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      ...args, pageSize, (page - 1) * pageSize,
    )
    return res.json({
      users: rows.map((row) => ({
        id: row.id,
        email: row.email,
        vipActive: Boolean(row.vip_expires_at && Number(row.vip_expires_at) > Date.now()),
        vipExpiresAt: row.vip_expires_at === null || row.vip_expires_at === undefined ? null : Number(row.vip_expires_at),
        emailVerified: Number(row.email_verified) === 1,
        createdAt: Number(row.created_at),
        orderCount: Number(row.order_count),
        paidAmount: Number(row.paid_cents) / 100,
        // 分通道累计：USDT（加密货币）与 VaeHub（法币）分开统计。
        usdtPaidCount: Number(row.usdt_count),
        vaehubPaidCount: Number(row.vaehub_count),
        vaehubPaidFiat: Number(row.vaehub_fiat ?? 0),
      })),
      total: Number(totalRow?.total ?? 0),
      page,
      pageSize,
    })
  }))

  /**
   * 开通会员（后台手动补单）。
   *
   * 走与支付回调相同的时长账本：从当前有效期末尾累加。
   * 记录操作人，便于审计。
   */
  router.post('/users/:id/grant', asyncRoute(async (req, res) => {
    const days = Number(req.body?.days)
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return res.status(400).json({ error: '会员天数必须是 1–3650 的整数' })
    }
    const user = await query('SELECT * FROM vip_users WHERE id = ?', req.params.id)
    if (!user) return res.status(404).json({ error: '用户不存在' })
    const expiresAt = Math.max(Date.now(), Number(user.vip_expires_at) || 0) + days * 86400_000
    await run('UPDATE vip_users SET vip_expires_at = ? WHERE id = ?', expiresAt, user.id)
    logger.log(`[admin] 手动开通会员：用户 ${user.id} 加 ${days} 天，由 ${req.admin?.username || 'unknown'} 操作`)
    return res.json({ ok: true, vipExpiresAt: expiresAt })
  }))

  /** 邀请模块概览：支付后台顺带能看到推荐数据。 */
  router.get('/referral', asyncRoute(async (_req, res) => {
    const stats = await referralService.stats()
    return res.json(stats)
  }))

  /**
   * 开通会员的账本逻辑（与 server/vip.js 的 markOrderPaid 语义一致）。
   *
   * 单独实现而不是跨文件 import，是为了避免后台为了复用几行逻辑就把
   * 整个 vip.js（含定时器、支付通道）拖进来。
   */
  async function markOrderPaid(orderId) {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const [orderRows] = await conn.execute('SELECT * FROM vip_orders WHERE id = ? FOR UPDATE', [orderId])
      const order = orderRows[0]
      if (!order) { await conn.rollback(); return false }
      if (order.paid_at !== null) { await conn.rollback(); return false }
      if (order.refunded_at !== null) { await conn.rollback(); return false }
      const [userRows] = await conn.execute('SELECT * FROM vip_users WHERE id = ? FOR UPDATE', [order.user_id])
      const user = userRows[0]
      if (!user) { await conn.rollback(); return false }
      const expiresAt = Math.max(Date.now(), Number(user.vip_expires_at) || 0) + Number(order.days) * 86400_000
      await conn.execute('UPDATE vip_users SET vip_expires_at = ? WHERE id = ?', [expiresAt, user.id])
      await conn.execute(
        "UPDATE vip_orders SET status = 'paid', paid_at = ?, review_reason = NULL WHERE id = ? AND paid_at IS NULL AND refunded_at IS NULL",
        [Date.now(), order.id],
      )
      await conn.commit()
      return true
    } catch (error) {
      try { await conn.rollback() } catch { /* ignore */ }
      throw error
    } finally {
      conn.release()
    }
  }

  router.__statusLabels = STATUS_LABELS
  router.__providerLabels = PROVIDER_LABELS
  router.__channelLabels = CHANNELS
  return router
}
