// 把 data/dramas.json 里 /media/imported/<id>/episode-N.mp4 批量指向 S3 HLS 中转：
//   /s3-hls/<id>/episode-N/index.m3u8  （服务端用 IAM 凭证 GetObject，桶保持私有；组织 SCP 禁公开直链也能播）
// 用法：node scripts/point-dramas-to-s3.mjs [--apply] [--proxy] [--direct] [--bucket X] [--region Y] [--prefix hls]
// 不加 --apply 只预览前 5 条 + 统计。--direct 才写 S3 公开直链（需桶策略允许）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 自动加载项目根目录 .env（调用方已显式设置的环境变量优先，不被 .env 覆盖）。
function loadEnvFile(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed
    const eq = body.indexOf('=')
    if (eq < 0) continue
    const k = body.slice(0, eq).trim()
    if (!k || process.env[k] !== undefined) continue
    let v = body.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    } else {
      // 去掉无引号值行尾注释： key=value # comment
      const hash = v.indexOf(' #')
      if (hash >= 0) v = v.slice(0, hash).trim()
    }
    process.env[k] = v
  }
}
loadEnvFile(path.join(ROOT, '.env'))

// 与 gen-import-manifest.mjs 同源：疑似未成年/年龄不明的一律不指 S3、不上传。
const BLOCK_S3 = [
  /鬼父/i, /高三/i, /童童|孩童|少年阿宾/i, /魔头女儿/i,
  /我的女友景甜|鹤棣/i, /原神·人物志/i, /夜神月/i, /龙女奇遇/i,
  /系统带我攻略弟弟/i, /狐小六/i, /瓜瓜干童童/i,
]

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    apply: { type: 'boolean', default: false },
    proxy: { type: 'boolean', default: true },
    direct: { type: 'boolean', default: false },
    bucket: { type: 'string', default: process.env.S3_BUCKET || 'duanju-h5-hls-473041657070' },
    region: { type: 'string', default: process.env.AWS_REGION || 'ap-northeast-1' },
    prefix: { type: 'string', default: process.env.S3_PREFIX || 'hls' },
  },
})

const dataFile = path.join(ROOT, 'data/dramas.json')
const raw = fs.readFileSync(dataFile, 'utf8')
const db = JSON.parse(raw)
const useProxy = values.proxy && !values.direct
const base = `https://${values.bucket}.s3.${values.region}.amazonaws.com/${values.prefix}`

let rewritten = 0
let skippedLocal = 0
let skippedNotReady = 0
let blocked = 0
const blockedTitles = []
const preview = []
const notReadySample = []

for (const d of db.dramas) {
  const hay = `${d.id}\n${d.title}`
  if (BLOCK_S3.some((re) => re.test(hay))) {
    blocked += d.episodes.length
    blockedTitles.push(d.title)
    continue
  }
  for (const ep of d.episodes) {
    const m = /^\/media\/imported\/(local-[a-f0-9]{16})\/episode-(\d+)\.mp4$/.exec(ep.src)
    if (!m) { skippedLocal++; continue }
    // 只指已转码好的：本地 hls-output/<id>/episode-N/index.m3u8 必须存在，否则留着本地不断链。
    const readyPath = path.join(ROOT, 'hls-output', m[1], `episode-${Number(m[2])}`, 'index.m3u8')
    if (!fs.existsSync(readyPath)) {
      skippedNotReady++
      if (notReadySample.length < 10) notReadySample.push(`${d.title} 第${ep.no}集（缺 ${m[1]}/episode-${Number(m[2])}/index.m3u8）`)
      continue
    }
    const next = useProxy
      ? `/s3-hls/${m[1]}/episode-${Number(m[2])}/index.m3u8`
      : `${base}/${m[1]}/episode-${Number(m[2])}/index.m3u8`
    if (preview.length < 5) preview.push(`${d.title} 第${ep.no}集\n  ${ep.src}\n  -> ${next}`)
    ep.src = next
    rewritten++
  }
}

console.log(JSON.stringify({
  mode: values.apply ? 'applied' : 'preview',
  target: useProxy ? 'proxy:/s3-hls' : `direct:${base}`, rewritten, skippedNonLocalSrc: skippedLocal, skippedNotTranscoded: skippedNotReady,
  blockedEpisodes: blocked, blockedWorks: blockedTitles, notReadySample,
  preview,
}, null, 2))

if (values.apply) {
  const backupDir = path.join(ROOT, 'data/backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const h = (await import('node:crypto')).createHash('sha256').update(raw).digest('hex').slice(0, 16)
  const backup = path.join(backupDir, `dramas-${h}.json`)
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw)
  fs.writeFileSync(dataFile, `${JSON.stringify(db, null, 2)}\n`)
  console.log(`已写入 ${dataFile}，备份 ${backup}`)
} else {
  console.log('预览模式，未写文件。确认无误后加 --apply 执行。')
}
