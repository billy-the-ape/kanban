# Task diagnostics export

The diagnostics panel's **Export diagnostics** action downloads a complete, unredacted JSON bundle of the task's recorded evidence to the user's browser. Nothing is written to the runtime host: the export is a streamed response, and the downloaded file is owned by the client. (The old host-disk export to `~/.cline/kanban/diagnostics/` was removed in DIAG-3; manually created files there are left as-is and never read back.)

## What is included

The bundle is a single UTF-8 JSON document (`schemaVersion: 3`) named `task-<safeTaskId>-<timestampMs>.json`:

- **Full conversation transcripts** for every session the task owns — the working session (`kind: "task"`), review sessions (`kind: "review"`), and verification-repair rounds (`kind: "verification-repair"`) — in creation order, with each segment's allowlisted header (session id, status, model, cwd, …).
- **The task launch config**: mode, reasoning effort, and the full system prompt (the context needed to explain model behaviour).
- **Tool evidence**: exact recorded inputs, outputs, and errors in chronological context; oversized outputs that were archived as context artifacts are embedded once, as their exact raw text with `contentFormat: "json-text" | "text"`.
- **Operational diagnostics**: the full task diagnostics response (phase, branch/commit, delivery, review, dispatch record, preserved work, context usage, errors) plus the card's original prompt.
- **PR comment dispatch evidence**: `diagnostics.prCommentHandling` contains the comment consumer's pending count/deadline, durable dispatch, hold reason and timestamps, and Resume state. This is separate from the general task queue's `dispatchRecord`. `diagnostics.session.writerActivity` contains both raw session summaries, actual terminal-process liveness, and the shared writer-check result. A missing session service gives an unknown (`null`) result rather than implying it is idle. Reads do not poll GitHub, start a turn, or mutate the comment record.
- **Completeness**: `complete`, `partial`, or `unavailable` with explicit reasons (deleted history, lost pre-archive output, truncated session listings) and informational warnings. Deleted or lost evidence is reported as a gap, never invented.

What is deliberately excluded: provider credentials, auth headers, raw environment dumps, passcode state, session-record internals (raw `metadata`, `prompt`, `messagesPath`, `hookPath`, `pid`), and arbitrary files outside the task's recorded evidence.

> The bundle contains the full conversation and every tool output, so it can include secrets that tools printed. Review it before sharing it. The UI shows this caveat next to the export action.

## Transport

- **Browser**: a same-origin `GET /api/task-diagnostics/download?workspaceId=…&taskId=…`, authenticated by the `SameSite=Strict; HttpOnly` session cookie (sent automatically). The response is `application/json` with `Content-Disposition: attachment`, `Cache-Control: no-store`, and an `X-Kanban-Diagnostics-Completeness` header. The route dispatches after the runtime auth gate and before the unmatched `/api/` 404; unknown workspaces, unknown tasks, and export failures return clear non-2xx JSON errors. A failure mid-stream terminates the response so a truncated file is never mistaken for a complete bundle.
- **CLI**: `kanban task export-diag --task-id <id> --output <file> [--project-path <path>]`. It authenticates with the internal bearer token (`getRuntimeFetch`), streams to the file given by `--output`, and prints the usual `{ ok, outputPath, bytes, completeness, … }` record. A non-2xx response or a truncated stream deletes the partial file and exits non-zero. The command never writes to `~/.cline/kanban/diagnostics/`.

The export is read-only: it never starts, restarts, or mutates a session, sends model requests, or changes board state. It is a point-in-time capture; activity after the capture time is outside the bundle.

## Memory use and troubleshooting

Session enumeration uses the SDK's `hydrate: false` option. The default hydrated history listing reads transcripts concurrently to infer display metadata, including cost; local-model sessions often lack that cost metadata. Exporting one task must not parse unrelated tasks' histories. After filtering by session-id prefix and workspace ownership, the export reads only the selected task's transcripts, including its review and verification-repair lineage.

This fixes the October 14, 2026 ai-monster crash when exporting `blwzb` on release `0b6df3eb685589dc1f1f76c0d5e3eb197447a1d6`: Node reached its approximately 4 GiB JavaScript heap limit during JSON parsing, despite the task's four transcripts totaling about 6 MiB. Systemd recorded a 6.5 GiB process memory peak and automatically restarted the service.

The serializer streams archived outputs, but the selected task's transcript snapshot is still assembled in memory. This fix removes the unrelated-history amplification; it does not make arbitrarily large task transcripts or concurrent exports constant-memory. No heap-size override, new environment variable, or migration is required. If an export fails again, capture the service journal and the task's transcript file sizes before retrying; increasing the heap alone does not fix unnecessary transcript loading.

