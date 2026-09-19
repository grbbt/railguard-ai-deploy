"""Current-file exports preserve exact saved predictions and official schemas."""
import csv
import io

from fastapi.testclient import TestClient
import pytest

from backend.api import create_app
from backend.ps3.service import COLUMNS, PS3Service, atomic_json


@pytest.fixture
def service(tmp_path):
    value = PS3Service(tmp_path / 'data', tmp_path / 'models', tmp_path / 'jobs')
    yield value
    value.close()


def saved(service, subsystem='rail', status='completed'):
    reports = []
    for index in range(1, 2 if subsystem == 'door' else 3):
        name = f'Test ({index}).xlsx' if subsystem == 'acv' else f'Test ({index}).csv'
        if subsystem == 'door':
            rows = [
                {'start_time': '2023-07-05T00:00:00', 'end_time': '2023-07-05T00:00:01', 'prediction': 'Normal'},
                {'start_time': '2023-07-05T00:00:02', 'end_time': '2023-07-05T00:00:03', 'prediction': 'Abnormal resistance'},
            ]
        elif subsystem == 'acv':
            ranking = '01|02|03|04|05|06|07|08' if index == 1 else '08|07|06|05|04|03|02|01'
            rows = [{'file_id': name, 'ranked_cars': ranking}]
        else:
            prediction = ('Normal' if index == 1 else 'Side II') if subsystem == 'rail' else index * 1.25e-9
            rows = [{'file_id': name, 'prediction': prediction}]
        reports.append({'file_id': name, 'prediction_rows': rows})
    job = {'id': 'a' * 32, 'subsystem': subsystem, 'status': status,
           'created_at': '2026-09-18T01:00:00+00:00', 'source': 'uploaded',
           'owner_session': service._owner_session,
           'reports': reports, 'progress': {'completed': len(reports), 'total': len(reports)}}
    atomic_json(service.jobs_dir / job['id'] / 'job.json', job)
    return job


def decoded(raw):
    return list(csv.DictReader(io.StringIO(raw.decode('utf-8'))))


@pytest.mark.parametrize('subsystem', ['door', 'acv', 'rail', 'shm'])
def test_file_export_preserves_schema_saved_values_and_other_reports(service, subsystem):
    job = saved(service, subsystem)
    selected = job['reports'][-1]
    complete_before, whole_name = service.csv(job['id'])
    current, current_name = service.csv(job['id'], file_id=selected['file_id'])
    expected = [{key: str(value) for key, value in row.items()} for row in selected['prediction_rows']]
    assert decoded(current) == expected
    assert current.decode().splitlines()[0] == ','.join(COLUMNS[subsystem])
    assert current_name == f'{subsystem}_current_file_predictions.csv'
    assert whole_name == f'{subsystem}_predictions.csv'
    assert service.csv(job['id'])[0] == complete_before
    assert len(decoded(complete_before)) == sum(len(report['prediction_rows']) for report in job['reports'])
    assert service.get(job['id'])['reports'] == job['reports']


@pytest.mark.parametrize('file_id', ['missing.csv', 'test (2).csv', '../Test (2).csv', 'Test (2).csv '])
def test_selection_is_exact_and_never_defaults_to_all_files(service, file_id):
    job = saved(service)
    with pytest.raises(KeyError, match='not part of this completed job'):
        service.csv(job['id'], file_id=file_id)


@pytest.mark.parametrize('status', ['queued', 'running', 'failed'])
def test_current_file_does_not_bypass_entire_job_completion(service, status):
    job = saved(service, status=status)
    with pytest.raises(ValueError, match='entire inference job completes'):
        service.csv(job['id'], file_id=job['reports'][0]['file_id'])


def test_ambiguous_saved_selection_is_rejected(service):
    job = saved(service)
    job['reports'].append(job['reports'][0])
    atomic_json(service.jobs_dir / job['id'] / 'job.json', job)
    with pytest.raises(ValueError, match='ambiguous saved predictions'):
        service.csv(job['id'], file_id=job['reports'][0]['file_id'])


def test_csv_http_scope_and_validation_contract(service, tmp_path):
    job = saved(service)
    app = create_app(orders_path=tmp_path / 'orders.sqlite3', ps3_service=service)
    with TestClient(app) as client:
        endpoint = f"/api/ps3/jobs/{job['id']}/csv"
        all_files = client.get(endpoint)
        assert all_files.status_code == 200
        assert len(decoded(all_files.content)) == 2
        current = client.get(endpoint, params={'file_id': 'Test (2).csv'})
        assert current.status_code == 200
        assert current.headers['content-type'].startswith('text/csv')
        assert current.headers['content-disposition'] == 'attachment; filename="rail_current_file_predictions.csv"'
        assert decoded(current.content) == [{'file_id': 'Test (2).csv', 'prediction': 'Side II'}]
        unknown = client.get(endpoint, params={'file_id': 'missing.csv'})
        assert unknown.status_code == 404
        assert unknown.json()['detail'] == 'The selected file is not part of this completed job.'
        for invalid in ['', 'x' * 151]:
            response = client.get(endpoint, params={'file_id': invalid})
            assert response.status_code == 422
            assert 'file_id' in response.json()['detail']
