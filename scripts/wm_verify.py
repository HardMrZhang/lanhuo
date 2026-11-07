#!/usr/bin/env python3
"""校验：对每个 media/clean 视频做 OCR 采样，若仍能读到水印候选则判定残留。

比"高通残差比"更可靠：直接在成片上找水印文字。
"""
import glob
import os
import re
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import wm_clean  # noqa: E402


def scan(video, samples=8):
    """在视频上采样，返回 OCR 命中的水印候选 (text, x, y, w, h, conf)。"""
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        return []
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    dur = total / fps if total else 0
    hits = []
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        for i in range(samples):
            idx = int(total * (i + 0.5) / samples)
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, f = cap.read()
            if not ok:
                continue
            p = os.path.join(td, f'{i}.png')
            cv2.imwrite(p, f)
            for wd in wm_clean.tesseract_words(p):
                t = wd['text'].replace(' ', '')
                if not t or not wm_clean.OCR_PAT.search(t):
                    continue
                if wd['conf'] < 30:
                    continue
                if wd['w'] < 60 or wd['h'] > 80 or wd['w'] / max(1, wd['h']) < 3:
                    continue
                hits.append((wd['text'], wd['x'], wd['y'], wd['w'], wd['h'], round(wd['conf'])))
    cap.release()
    return hits


def main():
    files = sorted(glob.glob('media/clean/*/*.mp4'))
    files = [f for f in files if '.tmp.' not in f]
    if len(sys.argv) > 1 and sys.argv[1] != 'all':
        files = files[:int(sys.argv[1])]
    bad = []
    ok = 0
    for cf in files:
        hits = scan(cf)
        if hits:
            bad.append((cf, hits))
            print(f'  ✗ 残留 {len(hits)} 处  {cf}  {hits[:2]}', flush=True)
        else:
            ok += 1
            print(f'  ✓ 无水印  {cf}', flush=True)
    print(f'\n通过 {ok} 集，残留 {len(bad)} 集')
    for f, hits in bad:
        print(f'  {f}  {hits[:3]}')


if __name__ == '__main__':
    main()
