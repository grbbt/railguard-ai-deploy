"""Lossless, bounded upload transport; fixtures make no model accuracy claims."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import threading
import time

from fastapi.testclient import TestClient
import pytest

from backend.api import create_app
from backend.ps3 import api as ps3_api
from backend.ps3.service import PS3Service
from backend.ps3.upload_transport import (
    UploadLimitError,
    UploadLimits,
    parse_upload_metadata,
    save_uploads,
)


RAW = b'\xef\xbb\xbftime,signal,comment\r\n0,1,"two, fields"\r\n1,,caf\xc3\xa9\r\n'


class BoundedSource(io.BytesIO):
    """Fail if transport attempts to materialize a complete source at once."""

    def __init__(self, raw, chunk_bytes):
        super().__init__(raw)
        self.chunk_bytes = chunk_bytes
        self.reads = []

    def read(self, size=-1):
        assert 0 < size <= self.chunk_bytes
        self.reads.append(size)
        return super().read(size)


def _save(tmp_path, payloads, encodings, *, limits=None):
    tmp_path.mkdir(exist_ok=True)
    names = [f'Test{i + 1}.csv' for i in range(len(payloads))]
    options = {} if limits is None else {'limits': limits}
    return save_uploads([io.BytesIO(raw) for raw in payloads], names, encodings, tmp_path, **options)


def test_legacy_and_explicit_identity_metadata_preserve_original_names():
    names = ['Test (2).CSV', 'signal.gz.csv']
    for metadata in (None, '["identity", "identity"]'):
        assert parse_upload_metadata(metadata, names, '.csv') == (names, ['identity', 'identity'])
    assert parse_upload_metadata(None, ['Case 1.xlsx'], '.xlsx') == (['Case 1.xlsx'], ['identity'])


def test_gzip_metadata_removes_only_transport_suffix_and_keeps_original_name_limit():
    longest = 'a' * 146 + '.csv'
    wire_names = ['signal.gz.csv.gz', 'plain.csv', longest + '.gz']
    assert parse_upload_metadata('["gzip", "identity", "gzip"]', wire_names, '.csv') == (
        ['signal.gz.csv', 'plain.csv', longest], ['gzip', 'identity', 'gzip'])


@pytest.mark.parametrize('metadata', [
    '', 'not json', 'null', '{}', '"gzip"', '1', 'true', '[]',
    '["identity", "gzip"]', '["br"]', '["GZIP"]', '[null]', '[1]',
    '[true]', '[{}]', '[[]]', '["gzip",]',
])
def test_metadata_requires_aligned_json_array_of_known_strings(metadata):
    with pytest.raises(ValueError):
        parse_upload_metadata(metadata, ['Test1.csv'], '.csv')


@pytest.mark.parametrize('metadata,name,extension', [
    (None, 'Test1.csv.gz', '.csv'),
    ('["identity"]', 'Test1.csv.gz', '.csv'),
    ('["gzip"]', 'Test1.csv', '.csv'),
    ('["gzip"]', 'Test1.csv.gz.gz', '.csv'),
    ('["gzip"]', 'Test1.xlsx.gz', '.xlsx'),
    ('["gzip"]', 'Test1.xlsx.gz', '.csv'),
    ('["gzip"]', '../escape.csv.gz', '.csv'),
    ('["gzip"]', '..\\escape.csv.gz', '.csv'),
    ('["gzip"]', 'C:escape.csv.gz', '.csv'),
    ('["gzip"]', '=formula.csv.gz', '.csv'),
    ('["gzip"]', 'CON.csv.gz', '.csv'),
    ('["gzip"]', 'a' * 147 + '.csv.gz', '.csv'),
])
def test_metadata_rejects_unsafe_names_and_unnegotiated_or_wrong_format_gzip(metadata, name, extension):
    with pytest.raises(ValueError):
        parse_upload_metadata(metadata, [name], extension)


@pytest.mark.parametrize('encoding', ['identity', 'gzip'])
def test_streaming_roundtrip_keeps_exact_original_bytes_and_hash(tmp_path, encoding):
    raw = RAW * 100
    wire = gzip.compress(raw, mtime=0) if encoding == 'gzip' else raw
    source = BoundedSource(wire, chunk_bytes=7)
    paths = save_uploads([source], ['Original (2).csv'], [encoding], tmp_path,
                         limits=UploadLimits(chunk_bytes=7))
    assert paths == [tmp_path / 'Original (2).csv']
    assert paths[0].read_bytes() == raw
    assert hashlib.sha256(paths[0].read_bytes()).hexdigest() == hashlib.sha256(raw).hexdigest()
    assert len(source.reads) > 1


def test_identity_does_not_guess_encoding_from_content(tmp_path):
    wire = gzip.compress(RAW, mtime=0)
    assert _save(tmp_path, [wire], ['identity'])[0].read_bytes() == wire


def test_gzip_header_filename_cannot_replace_validated_multipart_name(tmp_path):
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode='wb', filename='ignored.csv', mtime=0) as stream:
        stream.write(RAW)
    # Supply an explicitly unsafe optional FNAME header, independent of the
    # multipart filename. It must never become a destination path or file ID.
    wire = buffer.getvalue().replace(b'ignored.csv\x00', b'../escape.csv\x00', 1)
    paths = _save(tmp_path, [wire], ['gzip'])
    assert paths == [tmp_path / 'Test1.csv']
    assert paths[0].read_bytes() == RAW
    assert list(tmp_path.iterdir()) == paths


def _broken_gzip(kind):
    wire = gzip.compress(RAW, mtime=0)
    if kind == 'not-gzip':
        return RAW
    if kind == 'empty-wire':
        return b''
    if kind == 'empty-original':
        return gzip.compress(b'', mtime=0)
    if kind == 'truncated-header':
        return wire[:7]
    if kind == 'truncated-body':
        return wire[:len(wire) // 2]
    if kind == 'truncated-trailer':
        return wire[:-1]
    if kind == 'bad-crc':
        return wire[:-8] + bytes([wire[-8] ^ 1]) + wire[-7:]
    if kind == 'bad-size':
        return wire[:-4] + bytes([wire[-4] ^ 1]) + wire[-3:]
    if kind == 'trailing-bytes':
        return wire + b'unexpected'
    if kind == 'trailing-zero':
        return wire + b'\x00'
    if kind == 'concatenated-member':
        return wire + gzip.compress(RAW, mtime=0)
    raise AssertionError(kind)


@pytest.mark.parametrize('kind', [
    'not-gzip', 'empty-wire', 'empty-original', 'truncated-header', 'truncated-body',
    'truncated-trailer', 'bad-crc', 'bad-size', 'trailing-bytes', 'trailing-zero', 'concatenated-member',
])
@pytest.mark.parametrize('chunk_bytes', [7, 65536])
def test_gzip_requires_one_complete_valid_nonempty_member(tmp_path, kind, chunk_bytes):
    with pytest.raises(ValueError):
        _save(tmp_path, [_broken_gzip(kind)], ['gzip'], limits=UploadLimits(chunk_bytes=chunk_bytes))


def test_identity_empty_file_rejected(tmp_path):
    with pytest.raises(ValueError):
        _save(tmp_path, [b''], ['identity'])


@pytest.mark.parametrize('encoding', ['identity', 'gzip'])
def test_exact_original_file_and_batch_limit_are_accepted(tmp_path, encoding):
    original = b'row,1\r\n' * 10
    wire = gzip.compress(original, mtime=0) if encoding == 'gzip' else original
    paths = _save(tmp_path, [wire, wire], [encoding, encoding], limits=UploadLimits(
        file_bytes=len(original), batch_bytes=2 * len(original), compressed_file_bytes=len(wire), chunk_bytes=11))
    assert [path.read_bytes() for path in paths] == [original, original]


@pytest.mark.parametrize('encoding', ['identity', 'gzip'])
def test_original_per_file_limit_is_enforced_after_decompression(tmp_path, encoding):
    original = b'x' * 4097
    wire = gzip.compress(original, mtime=0) if encoding == 'gzip' else original
    with pytest.raises(UploadLimitError):
        _save(tmp_path, [wire], [encoding], limits=UploadLimits(file_bytes=4096, chunk_bytes=31))


def test_batch_limit_counts_original_bytes_across_mixed_encodings(tmp_path):
    with pytest.raises(UploadLimitError):
        _save(tmp_path, [b'a' * 100, gzip.compress(b'b' * 101, mtime=0)], ['identity', 'gzip'],
              limits=UploadLimits(file_bytes=1024, batch_bytes=200, chunk_bytes=13))


def test_compressed_file_limit_counts_wire_bytes(tmp_path):
    wire = gzip.compress(RAW, mtime=0)
    with pytest.raises(UploadLimitError):
        _save(tmp_path, [wire], ['gzip'], limits=UploadLimits(
            compressed_file_bytes=len(wire) - 1, chunk_bytes=5))


def test_compressed_batch_limit_counts_wire_bytes_even_for_tiny_originals(tmp_path):
    wire = gzip.compress(b'x', mtime=0)
    with pytest.raises(UploadLimitError):
        _save(tmp_path, [wire, wire], ['gzip', 'gzip'], limits=UploadLimits(
            file_bytes=64, compressed_file_bytes=64, batch_bytes=2 * len(wire) - 1, chunk_bytes=5))


@pytest.mark.parametrize('names,encodings', [
    (['one.csv'], []), ([], ['identity']),
    (['one.csv'], ['br']), (['../escape.csv'], ['identity']),
    (['same.csv', 'SAME.csv'], ['identity', 'gzip']),
])
def test_save_validates_entire_batch_before_writing(tmp_path, names, encodings):
    with pytest.raises(ValueError):
        save_uploads([io.BytesIO(RAW)] * len(names), names, encodings, tmp_path)
    assert not list(tmp_path.iterdir())


@pytest.fixture
def upload_client(tmp_path):
    predicted = []

    def predictor(path, _):
        predicted.append((path.name, path.read_bytes()))
        row = ({'file_id': path.name, 'ranked_cars': '01|02|03|04|05|06|07|08'}
               if path.suffix == '.xlsx' else {'file_id': path.name, 'prediction': 'Normal'})
        return {'file_id': path.name, 'summary': 'Transport test fixture', 'prediction_rows': [row]}

    service = PS3Service(tmp_path / 'data', tmp_path / 'models', tmp_path / 'jobs', predictor=predictor)
    for subsystem in ('rail', 'acv'):
        directory = service.artifacts_dir / subsystem
        directory.mkdir(parents=True)
        (directory / 'model.joblib').write_bytes(b'Injected test predictor; not a trained model')
        (directory / 'metadata.json').write_text(json.dumps({
            'model_name': 'Transport fixture', 'validation': {'score': None},
        }), encoding='utf-8')
    app = create_app(orders_path=tmp_path / 'orders.sqlite3', ps3_service=service)
    with TestClient(app) as client:
        yield client, service, predicted


def _completed(service, job_id):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        job = service.get(job_id)
        if job['status'] in {'completed', 'failed'}:
            assert job['status'] == 'completed', job.get('error')
            return job
        time.sleep(.01)
    raise AssertionError('Transport fixture job did not finish')


def _assert_no_job(service, predicted):
    assert predicted == []
    assert not list(service.jobs_dir.glob('*/inputs'))
    assert not list(service.jobs_dir.glob('*/job.json'))
    assert [path.name for path in service.jobs_dir.iterdir()] == ['.owners']


@pytest.mark.parametrize('subsystem,name,raw', [('rail', 'Legacy.csv', RAW), ('acv', 'Legacy.xlsx', b'fixture workbook')])
def test_route_legacy_upload_remains_compatible(upload_client, subsystem, name, raw):
    client, service, predicted = upload_client
    response = client.post('/api/ps3/jobs', data={'subsystem': subsystem}, files=[('files', (name, raw))])
    assert response.status_code == 202, response.text
    job = _completed(service, response.json()['id'])
    assert predicted == [(name, raw)]
    assert job['source'] == 'uploaded'
    assert job['reports'][0]['input_sha256'] == hashlib.sha256(raw).hexdigest()
    assert (service.jobs_dir / job['id'] / 'inputs' / name).read_bytes() == raw


def test_route_gzip_mixed_batch_preserves_original_ids_hashes_and_exports(upload_client):
    client, service, predicted = upload_client
    second = b'time,signal\n0,2\n'
    response = client.post('/api/ps3/jobs', data={
        'subsystem': 'rail', 'file_encodings': '["gzip", "identity"]',
    }, files=[('files', ('Compressed.csv.gz', gzip.compress(RAW, mtime=0))),
              ('files', ('Plain.csv', second))])
    assert response.status_code == 202, response.text
    job = _completed(service, response.json()['id'])
    assert predicted == [('Compressed.csv', RAW), ('Plain.csv', second)]
    assert [report['file_id'] for report in job['reports']] == ['Compressed.csv', 'Plain.csv']
    assert [report['input_sha256'] for report in job['reports']] == [
        hashlib.sha256(raw).hexdigest() for raw in (RAW, second)]
    inputs = service.jobs_dir / job['id'] / 'inputs'
    assert sorted(path.name for path in inputs.iterdir()) == ['Compressed.csv', 'Plain.csv']
    exported = client.get(f"/api/ps3/jobs/{job['id']}/csv")
    assert exported.status_code == 200
    assert exported.text == 'file_id,prediction\nCompressed.csv,Normal\nPlain.csv,Normal\n'


@pytest.mark.parametrize('metadata,names,subsystem', [
    ('{"encoding":"gzip"}', ['Test.csv.gz'], 'rail'),
    ('["gzip", "identity"]', ['Test.csv.gz'], 'rail'),
    ('["br"]', ['Test.csv.gz'], 'rail'),
    ('["gzip"]', ['../escape.csv.gz'], 'rail'),
    ('["gzip"]', ['CON.csv.gz'], 'rail'),
    ('["gzip"]', ['Test.csv.gz.gz'], 'rail'),
    ('["gzip"]', ['Test.csv'], 'rail'),
    (None, ['Test.csv.gz'], 'rail'),
    ('["identity"]', ['Test.csv.gz'], 'rail'),
    ('["gzip"]', ['Case.xlsx.gz'], 'acv'),
    ('["gzip", "identity"]', ['Same.csv.gz', 'SAME.csv'], 'rail'),
])
def test_route_rejects_metadata_and_names_before_mkdir(upload_client, monkeypatch, metadata, names, subsystem):
    client, service, predicted = upload_client
    created_inputs = []
    original_mkdir = Path.mkdir

    def record_mkdir(path, *args, **kwargs):
        if path.name == 'inputs' and path.parent.parent == service.jobs_dir:
            created_inputs.append(path)
        return original_mkdir(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'mkdir', record_mkdir)
    data = {'subsystem': subsystem}
    if metadata is not None:
        data['file_encodings'] = metadata
    response = client.post('/api/ps3/jobs', data=data, files=[
        ('files', (name, gzip.compress(RAW, mtime=0))) for name in names])
    assert response.status_code == 422, response.text
    assert created_inputs == []
    _assert_no_job(service, predicted)


@pytest.mark.parametrize('kind', ['bad-crc', 'truncated-trailer', 'concatenated-member', 'empty-original'])
def test_route_bad_second_upload_cleans_partial_batch_without_inference(upload_client, kind):
    client, service, predicted = upload_client
    response = client.post('/api/ps3/jobs', data={
        'subsystem': 'rail', 'file_encodings': '["identity", "gzip"]',
    }, files=[('files', ('First.csv', RAW)), ('files', ('Broken.csv.gz', _broken_gzip(kind)))])
    assert response.status_code == 422, response.text
    _assert_no_job(service, predicted)


def test_route_limit_failure_is_413_and_cleans_saved_inputs(upload_client, monkeypatch):
    client, service, predicted = upload_client
    original_save = ps3_api.save_uploads

    def save_with_small_limit(*args, **kwargs):
        return original_save(*args, **{**kwargs, 'limits': UploadLimits(file_bytes=100, batch_bytes=150)})

    monkeypatch.setattr(ps3_api, 'save_uploads', save_with_small_limit)
    response = client.post('/api/ps3/jobs', data={
        'subsystem': 'rail', 'file_encodings': '["identity", "gzip"]',
    }, files=[('files', ('First.csv', b'a' * 100)),
              ('files', ('Large.csv.gz', gzip.compress(b'b' * 51, mtime=0)))])
    assert response.status_code == 413, response.text
    _assert_no_job(service, predicted)


@pytest.mark.parametrize('failure', ['invalid-gzip', 'closed-service'])
def test_route_closes_sources_and_removes_input_directory_on_failure(upload_client, monkeypatch, failure):
    client, service, predicted = upload_client
    original_save, sources = ps3_api.save_uploads, []

    def record_sources(upload_sources, *args, **kwargs):
        sources.extend(upload_sources)
        return original_save(upload_sources, *args, **kwargs)

    monkeypatch.setattr(ps3_api, 'save_uploads', record_sources)
    if failure == 'closed-service':
        service.close()
    wire = b'invalid gzip' if failure == 'invalid-gzip' else gzip.compress(RAW, mtime=0)
    response = client.post('/api/ps3/jobs', data={'subsystem': 'rail', 'file_encodings': '["gzip"]'},
                           files=[('files', ('Test.csv.gz', wire))])
    assert response.status_code == 422, response.text
    assert sources and all(source.closed for source in sources)
    _assert_no_job(service, predicted)


def test_route_saves_on_worker_thread_and_closes_sources(upload_client, monkeypatch):
    client, service, _ = upload_client
    parsing_threads, saving_threads, sources = [], [], []
    original_parse, original_save = ps3_api.parse_upload_metadata, ps3_api.save_uploads

    def record_parse(*args, **kwargs):
        parsing_threads.append(threading.get_ident())
        return original_parse(*args, **kwargs)

    def record_save(upload_sources, *args, **kwargs):
        saving_threads.append(threading.get_ident())
        sources.extend(upload_sources)
        return original_save(upload_sources, *args, **kwargs)

    monkeypatch.setattr(ps3_api, 'parse_upload_metadata', record_parse)
    monkeypatch.setattr(ps3_api, 'save_uploads', record_save)
    response = client.post('/api/ps3/jobs', data={'subsystem': 'rail', 'file_encodings': '["gzip"]'},
                           files=[('files', ('Test.csv.gz', gzip.compress(RAW, mtime=0)))])
    assert response.status_code == 202, response.text
    _completed(service, response.json()['id'])
    assert len(parsing_threads) == len(saving_threads) == 1
    assert parsing_threads[0] != saving_threads[0]
    assert sources and all(source.closed for source in sources)


def test_route_advertises_supported_upload_encodings(upload_client):
    response = upload_client[0].get('/api/ps3/status')
    assert response.status_code == 200
    assert response.json()['limits']['upload_encodings'] == ['identity', 'gzip']
