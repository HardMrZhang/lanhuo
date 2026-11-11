#!/usr/bin/env node
/**
 * 打开 XVIDEOS 登录页，用真实浏览器完成登录（人工输入账号密码 + 通过验证码），
 * 登录成功后把 Cookie 保存成 Netscape 格式，供 yt-dlp 复用。
 *
 * 用法：
 *   node scripts/xvideos-login.mjs [--out data/xvideos/cookies.txt]
 *
 * 流程：
 *   1. 启动 Chromium（有头模式）
 *   2. 打开 https://www.xvideos.com/account
 *   3. 等待你在页面上完成登录（含验证码）
 *   4. 检测登录成功（页面出现已登录标识），导出 Cookie
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright-core'
import { toNetscape as toNetscapeFormat } from './lib/xvideos-cookies.mjs'

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'data/xvideos/cookies.txt' },
    profile: { type: 'string', default: '' },
    timeout: { type: 'string', default: '300' },
  },
})

const OUT = path.resolve(process.cwd(), values.out)
const PROFILE = values.profile
  ? path.resolve(process.cwd(), values.profile)
  : path.join(os.homedir(), '.xvideos-profile')
const TIMEOUT_SEC = Number(values.timeout) || 300

/**
 * 定位本机已安装的 Chromium。
 * playwright-core 默认按 PLAYWRIGHT_BROWSERS_PATH 查找，某些环境下该变量指向
 * 临时目录导致找不到浏览器，这里回退到 ~/Library/Caches/ms-playwright 下的版本。
 */
function resolveChromiumPath() {
  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
  if (!fs.existsSync(cacheDir)) return undefined

  const candidates = fs
    .readdirSync(cacheDir)
    .filter((n) => /^chromium-\d+$/.test(n))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))

  for (const dir of candidates) {
    for (const rel of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      'chrome-linux/chrome',
    ]) {
      const p = path.join(cacheDir, dir, rel)
      if (fs.existsSync(p)) return p
    }
  }
  return undefined
}

function toNetscape(cookies) {
  return toNetscapeFormat(cookies)
}

/**
 * 判断是否已登录。
 * 登录成功时站点会立即跳转，此时 evaluate 会抛「Execution context was destroyed」，
 * 因此这里必须吞掉异常并返回 false，交由下一轮轮询重试。
 *
 * @param {object} state 跨轮次状态：记录是否见过登录页，避免 URL 兜底误判
 */
async function isLoggedIn(page, context, state) {
  // 1) 先等页面稳定，避免在跳转中途取 DOM
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 })
  } catch {
    /* 仍在跳转中，继续往下试 */
  }

  let url = ''
  try {
    url = page.url()
  } catch {
    /* ignore */
  }
  if (/\/account(\?|$)/.test(url) || /\/account\/create/.test(url)) {
    state.sawAccountPage = true
  }

  // 2) DOM 标志：未登录时 body.class 含 anonymous，已登录为 authenticated
  try {
    const bodyClass = await page.evaluate(() => document.body?.className || '')
    if (/\bauthenticated\b/.test(bodyClass)) return true
  } catch {
    /* 上下文被销毁，下一轮再试 */
  }

  // 3) Cookie 兜底：匿名态只有 session_token，登录成功会新增认证 cookie
  try {
    const cookies = await context.cookies()
    const auth = cookies.find(
      (c) => c.name !== 'session_token' && /auth|user|member|uid|token/i.test(c.name),
    )
    if (auth) return true
  } catch {
    /* ignore */
  }

  // 4) URL 兜底：只有确定见过登录页、之后又跳离，才算登录成功
  if (state.sawAccountPage && url && !/\/account(\?|$)/.test(url) && !/\/account\/create/.test(url)) {
    return true
  }

  return false
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.mkdirSync(PROFILE, { recursive: true })

  const executablePath = resolveChromiumPath()
  const launchOptions = {
    headless: false,
    viewport: { width: 1280, height: 860 },
    args: ['--disable-blink-features=AutomationControlled'],
  }
  if (executablePath) {
    launchOptions.executablePath = executablePath
    console.log(`使用浏览器：${executablePath}`)
  }

  const context = await chromium.launchPersistentContext(PROFILE, launchOptions)
  const page = context.pages()[0] || (await context.newPage())

  console.log('浏览器已启动，正在打开登录页：https://www.xvideos.com/account')
  await page.goto('https://www.xvideos.com/account', { waitUntil: 'domcontentloaded' })

  console.log('\n请在打开的浏览器窗口中完成登录（填写账号密码并通过验证码）。')
  console.log(`检测到登录成功后会自动保存 Cookie，最多等待 ${TIMEOUT_SEC} 秒。\n`)

  const deadline = Date.now() + TIMEOUT_SEC * 1000
  let ok = false
  let lastUrl = ''
  const state = { sawAccountPage: false }
  while (Date.now() < deadline) {
    try {
      lastUrl = page.url()
    } catch {
      /* ignore */
    }
    if (await isLoggedIn(page, context, state)) {
      ok = true
      break
    }
    await new Promise((r) => setTimeout(r, 1500))
  }

  if (!ok) {
    await context.close().catch(() => {})
    throw new Error(`超时未检测到登录成功，未保存 Cookie（当前页面：${lastUrl || '未知'}）`)
  }

  // 登录成功后等页面完全稳定再取 Cookie
  await new Promise((r) => setTimeout(r, 1500))
  const cookies = await context.cookies(['https://www.xvideos.com', 'https://xvideos.com'])
  fs.writeFileSync(OUT, toNetscape(cookies))
  console.log(`\n登录成功，已保存 ${cookies.length} 条 Cookie 到：${OUT}`)

  await context.close().catch(() => {})
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})

// 兜底：任何未捕获异常都要关掉浏览器窗口，避免留下僵尸进程
process.on('uncaughtException', (err) => {
  console.error(err)
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  console.error(err)
  process.exit(1)
})
