#!/usr/bin/env python3
"""批量去水印：media/imported -> media/clean。

只处理 scripts/wm_scan_imported.py 判定为"有水印"的剧（或者全部 --all）。
输出：media/clean/<dramaId>/episode-N.mp4

用法:
    python3 wm_clean_batch.py --parallel 3
    python3 wm_clean_batch.py --all --parallel 3
    python3 wm_clean_batch.py --work local-xxx --work local-yyy
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMPORTED = os.path.join(ROOT, 'media', 'imported')
CLEAN = os.path.join(ROOT, 'media', 'clean')
SCAN = os.path.join(ROOT, 'data', 'watermark-scan.json')
PY = os.path.join(ROOT, '.venv-wm', 'bin', 'python')
CLEANER = os.path.join(ROOT, 'scripts', 'wm_clean.py')


def load_targets(all_dramas=False, only=None):
    if only:
        ids = only
    else:
        scan = json.load(open(SCAN))
        ids = [k for k, v in scan.items() if v.get('watermark')]
        if all_dramas:
            ids = list(scan.keys())
    tasks = []
    for drama_id in ids:
        d = os.path.join(IMPORTED, drama_id)
        if not os.path.isdir(d):
            continue
        for name in sorted(f for f in os.listdir(d) if f.endswith('.mp4')):
            dest = os.path.join(CLEAN, drama_id, name)
            if os.path.exists(dest) and os.path.getsize(dest) > 0:
                continue
            tasks.append({'id': drama_id, 'src': os.path.realpath(os.path.join(d, name)),
                          'dest': dest})
    return tasks


def run_task(task):
    os.makedirs(os.path.dirname(task['dest']), exist_ok=True)
    tmp = task['dest'] + '.tmp.mp4'
    try:
        r = subprocess.run([PY, CLEANER, task['src'], '-o', tmp],
                           capture_output=True, text=True, timeout=3600)
        out = (r.stdout or '') + (r.stderr or '')
        if r.returncode != 0 or not os.path.exists(tmp):
            # "未找到水印候选" 表示这一集本来就没有水印，不算失败
            if '未找到水印候选' in out or '无法稳定追踪' in out:
                return {'id': task['id'], 'ok': True, 'skipped': True,
                        'info': '无水印，跳过'}
            return {'id': task['id'], 'ok': False, 'error': out.strip()[-300:]}
        os.replace(tmp, task['dest'])
        pct = ''
        for line in out.split('\n'):
            if '修复' in line and '完成' in line:
                pct = line.strip()
        return {'id': task['id'], 'ok': True, 'info': pct}
    except subprocess.TimeoutExpired:
        return {'id': task['id'], 'ok': False, 'error': 'timeout'}
    except Exception as e:
        return {'id': task['id'], 'ok': False, 'error': str(e)[:300]}
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--work', action='append', default=[])
    ap.add_argument('--parallel', type=int, default=3)
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()
    tasks = load_targets(a.all, a.work)
    if a.limit:
        tasks = tasks[:a.limit]
    print(f'待处理 {len(tasks)} 集（并发 {a.parallel}）', flush=True)
    if not tasks:
        return
    t0 = time.time()
    done = failed = 0
    results = []
    with ThreadPoolExecutor(max_workers=max(1, a.parallel)) as ex:
        for r in ex.map(run_task, tasks):
            done += 1
            if r['ok']:
                tag = '跳过' if r.get('skipped') else '✓'
                print(f'  [{done}/{len(tasks)}] {tag} {r["id"]} {r.get("info","")}', flush=True)
            else:
                failed += 1
                print(f'  [{done}/{len(tasks)}] ✗ {r["id"]} {r.get("error","")}', flush=True)
            results.append(r)
    mins = (time.time() - t0) / 60
    print(f'\n完成 {done - failed} 集，失败 {failed} 集，用时 {mins:.1f} min')
    bad = [r for r in results if not r['ok']]
    if bad:
        print('失败清单:', json.dumps([r['id'] for r in bad], ensure_ascii=False))


if __name__ == '__main__':
    main()
