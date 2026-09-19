"""Brief, grounded result wording; exact prediction facts remain server-owned."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
import hashlib
import json
import math
import re

import httpx

from backend.ps3.assistant import _settings
from backend.ps3.service import validate_predictions

SUMMARY_VERSION = 'result-summary-v2-measurements-and-runs'
SUMMARY_TIMEOUT_SECONDS = 8.
_MAX_CACHE = 128
_MAX_REQUESTS = 2
_MAX_FILES = 100
_MAX_WORDS = 65
_CONTEXT = {
    'door': 'Opening or closing actions classified from current, voltage, back-EMF and door-position recordings. Review action boundaries and recorded signals; the classification does not establish a mechanical cause.',
    'acv': 'Car-level inspection ranking from usable cabin/cooling-target and operating-state evidence. The first rank is not a verified refrigerant leak. Missing cooling evidence means condition is unknown.',
    'rail': 'Whole-recording Normal, Side I or Side II classification from axle-box vibration and shock. This is a rail-side model output, not a verified local defect or vehicle diagnosis.',
    'shm': 'Cumulative fatigue damage estimate from the recorded stress waveform. It is not a percentage, fault probability or remaining lifetime. No physical stress calibration or elapsed duration is established.',
}
_REVIEW_TERMS = {
    'door': r'\b(?:action|actions|boundar\w*|current|position|record\w*|signal\w*)\b',
    'acv': r'\b(?:car|cooling|cabin|temperature|ranking|record\w*|measurement\w*)\b',
    'rail': r'\b(?:rail|vibration|shock|record\w*|signal\w*)\b',
    'shm': r'\b(?:stress|cycle\w*|damage|record\w*|waveform)\b',
}
# Conservative wording checks, not a general factual verifier. Exact numbers and
# labels never come from the language model, and its second sentence is a review
# suggestion only. Rejected wording leaves the ordinary local summary intact.
_UNSUPPORTED = re.compile(
    r'\d|[%°]|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|'
    r'sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|'
    r'evidence|percent\w*|probabilit\w*|confidence|certain\w*|definit\w*|confirm\w*|proven|verif\w*|guarantee\w*|'
    r'safe\w*|unsafe|urgent\w*|immediat\w*|critical|severe\w*|high|low|elevated|excessive|'
    r'worsen\w*|increas\w*|decreas\w*|health\w*|normal|abnormal|'
    r'because|cause\w*|causal\w*|indicat\w*|prove\w*|diagnos\w*|'
    r'replace\w*|repair\w*|grind\w*|lubricat\w*|obstruction|jamming|wear|broken|'
    r'hours?|days?|weeks?|months?|years?|volts?|amperes?|degrees?|kilomet\w*)\b|'
    r'\b(?:due to|driven by|root cause|will fail|remaining life|remaining useful life|risk level|Side I|Side II)\b',
    re.IGNORECASE,
)


def _measurement(report: dict, identifier: str, unit: str, *, nonnegative=False):
    """Accept only one known numeric measurement; never copy labels/details/units."""
    items = report.get('evidence')
    if not isinstance(items, list):
        return None
    matches = [item for item in items if isinstance(item, dict) and item.get('id') == identifier]
    if len(matches) != 1 or matches[0].get('unit') != unit:
        return None
    value = matches[0].get('value')
    try:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return None
        if nonnegative and value < 0:
            return None
    except OverflowError:
        return None
    return value


def _number(value):
    return f'{value:.6g}'


def _range(values):
    lower, upper = min(values), max(values)
    return _number(lower) if lower == upper else f'{_number(lower)}–{_number(upper)}'


def _files(count):
    return f'{count} file' + ('' if count == 1 else 's')


def _measured_facts(report, subsystem, facts):
    measured = {}
    if subsystem == 'door':
        actions = []
        for index, row in enumerate(report['prediction_rows'], 1):
            if row['prediction'] != 'Abnormal resistance':
                continue
            current = _measurement(report, f'door-action-{index}-current', 'mA', nonnegative=True)
            duration = _measurement(report, f'door-action-{index}-duration', 'seconds', nonnegative=True)
            if current is not None:
                actions.append({'action': index, 'peak_absolute_current_ma': current, 'duration_s': duration})
        if actions:
            measured['flagged_actions'] = actions
            first = actions[0]
            text = f'Flagged movement {first["action"]}: peak motor current about {_number(first["peak_absolute_current_ma"])} mA'
            return measured, text + (f' over about {_number(first["duration_s"])} s.' if first['duration_s'] is not None else '.')
        cadence = _measurement(report, 'door-cadence', 'seconds', nonnegative=True)
        if cadence is not None and cadence > 0:
            return {'median_sample_interval_s': cadence}, f'Median sampling interval: about {_number(cadence)} s.'
    elif subsystem == 'acv' and facts['cars_with_usable_cooling_readings'] != 0:
        value = _measurement(report, f'acv-car-{facts["first_car"]}', 'raw temperature units')
        if value is not None:
            return {'first_car_median_cabin_minus_target': value}, f'Median cabin temperature minus target: about {_number(value)} raw temperature units.'
    elif subsystem == 'rail':
        for side in (1, 2):
            value = _measurement(report, f'rail-side-{side}-vibration', 'm/s²', nonnegative=True)
            if value is not None:
                measured[f'side_{side}_median_vibration_rms_m_s2'] = value
        label = facts['predicted_class']
        chosen = [1, 2] if label == 'Normal' else [1 if label == 'Side I' else 2]
        readings = [f'Side {"I" if side == 1 else "II"} about {_number(measured[key])}'
                    for side in chosen if (key := f'side_{side}_median_vibration_rms_m_s2') in measured]
        if readings:
            return measured, 'Typical vibration (median RMS): ' + ', '.join(readings) + ' m/s².'
    elif subsystem == 'shm':
        rms = _measurement(report, 'shm-rms', 'raw stress units', nonnegative=True)
        cycles = _measurement(report, 'shm-cycles', 'cycles including half cycles', nonnegative=True)
        phrases = []
        if rms is not None:
            measured['stress_rms_raw_units'] = rms
            phrases.append(f'Stress level (RMS): about {_number(rms)} raw stress units')
        if cycles is not None:
            measured['rainflow_cycles_including_half_cycles'] = cycles
            phrases.append(f'rainflow count: about {_number(cycles)} cycles')
        if phrases:
            return measured, '; '.join(phrases) + '.'
    return measured, ''


def _facts(report: dict, subsystem: str) -> tuple[dict, str, str]:
    if not isinstance(report, dict) or subsystem not in _CONTEXT or report.get('subsystem') not in (None, subsystem):
        raise ValueError('Unsupported saved result.')
    if not isinstance(report.get('prediction_rows'), list) or any(not isinstance(row, dict) for row in report['prediction_rows']):
        raise ValueError('Invalid saved prediction rows.')
    validate_predictions(subsystem, report)
    rows = report['prediction_rows']
    if subsystem == 'door':
        total = len(rows)
        flagged = sum(row['prediction'] == 'Abnormal resistance' for row in rows)
        facts = {'subsystem': subsystem, 'candidate_actions': total, 'abnormal_resistance_classifications': flagged}
        action_phrase = 'detected door movement was' if total == 1 else 'detected door movements were'
        anchor = f'{flagged} of {total} {action_phrase} flagged for abnormal resistance.'
        review = 'Check the action boundaries and signals before drawing mechanical conclusions.'
    elif subsystem == 'acv':
        ranking = rows[0]['ranked_cars'].split('|')
        entities = report.get('entities')
        available = None
        if isinstance(entities, list) and len(entities) == len(ranking):
            by_id = {item.get('id'): item.get('status') for item in entities if isinstance(item, dict)}
            if set(by_id) == set(ranking) and all(status in {'ranked', 'unavailable'} for status in by_id.values()):
                available = sum(status == 'ranked' for status in by_id.values())
                if available and by_id[ranking[0]] != 'ranked':
                    raise ValueError('Inconsistent cooling ranking and evidence availability.')
        facts = {'subsystem': subsystem, 'first_car': ranking[0], 'cars': len(ranking), 'cars_with_usable_cooling_readings': available}
        if available == 0:
            anchor = f'All {len(ranking)} cars lack usable cooling readings; Car {ranking[0]} appears first only in the required fallback order.'
            review = 'Review the missing cooling measurements before using this ordering for inspection.'
        elif available is None:
            anchor = f'Car {ranking[0]} appears first in the recorded ranking; cooling-reading availability is not recorded.'
            review = 'Review the car measurements and their availability before interpreting this ranking.'
        else:
            anchor = f'Car {ranking[0]} ranks first for inspection; {available} of {len(ranking)} cars have usable cooling readings.'
            review = 'Compare its cooling measurements with the other cars; this ranking does not establish a leak.'
    elif subsystem == 'rail':
        label = rows[0]['prediction']
        facts = {'subsystem': subsystem, 'predicted_class': label}
        anchor = 'The recording is classified as Normal; no rail corrugation is predicted.' if label == 'Normal' else f'The recording is classified as {label} rail corrugation.'
        review = 'Compare the vibration and shock signals before drawing engineering conclusions.'
    else:
        value = rows[0]['prediction']
        if not math.isfinite(value):
            raise ValueError('Invalid saved damage estimate.')
        facts = {'subsystem': subsystem, 'cumulative_fatigue_damage': value}
        anchor = f'The estimated cumulative fatigue damage is approximately {value:.6g}; it is not a percentage or remaining lifetime.'
        review = 'Review the stress waveform and counted cycles to interpret this estimate.'
    measured, measured_text = _measured_facts(report, subsystem, facts)
    facts['measurements'] = measured
    if measured_text:
        anchor += ' ' + measured_text
    return facts, anchor, review


def _run_facts(reports, subsystem):
    if not isinstance(reports, list) or not 1 <= len(reports) <= _MAX_FILES:
        raise ValueError('Choose a run containing between one and one hundred files.')
    names = [report.get('file_id') if isinstance(report, dict) else None for report in reports]
    if any(not isinstance(name, str) or not name.strip() or len(name) > 150 for name in names):
        raise ValueError('Every saved result needs a source filename.')
    if len({name.casefold() for name in names}) != len(names):
        raise ValueError('Saved filenames must be distinct.')
    file_facts = [_facts(report, subsystem)[0] for report in reports]
    count = len(reports)
    facts = {'subsystem': subsystem, 'scope': 'run', 'file_count': count}
    if subsystem == 'door':
        total = sum(item['candidate_actions'] for item in file_facts)
        flagged = sum(item['abnormal_resistance_classifications'] for item in file_facts)
        affected = sum(item['abnormal_resistance_classifications'] > 0 for item in file_facts)
        facts.update(candidate_actions=total, abnormal_resistance_classifications=flagged, files_with_flagged_actions=affected)
        action_phrase = 'detected door movement was' if total == 1 else 'detected door movements were'
        anchor = f'{_files(count)}: {flagged} of {total} {action_phrase} flagged for abnormal resistance, across {_files(affected)}.'
        currents = [action['peak_absolute_current_ma'] for item in file_facts for action in item['measurements'].get('flagged_actions', [])]
        if currents:
            facts['reported_flagged_action_peak_current_ma'] = {'min': min(currents), 'max': max(currents), 'action_count': len(currents)}
            action_word = 'movement' if len(currents) == 1 else 'movements'
            anchor += f' Reported peak currents for {len(currents)} flagged {action_word}: about {_range(currents)} mA.'
        review = 'Check the action boundaries in each recording before comparing the classifications.'
    elif subsystem == 'acv':
        usable = sum((item['cars_with_usable_cooling_readings'] or 0) > 0 for item in file_facts)
        missing = sum(item['cars_with_usable_cooling_readings'] == 0 for item in file_facts)
        unknown = count - usable - missing
        facts.update(files_with_usable_cooling_rankings=usable, files_without_usable_readings=missing, files_with_unknown_availability=unknown)
        ranking_word = 'ranking' if usable == 1 else 'rankings'
        anchor = f'{_files(count)}: {usable} usable cooling {ranking_word}, {missing} without usable readings, {unknown} with availability unrecorded.'
        values = [item['measurements']['first_car_median_cabin_minus_target'] for item in file_facts if 'first_car_median_cabin_minus_target' in item['measurements']]
        if values:
            facts['first_car_cabin_minus_target_median_raw_units'] = {'min': min(values), 'max': max(values), 'file_count': len(values)}
            anchor += f' First-ranked cars’ median cabin temperature minus target: about {_range(values)} raw temperature units across {_files(len(values))}.'
        review = 'Compare each car within its recording; the rankings do not establish leaks.'
    elif subsystem == 'rail':
        counts = {label: sum(item['predicted_class'] == label for item in file_facts) for label in ('Normal', 'Side I', 'Side II')}
        facts['predicted_class_counts'] = counts
        anchor = f'{_files(count)}: {counts["Normal"]} classified Normal, {counts["Side I"]} Side I corrugation, and {counts["Side II"]} Side II corrugation.'
        measured = [item['measurements'] for item in file_facts if item['measurements']]
        values = [value for item in measured for value in item.values()]
        if values:
            facts['recorded_side_median_vibration_rms_m_s2'] = {'min': min(values), 'max': max(values), 'file_count': len(measured)}
            anchor += f' Typical vibration (median RMS): about {_range(values)} m/s² across {_files(len(measured))}.'
        review = 'Compare the rail-side vibration and shock signals within each recording.'
    else:
        values = [item['cumulative_fatigue_damage'] for item in file_facts]
        facts['cumulative_fatigue_damage'] = {'min': min(values), 'max': max(values)}
        anchor = f'{_files(count)}: estimated fatigue damage spans approximately {_range(values)}; these are separate recording estimates, not percentages or remaining lifetimes.'
        rms = [item['measurements']['stress_rms_raw_units'] for item in file_facts if 'stress_rms_raw_units' in item['measurements']]
        if rms:
            facts['stress_rms_raw_units'] = {'min': min(rms), 'max': max(rms), 'file_count': len(rms)}
            anchor += f' Stress level (RMS): about {_range(rms)} raw stress units across {_files(len(rms))}.'
        review = 'Review each stress waveform and recording length before comparing damage estimates.'
    return facts, anchor, review


def _checked_explanation(value, subsystem: str, anchor: str) -> str:
    if not isinstance(value, str) or len(value) > 350:
        raise ValueError('Invalid brief explanation.')
    text = ' '.join(value.split()).strip()
    if not 6 <= len(text.split()) <= min(18, _MAX_WORDS - len(anchor.split())):
        raise ValueError('Explanation exceeds the concise-summary budget.')
    if not re.match(r'^(?:Review|Compare|Check|Inspect|Use)\b', text) or re.search(r'[.!?]', text.rstrip('.')):
        raise ValueError('Expected one plain-language review sentence.')
    if any(character.isnumeric() for character in text) or _UNSUPPORTED.search(text) or not re.search(_REVIEW_TERMS[subsystem], text, re.IGNORECASE):
        raise ValueError('Explanation includes unsupported claims or unrelated content.')
    if re.search(r'[<>{}\[\]`\n]', text) or re.search(r'https?://|\bwww\.', text, re.IGNORECASE):
        raise ValueError('Explanation must be plain text.')
    return text.rstrip('.') + '.'


class ResultSummarizer:
    """Per-app, bounded success cache and dedicated two-request single flight."""

    def __init__(self, *, transport=None):
        self._cache: OrderedDict[str, dict] = OrderedDict()
        self._inflight: dict[str, asyncio.Task] = {}
        self._slots = asyncio.Semaphore(_MAX_REQUESTS)
        self._transport = transport

    async def summarize(self, report: dict, subsystem: str, model_fingerprint: str | None = None) -> dict:
        file_id = report.get('file_id', '') if isinstance(report, dict) else ''
        return await self._summarize([report], subsystem, model_fingerprint, {'file_id': file_id})

    async def summarize_run(self, reports: list, subsystem: str, model_fingerprint: str | None = None) -> dict:
        return await self._summarize(reports, subsystem, model_fingerprint,
                                     {'scope': 'run', 'file_count': len(reports) if isinstance(reports, list) else 0})

    async def _summarize(self, reports, subsystem, model_fingerprint, identity):
        try:
            facts, anchor, review = (_run_facts(reports, subsystem) if identity.get('scope') == 'run'
                                    else _facts(reports[0], subsystem))
        except (ValueError, TypeError, KeyError, OverflowError):
            return {'summary': 'This saved result has incomplete prediction information. Review the result details or analyse the recording again before interpreting it.',
                    'mode': 'local', 'cached': False, **identity,
                    'warning': 'A complete saved prediction is required for an AI summary.'}
        local = {'summary': f'{anchor} {review}', 'mode': 'local', 'cached': False, **identity}
        settings = _settings()
        if not settings['enabled'] or not settings['key']:
            return {**local, 'warning': 'AI summaries are unavailable; this summary uses the saved prediction.'}
        binding = {'version': SUMMARY_VERSION, 'configured_model': settings['model'], 'model': model_fingerprint,
                   'identity': identity, 'facts': facts,
                   'reports': [{'input': report.get('input_sha256'), 'file_id': report.get('file_id'),
                                'model_name': report.get('model_name'), 'predictions': report['prediction_rows'],
                                'facts': _facts(report, subsystem)[0]} for report in reports]}
        key = hashlib.sha256(json.dumps(binding, sort_keys=True, allow_nan=False).encode()).hexdigest()
        if key in self._cache:
            self._cache.move_to_end(key)
            return {**self._cache[key], 'cached': True}
        if key in self._inflight:
            result = await asyncio.shield(self._inflight[key])
            return {**result, 'cached': result['mode'] == 'ai'}
        if len(self._inflight) >= _MAX_REQUESTS:
            return {**local, 'warning': 'AI summary capacity is busy; the saved prediction is shown immediately.'}
        task = asyncio.create_task(self._generate(facts, anchor, local, settings))
        self._inflight[key] = task

        def finished(completed):
            self._inflight.pop(key, None)
            if completed.cancelled():
                return
            result = completed.result()
            if result['mode'] == 'ai':
                self._cache[key] = result
                self._cache.move_to_end(key)
                while len(self._cache) > _MAX_CACHE:
                    self._cache.popitem(last=False)

        task.add_done_callback(finished)
        return await asyncio.shield(task)

    async def _generate(self, facts: dict, anchor: str, local: dict, settings: dict) -> dict:
        subsystem = facts['subsystem']
        budget = min(18, _MAX_WORDS - len(anchor.split()))
        payload = {
            'model': settings['model'], 'store': False, 'max_output_tokens': 600,
            'instructions': (
                'Write one short plain-language review suggestion for an engineering result card. '
                f'The app already displays this exact result sentence: {anchor} '
                f'Write only an explanation of 6 to {budget} words, beginning Review, Compare, Check, Inspect or Use. '
                'Refer only to the supplied task context and saved facts. Do not repeat numbers, car IDs or class labels. '
                'Never use the word evidence. Use everyday wording; the numeric readings are already shown. '
                'Do not add readings, units, confidence, severity, physical causes, diagnoses, safety clearance, '
                'maintenance deadlines, repairs, probabilities or forecasting. No links, markdown or additional sentences. '
                'If cooling readings are unavailable, focus on reviewing missing measurements. '
                'A model result is an estimate or classification requiring engineering interpretation.'
            ),
            'input': json.dumps({'saved_facts': facts, 'task_context': _CONTEXT[subsystem]}, allow_nan=False),
            'text': {'format': {'type': 'json_schema', 'name': 'result_review_sentence', 'strict': True,
                                'schema': {'type': 'object', 'properties': {'explanation': {'type': 'string'}},
                                           'required': ['explanation'], 'additionalProperties': False}}},
        }
        if settings['model'].startswith(('gpt-5', 'o3', 'o4')):
            payload['reasoning'] = {'effort': 'low'}
        try:
            async with self._slots, asyncio.timeout(SUMMARY_TIMEOUT_SECONDS):
                async with httpx.AsyncClient(transport=self._transport, timeout=SUMMARY_TIMEOUT_SECONDS) as client:
                    response = await client.post('https://api.openai.com/v1/responses',
                                                 headers={'Authorization': 'Bearer ' + settings['key']}, json=payload)
                    response.raise_for_status()
                    result = response.json()
                if not isinstance(result, dict) or result.get('status') != 'completed':
                    raise ValueError('Incomplete summary response.')
                content = [part for item in result.get('output', []) if isinstance(item, dict) and item.get('type') == 'message'
                           for part in item.get('content', []) if isinstance(part, dict)]
                if any(part.get('type') == 'refusal' for part in content):
                    raise ValueError('Summary was declined.')
                texts = [part.get('text') for part in content if part.get('type') == 'output_text']
                if len(texts) != 1 or not isinstance(texts[0], str):
                    raise ValueError('Missing structured summary.')
                output = json.loads(texts[0])
                if not isinstance(output, dict) or set(output) != {'explanation'}:
                    raise ValueError('Invalid summary schema.')
                explanation = _checked_explanation(output['explanation'], subsystem, anchor)
                return {**local, 'summary': f'{anchor} {explanation}', 'mode': 'ai'}
        except (TimeoutError, httpx.TimeoutException):
            return {**local, 'warning': 'AI summary timed out; the saved prediction is shown instead.'}
        except httpx.HTTPStatusError:
            return {**local, 'warning': 'The AI provider could not supply a summary; the saved prediction is shown instead.'}
        except httpx.RequestError:
            return {**local, 'warning': 'AI summary connection is unavailable; the saved prediction is shown instead.'}
        except (ValueError, TypeError, KeyError, AttributeError):
            return {**local, 'warning': 'The AI wording did not pass result checks; the saved prediction is shown instead.'}
