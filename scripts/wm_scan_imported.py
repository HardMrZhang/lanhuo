#!/usr/bin/env python3
"""扫描 media/imported 下所有剧的第一集，列出带 91CRDJ 水印的剧（OCR 判定）。

用法:
    python3 wm_scan_imported.py            # 扫描并打印
    python3 wm_scan_imported.py --json out.json
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wm_ocr_scan import scan  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMPORTED = os.path.join(ROOT, 'media', 'imported')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', default=os.path.join(ROOT, 'data', 'watermark-scan.json'))
    a = ap.parse_args()
    ids = sorted(os.listdir(IMPORTED))
    result = {}
    marked = []
    for i, drama_id in enumerate(ids, 1):
        d = os.path.join(IMPORTED, drama_id)
        eps = sorted(f for f in os.listdir(d) if f.endswith('.mp4'))
        if not eps:
            continue
        src = os.path.realpath(os.path.join(d, eps[0]))
        r = scan(src)
        has = bool(r and r['hits'])
        result[drama_id] = {'episodes': len(eps), 'watermark': has,
                            'hits': (r or {}).get('hits', [])}
        print(f'[{i}/{len(ids)}] {drama_id} {len(eps)}集 '
              f'{"✗ 有水印" if has else "✓ 无水印"}', flush=True)
        if has:
            marked.append(drama_id)
    with open(a.json, 'w') as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(f'\n共 {len(result)} 部剧，其中 {len(marked)} 部有水印')
    print(json.dumps(marked, ensure_ascii=False))


if __name__ == '__main__':
    main()
