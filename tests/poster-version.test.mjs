import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverIndex = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/index.js'),
  'utf8',
)

test('local poster paths get a cache-busting version parameter', () => {
  assert.match(serverIndex, /POSTER_PATH_RE/)
  assert.match(serverIndex, /\?v=\$\{POSTER_VERSION\}/)
  assert.match(serverIndex, /cover: versionedCover\(rest\.cover\)/)
  assert.match(serverIndex, /cover: versionedCover\(d\.cover\)/)
})

test('poster handler only serves long-lived cache for versioned requests', () => {
  assert.match(serverIndex, /app\.get\('\/posters\/imported\/:file', createS3PosterHandler\(\)\)/)
  const handler = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/s3posters.js'),
    'utf8',
  )
  assert.match(handler, /max-age=31536000, immutable/)
  assert.match(handler, /max-age=0, must-revalidate/)
})
