"""Verify a running local PS3 app, optional real AI, and exact prediction exports."""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import sys
import time
import zipfile

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.ps3.service import COLUMNS, SUBSYSTEMS, validate_predictions  # noqa: E402


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024**2), b''):
            digest.update(block)
    return digest.hexdigest()


def verify(base_url, output_dir, all_files=False, ai=False):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    base = base_url.rstrip('/') + '/api/ps3'
    hashes = {name: sha256(ROOT / 'data/ps3_artifacts' / name / 'model.joblib') for name in SUBSYSTEMS}
    manifest = json.loads((ROOT / 'data/ps3/manifest.json').read_text(encoding='utf-8'))
    original_hashes = {item['path']: item['sha256'] for item in manifest['files']}
    summary = {'verified_at': datetime.now(timezone.utc).isoformat(), 'all_files': all_files,
               'release_commit': manifest['commit'], 'subsystems': {}, 'ai_requested': ai}
    with httpx.Client(timeout=90) as client:
        def get(path):
            response = client.get(base + path)
            response.raise_for_status()
            return response.json()

        def post(path, body):
            response = client.post(base + path, json=body)
            response.raise_for_status()
            return response

        status = get('/status')
        require(all(s['available'] for s in status['subsystems']), 'All four trained models must be available.')
        if ai:
            require(status['assistant']['available'], 'OpenAI is not configured. Add the key locally and enable the assistant.')
        expected_counts = {s['id']: s['example_files'] if all_files else 1 for s in status['subsystems']}
        jobs = {name: post('/examples/' + name, {'all_files': all_files}).json()['id'] for name in SUBSYSTEMS}
        (output_dir / 'job_ids.json').write_text(json.dumps(jobs, indent=2), encoding='utf-8')
        pending, results, previous = set(jobs), {}, {}
        deadline = time.monotonic() + 600
        while pending and time.monotonic() < deadline:
            for name in sorted(pending.copy()):
                job = get('/jobs/' + jobs[name])
                state = (job['status'], job['progress']['completed'])
                if previous.get(name) != state:
                    print(f"{name}: {state[0]} {state[1]}/{job['progress']['total']}", flush=True)
                    previous[name] = state
                require(job['status'] != 'failed', f"{name} inference failed: {job.get('error', 'check backend log')}")
                if job['status'] == 'completed':
                    results[name] = job
                    pending.remove(name)
            if pending:
                time.sleep(2)
        require(not pending, 'Timed out while waiting for prediction jobs.')

        for name, job in results.items():
            require(len(job['reports']) == expected_counts[name], f'{name}: incomplete file coverage.')
            require(job['model_sha256'] == hashes[name], f'{name}: unexpected model version.')
            expected_paths = {}
            prefix = f"PS3/02_Datasets/{SUBSYSTEMS[name]['folder']}/"
            for path, checksum in original_hashes.items():
                if path == prefix + 'Test.csv' or path.startswith(prefix + 'Test/'):
                    expected_paths[Path(path).name] = checksum
            names = set()
            for report in job['reports']:
                validate_predictions(name, report)
                require(report['input_sha256'] == expected_paths.get(report['file_id']), f'{name}: input differs from the verified release.')
                names.add(report['file_id'])
            if all_files:
                require(names == set(expected_paths), f'{name}: missing or unexpected official source filenames.')
            summary['subsystems'][name] = {'job_id': job['id'], 'files': len(job['reports']),
                'prediction_rows': sum(len(r['prediction_rows']) for r in job['reports']),
                'model': job['model_name'], 'model_sha256': job['model_sha256'],
                'local_validation': job['validation']['score']}

        raw = post('/export', {'job_ids': list(jobs.values())}).content
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            require(set(archive.namelist()) == {f'{name}_predictions.csv' for name in jobs}, 'Incorrect ZIP root entries.')
            for name, job in results.items():
                reader = csv.DictReader(io.StringIO(archive.read(f'{name}_predictions.csv').decode('utf-8')))
                require(reader.fieldnames == COLUMNS[name], f'{name}: incorrect CSV header.')
                rows = list(reader)
                expected = [{k: str(v) for k, v in row.items()} for report in job['reports'] for row in report['prediction_rows']]
                require(rows == expected, f'{name}: exported values differ from retained predictions.')
        (output_dir / 'predictions.zip').write_bytes(raw)
        summary['zip_sha256'] = hashlib.sha256(raw).hexdigest()
        summary['total_files'] = sum(s['files'] for s in summary['subsystems'].values())

        if ai:
            questions = {
                'door': 'What evidence supports the detected actions, and does this verify a mechanical fault?',
                'acv': 'Why is the first car ranked for inspection? Compare measured evidence and explain what cannot be concluded.',
                'rail': 'Explain this prediction and the local validation limitations, especially sensitivity for Side I.',
                'shm': 'What does the damage estimate mean? Can you derive remaining life or a maintenance deadline from it?',
            }
            for name, job in results.items():
                answer = post('/investigate', {'job_id': job['id'], 'file_id': job['reports'][0]['file_id'], 'question': questions[name]}).json()
                (output_dir / f'{name}-investigation.json').write_text(json.dumps(answer, ensure_ascii=False, indent=2), encoding='utf-8')
                summary['subsystems'][name]['assistant'] = {'mode': answer['mode'], 'sources': answer['sources'], 'tools': answer['tools']}
                require(answer['mode'] == 'agent', f'{name}: AI verification used local fallback. Check the saved response warning.')
                require(any(t['name'] == 'get_prediction_evidence' for t in answer['tools']), f'{name}: agent did not retrieve prediction evidence.')
                print(f'{name}: live OpenAI investigation passed', flush=True)
    require(all(sha256(ROOT / 'data/ps3_artifacts' / name / 'model.joblib') == checksum for name, checksum in hashes.items()), 'A frozen model changed during verification.')
    summary['frozen_models_unchanged'] = True
    (output_dir / 'verification.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(f"Verified {summary['total_files']} files. Output: {output_dir}", flush=True)
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:3000')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'outputs/ps3-check')
    parser.add_argument('--all-files', action='store_true', help='Check all 86 installed official Test recordings, not just one per task.')
    parser.add_argument('--ai', action='store_true', help='Send four diagnostic-summary investigations to configured OpenAI; normal API charges apply.')
    args = parser.parse_args()
    try:
        verify(args.base_url, args.output_dir, args.all_files, args.ai)
    except (httpx.HTTPError, ValueError, OSError, KeyError) as error:
        # HTTP exception text contains URLs/status, never print request headers or keys.
        raise SystemExit(f'PS3 verification failed: {error}')
