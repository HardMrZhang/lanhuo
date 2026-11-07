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

    def locate_all(self, frame, max_hits=4, expect=0):
        """找出画面里所有水印实例。

        有些片源把同一支水印同时印在画面的多个角落（左右下角 + 顶边），
        只修一处的话其余几处会留着。NCC 是全图相关，直接取峰值图上的
        若干个互相分离的极大值即可一次拿到所有实例。

        另外水印会沿画面边缘弹跳，被裁掉一半时整块模板匹配不上（相关度掉到
        阈值以下），这时改用左右半块模板匹配，再把位置还原回整块左上角，
        否则贴边的那一半水印会全程漏修。

        半块模板的限制很严，否则会在画面里到处匹配出假实例：
          - 只在对应的贴边窄带里找（右半块 -> 画面左侧带宽，左半块 -> 右侧带宽）；
          - 还原出来的整块水印位置必须真的有一部分在画面外；
          - 阈值比整块模板更高（半块特征更弱，容易误匹配）。

        expect：已知应该存在的实例数。整块模板已经找到这么多实例时就不必再算
        半块模板（每多算一次 match_map 就是一次全图 FFT 相关，代价很高），
        只在"有实例不见了"时才启用降级匹配。
        """
        self.prepare(frame.shape)
        hits = []
        used = []
        W = frame.shape[1]

        def collect(tracker, xoff, band=None, need_outside=False, min_score=NCC_MIN):
            m = tracker.match_map(frame.hp, frame.spec, frame.sq_map)
            if m is None:
                return
            work = m.copy()
            for _ in range(max_hits):
                idx = int(np.argmax(work))
                y, x = divmod(idx, work.shape[1])
                score = float(work[y, x])
                if score < min_score:
                    break
                # 抹掉这一片区域，避免同一个位置被重复计数
                y0 = max(0, y - self.full.h // 2)
                y1 = min(work.shape[0], y + self.full.h // 2)
                x0 = max(0, x - self.full.w // 2)
                x1 = min(work.shape[1], x + self.full.w // 2)
                if band is not None and not (band[0] <= x <= band[1]):
                    # 不在贴边窄带内 -> 这不是被裁掉的水印，跳过
                    work[y0:y1, x0:x1] = -9.0
                    continue
                x += xoff
                if need_outside and not (x < 0 or x + self.full.w > W):
                    # 还原后整块水印仍在画面内 -> 说明整块模板本该匹配上，不算
                    work[y0:y1, x0:x1] = -9.0
                    continue
                # 已被整块模板命中的位置不再重复计数
                if any(abs(x - hx) < self.full.w // 3 and abs(y - hy) < self.full.h // 2
                       for _, hx, hy in used):
                    work[y0:y1, x0:x1] = -9.0
                    continue
                used.append((score, x, y))
                hits.append((score, x, y))
                work[y0:y1, x0:x1] = -9.0

        collect(self.full, 0)
        # 有实例没找到 -> 可能是被画面边缘裁掉一半，用半块模板补找
        if len(hits) < expect:
            hw = self.half_w
            # 只露右半 -> 可见的右半贴在画面左侧，还原后整块左上角为负
            collect(self.right, -hw, band=(0, hw), need_outside=True,
                    min_score=NCC_MIN + 0.15)
            # 只露左半 -> 可见的左半贴在画面右侧，还原后整块超出右边界
            collect(self.left, 0, band=(W - hw, W), need_outside=True,
                    min_score=NCC_MIN + 0.15)
        return hits


def glyph_mask(patch, thresh=10):
    """从模板裁出水印笔画（半透明叠加层的高通残差）。

    水印不一定都是加亮：部分片源是半透明加亮，部分是半透明压暗，
    所以正、负高通残差都要取，否则压暗型水印会完全漏掉。
    """
    p = patch.astype(np.float32)
    blur = cv2.blur(p, (9, 9))
    hp = cv2.subtract(p, blur)      # 加亮笔画
    hn = cv2.subtract(blur, p)      # 压暗笔画
    m = (((hp > thresh) | (hn > thresh)) * 255).astype(np.uint8)
    # 笔画边缘是渐变过渡，膨胀 3 次保证整条笔画被蒙版罩住，
    # 否则残留的高通边缘在成片上仍然看得见半截字。
    m = cv2.dilate(m, np.ones((3, 3), np.uint8), iterations=3)
    return m


def build_mask(shape, glyph, x, y):
    """把水印笔画蒙版贴到当前帧的水印位置（整图版，保留兼容）。

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


def glyph_roi(glyph, x, y, h, w):
    """返回水印在画面内可见的笔画蒙版片段及其左上角位置。

    避免为每一帧分配一张整图大小的蒙版（1080x1920 下每帧 2MB），
    只裁出水印实际占据的那一小块。
    """
    gh, gw = glyph.shape[:2]
    gx0 = max(0, -x)
    gy0 = max(0, -y)
    gx1 = gw - max(0, x + gw - w)
    gy1 = gh - max(0, y + gh - h)
    if gx1 <= gx0 or gy1 <= gy0:
        return None, 0, 0
    return glyph[gy0:gy1, gx0:gx1], max(0, x), max(0, y)


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


def is_fragment_of(fragment, full):
    """判断 fragment 是不是 full 水印的一个片段（同一支水印的部分区域）。

    同一支水印的完整模板与它的片段，高通残差图案是相关的；
    而另一支尺寸完全不同的水印，相关性很低。
    """
    fh, fw = fragment.shape[:2]
    th, tw = full.shape[:2]
    if fh > th or fw > tw:
        return False
    # 片段要明显小于完整模板，否则就是同一支水印的另一个完整实例
    if fh > th * 0.8 or fw > tw * 0.9:
        return False
    # 用模板匹配比较高通残差图案：片段在完整模板里的最佳匹配位置的相关度
    a = high_pass(fragment.astype(np.float32))
    b = high_pass(full.astype(np.float32))
    if a.std() < 1e-6 or b.std() < 1e-6:
        return False
    res = cv2.matchTemplate(b, a, cv2.TM_CCOEFF_NORMED)
    return float(res.max()) > 0.3


def same_watermark(patch_a, patch_b):
    """判断两支模板是不是同一支水印。

    判据（满足其一即视为同一支）：
      1. 宽度差异在 15% 以内（同一支水印被 OCR 读成不同宽度）；
      2. 其中一支是另一支的片段（高通残差图案高度相关）。

    注意：不能用"宽度差异 40% 以内"这种宽松阈值 —— 有些片源同时叠了
    180px 大水印和 108px 小水印，宽度差正好 40%，会被误并为一支，
    结果实例多的小水印把大水印挤掉，大水印全程没被修过。
    """
    wa = patch_a.shape[1]
    wb = patch_b.shape[1]
    if abs(wa - wb) <= 0.15 * max(wa, wb):
        return True
    if wa < wb:
        return is_fragment_of(patch_a, patch_b)
    return is_fragment_of(patch_b, patch_a)


def pick_templates(video, cands, max_templates=4):
    """在候选模板里挑出真正需要处理的水印模板（可能不止一个）。

    关键点 1：OCR 有时只读出水印的一个片段（例如只认出 "COM" 而漏掉 "91CRDJ"）。
    用片段当模板 -> 只修掉那一小块，水印主体仍在画面里。
    所以要按宽度归并：同一个水印的多个候选里，取最宽的那个（完整水印）。

    关键点 2：部分片源同时叠了两种不同尺寸的水印（例如画面四角的 255x48 大水印
    + 一支在画面里游走的 185x17 小水印）。只处理最宽的一个会漏掉另一个，
    所以这里要挑出"确实是另一支水印"的候选分别处理。
    """
    if not cands:
        return []
    # 逐个候选试追踪，留下能稳定追踪到的
    tracked = []
    for c in cands:
        pts, total, _ = track_positions(video, c['patch'], probe=20)
        if not pts:
            continue
        rate = len(pts) / 20
        xs = [p[1] for p in pts]
        spread = (max(xs) - min(xs)) if len(xs) > 1 else 0
        score = rate + min(spread, 400) / 2000
        tracked.append((score, c, rate))
    if not tracked:
        return []
    # 宽的优先（完整水印），同宽按追踪分排序
    tracked.sort(key=lambda t: (-t[1]['patch'].shape[1], -t[0]))

    chosen = []
    for score, c, rate in tracked:
        patch = c['patch']
        # 如果它和某个已选模板是同一支水印（含宽度接近 / 片段关系），跳过
        if any(same_watermark(patch, c2['patch']) for _, c2, _ in chosen):
            continue
        chosen.append((score, c, rate))
        if len(chosen) >= max_templates:
            break
    return chosen


def track_one_template(video, cand, w, h, total):
    """追踪一支水印，返回 (glyph, track_maps, 实例数)。

    有些片源把同一支水印同时印在画面多个角落，必须逐实例跟踪。
    """
    glyph, track_maps, n = track_templates(video, [cand], w, h, total)[0][1:]
    return glyph, track_maps, n


def track_templates(video, cands, w, h, total):
    """一次全片扫描同时追踪多支水印。

    每支水印单独扫一遍全片的话，2 支水印就是 2 次全片解码 + 2 次 FFT，
    是整个流程的主要开销。这里把所有模板的跟踪器挂在同一次解码上，
    共享每帧的高通图与频谱，N 支水印的开销接近 1 支。

    返回 [(glyph, track_maps, 实例数), ...]，顺序与 cands 一致。
    """
    if not cands:
        return []
    ds = min(1.0, DETECT_W / w)
    det_w = max(1, int(w * ds))
    det_h = max(1, int(h * ds))
    MATCH_TOL = max(12, int(60 * ds))   # 同一实例在相邻采样帧的允许位移

    trackers = []
    glyphs = []
    for cand in cands:
        patch = cand['patch']
        gh, gw = patch.shape[:2]
        sp = cv2.resize(patch, (max(16, int(gw * ds)), max(8, int(gh * ds))),
                        interpolation=cv2.INTER_AREA)
        tr = MultiTracker(sp)
        tr.prepare((det_h, det_w))
        trackers.append(tr)
        glyphs.append(glyph_mask(patch))

    all_tracks = [[] for _ in cands]   # 每支水印各自的实例列表
    cap = cv2.VideoCapture(video)
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % TRACK_EVERY == 0:
            g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            sm = cv2.resize(g, (det_w, det_h), interpolation=cv2.INTER_AREA)
            spec = FrameSpec(sm)
            for ti, tracker in enumerate(trackers):
                tracks = all_tracks[ti]
                hits = tracker.locate_all(spec, expect=max(1, len(tracks)))
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

    out = []
    for ti, tracks in enumerate(all_tracks):
        tracks = [t for t in tracks if len(t['pts']) >= 3]
        if not tracks:
            out.append((cands[ti]['patch'], glyphs[ti], [], 0))
            continue
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
        out.append((cands[ti]['patch'], glyphs[ti], track_maps, len(tracks)))
    return out


def find_extra_watermark(video, patches, w, h, total):
    """找出 OCR 采样阶段漏掉的那支水印。

    一支游走的小水印（尺寸比四角大水印小）常常在 8 个采样帧里都没被 OCR 读到，
    但把采样数加到 24 帧后，它经过画面中央时会被读到。
    判定"是不是另一支水印"要同时看宽度和残差图案相关性：
    宽度差超过 15% 且残差图案不相关，才算另一支水印。

    patches：已处理水印的模板（灰度 patch），用于去重。
    """
    cands = collect_candidates(video, samples=24)
    if not cands:
        return []
    extra = []
    for c in cands:
        patch = c['patch']
        # 已被处理过（含片段关系）-> 同一支水印，跳过
        if any(same_watermark(patch, p) for p in patches):
            continue
        # 补充候选之间也要去重，避免同一支水印被重复处理
        if any(same_watermark(patch, e['patch']) for e in extra):
            continue
        extra.append(c)
    return extra


# ---------------------------------------------------------------- 主流程
def clean(video, out_video, radius=3, dry_run=False, min_score=NCC_MIN):
    cands = collect_candidates(video)
    if not cands:
        print(f'  未找到水印候选，跳过: {os.path.basename(video)}')
        return None
    print(f'  候选模板 {len(cands)} 个')

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f'无法打开 {video}')
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # 逐支水印追踪，得到多组 (glyph, 轨迹)
    picked = pick_templates(video, cands)
    if not picked:
        print('  所有候选模板都无法稳定追踪，跳过')
        return None

    # --- 补充检测：8 帧采样常常漏掉游走的小水印 ---
    extra = find_extra_watermark(video, [c['patch'] for _, c, _ in picked], w, h, total)
    if extra:
        print(f'  补充候选 {len(extra)} 个（采样阶段漏掉的水印）')

    # 所有要处理的模板一次性追踪（共享同一次全片解码与 FFT）
    all_cands = [c for _, c, _ in picked] + extra[:4]
    for _, cand, rate in picked:
        gh, gw = cand['patch'].shape[:2]
        print(f'  模板 {gw}x{gh} @ {cand["box"]} 文本="{cand["text"]}" 追踪命中率 {rate:.0%}')
    for cand in extra[:4]:
        gh, gw = cand['patch'].shape[:2]
        print(f'  补充模板 {gw}x{gh} @ {cand["box"]} 文本="{cand["text"]}"')

    tracked = track_templates(video, all_cands, w, h, total)

    layers = []
    for (patch, glyph, track_maps, n) in tracked:
        if not track_maps:
            print('    追踪失败，忽略该水印')
            continue
        print(f'    追踪到 {n} 个水印实例')
        # 同一支水印在不同位置被识别成多个候选时只保留一个（取实例最多的），
        # 否则会重复修复同一支水印，白白多花一倍时间。
        # 用 same_watermark 判定（宽度 15% 内 或 残差图案相关），
        # 不能用宽松的宽度阈值，否则大小两支水印会被误并。
        same = None
        for li, (p0, g0, tm0, n0) in enumerate(layers):
            if same_watermark(patch, p0):
                same = li
                break
        if same is not None:
            if n <= layers[same][3]:
                continue
            layers.pop(same)
        layers.append((patch, glyph, track_maps, n))

    if not layers:
        print('  追踪失败，跳过')
        return None

    if dry_run:
        for li, (patch, glyph, track_maps, n) in enumerate(layers):
            cover = sum(1 for f in range(total) if any(tm.get(f) for tm in track_maps))
            print(f'  试检 水印{li + 1}: {len(track_maps)} 个实例, 覆盖 {cover}/{total} 帧')
            for i, tm in enumerate(track_maps[:4]):
                fis = sorted(tm)[:6]
                print(f'    实例{i}:', [(f, tm[f]) for f in fis])
        return {'layers': len(layers)}

    # --- 第二遍：逐帧修复，视频流通过管道交给 ffmpeg 编码（避免 mp4v 二次有损压缩）---
    cap = cv2.VideoCapture(video)
    proc = subprocess.Popen(
        ['ffmpeg', '-y', '-nostdin', '-hide_banner', '-loglevel', 'error',
         '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{w}x{h}', '-framerate', f'{fps}',
         '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
         '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
         '-movflags', '+faststart', out_video],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    idx = 0
    cleaned = 0
    fh, fw = h, w
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        # 逐个水印实例，只在它占据的小块区域上做修复，
        # 避免每帧分配整图蒙版 + 全图 inpaint（1080x1920 下非常慢）
        touched = False
        for patch, glyph, track_maps, _ in layers:
            for tm in track_maps:
                p = tm.get(idx)
                if not p:
                    continue
                sub, dx, dy = glyph_roi(glyph, p[0], p[1], fh, fw)
                if sub is None or not sub.any():
                    continue
                sh, sw = sub.shape[:2]
                x1 = min(fw, dx + sw)
                y1 = min(fh, dy + sh)
                if x1 <= dx or y1 <= dy:
                    continue
                sub = sub[:y1 - dy, :x1 - dx]
                roi = frame[dy:y1, dx:x1]
                frame[dy:y1, dx:x1] = cv2.inpaint(roi, sub, radius, cv2.INPAINT_TELEA)
                touched = True
        if touched:
            cleaned += 1
        idx += 1
        proc.stdin.write(frame.tobytes())
        if total and idx % 2000 == 0:
            print(f'    {idx}/{total} 修复 {cleaned}', flush=True)
    cap.release()
    proc.stdin.close()
    err = proc.stderr.read().decode('utf-8', 'ignore')
    proc.wait()
    if proc.returncode != 0:
        raise SystemExit(f'ffmpeg 编码失败: {err[-400:]}')
    print(f'  完成 {out_video}: {idx} 帧, 修复 {cleaned} 帧 ({cleaned/max(1,idx):.0%})')
    return {'frames': idx, 'cleaned': cleaned, 'layers': len(layers)}


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
