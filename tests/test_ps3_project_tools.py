"""Project investigations retrieve bounded evidence without expanding selected scope."""
from copy import deepcopy
import json

import pytest

from backend.ps3 import project_tools
from backend.ps3.project_tools import ProjectTools


FIRST, SECOND, THIRD = 'a' * 32, 'b' * 32, 'c' * 32


def report(name, prediction=None, subsystem='rail', **changes):
    value = {'file_id': name, 'subsystem': subsystem, 'model_name': 'Saved estimator',
             'summary': 'Saved prediction, subject to review.', 'evidence': [], 'entities': [], 'warnings': [],
             'prediction_rows': [{'file_id': name, 'prediction': prediction}]}
    value.update(changes)
    return value


def job(identity=FIRST, subsystem='rail', reports=None, **changes):
    value = {'id': identity, 'subsystem': subsystem, 'status': 'completed', 'source': 'uploaded',
             'created_at': '2026-09-18T01:00:00+00:00', 'finished_at': '2026-09-18T01:01:00+00:00',
             'reports': reports if reports is not None else [report('file2.csv', 'Normal'), report('file10.csv', 'Side I')],
             'validation': {'metric': 'Macro F1', 'score': .71, 'method': 'Saved grouped validation'}}
    value.update(changes)
    return value


class Service:
    def __init__(self, jobs=None):
        self.jobs = jobs or {FIRST: job(), SECOND: job(SECOND, reports=[report('other.csv', 'Side II')])}
        self.reads = []
        self.list_reads = []
        self.metadata = {'subsystem': 'rail', 'model_name': 'Current estimator', 'trained_at': '2026-09-18',
                         'training_files': 272, 'training_rows': 2720000, 'feature_names': ['rms', 'spectrum'],
                         'validation': {'metric': 'Macro F1', 'score': .78, 'method': 'Current grouped validation'},
                         'training_sources': ['DO_NOT_SEND_MANIFEST'], 'model_sha256': 'DO_NOT_SEND_HASH',
                         'private_path': 'C:/secret/model.joblib', 'secret': 'DO_NOT_SEND_SECRET'}

    def get(self, identity):
        self.reads.append(identity)
        return deepcopy(self.jobs[identity])

    def model(self, subsystem):
        return deepcopy({**self.metadata, 'subsystem': subsystem})

    def list_jobs(self, limit=100, subsystem=None):
        self.list_reads.append((limit, subsystem))
        jobs = [{**item, 'file_count': len(item['reports'])} for item in self.jobs.values()
                if subsystem is None or item['subsystem'] == subsystem]
        return {'jobs': deepcopy(jobs[:limit]), 'total': len(jobs)}

    def status(self):
        return {'subsystems': [{'id': key, 'available': True, 'task': 'Fixture task', 'model': self.model(key)}
                               for key in project_tools.SUBSYSTEMS],
                'assistant': {'key': 'DO_NOT_SEND_API_KEY'}, 'private': 'DO_NOT_SEND_STATUS_PRIVATE',
                'limits': {'file_mb': 64, 'batch_files': 100, 'batch_mb': 1500}}


def compare(tools, **changes):
    arguments = {'job_id': None, 'offset': 0, 'limit': 30, 'sort': 'filename', 'query': None}
    arguments.update(changes)
    return tools.execute('compare_run_files', arguments)[0]


def inspect(tools, **changes):
    arguments = {'job_id': None, 'file_id': None, 'prediction_offset': 0, 'prediction_limit': 80}
    arguments.update(changes)
    return tools.execute('inspect_recording', arguments)[0]


def test_all_tool_schemas_are_strict_and_have_no_path_or_write_parameter():
    specs = ProjectTools(Service()).specs()
    assert len(specs) == 6
    assert len({item['name'] for item in specs}) == 6
    for spec in specs:
        schema = spec['input_schema']
        assert schema['additionalProperties'] is False
        assert set(schema['required']) == set(schema['properties'])
        assert not set(schema['properties']).intersection({'path', 'url', 'command', 'code', 'write'})


@pytest.mark.parametrize('scope,identity,filename', [('unknown', None, None), ('run', None, None), ('file', FIRST, None),
                                                     ('project', '../../secrets', None), ('file', FIRST, '../file.csv'),
                                                     ('project', FIRST, 'C:\\private.csv'), ('project', None, 'file.csv')])
def test_invalid_scope_selection_rejected_before_any_reads(scope, identity, filename):
    service = Service()
    with pytest.raises(ValueError):
        ProjectTools(service, scope, identity, filename)
    assert not service.reads and not service.list_reads


def test_file_scope_blocks_other_runs_and_files_without_disclosing_results():
    service = Service()
    tools = ProjectTools(service, 'file', FIRST, 'file2.csv')
    value = compare(tools)
    assert value['aggregate']['files'] == 1
    assert [item['file_id'] for item in value['files']] == ['file2.csv']
    assert 'file10.csv' not in json.dumps(value)
    with pytest.raises(ValueError, match='outside'):
        compare(tools, job_id=SECOND)
    with pytest.raises(ValueError, match='outside'):
        inspect(tools, file_id='file10.csv')
    result = tools.execute('list_saved_runs', {'subsystem': None, 'limit': 30})[0]
    assert result['runs'][0]['accessible_file_count'] == 1
    assert result['completed_runs_in_scope'] == 1
    assert not service.list_reads and SECOND not in service.reads


def test_run_scope_can_select_other_file_but_not_other_run_and_docs_models_are_general():
    service = Service()
    tools = ProjectTools(service, 'run', FIRST, 'file2.csv')
    assert inspect(tools, file_id='file10.csv')['prediction_summary']['predicted_class'] == 'Side I'
    assert compare(tools)['aggregate']['files'] == 2
    with pytest.raises(ValueError, match='outside'):
        inspect(tools, job_id=SECOND, file_id='other.csv')
    assert tools.execute('get_model_details', {'subsystem': 'acv'})[0]['subsystem'] == 'acv'
    assert not service.list_reads and SECOND not in service.reads


def test_project_scope_resolves_exact_ids_and_does_not_guess_cross_run_file():
    service = Service()
    tools = ProjectTools(service, job_id=FIRST, file_id='file2.csv')
    assert inspect(tools, job_id=SECOND)['file_id'] == 'other.csv'
    assert compare(tools, job_id=SECOND)['aggregate']['class_counts']['Side II'] == 1
    with pytest.raises(ValueError, match='exact retained'):
        inspect(tools, file_id='File2.csv')
    with pytest.raises(KeyError):
        compare(tools, job_id=THIRD)
    with pytest.raises(ValueError, match='Choose a saved run'):
        compare(ProjectTools(service))


@pytest.mark.parametrize('arguments', [None, {}, {'job_id': None}, {'job_id': None, 'offset': -1, 'limit': 30, 'sort': 'filename', 'query': None},
                                     {'job_id': None, 'offset': 0, 'limit': True, 'sort': 'filename', 'query': None},
                                     {'job_id': None, 'offset': 0, 'limit': 31, 'sort': 'filename', 'query': None},
                                     {'job_id': None, 'offset': 0, 'limit': 3, 'sort': 'unknown', 'query': None},
                                     {'job_id': None, 'offset': 0, 'limit': 3, 'sort': 'filename', 'query': None, 'path': '.env'}])
def test_execution_validates_arguments_without_trusting_llm_schema(arguments):
    service = Service()
    with pytest.raises(ValueError):
        ProjectTools(service, job_id=FIRST).execute('compare_run_files', arguments)
    assert not service.reads


def test_unknown_tool_and_non_completed_run_are_rejected():
    service = Service({FIRST: job(status='running', reports=[])})
    tools = ProjectTools(service, job_id=FIRST)
    with pytest.raises(ValueError, match='Unknown'):
        tools.execute('execute_python', {})
    with pytest.raises(ValueError, match='completed'):
        compare(tools)
    assert tools.context()['selection_unavailable'] is True


def test_comparison_aggregates_all_files_before_query_and_page_and_sorts_naturally():
    reports = [report('sample10.csv', 'Side I'), report('sample2.csv', 'Normal'), report('sample1.csv', 'Side II'),
               report('sample3.csv', None), report('sample4.csv', 'unexpected')]
    tools = ProjectTools(Service({FIRST: job(reports=reports)}), job_id=FIRST)
    value = compare(tools, offset=1, limit=2)
    assert [item['file_id'] for item in value['files']] == ['sample2.csv', 'sample3.csv']
    assert value['aggregate']['class_counts'] == {'Normal': 1, 'Side I': 1, 'Side II': 1}
    assert value['aggregate']['missing_predictions'] == 2
    assert value['next_offset'] == 3 and value['matching_files_omitted'] == 3
    searched = compare(tools, query='SAMPLE10')
    assert searched['matching_files'] == 1 and searched['aggregate']['files'] == 5
    assert compare(tools, query='absent')['files'] == []
    with pytest.raises(ValueError, match='Numeric'):
        compare(tools, sort='value-desc')


def test_shm_zero_is_retained_missing_last_and_statistics_are_deterministic():
    reports = [report(f'damage{index}.csv', value, 'shm') for index, value in enumerate([None, 0, .5, 2, float('nan'), -1, True])]
    tools = ProjectTools(Service({FIRST: job(subsystem='shm', reports=reports)}), job_id=FIRST)
    value = compare(tools, sort='value-asc')
    assert [item['predicted_damage'] for item in value['files']] == [0, .5, 2, None, None, None, None]
    assert value['aggregate']['damage'] == {'count': 3, 'minimum': 0, 'maximum': 2, 'mean': pytest.approx(2.5 / 3)}
    assert value['aggregate']['missing_predictions'] == 4
    assert [item['predicted_damage'] for item in compare(tools, sort='value-desc')['files']][:3] == [2, .5, 0]
    assert [item['predicted_damage'] for item in compare(tools, sort='result')['files']][:3] == [2, .5, 0]


def test_door_action_counts_cover_all_rows_even_when_only_one_page_retrieved():
    rows = [{'start_time': index, 'end_time': index + 1, 'prediction': 'Abnormal resistance' if index % 3 == 0 else 'Normal'}
            for index in range(121)]
    recording = report('Door.csv', subsystem='door', prediction_rows=rows)
    tools = ProjectTools(Service({FIRST: job(subsystem='door', reports=[recording])}), job_id=FIRST, file_id='Door.csv')
    value = inspect(tools, prediction_offset=80, prediction_limit=40)
    assert value['coverage']['prediction_rows_total'] == 121 and len(value['prediction_rows']) == 40
    assert value['coverage']['next_prediction_offset'] == 120 and value['coverage']['prediction_rows_omitted'] == 81
    assert value['prediction_summary']['abnormal_actions'] == 41
    assert compare(tools)['aggregate']['normal_actions'] == 80


def test_acv_rankings_preserve_actual_ids_and_unknown_telemetry_without_inventing_confidence():
    recording = report('case.xlsx', subsystem='acv', prediction_rows=[{'file_id': 'case.xlsx', 'ranked_cars': '08|03|01|02|04|05|06|07'}],
                       entities=[{'id': '08', 'status': 'ranked', 'value': .2}, {'id': '07', 'status': 'unavailable', 'value': None}])
    tools = ProjectTools(Service({FIRST: job(subsystem='acv', reports=[recording])}), job_id=FIRST)
    value = compare(tools)
    assert value['files'][0]['ranked_cars'][0] == '08'
    assert value['files'][0]['unavailable_entities'] == ['07']
    assert value['aggregate']['first_ranked_car_counts'] == {'08': 1}
    assert value['aggregate']['files_with_unavailable_entities'] == 1
    assert 'probability' not in value['files'][0]


def test_recording_reads_saved_validation_not_current_and_bounds_disclosed_previews():
    recording = report('file.csv', 0, 'shm', evidence=[{'id': str(i), 'value': i} for i in range(50)],
                       warnings=['Review'] * 20, entities=[{'id': str(i)} for i in range(30)],
                       series=[{'name': 'Wave', 'points': [{'x': i, 'y': i} for i in range(100)]}] * 10)
    service = Service({FIRST: job(subsystem='shm', reports=[recording])})
    value = inspect(ProjectTools(service, job_id=FIRST))
    assert value['saved_validation']['score'] == .71
    assert value['coverage']['evidence_omitted'] == 10 and value['coverage']['entities_omitted'] == 10
    assert value['coverage']['warnings_omitted'] == 4 and value['coverage']['signals_omitted'] == 2
    signal = value['signal_previews'][0]
    assert signal['preview_points_total'] == 100 and len(signal['sampled_points']) == 12
    assert signal['sampled_points'][0]['y'] == 0 and signal['sampled_points'][-1]['y'] == 99
    assert signal['preview_points_omitted'] == 88


def test_missing_optional_report_data_stays_honest():
    recording = {'file_id': 'empty.csv', 'prediction_rows': None, 'evidence': None, 'series': None, 'entities': None, 'warnings': None}
    tools = ProjectTools(Service({FIRST: job(reports=[recording], validation=None)}), job_id=FIRST)
    value = inspect(tools)
    assert value['prediction_rows'] == [] and value['signal_previews'] == []
    assert value['saved_validation']['available'] is False
    assert value['prediction_summary']['predicted_class'] is None


def test_metadata_nested_audit_kept_and_manifests_secrets_and_arbitrary_paths_excluded():
    service = Service()
    service.metadata['validation']['nested_validation'] = {'score': .9167, 'ranking_metrics': {'top1_correct': 4, 'cases': 6},
                                                          'folds': [{'private_path': 'DO_NOT_SEND_FOLD_PATH'}]}
    service.metadata['selected_model_parameters'] = {'scale': 0, 'api_key': 'DO_NOT_SEND_NESTED_KEY', 'model_path': 'DO_NOT_SEND_PARAMETER_PATH'}
    service.metadata['feature_names'] = [str(index) for index in range(1000)]
    tools = ProjectTools(service)
    value = tools.execute('get_model_details', {'subsystem': 'acv'})[0]
    model = value['current_model']
    assert model['validation']['nested_validation']['ranking_metrics']['top1_correct'] == 4
    assert model['selected_model_parameters']['scale'] == 0
    assert model['feature_names_omitted'] == 976
    overview = tools.execute('get_project_overview', {})[0]
    assert 'DO_NOT_SEND' not in json.dumps([value, overview])
    assert 'C:/secret' not in json.dumps(value)


def test_run_catalog_discloses_bounded_scan_and_excludes_incomplete_records():
    jobs = {f'{i:032x}': job(f'{i:032x}', status='completed' if i % 2 else 'failed') for i in range(120)}
    tools = ProjectTools(Service(jobs))
    value = tools.execute('list_saved_runs', {'subsystem': None, 'limit': 3})[0]
    assert len(value['runs']) == 3 and all(item['status'] == 'completed' for item in value['runs'])
    assert value['total_saved_runs_all_statuses'] == 120 and value['saved_runs_scanned'] == 100
    assert value['older_runs_not_scanned'] == 20 and value['runs_omitted_from_scanned_window'] == 47
    assert all('reports' not in item and 'validation' not in item for item in value['runs'])


def test_search_is_allowlisted_ranked_bounded_and_versioned(tmp_path, monkeypatch):
    monkeypatch.setattr(project_tools, 'ROOT', tmp_path)
    (tmp_path / 'README.md').write_text('# Original brief\nIsolation Forest prototype.\n# Current ACV training\nCooling exceedance pairwise ranking.\n', encoding='utf-8')
    (tmp_path / 'docs').mkdir()
    (tmp_path / 'docs/ACV_MODEL_REVIEW.md').write_text('# ACV nested validation\nSix cases and four first choices in the nested audit.\n', encoding='utf-8')
    (tmp_path / '.env').write_text('ACV=DO_NOT_SEND_ENV', encoding='utf-8')
    (tmp_path / 'random.md').write_text('ACV=DO_NOT_SEND_RANDOM', encoding='utf-8')
    tools = ProjectTools(Service(), 'file', FIRST, 'file2.csv')
    value = tools.execute('search_project_knowledge', {'query': 'ACV nested validation', 'max_results': 1})[0]
    assert value['results'][0]['path'] == 'docs/ACV_MODEL_REVIEW.md'
    assert value['results'][0]['start_line'] == 1 and value['results'][0]['provenance'] == 'current ACV validation review'
    assert value['documents_available'] == 2
    assert 'DO_NOT_SEND' not in json.dumps(value)
    assert 'historical' in value['version_note']
    no_results = tools.execute('search_project_knowledge', {'query': 'unknown_unmatched_phrase', 'max_results': 2})[0]
    assert no_results['results'] == []


def test_search_does_not_follow_allowlisted_symlink_outside_project(tmp_path, monkeypatch):
    root = tmp_path / 'project'
    root.mkdir()
    private = tmp_path / 'private.md'
    private.write_text('Secret training data DO_NOT_SEND_LINK', encoding='utf-8')
    # Windows commonly lacks symlink privilege. Simulate the filesystem's
    # resolved target instead, exercising the production boundary check.
    (root / 'README.md').write_text('training allowed placeholder', encoding='utf-8')
    original_resolve = type(root).resolve
    def resolved(path, *args, **kwargs):
        if path == root / 'README.md':
            return private
        return original_resolve(path, *args, **kwargs)
    monkeypatch.setattr(type(root), 'resolve', resolved)
    monkeypatch.setattr(project_tools, 'ROOT', root)
    value = ProjectTools(Service()).execute('search_project_knowledge', {'query': 'training', 'max_results': 2})[0]
    assert value['results'] == [] and value['documents_available'] == 0


def test_actual_project_knowledge_answers_current_training_and_official_reference_queries():
    tools = ProjectTools(Service())
    value = tools.execute('search_project_knowledge', {'query': 'ACV nested validation', 'max_results': 4})[0]
    assert value['results'] and any('ACV' in item['path'] or 'acv.py' in item['path'] for item in value['results'])
    assert all(len(item['excerpt']) <= 2220 for item in value['results'])
    assert all(not item['path'].startswith(('C:', '/')) for item in value['results'])


def test_search_prefers_requested_subsystem_source_over_other_models(tmp_path, monkeypatch):
    monkeypatch.setattr(project_tools, 'ROOT', tmp_path)
    (tmp_path / 'backend/ps3').mkdir(parents=True)
    for subsystem in ('door', 'acv', 'rail', 'shm'):
        (tmp_path / f'backend/ps3/{subsystem}.py').write_text('def train():\n    # Fit model and validate training\n    pass\n', encoding='utf-8')
    value = ProjectTools(Service()).execute('search_project_knowledge', {'query': 'How was ACV trained', 'max_results': 2})[0]
    assert value['results'][0]['path'] == 'backend/ps3/acv.py'
