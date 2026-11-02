import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importDownloads, parseMetadata } from '../scripts/import-downloads.mjs'

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const videoInfo = { duration: 12.5, width: 720, height: 1280 }

function description(title = '山间书店') {
  return [
    '首页', '导航内容不应进入简介', '作品简介',
    '一位店主在山间开了一间书店。',
    '读者们通过书信分享各自的生活。',
    `《${title}》共3集，本剧持续更新，完整选集可从本页进入播放。`,
    '展开 ▾', '作品评分', '8.6', '作品标签', '日常', '温暖', '日常',
    '作品资料', '状态', '已完结', '热度', '1.2万', '发布', '2026-09-01',
    '选集', '第1集', '页脚内容不应进入简介',
  ].join('\n')
}

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'duanju-import-test-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'project')
  const source = path.join(base, 'downloads')
  const manifest = path.join(base, 'manifest.json')
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.mkdirSync(source)
  const initial = `${JSON.stringify({ categories: [{ id: 'demo', name: '演示' }], dramas: [{ id: 'demo-1', title: '原有演示' }] }, null, 2)}\n`
  fs.writeFileSync(path.join(root, 'data/dramas.json'), initial)
  const entries = []
  const writeManifest = () => fs.writeFileSync(manifest, JSON.stringify({ version: 1, entries }))
  function addWork({ title = '山间书店', channel = '成人短剧', episodes = [1, 3], expected = [1, 2, 3] } = {}) {
    const directory = path.join(source, channel, title)
    fs.mkdirSync(directory, { recursive: true })
    const metadataFile = path.join(directory, 'metadata.json')
    const metadata = { title, category: channel, description: description(title), episodes: expected.map((episode) => ({ episode })) }
    const text = JSON.stringify(metadata)
    fs.writeFileSync(metadataFile, text)
    for (const no of episodes) fs.writeFileSync(path.join(directory, `第${String(no).padStart(2, '0')}集.mp4`), 'placeholder; injected probe only')
    const entry = { relativePath: path.relative(source, metadataFile).split(path.sep).join('/'), metadataSha256: sha256(text), decision: 'include' }
    entries.push(entry)
    writeManifest()
    return { directory, metadataFile, metadata, entry }
  }
  const probeCalls = []
  const probe = (file) => { probeCalls.push(file); return { ...videoInfo } }
  const run = (options = {}) => importDownloads({ source, root, manifest, probe, ...options })
  const readCatalog = () => JSON.parse(fs.readFileSync(path.join(root, 'data/dramas.json'), 'utf8'))
  return { base, root, source, manifest, initial, entries, writeManifest, addWork, run, readCatalog, probeCalls }
}

function snapshot(directory) {
  const result = {}
  function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name)
      const relative = path.relative(directory, file)
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) result[relative] = `link:${fs.readlinkSync(file)}`
      else if (stat.isDirectory()) { result[relative] = 'directory'; walk(file) }
      else result[relative] = fs.readFileSync(file).toString('base64')
    }
  }
  walk(directory)
  return result
}

test('metadata parser keeps the introduction and removes navigation, footer and template copy', () => {
  const parsed = parseMetadata({ description: description().replaceAll('\n', '\r\n') })
  assert.equal(parsed.description, '一位店主在山间开了一间书店。\n读者们通过书信分享各自的生活。')
  assert.deepEqual(parsed.tags, ['日常', '温暖'])
  assert.equal(parsed.status, 'completed')
  assert.equal(parsed.views, 12000)
  assert.equal(parsed.rating, 86)
  assert.equal(parsed.publishedAt, '2026-09-01T00:00:00+08:00')
  const withoutCount = description().replace('共3集，本剧持续更新，', '成人漫剧，')
  assert.equal(parseMetadata({ description: withoutCount }).description, parsed.description)
})

test('dry run validates both channels and leaves all fixture files unchanged', (t) => {
  const f = fixture(t)
  f.addWork()
  f.addWork({ title: '星河邮局', channel: '成人漫剧', episodes: [2], expected: [2] })
  const before = snapshot(f.base)
  const report = f.run()
  assert.equal(report.importedWorks, 2)
  assert.equal(report.importedEpisodes, 3)
  assert.deepEqual(report.channels, { shorts: { works: 1, episodes: 2 }, anime: { works: 1, episodes: 1 } })
  assert.deepEqual(snapshot(f.base), before)
})

test('apply preserves original episode numbers, creates confined links and backs up the original catalog', (t) => {
  const f = fixture(t)
  const work = f.addWork()
  f.run({ apply: true })
  const catalog = f.readCatalog()
  const drama = catalog.dramas.find((item) => item.id.startsWith('local-'))
  assert.equal(drama.channelId, 'shorts')
  assert.deepEqual(drama.categoryIds, ['shorts'])
  assert.deepEqual(drama.episodes.map((episode) => episode.no), [1, 3])
  assert.deepEqual(drama.episodes.map((episode) => episode.title), ['第1集', '第3集'])
  assert.equal(drama.status, 'ongoing')
  assert.equal(drama.episodes[0].duration, 12.5)
  assert.equal(drama.hd, true)
  assert.ok(catalog.dramas.some((item) => item.id === 'demo-1'))
  for (const episode of drama.episodes) {
    const link = path.join(f.root, episode.src)
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    assert.equal(fs.realpathSync(link), path.join(work.directory, `第${String(episode.no).padStart(2, '0')}集.mp4`))
  }
  assert.ok(fs.existsSync(path.join(f.root, 'public', drama.cover)))
  const backups = fs.readdirSync(path.join(f.root, 'data/backups'))
  assert.equal(backups.length, 1)
  assert.equal(fs.readFileSync(path.join(f.root, 'data/backups', backups[0]), 'utf8'), f.initial)
})

test('repeating an import keeps catalog, backups, posters and links identical', (t) => {
  const f = fixture(t)
  f.addWork()
  const firstReport = f.run({ apply: true })
  const afterFirst = snapshot(f.root)
  const secondReport = f.run({ apply: true })
  assert.deepEqual(secondReport, firstReport)
  assert.deepEqual(snapshot(f.root), afterFirst)
})

test('fragments and invalid MP4 files are skipped without renumbering usable episodes', (t) => {
  const f = fixture(t)
  const work = f.addWork({ episodes: [1, 2, 3] })
  for (const name of ['第04集.mp4.part', '第05集.mp4.tmp', '第06集.ts']) fs.writeFileSync(path.join(work.directory, name), 'fragment')
  const calls = []
  const report = f.run({ apply: true, probe: (file) => { calls.push(path.basename(file)); return file.endsWith('第02集.mp4') ? null : videoInfo } })
  assert.deepEqual(calls, ['第01集.mp4', '第02集.mp4', '第03集.mp4'])
  assert.equal(report.importedEpisodes, 2)
  assert.deepEqual(report.incompleteFiles, [path.join('成人短剧', '山间书店', '第02集.mp4')])
  assert.deepEqual(f.readCatalog().dramas[0].episodes.map((episode) => episode.no), [1, 3])
})

test('unreviewed metadata changes and excluded works are skipped before probing', (t) => {
  const f = fixture(t)
  f.addWork()
  const changed = f.addWork({ title: '雨后钟楼', episodes: [1] })
  fs.appendFileSync(changed.metadataFile, '\n')
  const excluded = f.addWork({ title: '林间驿站', episodes: [1] })
  excluded.entry.decision = 'exclude'
  excluded.entry.reason = 'not_reviewed'
  f.writeManifest()
  const report = f.run()
  assert.equal(report.importedWorks, 1)
  assert.deepEqual(report.skipped, [
    { relativePath: changed.entry.relativePath, reason: 'metadata_changed' },
    { relativePath: excluded.entry.relativePath, reason: 'not_reviewed' },
  ])
  assert.equal(f.probeCalls.length, 2)
  assert.ok(f.probeCalls.every((file) => file.includes('山间书店')))
})

test('a video symlink within the source is accepted and an escaping video symlink is rejected', (t) => {
  const f = fixture(t)
  const work = f.addWork({ episodes: [1], expected: [1] })
  const file = path.join(work.directory, '第01集.mp4')
  const inside = path.join(f.source, 'shared.mp4')
  fs.renameSync(file, inside)
  fs.symlinkSync(inside, file)
  assert.equal(f.run().importedEpisodes, 1)
  assert.deepEqual(f.probeCalls, [inside])
  const outside = path.join(f.base, 'outside.mp4')
  fs.writeFileSync(outside, 'outside placeholder')
  fs.unlinkSync(file)
  fs.symlinkSync(outside, file)
  assert.throws(() => f.run(), /视频路径超出下载目录/)
  assert.equal(f.probeCalls.length, 1)
})

test('metadata symlinks must not escape the source directory', (t) => {
  const f = fixture(t)
  const work = f.addWork({ episodes: [1], expected: [1] })
  const outside = path.join(f.base, 'outside-metadata.json')
  fs.renameSync(work.metadataFile, outside)
  fs.symlinkSync(outside, work.metadataFile)
  const before = snapshot(f.base)
  assert.throws(() => f.run({ apply: true }), /(?:清单|元数据|metadata).*路径.*超出|路径超出下载目录/)
  assert.deepEqual(snapshot(f.base), before)
  assert.equal(f.probeCalls.length, 0)
})

test('duplicate numeric episode numbers are rejected before changing project files', (t) => {
  const f = fixture(t)
  const work = f.addWork({ episodes: [1] })
  fs.writeFileSync(path.join(work.directory, '第1集.mp4'), 'duplicate placeholder')
  const before = snapshot(f.root)
  assert.throws(() => f.run({ apply: true }), /集号无效或重复/)
  assert.deepEqual(snapshot(f.root), before)
})

test('metadata-only works are imported with no fake episodes or HD flag', (t) => {
  const f = fixture(t)
  const work = f.addWork({ episodes: [1] })
  const report = f.run({ apply: true, probe: () => null })
  const drama = f.readCatalog().dramas[0]
  assert.equal(report.importedWorks, 1)
  assert.equal(report.importedEpisodes, 0)
  assert.equal(report.playableWorks, 0)
  assert.deepEqual(report.awaitingVideo, [{ relativePath: work.entry.relativePath, reason: 'no_complete_episodes' }])
  assert.equal(drama.description, parseMetadata(work.metadata).description)
  assert.deepEqual(drama.episodes, [])
  assert.equal(drama.hd, false)
  assert.equal(drama.status, 'ongoing')
  assert.match(fs.readFileSync(path.join(f.root, 'public', drama.cover), 'utf8'), /剧集待更新/)
})

test('a channel mismatch and an empty approved catalog are rejected without changing files', (t) => {
  const f = fixture(t)
  const work = f.addWork({ episodes: [1] })
  const before = snapshot(f.root)
  work.entry.decision = 'exclude'
  f.writeManifest()
  assert.throws(() => f.run({ apply: true }), /没有可导入的资料/)
  assert.deepEqual(snapshot(f.root), before)
  work.entry.decision = 'include'
  work.metadata.category = '成人漫剧'
  const text = JSON.stringify(work.metadata)
  fs.writeFileSync(work.metadataFile, text)
  work.entry.metadataSha256 = sha256(text)
  f.writeManifest()
  assert.throws(() => f.run({ apply: true }), /目录与栏目不匹配/)
  assert.deepEqual(snapshot(f.root), before)
})

test('a selected local photo cover survives future imports unchanged', (t) => {
  const f = fixture(t)
  f.addWork()
  f.run({ apply: true })
  const drama = f.readCatalog().dramas[0]
  const imagePath = `/posters/imported/${drama.id}.jpg`
  const file = path.join(f.root, 'public', imagePath)
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  fs.writeFileSync(file, bytes)
  const report = f.run({ apply: true })
  assert.equal(f.readCatalog().dramas[0].cover, imagePath)
  assert.deepEqual(fs.readFileSync(file), bytes)
  assert.equal(report.imageCovers, 1)
})

test('excluding a previously imported work removes its public assets but keeps source files', (t) => {
  const f = fixture(t)
  const retired = f.addWork()
  f.addWork({ title: '雨后钟楼' })
  f.run({ apply: true })
  const drama = f.readCatalog().dramas.find((d) => d.title === retired.metadata.title)
  const sourceBefore = snapshot(f.source)
  retired.entry.decision = 'exclude'
  f.writeManifest()
  f.run({ apply: true })
  assert.ok(!f.readCatalog().dramas.some((d) => d.id === drama.id))
  assert.ok(!fs.existsSync(path.join(f.root, 'public', drama.cover)))
  for (const episode of drama.episodes) assert.ok(!fs.existsSync(path.join(f.root, episode.src)))
  assert.deepEqual(snapshot(f.source), sourceBefore)
})
