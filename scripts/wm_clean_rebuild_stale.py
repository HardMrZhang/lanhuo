#!/usr/bin/env python3
"""重建用旧算法生成的去水印文件（保留其它已完成的任务）。

旧版 wm_clean.py 只修采样帧、且只取正高通残差，
残留明显。用当前版本重跑这些集。

用法:
    python3 scripts/wm_clean_rebuild_stale.py --list
    python3 scripts/wm_clean_rebuild_stale.py --parallel 2
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLEAN = os.path.join(ROOT, 'media', 'clean')
IMPORTED = os.path.join(ROOT, 'media', 'imported')
SCAN = os.path.join(ROOT, 'data', 'watermark-scan.json')
PY = os.path.join(ROOT, '.venv-wm', 'bin', 'python')
CLEANER = os.path.join(ROOT, 'scripts', 'wm_clean.py')
STAMP = os.path.join(ROOT, 'data', 'wm-clean-version.txt')


def current_version():
    """用 wm_clean.py 的内容哈希作为"算法版本"标记。"""
    import hashlib
    with open(CLEANER, 'rb') as f:
        return hashlib.sha1(f.read()).hexdigest()[:12]


def read_stamp():
    try:
        with open(STAMP) as f:
            return f.read().strip()
    except OSError:
        return None


def write_stamp(v):
    os.makedirs(os.path.dirname(STAMP), exist_ok=True)
    with open(STAMP, 'w') as f:
        f.write(v)


def wm_ids():
    scan = json.load(open(SCAN))
    return {k for k, v in scan.items() if v.get('wm') or v.get('watermark')}


def stale_tasks(only_ids=None, only_files=None):
    """需要重建的集：已存在 clean 文件，但版本标记早于当前算法。"""
    cur = current_version()
    stamp = read_stamp()
    ids = wm_ids()
    tasks = []
    if only_files:
        # 精确重建指定文件（用于校验发现残留的集）
        want = {os.path.realpath(os.path.abspath(f)) for f in only_files}
        for p in sorted(glob.glob(os.path.join(CLEAN, '*', '*.mp4'))):
            if '.tmp.' in os.path.basename(p):
                continue
            if os.path.realpath(p) not in want:
                continue
            did = os.path.basename(os.path.dirname(p))
            src = os.path.join(IMPORTED, did, os.path.basename(p))
            if not os.path.exists(src):
                continue
            tasks.append({'id': did, 'src': os.path.realpath(src),
                          'dest': p, 'mtime': os.path.getmtime(p)})
        return tasks
    for p in sorted(glob.glob(os.path.join(CLEAN, '*', '*.mp4'))):
        if '.tmp.' in os.path.basename(p):
            continue
        did = os.path.basename(os.path.dirname(p))
        if ids and did not in ids:
            continue
        if only_ids and did not in only_ids:
            continue
        if stamp and stamp == cur:
            # 已经用当前算法整体标记过，仍然用 mtime 粗判是否需要重跑
            pass
        src = os.path.join(IMPORTED, did, os.path.basename(p))
        if not os.path.exists(src):
            continue
        # 用 mtime 与算法文件 mtime 比较：clean 比 wm_clean.py 旧 => 版本落后
        if os.path.getmtime(p) < os.path.getmtime(CLEANER):
            tasks.append({'id': did, 'src': os.path.realpath(src),
                          'dest': p, 'mtime': os.path.getmtime(p)})
    return tasks


def run_task(task):
    # 临时文件名带进程号：多个批次并行跑时不会互相覆盖同一个 .tmp.mp4
    tmp = f"{task['dest']}.tmp.{os.getpid()}.mp4"
    try:
        r = subprocess.run([PY, CLEANER, task['src'], '-o', tmp],
                           capture_output=True, text=True, timeout=7200)
        out = (r.stdout or '') + (r.stderr or '')
        if r.returncode != 0 or not os.path.exists(tmp):
            if '未找到水印候选' in out or '无法稳定追踪' in out:
                return {'id': task['id'], 'ok': True, 'skipped': True, 'info': '无水印'}
            return {'id': task['id'], 'ok': False, 'error': out.strip()[-300:]}
        os.replace(tmp, task['dest'])
        info = ''
        for line in out.split('\n'):
            if '修复' in line and '完成' in line:
                info = line.strip()
        return {'id': task['id'], 'ok': True, 'info': info}
    except subprocess.TimeoutExpired:
        return {'id': task['id'], 'ok': False, 'error': 'timeout'}
    except Exception as e:
        return {'id': task['id'], 'ok': False, 'error': str(e)[:300]}
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--parallel', type=int, default=2)
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--work', action='append', default=[])
    ap.add_argument('--files', action='append', default=[],
                    help='精确重建指定的 clean 文件（可重复）')
    a = ap.parse_args()

    tasks = stale_tasks(set(a.work) if a.work else None,
                        a.files if a.files else None)
    print(f'需重建 {len(tasks)} 集（算法版本 {current_version()}）')
    if a.list or a.dry_run:
        for t in tasks:
            print(f'  {t["id"]}/{os.path.basename(t["dest"])}')
        return
    if not tasks:
        return
    t0 = time.time()
    done = failed = 0
    with ThreadPoolExecutor(max_workers=max(1, a.parallel)) as ex:
        futs = {ex.submit(run_task, t): t for t in tasks}
        for fut in as_completed(futs):
            r = fut.result()
            done += 1
            if r['ok']:
                tag = '跳过' if r.get('skipped') else '✓'
                print(f'  [{done}/{len(tasks)}] {tag} {r["id"]} {r.get("info", "")}', flush=True)
            else:
                failed += 1
                print(f'  [{done}/{len(tasks)}] ✗ {r["id"]} {r.get("error", "")}', flush=True)
    print(f'\n完成 {done - failed} 集，失败 {failed} 集，用时 {(time.time() - t0) / 60:.1f} min')
    write_stamp(current_version())


if __name__ == '__main__':
    main()
