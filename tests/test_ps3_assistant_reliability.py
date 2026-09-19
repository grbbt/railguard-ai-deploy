import json

import httpx
import pytest

from backend.ps3.assistant import CAUSAL_ATTRIBUTION, _execute, investigate, local_answer


REPORT = {'subsystem': 'rail', 'file_id': 'Test.csv', 'summary': 'Model predicts Normal.',
          'prediction_rows': [{'file_id': 'Test.csv', 'prediction': 'Normal'}], 'evidence': [], 'warnings': []}


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    # Provider tests must not consult the user's local configuration.
    monkeypatch.setattr('backend.ps3.assistant._settings', lambda: {
        'enabled': True, 'key': 'private-test-key-not-for-output', 'model': 'mock-investigator',
    })


@pytest.mark.parametrize('status,expected', [(401, 'key'), (403, 'access'), (429, 'billing'), (404, 'model'), (503, 'retry')])
def test_provider_error_is_actionable_without_disclosing_response(status, expected):
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(status, json={'error': 'private-test-key-not-for-output'}))) as client:
        result = investigate(REPORT, {}, 'Explain this result', client)
    assert result['mode'] == 'local'
    assert expected in result['warning']
    assert 'private-test-key' not in json.dumps(result)


@pytest.mark.parametrize('payload', [[], None, {'output': 'invalid'}, {'output': [None]},
    {'output': [{'type': 'message', 'content': 'invalid'}]},
    {'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': {}}]}]},
    {'output': [{'type': 'function_call', 'call_id': None, 'name': 'get_prediction_evidence', 'arguments': '{}'}]}])
def test_malformed_provider_response_preserves_local_findings(payload):
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload))) as client:
        result = investigate(REPORT, {}, 'Explain this result', client)
    assert result['mode'] == 'local' and 'Model predicts Normal' in result['answer']


def test_timeout_has_honest_recovery_message():
    def timeout(request):
        raise httpx.ReadTimeout('private-test-key-not-for-output', request=request)
    with httpx.Client(transport=httpx.MockTransport(timeout)) as client:
        result = investigate(REPORT, {}, 'Explain this result', client)
    assert result['mode'] == 'local' and 'timed out' in result['warning']
    assert 'private-test-key' not in json.dumps(result)


def test_network_restriction_explains_connection_recovery_without_private_error():
    def unavailable(request):
        raise httpx.ConnectError('private-test-key-not-for-output', request=request)
    with httpx.Client(transport=httpx.MockTransport(unavailable)) as client:
        result = investigate(REPORT, {}, 'Explain this result', client)
    assert result['mode'] == 'local'
    assert 'network restrictions' in result['warning']
    assert 'narrower question' not in result['warning']
    assert 'private-test-key' not in json.dumps(result)


def test_evidence_tool_discloses_when_large_reports_are_summarized():
    large = {**REPORT, 'prediction_rows': REPORT['prediction_rows'] * 130, 'entities': [{'id': str(i)} for i in range(25)]}
    evidence, _, _ = _execute('get_prediction_evidence', large, {})
    assert len(evidence['prediction_rows']) == 120 and len(evidence['entities']) == 16
    assert evidence['coverage']['prediction_rows_total'] == 130
    assert evidence['coverage']['entities_total'] == 25
    assert 'omitted items' in evidence['coverage']['note']


def test_prediction_evidence_allowlist_excludes_private_extras_and_nonfinite_values():
    report = {**REPORT,
              'prediction_rows': [None, {'file_id': 'Test.csv', 'prediction': float('nan'),
                                         'private_path': 'DO_NOT_SEND_ROW'}],
              'evidence': [None, {'id': 'measured', 'value': 0, 'source': 'Test.csv / full recording',
                                  'detail': {'note': 'Retained observation', 'api_key': 'DO_NOT_SEND_NESTED'},
                                  'raw_samples': ['DO_NOT_SEND_EVIDENCE']}],
              'entities': ['invalid', {'id': 'car-01', 'value': float('inf'), 'secret': 'DO_NOT_SEND_ENTITY'}],
              'warnings': [None] + ['Review limitations.'] * 20,
              'raw_waveform': ['DO_NOT_SEND_REPORT']}
    result, _, source_id = _execute('get_prediction_evidence', report, {})
    assert source_id == 'E1'
    assert result['prediction_rows'] == [{'file_id': 'Test.csv', 'prediction': None}]
    assert result['evidence'][0]['value'] == 0
    assert result['evidence'][0]['source'] == 'Test.csv / full recording'
    assert result['evidence'][0]['detail'] == {'note': 'Retained observation'}
    assert result['entities'] == [{'id': 'car-01', 'value': None}]
    assert len(result['warnings']) == 16 and result['coverage']['warnings_omitted'] == 4
    assert all(result['coverage'][f'{field}_invalid'] == 1 for field in
               ('prediction_rows', 'evidence', 'entities', 'warnings'))
    assert 'DO_NOT_SEND' not in json.dumps(result, allow_nan=False)


def test_legacy_evidence_and_signal_tools_handle_missing_optional_arrays():
    report = {'file_id': 'empty.csv', 'summary': None, 'prediction_rows': None,
              'evidence': None, 'entities': None, 'warnings': None, 'series': None}
    evidence, _, _ = _execute('get_prediction_evidence', report, {})
    assert all(evidence[field] == [] for field in ('prediction_rows', 'evidence', 'entities', 'warnings'))
    assert evidence['coverage']['prediction_rows_total'] == 0
    signal, _, _ = _execute('get_signal_summary', report, {})
    assert signal['series'] == [] and signal['coverage']['signals_total'] == 0


def test_legacy_signal_summary_bounds_previews_and_filters_point_extras():
    points = [{'x': index, 'y': index, 'private_path': 'DO_NOT_SEND_POINT'} for index in range(25)]
    points[0]['x'] = float('nan')
    points[2]['y'] = float('inf')
    signal = {'name': 'Measured wave', 'x_label': 'Sample', 'y_label': 'Raw units',
              'points': [None, *points], 'raw_waveform': ['DO_NOT_SEND_SIGNAL']}
    result, _, source_id = _execute('get_signal_summary', {**REPORT, 'series': [None, *([signal] * 14)]}, {})
    assert source_id == 'S1' and len(result['series']) == 12
    assert result['coverage'] == {'signals_total': 14, 'signals_omitted': 2, 'signals_invalid': 1}
    summary = result['series'][0]
    assert summary['preview_min'] == 0 and summary['preview_max'] == 24
    assert summary['preview_points'] == 25 and summary['preview_points_invalid'] == 1
    assert summary['preview_points_omitted'] == 13
    assert len(summary['selected_preview_points']) == 12
    assert summary['selected_preview_points'][0] == {'x': None, 'y': 0}
    assert summary['selected_preview_points'][-1] == {'x': 24, 'y': 24}
    assert any(point['y'] is None for point in summary['selected_preview_points'])
    assert 'DO_NOT_SEND' not in json.dumps(result, allow_nan=False)
    empty, _, _ = _execute('get_signal_summary', {**REPORT, 'series': [{'name': 'Missing', 'points': None}]}, {})
    assert empty['series'][0]['preview_min'] is None and empty['series'][0]['selected_preview_points'] == []


def test_legacy_validation_uses_bounded_allowlist_and_preserves_nested_audit():
    validation = {
        'score': 0, 'metric': 'Rank-decay', 'method': 'Held-out groups',
        'candidates': [{'name': f'Candidate {index}', 'score': 0, 'secret': 'DO_NOT_SEND_CANDIDATE',
                        'fold_scores': [0] * 30} for index in range(14)],
        'folds': [{'fold': index, 'score': 0, 'private_path': 'DO_NOT_SEND_PATH',
                   'training_files': ['DO_NOT_SEND_MANIFEST']} for index in range(30)],
        'nested_validation': {'score': .5, 'ranking_metrics': {'top1_correct': 4, 'cases': 6},
                              'folds': [{'secret': 'DO_NOT_SEND_NESTED_FOLD'}]},
    }
    payload, _, source_id = _execute('get_validation_results', REPORT, validation)
    result = payload['local_validation']
    assert source_id == 'V1' and result['score'] == 0
    assert len(result['candidates']) == 12 and result['candidates_omitted'] == 2
    assert len(result['folds']) == 12 and result['folds_omitted'] == 18
    assert result['candidates'][0]['fold_scores'][-1] == {'omitted_items': 6}
    assert result['nested_validation']['ranking_metrics']['top1_correct'] == 4
    assert 'DO_NOT_SEND' not in json.dumps(payload)


def test_legacy_validation_reports_missing_metadata_without_failure():
    result, _, _ = _execute('get_validation_results', REPORT, None)
    assert result['local_validation']['available'] is False


@pytest.mark.parametrize('score', [None, '0.8', {}, True, float('nan'), float('inf'), -0.1, 1.1])
def test_local_fallback_does_not_format_invalid_validation_as_a_score(score):
    result = local_answer(REPORT, {'score': score, 'metric': None})
    assert result['mode'] == 'local'
    assert 'Local validation:' not in result['answer']
    assert [source['id'] for source in result['sources']] == ['E1']


def test_local_fallback_keeps_zero_and_skips_malformed_optional_evidence():
    report = {**REPORT, 'summary': None,
              'evidence': [None, {'label': None, 'value': float('nan'), 'unit': {}},
                           {'label': 'Measured count', 'value': 0, 'unit': 'actions'}],
              'warnings': [None, 42, 'Review the retained source.']}
    result = local_answer(report, {'metric': 'Macro F1', 'score': 0})
    assert 'summary is unavailable' in result['answer']
    assert 'Evidence: Unavailable.' in result['answer']
    assert 'Measured count: 0 actions.' in result['answer']
    assert 'Macro F1 = 0.0000' in result['answer']
    assert 'Review the retained source.' in result['answer']
    assert [source['id'] for source in result['sources']] == ['E1', 'V1']


def test_provider_failure_can_recover_with_null_optional_saved_fields():
    report = {**REPORT, 'summary': None, 'evidence': None, 'warnings': None}
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(503))) as client:
        result = investigate(report, None, 'Explain this result', client)
    assert result['mode'] == 'local' and 'retry' in result['warning']
    assert 'summary is unavailable' in result['answer']


def test_tool_loop_stops_when_overall_time_budget_is_spent(monkeypatch):
    times = iter([0, 0, 0, 61])
    monkeypatch.setattr('backend.ps3.assistant.monotonic', lambda: next(times))
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={'output': [{'type': 'function_call', 'call_id': 'first',
            'name': 'get_prediction_evidence', 'arguments': '{}'}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = investigate(REPORT, {}, 'Explain this result', client)
    assert len(calls) == 1
    assert result['mode'] == 'local' and 'timed out' in result['warning']


@pytest.mark.parametrize('corrected', [True, False])
def test_unsupported_feature_attribution_is_corrected_once_or_falls_back(corrected):
    requests = []
    unsupported = 'Car 01 is ranked first because its measured cooling residual is larger. [E1]'
    grounded = 'Car 01 ranks first. Its measured residual is larger than Car 02. Feature contributions are unavailable. [E1]'
    def handler(request):
        requests.append(json.loads(request.content))
        if len(requests) == 1:
            output = [{'type': 'function_call', 'call_id': 'evidence', 'name': 'get_prediction_evidence', 'arguments': '{}'}]
        else:
            answer = grounded if corrected and len(requests) == 3 else unsupported
            output = [{'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': answer}]}]
        return httpx.Response(200, json={'output': output})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = investigate(REPORT, {}, 'Why did the model choose this?', client)
    assert len(requests) == 3
    assert result['mode'] == ('agent' if corrected else 'local')
    assert unsupported not in result['answer']
    if corrected:
        assert result['answer'] == grounded


@pytest.mark.parametrize('answer,blocked', [
    ('The predicted class is driven by RMS. [E1]', True),
    ('Higher current explains the classification. [E1]', True),
    ('Because of the current, it ranks first. [E1]', True),
    ('The model cannot establish a leak because labels are unverified. [E1]', False),
    ('The model was selected because its saved validation score was highest. [V1]', False),
    ('We cannot say why the model ranked it first. [E1]', False),
])
def test_attribution_guard_distinguishes_outputs_from_validation_and_uncertainty(answer, blocked):
    assert bool(CAUSAL_ATTRIBUTION.search(answer)) is blocked
