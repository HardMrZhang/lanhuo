import express from 'express'
import { isValidCode } from './referral.js'

/**
 * 面向用户的邀请接口（挂在 /api/referral）。
 *
 * 只记录关系，不发放奖励。
 */
export function createReferralRouter({ referralService, logger = console }) {
  const router = express.Router()
  const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

  /** 当前登录用户的邀请概览：邀请码、邀请记录。 */
  router.get('/overview', asyncRoute(async (req, res) => {
    if (!req.vipUser) return res.status(401).json({ error: '请先登录' })
    const overview = await referralService.overview(req.vipUser.id)
    return res.json(overview)
  }))

  /**
   * 提交邀请码，绑定邀请关系。
   *
   * 绑定发生在「用户带着邀请码注册/登录」时：前端把邀请码存在本地，
   * 注册成功后调这个接口把关系落到服务端。
   */
  router.post('/bind', asyncRoute(async (req, res) => {
    if (!req.vipUser) return res.status(401).json({ error: '请先登录' })
    const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : ''
    if (!isValidCode(code)) return res.status(400).json({ error: '邀请码格式不正确' })
    const inviterUserId = await referralService.inviterOf(code)
    if (!inviterUserId) return res.status(404).json({ error: '邀请码不存在' })
    const result = await referralService.bind({
      inviterUserId,
      inviteeUserId: req.vipUser.id,
      code,
      source: 'code',
    })
    if (result.bound) return res.json({ bound: true })
    if (result.reason === 'self_invite') return res.status(400).json({ error: '不能使用自己的邀请码' })
    if (result.reason === 'already_bound') return res.status(409).json({ error: '该账号已绑定过邀请码' })
    if (result.reason === 'cycle') return res.status(400).json({ error: '该邀请码不能与你的邀请关系形成循环' })
    return res.status(400).json({ error: '绑定失败，请稍后重试' })
  }))

  /**
   * 通过邀请链接（?ref=CODE）绑定。
   *
   * 与手动输入邀请码走同一条逻辑，只是多了一步「链接里的码也要匹配邀请人本人」，
   * 防止有人拿别人的码冒领。
   */
  router.post('/bind-link', asyncRoute(async (req, res) => {
    if (!req.vipUser) return res.status(401).json({ error: '请先登录' })
    const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : ''
    if (!isValidCode(code)) return res.status(400).json({ error: '邀请码格式不正确' })
    const inviterUserId = await referralService.inviterOf(code)
    if (!inviterUserId) return res.status(404).json({ error: '邀请码不存在' })
    const result = await referralService.bind({
      inviterUserId,
      inviteeUserId: req.vipUser.id,
      code,
      source: 'link',
    })
    return res.json({ bound: result.bound, reason: result.bound ? null : result.reason })
  }))

  router.__logger = logger
  return router
}
