import test from 'node:test'
import assert from 'node:assert/strict'
import { posterKeyOf, posterContentType } from '../server/s3posters.js'

test('poster key only accepts local drama jpg covers', () => {
  assert.equal(posterKeyOf({ file: 'local-5c48fb6b989bf43d.jpg' }), 'posters/imported/local-5c48fb6b989bf43d.jpg')
  assert.equal(posterKeyOf({ file: 'local-5C48FB6B989BF43D.jpg' }), null)
  assert.equal(posterKeyOf({ file: 'local-5c48fb6b989bf43d.svg' }), null)
  assert.equal(posterKeyOf({ file: '../../etc/passwd' }), null)
  assert.equal(posterKeyOf({ file: 'index.html' }), null)
  assert.equal(posterKeyOf({}), null)
  assert.equal(posterKeyOf(undefined), null)
})

test('poster key also accepts the webp thumbnails', () => {
  assert.equal(posterKeyOf({ file: 'local-5c48fb6b989bf43d.webp' }), 'posters/imported/local-5c48fb6b989bf43d.webp')
  assert.equal(posterKeyOf({ file: 'local-5C48FB6B989BF43D.webp' }), null)
  assert.equal(posterKeyOf({ file: 'local-5c48fb6b989bf43d.exe' }), null)
})

test('poster content type follows the file extension', () => {
  assert.equal(posterContentType('a.jpg'), 'image/jpeg')
  assert.equal(posterContentType('a.jpeg'), 'image/jpeg')
  assert.equal(posterContentType('a.png'), 'image/png')
  assert.equal(posterContentType('a.webp'), 'image/webp')
  assert.equal(posterContentType('a.bin'), 'application/octet-stream')
})
