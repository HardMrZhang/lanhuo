#!/usr/bin/env python3
"""
去除视频里的移动水印（91CRDJ.COM / CRDJ.COM 一类烧录水印）。

水印是半透明加亮的文字叠加层，沿画面边缘匀速移动（bouncing）。
处理流程：

  1. 从参考帧裁出水印模板 -> 高通残差 + 归一化互相关（NCC）逐帧定位左上角；
  2. 从模板提取水印文字笔画形状（半透明叠加层的正高通残差）；
  3. 把笔画蒙版贴到每帧的水印位置，用周围像素修复（cv2.inpaint / Telea）；
  4. 写回为无水印视频，再交给 HLS 转码。

依赖：opencv-python-headless、numpy（建议装在项目内 venv）：
    python3 -m venv .venv-wm
    .venv-wm/bin/pip install opencv-python-headless numpy

用法：
    # 检测水印轨迹（看水印在哪些位置、是否真的存在）
    .venv-wm/bin/python scripts/dewatermark.py detect VIDEO -o track.json

    # 检测并修复，输出无水印视频
    .venv-wm/bin/python scripts/dewatermark.py run VIDEO -o clean.mp4

批量处理 + 转码 HLS：
    for f in media/imported/<drama>/*.mp4; do
      .venv-wm/bin/python scripts/dewatermark.py run "$f" -o "media/clean/<drama>/$(basename $f)"
    done
    node scripts/video-transcode.mjs --work <dramaId>
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np

# ---- 水印模板（720x1280 源片上的水印包围盒）----
TPL_W, TPL_H = 357, 32
# NCC 阈值：低于此值认为本帧没找到水印
NCC_MIN = 0.55
# 窗口标准差下限：低于此值说明窗口过于平坦，NCC 不可信
MIN_WINDOW_STD = 3.0
# 位置跳变阈值（像素）：相邻采样帧之间超过则认为是误检
MAX_JUMP = 80


def high_pass(img_gray):
    """高通残差：去掉低频画面内容，只留下文字边缘。"""
    blur = cv2.blur(img_gray, (9, 9))
    return cv2.subtract(img_gray, blur)


class WatermarkTemplate:
    """水印模板 + NCC 定位器。"""

    def __init__(self, patch):
        self.h, self.w = patch.shape[:2]
        self.tpl = high_pass(patch.astype(np.float32))
        self.tpl -= self.tpl.mean()
        self.tpl_norm = np.sqrt((self.tpl * self.tpl).sum()) + 1e-6

    @staticmethod
    def _ncc_map(img_hp, tpl, tpl_norm):
        """用 FFT 计算全图 NCC，返回 (map, valid_mask)。

        注意：平坦/低纹理窗口会让归一化分母退化，导致 NCC 出现虚假的 1.0。
        因此额外用窗口标准差做有效性过滤（std <= min_std 的位置视为无效）。
        """
        th, tw = tpl.shape[:2]
        H, W = img_hp.shape[:2]
        if H < th or W < tw:
            return None, None
        F = np.fft.rfft2(img_hp)
        Ft = np.fft.rfft2(tpl[::-1, ::-1], s=img_hp.shape)
        corr = np.fft.irfft2(F * Ft, s=img_hp.shape)[th - 1:H, tw - 1:W]

        sq = img_hp * img_hp
        ii = np.pad(np.cumsum(np.cumsum(sq, axis=0), axis=1), ((1, 0), (1, 0)))
        e = ii[th:, tw:] - ii[:-th, tw:] - ii[th:, :-tw] + ii[:-th, :-tw]
        std = np.sqrt(np.maximum(e, 0.0) / (th * tw))
        valid = std > MIN_WINDOW_STD
        denom = np.sqrt(np.maximum(e, 1e-6)) * tpl_norm
        m = np.nan_to_num(corr / denom, nan=0.0, posinf=0.0, neginf=0.0)
        m = np.clip(m, -1.0, 1.0)
        m[~valid] = -9.0
        return m, std

    def locate(self, frame_gray):
        """返回 (score, x, y) 或 None。"""
        hp = high_pass(frame_gray.astype(np.float32))
        m, _ = self._ncc_map(hp, self.tpl, self.tpl_norm)
        if m is None:
            return None
        idx = int(np.argmax(m))
        y, x = divmod(idx, m.shape[1])
        score = float(m[y, x])
        if score <= -9.0:
            return None
        return score, x, y


def extract_template(video, at=30.0, box=None):
    """从视频里裁出水印模板。box=(x,y) 为水印左上角。"""
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f'无法打开 {video}')
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    target = int(round(at * fps))
    cap.set(cv2.CAP_PROP_POS_FRAMES, target)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise SystemExit(f'无法读取 {video} @ {at}s')
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    if box is None:
        raise SystemExit('需要指定模板位置 box=x,y')
    x, y = box
    patch = gray[y:y + TPL_H, x:x + TPL_W]
    if patch.shape[0] != TPL_H or patch.shape[1] != TPL_W:
        raise SystemExit(f'模板区域超出画面: {patch.shape}')
    return patch


def detect_track(video, box, sample_fps=4.0, out_json=None):
    """逐帧定位水印，返回 [[t, x, y], ...]。"""
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f'无法打开 {video}')
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    x0, y0 = box
    # 模板按源分辨率裁剪
    scale_x = w / 720.0
    tw = max(20, int(round(TPL_W * scale_x)))
    th = max(8, int(round(TPL_H * scale_x)))
    patch = extract_template(video, 30.0, (int(round(x0 * scale_x)), int(round(y0 * scale_x))))
    patch = cv2.resize(patch, (tw, th), interpolation=cv2.INTER_LANCZOS4)
    tpl = WatermarkTemplate(patch)

    step = max(1, int(round(fps / sample_fps)))
    track = []
    idx = 0
    prev = None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            res = tpl.locate(gray)
            t = idx / fps
            if res and res[0] >= NCC_MIN:
                score, x, y = res
                # 与上一帧位置跳变过大 -> 视为误检
                if prev is not None and abs(x - prev[0]) + abs(y - prev[1]) > MAX_JUMP:
                    track.append([round(t, 3), None, None])
                else:
                    track.append([round(t, 3), int(x), int(y)])
                    prev = (x, y)
            else:
                track.append([round(t, 3), None, None])
        idx += 1
    cap.release()

    valid = [p for p in track if p[1] is not None]
    if not valid:
        raise SystemExit('未检测到水印')
    if out_json:
        with open(out_json, 'w') as f:
            json.dump({'video': video, 'width': w, 'height': h, 'fps': fps,
                       'template': [tw, th], 'points': track}, f, indent=1)
    return track


def glyph_mask(patch, thresh=22, dilate=1):
    """从模板里提取水印文字笔画蒙版。

    水印是半透明加亮的文字叠加层，用高通残差（去掉低频背景）后取正残差
    就能得到笔画形状。这个蒙版对同一支水印的所有视频都适用。
    """
    p = patch.astype(np.float32)
    hp = cv2.subtract(p, cv2.blur(p, (9, 9)))
    m = ((hp > thresh) * 255).astype(np.uint8)
    if dilate:
        m = cv2.dilate(m, np.ones((3, 3), np.uint8), iterations=dilate)
    return m


def build_mask(frame_gray, glyph, x, y):
    """把水印笔画蒙版贴到当前帧的水印位置。

    用模板自身的笔画形状作为遮罩，比逐帧做残差比对稳健得多：
    画面内容不会干扰遮罩，也不会因为帧内容变化而漏检。
    """
    h, w = frame_gray.shape[:2]
    gh, gw = glyph.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(w, x + gw), min(h, y + gh)
    mask = np.zeros((h, w), np.uint8)
    if x1 <= x0 or y1 <= y0:
        return mask
    mask[y0:y1, x0:x1] = glyph[:y1 - y0, :x1 - x0]
    return mask


def run(video, out_video, box, sample_fps=4.0, radius=3, dilate=1):
    """逐帧检测 + 修复 + 写出无水印视频。"""
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f'无法打开 {video}')
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    scale_x = w / 720.0
    tw = max(20, int(round(TPL_W * scale_x)))
    th = max(8, int(round(TPL_H * scale_x)))
    patch = extract_template(video, 30.0, (int(round(box[0] * scale_x)), int(round(box[1] * scale_x))))
    patch = cv2.resize(patch, (tw, th), interpolation=cv2.INTER_LANCZOS4)
    tpl = WatermarkTemplate(patch)

    # 位置查找用缩小图提速，坐标再乘回去
    detect_w = 360 if w > 720 else w
    detect_scale = detect_w / w
    small_patch = cv2.resize(patch, (max(20, int(round(tw * detect_scale))),
                                      max(8, int(round(th * detect_scale)))),
                             interpolation=cv2.INTER_AREA)
    small_tpl = WatermarkTemplate(small_patch)
    glyph = glyph_mask(patch, dilate=0)

    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(out_video, fourcc, fps, (w, h))
    if not writer.isOpened():
        raise SystemExit(f'无法创建输出 {out_video}')

    idx = 0
    prev = None
    cleaned = 0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        small = cv2.resize(gray, (int(w * detect_scale), int(h * detect_scale)),
                           interpolation=cv2.INTER_AREA)
        res = small_tpl.locate(small)
        if res and res[0] >= NCC_MIN:
            score, sx, sy = res
            x = int(round(sx / detect_scale))
            y = int(round(sy / detect_scale))
            if prev is None or abs(x - prev[0]) + abs(y - prev[1]) <= MAX_JUMP:
                prev = (x, y)
                mask = build_mask(gray, glyph, x, y)
                if dilate:
                    mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=dilate)
                if (mask > 0).any():
                    frame = cv2.inpaint(frame, mask, radius, cv2.INPAINT_TELEA)
                    cleaned += 1
        idx += 1
        writer.write(frame)
        if total and idx % 500 == 0:
            print(f'  {idx}/{total} 已修复 {cleaned} 帧', flush=True)
    writer.release()
    cap.release()
    print(f'完成: {out_video} 共 {idx} 帧, 修复 {cleaned} 帧')


def main():
    ap = argparse.ArgumentParser(description='去除视频移动水印')
    sub = ap.add_subparsers(dest='cmd', required=True)

    d = sub.add_parser('detect', help='检测水印轨迹')
    d.add_argument('video')
    d.add_argument('-o', '--out', help='轨迹 JSON 输出路径')
    d.add_argument('--box', default='349,139', help='水印左上角 x,y（720宽基准）')
    d.add_argument('--fps', type=float, default=4.0, help='采样帧率')

    r = sub.add_parser('run', help='检测并修复，输出无水印视频')
    r.add_argument('video')
    r.add_argument('-o', '--out', required=True)
    r.add_argument('--box', default='349,139', help='水印左上角 x,y（720宽基准）')
    r.add_argument('--fps', type=float, default=4.0, help='采样帧率')
    r.add_argument('--radius', type=int, default=3, help='inpaint 半径')
    r.add_argument('--dilate', type=int, default=1, help='蒙版膨胀次数')

    args = ap.parse_args()
    box = tuple(int(v) for v in args.box.split(','))

    if args.cmd == 'detect':
        track = detect_track(args.video, box, args.fps, args.out)
        valid = [p for p in track if p[1] is not None]
        print(f'检测到 {len(valid)}/{len(track)} 个采样帧含水印')
        for p in track[:40]:
            print(' ', p)
        if args.out:
            print(f'轨迹已写入 {args.out}')
    else:
        run(args.video, args.out, box, args.fps, args.radius, args.dilate)


if __name__ == '__main__':
    main()
