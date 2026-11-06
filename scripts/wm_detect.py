#!/usr/bin/env python3
"""通用水印检测：不依赖硬编码模板。

思路：
  1. 采样 N 帧，逐像素算时间标准差。
     画面内容在动 -> 背景像素 std 大；
     叠加式水印（半透明烧录）-> 该处像素几乎是常数 -> std 接近 0。
  2. 低 std 区域里再算高通残差强度，找出"文字形状"。
  3. 连通域聚类 -> 输出候选水印框。

用法:
    python3 wm_detect.py VIDEO [--n 40] [--json out.json]
"""
import argparse
import json

import cv2
import numpy as np


def sample_frames(path, n=40, fps_sample=None):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise SystemExit(f'cannot open {path}')
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if total <= 0:
        cap.release()
        raise SystemExit(f'no frame count {path}')
    idxs = np.linspace(0, total - 1, n).astype(int)
    frames = []
    for i in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(i))
        ok, f = cap.read()
        if ok:
            frames.append(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY))
    cap.release()
    return frames, total, fps


def detect(path, n=40, std_thresh=3.0, min_area=120):
    frames, total, fps = sample_frames(path, n)
    if len(frames) < 4:
        raise SystemExit('too few frames')
    stack = np.stack(frames).astype(np.float32)
    std = stack.std(axis=0)

    static = (std < std_thresh).astype(np.uint8) * 255
    # 静态区域做高通，突出文字笔画
    hp = cv2.subtract(stack.mean(axis=0), cv2.blur(stack.mean(axis=0), (9, 9)))
    hp = np.clip(hp * 4 + 128, 0, 255).astype(np.uint8)

    comb = cv2.bitwise_and(hp, static)
    comb = cv2.morphologyEx(comb, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    # 水平膨胀，把同一行文字连成一条
    comb = cv2.dilate(comb, np.ones((1, 9), np.uint8), iterations=1)

    num, lab, stats, cent = cv2.connectedComponentsWithStats(comb)
    boxes = []
    for i in range(1, num):
        x, y, w, h, a = stats[i]
        if a < min_area:
            continue
        if h < 6 or h > 120 or w < 40:
            continue
        boxes.append({'x': int(x), 'y': int(y), 'w': int(w), 'h': int(h), 'area': int(a)})
    boxes.sort(key=lambda b: -b['area'])
    return {'video': path, 'frames': len(frames), 'total_frames': total,
            'fps': fps, 'boxes': boxes[:20]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('--n', type=int, default=40)
    ap.add_argument('--std', type=float, default=3.0)
    ap.add_argument('--json')
    a = ap.parse_args()
    r = detect(a.video, a.n, a.std)
    print(json.dumps(r, ensure_ascii=False, indent=1))
    if a.json:
        with open(a.json, 'w') as f:
            json.dump(r, f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
