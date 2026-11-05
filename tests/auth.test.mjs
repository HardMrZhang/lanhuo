import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { createVipRouter } from '../server/vip.js'
import { createCaptchaChallenge, normalizeCaptcha } from '../server/captcha.js'

const ORIGIN = 'https://auth.example.test'
const TEST_CAPTCHA = { enabled: true, issue: () => ({ text: 'TESTCAPTCHA', svg: '<svg/>' }) }
const CAPTCHA_BODY = { captchaId: 'test-captcha', captchaText: 'TESTCAPTCHA' }

/** 收集邮件的假 mailer：记录每封邮件，便于断言链接内容。 */
function fakeMailer({ enabled = true } = {}) {
  const sent = []
  return {
    enabled,
    sent,
    send: async (message) => {
      sent.push(message)
      return { sent: true }
    },
  }
}

async function fixture(t, overrides = {}) {
  const dbSuffix = randomUUID().replace(/-/g, '').slice(0, 12)
  let timestamp = Date.parse('2026-09-18T08:00:00.000Z')
  const mail = overrides.mail ?? fakeMailer()
  const env = {
    NODE_ENV: 'test', APP_URL: ORIGIN,
    NOWPAYMENTS_API_KEY: 'test-key', NOWPAYMENTS_IPN_SECRET: 'test-secret',
    MYSQL_HOST: process.env.MYSQL_HOST || '127.0.0.1',
    MYSQL_PORT: process.env.MYSQL_PORT || '3306',
    MYSQL_USER: process.env.MYSQL_USER || 'root',
    MYSQL_PASSWORD: process.env.MYSQL_PASSWORD ?? '123456',
    MYSQL_DATABASE: `duanju_test_auth_${dbSuffix}`,
    ...overrides.env,
  }
  const router = await createVipRouter({
    env,
    now: () => timestamp,
    mail,
    captcha: overrides.captcha ?? TEST_CAPTCHA,
    fetchImpl: overrides.fetchImpl ?? (async (url, options) => {
      const body = JSON.parse(options.body)
      return new Response(JSON.stringify({
        payment_id: String(9100 + Math.floor(timestamp / 1000) % 1000),
        payment_status: 'waiting',
        pay_address: 'T' + '1'.repeat(33),
        pay_amount: body.pay_amount,
        pay_currency: body.pay_currency,
        price_amount: body.price_amount,
        price_currency: body.price_currency,
        order_id: body.order_id,
      }), { status: 201 })
    }),
    logger: { error() {}, warn() {} },
  })
  const app = express()
  app.use('/api', router)
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await router.close?.()
  })
  const base = `http://127.0.0.1:${server.address().port}/api`
  async function request(route, { method = 'GET', cookie, body, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method,
      headers: {
        Origin: ORIGIN,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* OAuth 回调返回跳转或 HTML */ }
    return { status: response.status, body: json, text, headers: response.headers }
  }
  async function captchaBody() {
    const res = await request('/auth/captcha')
    assert.equal(res.status, 200)
    return { captchaId: res.body.id, captchaText: 'TESTCAPTCHA' }
  }
  async function register(email = `${randomUUID()}@example.test`) {
    const res = await request('/auth/register', { method: 'POST', body: { email, password: 'Correct-Horse-972!', ...(await captchaBody()) } })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    return { cookie: res.headers.get('set-cookie').split(';')[0], user: res.body.user, email, body: res.body }
  }
  /** 从邮件正文里取出 /verify-email?token=... 或 /reset-password?token=... 的 token。 */
  function tokenFromMail(mailMessage, kind) {
    const match = mailMessage.text.match(new RegExp(`${kind}\\?token=([a-f0-9]{64})`))
    assert.ok(match, `no ${kind} token in mail body`)
    return match[1]
  }
  /** 从响应头里挑出指定名称的 cookie（一个响应可能带多个 set-cookie）。 */
  function cookieFrom(res, name) {
    const all = res.headers.getSetCookie?.() ?? []
    const found = all.find((entry) => entry.startsWith(`${name}=`))
    assert.ok(found, `no ${name} cookie in response`)
    return found.split(';')[0]
  }
  /** 从响应头里挑出指定名称的 cookie（一个响应可能带多个 set-cookie）。 */
  function cookieFrom(res, name) {
    const all = res.headers.getSetCookie?.() ?? []
    const found = all.find((entry) => entry.startsWith(`${name}=`))
    assert.ok(found, `no ${name} cookie in response`)
    return found.split(';')[0]
  }
  return { request, register, captchaBody, mail, tokenFromMail, cookieFrom, setTime: (value) => { timestamp = value } }
}

test('captcha challenge answers are normalized and rendered as svg', () => {
  const challenge = createCaptchaChallenge()
  assert.equal(challenge.text.length, 4)
  assert.match(challenge.svg, /^<svg /)
  assert.equal(normalizeCaptcha(` ${challenge.text.toLowerCase()} `), challenge.text)
})

test('registration requires a valid captcha and rejects reuse of a consumed one', async (t) => {
  const f = await fixture(t)
  const missing = await f.request('/auth/register', { method: 'POST', body: { email: `${randomUUID()}@example.test`, password: 'Correct-Horse-972!' } })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error, '请完成图形验证码')

  const captcha = await f.captchaBody()
  const wrong = await f.request('/auth/register', { method: 'POST', body: { email: `${randomUUID()}@example.test`, password: 'Correct-Horse-972!', captchaId: captcha.captchaId, captchaText: 'WRONG1' } })
  assert.equal(wrong.status, 400)

  // 同一个 captchaId 只能消费一次。
  const reused = await f.request('/auth/register', { method: 'POST', body: { email: `${randomUUID()}@example.test`, password: 'Correct-Horse-972!', ...captcha } })
  assert.equal(reused.status, 400)
})

test('a fresh captcha lets registration succeed and the account starts unverified', async (t) => {
  const f = await fixture(t)
  const { body } = await f.register()
  assert.equal(body.user.emailVerified, false)
  assert.equal(body.needsVerification, true)
  assert.equal(body.verificationSent, true)
  assert.equal(f.mail.sent.length, 1)
  assert.match(f.mail.sent[0].to, /@/)
  assert.match(f.mail.sent[0].text, /verify-email\?token=/)
})

test('email verification activates the account exactly once', async (t) => {
  const f = await fixture(t)
  const { cookie } = await f.register()
  const token = f.tokenFromMail(f.mail.sent[0], 'verify-email')

  const verified = await f.request('/auth/verify-email', { method: 'POST', body: { token } })
  assert.equal(verified.status, 200)
  assert.equal(verified.body.verified, true)
  assert.equal((await f.request('/auth/me', { cookie })).body.user.emailVerified, true)

  // 同一个 token 不能重复使用。
  const again = await f.request('/auth/verify-email', { method: 'POST', body: { token } })
  assert.equal(again.status, 400)
  assert.equal(again.body.error, '验证链接无效或已过期')
})

test('an unverified account cannot create a membership order', async (t) => {
  const f = await fixture(t)
  const { cookie } = await f.register()
  const order = await f.request('/vip/orders', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month' },
  })
  assert.equal(order.status, 403)
  assert.equal(order.body.needsVerification, true)

  const token = f.tokenFromMail(f.mail.sent[0], 'verify-email')
  await f.request('/auth/verify-email', { method: 'POST', body: { token } })
  const allowed = await f.request('/vip/orders', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { planId: 'month' },
  })
  assert.ok([200, 201].includes(allowed.status), JSON.stringify(allowed.body))
})

test('password reset emails a link, resets the password and invalidates old sessions', async (t) => {
  const f = await fixture(t)
  const { cookie, email } = await f.register()
  await f.request('/auth/verify-email', { method: 'POST', body: { token: f.tokenFromMail(f.mail.sent[0], 'verify-email') } })

  const forgot = await f.request('/auth/password/forgot', { method: 'POST', body: { email, ...(await f.captchaBody()) } })
  assert.equal(forgot.status, 200)
  assert.equal(forgot.body.sent, true)
  const resetMail = f.mail.sent.at(-1)
  const token = f.tokenFromMail(resetMail, 'reset-password')

  const weak = await f.request('/auth/password/reset', { method: 'POST', body: { token, password: 'short' } })
  assert.equal(weak.status, 400)

  const reset = await f.request('/auth/password/reset', { method: 'POST', body: { token, password: 'New-Strong-Pass-2026' } })
  assert.equal(reset.status, 200)

  // 旧会话失效，旧密码不可用。
  assert.equal((await f.request('/auth/me', { cookie })).body.user, null)
  const old = await f.request('/auth/login', { method: 'POST', body: { email, password: 'Correct-Horse-972!' } })
  assert.equal(old.status, 401)
  const fresh = await f.request('/auth/login', { method: 'POST', body: { email, password: 'New-Strong-Pass-2026' } })
  assert.equal(fresh.status, 200)
})

test('password reset never reveals whether an email is registered', async (t) => {
  const f = await fixture(t)
  const unknown = await f.request('/auth/password/forgot', { method: 'POST', body: { email: 'nobody@example.test', ...(await f.captchaBody()) } })
  assert.equal(unknown.status, 200)
  assert.equal(unknown.body.sent, true)
  assert.equal(f.mail.sent.length, 0)
})

test('a reset token cannot be reused and expired tokens are rejected', async (t) => {
  const f = await fixture(t)
  const { email } = await f.register()
  await f.request('/auth/password/forgot', { method: 'POST', body: { email, ...(await f.captchaBody()) } })
  const token = f.tokenFromMail(f.mail.sent.at(-1), 'reset-password')
  assert.equal((await f.request('/auth/password/reset', { method: 'POST', body: { token, password: 'First-Strong-Pass-2026' } })).status, 200)
  assert.equal((await f.request('/auth/password/reset', { method: 'POST', body: { token, password: 'Second-Strong-Pass-2026' } })).status, 400)
  assert.equal((await f.request('/auth/password/reset', { method: 'POST', body: { token: 'f'.repeat(64), password: 'Third-Strong-Pass-2026' } })).status, 400)
})

test('the captcha is demanded after repeated failed logins', async (t) => {
  const f = await fixture(t)
  const { email } = await f.register()
  await f.request('/auth/verify-email', { method: 'POST', body: { token: f.tokenFromMail(f.mail.sent[0], 'verify-email') } })
  for (let i = 0; i < 3; i++) {
    const failed = await f.request('/auth/login', { method: 'POST', body: { email, password: 'wrong-password' } })
    assert.equal(failed.status, 401)
  }
  const blocked = await f.request('/auth/login', { method: 'POST', body: { email, password: 'wrong-password' } })
  assert.equal(blocked.status, 400)
  assert.equal(blocked.body.captchaRequired, true)
  const withCaptcha = await f.request('/auth/login', { method: 'POST', body: { email, password: 'Correct-Horse-972!', ...(await f.captchaBody()) } })
  assert.equal(withCaptcha.status, 200)
})

test('email features stay disabled when SMTP is not configured', async (t) => {
  const f = await fixture(t, { mail: fakeMailer({ enabled: false }) })
  const capabilities = await f.request('/auth/providers')
  assert.equal(capabilities.body.emailVerification, false)
  assert.equal(capabilities.body.passwordReset, false)
  const { body } = await f.register()
  assert.equal(body.user.emailVerified, true)
  assert.equal(body.needsVerification, false)
  assert.equal(f.mail.sent.length, 0)
})

test('capabilities advertise the available account features', async (t) => {
  const f = await fixture(t)
  const capabilities = await f.request('/auth/providers')
  assert.equal(capabilities.body.captcha, true)
  assert.equal(capabilities.body.emailVerification, true)
  assert.equal(capabilities.body.passwordReset, true)
  assert.equal(capabilities.body.oauth, undefined)
})
