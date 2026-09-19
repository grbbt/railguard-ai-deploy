"""Allowlisted, read-only project retrieval for the investigation assistant.

The model chooses operations; Python enforces access and computes comparisons.
No tool accepts a filesystem path, fits an estimator, or reads raw telemetry.
"""
from __future__ import annotations

from collections import Counter
import math
from pathlib import Path
import re

from backend.ps3.agent_security import redact_data, redact_text, validate_tool_arguments

ROOT = Path(__file__).resolve().parents[2]
SUBSYSTEMS = ('door', 'acv', 'rail', 'shm')
KNOWLEDGE_FILES = (
    ('README.md', 'project brief and current implementation; historical sections are explicitly labelled'),
    ('docs/UNIFIED_WORKSPACE.md', 'current implementation'),
    ('docs/INVESTIGATION_AGENT.md', 'current project investigation capabilities and access limits'),
    ('docs/AI_SECURITY.md', 'implemented AI retrieval and prompt-injection defenses, tests and remaining limits'),
    ('docs/RESULT_SUMMARIES.md', 'current In brief result-summary implementation and its evidence boundaries'),
    ('docs/SUBMISSION_HOSTING_PLAN.md', 'proposed submission and hosting architecture; not a claim of deployed infrastructure'),
    ('docs/PS3_IMPLEMENTATION.md', 'current implementation'),
    ('docs/PS3_IMPLEMENTATION_CONTRACT.md', 'current API contract'),
    ('docs/PS3_RELEASE_REVIEW.md', 'release assessment'),
    ('docs/ACV_MODEL_REVIEW.md', 'current ACV validation review'),
    ('docs/NETWORK_DATA.md', 'map provenance; may describe the historical prototype'),
    ('docs/ROLLING_STOCK.md', 'illustration reference; historical six-car prototype, not recording identity'),
    ('data/ps3/PS3/01_Problem_Statement_3_Specifications.md', 'official pinned PS3 specification'),
    ('data/ps3/PS3/03_References/Door/Door_Subsystem_Info_Kit.md', 'official pinned Door reference'),
    ('data/ps3/PS3/03_References/Door/Door Data Headers.md', 'official pinned Door header reference'),
    ('data/ps3/PS3/03_References/ACV/ACV_Subsystem_Info_Kit.md', 'official pinned ACV reference'),
    ('data/ps3/PS3/03_References/Rail_Corrugation/Rail_Corrugation_Info_Kit.md', 'official pinned Rail reference'),
    ('data/ps3/PS3/03_References/SHM/SHM_Info_Kit.md', 'official pinned SHM reference'),
    ('backend/ps3/door.py', 'current local Door model implementation'),
    ('backend/ps3/acv.py', 'current local ACV model implementation'),
    ('backend/ps3/rail.py', 'current local Rail model implementation'),
    ('backend/ps3/shm.py', 'current local SHM model implementation'),
    ('scripts/train_ps3.py', 'current explicit training entry point'),
)

INTERPRETATION_LIMITS = {
    'validation': 'Local development validation is not official hidden-test performance or deployment accuracy.',
    'measurements': 'Measured features are descriptive; no computed feature contributions establish why a learned model chose an output.',
    'comparison': 'Compare recordings within this run. Anonymous file IDs do not establish the same physical asset, location, operating conditions or a time trend.',
    'safety': 'Predictions do not establish confirmed faults, calibrated failure probabilities, remaining life or authorised repair deadlines.',
}


def _text(value, limit=1000):
    if not isinstance(value, str):
        return None
    value = redact_text(value)
    return value if len(value) <= limit else value[:limit] + '… [text truncated]'


def _number(value):
    try:
        return value if type(value) in (int, float) and math.isfinite(value) else None
    except OverflowError:
        return None


def _bounded(value, depth=0):
    """Bound already allowlisted fields, preserving zero and excluding non-finite data."""
    if depth > 5:
        return '[nested details omitted]'
    if value is None or type(value) is bool:
        return value
    if isinstance(value, str):
        return _text(value)
    if type(value) in (int, float):
        return _number(value)
    if isinstance(value, list):
        result = [_bounded(item, depth + 1) for item in value[:24]]
        if len(value) > 24:
            result.append({'omitted_items': len(value) - 24})
        return result
    if isinstance(value, dict):
        items = list(value.items())[:30]
        return {str(key)[:100]: _bounded(item, depth + 1) for key, item in items
                if not re.search(r'path|secret|token|api.?key|source|sha256|password', str(key), re.I)}
    return None


def _pick(value, keys):
    return {key: _bounded(value[key]) for key in keys if key in value} if isinstance(value, dict) else {}


def _validation(value):
    if not isinstance(value, dict):
        return {'available': False, 'reason': 'No validation was retained for this model version.'}
    result = _pick(value, ('metric', 'score', 'method', 'mape', 'ranking_metrics', 'limitations',
                           'classification_at_exact_boundaries'))
    candidates = value.get('candidates', [])
    if isinstance(candidates, list):
        result['candidates'] = [_pick(item, ('name', 'score', 'ranking_metrics', 'mape', 'mae', 'rmse',
                                                     'fold_scores', 'confusion_matrix', 'per_class')) for item in candidates[:12]]
        result['candidates_omitted'] = max(0, len(candidates) - 12)
    folds = value.get('folds', [])
    if isinstance(folds, list) and folds:
        result['folds'] = [_pick(item, ('fold', 'file_id', 'score', 'true_car_rank', 'faulty_car', 'ranked_cars',
                                        'selected_model', 'training_actions', 'heldout_actions', 'true_actions',
                                        'detected_actions', 'segmentation', 'scores')) for item in folds[:12]]
        result['folds_omitted'] = max(0, len(folds) - 12)
    nested = value.get('nested_validation')
    if isinstance(nested, dict):
        result['nested_validation'] = _pick(nested, ('metric', 'score', 'method', 'ranking_metrics', 'limitations'))
        result['nested_validation']['note'] = 'Retrospective nested model-selection audit, distinct from the final fitted model.'
    result['official_hidden_test_score'] = None
    result['interpretation'] = INTERPRETATION_LIMITS['validation']
    return result


def _model(value):
    if not isinstance(value, dict):
        return {'available': False}
    result = _pick(value, ('subsystem', 'model_name', 'trained_at', 'training_files', 'training_rows',
                           'training_actions', 'artifact_version', 'feature_version', 'feature_count',
                           'class_order', 'class_counts', 'independent_groups', 'training_target_range',
                           'selected_model_features', 'selected_model_parameters', 'preprocessing', 'limitations'))
    features = value.get('feature_names', [])
    if isinstance(features, list):
        result['feature_names_preview'] = [_text(item, 150) for item in features[:24]]
        result['feature_names_total'] = len(features)
        result['feature_names_omitted'] = max(0, len(features) - 24)
    result.update(available=True, validation=_validation(value.get('validation')))
    return result


def _natural(value):
    return tuple((1, int(part)) if part.isdigit() else (0, part.casefold())
                 for part in re.split(r'(\d+)', str(value)))


def _rows(report):
    rows = report.get('prediction_rows')
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _list(value):
    return value if isinstance(value, list) else []


def _summary(report, subsystem):
    rows = _rows(report)
    result = {'file_id': _text(report.get('file_id'), 150), 'prediction_rows': len(rows),
              'model_name': _text(report.get('model_name'), 200),
              'warnings_count': len(_list(report.get('warnings'))),
              'evidence_count': len(_list(report.get('evidence')))}
    if subsystem == 'door':
        counts = Counter(row.get('prediction') for row in rows if isinstance(row.get('prediction'), str))
        result.update(total_actions=len(rows), normal_actions=counts['Normal'], abnormal_actions=counts['Abnormal resistance'],
                      other_actions=len(rows) - counts['Normal'] - counts['Abnormal resistance'])
    elif subsystem == 'acv':
        ranking = rows[0].get('ranked_cars') if rows else None
        cars = ranking.split('|') if isinstance(ranking, str) else []
        result['ranked_cars'] = cars[:16]
        result['ranked_cars_omitted'] = max(0, len(cars) - 16)
        result['first_ranked_car'] = cars[0] if cars else None
        entities = _list(report.get('entities'))
        result['unavailable_entities'] = [_text(entity.get('id'), 100) for entity in entities if
                                           isinstance(entity, dict) and entity.get('status') == 'unavailable'][:16]
        result['availability_note'] = 'Unavailable telemetry is unknown, not proof of health or fault; stable tail positions can be administrative.'
    elif subsystem == 'rail':
        result['predicted_class'] = rows[0].get('prediction') if rows and rows[0].get('prediction') in ('Normal', 'Side I', 'Side II') else None
    elif subsystem == 'shm':
        value = _number(rows[0].get('prediction')) if rows else None
        result['predicted_damage'] = value if value is not None and value >= 0 else None
    return result


def _aggregate(summaries, subsystem):
    base = {'files': len(summaries), 'files_with_warnings': sum(bool(item['warnings_count']) for item in summaries),
            'prediction_rows': sum(item['prediction_rows'] for item in summaries)}
    if subsystem == 'door':
        base.update({key: sum(item[key] for item in summaries) for key in ('total_actions', 'normal_actions', 'abnormal_actions', 'other_actions')})
    elif subsystem == 'acv':
        base['first_ranked_car_counts'] = dict(sorted(Counter(item['first_ranked_car'] for item in summaries if item['first_ranked_car']).items()))
        base['files_with_unavailable_entities'] = sum(bool(item['unavailable_entities']) for item in summaries)
        base['missing_predictions'] = sum(not item['ranked_cars'] for item in summaries)
    elif subsystem == 'rail':
        counts = Counter(item['predicted_class'] for item in summaries)
        base['class_counts'] = {label: counts[label] for label in ('Normal', 'Side I', 'Side II')}
        base['missing_predictions'] = counts[None]
    elif subsystem == 'shm':
        values = [item['predicted_damage'] for item in summaries if item['predicted_damage'] is not None]
        base['damage'] = {'count': len(values), 'minimum': min(values) if values else None,
                          'maximum': max(values) if values else None,
                          'mean': math.fsum(value / len(values) for value in values) if values else None}
        base['missing_predictions'] = len(summaries) - len(values)
    return base


def _schema(properties):
    return {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}


def _integer(low, high):
    return {'type': 'integer', 'minimum': low, 'maximum': high}


class ProjectTools:
    def __init__(self, service, scope='project', job_id=None, file_id=None):
        if scope not in ('project', 'run', 'file'):
            raise ValueError('Investigation scope must be project, run or file.')
        self.service, self.scope = service, scope
        self.job_id = self._job_id(job_id)
        self.file_id = self._file_id(file_id)
        if scope in ('run', 'file') and not self.job_id:
            raise ValueError('Select a saved run for this investigation scope.')
        if self.file_id and not self.job_id:
            raise ValueError('A selected file requires its saved run.')
        if scope == 'file' and not self.file_id:
            raise ValueError('Select a file for this investigation scope.')

    @staticmethod
    def _job_id(value):
        if value is not None and (not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32}', value)):
            raise ValueError('Use an exact saved run ID returned by list_saved_runs.')
        return value

    @staticmethod
    def _file_id(value):
        if value is not None and (not isinstance(value, str) or not value or len(value) > 150 or
                                  re.search(r'[/\\:\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]', value) or value in ('.', '..')):
            raise ValueError('Use an exact plain filename returned by compare_run_files.')
        return value

    def specs(self):
        nullable_job = {'type': ['string', 'null'], 'description': 'Exact saved run ID, or null for the selected run.'}
        return [
            {'name': 'get_project_overview', 'description': 'Read current project capabilities, available trained models, selected context and saved-run coverage. Start here for general project questions.', 'input_schema': _schema({})},
            {'name': 'search_project_knowledge', 'description': 'Search an explicit local allowlist of project guides, official pinned PS3 references and training/preprocessing source. Returns bounded ranked excerpts with provenance. No network search or arbitrary files.',
             'input_schema': _schema({'query': {'type': 'string', 'minLength': 2, 'maxLength': 400}, 'max_results': _integer(1, 8)})},
            {'name': 'list_saved_runs', 'description': 'Discover completed saved runs accessible within the chosen scope. A bounded newest-run window is disclosed; filenames and raw telemetry are not returned.',
             'input_schema': _schema({'subsystem': {'type': ['string', 'null'], 'enum': [*SUBSYSTEMS, None]}, 'limit': _integer(1, 30)})},
            {'name': 'compare_run_files', 'description': 'Compute aggregate results for every accessible file of one completed run, then return a sorted/searchable page of per-file predictions. Aggregates always describe the whole accessible run, independent of query and pagination. This is descriptive comparison, not accuracy.',
             'input_schema': _schema({'job_id': nullable_job, 'offset': _integer(0, 100), 'limit': _integer(1, 30),
                                      'sort': {'type': 'string', 'enum': ['filename', 'result', 'value-desc', 'value-asc']},
                                      'query': {'type': ['string', 'null'], 'maxLength': 150}})},
            {'name': 'inspect_recording', 'description': 'Read a retained file prediction, measured evidence, entities, warnings, downsampled signal previews and validation attached to that saved run. Page Door action rows with prediction_offset. Required for file-specific diagnostic claims.',
             'input_schema': _schema({'job_id': nullable_job,
                                      'file_id': {'type': ['string', 'null'], 'description': 'Exact retained filename or null for the selected file.'},
                                      'prediction_offset': _integer(0, 100000), 'prediction_limit': _integer(1, 80)})},
            {'name': 'get_model_details', 'description': 'Read current fitted model metadata, preprocessing, feature overview, local candidate validation and the separate nested ACV selection audit. Saved predictions may use an older model; inspect_recording returns their retained validation.',
             'input_schema': _schema({'subsystem': {'type': 'string', 'enum': list(SUBSYSTEMS)}})},
        ]

    def _validate(self, name, args):
        spec = next((item for item in self.specs() if item['name'] == name), None)
        if spec is None:
            raise ValueError('Unknown project investigation tool.')
        validate_tool_arguments(spec['input_schema'], args)
        if 'job_id' in args:
            self._job_id(args['job_id'])
        if 'file_id' in args:
            self._file_id(args['file_id'])

    def _job(self, job_id=None):
        target = self._job_id(job_id) or self.job_id
        if not target:
            raise ValueError('Choose a saved run from list_saved_runs before reading its recordings.')
        if self.scope in ('run', 'file') and target != self.job_id:
            raise ValueError('That run is outside this investigation scope.')
        job = self.service.get(target)
        if not isinstance(job, dict) or job.get('id') != target or job.get('subsystem') not in SUBSYSTEMS:
            raise ValueError('The saved run identity or subsystem is invalid.')
        if job.get('status') != 'completed':
            raise ValueError('Only completed saved runs have investigation evidence.')
        return job

    def _reports(self, job):
        reports = job.get('reports', [])
        if not isinstance(reports, list):
            raise ValueError('The saved run has no readable reports.')
        if len(reports) > 100:
            raise ValueError('The saved run exceeds the supported 100-file batch limit.')
        reports = [report for report in reports if isinstance(report, dict)]
        if self.scope == 'file':
            reports = [report for report in reports if report.get('file_id') == self.file_id]
            if not reports:
                raise ValueError('The selected file is not retained in this saved run.')
        return reports

    def context(self):
        result = {'scope': self.scope, 'current_job_id': self.job_id, 'current_file_id': self.file_id,
                  'access': {'file': 'Only the selected recording; general project documents and model metadata remain available.',
                             'run': 'Recordings in the selected saved run; general project documents and model metadata remain available.',
                             'project': 'All completed saved runs plus allowlisted project knowledge and model metadata.'}[self.scope]}
        if self.job_id:
            try:
                job = self._job()
                reports = self._reports(job)
                result['selected_subsystem'] = job['subsystem']
                result['selected_run_accessible_files'] = len(reports)
                result['selected_file_available'] = bool(self.file_id and any(report.get('file_id') == self.file_id for report in reports))
            except (KeyError, ValueError, OSError):
                result['selection_unavailable'] = True
        return result

    @staticmethod
    def _run_summary(job, file_scope=False):
        result = _pick(job, ('id', 'subsystem', 'status', 'source', 'created_at', 'finished_at', 'model_name', 'model_trained_at'))
        count = job.get('file_count')
        if count is None:
            count = len(job.get('reports', []))
        result['accessible_file_count'] = 1 if file_scope else count
        return result

    def _runs(self, subsystem=None, limit=30):
        if self.scope != 'project':
            job = self._job()
            self._reports(job)
            matches = subsystem is None or subsystem == job['subsystem']
            return {'runs': [self._run_summary(job, self.scope == 'file')] if matches else [],
                    'completed_runs_in_scope': int(matches), 'runs_omitted': 0,
                    'coverage': 'The selected run only; no other saved runs were accessed.'}
        library = self.service.list_jobs(limit=100, subsystem=subsystem)
        window = library.get('jobs', [])
        completed = [job for job in window if isinstance(job, dict) and job.get('status') == 'completed']
        total = library.get('total', len(window))
        return {'runs': [self._run_summary(job) for job in completed[:limit]],
                'completed_runs_in_scanned_window': len(completed), 'runs_omitted_from_scanned_window': max(0, len(completed) - limit),
                'total_saved_runs_all_statuses': total, 'saved_runs_scanned': len(window),
                'older_runs_not_scanned': max(0, total - len(window)),
                'coverage': 'Newest 100 saved runs at most. Only completed runs are listed; totals include all statuses where stated.'}

    def execute(self, name, args):
        data, label, location = self._execute(name, args)
        return redact_data(data), redact_text(label), redact_text(location) if location else None

    def _execute(self, name, args):
        self._validate(name, args)
        if name == 'get_project_overview':
            status = self.service.status()
            models = []
            for subsystem in status.get('subsystems', []):
                item = _pick(subsystem, ('id', 'title', 'task', 'metric', 'available', 'example_files'))
                model = subsystem.get('model') or {}
                item['model'] = _pick(model, ('model_name', 'trained_at', 'training_files', 'training_rows'))
                item['local_validation'] = _pick(model.get('validation'), ('metric', 'score', 'method'))
                models.append(item)
            return {'context': self.context(), 'models': models, 'saved_run_catalog': self._runs(limit=8),
                    'workflow': 'Frozen Python models analyse recordings. Evidence and numerical comparisons are computed locally. The AI retrieves bounded summaries and project references; it cannot change predictions or retrain.',
                    'interface': 'One workspace: fleet overview, recordings and analysis, component view, investigation, model validation, prediction exports.',
                    'architecture': {'frontend': 'Next.js and React web interface; Three.js component views and a glass geographic map.',
                                     'backend': 'Python/FastAPI; dedicated PS3 loaders, frozen trained models, computed evidence and persisted local jobs.',
                                     'ai': 'Optional OpenAI Responses tool loop selects read-only retrieval and comparison tools; Python computes numerical results.'},
                    'provenance': 'The glass map is static Singapore geographic context; PS3 recordings do not establish Singapore train identity or live position.',
                    'input_limits': _pick(status.get('limits'), ('file_mb', 'batch_files', 'batch_mb')),
                    'interpretation_limits': INTERPRETATION_LIMITS}, 'Project overview and accessible saved-run catalog', 'docs/UNIFIED_WORKSPACE.md'
        if name == 'list_saved_runs':
            return {'scope': self.scope, **self._runs(**args)}, 'Accessible completed saved runs', None
        if name == 'get_model_details':
            return {'subsystem': args['subsystem'], 'current_model': _model(self.service.model(args['subsystem'])),
                    'version_note': 'Current artifact metadata. Use inspect_recording for the validation retained with an older saved run.'}, f"{args['subsystem'].upper()} fitted model and validation", None
        if name == 'compare_run_files':
            return self._compare(**args), 'Deterministic saved-run comparison', None
        if name == 'inspect_recording':
            data = self._inspect(**args)
            return data, f"Recording evidence: {data['file_id']}", None
        if name == 'search_project_knowledge':
            return self._search(**args), 'Allowlisted project documentation and source excerpts', None
        raise ValueError('Unknown project investigation tool.')

    def _compare(self, job_id, offset, limit, sort, query):
        job = self._job(job_id)
        items = [_summary(report, job['subsystem']) for report in self._reports(job)]
        aggregate = _aggregate(items, job['subsystem'])
        if query:
            query = query.strip().casefold()
            items = [item for item in items if query in (item['file_id'] or '').casefold()]
        items.sort(key=lambda item: _natural(item['file_id']))
        if sort == 'result' and job['subsystem'] == 'shm':
            items.sort(key=lambda item: (item['predicted_damage'] is None, -(item['predicted_damage'] or 0)))
        elif sort == 'result':
            items.sort(key=lambda item: (str(item.get('predicted_class') or item.get('first_ranked_car') or ''),
                                         -(item.get('abnormal_actions') or 0)))
        elif sort in ('value-desc', 'value-asc'):
            key = 'predicted_damage' if job['subsystem'] == 'shm' else 'abnormal_actions' if job['subsystem'] == 'door' else None
            if key is None:
                raise ValueError('Numeric result ordering is available for SHM damage and Door abnormal-action counts only.')
            descending = sort == 'value-desc'
            items.sort(key=lambda item: (item.get(key) is None, (-item[key] if descending else item[key]) if item.get(key) is not None else 0))
        page = items[offset:offset + limit]
        return {'job_id': job['id'], 'subsystem': job['subsystem'], 'source': job.get('source'), 'scope': self.scope,
                'aggregate_scope': 'All accessible files in this run, before filename search or pagination.',
                'aggregate': aggregate, 'files': page, 'matching_files': len(items), 'offset': offset,
                'files_included': len(page), 'matching_files_omitted': len(items) - len(page),
                'next_offset': offset + len(page) if offset + len(page) < len(items) else None,
                'query': query, 'sort': sort, 'interpretation_limits': INTERPRETATION_LIMITS}

    def _inspect(self, job_id, file_id, prediction_offset, prediction_limit):
        job = self._job(job_id)
        target = self._file_id(file_id)
        if target is None and job['id'] == self.job_id:
            target = self.file_id
        reports = self._reports(job)
        if target is None and len(reports) == 1:
            target = reports[0].get('file_id')
        if self.scope == 'file' and target != self.file_id:
            raise ValueError('That file is outside this investigation scope.')
        report = next((item for item in reports if item.get('file_id') == target), None)
        if report is None:
            raise ValueError('Select an exact retained filename from compare_run_files.')
        rows = _rows(report)
        row_keys = {'door': ('start_time', 'end_time', 'prediction'), 'acv': ('file_id', 'ranked_cars'),
                    'rail': ('file_id', 'prediction'), 'shm': ('file_id', 'prediction')}[job['subsystem']]
        evidence, entities, warnings = (_list(report.get(key)) for key in ('evidence', 'entities', 'warnings'))
        series = _list(report.get('series'))
        previews = []
        for signal in series[:8]:
            if not isinstance(signal, dict):
                continue
            points = _list(signal.get('points'))
            values = [_number(point.get('y')) for point in points if isinstance(point, dict)]
            numeric = [value for value in values if value is not None]
            indexes = sorted({round(index * (len(points) - 1) / 11) for index in range(12)}) if points else []
            previews.append({**_pick(signal, ('name', 'x_label', 'y_label')), 'preview_points_total': len(points),
                             'preview_min': min(numeric) if numeric else None, 'preview_max': max(numeric) if numeric else None,
                             'sampled_points': [_pick(points[index], ('x', 'y')) for index in indexes],
                             'preview_points_omitted': len(points) - len(indexes)})
        selected = rows[prediction_offset:prediction_offset + prediction_limit]
        return {'job_id': job['id'], 'subsystem': job['subsystem'], 'source': job.get('source'), 'file_id': target,
                'model_name': _text(report.get('model_name'), 200), 'summary': _text(report.get('summary'), 1600),
                'prediction_summary': _summary(report, job['subsystem']),
                'prediction_rows': [_pick(row, row_keys) for row in selected],
                'evidence': [_pick(item, ('id', 'label', 'value', 'unit', 'detail', 'source')) for item in evidence[:40]],
                'entities': [_pick(item, ('id', 'label', 'value', 'status', 'detail')) for item in entities[:20]],
                'warnings': [_text(item) for item in warnings[:16]], 'signal_previews': previews,
                'preview_note': 'Downsampled display points only, not the complete waveform. Use computed evidence for full-recording metrics.',
                'coverage': {'prediction_rows_total': len(rows), 'prediction_offset': prediction_offset,
                             'prediction_rows_included': len(selected), 'prediction_rows_omitted': len(rows) - len(selected),
                             'next_prediction_offset': prediction_offset + len(selected) if prediction_offset + len(selected) < len(rows) else None,
                             'evidence_total': len(evidence), 'evidence_omitted': max(0, len(evidence) - 40),
                             'entities_total': len(entities), 'entities_omitted': max(0, len(entities) - 20),
                             'warnings_total': len(warnings), 'warnings_omitted': max(0, len(warnings) - 16),
                             'signals_total': len(series), 'signals_omitted': max(0, len(series) - 8)},
                'saved_model_trained_at': job.get('model_trained_at'), 'saved_validation': _validation(job.get('validation')),
                'interpretation_limits': INTERPRETATION_LIMITS}

    def _search(self, query, max_results):
        tokens = set(re.findall(r'[a-z0-9_]{2,}', query.casefold())) - {'the', 'and', 'for', 'how', 'what', 'does', 'this', 'that', 'our', 'with', 'are', 'can'}
        if not tokens:
            raise ValueError('Use specific project terms in the knowledge query.')
        # Preserve specific query terms, while covering common project vocabulary
        # variations without embeddings, network retrieval, or invented facts.
        for equivalents in ({'train', 'trained', 'training'}, {'api', 'apis'}, {'map', 'maps'},
                            {'door', 'doors'}, {'predict', 'predicted', 'prediction', 'predictions'},
                            {'row', 'rows'}, {'movement', 'movements', 'action', 'actions'},
                            {'segment', 'segments', 'segmentation'}):
            if tokens.intersection(equivalents):
                tokens.update(equivalents)
        requested_subsystems = tokens.intersection(SUBSYSTEMS)
        matches, available, unavailable = [], 0, 0
        root = ROOT.resolve()
        for relative, provenance in KNOWLEDGE_FILES:
            path = root / relative
            # An allowlisted pathname must still resolve to that exact local file,
            # so replacing a document with a symlink never expands access.
            try:
                if (Path(relative).is_absolute() or not path.is_relative_to(root) or path.suffix not in {'.md', '.py'} or
                    path.resolve() != path or not path.is_file() or path.stat().st_size > 300_000):
                    unavailable += 1
                    continue
                content = path.read_text(encoding='utf-8-sig')
            except (OSError, UnicodeError, RuntimeError):
                unavailable += 1
                continue
            available += 1
            lines = content.splitlines()
            current_readme_line = next((index for index, line in enumerate(lines) if line.startswith('## Unified workspace')), 0)
            heading, section_start = relative, 0
            sections = []
            for index, line in enumerate(lines):
                if re.match(r'^#{1,6}\s|^(?:async\s+)?def\s|^class\s', line):
                    if index > section_start:
                        sections.append((heading, section_start, index))
                    heading, section_start = line.lstrip('# ').strip()[:160], index
            sections.append((heading, section_start, len(lines)))
            for heading, start, end in sections:
                # Overlap short chunks so a term at a paragraph boundary remains retrievable.
                for chunk_start in range(start, end, 22):
                    chunk_end = min(end, chunk_start + 28)
                    text = '\n'.join(lines[chunk_start:chunk_end])
                    haystack = (relative + ' ' + heading + ' ' + text).casefold()
                    hit = [token for token in tokens if re.search(r'(?<![a-z0-9])' + re.escape(token) + r'(?![a-z0-9])', haystack)]
                    if not hit:
                        continue
                    score = sum(2 + min(3, haystack.count(token)) + (4 if token in heading.casefold() else 0) for token in hit)
                    score += 2 * len(hit) / len(tokens)
                    path_subsystems = set(re.findall(r'[a-z]+', relative.casefold())).intersection(SUBSYSTEMS)
                    if requested_subsystems.intersection(path_subsystems):
                        score += 12
                    elif requested_subsystems and path_subsystems:
                        score *= .35
                    if relative.endswith('.py') and not tokens.intersection({'code', 'train', 'training', 'fit', 'preprocessing', 'feature', 'features', 'segmentation', 'model'}):
                        score *= .6
                    chunk_provenance = provenance
                    if relative == 'README.md' and chunk_start < current_readme_line:
                        chunk_provenance = 'historical initial project proposal; not a claim of current implementation'
                        score *= .65
                    if relative == 'docs/PS3_RELEASE_REVIEW.md' and re.search(r'implement next|must change', heading, re.I):
                        chunk_provenance = 'historical release-integration plan; inspect current implementation before describing present behavior'
                    matches.append((score, relative, chunk_start, {'path': relative, 'heading': heading,
                                  'start_line': chunk_start + 1, 'end_line': chunk_end, 'provenance': chunk_provenance,
                                  'excerpt': _text(text, 2200), 'excerpt_truncated': len(text) > 2200}))
        matches.sort(key=lambda item: (-item[0], item[1], item[2]))
        chosen, used = [], set()
        for _, path, start, item in matches:
            # Avoid returning overlapping snippets that crowd out other evidence.
            if any(old_path == path and abs(old_start - start) < 22 for old_path, old_start in used):
                continue
            chosen.append(item)
            used.add((path, start))
            if len(chosen) >= max_results:
                break
        return {'query': query, 'results': chosen, 'matching_chunks': len(matches),
                'matching_chunks_omitted': max(0, len(matches) - len(chosen)),
                'documents_available': available, 'documents_unavailable': unavailable,
                'coverage': 'Bounded excerpts from an explicit local allowlist; no web access, raw dataset files, secret configuration or arbitrary repository traversal.',
                'version_note': 'README preserves an initial Isolation Forest/Streamlit brief. Current PS3 implementation and fitted model metadata describe the released-data system; historical map and six-car notes do not establish recording identity.'}
