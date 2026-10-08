# Complete task diagnostics as a browser download

Status: implementation-ready plan; no runtime behavior changes in this PR.
Target: billy-the-ape/kanban main. Source baseline: `7a64060`.

Implemented as three numbered briefs, each one PR / one squash commit, in this order. Every push to `main` auto-deploys (`docs/deployment/ai-monster.md`), so each brief must leave `main` in a deployable state:

- **DIAG-0** — Expanded tool I/O visibility in the chat panel. Independent of the other briefs; immediately closes the `0e05l` editor-input visibility gap.
- **DIAG-1** — Additive export snapshot, schemaVersion 3 builder, and streaming serializer, unwired. The schemaVersion 2 host-disk export is untouched.
- **DIAG-2** — HTTP download route, browser download, CLI repoint, old contract/consumer removal, and docs.

All open decisions (artifact metadata mechanism, session eligibility, overlap/inheritance labeling, route placement, CLI fate, test layers) are resolved in this plan; the implementer makes no product or operator decisions.

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
- `src/server/runtime-server.ts`, `middleware.ts`: HTTP handling and origin checks; the inline passcode/session/bearer gate lives in `requestHandler` (`:452-477`), unmatched `/api/` paths 404 at `:493`, and the session cookie is `SameSite=Strict; HttpOnly` (`:436-443`). The scoped review session service is at `:192`.
- `src/commands/task.ts`: `taskExportDiagnosticsCommand` (`:1339`) calls the write-to-host mutation; registered as `export-diag` with the description "Write the task's redacted diagnostic bundle to ~/.cline/kanban/diagnostics/…" (`:1800-1801`).
- `src/cline-sdk/cline-review-session-service.ts`: review and verification-repair sessions (`:53,:62`, started via `startTaskSession({ taskId: id })` at `:366`); they live in a separate in-memory scoped service, not the task's message repository.
- `src/cline-sdk/cline-session-state.ts`: `buildSessionIdPrefix` (`:154`) and locally generated live message IDs (`:129`).
- `src/cline-sdk/cline-task-launch-config.ts`: stores the resolved launch config, including the full system prompt, under `metadata["kanban.taskLaunchConfig"]`.
- `web-ui/src/hooks/use-task-diagnostics.ts`, `runtime/task-diagnostics.ts`, `components/detail-panels/task-diagnostics-panel.tsx`: export action and host-path toast.
- `web-ui/src/components/detail-panels/cline-chat-message-utils.ts` / `cline-chat-message-item.tsx`: expanded tool rendering.
- Existing tests: `test/runtime/core/task-diagnostics-export.test.ts`, runtime/session-service suites, bounding-hook suites, and web UI tests. Note: no test boots `createRuntimeServer` — `test/runtime/server/ws-upgrade-passcode.test.ts` deliberately re-implements the gate logic instead — and no user-facing diagnostics documentation exists in `docs/README.md`, `docs/architecture.md`, or `README.md`.

## Decisions and boundaries

1. Download format is a single UTF-8 JSON file, `task-<safeTaskId>-<timestampMs>.json`, schemaVersion 3. No ZIP, external upload, new storage service, or new environment variables.
2. Export is explicit and read-only. It never sends a model request, starts/restarts a session, compacts messages, or changes the board/task.
3. Export all retained sessions for the task, in creation order, in three kinds:
   - `kind: "task"`: native Cline sessions whose session IDs match `buildSessionIdPrefix(taskId)`, including the currently bound session even when its durable record is not yet created.
   - `kind: "review"` and `kind: "verification-repair"`: sessions started under task ids `<taskId>::review` and `<taskId>::verification-repair-N` (`cline-review-session-service.ts:53,62`). The SDK's `:` → `_` substitution (`WINDOWS_INVALID_SESSION_ID_CHARS`) makes their session IDs look like `<taskId>__review-…`, which does **not** start with the task prefix, so they must be matched by their task id, not by ID prefix. They live in the scoped review session service (`runtime-server.ts:192`), so each kind gets its own live tail; do not claim these segments come from the task's message repository.
   - Enumeration: `ClineCore.list(limit?)` defaults to 200 sessions across the whole SDK store (every task and workspace), and the existing helpers call `list()` with no argument (`cline-session-runtime.ts:845, 932, 1055`). The export must enumerate with an explicit large limit or page until exhausted; if the returned count equals the limit, mark the transcript `partial` with reason "session listing may be truncated".
   - Ownership: compare the recorded `cwd` / `workspaceRoot` strings on the SDK session record (`SessionRuntimeRecordShape` in `@clinebot/shared`) against the task's worktree path or the workspace repo path — as recorded strings, not filesystem existence (Done-task worktrees get disposed, B-5.7). Home-agent sessions use the repo checkout as `cwd`, so the repo path is a valid owner. Do not collect another workspace's history solely on a matching ID prefix.
4. Preserve each session's original message ordering and parts. Keep separate session segments; do not destructively deduplicate or concatenate them into a misleading single conversation. ID-based matching is not general, so use these concrete labeling rules:
   - Seeded restarts: overflow restarts seed the new session with `compactTranscriptForRecovery(...)` output, after `withoutFailedResend` has dropped messages (`cline-task-session-service.ts:612-647`, `cline-context-recovery.ts:208`), so a successor segment's prefix is a compacted/possibly synthesized transcript that may carry no ids. Label a seeded message `origin: "seeded-or-compacted"` when its tool-call id is a member of the predecessor segment, otherwise `origin: "unknown"`. Never claim "inherited IDs preserved".
   - Live tail: SDK `MessageWithMetadata.id` is optional, and Kanban's live display ids are locally generated (`${taskId}-${now}-${rand}`, `cline-session-state.ts:129`), so user/assistant/reasoning text in the live tail cannot be matched to durable messages by id (only tool messages share a stable key: `meta.toolCallId` ↔ `tool_use.id` / `tool_result.tool_use_id`). The live tail starts after the last durable `tool_result` (or last durable timestamp), is labelled `representation: "kanban-display"` (a display/context view, not raw provider output), and is flagged `possibleOverlap` rather than deduplicated where it may overlap durable messages.
5. Completeness is `complete`, `partial`, or `unavailable`, with explicit reasons. Complete means all evidence still available locally. Already deleted history and output lost before archival cannot be reconstructed; report those gaps explicitly rather than inventing content or claiming completeness. A truncated session listing (decision 3) is `partial`, and a request transport failure is never represented as a missing-history gap.
6. Segment headers export an explicit field allowlist: `sessionId`, `kind`, `source`, `status`, `startedAt`/`endedAt`/`updatedAt`, `provider`, `model`, `cwd`, `workspaceRoot`, `exitCode`. Never export the record's raw `metadata` object, or its `prompt`, `messagesPath`, `hookPath`, or `pid`. One allowlisted exception: `taskLaunchConfig.systemPrompt`, `mode`, and `reasoningEffort` are exported, because the SDK transcript (`Message[]`) contains only user/assistant turns and the system prompt is the context needed to explain model behaviour (the `0e05l` incident was about editor-argument behaviour, which Kanban shapes through system-prompt guidance); `taskLaunchConfig` is credential-free by design (B-4.8). Provider credentials, auth headers, raw environment dumps, and passcode state remain excluded.
7. Transport is a dedicated authenticated HTTP GET on the existing runtime origin, `/api/task-diagnostics/download?workspaceId=<id>&taskId=<id>`, dispatched in `runtime-server.ts` **after** the inline passcode/session/bearer gate (`:452-477`) and **before** the unmatched-`/api/` 404 (`:493`). Browser authentication is the `SameSite=Strict; HttpOnly` session cookie, sent automatically for same-origin requests; in every supported topology the browser is same-origin (prod serves the UI from the runtime origin, dev uses the `web-ui/vite.config.ts` proxy), so no `Access-Control-Expose-Headers` requirement is needed — the client builds the filename from `taskId` and does not depend on reading `Content-Disposition`. The internal bearer token stays a CLI-only concern. Do not invent a second auth mechanism, put auth tokens in URLs, or allow caller-supplied filesystem paths.
   - Task membership: the task must exist on the scoped workspace board (any column, including trash), else a 404 JSON error. Check this before touching the filesystem — `taskId` comes from the query string and feeds `getTaskContextArtifactsDir` and `buildSessionIdPrefix` (`normalizeTaskIdForWorktreePath` only rejects separators and `..`), and `gatherTaskDiagnosticsCore` returns `task: null` for unknown ids rather than failing, so without this rule the route would happily "export" nonexistent or foreign ids. Permanently deleted tasks (sessions cleared by `clearTaskSessions`) also return 404.
8. Stream the JSON response with backpressure; do not put the whole bundle or base64 content through tRPC. No hard truncation cap: retain all available output, including large artifacts. Browser fetch collects the response into a Blob for download. Host serialization must avoid holding a second giant JSON string, so artifacts are embedded as their exact raw text as a string with `contentFormat: "json-text" | "text"` — never `JSON.parse` and re-serialize (which would make 3+ in-memory copies of exactly the largest items). Optionally also embed the parsed JSON value below a size threshold, never truncating either.
9. Terminal agent sessions have no transcript or message store (`TerminalSessionManager.getSummary` returns only a `RuntimeTaskSessionSummary`), so for `source === "terminal"` the export emits `transcript: { status: "unavailable", reason: "terminal agent session; no structured transcript recorded" }` plus the session summary, and does not claim unsupported raw tool calls were captured.

## Implementation sequence

### DIAG-0: Expanded tool I/O visibility (1 PR)

In the expanded tool block, retain the existing readable `run_commands` rendering and also show the exact recorded JSON input for editor and other tools, with output/error sections, distinguishing SDK-level errors from structured per-operation errors. Make JSON selectable/copyable; long content may use a scrollable block, but must not disappear solely because the tool is not `run_commands`. Render recorded content as text, never execute HTML. Keep collapsed summaries unchanged.

- The existing full-input block is hard-labelled "Command" (`cline-chat-message-item.tsx:80`); once it also shows editor/other JSON, the label must read `Input` for non-`run_commands` tools.
- The expanded view parses the display string by line prefix (`parseToolMessageContent`: lines equal to `Input:`/`Output:`/`Error:`/`Duration:` switch sections). Pretty-printed JSON inputs are safe (strings are escaped), but a raw string output containing a line that is exactly `Error:` would be mis-sectioned — note this limitation and cover it with a test.
- "The UI labels any persisted excerpt as such" means detecting `Full content:` / `full output:` / `...[truncated` in the persisted prose — the exact parsing the export avoids, deliberately fine for the UI.
- Archived full outputs need not be loaded into every chat block; the export includes them.

Tests (ship with DIAG-0): expanded editor block shows actual input with `old_text` present/absent; outputs and errors; `run_commands` readability unchanged; hostile markup displays as text; a raw output line that is exactly `Error:` is handled per the noted limitation.

### DIAG-1: Export snapshot, builder, and streaming serializer (1 PR, additive and unwired)

All DIAG-1 code is additive: no route, no UI, no contract change. The schemaVersion 2 host-disk export and its mutation stay untouched until DIAG-2.

#### 1a. Export-specific transcript snapshot

Add a typed read-only export snapshot method to the session runtime and task-session service. Keep existing context/UI methods unchanged. Read SDK session records and messages through the boundary, deriving transcript types from SDK types; do not scan guessed SDK paths or export raw credential-bearing session config.

Return an immutable snapshot of all eligible session segments (decision 3), session IDs, allowlisted headers (decision 6), ordered raw messages, and the export capture time. Preserve user/assistant/reasoning/tool-call/tool-result parts, IDs where present, timestamps, original argument values, output values and error flags.

Use durable messages as the main source, merging any not-yet-persisted live tail per decision 4 (starts after the last durable `tool_result`/timestamp, labelled `representation: "kanban-display"`, flagged `possibleOverlap`, not deduplicated). Review and verification-repair segments (decision 3) read their live tail from the scoped review session service. Snapshotting a running task must not pause or mutate it; record a capture time and note that later activity is outside this export.

A task with no native Cline transcript still downloads operational diagnostics with a clear transcript availability status. A failed read of an expected existing transcript is a failure/gap, not an empty successful transcript. Terminal agents are handled per decision 9.

Tests (ship with DIAG-1): durable-only task after runtime restart; live tail while running; empty/no session; multiple restarted segments; seeded/compacted labelling (`origin: "seeded-or-compacted"` vs `unknown`); workspace mismatch rejected; corrupt transcript recorded as a gap/error; a snapshot test with >200 fake records where the task's oldest segment sits past the default 200 window and yields `partial` with reason "session listing may be truncated". Use SDK-host fakes; do not boot real hosts in unit tests.

#### 1b. Recover full tool output alongside its original transcript position

For every tool-result part, retain the persisted result exactly and locate any associated full-output artifact:

- Primary: an append-only sidecar index in the task's `context-artifacts/` directory, written by `writeTaskContextArtifact`, mapping `toolCallId` → artifact file name. This is resolved now, not deferred: the SDK's persisted `ToolResultContent` and runtime `AgentToolResultPart` carry no result-metadata field, and message-level `MessageWithMetadata.metadata` is not settable from tool hooks, so a Kanban-owned mechanism is required.
- Fallback: deterministic file-name lookup — artifacts are named `<sanitized toolCallId>-<ts>-<rand>.txt` (`task-artifacts.ts:40`) — but sanitisation plus the 80-char cap can collide, so a multi-match becomes an explicit "ambiguous" gap.
- Legacy: parse the prose paths emitted by `buildBoundedToolResultExcerpt` and `buildCommandOutputExcerpt` (both `Full content:` and `full output:` forms), for pre-existing sessions only.

Treat all references as untrusted: resolve and realpath them, require containment within `getTaskContextArtifactsDir(taskId)`, reject symlinks that escape it and non-files, and never follow arbitrary paths quoted in tool text. Do not enumerate/include unrelated files or artifacts from another task.

Each tool-result export entry includes the original persisted result plus linked `fullOutput` evidence: artifact identity, exact raw artifact text with `contentFormat: "json-text" | "text"` (decision 8), and optionally the parsed JSON value below a size threshold. Pair it to `toolCallId` and keep it attached to that result's message/part position; never append anonymous output dumps at the end. Do not substitute a parsed artifact as proof of the original provider response: it is the tool output archived by Kanban.

Missing, unreadable or ambiguous artifacts produce explicit per-result gaps and top-level completeness warnings while the rest remains downloadable. A bounded excerpt with no surviving artifact must be labelled incomplete. Do not change model context limits or stop bounding oversized model-facing results.

Tests (ship with DIAG-1): index-based references, both legacy reference styles, full output larger than 50,000 characters recovered beside its call, raw non-JSON content, missing artifact, invalid path, sibling-task reference, escaping symlink rejection, ambiguous multi-match gap. Isolate HOME/USERPROFILE using repository test helpers.

#### 1c. SchemaVersion 3 bundle and streaming serializer

Add typed export structures and assembly helpers for the schemaVersion 3 bundle (the schemaVersion 2 redaction builder stays in place until DIAG-2 removes it). Keep the operational fields from `RuntimeTaskDiagnosticsResponse`, including task title, review details, warning/activity text, dispatch data, workspace paths and diagnostics errors. Add capture metadata, chronological session segments, live tails, tool evidence, completeness status and gap reasons (decision 5).

Keep native messages/parts intact under each segment; add evidence using message/part references or enclosing export entries without rewriting the original messages. Tool calls retain exact parsed arguments including absent/null/empty distinctions; tool results retain error flags and all recorded errors/recovery envelopes. An interrupted call remains unmatched with an explicit annotation; do not run the model-history repair hook merely to make the export look paired.

Use a JSON streaming writer based on Node streams that emits top-level fields, segments/messages, and artifacts incrementally; honor `drain` and abort on client disconnect. Serialize artifacts one at a time under decision 8's memory rule (exact raw text as a string, no parse-then-reserialise). Stream strings safely with JSON escaping (including quotes, backslashes, control characters, Unicode); do not build JSON by interpolating unescaped content. Do not include optional arbitrary file contents or global settings objects.

Tests (ship with DIAG-1): JSON round-trip equality for original transcript values with control characters/Unicode/embedded quotes; large transcript plus multiple artifacts streamed one at a time; backpressure and client disconnect; no truncated successful response; no host export or temp files created.

### DIAG-2: Download route, browser download, CLI, old-contract removal, and docs (1 PR)

#### 2a. Extract the HTTP auth gate for testability

No test boots `createRuntimeServer`, and the gate plus workspace-scope resolution is inline in `requestHandler` (`runtime-server.ts:376-477`); `ws-upgrade-passcode.test.ts` re-implements the logic instead. Extract the gate (and workspace-scope resolution) into a function that `requestHandler`, the new download route, and the tests all call, so the integration cases below exercise production code rather than a re-implementation.

#### 2b. GET download route

Add the GET handler as a small server module wired into `runtime-server.ts`, dispatched **after** the gate and **before** the unmatched-`/api/` 404 (decision 7). Resolve the existing workspace scope, apply the task-membership rule (decision 7), and invoke export assembly. Set `Content-Type: application/json; charset=utf-8`, `Content-Disposition: attachment; filename="..."`, and `Cache-Control: no-store`. Sanitize only the download filename; preserve the task ID in the bundle.

Validate/read the initial snapshot before starting the response so auth, missing-task, and initial read errors return a clear non-2xx JSON error. If streaming fails after headers, terminate the response; the browser must report failure instead of downloading an apparently complete success. Missing historical artifacts are represented as gaps rather than transport failures. Respect backpressure and disconnects; no background export continues after cancellation.

#### 2c. Browser download

Replace the host-path export wrapper with a browser fetch helper: `fetch("/api/task-diagnostics/download?workspaceId=…&taskId=…", { credentials: "same-origin" })`. There is no "runtime base URL" helper in web-ui (the tRPC client uses the relative `/api/trpc`), and the `SameSite=Strict; HttpOnly` session cookie is sent automatically for same-origin requests; this path authenticates via the cookie only — the internal bearer token is a CLI concern (2d).

Check status, await Blob creation, create an object URL, click a temporary anchor with the client-built filename, then remove it and revoke the URL after download initiation. Preserve an exporting state and reject duplicate export starts. Surface actionable errors; do not show a host-path or redaction toast. Success text: "Diagnostics download started."

#### 2d. CLI

`kanban task export-diag` (`task.ts:1339`, registered at `:1800`) is repointed at the new GET route — not removed — because it is the CLI/JSON equivalent of the button (B-10.5). Authenticate with the internal bearer token, which the gate already accepts (`runtime-server.ts:456`). Stream the response body to `--output <file>` or stdout; never write to `~/.cline/kanban/diagnostics`. Update the command description text (`task.ts:1801`).

#### 2e. Remove the write-to-host export in the same commit

- `runtimeDiagnosticsExportRequestSchema` / response schemas in `src/core/api-contract.ts:2353-2366`
- `exportTaskDiagnostics` type at `src/trpc/app-router.ts:310` and the `workspaceProcedure` at `:629`
- `parseDiagnosticsExportRequest` in `src/core/api-validation.ts:379`
- `exportTaskDiagnostics` mutation in `src/trpc/runtime-api.ts` (including the `lockedFileSystem.writeTextFileAtomic` write)
- `buildTaskDiagnosticsExportBundle` (the schemaVersion 2 redaction builder) in `src/core/task-diagnostics-export.ts`
- The old wrapper in `web-ui/src/hooks/use-task-diagnostics.ts` / `runtime/task-diagnostics.ts`

Do not leave a hidden disk-writing fallback. Existing manually created diagnostic files need not be deleted or migrated.

Tests (ship with DIAG-2, against the extracted gate / booted server): authenticated download with passcode enabled; unauthenticated rejection; origin rejection; missing/foreign workspace or task rejection; filename headers and no-store; initial error and stream failure behavior; no test references the removed contract/procedure. Never bypass auth in the production route.

Browser test layer: jsdom with mocked `fetch` / `URL.createObjectURL` / anchor click covers one download per click with the correct filename, duplicate-click blocking, loading reset on success/failure, bad HTTP/download failure error, and object-URL cleanup. A real download event with the right filename and parseable JSON is asserted with Playwright against a booted runtime (using the server/gate fixture from 2a).

#### 2f. Docs

- New `docs/runtime/diagnostics-export.md` documents the browser-download behavior, content caption, and completeness/gap semantics, linked from `docs/README.md`. No existing user-facing diagnostics documentation exists to update.
- Update B-10.7's old redacted-host-file requirement in all three places: `docs/plans/B-10.md:191` (the requirement "Exclude API keys, prompts, private code, and raw environment by default"), `docs/plans/B-10.md:201` (acceptance: "Tests cover … redaction"), and `docs/plans/B_IMPLEMENTATION_PLAN.md:528` (the unchecked copy). Keep the wording explicit that provider credentials and raw environment dumps remain excluded while prompts and code are now included, so the history does not read as a silent policy flip.
- CLI help text updated per 2d.

Manual acceptance (DIAG-2): in a remote browser connected to ai-monster, export a stopped task with failed editor calls and a task with archived oversized command output. A browser file download must start without SSH or a host export path. Parse the downloaded JSON, find the failure in its conversation segment, and inspect the exact recorded input plus error. Verify an archived output is fully present beyond the model excerpt. Test with passcode authentication and after a Kanban restart. Confirm no new file appeared under `~/.cline/kanban/diagnostics` from either export, and that `kanban task export-diag` writes to the requested file, not `~/.cline/kanban/diagnostics`.

Every brief runs repository Biome formatting/checks on changed files, backend and web typechecks, its focused suites, and applicable CI checks before committing. Do not run Prettier.

## Completion and deployment

No new environment variables, account setup, services, storage directories or database migration. Each brief is independently deployable: DIAG-0 is UI-only; DIAG-1 is additive with zero behavior change; DIAG-2 wires the new route and removes the old host-disk export contract in one commit, so its backend and frontend deploy together.

Deployment note for DIAG-2: because the host-path export contract is removed, an already-open browser tab running the old UI will see a "runtime request error" on Export until it is reloaded.

Historical exports and missing historical evidence stay unchanged.

The implementation PR description must prominently include deployment instructions and tests for complete transcript context, full archived tool output, browser downloading and expanded tool input visibility. This plan PR changes documentation only and does not yet enable those features.
