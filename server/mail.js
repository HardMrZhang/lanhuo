import nodemailer from 'nodemailer'

/**
 * 事务性邮件发送（SMTP）。
 * 未配置 SMTP 时 enabled=false：调用方据此决定是提示用户「暂不可用」还是跳过发送。
 */
export function createMailer(env = process.env, { logger = console } = {}) {
  const host = env.SMTP_HOST?.trim()
  const port = Number(env.SMTP_PORT) || 587
  const secure = env.SMTP_SECURE === 'true' || port === 465
  const user = env.SMTP_USER?.trim()
  const pass = env.SMTP_PASS
  const from = env.MAIL_FROM?.trim() || user || ''
  const enabled = Boolean(host && from)
  const transporter = enabled
    ? nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined })
    : null

  async function send(message) {
    if (!transporter) {
      logger.warn?.('[mail] SMTP 未配置，邮件未发送')
      return { sent: false }
    }
    await transporter.sendMail({ from, ...message })
    return { sent: true }
  }

  return { enabled, send }
}

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/** 邮箱验证邮件：链接带一次性 token，30 分钟内有效。 */
export function verificationEmail({ email, url, lang = 'zh' }) {
  const en = lang === 'en'
  const subject = en ? 'Verify your Drama Theater email address' : '验证你的短剧剧场邮箱'
  const heading = en ? 'Confirm your email address' : '确认你的邮箱地址'
  const body = en
    ? `Hi, use the button below to confirm the email address ${email}. The link expires in 30 minutes. If you did not create this account you can ignore this email.`
    : `你好，点击下方按钮确认邮箱地址 ${email}。链接 30 分钟内有效。如果不是你本人操作，请忽略此邮件。`
  const button = en ? 'Verify email' : '验证邮箱'
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#151314;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f2f3f5">
  <div style="max-width:520px;margin:0 auto;background:#1f1f1f;border:1px solid #2e2e2e;border-radius:14px;padding:28px">
    <h1 style="margin:0 0 16px;font-size:20px">${heading}</h1>
    <p style="margin:0 0 24px;line-height:1.8;color:#c4cad9">${escapeHtml(body)}</p>
    <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#ff2e63;color:#fff;text-decoration:none;font-weight:700">${button}</a>
    <p style="margin:24px 0 0;font-size:12px;color:#7b8496;word-break:break-all">${escapeHtml(url)}</p>
  </div></body></html>`
  return { subject, html, text: `${heading}\n\n${body}\n\n${url}` }
}

/** 密码重置邮件：链接带一次性 token，30 分钟内有效。 */
export function resetEmail({ email, url, lang = 'zh' }) {
  const en = lang === 'en'
  const subject = en ? 'Reset your Drama Theater password' : '重置你的短剧剧场密码'
  const heading = en ? 'Reset your password' : '重置密码'
  const body = en
    ? `Hi, use the button below to set a new password for ${email}. The link expires in 30 minutes. If you did not request this, your password will stay unchanged.`
    : `你好，点击下方按钮为 ${email} 设置新密码。链接 30 分钟内有效。如果不是你本人操作，密码将保持不变。`
  const button = en ? 'Choose a new password' : '设置新密码'
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#151314;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f2f3f5">
  <div style="max-width:520px;margin:0 auto;background:#1f1f1f;border:1px solid #2e2e2e;border-radius:14px;padding:28px">
    <h1 style="margin:0 0 16px;font-size:20px">${heading}</h1>
    <p style="margin:0 0 24px;line-height:1.8;color:#c4cad9">${escapeHtml(body)}</p>
    <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#ff2e63;color:#fff;text-decoration:none;font-weight:700">${button}</a>
    <p style="margin:24px 0 0;font-size:12px;color:#7b8496;word-break:break-all">${escapeHtml(url)}</p>
  </div></body></html>`
  return { subject, html, text: `${heading}\n\n${body}\n\n${url}` }
}
