import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import fs from 'node:fs'
const s3=new S3Client({region:process.env.AWS_REGION||'ap-northeast-1',credentials:{accessKeyId:process.env.AWS_ACCESS_KEY_ID,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY}})
const id=process.argv[2], out=process.argv[3]
const key=`posters/imported/${id}.jpg`
try{
  const r=await s3.send(new GetObjectCommand({Bucket:'duanju-h5-hls-473041657070',Key:key}))
  fs.writeFileSync(out, Buffer.from(await r.Body.transformToByteArray()))
  console.log('saved',out,key)
}catch(e){ console.log('ERR',key,e.name) }
