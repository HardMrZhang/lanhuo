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
    """单模板的 FFT-NCC 定位器。

    多个模板（整块 + 左右半块）共享同一帧的高通图与 FFT，
    避免每帧重复做 rfft2/irfft2 —— 这是整个管线的主要开销。
    """

    def __init__(self, patch):
        self.h, self.w = patch.shape[:2]
        self.tpl = high_pass(patch.astype(np.float32))
        self.tpl -= self.tpl.mean()
        self.tpl_norm = np.sqrt((self.tpl * self.tpl).sum()) + 1e-6

    def match(self, hp, spec, sq_map):
        """在已高通/已 FFT 的图上找最佳匹配位置，返回 (score, x, y)。"""
        m = self.match_map(hp, spec, sq_map)
        if m is None:
            return None
        idx = int(np.argmax(m))
        y, x = divmod(idx, m.shape[1])
        if m[y, x] <= -9.0:
            return None
        return float(m[y, x]), x, y

    def match_map(self, hp, spec, sq_map):
        """返回整张图的 NCC 图（供取多个极大值用）。"""
        th, tw = self.tpl.shape[:2]
        H, W = hp.shape
        if H < th or W < tw:
            return None
        corr = np.fft.irfft2(spec * self.ft, s=hp.shape)[th - 1:H, tw - 1:W]
        e = sq_map(th, tw)
        std = np.sqrt(np.maximum(e, 0.0) / (th * tw))
        denom = np.sqrt(np.maximum(e, 1e-6)) * self.tpl_norm
        m = np.clip(np.nan_to_num(corr / denom, nan=0.0, posinf=0.0, neginf=0.0), -1, 1)
        m[std <= MIN_WINDOW_STD] = -9.0
        return m

    def prepare(self, shape):
        """预计算模板的频域表示（依赖图像尺寸，图像尺寸固定时只需算一次）。"""
        self.ft = np.fft.rfft2(self.tpl[::-1, ::-1], s=shape)
        return self


class FrameSpec:
    """一帧的共享计算结果：高通图、频谱、平方和积分图。"""

    def __init__(self, gray):
        hp = high_pass(gray.astype(np.float32))
        self.hp = hp
        self.shape = hp.shape
        self.spec = np.fft.rfft2(hp)
        sq = hp * hp
        self.cum = np.pad(np.cumsum(np.cumsum(sq, axis=0), axis=1), ((1, 0), (1, 0)))

    def sq_map(self, th, tw):
        return (self.cum[th:, tw:] - self.cum[:-th, tw:]
                - self.cum[th:, :-tw] + self.cum[:-th, :-tw])


class MultiTracker:
    """整块模板 + 左右半块模板，兼顾水印被画面边缘裁掉一半的情况。

    水印沿画面边缘弹跳时会有相当一部分时间只露出一半：
      - 整块模板匹配不上（NCC 掉到阈值以下）；
      - 只露右半 -> 用右半模板匹配，再减去半个模板宽还原左上角；
      - 只露左半 -> 用左半模板匹配，左上角就是匹配位置。

    三个模板共用一帧的 FFT，实测比逐模板独立计算快 2 倍以上。
    """

    def __init__(self, patch):
        gh, gw = patch.shape[:2]
        half = max(8, gw // 2)
        self.half_w = half
        self.full = Tracker(patch)
        self.right = Tracker(patch[:, gw - half:])   # 只露右半时用
        self.left = Tracker(patch[:, :half])          # 只露左半时用
        self._shape = None

    def prepare(self, shape):
        """图像尺寸固定时，提前算好三个模板的频域表示。"""
        if self._shape == shape:
            return self
        self._shape = shape
        self.full.prepare(shape)
        self.right.prepare(shape)
        self.left.prepare(shape)
        return self

    def locate(self, gray):
        frame = FrameSpec(gray)
        return self.locate_spec(frame)

    def locate_spec(self, frame):
        self.prepare(frame.shape)
        best = self.full.match(frame.hp, frame.spec, frame.sq_map)
        if best and best[0] >= NCC_MIN:
            return best
        cands = []
        r = self.right.match(frame.hp, frame.spec, frame.sq_map)
        if r:
            cands.append((r[0], r[1] - self.half_w, r[2]))   # 还原整块左上角
        l = self.left.match(frame.hp, frame.spec, frame.sq_map)
        if l:
            cands.append((l[0], l[1], l[2]))
        if not cands:
            return best
        pick = max(cands, key=lambda c: c[0])
        if best and best[0] >= pick[0]:
            return best
        return pick

    def locate_all(self, frame, max_hits=4):
        """找出画面里所有水印实例。

        有些片源把同一支水印同时印在画面的多个角落（左右下角 + 顶边），
        只修一处的话其余几处会留着。NCC 是全图相关，直接取峰值图上的
        若干个互相分离的极大值即可一次拿到所有实例。
        """
        self.prepare(frame.shape)
        m = self.full.match_map(frame.hp, frame.spec, frame.sq_map)
        if m is None:
            return []
        hits = []
        work = m.copy()
        for _ in range(max_hits):
            idx = int(np.argmax(work))
            y, x = divmod(idx, work.shape[1])
            score = float(work[y, x])
            if score < NCC_MIN:
                break
            hits.append((score, x, y))
            # 抹掉这一片区域，避免同一个水印被重复计数
            y0 = max(0, y - self.full.h // 2)
            y1 = min(work.shape[0], y + self.full.h // 2)
            x0 = max(0, x - self.full.w // 2)
            x1 = min(work.shape[1], x + self.full.w // 2)
            work[y0:y1, x0:x1] = -9.0
        return hits


def glyph_mask(patch, thresh=10):
    """从模板裁出水印笔画（半透明加亮叠加层的正高通残差）。"""
    p = patch.astype(np.float32)
    hp = cv2.subtract(p, cv2.blur(p, (9, 9)))
    m = ((hp > thresh) * 255).astype(np.uint8)
    m = cv2.dilate(m, np.ones((3, 3), np.uint8), iterations=2)
    return m


def build_mask(shape, glyph, x, y):
    """把水印笔画蒙版贴到当前帧的水印位置。

    x/y 可以是负数：水印移到画面边缘时会被截断，只有一部分可见。
    这时要按同样的偏移裁掉蒙版的对侧，否则笔画与实际位置错开，
    可见的那部分就修不掉（表现为画面左/右边缘残留半截水印）。
    """
    h, w = shape[:2]
    gh, gw = glyph.shape[:2]
    # 蒙版相对画面的可见交集
    gx0 = max(0, -x)          # 蒙版里被裁掉的左列数
    gy0 = max(0, -y)
    gx1 = gw - max(0, x + gw - w)   # 右边超出的列数
    gy1 = gh - max(0, y + gh - h)
    if gx1 <= gx0 or gy1 <= gy0:
        return np.zeros((h, w), np.uint8)
    mask = np.zeros((h, w), np.uint8)
    dx = max(0, x)
    dy = max(0, y)
    sub = glyph[gy0:gy1, gx0:gx1]
    mask[dy:dy + sub.shape[0], dx:dx + sub.shape[1]] = sub
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
    tracker = MultiTracker(sp)
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
    """在候选模板里挑追踪命中率最高的。

    关键点：OCR 有时只读出水印的一个片段（例如只认出 "COM" 而漏掉 "91CRDJ"）。
    用片段当模板 -> 只修掉那一小块，水印主体仍在画面里。
    所以要先按宽度归并：同一个水印的多个候选里，取最宽的那个（完整水印）。
    """
    if not cands:
        return None
    # 同类候选（宽高比接近）只保留最宽的：片段模板不可能比完整水印更宽
    cands = sorted(cands, key=lambda c: -c['patch'].shape[1])
    widths = [c['patch'].shape[1] for c in cands]
    # 宽度差异小于 15% 的视为同一水印的不同识别结果
    best_per_family = []
    for c in cands:
        w = c['patch'].shape[1]
        if all(abs(w - b['patch'].shape[1]) > 0.15 * max(w, b['patch'].shape[1])
               for b in best_per_family):
            best_per_family.append(c)
    # 片段候选：宽度明显小于最大候选的直接淘汰
    max_w = max(c['patch'].shape[1] for c in cands)
    pool = [c for c in best_per_family
            if c['patch'].shape[1] >= 0.6 * max_w] or best_per_family

    best = None
    for c in pool[:4]:
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
    tracker = MultiTracker(sp)
    glyph = glyph_mask(patch)

    # --- 第一遍：隔帧定位，得到每个水印实例的轨迹 ---
    # 有些片源把同一支水印同时印在画面多个角落，必须逐实例跟踪。
    tracks = []           # [{'pts': {frame_idx: (x, y)}, 'miss': int}]
    idx = 0
    det_w = max(1, int(w * ds))
    det_h = max(1, int(h * ds))
    tracker.prepare((det_h, det_w))
    MATCH_TOL = max(12, int(60 * ds))   # 同一实例在相邻采样帧的允许位移
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % TRACK_EVERY == 0:
            g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            sm = cv2.resize(g, (det_w, det_h), interpolation=cv2.INTER_AREA)
            hits = tracker.locate_all(FrameSpec(sm))
            used = set()
            for score, hx, hy in hits:
                # 归给最近的已有实例
                best_i, best_d = None, None
                for i, tr in enumerate(tracks):
                    if i in used or not tr['pts']:
                        continue
                    lf, lx, ly = tr['last']
                    d = abs(hx - lx) + abs(hy - ly)
                    if d <= MATCH_TOL and (best_d is None or d < best_d):
                        best_i, best_d = i, d
                if best_i is None:
                    tracks.append({'pts': {idx: (hx, hy)}, 'last': (idx, hx, hy),
                                   'miss': 0})
                else:
                    tr = tracks[best_i]
                    tr['pts'][idx] = (hx, hy)
                    tr['last'] = (idx, hx, hy)
                    tr['miss'] = 0
                    used.add(best_i)
            # 没被匹配到的实例算作一次丢失
            for i, tr in enumerate(tracks):
                if i not in used and tr['pts']:
                    tr['miss'] += 1
        idx += 1
    cap.release()

    tracks = [t for t in tracks if len(t['pts']) >= 3]
    if not tracks:
        print('  追踪失败，跳过')
        return None
    print(f'  追踪到 {len(tracks)} 个水印实例')

    # --- 每条轨迹补齐到每帧（线性插值）---
    track_maps = []
    for tr in tracks:
        m = {}
        fis = sorted(tr['pts'])
        for k, fi in enumerate(fis):
            hx, hy = tr['pts'][fi]
            m[fi] = (int(round(hx / ds)), int(round(hy / ds)))
            if k + 1 < len(fis):
                nj = fis[k + 1]
                nx, ny = tr['pts'][nj]
                span = nj - fi
                for s in range(1, span):
                    t = s / span
                    m[fi + s] = (int(round(m[fi][0] + (nx / ds - m[fi][0]) * t)),
                                 int(round(m[fi][1] + (ny / ds - m[fi][1]) * t)))
        track_maps.append(m)

    if dry_run:
        cover = sum(1 for f in range(total) if any(tm.get(f) for tm in track_maps))
        print(f'  试检: {len(tracks)} 个水印实例, 覆盖 {cover}/{total} 帧')
        for i, tm in enumerate(track_maps[:4]):
            fis = sorted(tm)[:6]
            print(f'    实例{i}:', [(f, tm[f]) for f in fis])
        return {'tracks': len(tracks), 'coverage': cover, 'box': cand['box']}

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
        mask = np.zeros(frame.shape[:2], np.uint8)
        for tm in track_maps:
            p = tm.get(idx)
            if not p:
                continue
            m = build_mask(frame.shape, glyph, p[0], p[1])
            mask |= m
        if (mask > 0).any():
            # 只在有蒙版的区域做修复：全图 inpaint 在 1080x1920 上非常慢
            ys, xs = np.nonzero(mask)
            y0 = max(0, int(ys.min()) - 6)
            y1 = min(frame.shape[0], int(ys.max()) + 7)
            x0 = max(0, int(xs.min()) - 6)
            x1 = min(frame.shape[1], int(xs.max()) + 7)
            roi = frame[y0:y1, x0:x1]
            roi_mask = mask[y0:y1, x0:x1]
            frame[y0:y1, x0:x1] = cv2.inpaint(roi, roi_mask, radius, cv2.INPAINT_TELEA)
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
