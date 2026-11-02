import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'

const BUCKET = process.env.S3_BUCKET || 'duanju-h5-hls-473041657070'
const REGION = process.env.AWS_REGION || 'ap-northeast-1'
const PREFIX = (process.env.S3_PREFIX || 'hls').replace(/^\/+|\/+$/g, '')

// 凭证走 .env 的 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY（node --env-file-if-exists=.env 已加载）。
// 这里不打日志、不回显密钥。
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

const DRAMA_RE = /^local-[a-f0-9]{16}$/
const EP_RE = /^episode-(\d+)$/
const FILE_RE = /^(index\.m3u8|seg_\d+\.ts)$/

export function s3KeyOf(params) {
  const { id, ep, file } = params
  if (!DRAMA_RE.test(id) || !EP_RE.test(ep) || !FILE_RE.test(file)) return null
  return `${PREFIX}/${id}/${ep}/${file}`
}

export function contentTypeOf(file) {
  if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl'
  if (file.endsWith('.ts')) return 'video/mp2t'
  return 'application/octet-stream'
}

/**
 * 私有桶中转：GET /s3-hls/:id/:ep/:file
 * - 用服务端 IAM 凭证 GetObject，桶保持私有（组织 SCP 禁公开也能播）。
 * - 第 2 集起走 isVip 鉴权（调用方传入），与 /media 付费策略一致。
 */
export function createS3HlsHandler({ isEpisodeLocked, checkVip }) {
  return async (req, res, next) => {
    try {
      const key = s3KeyOf(req.params)
      if (!key) return res.status(404).json({ error: 'not found' })
      const epMatch = EP_RE.exec(req.params.ep)
      const epNo = Number(epMatch?.[1])
      if (isEpisodeLocked(epNo)) {
        let ok = false
        try {
          ok = await checkVip(req)
        } catch (e) {
          return next(e)
        }
        if (!ok) {
          res.set('Cache-Control', 'no-store')
          return res.status(403).json({ error: '该集为 VIP 专享，请先开通会员' })
        }
        res.set('Cache-Control', 'private, no-store')
      } else if (req.params.file.endsWith('.m3u8')) {
        res.set('Cache-Control', 'public, max-age=10')
      } else {
        res.set('Cache-Control', 'public, max-age=31536000, immutable')
      }
      res.set('Content-Type', contentTypeOf(req.params.file))
      res.set('Accept-Ranges', 'bytes')

      const range = req.headers.range
      if (range && !/^bytes=\d*-\d*$/.test(range)) {
        return res.status(416).end()
      }
      const cmd = new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ...(range ? { Range: range } : {}),
      })
      const out = await s3.send(cmd)
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
