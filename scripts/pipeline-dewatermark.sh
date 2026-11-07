#!/usr/bin/env bash
# 成人短剧/漫剧 去水印 -> 重转 HLS -> 重传 S3 的完整流水线。
#
# 步骤：
#   1. 去水印：media/imported -> media/clean（scripts/wm_clean_batch.py）
#   1b. 重建旧产物：用旧版算法生成的 clean 文件重跑（scripts/wm_clean_rebuild_stale.py）
#   2. 重转 HLS：用 media/clean 的源重转 hls-output（scripts/transcode-local.mjs）
#   3. 重传 S3：覆盖旧分片（scripts/upload-local-s3.mjs --force）
#
# 用法：
#   bash scripts/pipeline-dewatermark.sh              # 全流程
#   bash scripts/pipeline-dewatermark.sh --skip-clean # 跳过第 1 步
#   bash scripts/pipeline-dewatermark.sh --dry-run    # 只看计划
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

SKIP_CLEAN=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --skip-clean) SKIP_CLEAN=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "未知参数: $arg" >&2; exit 1 ;;
  esac
done

PY="$ROOT/.venv-wm/bin/python"
LOG_DIR="$ROOT/data/logs"
mkdir -p "$LOG_DIR"

echo "=== 1/4 去水印 ==="
if [[ "$SKIP_CLEAN" == "1" ]]; then
  echo "  跳过"
elif [[ "$DRY_RUN" == "1" ]]; then
  "$PY" scripts/wm_clean_batch.py --parallel 4 --dry-run 2>/dev/null || true
  "$PY" - <<'EOF'
import json
scan = json.load(open('data/watermark-scan.json'))
ids = [k for k, v in scan.items() if v.get('wm') or v.get('watermark')]
eps = sum(scan[k].get('eps', scan[k].get('episodes', 0)) for k in ids)
print(f'  待处理 {len(ids)} 部剧 / {eps} 集')
EOF
else
  "$PY" scripts/wm_clean_batch.py --parallel 4 2>&1 | tee "$LOG_DIR/dewatermark.log"
fi

echo
echo "=== 2/4 重建旧产物（算法升级后重跑） ==="
if [[ "$SKIP_CLEAN" == "1" ]]; then
  echo "  跳过"
elif [[ "$DRY_RUN" == "1" ]]; then
  "$PY" scripts/wm_clean_rebuild_stale.py --list 2>/dev/null || true
else
  "$PY" scripts/wm_clean_rebuild_stale.py --parallel 2 2>&1 | tee "$LOG_DIR/dewatermark-rebuild.log"
fi

echo
echo "=== 3/4 重转 HLS ==="
if [[ "$DRY_RUN" == "1" ]]; then
  node scripts/transcode-local.mjs --dry-run
else
  node scripts/transcode-local.mjs --parallel 4 2>&1 | tee "$LOG_DIR/transcode.log"
fi

echo
echo "=== 4/4 重传 S3 ==="
if [[ "$DRY_RUN" == "1" ]]; then
  node scripts/upload-local-s3.mjs --dry-run
else
  node scripts/upload-local-s3.mjs --force --concurrency 3 2>&1 | tee "$LOG_DIR/upload-s3.log"
fi

echo
echo "完成。"
