import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const channels = { 成人短剧: 'shorts', 成人漫剧: 'anime' }
const channelCategories = Object.entries(channels).map(([name, id]) => ({ id, name }))
const hash = (value) => createHash('sha256').update(value).digest('hex')

export function extractSection(text, start, end) {
  const from = text.indexOf(start)
  if (from < 0) return ''
  const to = text.indexOf(end, from + start.length)
  return to < 0 ? '' : text.slice(from + start.length, to).trim()
}

export function parseMetadata(metadata) {
  const text = String(metadata.description ?? '').replace(/\r\n?/g, '\n')
  const description = extractSection(text, '作品简介', '作品评分')
    .replace(/《[^》\n]+》(?:共\s*\d+\s*集，|成人(?:短|漫)剧，)[^\n]*?完整选集可从本页进入播放。?/g, '')
    .replace(/(^|\n)\s*(?:展开|收起)\s*[▾▴▼▲]?\s*(?=\n|$)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const info = extractSection(text, '作品资料', '选集')
  const field = (name) => info.match(new RegExp(`(?:^|\\n)${name}\\s*\\n([^\\n]+)`))?.[1]?.trim()
  const viewsMatch = field('热度')?.match(/^([\d.]+)\s*([万亿])?/)
  const score = Number(extractSection(text, '作品评分', '作品标签').match(/^([\d.]+)/)?.[1])
  const published = field('发布')
  return {
    description,
    tags: [...new Set(extractSection(text, '作品标签', '作品资料').split('\n').map((s) => s.trim()).filter(Boolean))],
    status: /完结/.test(field('状态') ?? '') ? 'completed' : 'ongoing',
    ...(viewsMatch ? { views: Math.round(Number(viewsMatch[1]) * ({ 万: 1e4, 亿: 1e8 }[viewsMatch[2]] ?? 1)) } : {}),
    ...(Number.isFinite(score) && score >= 0 && score <= 10 ? { rating: Math.round(score * 10) } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(published ?? '') ? { publishedAt: `${published}T00:00:00+08:00` } : {}),
  }
}

function probeVideo(file) {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height',
    '-of', 'json', file,
  ], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })
  if (result.error?.code === 'ENOENT') throw new Error('需要安装 ffprobe（ffmpeg），才能检查视频文件。')
  if (result.status !== 0) return null
  try {
    const info = JSON.parse(result.stdout)
    const video = info.streams?.find((s) => s.codec_type === 'video')
    const duration = Number(info.format?.duration)
    if (!video || !(duration > 0)) return null
    return { duration: Math.round(duration * 100) / 100, width: video.width, height: video.height }
  } catch {
    return null
  }
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
}

export const designedCoverPath = (id) => `/posters/imported/${id}.designed-v1.svg`

/** Self-contained scenic artwork: no remote images or source-video frames. */
export function designPoster(drama, root = ROOT) {
  const themes = [
    ['sea', '#91d8d6'], ['stars', '#c4b5f4'], ['street', '#e3b785'],
    ['forest', '#b3d6ad'], ['sunset', '#f2c298'], ['mountain', '#b9d3e4'],
  ]
  const title = String(drama.title).trim()
  const themeIndex = /海|滩/.test(title) ? 0 : /神|唐门|系统/.test(title) ? 1
    : /黑|鬼|夜/.test(title) ? 3 : /爱情|校花|花田/.test(title) ? 4
      : parseInt(hash(drama.id).slice(0, 8), 16) % themes.length
  const [theme, color] = themes[themeIndex]
  const background = `/posters/bg-${theme}.jpg`
  const backgroundFile = path.join(root, 'public', background)
  const photo = fs.existsSync(backgroundFile)
    ? `<image href="data:image/jpeg;base64,${fs.readFileSync(backgroundFile).toString('base64')}" width="540" height="960" preserveAspectRatio="xMidYMid slice"/>`
    : ''
  const characters = Array.from(title)
  const lineCount = Math.min(4, Math.max(1, Math.ceil(characters.length / 7)))
  const perLine = Math.max(1, Math.ceil(characters.length / lineCount))
  const lines = []
  for (let i = 0; i < characters.length; i += perLine) lines.push(characters.slice(i, i + perLine).join(''))
  const fontSize = Math.min(57, Math.floor(434 / perLine))
  const lineHeight = fontSize + 16
  const titleY = 808 - (lines.length - 1) * lineHeight
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="960" viewBox="0 0 540 960">
<defs>
  <linearGradient id="base" x2=".85" y2="1"><stop stop-color="${color}"/><stop offset=".5" stop-color="#263449"/><stop offset="1" stop-color="#10131d"/></linearGradient>
  <linearGradient id="shade" x2="0" y2="1"><stop stop-color="#080e1b" stop-opacity=".46"/><stop offset=".35" stop-color="#080e1b" stop-opacity=".02"/><stop offset=".59" stop-color="#080e1b" stop-opacity=".34"/><stop offset=".83" stop-color="#080e1b" stop-opacity=".94"/><stop offset="1" stop-color="#080e1b"/></linearGradient>
</defs>
<rect width="540" height="960" fill="url(#base)"/>${photo}
<rect width="540" height="960" fill="url(#shade)"/>
<rect x="22" y="22" width="496" height="916" rx="3" fill="none" stroke="#fff" stroke-opacity=".25"/>
<path d="M48 157H492M48 851H492" stroke="#fff" stroke-opacity=".25"/>
<g font-family="PingFang SC,Microsoft YaHei,sans-serif">
  <text x="48" y="76" fill="#fff" font-size="24" font-weight="600" letter-spacing="6">短剧剧场</text>
  <text x="49" y="116" fill="#fff" fill-opacity=".65" font-size="12" letter-spacing="3">THEATER COLLECTION</text>
  <text x="491" y="76" text-anchor="end" fill="${color}" font-size="16" letter-spacing="2">${drama.channelId === 'anime' ? '漫剧' : '短剧'}</text>
  <rect x="48" y="${titleY - 80}" width="38" height="4" rx="2" fill="${color}"/>
  <text x="100" y="${titleY - 68}" fill="${color}" font-size="16" letter-spacing="4">剧场海报</text>
  ${lines.map((line, i) => `<text x="45" y="${titleY + i * lineHeight}" fill="#fff" font-size="${fontSize}" font-weight="800" letter-spacing="1">${xml(line)}</text>`).join('\n')}
  <text x="48" y="894" fill="${color}" font-size="21" letter-spacing="3">${drama.episodes.length ? `${String(drama.episodes.length).padStart(2, '0')} 集故事` : '剧集待更新'}</text>
  <text x="491" y="892" text-anchor="end" fill="#fff" fill-opacity=".5" font-size="12" letter-spacing="2">DUANJU</text>
</g></svg>\n`
  return { svg, background: photo ? background : null }
}

function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, contents)
  fs.renameSync(temp, file)
}

function removeRetiredAssets(root, previous, activeIds) {
  for (const drama of previous.dramas) {
    if (!/^local-[a-f0-9]{16}$/.test(drama.id) || activeIds.has(drama.id)) continue
    const directory = path.join(root, 'media/imported', drama.id)
    if (fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name)
        // Only remove generated links, never source videos or a user's regular files.
        if (/^episode-\d+\.mp4$/.test(name) && fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file)
      }
      if (!fs.readdirSync(directory).length) fs.rmdirSync(directory)
    }
    for (const extension of ['svg', 'jpg', 'designed-v1.svg']) {
      const file = path.join(root, 'public/posters/imported', `${drama.id}.${extension}`)
      if (fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) fs.unlinkSync(file)
    }
  }
}

export function importDownloads({ source, manifest, root = ROOT, apply = false, replaceCatalog = false, probe = probeVideo }) {
  source = fs.realpathSync(source)
  const audit = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  if (audit.version !== 1 || !Array.isArray(audit.entries)) throw new Error('无效的导入清单')
  const dataFile = path.join(root, 'data/dramas.json')
  const previousText = fs.readFileSync(dataFile, 'utf8')
  const previous = JSON.parse(previousText)
  const dramas = []
  const links = []
  const skipped = []
  const awaitingVideo = []
  const incompleteFiles = []
  const seen = new Set()
  for (const entry of audit.entries) {
    if (entry.decision !== 'include') {
      skipped.push({ relativePath: entry.relativePath, reason: entry.reason ?? 'excluded' })
      continue
    }
    const relativePath = entry.relativePath
    if (typeof relativePath !== 'string' || seen.has(relativePath)) throw new Error('清单路径重复或无效')
    seen.add(relativePath)
    const metadataFile = path.resolve(source, relativePath)
    if (!metadataFile.startsWith(`${source}${path.sep}`)) throw new Error('清单路径超出下载目录')
    if (!fs.existsSync(metadataFile)) {
      skipped.push({ relativePath, reason: 'metadata_missing' })
      continue
    }
    const realMetadataFile = fs.realpathSync(metadataFile)
    if (!realMetadataFile.startsWith(`${source}${path.sep}`)) throw new Error('元数据路径超出下载目录')
    const metadataText = fs.readFileSync(realMetadataFile, 'utf8')
    if (hash(metadataText) !== entry.metadataSha256) {
      skipped.push({ relativePath, reason: 'metadata_changed' })
      continue
    }
    const metadata = JSON.parse(metadataText)
    const channelName = relativePath.split('/')[0]
    const channelId = channels[channelName]
    if (!channelId || metadata.category !== channelName) throw new Error(`目录与栏目不匹配：${relativePath}`)
    const details = parseMetadata(metadata)
    if (!details.description || typeof metadata.title !== 'string' || !metadata.title.trim()) {
      skipped.push({ relativePath, reason: 'missing_title_or_introduction' })
      continue
    }
    const id = `local-${hash(relativePath).slice(0, 16)}`
    const episodes = []
    const episodeNos = new Set()
    let hd = true
    const directory = path.dirname(metadataFile)
    for (const filename of fs.readdirSync(directory).sort()) {
      const match = /^第(\d+)集\.mp4$/i.exec(filename)
      if (!match) continue
      const no = Number(match[1])
      if (!Number.isSafeInteger(no) || no < 1 || episodeNos.has(no)) throw new Error(`集号无效或重复：${relativePath}`)
      episodeNos.add(no)
      const file = fs.realpathSync(path.join(directory, filename))
      if (!file.startsWith(`${source}${path.sep}`)) throw new Error('视频路径超出下载目录')
      const info = probe(file)
      if (!info) {
        incompleteFiles.push(path.relative(source, file))
        continue
      }
      const name = `episode-${no}.mp4`
      episodes.push({ no, title: `第${no}集`, src: `/media/imported/${id}/${name}`, duration: info.duration })
      links.push({ target: file, destination: path.join(root, 'media/imported', id, name) })
      hd &&= Math.min(info.width ?? 0, info.height ?? 0) >= 720
    }
    episodes.sort((a, b) => a.no - b.no)
    if (!episodes.length) {
      awaitingVideo.push({ relativePath, reason: 'no_complete_episodes' })
      details.status = 'ongoing'
      hd = false
    }
    // Preserve source episode numbers. Missing episodes are never replaced with another video.
    const expected = metadata.episodes ?? []
    if (expected.some((e) => !episodes.some((local) => local.no === Number(e.episode)))) details.status = 'ongoing'
    const cover = fs.existsSync(path.join(root, 'public/posters/imported', `${id}.jpg`))
      ? `/posters/imported/${id}.jpg`
      : designedCoverPath(id)
    dramas.push({ id, title: metadata.title.trim(), cover, ...details,
      channelId, categoryIds: [channelId], hd, episodes })
  }
  if (!dramas.length) throw new Error('没有可导入的资料，现有数据未修改。')
  const kept = replaceCatalog ? [] : previous.dramas.filter((d) => !d.id.startsWith('local-'))
  const categoryMap = new Map((replaceCatalog ? [] : previous.categories).map((c) => [c.id, c]))
  for (const category of channelCategories) categoryMap.set(category.id, category)
  const next = `${JSON.stringify({ categories: [...categoryMap.values()], dramas: [...dramas, ...kept] }, null, 2)}\n`
  const report = {
    metadataCount: audit.entries.length,
    importedWorks: dramas.length,
    importedEpisodes: dramas.reduce((n, d) => n + d.episodes.length, 0),
    playableWorks: dramas.filter((d) => d.episodes.length).length,
    imageCovers: dramas.filter((d) => d.cover.endsWith('.jpg')).length,
    designedSvgCovers: dramas.filter((d) => d.cover.endsWith('.designed-v1.svg')).length,
    channels: Object.fromEntries(Object.values(channels).map((id) => [id, {
      works: dramas.filter((d) => d.channelId === id).length,
      episodes: dramas.filter((d) => d.channelId === id).reduce((n, d) => n + d.episodes.length, 0),
    }])),
    skipped,
    awaitingVideo,
    incompleteFiles,
  }
  if (apply) {
    // Back up each distinct catalog before changing it, including on later reimports.
    if (next !== previousText) {
      const backup = path.join(root, 'data/backups', `dramas-${hash(previousText).slice(0, 16)}.json`)
      if (!fs.existsSync(backup)) writeAtomic(backup, previousText)
    }
    for (const link of links) {
      fs.mkdirSync(path.dirname(link.destination), { recursive: true })
      if (fs.existsSync(link.destination) || fs.lstatSync(link.destination, { throwIfNoEntry: false })) {
        if (!fs.lstatSync(link.destination).isSymbolicLink() || fs.readlinkSync(link.destination) !== link.target)
          throw new Error(`媒体路径已被占用，未覆盖：${link.destination}`)
      } else fs.symlinkSync(link.target, link.destination)
    }
    for (const drama of dramas) {
      if (drama.cover.endsWith('.svg')) writeAtomic(path.join(root, 'public', drama.cover), designPoster(drama, root).svg)
    }
    if (next !== previousText) writeAtomic(dataFile, next)
    removeRetiredAssets(root, previous, new Set(dramas.map((d) => d.id)))
    writeAtomic(path.join(root, 'data/local-import-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = `用法：node import-downloads.mjs <下载目录> [--project <网站项目根目录>] [--apply] [--replace-catalog]

下载目录可使用相对路径，相对于运行命令时的目录。
--project 指定包含 data/dramas.json 和 data/local-import-manifest.json 的网站项目。
在原项目 scripts/ 目录保留脚本时可省略 --project；复制脚本到别处后请显式指定。
不加 --apply 只预览；加上后会写入目标项目，并自动备份旧目录。`
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        apply: { type: 'boolean', default: false },
        'replace-catalog': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
      },
    })
    if (values.help) {
      console.log(usage)
    } else {
      if (positionals.length !== 1) throw new Error(`需要且只能指定一个下载目录。\n${usage}`)
      const source = path.resolve(positionals[0])
      const root = path.resolve(values.project ?? ROOT)
      const manifest = path.join(root, 'data/local-import-manifest.json')
      for (const file of [manifest, path.join(root, 'data/dramas.json')]) {
        if (!fs.existsSync(file)) {
          throw new Error(`找不到目标项目的数据文件：${file}\n请用 --project 指定网站项目根目录；复制脚本到其他目录后也需要这个参数。`)
        }
      }
      if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
        throw new Error(`下载目录不存在或不是目录：${source}`)
      }
      const report = importDownloads({ source, root, manifest,
        apply: values.apply, replaceCatalog: values['replace-catalog'] })
      const reasons = {}
      for (const item of report.skipped) reasons[item.reason] = (reasons[item.reason] ?? 0) + 1
      console.log(JSON.stringify({ mode: values.apply ? 'applied' : 'preview', project: root, source,
        ...report, skipped: reasons, awaitingVideo: report.awaitingVideo.length,
        incompleteFiles: report.incompleteFiles.length }, null, 2))
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
