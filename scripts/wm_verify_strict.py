#!/usr/bin/env python3
"""严格检测：把原片的所有水印候选模板逐个拿到成片里全图 NCC 搜索。

任一模板峰值超阈值即判定残留。
比单模板检测准，能发现"只清掉了一支水印"的情况。
"""
import glob
import os
import sys

import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wm_clean  # noqa: E402

NCC_FAIL = 0.6


def templates_of(orig, samples=16):
    cands = wm_clean.collect_candidates(orig, samples=samples)
    # 去掉互相重复的（宽度接近视为同一支）
    out = []
    for c in sorted(cands, key=lambda c: -c['patch'].shape[1]):
        w = c['patch'].shape[1]
        if any(abs(w - o['patch'].shape[1]) <= 0.2 * max(w, o['patch'].shape[1]) for o in out):
            continue
        out.append(c)
    return out


def ncc_in(video, patch, samples=5):
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
    bad = []
    ok = 0
    for cf in files[:limit]:
        did = cf.split('/')[2]
        src = f'media/imported/{did}/{os.path.basename(cf)}'
        if not os.path.exists(src):
            continue
        tpls = templates_of(src)
        if not tpls:
            continue
        worst, wt = 0.0, None
        for t in tpls:
            n = ncc_in(cf, t['patch'])
            if n > worst:
                worst, wt = n, t
        if worst >= NCC_FAIL:
            bad.append((cf, worst, wt['patch'].shape))
            print(f'  ✗ NCC {worst:.2f} {wt["patch"].shape}  {cf}', flush=True)
        else:
            ok += 1
            print(f'  ✓ NCC {worst:.2f}  {cf}', flush=True)
    print(f'\n通过 {ok} 集，残留 {len(bad)} 集')
    for f, n, s in bad:
        print(f'  {n:.2f} {s}  {f}')


if __name__ == '__main__':
    main()
