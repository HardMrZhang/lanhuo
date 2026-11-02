#!/usr/bin/env bash
# 新批：py_project/download -> hls-output（只转码不上传不入库）
# 目录结构：顶层剧名目录/第00N集.mp4
# ID规则：local-<sha256('py-download/<剧目录>/metadata.json')[:16]>，与入库脚本同源。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="${1:-/Users/zhangchaoyin/zhangzhaoyin/py_project/download}"
OUT="${2:-$ROOT/hls-output}"
cd "$ROOT"
count=0; skipped=0; failed=0
total="$(find "$SRC" -type f -name '第*.mp4' | wc -l | tr -d ' ')"
echo "SRC=$SRC OUT=$OUT 共 $total 个 mp4"
for dir in "$SRC"/*/; do
  [ -d "$dir" ] || continue
  work="$(basename "$dir")"
  relpath="py-download/$work/metadata.json"
  id_hash="$(printf '%s' "$relpath" | shasum -a 256 | cut -c1-16)"
  drama_id="local-$id_hash"
  for mp4 in "$dir"第*.mp4; do
    [ -f "$mp4" ] || continue
    fname="$(basename "$mp4")"
    if [[ ! "$fname" =~ ^第0*([0-9]+)集\.mp4$ ]]; then
      echo "跳过（集号解析失败）：$mp4"; failed=$((failed+1)); continue
    fi
    no="${BASH_REMATCH[1]}"
    dest="$OUT/$drama_id/episode-$no"
    if [[ -f "$dest/index.m3u8" ]]; then skipped=$((skipped + 1)); continue; fi
    count=$((count+1))
    echo "[$count/$total] 转码 $work/$fname -> $drama_id/episode-$no"
    if ! npm run hls -- "$mp4" "$dest" --silent; then
      echo "转码失败：$mp4"; failed=$((failed+1))
    fi
  done
done
echo "转码完成 新增=${count} 跳过(已有)=${skipped} 失败=${failed}"
