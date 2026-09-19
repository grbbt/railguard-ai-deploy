import io
import json
from pathlib import Path
import time
import zipfile

import httpx
import pytest

from backend.ps3.assistant import investigate
from backend.ps3.service import PS3Service, atomic_json, safe_filename, validate_predictions


def report(subsystem='rail', name='Test1.csv'):
    return {'subsystem': subsystem, 'file_id': name, 'model_name': 'Fixture classifier',
            'summary': 'Predicted Side I corrugation.', 'prediction_rows': [{'file_id': name, 'prediction': 'Side I'}],
            'warnings': ['Illustrative test fixture, not measured model performance.'],
            'evidence': [{'id': 'side', 'label': 'Side I RMS', 'value': 2, 'unit': 'm/s²'}], 'series': []}


def wait(service, job_id):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        value = service.get(job_id)
        if value['status'] in {'completed', 'failed'}:
            return value
        time.sleep(.01)
    raise AssertionError('Job did not finish')


@pytest.fixture
def service(tmp_path):
    value = PS3Service(tmp_path / 'data', tmp_path / 'models', tmp_path / 'jobs', predictor=lambda p, _: report(name=p.name))
    yield value
    value.close()


def test_export_preserves_official_ids_and_zip_root(service, tmp_path):
    path = tmp_path / 'Test1.csv'
    path.write_text('input')
    job_id = service.create('rail', [path])['id']
    assert wait(service, job_id)['status'] == 'completed'
    csv, name = service.csv(job_id)
    assert name == 'rail_predictions.csv'
    assert csv.decode() == 'file_id,prediction\nTest1.csv,Side I\n'
    with zipfile.ZipFile(io.BytesIO(service.bundle([job_id]))) as archive:
        assert archive.namelist() == ['rail_predictions.csv']
        assert archive.read(name) == csv
    # Results survive constructing a fresh service, without executing the predictor again.
    other = PS3Service(service.data_dir, service.artifacts_dir, service.jobs_dir)
    assert other.get(job_id)['status'] == 'completed'
    other.close()


def test_job_persistence_recovers_from_transient_windows_file_lock(tmp_path, monkeypatch):
    original = Path.replace
    attempts = []
    def temporarily_locked(self, target):
        attempts.append(self)
        if len(attempts) < 3:
            raise PermissionError('Simulated Windows sync-client file lock')
        return original(self, target)
    monkeypatch.setattr(Path, 'replace', temporarily_locked)
    target = tmp_path / 'job.json'
    atomic_json(target, {'status': 'completed'})
    assert json.loads(target.read_text()) == {'status': 'completed'}
    assert len(attempts) == 3 and not list(tmp_path.glob('*.tmp'))


def test_duplicate_file_exports_and_unsafe_names_rejected(service, tmp_path):
    path = tmp_path / 'Test1.csv'
    path.write_text('input')
    jobs = [service.create('rail', [path])['id'] for _ in range(2)]
    for job in jobs:
        wait(service, job)
    with pytest.raises(ValueError, match='more than one'):
        service.bundle(jobs)
    for name in ['../outside.csv', '..\\outside.csv', 'C:secret.csv', '=formula.csv', 'CON.csv', 'Test1.exe']:
        with pytest.raises(ValueError):
            safe_filename(name, '.csv')
    assert safe_filename('Test (2).csv', '.csv') == 'Test (2).csv'
    with pytest.raises(KeyError):
        service.get('../job')


def test_failed_batch_has_no_partial_export(service, tmp_path):
    def failing(path, _):
        if path.name == 'Test2.csv':
            raise ValueError('Wrong column count.')
        return report(name=path.name)
    service._predictor = failing
    files = [tmp_path / 'Test1.csv', tmp_path / 'Test2.csv']
    for p in files:
        p.write_text('input')
    job = wait(service, service.create('rail', files)['id'])
    assert job['status'] == 'failed'
    assert job['reports'] == []
    assert 'Wrong column count' in job['error']
    with pytest.raises(ValueError):
        service.csv(job['id'])


def test_schema_checks_car_ids_damage_and_door_intervals():
    acv = {**report('acv', 'case.xlsx'), 'prediction_rows': [{'file_id': 'case.xlsx', 'ranked_cars': '01|02|03|04|05|06|07|08'}]}
    validate_predictions('acv', acv)
    acv['prediction_rows'][0]['ranked_cars'] = '1|2|3|4|5|6|7|8'
    with pytest.raises(ValueError):
        validate_predictions('acv', acv)
    shm = {**report('shm'), 'prediction_rows': [{'file_id': 'Test1.csv', 'prediction': float('nan')}]}
    with pytest.raises(ValueError):
        validate_predictions('shm', shm)
    door = {**report('door'), 'prediction_rows': [{'start_time': '2023-7-5-0-0-0-20', 'end_time': '2023-7-5-0-0-1-20', 'prediction': 'Normal'}]}
    validate_predictions('door', door)
    door['prediction_rows'][0]['end_time'] = door['prediction_rows'][0]['start_time']
    with pytest.raises(ValueError):
        validate_predictions('door', door)


def test_missing_key_uses_explicit_local_summary(monkeypatch):
    monkeypatch.setenv('RAILGUARD_AI_ENABLED', 'false')
    value = investigate(report(), {'metric': 'Macro F1', 'score': 0.0}, 'Why this result?')
    assert value['mode'] == 'local'
    assert 'fixed local evidence summary' in value['answer']
    assert '0.0000' in value['answer']


def test_agent_executes_read_only_tool_and_uses_its_result(monkeypatch):
    monkeypatch.setenv('RAILGUARD_AI_ENABLED', 'true')
    monkeypatch.setenv('OPENAI_API_KEY', 'unit-test-placeholder')
    calls = []
    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        if len(calls) == 1:
            return httpx.Response(200, json={'status': 'completed', 'output': [{'type': 'function_call', 'call_id': 'tool1', 'name': 'get_prediction_evidence', 'arguments': '{}'}]})
        assert body['input'][-1]['call_id'] == 'tool1'
        assert 'Side I RMS' in body['input'][-1]['output']
        return httpx.Response(200, json={'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': 'The classifier predicts Side I. This is a model finding. [E1]'}]}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        value = investigate(report(), {}, 'Why this result?', client)
    assert value['mode'] == 'agent'
    assert value['tools'][0]['name'] == 'get_prediction_evidence'
    assert value['sources'] == [{'id': 'E1', 'label': 'Selected prediction and evidence'}]
    assert len(calls) == 2


def test_api_error_falls_back_without_exposing_credentials(monkeypatch):
    monkeypatch.setenv('RAILGUARD_AI_ENABLED', 'true')
    monkeypatch.setenv('OPENAI_API_KEY', 'unit-test-secret-placeholder')
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(401, json={'error': 'unit-test-secret-placeholder'}))) as client:
        value = investigate(report(), {}, 'Why?', client)
    assert value['mode'] == 'local'
    assert 'unit-test-secret-placeholder' not in json.dumps(value)


@pytest.mark.parametrize('tool,citation', [('get_subsystem_reference', 'R1'), ('get_prediction_evidence', 'V1')])
def test_agent_cannot_diagnose_without_file_evidence_or_cite_unread_sources(monkeypatch, tool, citation):
    monkeypatch.setenv('RAILGUARD_AI_ENABLED', 'true')
    monkeypatch.setenv('OPENAI_API_KEY', 'unit-test-placeholder')
    count = 0
    def handler(request):
        nonlocal count
        count += 1
        if count == 1:
            assert json.loads(request.content)['tool_choice'] == {'type': 'function', 'name': 'get_prediction_evidence'}
            return httpx.Response(200, json={'output': [{'type': 'function_call', 'call_id': 'one', 'name': tool, 'arguments': '{}'}]})
        return httpx.Response(200, json={'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': f'Diagnosis [{citation}]'}]}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = investigate(report(), {}, 'Explain this file.', client)
    assert result['mode'] == 'local'


def test_snapshot_rejects_estimator_not_bound_to_saved_validation(tmp_path, monkeypatch):
    import hashlib
    import types
    artifact = tmp_path / 'models' / 'rail'
    artifact.mkdir(parents=True)
    (artifact / 'model.joblib').write_bytes(b'new estimator')
    (artifact / 'metadata.json').write_text(json.dumps({'model_name': 'old', 'trained_at': 'old',
        'model_sha256': hashlib.sha256(b'old estimator').hexdigest(), 'validation': {'score': .1}}))
    monkeypatch.setattr('backend.ps3.service.importlib.import_module', lambda _: types.SimpleNamespace(predict=lambda *_: pytest.fail('Mismatched model must never predict')))
    value = PS3Service(tmp_path / 'data', tmp_path / 'models', tmp_path / 'jobs')
    path = tmp_path / 'Test1.csv'
    path.write_text('input')
    try:
        assert value.model('rail') is None
        with pytest.raises(ValueError, match='No trained model is available'):
            value.create('rail', [path])
        assert not list(value.jobs_dir.glob('*/job.json'))
    finally:
        value.close()


def test_http_upload_investigation_and_export_contract(service, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from backend.api import create_app
    monkeypatch.setenv('RAILGUARD_AI_ENABLED', 'false')
    artifact = service.artifacts_dir / 'rail'
    artifact.mkdir(parents=True)
    (artifact / 'model.joblib').write_bytes(b'test fixture, predictor injected')
    (artifact / 'metadata.json').write_text(json.dumps({'model_name': 'Fixture classifier', 'validation': {'metric': 'Macro F1', 'score': .5}}))
    app = create_app(orders_path=tmp_path / 'orders.sqlite3', ps3_service=service)
    with TestClient(app) as client:
        bad = client.post('/api/ps3/jobs', data={'subsystem': 'rail'}, files=[('files', ('../escape.csv', b'input'))])
        assert bad.status_code == 422
        empty = client.post('/api/ps3/jobs', data={'subsystem': 'rail'}, files=[('files', ('empty.csv', b''))])
        assert empty.status_code == 422
        assert not list(service.jobs_dir.glob('*/inputs'))
        response = client.post('/api/ps3/jobs', data={'subsystem': 'rail'}, files=[('files', ('Test1.csv', b'input'))])
        assert response.status_code == 202
        job_id = response.json()['id']
        wait(service, job_id)
        job = client.get(f'/api/ps3/jobs/{job_id}').json()
        assert job['status'] == 'completed' and job['source'] == 'uploaded'
        assert job['reports'][0]['input_sha256']
        csv_response = client.get(f'/api/ps3/jobs/{job_id}/csv')
        assert csv_response.status_code == 200 and csv_response.text.startswith('file_id,prediction\n')
        exported = client.post('/api/ps3/export', json={'job_ids': [job_id]})
        assert exported.status_code == 200 and exported.headers['content-type'] == 'application/zip'
        body = {'job_id': job_id, 'file_id': 'Test1.csv', 'question': 'What evidence supports this?'}
        assert client.post('/api/ps3/investigate', json=body).json()['mode'] == 'local'
        assert client.post('/api/ps3/investigate', json={**body, 'question': '   '}).status_code == 422
        assert client.post('/api/ps3/investigate', json={**body, 'file_id': 'Other.csv'}).status_code == 404
        assert client.get('/api/ps3/jobs/' + '0' * 32).status_code == 404
        monkeypatch.setattr('backend.ps3.limits.MAX_REQUEST_BYTES', 1024)
        oversized = client.post('/api/ps3/jobs', data={'subsystem': 'rail'}, files=[('files', ('large.csv', b'x' * 2048))])
        assert oversized.status_code == 413
        multipart = b'--test\r\nContent-Disposition: form-data; name="files"; filename="large.csv"\r\nContent-Type: text/csv\r\n\r\n' + b'x' * 2048 + b'\r\n--test--\r\n'
        chunked = client.post('/api/ps3/jobs', content=iter([multipart[:512], multipart[512:]]), headers={'Content-Type': 'multipart/form-data; boundary=test'})
        assert chunked.status_code == 413
