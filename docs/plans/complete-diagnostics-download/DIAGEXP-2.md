# DIAGEXP-2 — Export snapshot, schemaVersion 3 builder, and streaming serializer

Part of the **complete task diagnostics as a browser download** feature. The master plan
lives in [PLAN.md](./PLAN.md). This document is a self-contained execution brief for the
additive export-pipeline PR (slice **DIAGEXP-2**). It represents a single PR.

| Field | Value |
| --- | --- |
| Document revision | 1 |
| Prepared | 2026-10-08 |
| Status | planned; no milestone started |
| Source baseline | `7a64060` (main) |
| Fork | https://github.com/billy-the-ape/kanban |
| Prerequisites | None — independent of DIAGEXP-0 and DIAGEXP-1 |
| Follow-on | DIAGEXP-3 wires this pipeline behind the extracted gate (DIAGEXP-1) and removes the old host-disk export contract |

## Purpose

Build the complete, unredacted export pipeline for a task's diagnostics:

- **2a** — a typed read-only export snapshot of all eligible session segments.
- **2b** — recovery of full tool output (artifacts) alongside its original transcript
  position, backed by a new append-only sidecar index.
- **2c** — the schemaVersion 3 bundle types, assembly helpers, and a Node-streams-based
  JSON streaming serializer.

All DIAGEXP-2 code is **additive**: no route, no UI, no contract change, and no user-visible
behavior change — the only runtime change is the sidecar-index write in 2b. The
schemaVersion 2 host-disk export (`src/core/task-diagnostics-export.ts` and the
`exportTaskDiagnostics` mutation in `src/trpc/runtime-api.ts`) stays untouched until
DIAGEXP-3.

The download these pieces will serve (DIAGEXP-3) is a complete JSON file on the user's
browser: all available task conversation history plus full tool input/output/error data in
chronological context, with no blanket content redaction, and no export bundle, cache, or
temporary download file written to the host disk. Existing session records and context
artifacts remain the sources of truth.

If the DIAGEXP-2 diff grows beyond one reviewable PR, its 2a/2b/2c sub-steps are
independent and additive and can be split into separate briefs at that point.

## Fixed decisions carried in from the master plan

These are settled. Implementation may choose local helper names and file layout, but not
the architecture or product rules.

1. **Download format** (frozen here, consumed by DIAGEXP-3): a single UTF-8 JSON file,
   `task-<safeTaskId>-<timestampMs>.json`, schemaVersion 3. No ZIP, external upload, new
   storage service, or new environment variables.
2. **Read-only export.** Never sends a model request, starts/restarts a session, compacts
   messages, or changes the board/task. Snapshotting a running task must not pause or
   mutate it.
3. **Session eligibility — three kinds**, all exported in creation order:
   - `kind: "task"`: native Cline sessions whose session IDs match
     `buildSessionIdPrefix(taskId)`, including the currently bound session even when its
     durable record is not yet created.
   - `kind: "review"` and `kind: "verification-repair"`: sessions started under task ids
     `<taskId>::review` and `<taskId>::verification-repair-N`
     (`cline-review-session-service.ts:53,62`). The SDK's `:` → `_` substitution
     (`WINDOWS_INVALID_SESSION_ID_CHARS`) makes their session IDs look like
     `<taskId>__review-…`, which does **not** start with the task prefix, so they must be
     matched by their task id, not by ID prefix. They live in the scoped review session
     service (`runtime-server.ts:192`), so each kind gets its own live tail; do not claim
     these segments come from the task's message repository.
   - Enumeration: `ClineCore.list(limit?)` defaults to 200 sessions across the whole SDK
     store, and the existing helpers call `list()` with no argument
     (`cline-session-runtime.ts:845, 932, 1055`). The export must enumerate with an explicit
     large limit or page until exhausted; if the returned count equals the limit, mark the
     transcript `partial` with reason "session listing may be truncated".
   - Ownership: compare the recorded `cwd` / `workspaceRoot` strings on the SDK session
     record (`SessionRuntimeRecordShape` in `@clinebot/shared`) against the task's worktree
     path or the workspace repo path — as recorded strings, not filesystem existence (Done
     task worktrees get disposed, B-5.7). Home-agent sessions use the repo checkout as
     `cwd`, so the repo path is a valid owner. Do not collect another workspace's history
     solely on a matching ID prefix.
4. **Segment integrity and labelling.** Preserve each session's original message ordering
   and parts; keep separate session segments (no destructive dedup or concatenation):
   - Seeded restarts: overflow restarts seed the new session with
     `compactTranscriptForRecovery(...)` output after `withoutFailedResend` has dropped
     messages (`cline-task-session-service.ts:612-647`, `cline-context-recovery.ts:208`).
     Label a tool call/result in the successor `origin: "seeded-or-compacted"` when its id
     is a member of the predecessor segment and `origin: "native"` when its id is not;
     `origin: "unknown"` only for messages with no id to test against. Never claim
     "inherited IDs preserved".
   - Live tail: SDK `MessageWithMetadata.id` and `ts` are both optional, and Kanban's live
     display ids are locally generated (`${taskId}-${now}-${rand}`,
     `cline-session-state.ts:129`), so user/assistant/reasoning text in the live tail
     cannot be matched to durable messages by id (only tool messages share a stable key:
     `meta.toolCallId` ↔ `tool_use.id` / `tool_result.tool_use_id`). Start point, fixed
     precedence: after the newest durable `ts` if any durable message has one; else after
     the last durable `tool_result` position; else the whole live list. The tail is
     labelled `representation: "kanban-display"` (a display/context view, not raw provider
     output) and flagged `possibleOverlap` rather than deduplicated where it may overlap
     durable messages.
5. **Completeness** is `complete`, `partial`, or `unavailable`, with explicit reasons.
   Complete means all evidence still available locally. Already deleted history and output
   lost before archival cannot be reconstructed; report those gaps explicitly rather than
   inventing content or claiming completeness. A truncated session listing (decision 3) is
   `partial`; a request transport failure is never represented as a missing-history gap.
6. **Segment header allowlist.** Export: `sessionId`, `kind`, `source`, `status`,
   `startedAt`/`endedAt`/`updatedAt`, `provider`, `model`, `cwd`, `workspaceRoot`,
   `exitCode`. Never export the record's raw `metadata` object, or its `prompt`,
   `messagesPath`, `hookPath`, or `pid`. One allowlisted exception:
   `taskLaunchConfig.systemPrompt`, `mode`, and `reasoningEffort` are exported (the SDK
   transcript contains only user/assistant turns; the system prompt is the context needed
   to explain model behaviour; `taskLaunchConfig` is credential-free by design, B-4.8).
   Provider credentials, auth headers, raw environment dumps, and passcode state remain
   excluded.
7. **Memory/serialization rule.** No hard truncation cap: retain all available output,
   including large artifacts. Host serialization must avoid holding a second giant JSON
   string, so artifacts are embedded as their exact raw text as a string with
   `contentFormat: "json-text" | "text"` — never `JSON.parse` and re-serialize (which would
   make 3+ in-memory copies of exactly the largest items); readers that want a parsed
   value parse the text themselves. Artifacts stream through a chunked JSON escaper reading
   with a UTF-8 `StringDecoder`, so a surrogate pair split across chunk boundaries is not
   corrupted — reading the whole file into one string would still be one full copy per
   artifact.
8. **Terminal agents** have no transcript or message store
   (`TerminalSessionManager.getSummary` returns only a `RuntimeTaskSessionSummary`), so for
   `source === "terminal"` the export emits
   `transcript: { status: "unavailable", reason: "terminal agent session; no structured transcript recorded" }`
   plus the session summary, and does not claim unsupported raw tool calls were captured.

## Scope

Allowed:

- `src/cline-sdk/cline-session-runtime.ts` — the typed read-only export snapshot method
  (durable records/messages through the boundary, explicit large-list enumeration).
- `src/cline-sdk/cline-task-session-service.ts` — export snapshot method over the bound
  task session including live-tail merge (decision 4); existing context/UI methods
  unchanged.
- `src/cline-sdk/cline-review-session-service.ts` — small read-only interface addition:
  extend `ClineReviewSessionService` (interface at `:105-112`, which today exposes no
  messages) with, e.g., `getSessionExportSnapshot(taskId)` delegating to its underlying
  `ClineTaskSessionService` export snapshot.
- `src/trpc/runtime-api.ts` — thread the scoped review session service through the existing
  `getScopedReviewSessionService` dependency in `CreateRuntimeApiDependencies` so the
  snapshot can reach review/verification-repair live tails (dependency typing only; no
  new procedures).
- `src/cline-sdk/sdk-runtime-boundary.ts` — SDK import boundary; derive transcript types
  from SDK types here. Do not scan guessed SDK paths or export raw credential-bearing
  session config.
- `src/workspace/task-artifacts.ts` — the append-only sidecar index written by
  `writeTaskContextArtifact` (2b) and the untrusted-reference resolution rules.
- `src/core/` (new module or extension of `task-diagnostics-export.ts`'s neighborhood) —
  schemaVersion 3 typed structures, assembly helpers, and the streaming JSON writer (2c).
  The schemaVersion 2 redaction builder stays in place.
- Tests under `test/` (runtime, cline-sdk, workspace as needed).

Explicit non-goals:

- No HTTP route, no UI, no contract change (`api-contract.ts` untouched until DIAGEXP-3),
  no user-visible behavior change.
- No changes to the schemaVersion 2 host-disk export or the `exportTaskDiagnostics`
  mutation.
- No changes to model context limits and no stopping the bounding of oversized model-facing
  results (`cline-tool-result-bounding-hook.ts` behaviour is unchanged; the sidecar index
  is additive metadata written alongside the existing artifact).
- No raw `metadata`/`prompt`/`messagesPath`/`hookPath`/`pid` export, no arbitrary file
  contents, no global settings objects.

## Source map (reinspect before editing; baseline is historical)

- `src/cline-sdk/cline-session-runtime.ts` — session binding, `readPersistedTaskSession`,
  SDK `list` (no-arg calls at `:845, 932, 1055` — the 200-default trap), and SDK
  `readMessages`.
- `src/cline-sdk/cline-task-session-service.ts` — live UI messages,
  `loadTaskSessionMessages`, `getTaskContextSnapshot` (display/context views, not a raw
  export source); seeded-restart seeding at `:612-647`.
- `src/cline-sdk/cline-session-state.ts` — `buildSessionIdPrefix` (`:154`) and locally
  generated live message IDs (`:129`).
- `src/cline-sdk/cline-task-launch-config.ts` — resolved launch config, including the full
  system prompt, under `metadata["kanban.taskLaunchConfig"]` (credential-free, B-4.8).
- `src/cline-sdk/cline-review-session-service.ts` — review (`:53`) and
  verification-repair (`:62`) sessions started via `startTaskSession({ taskId: id })` at
  `:366`; interface at `:105-112` exposes no messages today.
- `src/workspace/task-artifacts.ts` — task-scoped `context-artifacts` directory and full
  serialized output files named `<sanitized toolCallId>-<ts>-<rand>.txt` (`:40`);
  `writeTaskContextArtifact` is the 2b index writer.
- `src/cline-sdk/cline-tool-result-bounding-hook.ts` / `cline-command-output-excerpt.ts` —
  `buildBoundedToolResultExcerpt` and `buildCommandOutputExcerpt` emit the `Full content:`
  and `full output:` prose paths that the 2b legacy parser consumes.
- `src/fs/locked-file-system.ts` — `withLock`/`writeTextFileAtomic`; the `lock: null`
  option (`:118-123`) exists for nested same-path writes. proper-lockfile keys its
  in-process `locks` map by the resolved `path` argument, **not** by `lockfilePath` —
  distinct locks need distinct `path` values.
- `src/core/api-contract.ts` / `src/trpc/runtime-api.ts` — `gatherTaskDiagnosticsSnapshot`
  and `buildTaskDiagnosticsResponse` operational fields (title, review details,
  warning/activity text, dispatch data, workspace paths, diagnostics errors) that the
  schemaVersion 3 bundle carries over; `gatherTaskDiagnosticsCore` returns `task: null`
  for unknown ids (DIAGEXP-3's route must guard membership itself).

## Implementation tasks (in this order)

- [ ] DIAGEXP-2.1 **2a: Export-specific transcript snapshot.** Add a typed read-only export
      snapshot method to the session runtime and task-session service (existing context/UI
      methods unchanged). Read SDK session records and messages through the boundary,
      deriving transcript types from SDK types. Return an immutable snapshot of all
      eligible session segments (decision 3), session IDs, allowlisted headers (decision 6),
      ordered raw messages, and the export capture time. Preserve user/assistant/reasoning/
      tool-call/tool-result parts, IDs where present, timestamps, original argument values,
      output values and error flags. Use durable messages as the main source, merging any
      not-yet-persisted live tail per decision 4 (fixed start precedence,
      `representation: "kanban-display"`, `possibleOverlap`, no dedup). Review and
      verification-repair segments read their live tail through the new
      `getSessionExportSnapshot` interface addition, threaded through
      `getScopedReviewSessionService` in `CreateRuntimeApiDependencies` (the test-harness
      impact of that threading belongs to this PR's tests). Record a capture time and note
      that later activity is outside this export; snapshotting must not pause or mutate a
      running task. A task with no native Cline transcript still yields operational
      diagnostics with a clear transcript availability status; a failed read of an expected
      existing transcript is a failure/gap, not an empty successful transcript. Terminal
      agents per decision 8.
- [ ] DIAGEXP-2.2 **2b: Recover full tool output alongside its original transcript
      position.** For every tool-result part, retain the persisted result exactly and
      locate any associated full-output artifact:
      - Primary: an append-only sidecar index in the task's `context-artifacts/` directory,
        written by `writeTaskContextArtifact`, mapping `toolCallId` → artifact file name.
        Write discipline: parallel tool calls can fire the hook concurrently, so take
        `withLock` on the index file with a `path` distinct from the artifact files'/
        directory's lock, then read-append and write with
        `writeTextFileAtomic(indexPath, content, { lock: null })` — the `lock: null` option
        exists for exactly this nesting case, because the default would take a second lock
        on the same path and self-deadlock with `ELOCKED` after the retry window. An index
        write failure is treated like the existing artifact-write failure: log it, still
        return the excerpt, and let the export fall back to filename lookup.
      - Fallback: deterministic file-name lookup (artifacts are named
        `<sanitized toolCallId>-<ts>-<rand>.txt`, `task-artifacts.ts:40`); sanitisation plus
        the 80-char cap can collide, so a multi-match becomes an explicit "ambiguous" gap.
      - Legacy: parse the prose paths emitted by `buildBoundedToolResultExcerpt` and
        `buildCommandOutputExcerpt` (both `Full content:` and `full output:` forms), for
        pre-existing sessions only.
      Treat all references as untrusted: resolve and realpath them, require containment
      within `getTaskContextArtifactsDir(taskId)`, reject symlinks that escape it and
      non-files, and never follow arbitrary paths quoted in tool text. Do not
      enumerate/include unrelated files or artifacts from another task.
      Each tool-result export entry includes the original persisted result plus linked
      `fullOutput` evidence: artifact identity, and exact raw artifact text with
      `contentFormat: "json-text" | "text"` (decision 7); no parsed copy is embedded. Pair
      it to `toolCallId` and keep it attached to that result's message/part position; never
      append anonymous output dumps at the end. Do not substitute a parsed artifact as proof
      of the original provider response: it is the tool output archived by Kanban.
      Missing, unreadable or ambiguous artifacts produce explicit per-result gaps and
      top-level completeness warnings while the rest remains downloadable. A bounded
      excerpt with no surviving artifact must be labelled incomplete.
- [ ] DIAGEXP-2.3 **2c: SchemaVersion 3 bundle and streaming serializer.** Add typed export
      structures and assembly helpers for the schemaVersion 3 bundle (the schemaVersion 2
      redaction builder stays in place). Keep the operational fields from
      `RuntimeTaskDiagnosticsResponse` (task title, review details, warning/activity text,
      dispatch data, workspace paths and diagnostics errors). Add capture metadata,
      chronological session segments, live tails, tool evidence, completeness status and
      gap reasons (decision 5).
      Keep native messages/parts intact under each segment; add evidence using message/part
      references or enclosing export entries without rewriting the original messages. Tool
      calls retain exact parsed arguments including absent/null/empty distinctions; tool
      results retain error flags and all recorded errors/recovery envelopes. An interrupted
      call remains unmatched with an explicit annotation; do not run the model-history
      repair hook merely to make the export look paired.
      Use a JSON streaming writer based on Node streams that emits top-level fields,
      segments/messages, and artifacts incrementally; honor `drain` and abort on client
      disconnect. Serialize artifacts one at a time under decision 7's memory rule (exact
      raw text as a string, no parse-then-reserialise). Stream strings safely with JSON
      escaping (quotes, backslashes, control characters, Unicode); do not build JSON by
      interpolating unescaped content. Do not include optional arbitrary file contents or
      global settings objects.
- [ ] DIAGEXP-2.4 **Tests** — see the acceptance tables below.

## Acceptance and tests

Unit suites must not boot real SDK hosts — use SDK-host fakes. Tests touching workspace
state or task artifacts redirect `process.env.HOME` (and `USERPROFILE`) to a temp dir in
`beforeEach` and restore in `afterEach`, using repository test helpers.

### 2a snapshot tests

| Scenario | Required result |
| --- | --- |
| Durable-only task after runtime restart | Snapshot matches durable records; no live tail |
| Live tail while running | Merged per decision 4's fixed precedence; `representation: "kanban-display"`; `possibleOverlap` flagged, not deduplicated |
| Review live tail while a review is running | Reached via `getSessionExportSnapshot`; `kind: "review"`; not claimed from the task's message repository |
| Empty/no session | Clean availability status; operational diagnostics still present |
| Multiple restarted segments | Separate segments, creation order; seeded-restart labelling: `origin: "seeded-or-compacted"` / `"native"` / `"unknown"` per decision 4 |
| Workspace mismatch | Rejected — a matching ID prefix from another workspace is not collected |
| Corrupt transcript | Recorded as a gap/error, not an empty successful transcript |
| >200 fake records, task's oldest segment past the default 200 window | `partial` with reason "session listing may be truncated" |
| `source === "terminal"` | `transcript: { status: "unavailable", reason: "terminal agent session; no structured transcript recorded" }` plus summary |
| `ClineReviewSessionService` threading | Test harness updated for the new dependency path; no harness fakes conceal the interface addition |

### 2b artifact tests

| Scenario | Required result |
| --- | --- |
| Index-based reference | Full output recovered via the sidecar index beside its original call position |
| Both legacy reference styles | `Full content:` and `full output:` prose paths resolved for pre-existing sessions |
| Full output larger than 50,000 characters | Recovered beside its call; exact text, `contentFormat` correct |
| Raw non-JSON content | `contentFormat: "text"`; no parse attempt |
| Missing artifact | Explicit per-result gap + top-level completeness warning; rest downloadable |
| Invalid path | Rejected; gap recorded |
| Sibling-task reference | Rejected — nothing from another task included |
| Escaping symlink | Rejected |
| Ambiguous multi-match (sanitisation/80-char collision) | Explicit "ambiguous" gap |
| Two concurrent `writeTaskContextArtifact` calls | Both entries land in the index and complete well under the lock-retry window (no self-deadlock) |

### 2c serializer tests

| Scenario | Required result |
| --- | --- |
| JSON round-trip | Equality for original transcript values with control characters, Unicode, embedded quotes |
| Large transcript + multiple artifacts | Streamed one at a time (no second giant string; no parse-then-reserialise) |
| Backpressure and client disconnect | `drain` honored; abort on disconnect; no truncated successful response |
| Host side effects | No host export or temp files created |

Run: the focused runtime / cline-sdk / workspace suites, backend typecheck, Biome on
changed files, and the repository's required checks. Do not run Prettier.

## Settings, rollout, and documentation

No new environment variables, configuration, services, or storage directories beyond the
sidecar index inside the task's existing `context-artifacts/` directory. Additively
deployable with no user-visible behavior change (only the sidecar-index write). The PR
description must state that this PR ships no route/UI/contract change, that the
schemaVersion 2 export is untouched, and that the only runtime behavior change is the
index write.

## Handoff

Record: changed files, the export snapshot method signatures (runtime, task-session
service, review-service `getSessionExportSnapshot`), the sidecar index location/format and
its distinct lock `path` choice, the schemaVersion 3 structure surface and the streaming
writer API (DIAGEXP-3 consumes it), test commands and results, and any baseline drift
discovered against `7a64060`. DIAGEXP-3 wires the GET route behind the DIAGEXP-1 gate,
implements the browser download and CLI repoint, and removes the old host-disk export
contract in one commit.

## Stop conditions

- The diff for 2a+2b+2c is no longer one reviewable PR — split 2a/2b/2c into separate
  briefs/files per the master plan rather than shipping one giant PR.
- A test requires a real SDK host boot or a real network — rework the fixture (SDK-host
  fakes).
- Recovering a full output would require exporting data outside the task's recorded
  evidence (credentials, env dumps, other tasks' files, arbitrary paths) — record the gap
  instead of adding the export.
