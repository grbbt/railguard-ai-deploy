# Short result summaries and investigation reading position

The **In brief** card appears above the recording's 3D/component view in Analyse data and 3D + AI investigation. **Current file** describes the whole selected recording. **All files** summarises every recording in the selected completed analysis run and appears above the comparison table in Analyse data. Both views share this selection. The filename or file count stays visible; the 3D view and measurements still belong to the explicitly named selected recording.

A local explanation appears immediately from the returned prediction rows and known measurements. When OpenAI is configured, the card requests `/api/ps3/summary` using `{job_id, scope: 'file', file_id}` or `{job_id, scope: 'run'}`. Omitting scope keeps the original file contract. The backend resolves the saved completed run; callers cannot supply replacement predictions or measurements. Exact counts, car IDs, classes, damage values and recorded measurements remain server-generated. The language model adds one brief review sentence, with no extra numbers or unsupported diagnostic claims. Summary wording calls the readings measurements rather than evidence.

| System | Current-file measurements | All-files brief |
| --- | --- | --- |
| Door | Peak motor current and duration for an available flagged action; sampling interval when applicable | Action and flagged-file counts, plus range and coverage of available flagged-action peak currents |
| Air conditioning | First-ranked car's median cabin-minus-target reading, in raw source temperature units | Usable-ranking coverage and the range of first-ranked car measurements within their own recordings |
| Rail | Median vibration RMS for the predicted side, or both sides for Normal | Normal / Side I / Side II counts and recorded side-median RMS range |
| Structural health | Stress RMS and counted rainflow cycles | Separate damage-estimate range and stress RMS range; estimates are not added together |

Only unique known measurement IDs with the expected units and finite numeric values are accepted. No values are extracted from arbitrary labels, filenames or prose; missing readings are not replaced by zero. Rounded readings are marked approximate. Invalid batch predictions produce a local explanation rather than a partial aggregate presented as complete. Conditional input-validity notes remain visible where they affect interpretation.

The API uses an eight-second provider budget, two concurrent requests, deduplication and a bounded success cache; this is separate from the longer tool-using investigation. Cache identity includes scope, run members, prediction facts, selected measurements and model binding. Only compact canonical facts and static subsystem context are sent, never raw recordings. The browser validates response scope and file identity or count and ignores replies from earlier selections.

The badge distinguishes **AI summary**, **Writing AI summary** and **Saved result**. The saved result stays visible during generation, missing configuration, timeout and provider failures. A retry control is available after an unsuccessful AI request. Reading the card should take only a glance; actual uncached cloud latency varies and a two-to-three-second response is not guaranteed. The frontend debounces quick file selection, shares requests between view mounts, briefly retains local failures, and ignores late results from an earlier selection.

Structured response formatting follows the official [OpenAI Structured Outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs). Wording checks are conservative safeguards, not a complete factual verifier. This feature neither changes model output nor establishes an engineering diagnosis, operational severity, failure probability or remaining useful life.

When a question is submitted in AI investigation, only the conversation's scroll container moves to the new exchange's beginning. It keeps enough space for a short pending answer to align with the top. Answer completion does not scroll or force input focus. Manual reading position and close/reopen position are retained while the component stays mounted; submitting another question deliberately anchors that new exchange.
