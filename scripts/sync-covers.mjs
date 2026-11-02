import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { designPoster, designedCoverPath } from './import-downloads.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } })
const catalogFile = path.join(root, 'data/dramas.json')
const sourcesFile = path.join(root, 'data/local-cover-sources.json')
const previous = fs.readFileSync(catalogFile, 'utf8')
const catalog = JSON.parse(previous)
const sources = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'))
const prepared = new Set([...(sources.selected ?? []), ...(sources.designed ?? [])].map((item) => item.cover))
const generated = []
let restored = 0
let changed = 0

function writeChanged(file, contents) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === contents) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, contents)
  fs.renameSync(temp, file)
}

for (const drama of catalog.dramas) {
  if (!/^local-[a-f0-9]{16}$/.test(drama.id)) continue
  const oldPlaceholder = `/posters/imported/${drama.id}.svg`
  const designedPath = designedCoverPath(drama.id)
  if (![oldPlaceholder, designedPath].includes(drama.cover)) continue
  const photoPath = `/posters/imported/${drama.id}.jpg`
  if (prepared.has(photoPath) && fs.existsSync(path.join(root, 'public', photoPath))) {
    drama.cover = photoPath
    restored++
    changed++
    continue
  }
  const { svg, background } = designPoster(drama, root)
  if (drama.cover !== designedPath) changed++
  drama.cover = designedPath
  generated.push({ file: path.join(root, 'public', designedPath), svg })
  const record = { id: drama.id, cover: designedPath, kind: 'designed', style: 'cinematic-v1', background }
  sources.designed ??= []
  const index = sources.designed.findIndex((item) => item.id === drama.id)
  if (index === -1) sources.designed.push(record)
  else sources.designed[index] = record
}

if (values.apply) {
  if (changed) {
    const digest = createHash('sha256').update(previous).digest('hex').slice(0, 16)
    writeChanged(path.join(root, 'data/backups', `dramas-${digest}.json`), previous)
  }
  // Assets are written before publishing references, so the hot-reloaded API never
  // points to a poster that has not been created yet.
  for (const { file, svg } of generated) writeChanged(file, svg)
  writeChanged(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`)
  writeChanged(sourcesFile, `${JSON.stringify(sources, null, 2)}\n`)
  const reportFile = path.join(root, 'data/local-import-report.json')
  if (fs.existsSync(reportFile)) {
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
    report.imageCovers = catalog.dramas.filter((drama) => drama.cover.endsWith('.jpg')).length
    report.designedSvgCovers = catalog.dramas.filter((drama) => drama.cover.endsWith('.designed-v1.svg')).length
    writeChanged(reportFile, `${JSON.stringify(report, null, 2)}\n`)
  }
}

console.log(JSON.stringify({ mode: values.apply ? 'applied' : 'preview', restoredPhotos: restored,
  designedPosters: generated.length, changedReferences: changed }, null, 2))
