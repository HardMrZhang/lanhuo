#!/usr/bin/env bash
# 把 mp4 转成多码率 HLS（自适应），显著减少弱网卡顿。
#
# 用法:
#   npm run hls -- <输入.mp4> <输出目录>
#   例: npm run hls -- ~/Videos/ep01.mp4 media/my-drama/ep01
# 输出:
#   <输出目录>/index.m3u8          主清单（自动选码率）
#   <输出目录>/{1080p,720p,480p}/  各档位分片
# 然后在 data/dramas.json 里把 src 写成 /media/my-drama/ep01/index.m3u8
set -euo pipefail

IN="${1:?用法: to-hls.sh <输入.mp4> <输出目录>}"
OUT="${2:?用法: to-hls.sh <输入.mp4> <输出目录>}"
command -v ffmpeg >/dev/null || { echo "需要 ffmpeg: brew install ffmpeg"; exit 1; }

mkdir -p "$OUT"/{1080p,720p,480p}

# 竖屏短剧常见 720x1280；这里按高度缩放，宽度自适应并保持偶数。
ffmpeg -y -hide_banner -loglevel warning -stats -i "$IN" \
  -filter_complex "[0:v]split=3[v1][v2][v3]; \
    [v1]scale=-2:1080[v1o]; [v2]scale=-2:720[v2o]; [v3]scale=-2:480[v3o]" \
  -map "[v1o]" -map 0:a? -c:v:0 libx264 -preset veryfast -profile:v:0 high -b:v:0 3500k -maxrate:v:0 3800k -bufsize:v:0 7000k \
  -map "[v2o]" -map 0:a? -c:v:1 libx264 -preset veryfast -profile:v:1 main -b:v:1 1800k -maxrate:v:1 2000k -bufsize:v:1 3600k \
  -map "[v3o]" -map 0:a? -c:v:2 libx264 -preset veryfast -profile:v:2 main -b:v:2 800k  -maxrate:v:2 900k  -bufsize:v:2 1600k \
  -c:a aac -b:a 128k -ac 2 \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -f hls -hls_time 4 -hls_playlist_type vod -hls_flags independent_segments \
  -hls_segment_filename "$OUT/%v/seg_%04d.ts" \
  -master_pl_name index.m3u8 \
  -var_stream_map "v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:480p" \
  "$OUT/%v/index.m3u8"

echo
echo "完成 → $OUT/index.m3u8"
