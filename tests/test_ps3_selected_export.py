"""Explicit export selection is atomic, read-only, and preserves official results."""
import csv
import io
import zipfile

from fastapi.testclient import TestClient
import pytest

from backend.api import create_app
from backend.ps3.service import COLUMNS, PS3Service, atomic_json


@pytest.fixture
def service(tmp_path):
    value = PS3Service(tmp_path / 'data', tmp_path / 'models', tmp_path / 'jobs')
    yield value
    value.close()


def save_run(service, subsystem='rail', number=1, *, status='completed', names=None):
    names = names or (['Door stream.csv'] if subsystem == 'door' else
                      ['Case 1.xlsx', 'Case 2.xlsx'] if subsystem == 'acv' else ['Case 1.csv', 'Case 2.csv'])
    reports = []
    for index, name in enumerate(names):
        if subsystem == 'door':
            rows = [
                {'start_time': '2023-07-05T00:00:00', 'end_time': '2023-07-05T00:00:01', 'prediction': 'Normal'},
                {'start_time': '2023-07-05T00:00:02', 'end_time': '2023-07-05T00:00:03', 'prediction': 'Abnormal resistance'},
                {'start_time': '2023-07-05T00:00:04', 'end_time': '2023-07-05T00:00:05', 'prediction': 'Normal'},
            ]
        elif subsystem == 'acv':
            rows = [{'file_id': name, 'ranked_cars': '01|02|03|04|05|06|07|08' if index == 0 else '08|07|06|05|04|03|02|01'}]
        else:
            prediction = ['Normal', 'Side II'][index % 2] if subsystem == 'rail' else [1.25e-9, 0.0][index % 2]
            rows = [{'file_id': name, 'prediction': prediction}]
        reports.append({'file_id': name, 'prediction_rows': rows})
    job = {'id': f'{number:032x}', 'subsystem': subsystem, 'status': status,
           'created_at': '2026-09-18T01:00:00+00:00', 'source': 'uploaded',
           'owner_session': 'abandoned-fixture-owner', 'reports': reports,
           'progress': {'completed': len(reports), 'total': len(reports)}}
    directory = service.jobs_dir / job['id']
    atomic_json(directory / 'job.json', job)
    (directory / 'inputs').mkdir()
    for name in names:
        (directory / 'inputs' / name).write_bytes(b'Original recording fixture; must stay unchanged.')
    return job


def selection(job, *file_ids):
    return {'job_id': job['id'], 'file_ids': list(file_ids) or [job['reports'][-1]['file_id']]}


def snapshot(service):
    return {path.relative_to(service.jobs_dir): path.read_bytes()
            for path in service.jobs_dir.rglob('*') if path.is_file() and '.owners' not in path.parts}


def decode_bundle(raw):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        return {name: (archive.read(name).decode('utf-8').splitlines()[0],
                       list(csv.DictReader(io.StringIO(archive.read(name).decode('utf-8')))))
                for name in archive.namelist()}


@pytest.mark.parametrize('subsystem', ['door', 'acv', 'rail', 'shm'])
def test_selected_file_retains_schema_and_every_saved_prediction(service, subsystem):
    job = save_run(service, subsystem)
    before = snapshot(service)
    result = decode_bundle(service.bundle(selections=[selection(job)]))
    name = f'{subsystem}_predictions.csv'
    assert set(result) == {name}
    header, rows = result[name]
    assert header == ','.join(COLUMNS[subsystem])
    expected = [{key: str(value) for key, value in row.items()} for row in job['reports'][-1]['prediction_rows']]
    assert rows == expected
    if subsystem == 'shm':
        assert rows[0]['prediction'] == '0.0'
    if subsystem == 'door':
        assert len(rows) == 3
    assert snapshot(service) == before


def test_combined_selected_export_contains_only_chosen_files_in_all_four_schemas(service):
    jobs = [save_run(service, subsystem, number) for number, subsystem in enumerate(['door', 'acv', 'rail', 'shm'], 1)]
    before = snapshot(service)
    result = decode_bundle(service.bundle(selections=[selection(job) for job in jobs]))
    assert list(result) == ['acv_predictions.csv', 'door_predictions.csv', 'rail_predictions.csv', 'shm_predictions.csv']
    for job in jobs:
        header, rows = result[f"{job['subsystem']}_predictions.csv"]
        assert header == ','.join(COLUMNS[job['subsystem']])
        assert rows == [{key: str(value) for key, value in row.items()} for row in job['reports'][-1]['prediction_rows']]
    assert snapshot(service) == before


def test_nonoverlapping_files_from_different_runs_can_be_selected(service):
    first, second = save_run(service, number=1), save_run(service, number=2)
    result = decode_bundle(service.bundle(selections=[selection(first, 'Case 1.csv'), selection(second, 'Case 2.csv')]))
    assert result['rail_predictions.csv'][1] == [
        {'file_id': 'Case 1.csv', 'prediction': 'Normal'}, {'file_id': 'Case 2.csv', 'prediction': 'Side II'}]


@pytest.mark.parametrize('name', ['missing.csv', 'case 2.csv', '../Case 2.csv', 'Case 2.csv '])
def test_unknown_or_changed_name_never_falls_back_to_all_files(service, name):
    job = save_run(service)
    before = snapshot(service)
    with pytest.raises(KeyError, match='not part of its completed job'):
        service.bundle(selections=[selection(job, 'Case 1.csv', name)])
    assert snapshot(service) == before


@pytest.mark.parametrize('status', ['queued', 'running', 'failed'])
def test_incomplete_run_is_rejected_without_recovering_or_mutating_it(service, status):
    first = save_run(service, number=1)
    unfinished = save_run(service, number=2, status=status)
    before = snapshot(service)
    with pytest.raises(ValueError, match='Every selected job must be completed'):
        service.bundle(selections=[selection(first, 'Case 1.csv'), selection(unfinished)])
    assert snapshot(service) == before


@pytest.mark.parametrize('duplicate_name', ['Case 2.csv', 'case 2.csv'])
def test_ambiguous_retained_filename_is_rejected(service, duplicate_name):
    job = save_run(service)
    job['reports'].append({**job['reports'][-1], 'file_id': duplicate_name})
    atomic_json(service.jobs_dir / job['id'] / 'job.json', job)
    before = snapshot(service)
    with pytest.raises(ValueError, match='ambiguous saved predictions'):
        service.bundle(selections=[selection(job, 'Case 2.csv')])
    assert snapshot(service) == before


def test_duplicate_filenames_across_runs_remain_disallowed(service):
    first = save_run(service, number=1)
    second = save_run(service, number=2, names=['case 2.csv'])
    with pytest.raises(ValueError, match='more than one selected job'):
        service.bundle(selections=[selection(first), selection(second)])


def test_multiple_door_streams_are_rejected_even_with_distinct_filenames(service):
    first = save_run(service, 'door', 1)
    second = save_run(service, 'door', 2, names=['Another stream.csv'])
    with pytest.raises(ValueError, match='only one continuous Door stream'):
        service.bundle(selections=[selection(first), selection(second)])


def test_invalid_saved_predictions_prevent_any_export(service):
    first = save_run(service, 'rail', 1)
    second = save_run(service, 'shm', 2)
    second['reports'][-1]['prediction_rows'][0]['prediction'] = -1
    atomic_json(service.jobs_dir / second['id'] / 'job.json', second)
    before = snapshot(service)
    with pytest.raises(ValueError, match='finite nonnegative'):
        service.bundle(selections=[selection(first), selection(second)])
    assert snapshot(service) == before


@pytest.mark.parametrize('body', [
    {}, {'job_ids': None}, {'selections': None}, {'selections': []},
    {'job_ids': ['1' * 32], 'selections': [{'job_id': '1' * 32, 'file_ids': ['a.csv']}]},
    {'job_ids': ['1' * 32], 'selections': None},
    {'job_ids': None, 'selections': [{'job_id': '1' * 32, 'file_ids': ['a.csv']}]},
    {'selections': [{'job_id': '1' * 32, 'file_ids': []}]},
    {'selections': [{'job_id': '1' * 32, 'file_ids': ['']}]},
    {'selections': [{'job_id': '1' * 32, 'file_ids': ['   ']}]},
    {'selections': [{'job_id': '1' * 32, 'file_ids': ['a.csv', 'a.csv']}]},
    {'selections': [{'job_id': '1' * 32, 'file_ids': ['a.csv', 'A.csv']}]},
    {'selections': [{'job_id': '../unsafe', 'file_ids': ['a.csv']}]},
    {'selections': [{'job_id': '1' * 32, 'file_ids': ['x' * 151]}]},
    {'selections': [{'job_id': '1' * 32, 'file_ids': [1]}]},
    {'selections': [{'job_id': '1' * 32, 'file_ids': ['a.csv'], 'all_files': True}]},
    {'selections': [{'job_id': '1' * 32, 'file_ids': ['a.csv']}] * 2},
    {'selections': [{'job_id': f'{n:032x}', 'file_ids': ['a.csv']} for n in range(17)]},
    {'selections': [{'job_id': '1' * 32, 'file_ids': [f'{n}.csv' for n in range(101)]}]},
])
def test_api_rejects_invalid_export_selections(service, tmp_path, body):
    app = create_app(orders_path=tmp_path / 'orders.sqlite3', ps3_service=service)
    with TestClient(app) as client:
        response = client.post('/api/ps3/export', json=body)
        assert response.status_code == 422
        assert 'application/zip' not in response.headers.get('content-type', '')


def test_api_supports_explicit_selection_and_legacy_whole_run_exports(service, tmp_path):
    job = save_run(service)
    before = snapshot(service)
    app = create_app(orders_path=tmp_path / 'orders.sqlite3', ps3_service=service)
    with TestClient(app) as client:
        selected = client.post('/api/ps3/export', json={'selections': [selection(job)]})
        assert selected.status_code == 200
        assert selected.headers['content-type'] == 'application/zip'
        assert selected.headers['content-disposition'] == 'attachment; filename="predictions.zip"'
        assert decode_bundle(selected.content)['rail_predictions.csv'][1] == [{'file_id': 'Case 2.csv', 'prediction': 'Side II'}]
        complete = client.post('/api/ps3/export', json={'job_ids': [job['id']]})
        assert complete.status_code == 200
        assert len(decode_bundle(complete.content)['rail_predictions.csv'][1]) == 2
        missing = client.post('/api/ps3/export', json={'selections': [selection(job, 'Case 1.csv', 'unknown.csv')]})
        assert missing.status_code == 404
        assert snapshot(service) == before


@pytest.mark.parametrize('selections', [[], [{}], [{'job_id': '1' * 32, 'file_ids': []}],
    [{'job_id': '1' * 32, 'file_ids': ['a.csv', 'a.csv']}],
    [{'job_id': '1' * 32, 'file_ids': ['a.csv']}] * 2])
def test_direct_service_call_validates_selection_before_reading_jobs(service, selections):
    with pytest.raises(ValueError):
        service.bundle(selections=selections)


def test_direct_service_requires_exactly_one_mode(service):
    with pytest.raises(ValueError, match='either complete job IDs'):
        service.bundle()
    with pytest.raises(ValueError, match='either complete job IDs'):
        service.bundle(['1' * 32], selections=[{'job_id': '1' * 32, 'file_ids': ['a.csv']}])
