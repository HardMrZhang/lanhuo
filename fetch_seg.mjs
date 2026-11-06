import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import fs from 'node:fs'
const s3=new S3Client({region:process.env.AWS_REGION||'ap-southeast-1',credentials:{accessKeyId:process.env.AWS_ACCESS_KEY_ID,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY}})
const id=process.argv[2], ep=process.argv[3]
const out=process.argv[4]
const key=`hls/${id}/${ep}/index.m3u8`
const r=await s3.send(new GetObjectCommand({Bucket:'duanju-h5-hls-473041657070',Key:key}))
const txt=await r.Body.transformToString()
console.log(txt.split('\n').slice(0,12).join('\n'))
const m=txt.match(/([\w\-.]+\.ts)/)
if(!m) { console.log('no ts'); process.exit(0) }
const seg=`hls/${id}/${ep}/${m[1]}`
const r2=await s3.send(new GetObjectCommand({Bucket:'duanju-h5-hls-473041657070',Key:seg}))
fs.writeFileSync(out, Buffer.from(await r2.Body.transformToByteArray()))
console.log('saved',out, seg)
