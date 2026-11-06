import test from 'node:test'
import assert from 'node:assert/strict'
import { s3KeyOf, contentTypeOf } from '../server/s3hls.js'

const ID = 'local-0bab598161cda023'

test('single-tier HLS keeps the flat key layout', () => {
  assert.equal(
    s3KeyOf({ id: ID, ep: 'episode-1', file: 'index.m3u8' }),
    `hls/${ID}/episode-1/index.m3u8`,
  )
  assert.equal(
    s3KeyOf({ id: ID, ep: 'episode-2', file: 'seg_0007.ts' }),
    `hls/${ID}/episode-2/seg_0007.ts`,
  )
})

test('multi-tier HLS nests the tier directory', () => {
  assert.equal(
    s3KeyOf({ id: ID, ep: 'episode-1', tier: '720p', file: 'index.m3u8' }),
    `hls/${ID}/episode-1/720p/index.m3u8`,
  )
  assert.equal(
    s3KeyOf({ id: ID, ep: 'episode-1', tier: '480p', file: 'seg_0000.ts' }),
    `hls/${ID}/episode-1/480p/seg_0000.ts`,
  )
})

test('malformed ids, episodes, tiers and file names are rejected', () => {
  assert.equal(s3KeyOf({ id: 'demo', ep: 'episode-1', file: 'index.m3u8' }), null)
  assert.equal(s3KeyOf({ id: ID, ep: 'ep-1', file: 'index.m3u8' }), null)
  assert.equal(s3KeyOf({ id: ID, ep: 'episode-1', file: '../secret.m3u8' }), null)
  assert.equal(s3KeyOf({ id: ID, ep: 'episode-1', file: 'index.m3u8.bak' }), null)
  assert.equal(s3KeyOf({ id: ID, ep: 'episode-1', tier: '360p', file: 'index.m3u8' }), null)
  assert.equal(s3KeyOf({ id: ID, ep: 'episode-1', tier: '..', file: 'index.m3u8' }), null)
})

test('content type follows the file extension', () => {
  assert.equal(contentTypeOf('index.m3u8'), 'application/vnd.apple.mpegurl')
  assert.equal(contentTypeOf('seg_0000.ts'), 'video/mp2t')
  assert.equal(contentTypeOf('other.bin'), 'application/octet-stream')
})
