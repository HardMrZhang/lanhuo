#!/usr/bin/env node
/**
 * 批量给源视频去水印，然后重新转码 HLS。
 *
 * 只处理检测到水印的剧：先跑 scripts/dewatermark.py detect 判断，
 * 确认有水印才做 run（去水印 -> 重新转码 -> 重新生成封面）。
 *
 * 用法：
 *   node scripts/dewatermark-batch.mjs --dry-run          # 只列计划
 *   node scripts/dewatermark-batch.mjs --work local-xxx   # 只处理指定剧
 *   node scripts/dewatermark-batch.mjs --parallel 3
 *   node scripts/dewatermark-batch.mjs --skip-detect      # 跳过检测，直接处理
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PY = path.join(ROOT, '.venv-wm/bin/python')
const DEWMARK = path.join(ROOT, 'scripts/dewatermark.py')
const CLEAN_DIR = path.join(ROOT, 'media/clean')

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    parallel: { type: 'string', default: '2' },
    'dry-run': { type: 'boolean', default: false },
    'skip-detect': { type: 'boolean', default: false },
    work: { type: 'string', multiple: true, default: [] },
    limit: { type: 'string', default: '0' },
  },
})

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts })
    p.on('error', () => resolve(1))
    p.on('close', (code) => resolve(code ?? 1))
  })
}

/** 列出 media/imported 下每个剧的 mp4 集。 */
function listImported() {
  const base = path.join(ROOT, 'media/imported')
  if (!fs.existsSync(base)) return []
  return fs
    .readdirSync(base)
    .filter((d) => fs.statSync(path.join(base, d)).isDirectory())
    .map((id) => ({
      id,
      files: fs
        .readdirSync(path.join(base, id))
        .filter((f) => f.endsWith('.mp4'))
        .sort()
        .map((f) => path.join(base, id, f)),
    }))
    .filter((w) => w.files.length)
}

const works = listImported()
const selected = values.work.length ? works.filter((w) => values.work.includes(w.id)) : works
const limit = Number(values.limit) || 0

console.log(`候选剧集 ${selected.length}（共 ${works.length}）`)

const tasks = []
for (const w of selected) {
  for (const f of w.files) {
    tasks.push({ id: w.id, src: f, dest: path.join(CLEAN_DIR, w.id, path.basename(f)) })
  }
}

if (limit > 0) tasks.length = Math.min(tasks.length, limit)

if (values['dry-run']) {
  for (const t of tasks.slice(0, 30)) console.log(`  ${t.id} ${path.basename(t.src)}`)
  if (tasks.length > 30) console.log(`  ... 其余 ${tasks.length - 30} 个`)
  process.exit(0)
}

if (!fs.existsSync(PY)) {
  console.error(`找不到 ${PY}，请先创建环境：\n  python3 -m venv .venv-wm && .venv-wm/bin/pip install opencv-python-headless numpy`)
  process.exit(1)
}

const results = { done: 0, failed: 0, skipped: 0, failures: [] }

async function worker() {
  for (;;) {
    const task = tasks.shift()
    if (!task) return
    fs.mkdirSync(path.dirname(task.dest), { recursive: true })

    if (!values['skip-detect']) {
      const code = await run(PY, [DEWMARK, 'detect', task.src], { stdio: 'ignore' })
      if (code !== 0) {
        results.skipped++
        console.log(`  跳过（无水印）${task.id}/${path.basename(task.src)}`)
        continue
      }
    }

    const code = await run(PY, [DEWMARK, 'run', task.src, '-o', task.dest])
    if (code !== 0) {
      results.failed++
      results.failures.push(task.src)
      console.log(`  失败 ${task.id}/${path.basename(task.src)}`)
      continue
    }
    results.done++
    console.log(`  完成 ${task.id}/${path.basename(task.src)}`)
  }
}

await Promise.all(Array.from({ length: Math.max(1, Number(values.parallel) || 2) }, () => worker()))
console.log(JSON.stringify({ ...results, failures: results.failures.slice(0, 10) }, null, 2))
console.log('\n下一步：用去水印后的源重新转码 HLS（video-transcode.mjs 需要指向新的源目录）')
