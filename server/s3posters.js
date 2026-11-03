import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'

const BUCKET = process.env.S3_BUCKET || 'duanju-h5-hls-473041657070'
const REGION = process.env.AWS_REGION || 'ap-northeast-1'
const POSTER_PREFIX = (process.env.S3_POSTER_PREFIX || 'posters').replace(/^\/+|\/+$/g, '')

// 凭证走 .env 的 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY，不打日志、不回显。
const s3 = new S3Client({
  region: REGION,
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
        },
      }
    : {}),
})

const FILE_RE = /^local-[a-f0-9]{16}\.jpg$/

export function posterKeyOf(params) {
  const file = params?.file ?? ''
  if (!FILE_RE.test(file)) return null
  return `${POSTER_PREFIX}/imported/${file}`
}

export function posterContentType(file) {
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg'
  if (file.endsWith('.png')) return 'image/png'
  if (file.endsWith('.webp')) return 'image/webp'
  return 'application/octet-stream'
}

/**
 * 私有桶封面中转：GET /s3-posters/:file
 * - 封面与 HLS 同桶，桶策略禁止公开，故走服务端 GetObject 中转。
 * - 封面非付费内容，公开可访问，长缓存（内容不可变）。
 */
export function createS3PosterHandler() {
  return async (req, res, next) => {
    try {
      const key = posterKeyOf(req.params)
      if (!key) return res.status(404).json({ error: 'not found' })
      res.set('Cache-Control', 'public, max-age=31536000, immutable')
      res.set('Content-Type', posterContentType(req.params.file))
      res.set('Accept-Ranges', 'bytes')

      const range = req.headers.range
      if (range && !/^bytes=\d*-\d*$/.test(range)) {
        return res.status(416).end()
      }
      const out = await s3.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: key,
          ...(range ? { Range: range } : {}),
        }),
      )
      if (out.ContentLength != null) res.set('Content-Length', String(out.ContentLength))
      if (out.ContentRange) {
        res.status(206)
        res.set('Content-Range', out.ContentRange)
      }
      if (out.ETag) res.set('ETag', out.ETag)
      const body = out.Body
      if (body instanceof Readable) body.pipe(res)
      else if (body?.pipe) body.pipe(res)
      else if (body?.transformToWebStream) {
        const web = body.transformToWebStream()
        for await (const chunk of web) res.write(chunk)
        res.end()
      } else {
        res.end()
      }
    } catch (e) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NoSuchKey') {
        return res.status(404).json({ error: 'not found' })
      }
      next(e)
    }
  }
}
