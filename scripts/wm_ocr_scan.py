#!/usr/bin/env python3
"""扫描视频里的 CRDJ 水印：用 OCR 找出 "CRDJ" 文字包围盒。

OCR 慢但准，用来确定：
  - 哪个视频有水印
  - 水印文字的实际像素尺寸（不同片源缩放比例不同）
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

import cv2

TSV_HEADER = ['level', 'page_num', 'block_num', 'par_num', 'line_num', 'word_num',
              'left', 'top', 'width', 'height', 'conf', 'text']
PAT = re.compile(r'(CRDJ|DJ\s*\.\s*COM|\.COM|COM)', re.I)


def ocr_boxes(img_path):
    try:
        out = subprocess.run(['tesseract', img_path, 'stdout', '-l', 'eng', '--psm', '11', 'tsv'],
                             capture_output=True, text=True, timeout=60).stdout
    except Exception as e:
        return []
    lines = out.strip().split('\n')
    if not lines or not lines[0].startswith('level'):
        return []
    rows = lines[1:]
    boxes = []
    for r in rows:
        p = r.split('\t')
        if len(p) < 12:
            continue
        try:
            left, top, w, h = int(p[6]), int(p[7]), int(p[8]), int(p[9])
            conf = float(p[10])
        except ValueError:
            continue
        text = p[11]
        if conf < 40:
            continue
        if PAT.search(text.replace(' ', '')):
            boxes.append({'text': text, 'x': left, 'y': top, 'w': w, 'h': h, 'conf': conf})
    return boxes


def scan(video, times=(10, 40, 70, 100, 130, 160)):
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        return None
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    dur = total / fps if fps else 0
    ts = [t for t in times if t < dur - 1] or [dur / 2]
    found = []
    with tempfile.TemporaryDirectory() as td:
        for i, t in enumerate(ts):
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
            ok, f = cap.read()
            if not ok:
                continue
            p = os.path.join(td, f'{i}.png')
            cv2.imwrite(p, f)
            for b in ocr_boxes(p):
                b['t'] = round(t, 2)
                found.append(b)
    cap.release()
    return {'duration': round(dur, 1), 'w': total and 0, 'hits': found}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('videos', nargs='+')
    ap.add_argument('--json')
    a = ap.parse_args()
    out = {}
    for v in a.videos:
        r = scan(v)
        if r is None:
            print(f'{v}: 无法打开')
            continue
        out[v] = r
        if r['hits']:
            sizes = sorted({(h['w'], h['h']) for h in r['hits']})
            locs = [(h['x'], h['y']) for h in r['hits']]
            print(f'✗ 有水印 {v}\n    尺寸={sizes} 位置={locs[:8]}')
        else:
            print(f'✓ 无水印 {v}')
    if a.json:
        with open(a.json, 'w') as f:
            json.dump(out, f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
