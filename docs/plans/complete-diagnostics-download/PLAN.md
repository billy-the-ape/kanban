# Complete task diagnostics as a browser download

Status: implementation-ready plan; no runtime behavior changes in this PR.
Target: billy-the-ape/kanban main. Implement this plan in one focused PR. Split into two only if necessary: (1) complete export assembly and tests, (2) transport/UI and end-to-end tests. Do not create a separate subsystem or require operator decisions.

## Problem and required outcome

The current Export diagnostics button writes a redacted JSON file to the runtime host. A remote browser user must SSH-copy it. The export removes the entire session transcript, including tool arguments, outputs, errors, and reasoning. During investigation of task `0e05l`, this prevented distinguishing an omitted editor `old_text` argument from suspected argument stripping. The expanded editor UI also hides its input because `formatToolInputForDisplay` handles only `run_commands`.

Replace that behavior with a complete JSON download on the user's browser. Include all available task conversation history and full tool input/output/error data in chronological context. Preserve prompts, reasoning, code, paths, review text, and activity text; do not use the existing blanket content redaction. Do not write an export bundle, cache, or temporary download file to the host disk. Existing session records and context artifacts remain the sources of truth.

The download contains task content and can contain secrets printed by tools. Put a short persistent caption next to the export action: "Includes the full conversation and tool inputs, outputs, and errors. Review before sharing." Do not add a confirmation dialog or a second redacted export mode. Do not include provider credentials, raw environment dumps, passcode state, or arbitrary files outside the task's recorded evidence. Preserve actual recorded tool content without speculative secret filtering that changes debugging evidence.

## Existing implementation map

- `src/core/task-diagnostics-export.ts`: current schemaVersion 2 redaction builder; deliberately never exports transcript.
- `src/trpc/runtime-api.ts`: `gatherTaskDiagnosticsSnapshot`, `buildTaskDiagnosticsResponse`, and `exportTaskDiagnostics`; currently writes with `lockedFileSystem.writeTextFileAtomic`.
- `src/core/api-contract.ts`: `runtimeDiagnosticsExportRequestSchema` / response currently return `bundlePath` and `redactions`.
- `src/cline-sdk/cline-task-session-service.ts`: live UI messages, `loadTaskSessionMessages`, `getTaskContextSnapshot`; these are display/context views, not a raw export source.
- `src/cline-sdk/cline-session-runtime.ts`: session binding plus `readPersistedTaskSession`, SDK `list` and `readMessages`; current helper resolves only one session.
- `src/cline-sdk/sdk-runtime-boundary.ts`: SDK import boundary; derive transcript types from SDK types here.
- `src/cline-sdk/cline-event-adapter.ts` and `cline-session-state.ts`: transform raw events into chat messages and tool display strings.
- `src/cline-sdk/cline-tool-result-bounding-hook.ts`: replaces oversized read/search/command outputs with excerpts and artifact references.
- `src/workspace/task-artifacts.ts`: task-scoped `context-artifacts` directory and full serialized output files.
- `src/server/runtime-server.ts`, `middleware.ts`: HTTP handling, origin checks, passcode/session validation, workspace scope resolution.
- `web-ui/src/hooks/use-task-diagnostics.ts`, `runtime/task-diagnostics.ts`, `components/detail-panels/task-diagnostics-panel.tsx`: export action and host-path toast.
- `web-ui/src/components/detail-panels/cline-chat-message-utils.ts` / `cline-chat-message-item.tsx`: expanded tool rendering.
- Existing tests: `test/runtime/core/task-diagnostics-export.test.ts`, runtime/session-service suites, bounding-hook suites, runtime-server tests and web UI tests.

## Decisions and boundaries

1. Download format is a single UTF-8 JSON file, `task-<safeTaskId>-<timestampMs>.json`, schemaVersion 3. No ZIP, external upload, new storage service, or new environment variables.
2. Export is explicit and read-only. It never sends a model request, starts/restarts a session, compacts messages, or changes the board/task.
3. Export all retained native Cline sessions for the task, in creation order. Match using `buildSessionIdPrefix(taskId)` and validate workspace ownership against the task's original workspace/worktree evidence; do not collect another workspace's history solely on a matching ID prefix. Include the currently bound session even when its durable record is not yet created.
4. Preserve each session's original message ordering and metadata. Restarted sessions can inherit earlier messages: keep separate session segments and label inherited/duplicate message IDs; do not destructively deduplicate or concatenate them into a misleading single conversation.
5. Completeness means all evidence still available locally. Already deleted history and output lost before archival cannot be reconstructed. Report those gaps explicitly rather than inventing content or claiming completeness.
6. Transport is a dedicated authenticated HTTP GET download route, `/api/task-diagnostics/download?workspaceId=<id>&taskId=<id>`, on the existing runtime origin. Reuse existing runtime origin/passcode/session/internal-token checks and workspace resolution. Route requests through the existing CORS/middleware gates before serving. Do not invent a second auth mechanism, put auth tokens in URLs, or allow caller-supplied filesystem paths.
7. Stream the JSON response with backpressure; do not put the whole bundle or base64 content through tRPC. No hard truncation cap: retain all available output, including large artifacts. Browser fetch collects the response into a Blob for download; serialization on the host must avoid holding a second giant JSON string in memory.

## Implementation sequence

### 1. Export-specific transcript snapshot

Add a typed read-only export snapshot method to the session runtime and task-session service. Keep existing context/UI methods unchanged. Read SDK session records and messages through the boundary; do not scan guessed SDK paths or export raw credential-bearing session config.

Return an immutable snapshot of all eligible session segments, session IDs and safe operational metadata, ordered raw messages, and the export capture time. Preserve user/assistant/reasoning/tool-call/tool-result parts, IDs, timestamps, original argument values, output values and error flags. Expose provider/model IDs and SDK version as diagnostic metadata, without API keys or auth headers.

Use durable messages as the main source. Merge any not-yet-persisted live tail from Kanban's message repository as a separate explicitly labelled `liveTail` with its actual recorded representation. Do not claim this display tail is identical to raw provider output. Overlap detection uses stable message/tool-call IDs, not text equality. Snapshotting a running task must not pause or mutate it; record a capture time and note that later activity is outside this export.

A task with no native Cline transcript still downloads operational diagnostics with a clear transcript availability status. A failed read of an expected existing transcript is a failure/gap, not an empty successful transcript. For terminal agents, include existing available task session messages as a labelled source and state that structured native tool evidence is unavailable; do not claim unsupported raw tool calls were captured.

### 2. Recover full tool output alongside its original transcript position

For every tool-result part, retain the persisted result exactly and locate any associated full-output artifact. The bounding hook currently stores serialized full output and leaves a path in its excerpt; add structured artifact metadata for new results so future exports do not depend exclusively on parsing prose. Inspect SDK part metadata support before choosing the metadata field; use its provided types through the boundary.

Support legacy references emitted by `buildBoundedToolResultExcerpt` and `buildCommandOutputExcerpt` (both `Full content:` and `full output:` forms). Treat references as untrusted: resolve and realpath them, require containment within `getTaskContextArtifactsDir(taskId)`, reject symlinks that escape it and non-files, and never follow arbitrary paths quoted in tool text. Do not enumerate/include unrelated files or artifacts from another task.

Each tool-result export entry includes the original persisted result plus linked `fullOutput` evidence: artifact identity, recovered JSON value where parsing succeeds, or exact raw text where it does not. Pair it to `toolCallId` and keep it attached to that result's message/part position; never append anonymous output dumps at the end. Do not substitute a parsed artifact as proof of the original provider response: it is the tool output archived by Kanban.

Missing, unreadable or ambiguous artifacts produce explicit per-result gaps and top-level completeness warnings while the rest remains downloadable. A bounded excerpt with no surviving artifact must be labelled incomplete. Do not change model context limits or stop bounding oversized model-facing results.

### 3. SchemaVersion 3 bundle and streaming serializer

Replace the redaction-only export builder with typed export structures and assembly helpers. Keep the operational fields from `RuntimeTaskDiagnosticsResponse`, including task title, review details, warning/activity text, dispatch data, workspace paths and diagnostics errors. Add capture metadata, chronological session segments, live tail, tool evidence, completeness status and gaps. Define completeness as `complete`, `partial`, or `unavailable`, with explicit reasons, and do not conflate missing history with request transport failure.

Keep native messages/parts intact under each segment; add evidence using message/part references or enclosing export entries without rewriting the original messages. Tool calls retain exact parsed arguments including absent/null/empty distinctions; tool results retain error flags and all recorded errors/recovery envelopes. An interrupted call remains unmatched with an explicit annotation; do not run the model-history repair hook merely to make the export look paired.

Use a JSON streaming writer based on Node streams that emits top-level fields, segments/messages, and artifacts incrementally; honor `drain` and abort on client disconnect. Serialize artifacts one at a time. Stream strings safely with JSON escaping (including quotes, backslashes, control characters, Unicode); do not build JSON by interpolating unescaped content. Do not include optional arbitrary file contents or global settings objects. Verify round-trip JSON equality for original transcript values.

### 4. Authenticated browser download and remove host writes

Add the GET handler as a small server module wired into `runtime-server.ts`. Resolve the existing workspace scope, verify that the task belongs to it, and invoke export assembly. Set `Content-Type: application/json; charset=utf-8`, `Content-Disposition: attachment; filename="..."`, and `Cache-Control: no-store`. Sanitize only the download filename; preserve the task ID in the bundle. Use existing origin checks and authentication; cross-origin clients must be able to read the filename header through the appropriate CORS expose header.

Validate/read the initial snapshot before starting the response so auth, missing-task, and initial read errors return a clear non-2xx JSON error. If streaming fails after headers, terminate the response; the browser must report failure instead of downloading an apparently complete success. Missing historical artifacts are represented as gaps rather than transport failures. Respect backpressure and disconnects; no background export continues after cancellation.

Replace the host-path export wrapper with a browser fetch helper using the existing runtime base URL and credential mechanism. Fetch the route, check status, await Blob creation, create an object URL, click a temporary anchor with the server filename, then remove it and revoke the URL after download initiation. Preserve an exporting state and reject duplicate export starts. Surface actionable errors; do not show a host-path or redaction toast. Success text: "Diagnostics download started."

Remove the old `bundlePath` response and write-to-host mutation from contracts/router/wrappers and all consumers. Do not leave a hidden disk-writing fallback. Existing manually created diagnostic files need not be deleted or migrated.

### 5. Expanded tool I/O visibility

In the expanded tool block, retain the existing readable run_commands rendering and also show the exact recorded JSON input for editor and other tools. Show output/error sections with labels and distinguish SDK-level errors from structured per-operation errors. Make JSON selectable/copyable; long content may use a scrollable block, but must not disappear solely because the tool is not run_commands. This UI should render recorded content as text, never execute HTML. Keep collapsed summaries unchanged. Archived full outputs need not be loaded into every chat block; the export includes them and the UI labels any persisted excerpt as such.

### 6. Tests and acceptance

- Builder tests: ordered user/reasoning/tool-call/tool-result/error messages; omitted versus null versus empty `old_text`; retained titles/review/activity text; no generic home/path/code redaction; operational fields retained.
- Session snapshot tests: durable-only task after runtime restart, live tail while running, empty/no session, multiple restarted segments, inherited IDs preserved/labeled, workspace mismatch rejected, corrupt transcript recorded as a gap/error. Use SDK-host fakes; do not boot real hosts in unit tests.
- Artifact tests: structured and both legacy reference styles, full output larger than 50,000 characters recovered beside its call, raw non-JSON content, missing artifact, invalid path, sibling-task reference and escaping symlink rejection. Isolate HOME/USERPROFILE using repository test helpers.
- Streaming tests: JSON round trips with control characters/Unicode/embedded quotes, large transcript plus multiple artifacts, backpressure and client disconnect, no truncated successful response, no host export/temp files created.
- HTTP integration: authenticated download with passcode enabled, unauthenticated rejection, origin rejection, missing/foreign workspace/task rejection, filename headers, no-store, initial error and stream failure behavior. Reuse runtime-server fixtures; never bypass auth in the production route.
- Browser tests: click starts one download with correct filename and JSON, duplicate click blocked, loading resets on success/failure, bad HTTP response/download failure shows an error, object URL cleaned up. Use existing browser/runtime test infrastructure.
- UI tests: expanded editor shows actual input with `old_text` present/absent, outputs and errors; run_commands readability unchanged; hostile markup displays as text.
- Run repository Biome formatting/checks on changed files, backend and web typechecks, focused suites, and applicable CI checks before committing. Do not run Prettier.

Manual acceptance: in a remote browser connected to ai-monster, export a stopped task with failed editor calls and a task with archived oversized command output. A browser file download must start without SSH or a host export path. Parse the downloaded JSON, find the failure in its conversation segment, and inspect the exact recorded input plus error. Verify an archived output is fully present beyond the model excerpt. Test with passcode authentication and after a Kanban restart. Confirm no new file appeared under `~/.cline/kanban/diagnostics` from either export.

## Completion and deployment

No new environment variables, account setup, services, storage directories or database migration. Deploy backend and frontend together because the host-path export contract is removed. Document the browser-download behavior, content caption and completeness/gap semantics in existing user-facing diagnostics documentation, and update B-10.7's old redacted-host-file requirement to describe the new behavior. Historical exports and missing historical evidence stay unchanged.

The implementation PR description must prominently include deployment instructions and tests for complete transcript context, full archived tool output, browser downloading and expanded tool input visibility. This plan PR changes documentation only and does not yet enable those features.
