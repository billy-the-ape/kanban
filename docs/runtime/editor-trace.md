# Editor trace and raw transport capture (observational diagnostics)

Set `KANBAN_TRACE_EDITOR=1` in the Kanban runtime's environment and restart Kanban,
then **start a new native Cline session** — the trace hooks and the transport
capture are installed when a session starts, so existing sessions are not
retroactively traced. No model, prompt, or gateway changes are needed. Logging is
independent of `CLINE_LOG_ENABLED`. Tracing is strictly observational: it never
retries, repairs, or alters edits, failure handling, backpressure, or execution
outcomes, and log-write failures are best effort and never fail a task.

## What is recorded

Each editor call appends timestamped JSON records to
`<Cline SDK data directory>/logs/editor-trace.jsonl` (for example
`~/.cline/data/logs/editor-trace.jsonl`). New files use owner-only permissions.

Two kinds of records:

- **Hook stages** (`model-call`, `before-execution`, `result`): task/session/
  tool-call IDs, the exact parsed input at the parsed-call and before-execution
  stages, field-presence flags, character counts, and the original SDK result.
  Thrown tool errors appear verbatim in the result. Other tools are excluded.
- **Raw transport capture** (`raw-arguments`): for local native sessions using the
  OpenAI-compatible streaming path, the editor `function.arguments` text fragments
  exactly as received over HTTP **before** SDK argument parsing/validation — in
  arrival order — plus the assembled text, stream completion status
  (`completed` / `ended-early` / `interrupted`), abort flag, SSE parse-error count,
  per-request and per-host identifiers for correlation, and the model-facing
  editor schema sent for that request (properties and required fields).

## Interpretation

For one editor call, compare the stages (this is done automatically by the
diagnostics export; see below):

- `present-in-both`: `old_text` was in the raw response and in the parsed call.
- `present-only-in-raw`: the raw provider response contained `old_text` but the
  parsed SDK tool call did not — the loss occurred at or below the client
  argument-parsing boundary.
- `absent-in-both`: the raw provider response already omitted `old_text`. The
  omission is **upstream of the client boundary** (the model, the inference
  server's tool parser, or an intervening gateway) — this is *not* proven model
  error.
- `not-comparable` (truncated, interrupted, malformed, or unmatched records): the
  evidence is **inconclusive** and must never be presented as proof of omission at
  any stage.

The model-call hook runs after SDK JSON parsing; it is not the raw provider
response. Presence of `old_text` alone does not establish that the replacement
text is valid or matches the file.

## Diagnostics export

The existing task diagnostics download includes an additive, versioned
`editorCallEvidence` object (schema version 1) per session segment: the four
stages per editor tool call, the factual comparison above, and explicit
`captured` / `partial` / `unavailable` statuses with reasons for missing stages.
Historical sessions and exports without this evidence are unaffected (the field is
absent or reports `unavailable`). Download it through the existing task
diagnostics download UI; no new UI was added.

## Capture limits and retention

- Assembled argument text is capped at 32,000 characters per editor call; single
  SSE lines at 64,000 characters; the captured editor schema at 8,000 serialized
  characters; 32 tool-call indexes per request. Truncation is flagged explicitly
  (`assembledTruncated`, incompleteness notes) and never silently dropped.
- Only editor arguments and the editor schema are captured. Authorization
  headers, credentials, prompts, and unrelated responses are never stored.
- The trace file itself is capped at 32 MB: once reached, a single
  `capture-limit-reached` marker line is written and no further records are
  written (missing records must be read as unavailable evidence). There is no
  automatic rotation. Enable tracing only during investigation, then **remove
  `KANBAN_TRACE_EDITOR` and restart Kanban** to disable it (existing sessions
  keep their hooks until restart). Delete the trace file when no longer needed.

## Limitations

- Raw transport capture covers **local native Cline sessions only** (backend
  `local`, OpenAI-compatible streaming requests that go through the process
  `fetch`). Hub-backed execution and non-streaming responses are not covered by
  the raw stage; the hook stages apply where SDK hooks are supported.
- Custom providers without a resolvable base-URL host are not tracked for the raw
  stage (hook stages still apply).
- When several sessions share one provider host, requests cannot always be
  attributed to a session. Such captures are never used for a definitive verdict:
  they are marked `ambiguous` (with the unattributed arguments not listed, to
  keep task isolation), and the affected call's comparison is `not-comparable`.
- Upstream ambiguity: `absent-in-both` cannot distinguish a model omission from an
  inference-server tool-parser or gateway modification. It is labeled upstream,
  never as proven model error.
- Truncated, interrupted, or unmatched evidence is always `not-comparable`.
