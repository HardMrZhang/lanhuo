#!/usr/bin/env bash
# 单档 HLS（按源分辨率封顶，只压一档，速度约为三档同压的 2~3 倍）。
#
# 规则（按短边 min(宽,高)，横竖屏通用，绝不放大）：
#   短边>=1000 -> 封顶 1080（3500k, high）
#   短边>=700  -> 封顶 720（1800k, main）
#   其他       -> 封顶 480 且不放大（800k, main）
#
# 用法（不变）:
#   npm run hls -- <输入.mp4> <输出目录>
#   例: npm run hls -- ~/Videos/ep01.mp4 media/my-drama/ep01
# 输出:
#   <输出目录>/index.m3u8 + seg_*.ts（hls.js 可直接播，和旧三档输出同路径可混存）
# 然后在 data/dramas.json 里把 src 写成 S3 的 .../episode-N/index.m3u8
set -euo pipefail

IN="${1:?用法: to-hls.sh <输入.mp4> <输出目录>}"
OUT="${2:?用法: to-hls.sh <输入.mp4> <输出目录>}"
command -v ffmpeg >/dev/null || { echo "需要 ffmpeg: brew install ffmpeg"; exit 1; }
command -v ffprobe >/dev/null || { echo "需要 ffprobe（随 ffmpeg 安装）"; exit 1; }

mkdir -p "$OUT"

# 探测源分辨率（短边决定档位；竖屏短边=宽，横屏短边=高）
W="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$IN")"
H="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$IN")"
SHORT="$(( W < H ? W : H ))"

if [[ "$SHORT" -ge 1000 ]]; then
  T=1080; BV=3500k; MAXRATE=3800k; BUF=7000k; PROF=high
elif [[ "$SHORT" -ge 700 ]]; then
  T=720; BV=1800k; MAXRATE=2000k; BUF=3600k; PROF=main
else
  T=480; BV=800k; MAXRATE=900k; BUF=1600k; PROF=main
fi
echo "源 ${W}x${H}（短边 ${SHORT}）-> 封顶 ${T}p (${BV})"

# 横屏定高、竖屏定宽，且 min(iw|ih,T) 保证只缩小不放大；setsar=1 防非方形像素拉伸。
ffmpeg -y -nostdin -hide_banner -loglevel warning -stats -i "$IN" \
  -vf "scale=w='if(gt(iw,ih),-2,min(iw,${T}))':h='if(gt(iw,ih),min(ih,${T}),-2)',setsar=1" \
  -c:v libx264 -preset veryfast -profile:v "$PROF" -b:v "$BV" -maxrate:v "$MAXRATE" -bufsize:v "$BUF" \
  -c:a aac -b:a 128k -ac 2 \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -f hls -hls_time 4 -hls_playlist_type vod -hls_flags independent_segments \
  -hls_segment_filename "$OUT/seg_%04d.ts" \
  "$OUT/index.m3u8"

echo
echo "完成 → $OUT/index.m3u8"
