"""Persisted-job discovery stays bounded, recoverable and free of report data."""
import json
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from backend.ps3.api import router
from backend.ps3.service import PS3Service, atomic_json


@pytest.fixture
def service(tmp_path):
    value = PS3Service(tmp_path / 'data', tmp_path / 'models', tmp_path / 'jobs',
                       predictor=lambda path, _: {'prediction_rows': [{'file_id': path.name, 'prediction': 'Normal'}]})
    yield value
    value.close()


def saved(service, number, subsystem='rail', status='completed', **changes):
    job_id = f'{number:032x}'
    name = 'Test.xlsx' if subsystem == 'acv' else 'Test.csv'
    job = {'id': job_id, 'subsystem': subsystem, 'status': status,
           'created_at': f'2026-09-18T01:{number % 60:02d}:00+00:00',
           'source': 'uploaded', 'model_name': 'Frozen test fixture',
           'owner_session': service._owner_session,
           'progress': {'completed': 1 if status == 'completed' else 0, 'total': 1, 'filename': name},
           'reports': [{'file_id': name, 'prediction_rows': [{'private': 'RAW_PREDICTION'}],
                        'series': [{'values': ['RAW_TELEMETRY']}]}] if status == 'completed' else []}
    if status in {'completed', 'failed'}:
        job['finished_at'] = '2026-09-18T03:00:00+00:00'
    job.update(changes)
    atomic_json(service.jobs_dir / job_id / 'job.json', job)
    return job


def test_list_orders_all_statuses_limits_and_filters_without_reports(service):
    first = saved(service, 1, 'door', 'queued')
    saved(service, 2, 'acv', 'running', source='organiser_test')
    saved(service, 3, 'rail', 'failed', error='C:\\private\\input.csv SECRET_ERROR')
    newest = saved(service, 4, 'shm')
    value = service.list_jobs(limit=2)
    assert value['total'] == 4 and value['limit'] == 2
    assert [job['id'] for job in value['jobs']] == [newest['id'], f'{3:032x}']
    all_jobs = service.list_jobs()['jobs']
    assert {job['status'] for job in all_jobs} == {'queued', 'running', 'completed', 'failed'}
    assert service.list_jobs(subsystem='door')['jobs'][0]['id'] == first['id']
    acv = service.list_jobs(subsystem='acv')
    assert acv['total'] == 1 and acv['jobs'][0]['source'] == 'organiser_test'
    for job in all_jobs:
        assert set(job) == {'id', 'subsystem', 'status', 'created_at', 'finished_at', 'source',
                            'progress', 'error', 'first_file', 'file_count', 'model_name'}
        assert job['first_file'] in {'Test.csv', 'Test.xlsx'} and job['file_count'] == 1
    serialized = json.dumps(all_jobs)
    for hidden in ('RAW_TELEMETRY', 'RAW_PREDICTION', 'SECRET_ERROR', 'private', 'owner_session', 'reports'):
        assert hidden not in serialized
    assert all_jobs[1]['error'] == 'Analysis failed. Open the saved job for details.'


def test_malformed_folders_and_individual_corrupt_records_do_not_hide_history(service):
    valid = saved(service, 1)
    for name in ['not-a-job', 'A' * 32, 'a' * 31, 'a' * 33]:
        atomic_json(service.jobs_dir / name / 'job.json', {**valid, 'id': name})
    nested = service.jobs_dir / 'archive' / ('b' * 32) / 'job.json'
    atomic_json(nested, {**valid, 'id': 'b' * 32})
    for number, malformed in [(2, []), (3, {'id': f'{3:032x}'}),
                              (4, {**valid, 'id': f'{4:032x}', 'created_at': 'invalid'}),
                              (5, {**valid, 'id': f'{5:032x}', 'progress': {'completed': 3, 'total': 1}}),
                              (6, {**valid, 'id': 'different-record'})]:
        atomic_json(service.jobs_dir / f'{number:032x}' / 'job.json', malformed)
    bad_json = service.jobs_dir / ('c' * 32) / 'job.json'
    bad_json.parent.mkdir()
    bad_json.write_text('{unfinished', encoding='utf-8')
    assert service.list_jobs()['total'] == 1
    assert service.list_jobs()['jobs'][0]['id'] == valid['id']


def test_listing_recovers_ownerless_work_and_preserves_live_owner(service):
    abandoned = saved(service, 1, status='running', owner_session='d' * 32)
    live = saved(service, 2, status='queued')
    jobs = {job['id']: job for job in service.list_jobs()['jobs']}
    assert jobs[abandoned['id']]['status'] == 'failed'
    assert jobs[abandoned['id']]['finished_at'] is not None
    assert service.get(abandoned['id'])['status'] == 'failed'
    assert jobs[live['id']]['status'] == 'queued'


def test_terminal_summary_cache_invalidates_and_never_exposes_mutable_cached_data(service, monkeypatch):
    completed = saved(service, 1)
    live = saved(service, 2, status='running')
    real_get, reads = service.get, []
    def counted(job_id):
        reads.append(job_id)
        return real_get(job_id)
    monkeypatch.setattr(service, 'get', counted)
    first = service.list_jobs()
    first['jobs'][1]['progress']['completed'] = 99
    second = service.list_jobs()
    assert reads.count(completed['id']) == 1
    assert reads.count(live['id']) == 2  # Active records always check fresh progress/ownership.
    assert second['jobs'][1]['progress']['completed'] == 1
    saved(service, 1, status='failed', error='Changed after publication')
    assert service.list_jobs()['jobs'][1]['status'] == 'failed'
    assert reads.count(completed['id']) == 2


def test_summary_strips_paths_and_does_not_mislabel_current_batch_file_as_first(service):
    saved(service, 1, status='running', model_name='C:\\private\\model.joblib',
          first_file='C:\\private\\first.csv', progress={'completed': 1, 'total': 2, 'filename': 'Second.csv'})
    saved(service, 2, progress={'completed': 1, 'total': 1, 'filename': '/private/source.csv'},
          reports=[{'file_id': '/private/source.csv'}])
    values = service.list_jobs()['jobs']
    assert values[1]['first_file'] is None and 'model_name' not in values[1]
    assert values[1]['progress']['filename'] == 'Second.csv'
    assert values[0]['first_file'] is None and values[0]['progress']['filename'] is None
    assert 'private' not in json.dumps(values)


def test_new_browser_discovers_completed_batch_with_original_first_filename(service, tmp_path):
    sources = [tmp_path / 'First.csv', tmp_path / 'Second.csv']
    for path in sources:
        path.write_text('fixture sensor input', encoding='utf-8')
    job_id = service.create('rail', sources)['id']
    deadline = time.monotonic() + 5
    while service.get(job_id)['status'] not in {'completed', 'failed'} and time.monotonic() < deadline:
        time.sleep(.01)
    assert service.get(job_id)['status'] == 'completed'
    other = PS3Service(service.data_dir, service.artifacts_dir, service.jobs_dir)
    try:
        summary = other.list_jobs()['jobs'][0]
        assert summary['id'] == job_id and summary['first_file'] == 'First.csv'
        assert summary['file_count'] == 2 and summary['progress']['filename'] == 'Second.csv'
        assert service.get(job_id)['first_file'] == 'First.csv'
    finally:
        other.close()


def test_http_collection_defaults_empty_state_and_query_validation(service):
    app = FastAPI()
    app.include_router(router(service))
    with TestClient(app) as client:
        assert client.get('/api/ps3/jobs').json() == {'jobs': [], 'total': 0, 'limit': 40,
                                                    'latest_completed': [], 'active_jobs': []}
        saved(service, 1, 'acv')
        saved(service, 2, 'rail')
        value = client.get('/api/ps3/jobs?limit=1&subsystem=acv')
        assert value.status_code == 200
        assert value.json()['total'] == 1 and value.json()['jobs'][0]['subsystem'] == 'acv'
        for query in ['limit=0', 'limit=101', 'limit=1.5', 'subsystem=unknown', 'subsystem=ACV']:
            assert client.get('/api/ps3/jobs?' + query).status_code == 422
        assert client.get('/api/ps3/jobs?limit=100').json()['limit'] == 100


def test_newest_sort_compares_instants_across_timezones(service):
    saved(service, 1, created_at='2026-09-18T10:00:00+08:00')
    latest = saved(service, 2, created_at='2026-09-18T03:00:00+00:00')
    assert service.list_jobs(limit=1)['jobs'][0]['id'] == latest['id']


def test_corrupt_record_cannot_prevent_fresh_service_startup(service):
    valid = saved(service, 1)
    atomic_json(service.jobs_dir / f'{2:032x}' / 'job.json', {'status': []})
    other = PS3Service(service.data_dir, service.artifacts_dir, service.jobs_dir)
    try:
        assert other.list_jobs()['total'] == 1
        assert other.list_jobs()['jobs'][0]['id'] == valid['id']
    finally:
        other.close()


def test_cache_is_bounded_and_summary_limits_are_validated(service, monkeypatch):
    monkeypatch.setattr('backend.ps3.service.MAX_JOB_SUMMARIES', 2)
    for number in range(1, 6):
        saved(service, number)
    assert service.list_jobs(limit=1)['total'] == 5
    assert len(service._job_summary_cache) == 2
    for invalid in (0, 101, True, 1.5):
        with pytest.raises(ValueError, match='limit'):
            service.list_jobs(limit=invalid)
    with pytest.raises(ValueError, match='Choose'):
        service.list_jobs(subsystem='unknown')


def test_latest_completed_preserves_other_subsystems_beyond_recent_history_limit(service):
    for number, subsystem in enumerate(('door', 'acv', 'shm'), 1):
        saved(service, number, subsystem, created_at='2026-09-17T00:00:00+00:00')
    for number in range(10, 55):
        saved(service, number, 'rail')
    # Neither a newer failed run nor a damaged "completed" record replaces valid work.
    saved(service, 55, 'door', 'failed')
    saved(service, 56, 'acv', reports=[])
    value = service.list_jobs()
    assert value['total'] == 49 and len(value['jobs']) == 40
    assert {job['subsystem'] for job in value['jobs']} == {'door', 'rail'}
    assert [(job['subsystem'], job['id']) for job in value['latest_completed']] == [
        ('door', f'{1:032x}'), ('acv', f'{2:032x}'), ('rail', f'{54:032x}'), ('shm', f'{3:032x}')]
    assert all(job['status'] == 'completed' and 'reports' not in job for job in value['latest_completed'])
    assert not value['active_jobs']
    # Repeated cached listing produces exactly the same selections.
    assert service.list_jobs() == value


def test_active_jobs_include_live_older_work_but_not_recovered_abandoned_jobs(service):
    queued = saved(service, 1, 'door', 'queued')
    running = saved(service, 2, 'acv', 'running')
    abandoned = saved(service, 3, 'rail', 'running', owner_session='e' * 32)
    newest = saved(service, 4, 'shm')
    value = service.list_jobs(limit=1)
    assert [job['id'] for job in value['jobs']] == [newest['id']]
    assert [job['id'] for job in value['active_jobs']] == [running['id'], queued['id']]
    assert service.get(abandoned['id'])['status'] == 'failed'
    assert value['total'] == 4
    assert all('reports' not in job for job in value['active_jobs'])


def test_subsystem_filter_applies_to_all_catalog_arrays_and_cached_summaries_are_copied(service):
    completed = saved(service, 1, 'acv')
    active = saved(service, 2, 'acv', 'running')
    saved(service, 3, 'rail')
    saved(service, 4, 'rail', 'running')
    value = service.list_jobs(limit=1, subsystem='acv')
    assert value['total'] == 2 and value['jobs'][0]['id'] == active['id']
    assert [job['id'] for job in value['latest_completed']] == [completed['id']]
    assert [job['id'] for job in value['active_jobs']] == [active['id']]
    value['latest_completed'][0]['progress']['completed'] = 99
    value['active_jobs'][0]['progress']['completed'] = 99
    assert value['jobs'][0]['progress']['completed'] == 0
    repeat = service.list_jobs(subsystem='acv')
    assert repeat['latest_completed'][0]['progress']['completed'] == 1
    assert repeat['active_jobs'][0]['progress']['completed'] == 0
