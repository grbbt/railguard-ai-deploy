# AI investigation: retrieval and security controls

RailGuard's investigator can read selected project knowledge and saved diagnostic summaries. It cannot execute commands, write files, retrain models, change predictions, browse arbitrary URLs, send messages or issue maintenance orders. Python enforces these boundaries independently of the model's instructions.

## What protects a question

| Boundary | Implemented control |
| --- | --- |
| Available actions | A fixed set of read-only tools, strict function schemas, and a second server-side check of exact argument names, types, ranges and enums. Unknown tools never run. Duplicate JSON keys and non-finite numeric arguments are rejected. |
| Recording scope | File scope can read only its selected recording; run scope only its selected run. Project scope can access the local completed-run library. Exact IDs are checked before reading, and a mismatched selected report is rejected. Scope is a data boundary within this local application, not multi-user authorization. |
| Document access | A fixed allowlist of local Markdown and Python files. No caller-supplied path or URL is accepted. Absolute paths, escapes from the project, symlink destinations and files larger than 300 KB are excluded. Raw telemetry and secret configuration are not retrieval sources. |
| Untrusted content | Retrieved documents, source comments, filenames and report strings are placed in a JSON `untrusted_reference_data` envelope. The source ID is assigned by the server. Earlier conversation is quoted inside an `untrusted_conversation_history` message rather than replayed as authoritative assistant messages. Neither data source is inserted into privileged instructions. |
| Credentials | Before provider requests and returned evidence, text redaction removes the exact configured OpenAI key and recognizable API-token, bearer-token, credential-assignment, private-key and URL-password formats. Credential-named nested fields are redacted. Only the fixed OpenAI endpoint receives the configured key in its authorization header. |
| Context size | Existing per-field, page and excerpt limits remain. Additional checks cap a retrieval's serialized data at 64,000 characters and each provider input at 240,000 characters. Oversized retrieval data is replaced with an explicit unavailable result; it is not treated as inspected evidence. Deep or excessive nested data is marked as omitted. |
| Answers and citations | Answers must cite source IDs retrieved during that question. Credential echoes and recognizable directions to export credentials are rejected. A conservative model-attribution check requests correction when prose claims unsupported causal feature attribution. Malformed or rejected answers fall back to clearly labelled local information. |

The agent leads with useful findings and actual measurements. Relevant uncertainties accompany the affected claim, rather than repeating a generic disclaimer. Current and historical project information remain distinguishable. Security controls do not hide validation coverage, missing evidence or unknown physical causes.

## What the tests establish

`tests/test_ps3_agent_security.py` uses scripted local provider responses and synthetic fixture credentials; it makes no paid API requests. It checks:

- Malicious instructions embedded in a retrieved document cannot make the real Python tools read another run in run scope.
- Forged privileged provider messages and unadvertised execution tools are rejected.
- Earlier conversation remains quoted context; its old citations do not become current evidence.
- Credentials in documentation, source comments, question/history, tool evidence and generated text are redacted or rejected, while actual measurements and valid citations remain intact.
- Duplicate keys, non-finite JSON numbers, unexpected arguments, unsafe filenames, absolute paths and context overflows are handled deterministically.
- Direct credential-export instructions, including unrelated-negation tricks, are blocked; legitimate advice such as “Never share your API key” remains usable.

The existing project-tool and agent tests also cover pagination, exact file/run scope, symlink escapes, unknown citations, tool budgets, provider failure and malformed retained data. Run these without a configured live provider:

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_ps3_agent_security.py tests/test_ps3_project_tools.py tests/test_ps3_project_agent.py tests/test_ps3_assistant_reliability.py -q
```

## Limits and operating assumptions

These are layered defenses, not an injection-proof guarantee. Untrusted text can still influence a model's prose or its choice among permitted reads. Pattern-based redaction does not identify every secret, encoded payload, personal detail or paraphrased unsafe instruction. Citations establish source identity, not the truth of every sentence. A compromised local administrator or edited server code is outside this application's isolation boundary. Existing browser-stored answers are not retroactively scrubbed.

The tool surface has no write or network-browsing capability; adding either requires a separate permission and security design. This local single-user application also needs authentication, per-user storage isolation and infrastructure controls before public multi-user hosting. A live adversarial evaluation can measure model behavior separately; passing these deterministic tests does not measure an attack success rate or railway model accuracy.

## Primary guidance checked

The implementation follows OpenAI's guidance to keep untrusted input out of privileged instructions, constrain tool data, combine safeguards and test adversarial cases. OpenAI explicitly notes that these measures reduce risk without eliminating it. [Safety in building agents](https://developers.openai.com/api/docs/guides/agent-builder-safety)

The function definitions use strict schemas with required properties and `additionalProperties: false`; Python still verifies each call before executing it. [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
