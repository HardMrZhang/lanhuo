#!/usr/bin/env node
/**
 * 把 media/imported（成人短剧/漫剧）的剧转成 HLS，优先用去水印后的源 media/clean。
 *
 * 与 scripts/video-transcode.mjs 的区别：
 *   - 数据源是 media/imported/<dramaId>/episode-N.mp4（符号链接指向下载目录），
 *     不是 data/video-import-map.json；
 *   - 源优先取 media/clean/<dramaId>/episode-N.mp4（去水印产物），没有再用原始源；
 *   - 对有去水印源的集强制重转（覆盖旧 index.m3u8）。
 *
 * 输出：hls-output/<dramaId>/episode-<N>/index.m3u8 + seg_*.ts
 *
 * 用法：
 *   node scripts/transcode-local.mjs --dry-run
 *   node scripts/transcode-local.mjs --work local-xxx --work local-yyy
 *   node scripts/transcode-local.mjs --parallel 4
 *   node scripts/transcode-local.mjs --all          # 全部（含无水印的）
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IMPORTED = path.join(ROOT, 'media/imported')
const CLEAN = path.join(ROOT, 'media/clean')
const OUT = path.join(ROOT, 'hls-output')

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    parallel: { type: 'string', default: '4' },
    'dry-run': { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    work: { type: 'string', multiple: true, default: [] },
    limit: { type: 'string', default: '0' },
  },
})

/** 列出所有本地剧及其集。 */
function listWorks() {
  if (!fs.existsSync(IMPORTED)) return []
  return fs
    .readdirSync(IMPORTED)
    .filter((d) => fs.statSync(path.join(IMPORTED, d)).isDirectory())
    .map((id) => {
      const files = fs
        .readdirSync(path.join(IMPORTED, id))
        .filter((f) => /^episode-\d+\.mp4$/.test(f))
        .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
      return { id, files }
    })
    .filter((w) => w.files.length)
}

const works = listWorks()
const selected = values.work.length ? works.filter((w) => values.work.includes(w.id)) : works

const tasks = []
for (const w of selected) {
  for (const f of w.files) {
    const no = Number(f.match(/episode-(\d+)\.mp4/)[1])
    const dest = path.join(OUT, w.id, `episode-${no}`)
    const clean = path.join(CLEAN, w.id, f)
    const hasClean = fs.existsSync(clean) && fs.statSync(clean).size > 0
    const src = hasClean ? clean : path.join(IMPORTED, w.id, f)
    // 已有产物：去水印源要强制重转，普通源跳过
    const done = fs.existsSync(path.join(dest, 'index.m3u8'))
    if (done && !hasClean) continue
    if (!values.all && !hasClean) continue
    tasks.push({ id: w.id, no, src, dest, cleaned: hasClean, done })
  }
}

const limit = Number(values.limit) || 0
if (limit > 0) tasks.length = Math.min(tasks.length, limit)

console.log(`待转码 ${tasks.length} 集（并发 ${values.parallel}）`)
const cleanedCount = tasks.filter((t) => t.cleaned).length
if (cleanedCount) console.log(`  其中 ${cleanedCount} 集使用去水印后的源（media/clean/）`)
if (values['dry-run']) {
  for (const t of tasks.slice(0, 40)) {
    console.log(`  ${t.id} 第${t.no}集 -> ${t.dest}${t.cleaned ? ' [已去水印]' : ''}${t.done ? ' [重转]' : ''}`)
  }
  if (tasks.length > 40) console.log(`  ... 其余 ${tasks.length - 40} 个`)
  process.exit(0)
}
if (!tasks.length) process.exit(0)

/** 一集：探测短边选档位 -> ffmpeg 切 HLS。 */
function transcode(task) {
  return new Promise((resolve) => {
    const { src, dest } = task
    fs.mkdirSync(dest, { recursive: true })
    const probe = spawn(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src],
      { encoding: 'utf8' },
    )
    let pOut = ''
    probe.stdout.on('data', (d) => { pOut += d })
    probe.on('error', () => resolve({ ...task, ok: false, error: 'ffprobe-missing' }))
    probe.on('close', () => {
      const [w, h] = pOut.trim().split(',').map(Number)
      if (!w || !h) return resolve({ ...task, ok: false, error: 'probe-failed' })
      const short = Math.min(w, h)
      let target, bv, maxrate, buf, prof
      if (short >= 1000) { target = 1080; bv = '3500k'; maxrate = '3800k'; buf = '7000k'; prof = 'high' }
      else if (short >= 700) { target = 720; bv = '1800k'; maxrate = '2000k'; buf = '3600k'; prof = 'main' }
      else { target = 480; bv = '800k'; maxrate = '900k'; buf = '1600k'; prof = 'main' }
      const vf = `scale=w='if(gt(iw,ih),-2,min(iw,${target}))':h='if(gt(iw,ih),min(ih,${target}),-2)',setsar=1`
      const args = [
        '-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-stats', '-i', src,
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', prof,
        '-b:v', bv, '-maxrate:v', maxrate, '-bufsize:v', buf,
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
        '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
        '-hls_flags', 'independent_segments',
        '-hls_segment_filename', path.join(dest, 'seg_%04d.ts'),
        path.join(dest, 'index.m3u8'),
      ]
      const ff = spawn('ffmpeg', args)
      let err = ''
      ff.stderr.on('data', (d) => { err += d })
      ff.on('error', () => resolve({ ...task, ok: false, error: 'ffmpeg-missing' }))
      ff.on('close', (code) => {
        if (code === 0 && fs.existsSync(path.join(dest, 'index.m3u8'))) resolve({ ...task, ok: true })
        else resolve({ ...task, ok: false, error: `exit=${code} ${err.slice(-300)}` })
      })
    })
  })
}

const parallel = Math.max(1, Number(values.parallel) || 4)
let done = 0
let failed = 0
const failures = []
const started = Date.now()

async function worker() {
  for (;;) {
    const task = tasks.shift()
    if (!task) return
    const r = await transcode(task)
    done++
    if (!r.ok) { failed++; failures.push(r); console.log(`  ✗ ${r.id} 第${r.no}集 ${r.error}`) }
    else console.log(`  ✓ ${r.id} 第${r.no}集${r.cleaned ? ' [已去水印]' : ''}`)
    const pct = (((done + failed) / (done + failed + tasks.length)) * 100).toFixed(1)
    const mins = ((Date.now() - started) / 60000).toFixed(1)
    console.log(`  进度 ${done + failed}/${done + failed + tasks.length} (${pct}%) 用时 ${mins}min`)
  }
}

await Promise.all(Array.from({ length: parallel }, () => worker()))
console.log(JSON.stringify({ done, failed, failures: failures.slice(0, 10).map((f) => ({ id: f.id, no: f.no, error: f.error })) }, null, 2))
