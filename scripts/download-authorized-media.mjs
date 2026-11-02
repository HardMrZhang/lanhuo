import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_BYTES = 20 * 1024 * 1024 * 1024
const ACCEPTED_TYPES = new Set(['video/mp4', 'application/octet-stream', 'binary/octet-stream'])

function validateUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('下载地址无效') }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('仅支持不含账号密码的 HTTPS 官方下载地址')
  }
  return url
}

function safeTitle(value) {
  const title = String(value).normalize('NFC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 100)
  if (!title || title === '.' || title === '..') throw new Error('作品名称无效')
  return title
}

export function parseDownloadManifest(document) {
  if (!document || document.version !== 1 || !Array.isArray(document.items)) {
    throw new Error('清单格式无效：需要 version: 1 和 items 数组')
  }
  const seen = new Set()
  return document.items.map((item) => {
    if (!item || typeof item.title !== 'string') throw new Error('每项都必须包含作品 title')
    const title = safeTitle(item.title)
    const episode = Number(item.episode)
    if (!Number.isSafeInteger(episode) || episode < 1) throw new Error(`集数无效：${title}`)
    const url = validateUrl(item.url)
    const key = `${title}\0${episode}`
    if (seen.has(key)) throw new Error(`作品集数重复：${title} 第${episode}集`)
    seen.add(key)
    return { title, episode, url: url.toString() }
  })
}

async function fetchAuthorizedFile(url, fetchImpl, signal) {
  let current = validateUrl(url)
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetchImpl(current, {
      redirect: 'manual',
      headers: { Accept: 'video/mp4, application/octet-stream' },
      signal,
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || redirects === 5) throw new Error('下载地址重定向无效或次数过多')
    current = validateUrl(new URL(location, current).toString())
  }
  throw new Error('下载地址重定向次数过多')
}

export async function downloadAuthorizedMedia(items, outputDir, {
  fetchImpl = fetch,
  timeoutMs = 10 * 60 * 1000,
  maxBytes = MAX_BYTES,
  skipExisting = false,
  continueOnError = false,
} = {}) {
  const root = path.resolve(outputDir)
  const results = []
  for (const item of items) {
    let safe
    let destination
    let temporary
    try {
      safe = { ...item, title: safeTitle(item.title), url: validateUrl(item.url).toString() }
      if (!Number.isSafeInteger(safe.episode) || safe.episode < 1) throw new Error(`集数无效：${safe.title}`)
      const directory = path.join(root, safe.title)
      const filename = `第${String(safe.episode).padStart(2, '0')}集.mp4`
      destination = path.join(directory, filename)
      await fs.promises.mkdir(directory, { recursive: true })
      let stat
      try { stat = await fs.promises.lstat(destination) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (stat) {
        if (!stat.isFile()) throw new Error(`目标路径已存在且不是普通文件：${destination}`)
        if (skipExisting) {
          const handle = await fs.promises.open(destination, 'r')
          const header = Buffer.alloc(8)
          let bytesRead
          try { ({ bytesRead } = await handle.read(header, 0, header.length, 0)) }
          finally { await handle.close() }
          if (bytesRead < 8 || header.toString('ascii', 4, 8) !== 'ftyp') {
            throw new Error(`已存在文件不是 MP4，未跳过：${destination}`)
          }
          results.push({ title: safe.title, episode: safe.episode, path: destination, status: 'skipped' })
          continue
        }
        throw new Error(`文件已存在，不覆盖：${destination}`)
      }

      temporary = `${destination}.${randomUUID()}.part`
      const response = await fetchAuthorizedFile(safe.url, fetchImpl, AbortSignal.timeout(timeoutMs))
      if (response.status !== 200) {
        await response.body?.cancel()
        throw new Error(`需要完整文件响应 HTTP 200（收到 ${response.status}）：${safe.title} 第${safe.episode}集`)
      }
      const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
      if (!ACCEPTED_TYPES.has(contentType)) {
        await response.body?.cancel()
        throw new Error(`响应不是 MP4 文件（${contentType || '缺少 Content-Type'}）：${safe.title} 第${safe.episode}集`)
      }
      if (!response.body) throw new Error(`下载响应没有内容：${safe.title} 第${safe.episode}集`)
      const declaredLengthHeader = response.headers.get('content-length')
      const declaredLength = Number(declaredLengthHeader)
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body.cancel()
        throw new Error(`文件超过大小上限：${safe.title} 第${safe.episode}集`)
      }
      let received = 0
      let prefix = Buffer.alloc(0)
      let validMp4 = false
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length
          if (received > maxBytes) {
            callback(new Error(`文件超过大小上限：${safe.title} 第${safe.episode}集`))
            return
          }
          if (!validMp4) {
            prefix = Buffer.concat([prefix, chunk])
            if (prefix.length < 8) {
              callback()
              return
            }
            if (prefix.toString('ascii', 4, 8) !== 'ftyp') {
              callback(new Error(`文件内容不是 MP4：${safe.title} 第${safe.episode}集`))
              return
            }
            validMp4 = true
            callback(null, prefix)
            prefix = Buffer.alloc(0)
            return
          }
          callback(null, chunk)
        },
        flush(callback) {
          callback(validMp4 ? null : new Error(`文件内容不是 MP4：${safe.title} 第${safe.episode}集`))
        },
      })
      await pipeline(
        Readable.fromWeb(response.body),
        limit,
        fs.createWriteStream(temporary, { flags: 'wx' }),
        { signal: AbortSignal.timeout(timeoutMs) },
      )
      if (declaredLengthHeader !== null && Number.isFinite(declaredLength) && received !== declaredLength) {
        throw new Error(`下载大小与服务器声明不一致：${safe.title} 第${safe.episode}集`)
      }
      // A hard link publishes the completed file atomically and never overwrites a raced destination.
      await fs.promises.link(temporary, destination)
      await fs.promises.unlink(temporary)
      temporary = undefined
      results.push({ title: safe.title, episode: safe.episode, path: destination, bytes: received, status: 'downloaded' })
    } catch (error) {
      if (temporary) await fs.promises.rm(temporary, { force: true })
      if (!continueOnError) throw error
      results.push({
        title: safe?.title ?? String(item?.title ?? ''),
        episode: item?.episode,
        error: error.message,
        status: 'failed',
      })
    }
  }
  return results
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = `用法：node scripts/download-authorized-media.mjs <清单.json> [输出目录]

只下载授权方通过官方 API 或交付系统提供的 HTTPS MP4 直链/签名链接。
不会登录网站、解析网页播放器、读取浏览器 Cookie 或处理 DRM/HLS。
默认输出到 downloads/authorized。单个视频最大 20 GiB；已存在文件不会覆盖。
批量任务失败后，可加 --skip-existing 跳过已完成文件并继续。

清单格式：
{
  "version": 1,
  "items": [
    { "title": "示例剧名", "episode": 1, "url": "https://media.example/signed-video.mp4" }
  ]
}`
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        'skip-existing': { type: 'boolean', default: false },
      },
    })
    if (values.help) {
      console.log(usage)
      process.exit(0)
    }
    const [manifestPath, outputPath] = positionals
    if (!manifestPath || positionals.length > 2) throw new Error(usage)
    const document = JSON.parse(await fs.promises.readFile(path.resolve(manifestPath), 'utf8'))
    const items = parseDownloadManifest(document)
    const outputDir = path.resolve(outputPath ?? path.join(ROOT, 'downloads/authorized'))
    const results = await downloadAuthorizedMedia(items, outputDir, {
      skipExisting: values['skip-existing'],
      continueOnError: true,
    })
    const summary = {
      outputDir,
      downloaded: results.filter((result) => result.status === 'downloaded').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
      failed: results.filter((result) => result.status === 'failed').length,
      results,
    }
    console.log(JSON.stringify(summary, null, 2))
    if (summary.failed) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
