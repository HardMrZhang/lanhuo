#!/usr/bin/env python3
"""跨视频水印模板匹配：用已知水印模板在其它视频里定位水印。

已知水印（91CRDJ.COM 移动水印）在 720x1280 下位于 (349,140)，尺寸 357x32。
这里把这块区域抽成模板，用 NCC 在任意视频（任意分辨率）里搜索，
从而判断某个视频是否带有同款水印，以及它在画面里的位置。
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np

TPL_W, TPL_H = 357, 32
NCC_MIN = 0.45


def high_pass(img_gray):
    blur = cv2.blur(img_gray, (9, 9))
    return cv2.subtract(img_gray, blur)


class Tpl:
    def __init__(self, patch):
        self.h, self.w = patch.shape[:2]
        self.tpl = high_pass(patch.astype(np.float32))
        self.tpl -= self.tpl.mean()
        self.tpl_norm = np.sqrt((self.tpl * self.tpl).sum()) + 1e-6

    def locate(self, gray):
        hp = high_pass(gray.astype(np.float32))
        th, tw = self.tpl.shape[:2]
        H, W = hp.shape
        if H < th or W < tw:
            return None
        F = np.fft.rfft2(hp)
        Ft = np.fft.rfft2(self.tpl[::-1, ::-1], s=hp.shape)
        corr = np.fft.irfft2(F * Ft, s=hp.shape)[th - 1:H, tw - 1:W]
        sq = hp * hp
        ii = np.pad(np.cumsum(np.cumsum(sq, axis=0), axis=1), ((1, 0), (1, 0)))
        e = ii[th:, tw:] - ii[:-th, tw:] - ii[th:, :-tw] + ii[:-th, :-tw]
        std = np.sqrt(np.maximum(e, 0.0) / (th * tw))
        denom = np.sqrt(np.maximum(e, 1e-6)) * self.tpl_norm
        m = np.clip(np.nan_to_num(corr / denom, nan=0.0, posinf=0.0, neginf=0.0), -1, 1)
        m[std <= 3.0] = -9.0
        idx = int(np.argmax(m))
        y, x = divmod(idx, m.shape[1])
        score = float(m[y, x])
        if score <= -9.0:
            return None
        return score, x, y


def make_template(ref_png, box=(349, 140)):
    im = cv2.imread(ref_png)
    if im is None:
        raise SystemExit(f'cannot read {ref_png}')
    g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    x, y = box
    return g[y:y + TPL_H, x:x + TPL_W]


def scan(video, tpl, times=None, sample=1):
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        return []
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if times is None:
        times = np.linspace(0, max(0, (total / fps) - 1), 12).tolist()
    hits = []
    for t in times:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
        ok, f = cap.read()
        if not ok:
            continue
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        r = tpl.locate(g)
        if r:
            hits.append({'t': round(t, 2), 'score': round(r[0], 3),
                         'x': r[1], 'y': r[2]})
    cap.release()
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('videos', nargs='+')
    ap.add_argument('--ref', default='/tmp/wmcmp/src30.png')
    ap.add_argument('--min', type=float, default=NCC_MIN)
    a = ap.parse_args()
    tpl = Tpl(make_template(a.ref))
    for v in a.videos:
        hits = [h for h in scan(v, tpl) if h['score'] >= a.min]
        top = sorted(hits, key=lambda h: -h['score'])[:4]
        print(f'{os.path.basename(os.path.dirname(v))}/{os.path.basename(v)}  '
              f'hit {len(hits)}/12  ' +
              ' '.join(f"t{h['t']}s={h['score']}@({h['x']},{h['y']})" for h in top))


if __name__ == '__main__':
    main()
