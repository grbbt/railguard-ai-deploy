"""Job ownership, shutdown and artifact readiness regressions."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from threading import Barrier, Event
import time
import types

import pytest

from backend.ps3.service import PS3Service, atomic_json


def _report(path, _):
    return {'file_id': path.name, 'summary': 'Test fixture',
            'prediction_rows': [{'file_id': path.name, 'prediction': 'Normal'}]}


def _service(tmp_path, predictor=_report):
    return PS3Service(tmp_path / 'data', tmp_path / 'models', tmp_path / 'jobs', predictor=predictor)


def _input(tmp_path):
    path = tmp_path / 'Test1.csv'
    path.write_text('fixture', encoding='utf-8')
    return path


def _wait(service, job_id):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        job = service.get(job_id)
        if job['status'] in {'completed', 'failed'}:
            return job
        time.sleep(.01)
    raise AssertionError('Job did not finish')


def test_second_instance_preserves_active_and_queued_jobs(tmp_path):
    ready, release = Barrier(3), Event()
    def blocked(path, artifact):
        ready.wait(timeout=5)
        assert release.wait(timeout=5)
        return _report(path, artifact)
    owner = _service(tmp_path, blocked)
    observer = None
    try:
        path = _input(tmp_path)
        active = [owner.create('rail', [path])['id'] for _ in range(2)]
        ready.wait(timeout=5)
        queued = owner.create('rail', [path])['id']
        observer = _service(tmp_path)
        assert [observer.get(job)['status'] for job in active] == ['running', 'running']
        assert observer.get(queued)['status'] == 'queued'
        assert observer._owner_active(owner._owner_session)
        owner.close()
        assert observer.get(queued)['status'] == 'failed'
        assert 'before this queued job began' in observer.get(queued)['error']
        assert observer._owner_active(owner._owner_session), 'Running workers retain the owner lease after close()'
        assert [observer.get(job)['status'] for job in active] == ['running', 'running']
        release.set()
        assert [_wait(observer, job)['status'] for job in active] == ['completed', 'completed']
    finally:
        release.set()
        owner.close()
        if observer:
            observer.close()


def test_cross_process_owner_death_is_recovered_on_read(tmp_path):
    # The child exits itself after input, without graceful service.close(). The
    # OS must release its lease; no process signals, PID probing or kills needed.
    program = """
from pathlib import Path
import os,sys,uuid
from backend.ps3.service import PS3Service,atomic_json
root=Path(sys.argv[1])
service=PS3Service(root/'data',root/'models',root/'jobs')
job=uuid.uuid4().hex
atomic_json(service._job_path(job),{'id':job,'status':'running','reports':[], 'owner_session':service._owner_session})
print(job,flush=True)
sys.stdin.readline()
os._exit(0)
"""
    child = subprocess.Popen([sys.executable, '-c', program, str(tmp_path)], cwd=Path(__file__).resolve().parents[1],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    observer = None
    try:
        job_id = child.stdout.readline().strip()
        assert len(job_id) == 32
        observer = _service(tmp_path)
        assert observer.get(job_id)['status'] == 'running'
        _, errors = child.communicate(input='exit\n', timeout=10)
        assert child.returncode == 0, errors
        recovered = observer.get(job_id)
        assert recovered['status'] == 'failed'
        assert 'owning this job stopped' in recovered['error']
        assert recovered['reports'] == [] and recovered['finished_at']
    finally:
        if child.poll() is None:
            child.communicate(input='exit\n', timeout=10)
        if observer:
            observer.close()


def test_legacy_interrupted_jobs_recover_but_completed_results_survive(tmp_path):
    interrupted, complete = 'a' * 32, 'b' * 32
    atomic_json(tmp_path / 'jobs' / interrupted / 'job.json', {'id': interrupted, 'status': 'queued'})
    atomic_json(tmp_path / 'jobs' / complete / 'job.json', {'id': complete, 'status': 'completed', 'reports': [{'kept': True}]})
    service = _service(tmp_path)
    try:
        assert service.get(interrupted)['status'] == 'failed'
        assert service.get(complete)['reports'] == [{'kept': True}]
    finally:
        service.close()


def test_recovery_cannot_overwrite_completion_during_owner_probe(tmp_path, monkeypatch):
    service = _service(tmp_path)
    job_id = 'd' * 32
    path = service._job_path(job_id)
    atomic_json(path, {'id': job_id, 'status': 'running', 'owner_session': 'e' * 32, 'reports': []})
    completed = {'id': job_id, 'status': 'completed', 'owner_session': 'e' * 32,
                 'reports': [{'completed_before_lease_release': True}], 'finished_at': 'saved completion'}
    def just_finished(_):
        atomic_json(path, completed)
        return False
    monkeypatch.setattr(service, '_owner_active', just_finished)
    try:
        assert service.get(job_id) == completed
        assert json.loads(path.read_text(encoding='utf-8')) == completed
    finally:
        service.close()


def test_closed_service_rejects_new_work_without_stranded_jobs(tmp_path):
    service = _service(tmp_path)
    service.close()
    service.close()
    with pytest.raises(ValueError, match='shutting down'):
        service.create('rail', [_input(tmp_path)])
    assert not list(service.jobs_dir.glob('*/job.json'))


def test_submit_failure_is_recorded_and_existing_job_id_cannot_be_overwritten(tmp_path, monkeypatch):
    service = _service(tmp_path)
    try:
        path = _input(tmp_path)
        job = service.create('rail', [path])['id']
        saved = _wait(service, job)
        with pytest.raises(ValueError, match='already exists'):
            service.create('rail', [path], job_id=job)
        assert service.get(job) == saved
        def reject(*args, **kwargs):
            raise RuntimeError('Executor unavailable')
        monkeypatch.setattr(service._pool, 'submit', reject)
        with pytest.raises(ValueError, match='could not queue'):
            service.create('rail', [path], job_id='c' * 32)
        assert service.get('c' * 32)['status'] == 'failed'
        assert not service._pending
    finally:
        service.close()


def test_queue_has_a_limit_and_rejected_jobs_are_not_persisted(tmp_path, monkeypatch):
    ready, release = Barrier(3), Event()
    def blocked(path, artifact):
        ready.wait(timeout=5)
        assert release.wait(timeout=5)
        return _report(path, artifact)
    monkeypatch.setattr('backend.ps3.service.MAX_PENDING_JOBS', 2)
    service = _service(tmp_path, blocked)
    try:
        path = _input(tmp_path)
        jobs = [service.create('rail', [path])['id'] for _ in range(2)]
        ready.wait(timeout=5)
        with pytest.raises(ValueError, match='queue is full'):
            service.create('rail', [path])
        assert len(list(service.jobs_dir.glob('*/job.json'))) == 2
        release.set()
        assert all(_wait(service, job)['status'] == 'completed' for job in jobs)
    finally:
        release.set()
        service.close()


def _artifact(tmp_path):
    directory = tmp_path / 'models' / 'rail'
    directory.mkdir(parents=True)
    (directory / 'model.joblib').write_bytes(b'fixed model fixture')
    metadata = {'subsystem': 'rail', 'model_name': 'Fixture', 'trained_at': datetime.now(timezone.utc).isoformat(),
                'training_files': 1, 'training_rows': 10,
                'model_sha256': hashlib.sha256((directory / 'model.joblib').read_bytes()).hexdigest(),
                'validation': {'metric': 'Macro F1', 'score': .5, 'method': 'Test only', 'candidates': [], 'limitations': []}}
    atomic_json(directory / 'metadata.json', metadata)
    return directory, metadata


def test_model_integrity_is_cached_and_rechecked_after_file_changes(tmp_path, monkeypatch):
    from backend.ps3 import service as module
    directory, metadata = _artifact(tmp_path)
    original, hashes = module._file_sha256, []
    def count(path):
        hashes.append(path)
        return original(path)
    monkeypatch.setattr(module, '_file_sha256', count)
    service = _service(tmp_path, predictor=None)
    try:
        assert service.model('rail') == metadata
        assert service.model('rail') == metadata
        assert len(hashes) == 1
        (directory / 'model.joblib').write_bytes(b'corrupted model fixture')
        assert service.model('rail') is None
        assert service.model('rail') is None
        assert len(hashes) == 2
        assert not next(row for row in service.status()['subsystems'] if row['id'] == 'rail')['available']
        (directory / 'model.joblib').write_bytes(b'fixed model fixture')
        assert service.model('rail') == metadata
        assert len(hashes) == 3
    finally:
        service.close()


def test_valid_model_publication_cannot_change_an_already_queued_jobs_estimator(tmp_path, monkeypatch):
    directory, metadata = _artifact(tmp_path)
    ready, release = Barrier(3), Event()
    def blocked(path, artifact):
        assert (artifact / 'model.joblib').read_bytes() == b'fixed model fixture'
        ready.wait(timeout=5)
        assert release.wait(timeout=5)
        return _report(path, artifact)
    monkeypatch.setattr('backend.ps3.service.importlib.import_module', lambda _: types.SimpleNamespace(predict=blocked))
    service = _service(tmp_path, predictor=None)
    try:
        path = _input(tmp_path)
        active = [service.create('rail', [path])['id'] for _ in range(2)]
        ready.wait(timeout=5)
        queued = service.create('rail', [path])['id']
        (directory / 'model.joblib').write_bytes(b'new valid model fixture')
        metadata['model_sha256'] = hashlib.sha256((directory / 'model.joblib').read_bytes()).hexdigest()
        # Retaining the timestamp exercises the hash guard independently of the
        # earlier trained_at guard; the replacement itself is correctly bound.
        atomic_json(directory / 'metadata.json', metadata)
        assert service.model('rail') == metadata
        release.set()
        assert all(_wait(service, job)['status'] == 'completed' for job in active)
        rejected = _wait(service, queued)
        assert rejected['status'] == 'failed'
        assert 'training overlapped' in rejected['error']
        assert rejected['reports'] == []
    finally:
        release.set()
        service.close()


@pytest.mark.parametrize('remove', ['subsystem', 'model_name', 'trained_at', 'training_files', 'validation', 'model_sha256'])
def test_incomplete_artifacts_are_not_advertised_ready(tmp_path, remove):
    directory, metadata = _artifact(tmp_path)
    metadata.pop(remove)
    atomic_json(directory / 'metadata.json', metadata)
    service = _service(tmp_path, predictor=None)
    try:
        assert service.model('rail') is None
    finally:
        service.close()


@pytest.mark.parametrize('validation', [
    {'metric': 'F1', 'method': 'fixture', 'candidates': [], 'limitations': []},
    {'metric': 'F1', 'method': 'fixture', 'score': .5, 'candidates': [{'name': 'broken', 'score': float('inf')}], 'limitations': []},
])
def test_missing_or_nonfinite_validation_scores_are_not_advertised_ready(tmp_path, validation):
    directory, metadata = _artifact(tmp_path)
    metadata['validation'] = validation
    # Write the malformed external metadata literally; atomic_json deliberately
    # sanitizes nonfinite values and would repair the second fixture.
    (directory / 'metadata.json').write_text(json.dumps(metadata), encoding='utf-8')
    service = _service(tmp_path, predictor=None)
    try:
        assert service.model('rail') is None
    finally:
        service.close()
