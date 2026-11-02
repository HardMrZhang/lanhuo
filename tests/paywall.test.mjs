import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FREE_EPISODES, PAYWALL_START_EPISODE, isEpisodeLocked, lockedMediaPaths, mediaPathOf } from '../server/access.js'

const clientAccess = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/access.ts'), 'utf8')

const dramas = [
  {
    id: 'demo',
    episodes: [
      { no: 1, src: '/media/imported/demo/episode-1.mp4' },
      { no: 2, src: '/media/imported/demo/episode-2.mp4' },
      { no: 3, src: '/media/imported/demo/episode-3.mp4?token=1' },
      { no: 4, src: 'https://cdn.example/episode-4.mp4' },
    ],
  },
]

test('episode 1 stays free and every later episode is paid', () => {
  assert.equal(FREE_EPISODES, 1)
  assert.equal(PAYWALL_START_EPISODE, 2)
  assert.equal(isEpisodeLocked(1), false)
  assert.equal(isEpisodeLocked(2), true)
  assert.equal(isEpisodeLocked(9), true)
  assert.equal(isEpisodeLocked(Number.NaN), false)
})

test('the client keeps the same paywall constants as the server', () => {
  assert.match(clientAccess, new RegExp(`FREE_EPISODES = ${FREE_EPISODES}\\b`))
  assert.match(clientAccess, /PAYWALL_START_EPISODE = FREE_EPISODES \+ 1/)
  assert.match(clientAccess, /no >= PAYWALL_START_EPISODE/)
})

test('only same-origin media paths can be gated', () => {
  assert.equal(mediaPathOf('/media/a/b.mp4'), '/a/b.mp4')
  assert.equal(mediaPathOf('/media/a/b.mp4?x=1#t'), '/a/b.mp4')
  assert.equal(mediaPathOf('https://cdn.example/a.mp4'), null)
  assert.equal(mediaPathOf('/posters/a.jpg'), null)
  assert.equal(mediaPathOf(undefined), null)
})

test('locked media paths skip the free episode and external sources', () => {
  assert.deepEqual([...lockedMediaPaths(dramas)].sort(), ['/imported/demo/episode-2.mp4', '/imported/demo/episode-3.mp4'])
  assert.equal(lockedMediaPaths([]).size, 0)
  assert.equal(lockedMediaPaths(undefined).size, 0)
})
