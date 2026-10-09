# Temporary editor trace

Set `KANBAN_TRACE_EDITOR=1` in the Kanban runtime's environment and restart it.
Start a new native Cline session to install the hooks. No model or gateway changes are needed.
Logging is independent of `CLINE_LOG_ENABLED`.

Each editor call appends timestamped JSON records to
`<Cline SDK data directory>/logs/editor-trace.jsonl` (normally
`/home/cline-agent/.cline/data/logs/editor-trace.jsonl` on ai-monster).
New files use owner-only permissions. Records contain task/session/tool-call IDs,
exact parsed input, field-presence flags, character counts, and the original SDK result.
The stages are `model-call`, `before-execution`, and `result`.
Thrown tool errors appear in the SDK result. Other tools are excluded.

The model-call hook runs after SDK JSON parsing; it is not the raw provider response.
Parse-error metadata is retained when available. Compare inputs across the two stages:
if both omit old_text, it was already absent at the assembled model-call boundary;
if they differ, investigate processing between those stages. Presence alone does not
establish that replacement text is valid or matches the file.

Inspect with `tail -n 12 /home/cline-agent/.cline/data/logs/editor-trace.jsonl`.
For sharing, copy the file as the service user; it contains full code and tool content,
without truncation or redaction. There is no automatic rotation: enable only during
investigation, then remove the environment setting and restart Kanban. Existing sessions
keep their hooks until restart. Delete the trace when no longer needed.

This is a temporary local-mode SDK hook. Hub-backed execution does not support these hooks.
It does not retry, repair, or alter edits or failure handling; log-write failures are best effort.
When diagnostics downloads replace it, remove `cline-editor-trace.ts`, its focused test,
the session-runtime hook wiring, this document, and the environment setting.
