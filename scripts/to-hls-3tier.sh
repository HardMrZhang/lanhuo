#!/usr/bin/env bash
# 三档 HLS 转码（1080p / 720p / 480p）+ 主播放清单。
# 与项目里已有的三档 HLS 产物结构保持一致：
#   <输出目录>/index.m3u8          主清单（多码率）
#   <输出目录>/1080p/index.m3u8     单码率清单 + seg_*.ts
#   <输出目录>/720p/index.m3u8
#   <输出目录>/480p/index.m3u8
#
# 档位规则与 scripts/to-hls.sh 一致：按源短边封顶，绝不放大。
#
# 用法:
#   bash scripts/to-hls-3tier.sh <输入.mp4> <输出目录>
set -euo pipefail

IN="${1:?用法: to-hls-3tier.sh <输入.mp4> <输出目录>}"
OUT="${2:?用法: to-hls-3tier.sh <输入.mp4> <输出目录>}"
command -v ffmpeg >/dev/null || { echo "需要 ffmpeg: brew install ffmpeg"; exit 1; }

W="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$IN")"
H="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$IN")"
SHORT="$(( W < H ? W : H ))"
echo "源 ${W}x${H}（短边 ${SHORT}）-> $OUT"

# 档位表：名称|目标短边|码率|最大码率|缓冲|profile
TIERS=(
  "1080p|1080|3500k|3800k|7000k|high"
  "720p|720|1800k|2000k|3600k|main"
  "480p|480|800k|900k|1600k|main"
)

for tier in "${TIERS[@]}"; do
  IFS='|' read -r name target bv maxrate buf prof <<<"$tier"
  # 短边不足该档位时降到下一档；且绝不放大
  if [[ "$SHORT" -lt "$target" ]]; then continue; fi
  dest="$OUT/$name"
  mkdir -p "$dest"
  # 横屏定高、竖屏定宽，min(iw|ih,T) 保证只缩小不放大
  ffmpeg -y -nostdin -hide_banner -loglevel error -stats -i "$IN" \
    -vf "scale=w='if(gt(iw,ih),-2,min(iw,${target}))':h='if(gt(iw,ih),min(ih,${target}),-2)',setsar=1" \
    -c:v libx264 -preset veryfast -profile:v "$prof" \
    -b:v "$bv" -maxrate:v "$maxrate" -bufsize:v "$buf" \
    -c:a aac -b:a 128k -ac 2 \
    -g 60 -keyint_min 60 -sc_threshold 0 \
    -f hls -hls_time 4 -hls_playlist_type vod -hls_flags independent_segments \
    -hls_segment_filename "$dest/seg_%04d.ts" "$dest/index.m3u8"
  echo "  $name -> $dest"
done

# 生成主清单（多码率）
cat > "$OUT/index.m3u8" <<'EOF'
#EXTM3U
#EXT-X-VERSION:6
EOF
for tier in "${TIERS[@]}"; do
  IFS='|' read -r name target bv maxrate buf prof <<<"$tier"
  [[ -f "$OUT/$name/index.m3u8" ]] || continue
  case "$name" in
    1080p) res="608x1080"; codecs='avc1.64001f,mp4a.40.2'; bw=4557872; avg=3754996 ;;
    720p)  res="406x720";  codecs='avc1.4d401e,mp4a.40.2'; bw=2457160; avg=2015559 ;;
    480p)  res="270x480";  codecs='avc1.4d4015,mp4a.40.2'; bw=1225760; avg=991351 ;;
  esac
  echo "#EXT-X-STREAM-INF:BANDWIDTH=$bw,AVERAGE-BANDWIDTH=$avg,RESOLUTION=$res,CODECS=\"$codecs\"" >> "$OUT/index.m3u8"
  echo "$name/index.m3u8" >> "$OUT/index.m3u8"
  echo "" >> "$OUT/index.m3u8"
done

echo "完成：$OUT/index.m3u8"
