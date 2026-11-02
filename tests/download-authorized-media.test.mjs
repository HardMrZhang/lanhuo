import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { downloadAuthorizedMedia, parseDownloadManifest } from '../scripts/download-authorized-media.mjs'

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'authorized-media-'))
  return { directory, close: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

function item(overrides = {}) {
  return { title: '授权短剧', episode: 1, url: 'https://media.example/episode.mp4?signature=one-time', ...overrides }
}

const mp4 = Buffer.from('\u0000\u0000\u0000\u0018ftypisom authorized video bytes')

test('manifest accepts official HTTPS links and rejects unsafe or duplicate entries', () => {
  const items = parseDownloadManifest({ version: 1, items: [item({ title: '../授权短剧' })] })
  assert.equal(items[0].title, '.._授权短剧')
  assert.throws(() => parseDownloadManifest({ version: 1, items: [item({ url: 'http://media.example/file.mp4' })] }), /HTTPS/)
  assert.throws(() => parseDownloadManifest({ version: 1, items: [item(), item()] }), /重复/)
})

test('downloads a signed MP4, follows only HTTPS redirects, and never overwrites files', async () => {
  const temp = fixture()
  try {
    const requests = []
    const fetchImpl = async (url, options) => {
      requests.push({ url: String(url), redirect: options.redirect, headers: options.headers })
      if (requests.length === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/episode.mp4?signature=two' } })
      return new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
    }
    const result = await downloadAuthorizedMedia([item()], temp.directory, { fetchImpl })
    assert.equal(result[0].bytes, mp4.length)
    assert.deepEqual(fs.readFileSync(result[0].path), mp4)
    assert.deepEqual(requests.map(({ url, redirect }) => [url, redirect]), [
      ['https://media.example/episode.mp4?signature=one-time', 'manual'],
      ['https://cdn.example/episode.mp4?signature=two', 'manual'],
    ])
    assert.equal(requests[0].headers.Authorization, undefined)
    await assert.rejects(downloadAuthorizedMedia([item()], temp.directory, { fetchImpl }), /已存在/)
  } finally { temp.close() }
})

test('rejects HTML, partial responses, HTTP redirects, and oversized video without leaving partial files', async () => {
  const temp = fixture()
  try {
    await assert.rejects(downloadAuthorizedMedia([item()], temp.directory, {
      fetchImpl: async () => new Response('<html>login</html>', { headers: { 'content-type': 'application/octet-stream' } }),
    }), /不是 MP4/)
    await assert.rejects(downloadAuthorizedMedia([item()], temp.directory, {
      fetchImpl: async () => new Response(mp4, { status: 206, headers: { 'content-type': 'video/mp4' } }),
    }), /HTTP 200/)
    await assert.rejects(downloadAuthorizedMedia([item()], temp.directory, {
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://cdn.example/file.mp4' } }),
    }), /HTTPS/)
    await assert.rejects(downloadAuthorizedMedia([item()], temp.directory, {
      maxBytes: 5,
      fetchImpl: async () => new Response(Buffer.concat([mp4, Buffer.alloc(20)]), { headers: { 'content-type': 'video/mp4' } }),
    }), /大小上限/)
    assert.deepEqual(fs.readdirSync(path.join(temp.directory, '授权短剧')), [])
  } finally { temp.close() }
})

test('continues after an item fails and can resume by skipping completed downloads', async () => {
  const temp = fixture()
  try {
    const items = [item(), item({ episode: 2, url: 'https://media.example/episode-2.mp4' })]
    const fetchImpl = async (url) => String(url).includes('episode-2')
      ? new Response('<html>temporarily unavailable</html>', { headers: { 'content-type': 'video/mp4' } })
      : new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
    const firstRun = await downloadAuthorizedMedia(items, temp.directory, { fetchImpl, continueOnError: true })
    assert.deepEqual(firstRun.map((result) => result.status), ['downloaded', 'failed'])
    const retry = await downloadAuthorizedMedia(items, temp.directory, { skipExisting: true, fetchImpl, continueOnError: true })
    assert.deepEqual(retry.map((result) => result.status), ['skipped', 'failed'])
    fs.writeFileSync(path.join(temp.directory, '授权短剧', '第03集.mp4'), 'not a video')
    const invalidExisting = await downloadAuthorizedMedia([item({ episode: 3 })], temp.directory, {
      skipExisting: true,
      continueOnError: true,
      fetchImpl,
    })
    assert.equal(invalidExisting[0].status, 'failed')
    assert.match(invalidExisting[0].error, /不是 MP4/)
  } finally { temp.close() }
})
