import { randomInt } from 'node:crypto'

/** 邀请码字符集：去掉了 0/O/1/I/L 等易混字符，方便口头传播和手动输入。 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LENGTH = 8

/** 邀请关系来源，便于后续区分入口（页面 / 链接 / 后台补录）。 */
export const REFERRAL_SOURCES = ['link', 'code', 'admin']

export async function initReferralSchema(pool) {
  // 每个用户一个邀请码。
  //
  // 这里刻意不建到 vip_users 的外键：vip_users 是会员模块建的表，
  // 不同历史库的 collation 可能与本表不一致，外键会因「列不兼容」直接建表失败，
  // 把整个服务拖垮。改用索引 + 应用层保证，删除用户时由调用方显式清理。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_codes (
      user_id VARCHAR(36) PRIMARY KEY,
      code VARCHAR(16) NOT NULL UNIQUE,
      created_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  // 邀请关系：一个被邀请人只能绑定一个邀请人。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_relations (
      id VARCHAR(36) PRIMARY KEY,
      inviter_user_id VARCHAR(36) NOT NULL,
      invitee_user_id VARCHAR(36) NOT NULL UNIQUE,
      code VARCHAR(16) NOT NULL,
      source VARCHAR(16) NOT NULL,
      bound_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  for (const sql of [
    'CREATE INDEX idx_referral_inviter ON referral_relations(inviter_user_id, bound_at DESC)',
    'CREATE INDEX idx_referral_bound ON referral_relations(bound_at DESC)',
  ]) {
    try {
      await pool.query(sql)
    } catch (error) {
      if (error?.code !== 'ER_DUP_KEYNAME') throw error
    }
  }
}

/** 生成随机邀请码。 */
function randomCode() {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

/** 邀请码格式校验：只允许大写字母与数字，长度固定。 */
export function isValidCode(code) {
  return typeof code === 'string' && /^[A-Z0-9]{6,16}$/.test(code.trim().toUpperCase())
}

/** 邮箱脱敏：a***@example.com —— 列表里不暴露完整邮箱。 */
export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return ''
  const [name, domain] = email.split('@')
  if (!name) return `***@${domain}`
  const head = name.slice(0, 1)
  return `${head}${'*'.repeat(Math.min(3, Math.max(1, name.length - 1)))}@${domain}`
}

/**
 * 邀请服务。
 *
 * 只记录「谁邀请了谁」的关系，不发放任何奖励 —— 奖励规则不在本期范围内。
 */
export function createReferralService({ pool, logger = console, now = Date.now }) {
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

  /**
   * 取用户的邀请码，没有就生成一个。
   *
   * 邀请码唯一索引兜底：并发生成时靠唯一键冲突重试，不会出现两个用户共用一个码。
   */
  const ensureCode = async (userId) => {
    const existing = await query('SELECT code FROM referral_codes WHERE user_id = ?', userId)
    if (existing?.code) return existing.code
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = randomCode()
      try {
        await run('INSERT INTO referral_codes (user_id, code, created_at) VALUES (?, ?, ?)', userId, code, now())
        return code
      } catch (error) {
        if (error?.code !== 'ER_DUP_ENTRY') throw error
      }
    }
    throw Object.assign(new Error('生成邀请码失败，请重试'), { status: 503 })
  }

  /**
   * 绑定邀请关系。
   *
   * 规则：
   *   - 不能邀请自己；
   *   - 一个被邀请人只能有一个邀请人（重复绑定保持原关系，不覆盖）；
   *   - 不能形成环（A 邀 B、B 邀 A 都会被拒绝）。
   */
  const bind = async ({ inviterUserId, inviteeUserId, code, source = 'code' }) => {
    if (!inviterUserId || !inviteeUserId) return { bound: false, reason: 'missing_user' }
    if (inviterUserId === inviteeUserId) return { bound: false, reason: 'self_invite' }
    const normalized = String(code || '').trim().toUpperCase()
    const owner = await query('SELECT user_id FROM referral_codes WHERE code = ?', normalized)
    if (!owner || owner.user_id !== inviterUserId) return { bound: false, reason: 'invalid_code' }
    const existing = await query('SELECT * FROM referral_relations WHERE invitee_user_id = ?', inviteeUserId)
    if (existing) return { bound: false, reason: 'already_bound' }
    // 环检测：邀请人不能已经是自己的下级（否则 A 邀 B、B 又邀 A 会成环）。
    // 两层就够挡住实际会出现的自邀/互邀场景，深层环在绑定顺序上自然被「先绑定者不变」挡住。
    const cycle = await query(
      `SELECT invitee_user_id FROM referral_relations
        WHERE (inviter_user_id = ? AND invitee_user_id = ?)
           OR (inviter_user_id = ? AND invitee_user_id IN (
                SELECT invitee_user_id FROM referral_relations WHERE inviter_user_id = ?
              ))`,
      inviteeUserId, inviterUserId,
      inviteeUserId, inviteeUserId,
    )
    if (cycle) return { bound: false, reason: 'cycle' }
    try {
      await run(
        'INSERT INTO referral_relations (id, inviter_user_id, invitee_user_id, code, source, bound_at) VALUES (?, ?, ?, ?, ?, ?)',
        `ref-${now()}-${Math.random().toString(36).slice(2, 10)}`, inviterUserId, inviteeUserId, normalized, source, now(),
      )
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') return { bound: false, reason: 'already_bound' }
      throw error
    }
    return { bound: true }
  }

  /** 根据邀请码找到邀请人 id。 */
  const inviterOf = async (code) => {
    if (!isValidCode(code)) return null
    const row = await query('SELECT user_id FROM referral_codes WHERE code = ?', String(code).trim().toUpperCase())
    return row?.user_id ?? null
  }

  /**
   * 邀请概览：邀请码、已邀请人数、邀请记录列表、自己的邀请人。
   */
  const overview = async (userId) => {
    const code = await ensureCode(userId)
    const rows = await queryAll(
      `SELECT r.bound_at, r.source, u.email, u.id
        FROM referral_relations r JOIN vip_users u ON u.id = r.invitee_user_id
        WHERE r.inviter_user_id = ? ORDER BY r.bound_at DESC LIMIT 200`,
      userId,
    )
    const inviterRow = await query(
      `SELECT r.code, u.email FROM referral_relations r JOIN vip_users u ON u.id = r.inviter_user_id
        WHERE r.invitee_user_id = ?`,
      userId,
    )
    const totalRow = await query('SELECT COUNT(*) AS total FROM referral_relations WHERE inviter_user_id = ?', userId)
    return {
      code,
      linkPath: `/?ref=${code}`,
      invitedCount: Number(totalRow?.total ?? 0),
      invited: rows.map((row) => ({
        email: maskEmail(row.email),
        boundAt: Number(row.bound_at),
        source: row.source,
      })),
      invitedBy: inviterRow ? { email: maskEmail(inviterRow.email), code: inviterRow.code } : null,
    }
  }

  /** 后台统计：概览 + 明细。 */
  const stats = async () => {
    const totalRow = await query('SELECT COUNT(*) AS total FROM referral_relations')
    const todayRow = await query('SELECT COUNT(*) AS total FROM referral_relations WHERE bound_at >= ?', startOfToday(now()))
    const usersRow = await query('SELECT COUNT(*) AS total FROM referral_codes')
    const topRows = await queryAll(
      `SELECT r.inviter_user_id, u.email, COUNT(*) AS total
        FROM referral_relations r JOIN vip_users u ON u.id = r.inviter_user_id
        GROUP BY r.inviter_user_id, u.email ORDER BY total DESC, u.email LIMIT 20`,
    )
    const recentRows = await queryAll(
      `SELECT r.id, r.code, r.source, r.bound_at, iu.email AS inviter_email, eu.email AS invitee_email
        FROM referral_relations r
        JOIN vip_users iu ON iu.id = r.inviter_user_id
        JOIN vip_users eu ON eu.id = r.invitee_user_id
        ORDER BY r.bound_at DESC LIMIT 200`,
    )
    return {
      total: Number(totalRow?.total ?? 0),
      today: Number(todayRow?.total ?? 0),
      codeUsers: Number(usersRow?.total ?? 0),
      topInviters: topRows.map((row) => ({
        userId: row.inviter_user_id,
        email: maskEmail(row.email),
        count: Number(row.total),
      })),
      relations: recentRows.map((row) => ({
        id: row.id,
        code: row.code,
        source: row.source,
        boundAt: Number(row.bound_at),
        inviter: maskEmail(row.inviter_email),
        invitee: maskEmail(row.invitee_email),
      })),
    }
  }

  /** 后台手工补录 / 解绑邀请关系。 */
  const adminSetRelation = async ({ inviterUserId, inviteeUserId, code, source = 'admin' }) => bind({ inviterUserId, inviteeUserId, code, source })
  const adminDeleteRelation = async (id) => run('DELETE FROM referral_relations WHERE id = ?', id)

  return { ensureCode, bind, inviterOf, overview, stats, adminSetRelation, adminDeleteRelation, __query: query, __queryAll: queryAll, __run: run, __logger: logger }
}

/** 今天的 0 点（本地时区），用于「今日新增」统计。 */
function startOfToday(timestamp) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}
