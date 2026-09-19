# RailGuard project investigation agent

The Investigation view can research questions about the project, examine saved model findings, compare recordings and draft a sourced inspection or presentation brief. It uses the configured OpenAI model to select local read-only tools. Numerical analysis and trained-model inference remain in Python.

A separate [In brief result card](RESULT_SUMMARIES.md) provides a short explanation above the component view. It uses a single bounded AI wording request over saved facts, rather than the investigation tool loop. The conversation now anchors each submitted question at its beginning and keeps the reader's position when the answer finishes.

## What it can investigate

- Project architecture, the released PS3 tasks, data schemas, preprocessing and model-training methods.
- Current fitted model metadata, local validation, candidate comparisons and the separate retrospective ACV selection audit.
- Saved runs, their exact recording-level predictions, computed comparisons and detailed supporting measurements.
- Missing data, interpretation limits, evidence still needed, and proposed engineering checks.
- The map and component-view limitations, how to test the app, and improvements or hackathon presentation material.

These capabilities do not promise an answer to every possible question. Unreleased test answers, undocumented calibration, unavailable telemetry, and verified failure causes remain unknown. General explanations and proposed improvements must be distinguished from retrieved project facts.

## Scope and follow-ups

**Project** scope supports documentation questions without a completed recording and can inspect saved runs across all four subsystems. **Selected run** limits recording access to that run. **Current file** limits it to the selected recording. General documentation and model metadata are available in every scope. Scope is enforced by Python; instructions in documents cannot expand it.

Recent conversation is included so follow-up questions can refer to earlier answers. It is intent context, not authoritative evidence: the agent retrieves fresh sources for every response. The interface keeps a bounded conversation in browser session storage, with the run/file context shown for each question. A new session can be started in the interface. This is not a permanent memory store or an automatically running background agent.

## Tools and evidence

| Tool | Purpose |
| --- | --- |
| `get_project_overview` | Current scope, model availability and a summary of saved results. |
| `search_project_knowledge` | Search a fixed allowlist of project documentation, official reference material and selected implementation source excerpts. |
| `list_saved_runs` | Find saved run IDs and provenance within the chosen scope. |
| `compare_run_files` | Compute run-wide summaries in Python and return paginated file predictions. |
| `inspect_recording` | Retrieve a saved report, evidence, entities, signal previews, prediction rows and that run's validation. |
| `get_model_details` | Retrieve the current fitted model's metadata and measured validation. |
| Selected-file evidence, validation, signal and subsystem-reference tools | Preserve direct access to the selected recording's existing evidence. |

Search is local lexical retrieval over bounded excerpts; it does not browse the web or upload a raw dataset to a vector database. Documents and source code are reference material, never executable instructions. Current implementation and saved metadata take precedence over the README's original proposal and historical prototype notes. Pagination and coverage fields identify omissions.

The [AI security controls](AI_SECURITY.md) explain enforced tool/scope boundaries, credential redaction, untrusted retrieval and conversation envelopes, context budgets and deterministic adversarial tests. These controls reduce prompt-injection risk; they do not establish that every generated statement is correct.

The assistant cites only source IDs retrieved during the current answer. The interface shows actual completed tool activity, source locations when available, and whether OpenAI answered or a local fallback was used. Each new answer includes expandable retrieved evidence: documentation excerpts retain their paths, line ranges and provenance; model and recording sources retain their numerical summaries and available version/run identity. Clicking a citation opens its evidence. These snapshots come from local tool results, not a second AI summary, and are included in copied/downloaded briefs. Displays are capped at 16,000 characters per source with explicit truncation; retrieval coverage limits still apply. Older cached answers may have source labels only.

A cited source makes a claim inspectable; citation checks alone cannot verify the interpretation of every sentence. Browser session storage is bounded; if it fills or becomes unavailable, the active page retains the recent conversation in memory. That fallback does not persist across a page reload.

## Comparisons and conclusions

Door comparisons count every returned action; rail comparisons preserve Normal / Side I / Side II classes; ACV comparisons retain source-car rankings and missing-evidence status; SHM comparisons use raw cumulative-damage estimates, including zero. A complete-run aggregate is separate from a page of returned file rows.

Rank, classification, damage, descriptive measurements and engineering interpretation are different things. A measured feature is not a computed explanation of the model's decision. There are no per-prediction feature contributions, calibrated failure probabilities, verified physical fault causes, approved repair deadlines or live Singapore positions in these reports. Comparing uploaded Train files does not establish independent accuracy. Historical runs retain their own model/validation context.

## Connection, limits and outputs

The existing server-side `OPENAI_API_KEY`, `RAILGUARD_AI_ENABLED` and `RAILGUARD_AI_MODEL` settings are reused. Configuration is reread per request. Requests use the [OpenAI Responses function-calling interface](https://developers.openai.com/api/docs/guides/function-calling) and manually supplied [conversation context](https://developers.openai.com/api/docs/guides/conversation-state), with `store=false`.

Questions, bounded recent conversation, retrieved documentation/code excerpts and diagnostic summaries are sent to OpenAI. Whole source recordings, credentials and arbitrary local files are not available to the tools. Normal API charges apply. `store=false` does not imply zero provider retention.

Each project investigation permits at most six API rounds, sixteen tool calls, four calls per round, a 75-second overall time budget and two concurrent investigations. Questions are limited to 4,000 characters; conversation input to twelve messages and 40,000 characters. A cancelled UI request stops waiting, but an already-running provider request can continue until the backend budget ends.

The agent can draft a brief which the user copies or downloads from the interface. It cannot retrain models, change predictions, execute commands, issue maintenance orders or send messages. It must not report that any such action occurred. When the AI connection fails, the UI gives explicit local guidance or a fixed selected-file evidence summary rather than pretending the requested investigation completed.

## Verification

Run `scripts/check.ps1` with the frontend stopped for the Python regression tests, frontend helper tests, TypeScript, lint and production build. Mocked tests check tool arguments, scope boundaries, conversation limits, source attribution, malformed provider output and graceful fallback. Live questions exercise retrieval and tool selection separately; these are application checks, not measurements of railway model accuracy.
