import express from 'express'
import { maskEmail } from '../referral.js'

/**
 * 推荐系统后台 API。
 *
 * 推荐位（slot）= 首页某个展示区块；推荐条目（item）= 位里的一条剧。
 * 前台首页按 slot 的权重与顺序拉取推荐位，再按条目的权重与顺序取剧。
 */
export async function initRecommendSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recommend_slots (
      id VARCHAR(36) PRIMARY KEY,
      slot_key VARCHAR(64) NOT NULL UNIQUE,
      name VARCHAR(80) NOT NULL,
      description VARCHAR(255) NULL,
      enabled TINYINT NOT NULL DEFAULT 1,
      weight INT NOT NULL DEFAULT 0,
      item_limit INT NOT NULL DEFAULT 10,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recommend_items (
      id VARCHAR(36) PRIMARY KEY,
      slot_id VARCHAR(36) NOT NULL,
      drama_id VARCHAR(128) NOT NULL,
      weight INT NOT NULL DEFAULT 0,
      enabled TINYINT NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE KEY uq_recommend_slot_drama (slot_id, drama_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  for (const sql of [
    'CREATE INDEX idx_recommend_items_slot ON recommend_items(slot_id, enabled, sort_order DESC, weight DESC)',
  ]) {
    try {
      await pool.query(sql)
    } catch (error) {
      if (error?.code !== 'ER_DUP_KEYNAME') throw error
    }
  }
}

/** 预置推荐位：首页已有的分区先落成可配置的推荐位。 */
const DEFAULT_SLOTS = [
  { slotKey: 'home_featured', name: '首页轮播', description: '首页顶部大图轮播', weight: 100, itemLimit: 7 },
  { slotKey: 'home_ranking', name: '热播榜', description: '按播放量排序的热门剧', weight: 90, itemLimit: 15 },
  { slotKey: 'home_latest', name: '最新上架', description: '最近上架的剧', weight: 80, itemLimit: 15 },
  { slotKey: 'home_top_rated', name: '好评推荐', description: '评分最高的剧', weight: 70, itemLimit: 15 },
]

export function createRecommendAdminRouter({ pool, logger = console }) {
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
  const now = () => Date.now()
  const newId = () => `slot-${now()}-${Math.random().toString(36).slice(2, 10)}`

  const router = express.Router()
  const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

  const slotView = (row) => ({
    id: row.id,
    key: row.slot_key,
    name: row.name,
    description: row.description ?? '',
    enabled: Number(row.enabled) === 1,
    weight: Number(row.weight),
    itemLimit: Number(row.item_limit),
    itemCount: Number(row.item_count ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  })

  const itemView = (row) => ({
    id: row.id,
    slotId: row.slot_id,
    dramaId: row.drama_id,
    title: row.title ?? row.drama_id,
    cover: row.cover ?? '',
    weight: Number(row.weight),
    enabled: Number(row.enabled) === 1,
    sortOrder: Number(row.sort_order),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  })

  /** 推荐位列表（含每个位的条目数）。 */
  router.get('/slots', asyncRoute(async (_req, res) => {
    const rows = await queryAll(
      `SELECT s.*, (SELECT COUNT(*) FROM recommend_items i WHERE i.slot_id = s.id) AS item_count
        FROM recommend_slots s ORDER BY s.weight DESC, s.created_at ASC`,
    )
    return res.json({ slots: rows.map(slotView) })
  }))

  /** 新建推荐位。 */
  router.post('/slots', asyncRoute(async (req, res) => {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim().toLowerCase() : ''
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!/^[a-z0-9_-]{2,64}$/.test(key)) return res.status(400).json({ error: '推荐位标识只能是 2–64 位小写字母、数字、下划线或短横线' })
    if (!name || name.length > 80) return res.status(400).json({ error: '推荐位名称不能为空且不超过 80 字' })
    const weight = Number.isInteger(req.body?.weight) ? req.body.weight : 0
    const itemLimit = Number.isInteger(req.body?.itemLimit) ? req.body.itemLimit : 10
    if (itemLimit < 1 || itemLimit > 100) return res.status(400).json({ error: '展示条数必须是 1–100 的整数' })
    const id = newId()
    try {
      await run(
        'INSERT INTO recommend_slots (id, slot_key, name, description, enabled, weight, item_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, key, name, typeof req.body?.description === 'string' ? req.body.description.slice(0, 255) : null,
        req.body?.enabled === false ? 0 : 1, weight, itemLimit, now(), now(),
      )
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '该推荐位标识已存在' })
      throw error
    }
    return res.status(201).json({ slot: slotView(await query('SELECT * FROM recommend_slots WHERE id = ?', id)) })
  }))

  /** 更新推荐位。 */
  router.patch('/slots/:id', asyncRoute(async (req, res) => {
    const slot = await query('SELECT * FROM recommend_slots WHERE id = ?', req.params.id)
    if (!slot) return res.status(404).json({ error: '推荐位不存在' })
    const sets = []
    const args = []
    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      sets.push('name = ?'); args.push(req.body.name.trim().slice(0, 80))
    }
    if (typeof req.body?.description === 'string') {
      sets.push('description = ?'); args.push(req.body.description.slice(0, 255))
    }
    if (typeof req.body?.enabled === 'boolean') { sets.push('enabled = ?'); args.push(req.body.enabled ? 1 : 0) }
    if (Number.isInteger(req.body?.weight)) { sets.push('weight = ?'); args.push(req.body.weight) }
    if (Number.isInteger(req.body?.itemLimit)) {
      if (req.body.itemLimit < 1 || req.body.itemLimit > 100) return res.status(400).json({ error: '展示条数必须是 1–100 的整数' })
      sets.push('item_limit = ?'); args.push(req.body.itemLimit)
    }
    if (!sets.length) return res.status(400).json({ error: '没有需要更新的字段' })
    sets.push('updated_at = ?'); args.push(now())
    await run(`UPDATE recommend_slots SET ${sets.join(', ')} WHERE id = ?`, ...args, slot.id)
    return res.json({ slot: slotView(await query('SELECT * FROM recommend_slots WHERE id = ?', slot.id)) })
  }))

  /** 删除推荐位（条目一并删除）。 */
  router.delete('/slots/:id', asyncRoute(async (req, res) => {
    const slot = await query('SELECT id FROM recommend_slots WHERE id = ?', req.params.id)
    if (!slot) return res.status(404).json({ error: '推荐位不存在' })
    // 没有用外键级联（不同库的外键列可能不兼容），所以显式删条目。
    await run('DELETE FROM recommend_items WHERE slot_id = ?', req.params.id)
    await run('DELETE FROM recommend_slots WHERE id = ?', req.params.id)
    return res.json({ ok: true })
  }))

  /** 某个推荐位下的条目列表。 */
  router.get('/slots/:id/items', asyncRoute(async (req, res) => {
    const slot = await query('SELECT * FROM recommend_slots WHERE id = ?', req.params.id)
    if (!slot) return res.status(404).json({ error: '推荐位不存在' })
    const rows = await queryAll(
      `SELECT i.*, d.title, d.cover FROM recommend_items i
        LEFT JOIN dramas d ON d.id = i.drama_id
        WHERE i.slot_id = ? ORDER BY i.sort_order DESC, i.weight DESC, i.created_at DESC`,
      req.params.id,
    )
    return res.json({ items: rows.map(itemView) })
  }))

  /** 添加推荐条目。 */
  router.post('/slots/:id/items', asyncRoute(async (req, res) => {
    const slot = await query('SELECT * FROM recommend_slots WHERE id = ?', req.params.id)
    if (!slot) return res.status(404).json({ error: '推荐位不存在' })
    const dramaId = typeof req.body?.dramaId === 'string' ? req.body.dramaId.trim() : ''
    if (!dramaId || dramaId.length > 128) return res.status(400).json({ error: '请选择要推荐的剧' })
    const id = `item-${now()}-${Math.random().toString(36).slice(2, 10)}`
    try {
      await run(
        'INSERT INTO recommend_items (id, slot_id, drama_id, weight, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, slot.id, dramaId,
        Number.isInteger(req.body?.weight) ? req.body.weight : 0,
        req.body?.enabled === false ? 0 : 1,
        Number.isInteger(req.body?.sortOrder) ? req.body.sortOrder : 0,
        now(), now(),
      )
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '该剧已在此推荐位中' })
      throw error
    }
    return res.status(201).json({ item: itemView(await query('SELECT i.*, d.title, d.cover FROM recommend_items i LEFT JOIN dramas d ON d.id = i.drama_id WHERE i.id = ?', id)) })
  }))

  /** 更新推荐条目（权重、顺序、启用状态）。 */
  router.patch('/items/:id', asyncRoute(async (req, res) => {
    const item = await query('SELECT * FROM recommend_items WHERE id = ?', req.params.id)
    if (!item) return res.status(404).json({ error: '推荐条目不存在' })
    const sets = []
    const args = []
    if (Number.isInteger(req.body?.weight)) { sets.push('weight = ?'); args.push(req.body.weight) }
    if (Number.isInteger(req.body?.sortOrder)) { sets.push('sort_order = ?'); args.push(req.body.sortOrder) }
    if (typeof req.body?.enabled === 'boolean') { sets.push('enabled = ?'); args.push(req.body.enabled ? 1 : 0) }
    if (!sets.length) return res.status(400).json({ error: '没有需要更新的字段' })
    sets.push('updated_at = ?'); args.push(now())
    await run(`UPDATE recommend_items SET ${sets.join(', ')} WHERE id = ?`, ...args, item.id)
    return res.json({ item: itemView(await query('SELECT i.*, d.title, d.cover FROM recommend_items i LEFT JOIN dramas d ON d.id = i.drama_id WHERE i.id = ?', item.id)) })
  }))

  /** 删除推荐条目。 */
  router.delete('/items/:id', asyncRoute(async (req, res) => {
    const result = await run('DELETE FROM recommend_items WHERE id = ?', req.params.id)
    if (!result.changes) return res.status(404).json({ error: '推荐条目不存在' })
    return res.json({ ok: true })
  }))

  /** 批量调整顺序：传入条目 id 数组，服务端按数组顺序重排 sort_order。 */
  router.post('/items/reorder', asyncRoute(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => typeof id === 'string') : []
    if (!ids.length) return res.status(400).json({ error: '请提供条目 id 数组' })
    for (const [index, id] of ids.entries()) {
      await run('UPDATE recommend_items SET sort_order = ?, updated_at = ? WHERE id = ?', ids.length - index, now(), id)
    }
    return res.json({ ok: true })
  }))

  /** 推荐效果概览：每个位配置了多少条、启用了多少条。 */
  router.get('/overview', asyncRoute(async (_req, res) => {
    const rows = await queryAll(
      `SELECT s.slot_key, s.name, s.enabled, s.weight, s.item_limit,
              COUNT(i.id) AS total_items,
              COALESCE(SUM(CASE WHEN i.enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled_items
        FROM recommend_slots s LEFT JOIN recommend_items i ON i.slot_id = s.id
        GROUP BY s.id ORDER BY s.weight DESC, s.created_at ASC`,
    )
    return res.json({
      overview: rows.map((row) => ({
        key: row.slot_key,
        name: row.name,
        enabled: Number(row.enabled) === 1,
        weight: Number(row.weight),
        itemLimit: Number(row.item_limit),
        totalItems: Number(row.total_items),
        enabledItems: Number(row.enabled_items),
      })),
    })
  }))

  /**
   * 推广码（邀请码）消费统计。
   *
   * 按邀请人聚合其下级（被邀请人）的付费情况：
   *   - 下级人数 = 通过该邀请码绑定的用户数；
   *   - 下级消费 = 这些下级已支付订单的金额合计。
   *
   * 金额分通道统计：USDT 通道（加密货币）取套餐计价 amount_cents，
   * VaeHub 通道（法币）取实收 pay_amount，两者币种不同不能相加。
   * 退款订单不计入消费。
   */
  router.get('/referral-stats', asyncRoute(async (_req, res) => {
    // 汇总：每个邀请人名下下级的付费情况。
    // 订单先按被邀请人聚合再 JOIN，避免一个下级有多笔已支付订单时金额被重复累加。
    const summaryRows = await queryAll(
      `SELECT r.inviter_user_id,
              COUNT(DISTINCT r.invitee_user_id) AS invitee_count,
              COALESCE(SUM(o.paid_order_count), 0) AS paid_order_count,
              COALESCE(SUM(o.usdt_cents), 0) AS usdt_cents,
              COALESCE(SUM(o.fiat_amount), 0) AS fiat_amount,
              MAX(o.last_paid_at) AS last_paid_at
        FROM referral_relations r
        LEFT JOIN (
          SELECT user_id,
                 COUNT(*) AS paid_order_count,
                 COALESCE(SUM(CASE WHEN provider = 'vaehub' THEN 0 ELSE amount_cents END), 0) AS usdt_cents,
                 COALESCE(SUM(CASE WHEN provider = 'vaehub' THEN pay_amount ELSE 0 END), 0) AS fiat_amount,
                 MAX(paid_at) AS last_paid_at
          FROM vip_orders WHERE status = 'paid' GROUP BY user_id
        ) o ON o.user_id = r.invitee_user_id
        GROUP BY r.inviter_user_id`,
    )
    const codeRows = await queryAll(
      `SELECT rc.user_id, rc.code, u.email FROM referral_codes rc
        LEFT JOIN vip_users u ON u.id = rc.user_id`,
    )
    const codeByUser = new Map(codeRows.map((row) => [row.user_id, row]))
    // 汇总每个邀请码下的下级消费明细。
    const detailRows = await queryAll(
      `SELECT r.id, r.code, r.source, r.bound_at,
              iu.email AS inviter_email, eu.email AS invitee_email,
              eu.id AS invitee_user_id,
              eu.vip_expires_at,
              (SELECT COUNT(*) FROM vip_orders o WHERE o.user_id = eu.id AND o.status = 'paid') AS paid_order_count,
              (SELECT COALESCE(SUM(o.amount_cents),0) FROM vip_orders o WHERE o.user_id = eu.id AND o.status = 'paid' AND (o.provider IS NULL OR o.provider <> 'vaehub')) AS usdt_cents,
              (SELECT COALESCE(SUM(o.pay_amount),0) FROM vip_orders o WHERE o.user_id = eu.id AND o.status = 'paid' AND o.provider = 'vaehub') AS fiat_amount,
              (SELECT MAX(o.paid_at) FROM vip_orders o WHERE o.user_id = eu.id AND o.status = 'paid') AS last_paid_at
        FROM referral_relations r
        LEFT JOIN vip_users iu ON iu.id = r.inviter_user_id
        LEFT JOIN vip_users eu ON eu.id = r.invitee_user_id
        ORDER BY r.bound_at DESC`,
    )
    const summaryByUser = new Map(summaryRows.map((row) => [row.inviter_user_id, row]))
    const codes = codeRows.map((row) => {
      const stat = summaryByUser.get(row.user_id)
      return {
        userId: row.user_id,
        code: row.code,
        email: maskEmail(row.email ?? ''),
        inviteeCount: Number(stat?.invitee_count ?? 0),
        paidOrderCount: Number(stat?.paid_order_count ?? 0),
        // USDT 通道：套餐计价，单位 USDT。
        usdtAmount: Number(stat?.usdt_cents ?? 0) / 100,
        // VaeHub 通道：实际收到的法币金额，单位随 pay_currency 而定。
        fiatAmount: Number(stat?.fiat_amount ?? 0),
        lastPaidAt: stat?.last_paid_at ? Number(stat.last_paid_at) : null,
      }
    })
    // 总览：所有邀请码合并起来的口径。
    const totalInvitee = codes.reduce((sum, item) => sum + item.inviteeCount, 0)
    const totalUsdt = codes.reduce((sum, item) => sum + item.usdtAmount, 0)
    const totalFiat = codes.reduce((sum, item) => sum + item.fiatAmount, 0)
    return res.json({
      totals: {
        codes: codes.length,
        invitees: totalInvitee,
        paidOrderCount: codes.reduce((sum, item) => sum + item.paidOrderCount, 0),
        usdtAmount: totalUsdt,
        fiatAmount: totalFiat,
      },
      codes: codes.sort((a, b) => b.inviteeCount - a.inviteeCount || b.usdtAmount - a.usdtAmount),
      details: detailRows.map((row) => ({
        id: row.id,
        code: row.code,
        source: row.source,
        boundAt: Number(row.bound_at),
        inviter: maskEmail(row.inviter_email ?? ''),
        invitee: maskEmail(row.invitee_email ?? ''),
        inviteeUserId: row.invitee_user_id,
        vipActive: Boolean(row.vip_expires_at && Number(row.vip_expires_at) > Date.now()),
        paidOrderCount: Number(row.paid_order_count ?? 0),
        usdtAmount: Number(row.usdt_cents ?? 0) / 100,
        fiatAmount: Number(row.fiat_amount ?? 0),
        lastPaidAt: row.last_paid_at ? Number(row.last_paid_at) : null,
      })),
    })
  }))

  /** 预置推荐位（幂等）。 */
  router.__seedSlots = async () => {
    for (const slot of DEFAULT_SLOTS) {
      const existing = await query('SELECT id FROM recommend_slots WHERE slot_key = ?', slot.slotKey)
      if (existing) continue
      await run(
        'INSERT INTO recommend_slots (id, slot_key, name, description, enabled, weight, item_limit, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)',
        `slot-${slot.slotKey}`, slot.slotKey, slot.name, slot.description, slot.weight, slot.itemLimit, now(), now(),
      )
    }
  }

  router.__logger = logger
  return router
}

/**
 * 前台用的推荐位读取器。
 *
 * 返回 { key, items: [{ dramaId, weight }] }，前台再结合剧库数据渲染。
 */
export function createRecommendReader({ pool }) {
  return async function readSlots() {
    const [slots] = await pool.execute(
      'SELECT id, slot_key, item_limit FROM recommend_slots WHERE enabled = 1 ORDER BY weight DESC, created_at ASC',
    )
    if (!slots.length) return []
    const results = []
    for (const slot of slots) {
      const [items] = await pool.execute(
        'SELECT drama_id, weight FROM recommend_items WHERE slot_id = ? AND enabled = 1 ORDER BY sort_order DESC, weight DESC LIMIT ?',
        [slot.id, Number(slot.item_limit)],
      )
      results.push({
        key: slot.slot_key,
        items: items.map((item) => ({ dramaId: item.drama_id, weight: Number(item.weight) })),
      })
    }
    return results
  }
}
