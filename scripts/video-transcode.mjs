#!/usr/bin/env node
/**
 * 批量把 py_project/video 的 mp4 转成 HLS（只转码，不上传、不入库）。
 *
 * 输出：hls-output/<dramaId>/episode-<no>/index.m3u8 + seg_*.ts
 * 档位规则与 scripts/to-hls.sh 一致（按源短边封顶 1080/720/480，绝不放大）。
 * 已有 index.m3u8 的集直接跳过，可重复执行。
 *
 * 用法：
 *   node scripts/video-transcode.mjs                    # 转码缺失的集
 *   node scripts/video-transcode.mjs --parallel 5       # 指定并发
 *   node scripts/video-transcode.mjs --dry-run          # 只列计划
 *   node scripts/video-transcode.mjs --work local-xxx    # 只处理指定剧
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'hls-output')
const CLEAN_DIR = path.join(ROOT, 'media/clean')
const MAP = path.join(ROOT, 'data/video-import-map.json')

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    parallel: { type: 'string', default: '4' },
    'dry-run': { type: 'boolean', default: false },
    work: { type: 'string', multiple: true, default: [] },
    limit: { type: 'string', default: '0' },
  },
})

const map = JSON.parse(fs.readFileSync(MAP, 'utf8'))
const works = values.work.length ? map.works.filter((w) => values.work.includes(w.id)) : map.works

const tasks = []
for (const w of works) {
  for (const e of w.episodes) {
    const dest = path.join(OUT, w.id, `episode-${e.no}`)
    if (fs.existsSync(path.join(dest, 'index.m3u8'))) continue
    // 去水印后的源优先（scripts/dewatermark.py 产出）
    const clean = path.join(CLEAN_DIR, w.id, path.basename(e.file))
    const src = fs.existsSync(clean) ? clean : e.file
    tasks.push({ src, dest, title: w.title, no: e.no, cleaned: src !== e.file })
  }
}

const limit = Number(values.limit) || 0
const allTasks = [...tasks]
if (limit > 0) tasks.length = Math.min(tasks.length, limit)

console.log(`待转码 ${tasks.length} 集（并发 ${values.parallel}）${limit ? `，本批上限 ${limit}/${allTasks.length}` : ''}`)
const cleanedCount = tasks.filter((t) => t.cleaned).length
if (cleanedCount) console.log(`  其中 ${cleanedCount} 集使用去水印后的源（media/clean/）`)
if (values['dry-run']) {
  for (const t of tasks.slice(0, 30)) console.log(`  ${t.title} 第${t.no}集 -> ${t.dest}${t.cleaned ? ' [已去水印]' : ''}`)
  if (tasks.length > 30) console.log(`  ... 其余 ${tasks.length - 30} 集`)
  process.exit(0)
}
if (!tasks.length) process.exit(0)

/** 转码一集：探测短边选档位 -> ffmpeg 切 HLS。 */
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
    if (!r.ok) { failed++; failures.push(r) }
    if (done % 5 === 0 || failed > 0) {
      const pct = (((done + failed) / (done + failed + tasks.length)) * 100).toFixed(1)
      const mins = ((Date.now() - started) / 60000).toFixed(1)
      console.log(`  进度 ${done + failed}/${done + failed + tasks.length} (${pct}%) 用时 ${mins}min`)
    }
  }
}

await Promise.all(Array.from({ length: parallel }, () => worker()))
console.log(JSON.stringify({ done, failed, failures: failures.slice(0, 10).map((f) => ({ title: f.title, no: f.no, error: f.error })) }, null, 2))
