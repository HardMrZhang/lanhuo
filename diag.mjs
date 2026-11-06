import { createHash, randomBytes } from 'node:crypto'

const base = process.env.VAEHUB_API_BASE
const appTag = process.env.VAEHUB_APP_TAG
const appKey = process.env.VAEHUB_APP_KEY
const appSecret = process.env.VAEHUB_APP_SECRET
const timestamp = String(Math.floor(Date.now() / 1000))
const nonce = randomBytes(8).toString('hex')
const signature = createHash('sha256').update(`${appKey}${timestamp}${nonce}${appSecret}`).digest('hex')
const auth = `Bearer ${Buffer.from(`${appTag}:${timestamp}:${appKey}:${nonce}:${signature}`, 'utf8').toString('base64')}`

const body = {
  order_id: 'diag-' + randomBytes(6).toString('hex'),
  country: process.env.VAEHUB_COUNTRY,
  currency: process.env.VAEHUB_CURRENCY,
  amount: 10,
  return_type: process.env.VAEHUB_RETURN_TYPE,
  user_hash: createHash('sha256').update('diag-user').digest('hex').slice(0, 32),
  callback_url: 'https://your-domain.example/api/payments/vaehub/notify',
}

for (let round = 1; round <= 5; round++) {
  const t0 = Date.now()
  try {
    const res = await fetch(`${base}/v1/trade/payin`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    console.log(`#${round} ${Date.now() - t0}ms HTTP ${res.status} -> ${text.slice(0, 120)}`)
  } catch (e) {
    console.log(`#${round} ${Date.now() - t0}ms ERROR: ${e?.message} / ${e?.cause?.message || ''}`)
  }
}
