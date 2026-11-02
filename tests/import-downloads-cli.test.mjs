import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const importer = fileURLToPath(new URL('../scripts/import-downloads.mjs', import.meta.url))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'duanju-import-cli-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const project = path.join(base, 'target website')
  const copiedRoot = path.join(base, 'copied tool')
  const script = path.join(copiedRoot, 'scripts/import-downloads.mjs')
  const cwd = path.join(base, 'external working directory')
  const source = path.join(cwd, 'download files')
  const emptyBin = path.join(base, 'empty-bin')
  const relativePath = '成人短剧/山间书店/metadata.json'
  for (const directory of [path.join(project, 'data'), path.dirname(script), path.dirname(path.join(source, relativePath)), emptyBin]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  fs.copyFileSync(importer, script)
  const metadata = JSON.stringify({
    title: '山间书店',
    category: '成人短剧',
    description: [
      '作品简介', '一位成年店主经营山间书店，与旅人交流读书心得。',
      '作品评分', '8.2', '作品标签', '日常',
      '作品资料', '状态', '更新中', '选集',
    ].join('\n'),
    episodes: [],
  })
  fs.writeFileSync(path.join(source, relativePath), metadata)
  const manifest = {
    version: 1,
    entries: [{ relativePath, metadataSha256: sha256(metadata), decision: 'include' }],
  }
  fs.writeFileSync(path.join(project, 'data/local-import-manifest.json'), JSON.stringify(manifest))
  const initial = JSON.stringify({
    categories: [{ id: 'demo', name: '演示' }],
    dramas: [{ id: 'demo-kept', title: '已有演示作品', episodes: [] }],
  })
  fs.writeFileSync(path.join(project, 'data/dramas.json'), initial)
  const run = (args) => spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    // The fixture has no video files and must not require ffprobe on PATH.
    env: { ...process.env, PATH: emptyBin },
  })
  return { base, project, copiedRoot, script, cwd, source, initial, run }
}

function snapshot(directory, omit) {
  const result = {}
  function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name)
      if (file === omit) continue
      const relative = path.relative(directory, file)
      const stat = fs.lstatSync(file)
      if (stat.isDirectory()) {
        result[relative] = 'directory'
        walk(file)
      } else if (stat.isSymbolicLink()) result[relative] = `link:${fs.readlinkSync(file)}`
      else result[relative] = sha256(fs.readFileSync(file))
    }
  }
  walk(directory)
  return result
}

test('copied CLI resolves a relative source from cwd and writes only the explicit project', (t) => {
  const f = fixture(t)
  const outsideProject = snapshot(f.base, f.project)
  const result = f.run([path.relative(f.cwd, f.source), '--project', f.project, '--apply'])
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.mode, 'applied')
  assert.equal(report.project, f.project)
  assert.equal(report.source, f.source)
  assert.equal(report.importedWorks, 1)
  assert.equal(report.importedEpisodes, 0)
  assert.equal(report.playableWorks, 0)
  assert.equal(report.awaitingVideo, 1)
  const catalog = JSON.parse(fs.readFileSync(path.join(f.project, 'data/dramas.json'), 'utf8'))
  const imported = catalog.dramas.find((drama) => drama.id.startsWith('local-'))
  assert.equal(imported.title, '山间书店')
  assert.equal(imported.channelId, 'shorts')
  assert.deepEqual(imported.episodes, [])
  assert.ok(catalog.dramas.some((drama) => drama.id === 'demo-kept'))
  assert.ok(fs.existsSync(path.join(f.project, 'public', imported.cover)))
  assert.ok(fs.existsSync(path.join(f.project, 'data/local-import-report.json')))
  const backups = fs.readdirSync(path.join(f.project, 'data/backups'))
  assert.equal(backups.length, 1)
  assert.equal(fs.readFileSync(path.join(f.project, 'data/backups', backups[0]), 'utf8'), f.initial)
  assert.deepEqual(snapshot(f.base, f.project), outsideProject)
})

test('copied CLI without --project explains the missing project path without writing files', (t) => {
  const f = fixture(t)
  const before = snapshot(f.base)
  const result = f.run([path.relative(f.cwd, f.source), '--apply'])
  assert.ifError(result.error)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--project/)
  assert.match(result.stderr, /项目|网站|目录/)
  assert.ok(result.stderr.includes(f.copiedRoot), result.stderr)
  assert.deepEqual(snapshot(f.base), before)
})

test('copied CLI --help succeeds without a source or project and changes nothing', (t) => {
  const f = fixture(t)
  const before = snapshot(f.base)
  const result = f.run(['--help'])
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--project/)
  assert.match(result.stdout, /--apply/)
  assert.match(result.stdout, /下载|downloads|source/)
  assert.deepEqual(snapshot(f.base), before)
})

test('unknown CLI options and extra source arguments fail before changing the target project', (t) => {
  const f = fixture(t)
  const before = snapshot(f.base)
  const source = path.relative(f.cwd, f.source)
  for (const args of [
    [source, '--project', f.project, '--apply', '--unexpected-option'],
    [source, source, '--project', f.project, '--apply'],
  ]) {
    const result = f.run(args)
    assert.ifError(result.error)
    assert.notEqual(result.status, 0)
    assert.ok(result.stderr.trim())
    assert.deepEqual(snapshot(f.base), before)
  }
})

test('an explicit project missing its catalog reports the file and leaves the source untouched', (t) => {
  const f = fixture(t)
  const catalog = path.join(f.project, 'data/dramas.json')
  fs.unlinkSync(catalog)
  const before = snapshot(f.base)
  const result = f.run([path.relative(f.cwd, f.source), '--project', f.project, '--apply'])
  assert.ifError(result.error)
  assert.notEqual(result.status, 0)
  assert.ok(result.stderr.includes(catalog), result.stderr)
  assert.match(result.stderr, /项目|网站|目录/)
  assert.deepEqual(snapshot(f.base), before)
})
