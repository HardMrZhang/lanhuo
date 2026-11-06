#!/usr/bin/env python3
"""按视频自适应地定位并去除 91CRDJ.COM 移动水印。

旧版 scripts/dewatermark.py 把水印位置 (349,139)、尺寸 357x32 写死了，
只有一部剧有效。本版本完全自适应：

  1. OCR 采样若干帧，收集所有疑似 "CRDJ/.COM" 的横条候选框；
  2. 每个候选框裁成模板，用 FFT-NCC 试跑追踪，命中率最高的胜出；
  3. 逐帧（或隔帧插值）追踪水印位置，每一帧都用笔画蒙版 + cv2.inpaint 修复。

用法:
    python3 wm_clean.py VIDEO -o OUT.mp4 [--dry-run]
"""
import argparse
import json
import os
import re
import subprocess
import tempfile

import cv2
import numpy as np

OCR_PAT = re.compile(r'(CRDJ|\.COM|COM|DJ)', re.I)
NCC_MIN = 0.45
MIN_WINDOW_STD = 3.0
MAX_JUMP = 160
DETECT_W = 360          # 追踪用的缩小图宽度
TRACK_EVERY = 2         # 每 N 帧定位一次，中间帧线性插值


# ---------------------------------------------------------------- OCR 定位
def tesseract_words(img_path):
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
        words.append({'text': p[11].strip(), 'x': left, 'y': top, 'w': w, 'h': h, 'conf': conf})
    return words


def candidate_boxes(frame_bgr, tmpdir, idx):
    """OCR 一帧，返回疑似水印框。"""
    p = os.path.join(tmpdir, f'{idx}.png')
    cv2.imwrite(p, frame_bgr)
    out = []
    for wd in tesseract_words(p):
        t = wd['text'].replace(' ', '')
        if not t or not OCR_PAT.search(t):
            continue
        if wd['conf'] < 30:
            continue
        # 水印是横条：宽高比 > 3，高度 <= 80
        if wd['w'] < 60 or wd['h'] > 80:
            continue
        if wd['w'] / max(1, wd['h']) < 3:
            continue
        out.append(wd)
    return out


def collect_candidates(video, samples=8):
    """返回候选模板列表 [{'patch':gray,'box':(x,y,w,h),'t':sec,'conf':..}]"""
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f'无法打开 {video}')
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    dur = total / fps if fps else 0
    if dur <= 2:
        cap.release()
        return []
    cands = []
    seen = set()
    with tempfile.TemporaryDirectory() as td:
        times = [dur * (i + 0.5) / samples for i in range(samples)]
        for i, t in enumerate(times):
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
            ok, f = cap.read()
            if not ok:
                continue
            for b in candidate_boxes(f, td, i):
                key = (b['x'] // 20, b['y'] // 20, b['w'] // 30, b['h'] // 10)
                if key in seen:
                    continue
                seen.add(key)
                pad = 4
                x0 = max(0, b['x'] - pad)
                y0 = max(0, b['y'] - pad)
                x1 = min(f.shape[1], b['x'] + b['w'] + pad)
                y1 = min(f.shape[0], b['y'] + b['h'] + pad)
                patch = cv2.cvtColor(f[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
                cands.append({'patch': patch, 'box': (x0, y0, x1 - x0, y1 - y0),
                              't': t, 'conf': b['conf'], 'text': b['text']})
    cap.release()
    return cands


# ---------------------------------------------------------------- NCC 追踪
def high_pass(img_gray):
    blur = cv2.blur(img_gray, (9, 9))
    return cv2.subtract(img_gray, blur)


class Tracker:
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
        m[std <= MIN_WINDOW_STD] = -9.0
        idx = int(np.argmax(m))
        y, x = divmod(idx, m.shape[1])
        if m[y, x] <= -9.0:
            return None
        return float(m[y, x]), x, y


def glyph_mask(patch, thresh=10):
    """从模板裁出水印笔画（半透明加亮叠加层的正高通残差）。"""
    p = patch.astype(np.float32)
    hp = cv2.subtract(p, cv2.blur(p, (9, 9)))
    m = ((hp > thresh) * 255).astype(np.uint8)
    m = cv2.dilate(m, np.ones((3, 3), np.uint8), iterations=2)
    return m


def build_mask(shape, glyph, x, y):
    h, w = shape[:2]
    gh, gw = glyph.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(w, x + gw), min(h, y + gh)
    mask = np.zeros((h, w), np.uint8)
    if x1 <= x0 or y1 <= y0:
        return mask
    mask[y0:y1, x0:x1] = glyph[:y1 - y0, :x1 - x0]
    return mask


# ---------------------------------------------------------------- 位置序列
def track_positions(video, patch, probe=24):
    """在整片上采样定位，返回 [(frame_idx, x, y), ...]。"""
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        return [], 0, 0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    ds = min(1.0, DETECT_W / w)
    gh, gw = patch.shape[:2]
    sp = cv2.resize(patch, (max(16, int(gw * ds)), max(8, int(gh * ds))),
                    interpolation=cv2.INTER_AREA)
    tracker = Tracker(sp)
    pts = []
    for i in range(probe):
        idx = int(total * i / probe)
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, f = cap.read()
        if not ok:
            continue
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        sm = cv2.resize(g, (max(1, int(w * ds)), max(1, int(h * ds))),
                        interpolation=cv2.INTER_AREA)
        r = tracker.locate(sm)
        if r and r[0] >= NCC_MIN:
            pts.append((idx, int(round(r[1] / ds)), int(round(r[2] / ds))))
    cap.release()
    return pts, total, (w, h)


def pick_template(video, cands):
    """在候选模板里挑追踪命中率最高的。"""
    best = None
    for c in cands[:6]:
        pts, total, _ = track_positions(video, c['patch'], probe=20)
        if not pts:
            continue
        rate = len(pts) / 20
        # 位置必须分散（说明真的在动），且不能都挤在一起
        xs = [p[1] for p in pts]
        spread = (max(xs) - min(xs)) if len(xs) > 1 else 0
        score = rate + min(spread, 400) / 2000
        if best is None or score > best[0]:
            best = (score, c, rate, pts)
    if best is None:
        return None
    return best


# ---------------------------------------------------------------- 主流程
def clean(video, out_video, radius=3, dry_run=False, min_score=NCC_MIN):
    cands = collect_candidates(video)
    if not cands:
        print(f'  未找到水印候选，跳过: {os.path.basename(video)}')
        return None
    print(f'  候选模板 {len(cands)} 个')
    picked = pick_template(video, cands)
    if picked is None:
        print('  所有候选模板都无法稳定追踪，跳过')
        return None
    _, cand, rate, _ = picked
    patch = cand['patch']
    gh, gw = patch.shape[:2]
    print(f'  采用模板 {gw}x{gh} @ {cand["box"]} 文本="{cand["text"]}" 追踪命中率 {rate:.0%}')

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f'无法打开 {video}')
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    ds = min(1.0, DETECT_W / w)
    sp = cv2.resize(patch, (max(16, int(gw * ds)), max(8, int(gh * ds))),
                    interpolation=cv2.INTER_AREA)
    tracker = Tracker(sp)
    glyph = glyph_mask(patch)

    # --- 第一遍：隔帧定位，得到位置序列 ---
    positions = []          # [(frame_idx, x, y)]
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % TRACK_EVERY == 0:
            g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            sm = cv2.resize(g, (max(1, int(w * ds)), max(1, int(h * ds))),
                            interpolation=cv2.INTER_AREA)
            r = tracker.locate(sm)
            if r and r[0] >= min_score:
                positions.append((idx, int(round(r[1] / ds)), int(round(r[2] / ds))))
        idx += 1
    cap.release()
    if not positions:
        print('  追踪失败，跳过')
        return None

    # --- 位置序列转成每帧的表（含线性插值）---
    pos_map = {}
    for i, (fi, x, y) in enumerate(positions):
        pos_map[fi] = (x, y)
        if i + 1 < len(positions):
            nj, nx, ny = positions[i + 1]
            span = nj - fi
            for k in range(1, span):
                t = k / span
                pos_map[fi + k] = (int(round(x + (nx - x) * t)),
                                   int(round(y + (ny - y) * t)))
    # 末尾补齐
    last_fi, last_x, last_y = positions[-1]
    for fi in range(last_fi + 1, total):
        pos_map[fi] = (last_x, last_y)

    if dry_run:
        print(f'  试检定位到 {len(positions)} 个采样点, 覆盖 {len(pos_map)}/{total} 帧')
        print('  样例:', [(p[0], p[1], p[2]) for p in positions[:8]])
        return {'positions': len(positions), 'box': cand['box']}

    # --- 第二遍：逐帧修复，视频流通过管道交给 ffmpeg 编码（避免 mp4v 二次有损压缩）---
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    proc = subprocess.Popen(
        ['ffmpeg', '-y', '-nostdin', '-hide_banner', '-loglevel', 'error',
         '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{w}x{h}', '-framerate', f'{fps}',
         '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
         '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
         '-movflags', '+faststart', out_video],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    idx = 0
    cleaned = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        p = pos_map.get(idx)
        if p:
            mask = build_mask(frame.shape, glyph, p[0], p[1])
            if (mask > 0).any():
                frame = cv2.inpaint(frame, mask, radius, cv2.INPAINT_TELEA)
                cleaned += 1
        idx += 1
        proc.stdin.write(frame.tobytes())
        if total and idx % 1000 == 0:
            print(f'    {idx}/{total} 修复 {cleaned}', flush=True)
    cap.release()
    proc.stdin.close()
    err = proc.stderr.read().decode('utf-8', 'ignore')
    proc.wait()
    if proc.returncode != 0:
        raise SystemExit(f'ffmpeg 编码失败: {err[-400:]}')
    print(f'  完成 {out_video}: {idx} 帧, 修复 {cleaned} 帧 ({cleaned/max(1,idx):.0%})')
    return {'frames': idx, 'cleaned': cleaned, 'box': cand['box']}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('videos', nargs='+')
    ap.add_argument('-o', '--out', help='输出目录或文件路径')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    for v in a.videos:
        print(f'== {v}')
        try:
            out = a.out
            if out and not out.lower().endswith(('.mp4', '.mkv')):
                os.makedirs(out, exist_ok=True)
                out = os.path.join(out, os.path.basename(v))
            clean(v, out, dry_run=a.dry_run)
        except SystemExit as e:
            print(f'  错误: {e}')


if __name__ == '__main__':
    main()
