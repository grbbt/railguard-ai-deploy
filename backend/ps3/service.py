"""Persisted PS3 inference jobs and exact competition exports; never trains on upload."""
from __future__ import annotations

from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import csv
import hashlib
import heapq
import importlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import time
from threading import RLock
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[2]
COMMIT = '16526c02579c7f37e54eaaa42a4cc6d4ceb19994'
REPOSITORY = 'https://github.com/aochinwen/NebulaX-Hackathon-ProblemStatement'
SUBSYSTEMS = {
    'door': {'title': 'Door systems', 'folder': 'Door', 'task': 'Action segmentation and resistance classification', 'metric': 'IoU-weighted F1', 'extension': '.csv'},
    'acv': {'title': 'Climate systems', 'folder': 'ACV', 'task': 'Refrigerant-leak car ranking', 'metric': 'Linear rank-decay', 'extension': '.xlsx'},
    'rail': {'title': 'Rail corrugation', 'folder': 'Rail_Corrugation', 'task': 'Normal / Side I / Side II classification', 'metric': 'Macro F1', 'extension': '.csv'},
    'shm': {'title': 'Structural health', 'folder': 'SHM', 'task': 'Cumulative fatigue damage regression', 'metric': '1 − MAPE (floor 0)', 'extension': '.csv'},
}
COLUMNS = {'door': ['start_time', 'end_time', 'prediction'], 'acv': ['file_id', 'ranked_cars'],
           'rail': ['file_id', 'prediction'], 'shm': ['file_id', 'prediction']}
MAX_PENDING_JOBS = 8
MAX_JOB_SUMMARIES = 512


def _lease_lock(handle):
    """Nonblocking process-lifetime lock; the OS releases it after a crash."""
    handle.seek(0)
    if os.name == 'nt':
        import msvcrt
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _file_sha256(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def clean_json(value):
    if isinstance(value, dict):
        return {str(k): clean_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean_json(v) for v in value]
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if hasattr(value, 'tolist'):
        return clean_json(value.tolist())
    if isinstance(value, Path):
        return str(value)
    return value


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(clean_json(value), ensure_ascii=False, allow_nan=False, indent=2), encoding='utf-8')
    try:
        # Windows indexers/sync clients can briefly hold the destination open.
        for attempt in range(8):
            try:
                temporary.replace(path)
                break
            except PermissionError:
                if attempt == 7:
                    raise
                time.sleep(min(.02 * 2**attempt, .5))
    finally:
        temporary.unlink(missing_ok=True)


def safe_filename(name, extension):
    if not name or len(name) > 150 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_. ()-]*', name):
        raise ValueError('Use a source filename containing only letters, numbers, spaces, dots, underscores, parentheses or hyphens.')
    if '/' in name or '\\' in name or Path(name).name != name or not name.lower().endswith(extension):
        raise ValueError(f'This subsystem accepts {extension} files with a plain source filename.')
    if name.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(10)), *(f'LPT{i}' for i in range(10))}:
        raise ValueError('This filename is reserved by Windows; choose another filename.')
    return name


def validate_predictions(subsystem, report):
    rows = report.get('prediction_rows')
    if not isinstance(rows, list) or not rows:
        raise ValueError('The model produced no prediction rows. Review the input and available evidence.')
    if subsystem != 'door' and len(rows) != 1:
        raise ValueError('Expected exactly one prediction per source file.')
    for row in rows:
        if set(row) != set(COLUMNS[subsystem]):
            raise ValueError('The prediction schema does not match the official PS3 format.')
        if subsystem != 'door' and row.get('file_id') != report['file_id']:
            raise ValueError('Prediction filename does not match its source.')
        if subsystem == 'door':
            if row['prediction'] not in {'Normal', 'Abnormal resistance'}:
                raise ValueError('Invalid Door prediction label.')
            def instant(v):
                text = str(v)
                if re.fullmatch(r'\d{4}(?:-\d{1,3}){6}', text):
                    y, mo, d, h, mi, s, ms = map(int, text.split('-'))
                    return datetime(y, mo, d, h, mi, s, ms * 1000)
                return datetime.fromisoformat(text.replace('Z', '+00:00'))
            if instant(row['end_time']) <= instant(row['start_time']):
                raise ValueError('Door segment ends must be later than their starts.')
        elif subsystem == 'acv':
            cars = str(row['ranked_cars']).split('|')
            # The released contract is eight header-derived two-digit identifiers.
            if len(cars) != 8 or len(set(cars)) != 8 or any(not re.fullmatch(r'\d{2}', c) for c in cars):
                raise ValueError('ACV rankings must contain all eight distinct two-digit car identifiers.')
        elif subsystem == 'rail' and row['prediction'] not in {'Normal', 'Side I', 'Side II'}:
            raise ValueError('Invalid Rail prediction label.')
        elif subsystem == 'shm':
            if isinstance(row['prediction'], bool) or not isinstance(row['prediction'], (int, float)) or not math.isfinite(row['prediction']) or row['prediction'] < 0:
                raise ValueError('SHM damage predictions must be finite nonnegative numbers.')


class PS3Service:
    def __init__(self, data_dir=None, artifacts_dir=None, jobs_dir=None, predictor=None):
        self.data_dir = Path(data_dir or ROOT / 'data/ps3/PS3/02_Datasets')
        self.artifacts_dir = Path(artifacts_dir or ROOT / 'data/ps3_artifacts')
        self.jobs_dir = Path(jobs_dir or ROOT / 'data/runtime/ps3_jobs')
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='ps3-inference')
        self._predictor = predictor
        self._closed = False
        self._pending = {}
        self._model_cache = {}
        self._job_summary_cache = OrderedDict()
        self._owner_session = uuid.uuid4().hex
        owners = self.jobs_dir / '.owners'
        owners.mkdir(exist_ok=True)
        self._owner_handle = (owners / (self._owner_session + '.lock')).open('x+b')
        try:
            self._owner_handle.write(b'1')
            self._owner_handle.flush()
            _lease_lock(self._owner_handle)
        except BaseException:
            self._owner_handle.close()
            self._pool.shutdown(wait=False, cancel_futures=True)
            raise
        # Another app instance may be serving these same jobs. Only recover work
        # whose owner has released its lease; a PID alone is vulnerable to reuse.
        for path in self._job_records():
            try:
                job = json.loads(path.read_text(encoding='utf-8'))
                self._recover_abandoned(path, job)
            except (OSError, ValueError, TypeError, KeyError, OverflowError, RecursionError):
                continue

    def close(self):
        """Stop accepting work, cancel queued jobs and let active inference finish."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._pool.shutdown(wait=False, cancel_futures=True)
            self._release_owner_if_done()

    def _release_owner_if_done(self):
        if self._closed and not self._pending and not self._owner_handle.closed:
            self._owner_handle.close()

    def _owner_active(self, session):
        if not isinstance(session, str) or not re.fullmatch(r'[a-f0-9]{32}', session):
            return False  # Legacy jobs have no surviving, verifiable owner.
        if session == self._owner_session and not self._owner_handle.closed:
            return True
        path = self.jobs_dir / '.owners' / (session + '.lock')
        try:
            with path.open('r+b') as handle:
                try:
                    _lease_lock(handle)
                except OSError:
                    return True  # Locked or uncertain: never invalidate possible live work.
            return False
        except FileNotFoundError:
            return False
        except OSError:
            return True

    def _recover_abandoned(self, path, job):
        if not isinstance(job, dict):
            raise ValueError('The saved job record is invalid.')
        if job.get('status') in {'running', 'queued'} and not self._owner_active(job.get('owner_session')):
            # The worker may have completed between our first read and its lease
            # release. Never replace its newer terminal record with stale state.
            job = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(job, dict):
                raise ValueError('The saved job record is invalid.')
            if job.get('status') in {'running', 'queued'} and not self._owner_active(job.get('owner_session')):
                job.update(status='failed', reports=[], error='The service owning this job stopped before completion. Run the files again.', finished_at=utcnow())
                atomic_json(path, job)
        return job

    def _job_finished(self, future, job):
        with self._lock:
            try:
                if future.cancelled():
                    job.update(status='failed', reports=[], error='The service stopped before this queued job began. Run the files again.', finished_at=utcnow())
                    self._save(job)
                elif future.exception() is not None:
                    job.update(status='failed', reports=[], error='Inference stopped unexpectedly. Check the local backend log and retry.', finished_at=utcnow())
                    self._save(job)
            finally:
                self._pending.pop(future, None)
                self._release_owner_if_done()

    def spec(self, subsystem):
        if subsystem not in SUBSYSTEMS:
            raise ValueError('Choose Door, ACV, Rail or SHM.')
        return SUBSYSTEMS[subsystem]

    def model(self, subsystem):
        self.spec(subsystem)
        directory = self.artifacts_dir / subsystem
        paths = (directory / 'model.joblib', directory / 'metadata.json')
        def fingerprint():
            return tuple((s.st_mtime_ns, s.st_ctime_ns, s.st_size, s.st_ino) for s in (path.stat() for path in paths))
        def valid_score(value):
            return value is None or type(value) in (int, float) and math.isfinite(value)
        with self._lock:
            try:
                stamp = fingerprint()
                cached = self._model_cache.get(subsystem)
                if cached and cached[0] == stamp:
                    return cached[1]
                metadata = json.loads(paths[1].read_text(encoding='utf-8'))
                if not isinstance(metadata, dict):
                    metadata = None
                elif self._predictor is None:
                    validation = metadata.get('validation')
                    valid = (metadata.get('subsystem') == subsystem and
                             isinstance(metadata.get('model_name'), str) and bool(metadata['model_name'].strip()) and
                             isinstance(metadata.get('trained_at'), str) and
                             all(type(metadata.get(key)) is int and metadata[key] > 0 for key in ('training_files', 'training_rows')) and
                             isinstance(validation, dict) and
                             all(isinstance(validation.get(key), str) and bool(validation[key].strip()) for key in ('metric', 'method')) and
                             'score' in validation and valid_score(validation['score']) and
                             isinstance(validation.get('candidates'), list) and isinstance(validation.get('limitations'), list) and
                             all(isinstance(item, str) for item in validation['limitations']) and
                             all(isinstance(item, dict) and isinstance(item.get('name'), str) and 'score' in item and valid_score(item['score']) for item in validation['candidates']) and
                             isinstance(metadata.get('model_sha256'), str) and bool(re.fullmatch(r'[a-f0-9]{64}', metadata['model_sha256'])))
                    if valid:
                        trained = datetime.fromisoformat(metadata['trained_at'].replace('Z', '+00:00'))
                        valid = (trained.utcoffset() is not None and trained.utcoffset().total_seconds() == 0 and
                                 _file_sha256(paths[0]) == metadata['model_sha256'])
                    if not valid:
                        metadata = None
                if fingerprint() != stamp:
                    return None  # A training publication changed files during validation.
                self._model_cache[subsystem] = (stamp, metadata)
                return metadata
            except (OSError, ValueError, TypeError):
                return None

    def examples(self, subsystem):
        spec = self.spec(subsystem)
        directory = self.data_dir / spec['folder']
        files = [directory / 'Test.csv'] if subsystem == 'door' else sorted((directory / 'Test').glob('*' + spec['extension']), key=lambda p: [int(v) if v.isdigit() else v for v in re.split(r'(\d+)', p.name.lower())])
        return [p for p in files if p.is_file()]

    def status(self):
        from backend.ps3.assistant import configuration
        models = {key: self.model(key) for key in SUBSYSTEMS}
        return {'subsystems': [{'id': key, 'title': spec['title'], 'task': spec['task'], 'metric': spec['metric'],
                                'available': models[key] is not None, 'model': models[key], 'example_files': len(self.examples(key))}
                               for key, spec in SUBSYSTEMS.items()],
                'assistant': configuration(), 'source': {'repository': REPOSITORY, 'commit': COMMIT},
                'limits': {'file_mb': 64, 'batch_files': 100, 'batch_mb': 1500,
                           'upload_encodings': ['identity', 'gzip']}}

    def _job_path(self, job_id):
        if not re.fullmatch(r'[a-f0-9]{32}', job_id):
            raise KeyError('PS3 job not found.')
        return self.jobs_dir / job_id / 'job.json'

    def _job_records(self):
        """Only direct, internally named records; do not follow linked directories."""
        root = self.jobs_dir.resolve()
        with os.scandir(root) as entries:
            for entry in entries:
                if not re.fullmatch(r'[a-f0-9]{32}', entry.name):
                    continue
                try:
                    directory = root / entry.name
                    path = directory / 'job.json'
                    if (entry.is_dir(follow_symlinks=False) and directory.resolve() == directory and
                            path.resolve() == path and path.is_file()):
                        yield path
                except (OSError, RuntimeError):
                    continue

    @staticmethod
    def _job_summary(job_id, job):
        """Allowlisted display fields, never raw reports or arbitrary error strings."""
        if not isinstance(job, dict) or job.get('id') != job_id:
            raise ValueError('Invalid saved job identity.')
        subsystem, status, source = (job.get(key) for key in ('subsystem', 'status', 'source'))
        if (subsystem not in SUBSYSTEMS or status not in {'queued', 'running', 'completed', 'failed'} or
                source not in {'uploaded', 'organiser_test'}):
            raise ValueError('Invalid saved job summary.')
        def instant(value):
            if not isinstance(value, str):
                raise ValueError('Invalid saved job date.')
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.utcoffset() is None:
                raise ValueError('Saved job dates must include a timezone.')
            return parsed.astimezone(timezone.utc)
        created = instant(job.get('created_at'))
        finished = job.get('finished_at')
        if finished is not None:
            instant(finished)
        progress = job.get('progress')
        if not isinstance(progress, dict):
            raise ValueError('Invalid saved job progress.')
        completed, total = progress.get('completed'), progress.get('total')
        if not (type(completed) is int and type(total) is int and 0 <= completed <= total <= 100 and total > 0):
            raise ValueError('Invalid saved job file counts.')
        def filename(value):
            try:
                return safe_filename(value, SUBSYSTEMS[subsystem]['extension']) if isinstance(value, str) else None
            except ValueError:
                return None
        first_file = filename(job.get('first_file'))
        reports = job.get('reports')
        if status == 'completed' and (completed != total or not isinstance(reports, list) or
                                      len(reports) != total or not all(isinstance(report, dict) for report in reports)):
            raise ValueError('The completed job has incomplete saved reports.')
        if first_file is None and isinstance(reports, list) and reports and isinstance(reports[0], dict):
            first_file = filename(reports[0].get('file_id'))
        # A current filename identifies the first source only for a one-file job.
        if first_file is None and total == 1:
            first_file = filename(progress.get('filename'))
        summary = {'id': job_id, 'subsystem': subsystem, 'status': status,
                   'created_at': job['created_at'], 'finished_at': finished, 'source': source,
                   'progress': {'completed': completed, 'total': total, 'filename': filename(progress.get('filename'))},
                   'error': 'Analysis failed. Open the saved job for details.' if status == 'failed' else None,
                   'first_file': first_file, 'file_count': total}
        model_name = job.get('model_name')
        if (isinstance(model_name, str) and 0 < len(model_name) <= 200 and
                not any(character in model_name for character in '/\\\r\n') and ':' not in model_name):
            summary['model_name'] = model_name
        return created, summary

    def list_jobs(self, limit=40, subsystem=None):
        """Discover saved results without retaining or returning their telemetry."""
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError('Choose a saved-job limit between 1 and 100.')
        if subsystem is not None:
            self.spec(subsystem)
        newest, total = [], 0
        latest_completed, active_jobs = {}, []
        for path in self._job_records():
            job_id = path.parent.name
            try:
                def fingerprint():
                    stat = path.stat()
                    return stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size, stat.st_ino
                stamp = fingerprint()
                with self._lock:
                    cached = self._job_summary_cache.get(job_id)
                    if cached and cached[0] == stamp:
                        self._job_summary_cache.move_to_end(job_id)
                    else:
                        cached = None
                if cached is not None:
                    created, summary = cached[1:]
                else:
                    # get() checks ownership and recovers jobs abandoned since startup.
                    created, summary = self._job_summary(job_id, self.get(job_id))
                    if summary['status'] in {'completed', 'failed'} and fingerprint() == stamp:
                        with self._lock:
                            self._job_summary_cache[job_id] = (stamp, created, summary)
                            self._job_summary_cache.move_to_end(job_id)
                            while len(self._job_summary_cache) > MAX_JOB_SUMMARIES:
                                self._job_summary_cache.popitem(last=False)
                if subsystem is not None and summary['subsystem'] != subsystem:
                    continue
                total += 1
                item = (created, job_id, summary)
                if summary['status'] == 'completed':
                    previous = latest_completed.get(summary['subsystem'])
                    if previous is None or item[:2] > previous[:2]:
                        latest_completed[summary['subsystem']] = item
                elif summary['status'] in {'queued', 'running'}:
                    active_jobs.append(item)
                if len(newest) < limit:
                    heapq.heappush(newest, item)
                elif item[:2] > newest[0][:2]:
                    heapq.heapreplace(newest, item)
            except (OSError, ValueError, TypeError, KeyError, OverflowError, RecursionError):
                # A damaged/deleted record must not hide the other saved analyses.
                continue
        # Copies keep callers from mutating the small cached summaries.
        def summaries(items):
            return [{**summary, 'progress': dict(summary['progress'])} for _, _, summary in items]
        return {'jobs': summaries(sorted(newest, reverse=True)), 'total': total, 'limit': limit,
                'latest_completed': summaries(latest_completed[key] for key in SUBSYSTEMS if key in latest_completed),
                'active_jobs': summaries(sorted(active_jobs, reverse=True))}

    def get(self, job_id):
        path = self._job_path(job_id)
        with self._lock:
            if not path.is_file():
                raise KeyError('PS3 job not found. It may belong to a different local workspace.')
            return self._recover_abandoned(path, json.loads(path.read_text(encoding='utf-8')))

    def _save(self, job):
        with self._lock:
            atomic_json(self._job_path(job['id']), job)

    def create(self, subsystem, files, source='uploaded', job_id=None):
        spec = self.spec(subsystem)
        metadata = self.model(subsystem)
        if not metadata and self._predictor is None:
            raise ValueError('No trained model is available. Run scripts/train_ps3.py before inference.')
        files = [Path(p) for p in files]
        if not 1 <= len(files) <= 100:
            raise ValueError('Choose between one and 100 input files.')
        names = [safe_filename(p.name, spec['extension']) for p in files]
        if len({n.casefold() for n in names}) != len(names):
            raise ValueError('Duplicate filenames in a batch would make prediction IDs ambiguous.')
        if subsystem == 'door' and len(files) != 1:
            raise ValueError('Run one continuous Door stream per job so its segment timestamps remain unambiguous.')
        job_id = job_id or uuid.uuid4().hex
        self._job_path(job_id)
        job = {'id': job_id, 'subsystem': subsystem, 'status': 'queued', 'progress': {'completed': 0, 'total': len(files), 'filename': None},
               'first_file': names[0],
               'created_at': utcnow(), 'reports': [], 'source': source, 'validation': (metadata or {}).get('validation'),
               'model_name': (metadata or {}).get('model_name'), 'model_trained_at': (metadata or {}).get('trained_at'),
               'model_sha256': (metadata or {}).get('model_sha256'),
               'release_commit': COMMIT if source == 'organiser_test' else None,
               'owner_session': self._owner_session, 'owner_pid': os.getpid()}
        with self._lock:
            if self._closed:
                raise ValueError('The inference service is shutting down. Retry after restarting it.')
            if len(self._pending) >= MAX_PENDING_JOBS:
                raise ValueError('The inference queue is full. Wait for an existing job to finish and retry.')
            if self._job_path(job_id).exists():
                raise ValueError('This job identifier already exists; create a new job.')
            self._save(job)
            try:
                future = self._pool.submit(self._run, job, files)
            except RuntimeError as exc:
                job.update(status='failed', error='The service could not queue this job. Retry after restarting it.', finished_at=utcnow())
                self._save(job)
                raise ValueError(job['error']) from exc
            self._pending[future] = job
            future.add_done_callback(lambda done: self._job_finished(done, job))
        return {'id': job_id}

    def _run(self, job, files):
        try:
            job['status'] = 'running'
            self._save(job)
            subsystem = job['subsystem']
            predictor = self._predictor or importlib.import_module(f'backend.ps3.{subsystem}').predict
            artifacts = self.artifacts_dir / subsystem
            if self._predictor is None:
                if (self.model(subsystem) or {}).get('trained_at') != job['model_trained_at']:
                    raise ValueError('The selected model changed while this job was queued. Run the files again with the new model.')
                # Retain the exact trusted model used by a batch even if another run retrains later.
                snapshot = self.jobs_dir / job['id'] / 'model_snapshot'
                snapshot.mkdir(exist_ok=True)
                for name in ('model.joblib', 'metadata.json'):
                    shutil.copyfile(artifacts / name, snapshot / name)
                model_hash = hashlib.sha256((snapshot / 'model.joblib').read_bytes()).hexdigest()
                snapshot_metadata = json.loads((snapshot / 'metadata.json').read_text(encoding='utf-8'))
                if (model_hash != job.get('model_sha256') or
                        model_hash != snapshot_metadata.get('model_sha256') or
                        snapshot_metadata.get('trained_at') != job['model_trained_at']):
                    raise ValueError('Model training overlapped this request. Retry after training completes.')
                artifacts = snapshot
                job['model_sha256'] = model_hash
            reports = []
            for path in files:
                job['progress']['filename'] = path.name
                self._save(job)
                report = clean_json(predictor(path, artifacts))
                report['input_sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
                report['subsystem'] = subsystem
                report['file_id'] = path.name
                report.setdefault('model_name', job.get('model_name') or 'Trained model')
                report.setdefault('warnings', [])
                report.setdefault('evidence', [])
                report.setdefault('series', [])
                report.setdefault('entities', [])
                validate_predictions(subsystem, report)
                reports.append(report)
                job['progress']['completed'] += 1
                self._save(job)
            job.update(status='completed', reports=reports, finished_at=utcnow())
        except Exception as exc:
            # Never expose a stack trace, credentials or arbitrary exception representation.
            message = str(exc)[:400] if isinstance(exc, ValueError) else 'Inference failed. Check the local backend log and input format.'
            if not isinstance(exc, ValueError):
                import logging
                logging.getLogger('railguard').exception('PS3 inference failed')
            job.update(status='failed', error=message, reports=[], finished_at=utcnow())
        finally:
            self._save(job)

    def example_job(self, subsystem, all_files=False):
        files = self.examples(subsystem)
        if not files:
            raise ValueError('Official example inputs are not installed. Run scripts/fetch_ps3.py first.')
        return self.create(subsystem, files if all_files else files[:1], 'organiser_test')

    def csv(self, job_id, file_id=None):
        job = self.get(job_id)
        if job['status'] != 'completed':
            raise ValueError('Download is available after the entire inference job completes.')
        reports = job['reports']
        name = f"{job['subsystem']}_predictions.csv"
        if file_id is not None:
            # Match the retained identity exactly; never interpret it as a path or
            # silently fall back to exporting the complete run on a stale selection.
            reports = [report for report in reports if report['file_id'] == file_id]
            if not reports:
                raise KeyError('The selected file is not part of this completed job.')
            if len(reports) != 1:
                raise ValueError('The selected file has ambiguous saved predictions. Run the source again.')
            name = f"{job['subsystem']}_current_file_predictions.csv"
        return self._csv_bytes(job['subsystem'], reports), name

    @staticmethod
    def _csv_bytes(subsystem, reports):
        buffer = io.StringIO(newline='')
        writer = csv.DictWriter(buffer, fieldnames=COLUMNS[subsystem], lineterminator='\n')
        writer.writeheader()
        for report in reports:
            validate_predictions(subsystem, report)
            writer.writerows(report['prediction_rows'])
        return buffer.getvalue().encode('utf-8')

    def bundle(self, job_ids=None, *, selections=None):
        """Create an official ZIP from whole runs or exact, explicit file selections.

        Resolve and validate every selection before creating the in-memory archive;
        exporting never changes saved reports, source files, or abandoned jobs.
        """
        if (job_ids is None) == (selections is None):
            raise ValueError('Provide either complete job IDs or explicit file selections, never both.')
        if selections is None:
            if (not isinstance(job_ids, list) or not 1 <= len(job_ids) <= 100 or
                    any(not isinstance(job_id, str) for job_id in job_ids) or len(set(job_ids)) != len(job_ids)):
                raise ValueError('Select distinct completed prediction jobs to export.')
            requested = [(job_id, None) for job_id in job_ids]
        else:
            if not isinstance(selections, list) or not 1 <= len(selections) <= 16:
                raise ValueError('Select files from between one and 16 completed runs.')
            requested, selected_jobs = [], set()
            for selection in selections:
                if not isinstance(selection, dict) or set(selection) != {'job_id', 'file_ids'}:
                    raise ValueError('Each export selection requires a run ID and its source filenames.')
                job_id, file_ids = selection['job_id'], selection['file_ids']
                if not isinstance(job_id, str) or job_id in selected_jobs:
                    raise ValueError('Each selected run must appear only once.')
                if (not isinstance(file_ids, list) or not 1 <= len(file_ids) <= 100 or
                        any(not isinstance(name, str) or not name.strip() or len(name) > 150 for name in file_ids) or
                        len({name.casefold() for name in file_ids}) != len(file_ids)):
                    raise ValueError('Choose between one and 100 distinct, nonempty source filenames per selected run.')
                selected_jobs.add(job_id)
                requested.append((job_id, file_ids))
        groups = {}
        seen = set()
        for job_id, file_ids in requested:
            path = self._job_path(job_id)
            with self._lock:
                if not path.is_file():
                    raise KeyError('PS3 job not found. It may belong to a different local workspace.')
                job = json.loads(path.read_text(encoding='utf-8'))
            if job['status'] != 'completed':
                raise ValueError('Every selected job must be completed before export.')
            subsystem = job['subsystem']
            reports = job['reports']
            if file_ids is not None:
                selected_reports = []
                for file_id in file_ids:
                    matches = [report for report in reports if report['file_id'] == file_id]
                    if not matches:
                        raise KeyError('A selected file is not part of its completed job. Refresh the export selection.')
                    if len([report for report in reports if report['file_id'].casefold() == file_id.casefold()]) != 1:
                        raise ValueError('A selected file has ambiguous saved predictions. Run the source again.')
                    selected_reports.append(matches[0])
                reports = selected_reports
            if not reports:
                raise ValueError('A selected run has no saved prediction files to export.')
            if subsystem == 'door' and (subsystem in groups or len(reports) != 1):
                raise ValueError('A submission can contain only one continuous Door stream.')
            for report in reports:
                identity = (subsystem, report['file_id'].casefold())
                if identity in seen:
                    raise ValueError('A source file appears in more than one selected job. Choose one prediction per file.')
                seen.add(identity)
                validate_predictions(subsystem, report)
            groups.setdefault(subsystem, []).extend(reports)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for subsystem, reports in sorted(groups.items()):
                archive.writestr(f'{subsystem}_predictions.csv', self._csv_bytes(subsystem, reports))
        return buffer.getvalue()
