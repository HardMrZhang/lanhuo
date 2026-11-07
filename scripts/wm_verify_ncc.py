#!/usr/bin/env python3
"""模板法校验：把原片的水印模板拿到成片里做全图 NCC 匹配。

比 OCR 精确：OCR 会把画面里长得像 ".com" 的内容文字也报出来。
NCC 峰值高 = 模板还在画面里；峰值低 = 已清除。
"""
import glob
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
import wm_clean  # noqa: E402

NCC_FAIL = 0.45


def top_template(orig):
    """从原片取水印模板（返回灰度 patch）。"""
    cands = wm_clean.collect_candidates(orig, samples=8)
    if not cands:
        return None
    cands.sort(key=lambda c: -c['patch'].shape[1])
    return cands[0]['patch']


def best_ncc(video, patch, samples=6):
    """在视频若干帧里搜模板，返回最高 NCC。"""
    gh, gw = patch.shape[:2]
    cap = cv2.VideoCapture(video)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    ds = min(1.0, wm_clean.DETECT_W / w)
    sp = cv2.resize(patch, (max(16, int(gw * ds)), max(8, int(gh * ds))),
                    interpolation=cv2.INTER_AREA)
    tracker = wm_clean.MultiTracker(sp)
    best = 0.0
    for i in range(samples):
        idx = int(total * (i + 0.5) / samples)
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, f = cap.read()
        if not ok:
            continue
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        sm = cv2.resize(g, (max(1, int(w * ds)), max(1, int(h * ds))),
                        interpolation=cv2.INTER_AREA)
        r = tracker.locate(sm)
        if r:
            best = max(best, r[0])
    cap.release()
    return best


def main():
    files = sorted(glob.glob('media/clean/*/*.mp4'))
    files = [f for f in files if '.tmp.' not in f]
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 999
    bad, ok, skip = [], 0, 0
    for cf in files[:limit]:
        did = cf.split('/')[2]
        src = f'media/imported/{did}/{os.path.basename(cf)}'
        if not os.path.exists(src):
            continue
        tpl = top_template(src)
        if tpl is None:
            skip += 1
            continue
        n = best_ncc(cf, tpl)
        if n >= NCC_FAIL:
            bad.append((cf, n))
            print(f'  ✗ NCC {n:.2f}  {cf}', flush=True)
        else:
            ok += 1
            print(f'  ✓ NCC {n:.2f}  {cf}', flush=True)
    print(f'\n通过 {ok} 集，残留 {len(bad)} 集，跳过(原片无水印) {skip} 集')
    for f, n in bad:
        print(f'  {n:.2f}  {f}')


if __name__ == '__main__':
    main()
