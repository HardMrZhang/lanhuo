import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import fs from 'node:fs'
const s3=new S3Client({region:process.env.AWS_REGION||'ap-northeast-1',credentials:{accessKeyId:process.env.AWS_ACCESS_KEY_ID,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY}})
const id=process.argv[2], ep=process.argv[3], segIdx=process.argv[4]||'seg_0000.ts', out=process.argv[5]
const key=`hls/${id}/${ep}/${segIdx}`
const r=await s3.send(new GetObjectCommand({Bucket:'duanju-h5-hls-473041657070',Key:key}))
fs.writeFileSync(out, Buffer.from(await r.Body.transformToByteArray()))
console.log('saved',out,key)
