# Task diagnostics export

The diagnostics panel's **Export diagnostics** action downloads a complete, unredacted JSON bundle of the task's recorded evidence to the user's browser. Nothing is written to the runtime host: the export is a streamed response, and the downloaded file is owned by the client. (The old host-disk export to `~/.cline/kanban/diagnostics/` was removed in DIAG-3; manually created files there are left as-is and never read back.)

## What is included

The bundle is a single UTF-8 JSON document (`schemaVersion: 3`) named `task-<safeTaskId>-<timestampMs>.json`:

- **Full conversation transcripts** for every session the task owns — the working session (`kind: "task"`), review sessions (`kind: "review"`), and verification-repair rounds (`kind: "verification-repair"`) — in creation order, with each segment's allowlisted header (session id, status, model, cwd, …).
- **The task launch config**: mode, reasoning effort, and the full system prompt (the context needed to explain model behaviour).
- **Tool evidence**: exact recorded inputs, outputs, and errors in chronological context; oversized outputs that were archived as context artifacts are embedded once, as their exact raw text with `contentFormat: "json-text" | "text"`.
- **Operational diagnostics**: the full task diagnostics response (phase, branch/commit, delivery, review, dispatch record, preserved work, context usage, errors) plus the card's original prompt.
- **Completeness**: `complete`, `partial`, or `unavailable` with explicit reasons (deleted history, lost pre-archive output, truncated session listings) and informational warnings. Deleted or lost evidence is reported as a gap, never invented.

What is deliberately excluded: provider credentials, auth headers, raw environment dumps, passcode state, session-record internals (raw `metadata`, `prompt`, `messagesPath`, `hookPath`, `pid`), and arbitrary files outside the task's recorded evidence.

> The bundle contains the full conversation and every tool output, so it can include secrets that tools printed. Review it before sharing it. The UI shows this caveat next to the export action.

## Transport

- **Browser**: a same-origin `GET /api/task-diagnostics/download?workspaceId=…&taskId=…`, authenticated by the `SameSite=Strict; HttpOnly` session cookie (sent automatically). The response is `application/json` with `Content-Disposition: attachment`, `Cache-Control: no-store`, and an `X-Kanban-Diagnostics-Completeness` header. The route dispatches after the runtime auth gate and before the unmatched `/api/` 404; unknown workspaces, unknown tasks, and export failures return clear non-2xx JSON errors. A failure mid-stream terminates the response so a truncated file is never mistaken for a complete bundle.
- **CLI**: `kanban task export-diag --task-id <id> --output <file> [--project-path <path>]`. It authenticates with the internal bearer token (`getRuntimeFetch`), streams to the file given by `--output`, and prints the usual `{ ok, outputPath, bytes, completeness, … }` record. A non-2xx response or a truncated stream deletes the partial file and exits non-zero. The command never writes to `~/.cline/kanban/diagnostics/`.

The export is read-only: it never starts, restarts, or mutates a session, sends model requests, or changes board state. It is a point-in-time capture; activity after the capture time is outside the bundle.
