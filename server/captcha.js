import { randomInt } from 'node:crypto'

// 去掉易混淆字符（0/O、1/I/L），避免人工识别歧义。
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const WIDTH = 132
const HEIGHT = 44

const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/**
 * 生成图形验证码。答案只在服务端保存（哈希），前端拿到的是 SVG 图片。
 * 干扰线 + 随机旋转/偏移，兼顾机器识别成本与人工可读性。
 */
export function createCaptchaChallenge() {
  const length = 4
  let text = ''
  for (let i = 0; i < length; i++) text += ALPHABET[randomInt(ALPHABET.length)]

  const pieces = []
  for (let i = 0; i < text.length; i++) {
    const x = 14 + i * 28 + randomInt(6)
    const y = 30 + randomInt(8)
    const rotate = randomInt(46) - 23
    const hue = randomInt(360)
    pieces.push(
      `<text x="${x}" y="${y}" transform="rotate(${rotate} ${x} ${y})" font-family="Georgia, 'Times New Roman', serif" font-size="${26 + randomInt(6)}" font-weight="700" fill="hsl(${hue} 72% 68%)">${escapeXml(text[i])}</text>`,
    )
  }

  const lines = []
  for (let i = 0; i < 5; i++) {
    const x1 = randomInt(WIDTH)
    const y1 = randomInt(HEIGHT)
    const x2 = randomInt(WIDTH)
    const y2 = randomInt(HEIGHT)
    lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="hsl(${randomInt(360)} 60% 60%)" stroke-width="1" opacity="0.55"/>`)
  }
  const dots = []
  for (let i = 0; i < 40; i++) {
    dots.push(`<circle cx="${randomInt(WIDTH)}" cy="${randomInt(HEIGHT)}" r="${randomInt(2) + 1}" fill="hsl(${randomInt(360)} 55% 60%)" opacity="0.5"/>`)
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="captcha">`
    + `<rect width="${WIDTH}" height="${HEIGHT}" fill="#0d1017"/>`
    + lines.join('')
    + dots.join('')
    + pieces.join('')
    + '</svg>'

  return { text, svg }
}

/** 验证码答案归一化：忽略大小写与空格。 */
export function normalizeCaptcha(text) {
  return typeof text === 'string' ? text.trim().toUpperCase().replace(/\s+/g, '') : ''
}
