#!/usr/bin/env node
/**
 * 创建后台管理员账号。
 *
 * 用法：
 *   node --env-file-if-exists=.env scripts/create-admin.mjs --username admin --password 'Strong-Pass-123' --role super
 *   node --env-file-if-exists=.env scripts/create-admin.mjs --username pay --password 'Strong-Pass-123' --role payment
 *   node --env-file-if-exists=.env scripts/create-admin.mjs --username ref --password 'Strong-Pass-123' --role referral
 *
 * 角色：
 *   super    —— 两个后台都能进
 *   payment  —— 只能进支付后台
 *   referral —— 只能进推荐后台
 *
 * 同名账号重复执行不会新建（会提示已存在），避免脚本重跑产生重复账号。
 */
import { createSharedPool, ensureDatabase, mysqlConfig } from '../server/db.js'
import { createAdminUser, initAdminSchema } from '../server/admin/auth.js'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i++
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const username = typeof args.username === 'string' ? args.username : ''
const password = typeof args.password === 'string' ? args.password : ''
const role = typeof args.role === 'string' ? args.role : 'super'
const displayName = typeof args.name === 'string' ? args.name : null

if (!username || !password) {
  console.error('用法：node scripts/create-admin.mjs --username <用户名> --password <密码> [--role super|payment|referral] [--name 显示名]')
  process.exit(1)
}

const config = mysqlConfig(process.env)
await ensureDatabase(config)
const pool = createSharedPool(process.env)
try {
  await initAdminSchema(pool)
  const [existing] = await pool.execute('SELECT id FROM admin_users WHERE username = ?', [username.trim().toLowerCase()])
  if (existing.length) {
    console.log(`管理员 ${username} 已存在，未做任何改动。如需修改密码请手动执行 SQL。`)
    process.exit(0)
  }
  const admin = await createAdminUser(pool, { username, password, role, displayName })
  console.log(`管理员已创建：${admin.username}（角色 ${admin.role}）`)
} catch (error) {
  console.error('创建失败：', error?.message || error)
  process.exit(1)
} finally {
  await pool.end()
}
