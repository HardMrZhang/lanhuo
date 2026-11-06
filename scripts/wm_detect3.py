#!/usr/bin/env python3
"""水印检测 v3：靠"文本跨帧复现"判定，不依赖水印具体文字。

原理：
  移动水印每一帧都在画面里，只是位置在变。OCR 扫 N 帧后，
  统计哪些文本 token 反复出现（同一 token 出现在多帧、位置各不相同），
  这样的 token 就是烧录水印（画面内字幕不会在每帧都出现同样的字）。

这样不依赖水印内容是 "91CRDJ.COM" 还是别的域名。

用法:
    python3 wm_detect3.py VIDEO [--n 24]
"""
import argparse
import json
import os
import re
import subprocess
import tempfile
from collections import defaultdict

import cv2


def ocr_words(img_path):
    try:
        out = subprocess.run(
            ['tesseract', img_path, 'stdout', '-l', 'eng', '--psm', '11', 'tsv'],
            capture_output=True, text=True, timeout=90).stdout
    except Exception:
        return []
    lines = out.strip().split('\n')
    if not lines or not lines[0].startswith('level'):
        return []
    words = []
    for r in lines[1:]:
        p = r.split('\t')
        if len(p) < 12:
            continue
        try:
            left, top, w, h = int(p[6]), int(p[7]), int(p[8]), int(p[9])
            conf = float(p[10])
        except ValueError:
            continue
        words.append({'text': p[11].strip(), 'x': left, 'y': top,
                      'w': w, 'h': h, 'conf': conf})
    return words


def scan(video, n=24, min_w=60, min_frames=3):
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        return None
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    dur = total / fps if fps else 0
    if dur <= 2:
        cap.release()
        return None
    times = [dur * (i + 0.5) / n for i in range(n)]
    # token -> 出现帧数 / 位置列表
    hits = defaultdict(list)
    with tempfile.TemporaryDirectory() as td:
        for i, t in enumerate(times):
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
            ok, f = cap.read()
            if not ok:
                continue
            p = os.path.join(td, f'{i}.png')
            cv2.imwrite(p, f)
            seen_in_frame = set()
            for wd in ocr_words(p):
                t2 = wd['text'].replace(' ', '').strip()
                if len(t2) < 3:
                    continue
                if not re.search(r'[A-Za-z]', t2):
                    continue
                if wd['w'] < min_w or wd['h'] < 8 or wd['h'] > 90:
                    continue
                if wd['conf'] < 40:
                    continue
                if t2 in seen_in_frame:
                    continue
                seen_in_frame.add(t2)
                hits[t2].append((round(t, 2), wd['x'], wd['y'], wd['w'], wd['h']))
    cap.release()
    out = []
    for tok, lst in hits.items():
        if len(lst) < min_frames:
            continue
        # 位置要分散（说明在移动），不是固定字幕
        poss = {(x, y) for _, x, y, _, _ in lst}
        if len(poss) < max(2, len(lst) // 2):
            continue
        out.append({'text': tok, 'frames': len(lst), 'positions': sorted(poss)[:8],
                    'size': (lst[0][3], lst[0][4])})
    out.sort(key=lambda o: -o['frames'])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('videos', nargs='+')
    ap.add_argument('--n', type=int, default=24)
    ap.add_argument('--json')
    a = ap.parse_args()
    res = {}
    for v in a.videos:
        r = scan(v, a.n)
        res[v] = r or []
        if r:
            print(f'✗ 有水印 {os.path.basename(v)}')
            for o in r[:5]:
                print(f'    "{o["text"]}" 出现 {o["frames"]} 帧 尺寸{o["size"]} 位置{o["positions"][:4]}')
        else:
            print(f'✓ 无水印 {os.path.basename(v)}')
    if a.json:
        with open(a.json, 'w') as f:
            json.dump(res, f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
