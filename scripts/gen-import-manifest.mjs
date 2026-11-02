import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DOWNLOADS = path.resolve(ROOT, '../../go_items/go_test/downloads')
const CHANNELS = new Set(['成人短剧', '成人漫剧'])
const hash = (value) => createHash('sha256').update(value).digest('hex')

const AUTO_EXCLUDE = [
  /鬼父/i,
  /高三/i,
  /童童|孩童|少年阿宾/i,
  /魔头女儿/i,
  /我的女友景甜|鹤棣/i,
  /原神·人物志/i,
  /夜神月/i,
  /龙女奇遇/i,
  /系统带我攻略弟弟/i,
  /狐小六/i,
  /瓜瓜干童童/i,
]

function autoExcludeReason(relativePath, title) {
  const hay = `${relativePath}\n${title}`
  if (AUTO_EXCLUDE.some((re) => re.test(hay))) return 'minor_or_age_uncertain'
  return null
}

function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, contents)
  fs.renameSync(temp, file)
}

function scanMetadataFiles(source) {
  const entries = []
  for (const channel of CHANNELS) {
    const channelDir = path.join(source, channel)
    if (!fs.existsSync(channelDir)) continue
    for (const name of fs.readdirSync(channelDir)) {
      const workDir = path.join(channelDir, name)
      if (!fs.statSync(workDir).isDirectory()) continue
      const metadataFile = path.join(workDir, 'metadata.json')
      if (!fs.existsSync(metadataFile)) continue
      const relativePath = `${channel}/${name}/metadata.json`
      const metadataText = fs.readFileSync(metadataFile, 'utf8')
      let title = name
      try {
        title = JSON.parse(metadataText).title ?? name
      } catch {
        /* keep folder name */
      }
      entries.push({
        relativePath,
        metadataSha256: hash(metadataText),
        title: String(title).trim(),
      })
    }
  }
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'))
  return entries
}

export function buildManifest({ source, manifestPath, previousPath = manifestPath, audit = false }) {
  source = fs.realpathSync(source)
  const scanned = scanMetadataFiles(source)
  const previous = fs.existsSync(previousPath)
    ? JSON.parse(fs.readFileSync(previousPath, 'utf8'))
    : { version: 1, entries: [] }
  const prevByPath = new Map((previous.entries ?? []).map((e) => [e.relativePath, e]))

  const entries = scanned.map(({ relativePath, metadataSha256, title }) => {
    const old = prevByPath.get(relativePath)
    if (old && old.metadataSha256 === metadataSha256 && old.decision) {
      return {
        relativePath,
        decision: old.decision,
        reason: old.reason ?? null,
        metadataSha256,
      }
    }
    const reason = audit ? autoExcludeReason(relativePath, title) : null
    return {
      relativePath,
      decision: reason ? 'exclude' : 'include',
      reason,
      metadataSha256,
    }
  })

  return {
    version: 1,
    entries,
    stats: {
      total: entries.length,
      include: entries.filter((e) => e.decision === 'include').length,
      exclude: entries.filter((e) => e.decision === 'exclude').length,
      preserved: entries.filter((e) => prevByPath.has(e.relativePath)).length,
    },
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = `用法：node gen-import-manifest.mjs [下载目录] [--project <duanju-h5根目录>] [--write]

默认下载目录：${DEFAULT_DOWNLOADS}
默认网站项目：${ROOT}
默认全部 include；加 --audit 才按标题规则写入 exclude。
不加 --write 只打印统计；加上后写入 data/local-import-manifest.json 并备份旧文件。`
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        write: { type: 'boolean', default: false },
        audit: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
      },
    })
    if (values.help) {
      console.log(usage)
    } else {
      const source = path.resolve(positionals[0] ?? DEFAULT_DOWNLOADS)
      const root = path.resolve(values.project ?? ROOT)
      const manifestPath = path.join(root, 'data/local-import-manifest.json')
      if (!fs.existsSync(source)) throw new Error(`下载目录不存在：${source}`)
      const manifest = buildManifest({ source, manifestPath, audit: values.audit })
      if (values.write) {
        if (fs.existsSync(manifestPath)) {
          const backupDir = path.join(root, 'data/backups')
          fs.mkdirSync(backupDir, { recursive: true })
          const backup = path.join(backupDir, `manifest-${hash(fs.readFileSync(manifestPath)).slice(0, 16)}.json`)
          if (!fs.existsSync(backup)) fs.copyFileSync(manifestPath, backup)
        }
        writeAtomic(manifestPath, `${JSON.stringify({ version: manifest.version, entries: manifest.entries }, null, 2)}\n`)
      }
      console.log(JSON.stringify({ source, project: root, manifest: manifestPath, ...manifest.stats, write: values.write }, null, 2))
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
