"""Download the pinned public PS3 release, validating every Git blob hash."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import shutil
import time
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
COMMIT = '16526c02579c7f37e54eaaa42a4cc6d4ceb19994'
REPOSITORY = 'aochinwen/NebulaX-Hackathon-ProblemStatement'
NAMES = {'door': 'Door', 'acv': 'ACV', 'rail': 'Rail_Corrugation', 'shm': 'SHM'}


def download(subsystems=None, workers=4):
    target = ROOT / 'data/ps3'
    target.mkdir(parents=True, exist_ok=True)
    cached = ROOT / '.cache/ps3-release'
    tree_path = target / 'repository-tree.json'
    if not tree_path.exists():
        old = cached / 'repository-tree.json'
        if old.exists() and json.loads(old.read_text(encoding='utf-8-sig')).get('sha') == COMMIT:
            shutil.copyfile(old, tree_path)
        else:
            req = Request(f'https://api.github.com/repos/{REPOSITORY}/git/trees/{COMMIT}?recursive=1', headers={'User-Agent': 'RailGuard-PS3'})
            with urlopen(req, timeout=45) as response:
                tree_path.write_bytes(response.read())
    tree = json.loads(tree_path.read_text(encoding='utf-8-sig'))
    if tree.get('sha') != COMMIT or tree.get('truncated'):
        raise ValueError('Expected the complete pinned repository tree.')
    chosen = {NAMES[s] for s in (subsystems or list(NAMES))}
    entries = [e for e in tree['tree'] if e['type'] == 'blob' and (
        e['path'].startswith('PS3/02_Datasets/') and e['path'].split('/')[2] in chosen
        or e['path'].startswith('PS3/03_References/') and e['path'].endswith('.md')
        or e['path'].startswith('PS3/04_Example_Submission/')
        or e['path'] == 'PS3/01_Problem_Statement_3_Specifications.md')]
    # Small subsystems become available first for parallel development/training.
    order = {'Door': 0, 'ACV': 1, 'SHM': 2, 'Rail_Corrugation': 3}
    entries.sort(key=lambda e: (order.get((e['path'].split('/') + [''])[2], -1), e['path']))
    print(json.dumps({'files': len(entries), 'bytes': sum(e['size'] for e in entries), 'commit': COMMIT}), flush=True)
    if shutil.disk_usage(target).free < sum(e['size'] for e in entries if not (target / e['path']).exists()) + 1024**3:
        raise ValueError('Insufficient free disk space for the selected release plus 1 GiB headroom.')

    def digest(path):
        size = path.stat().st_size
        git = hashlib.sha1(f'blob {size}\0'.encode())
        sha = hashlib.sha256()
        with path.open('rb') as handle:
            while block := handle.read(1024**2):
                git.update(block)
                sha.update(block)
        return git.hexdigest(), sha.hexdigest()

    def fetch(entry):
        path = target / entry['path']
        path.parent.mkdir(parents=True, exist_ok=True)
        for candidate in (path, cached / entry['path']):
            if candidate.is_file() and candidate.stat().st_size == entry['size']:
                git, sha = digest(candidate)
                if git == entry['sha']:
                    if candidate != path:
                        shutil.copyfile(candidate, path)
                    return {**entry, 'sha256': sha}
        url = f'https://raw.githubusercontent.com/{REPOSITORY}/{COMMIT}/{quote(entry["path"], safe="/")}'
        partial = path.with_suffix(path.suffix + '.partial')
        for attempt in range(3):
            try:
                request = Request(url, headers={'User-Agent': 'RailGuard-PS3'})
                with urlopen(request, timeout=60) as response, partial.open('wb') as handle:
                    while block := response.read(1024**2):
                        handle.write(block)
                git, sha = digest(partial)
                if partial.stat().st_size != entry['size'] or git != entry['sha']:
                    raise ValueError(f'Hash verification failed: {entry["path"]}')
                partial.replace(path)
                return {**entry, 'sha256': sha}
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)

    records = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        tasks = {pool.submit(fetch, e): e for e in entries}
        for future in as_completed(tasks):
            record = future.result()
            records.append(record)
            if len(records) % 20 == 0 or len(records) == len(entries):
                print(json.dumps({'completed': len(records), 'total': len(entries), 'last': record['path']}), flush=True)
    manifest = {'repository': f'https://github.com/{REPOSITORY}', 'commit': COMMIT, 'files': sorted(records, key=lambda e: e['path'])}
    (target / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('Verified release saved to data/ps3.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--subsystems', nargs='+', choices=list(NAMES))
    parser.add_argument('--workers', type=int, default=4, choices=range(1, 9))
    args = parser.parse_args()
    download(args.subsystems, args.workers)
