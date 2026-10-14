# Task quality diagnostics summary

Status: ready for implementation; one follow-up PR into main.

## Goal and scope

Help an operator choose completed tasks for a later eight-task reliability study:
two smooth/fast, two slow, two with edit loops, and two with review/restart/recovery.
Categories may overlap. Add a compact summary to the existing diagnostics panel;
do not build a dashboard, change prompts, change sampling, or start model calls.

The preceding UI change exposes the existing latest-session timestamps, state,
and start-to-last-activity span. That span includes waits and can reflect restored
metadata. It is **not** total executing-agent time. The existing context estimate
is a current snapshot, **not** cumulative token usage.

## Verified data sources

- `web-ui/src/components/detail-panels/task-diagnostics-panel.tsx` renders
  `RuntimeTaskDiagnosticsResponse` from `useTaskDiagnostics`.
- `src/core/api-contract.ts` currently exposes only a latest-session summary and
  chars/4 context estimates; it has no provider usage totals or tool statistics.
- `src/trpc/runtime-api.ts`: `getTaskDiagnostics` gathers the current context;
  `buildTaskDiagnosticsExportPlan` separately obtains task/review/repair lineage
  through `deps.getTaskExportSnapshot`.
- `src/cline-sdk/cline-task-export-snapshot.ts` supplies segment headers, raw
  persisted messages, and tool-origin annotations with message/part references.
- The SDK boundary aliases `ClineSdkPersistedMessage` to its installed
  `MessageWithMetadata`. Inspect installed types before implementing. Persisted
  assistant `metrics` contain `inputTokens`, `outputTokens`, `cacheReadTokens`,
  and `cacheWriteTokens`; display messages do not preserve these fields.
- `src/core/task-diagnostics-export-v3.ts` and the streaming serializer supply
  full-output evidence and explicit completeness. Reuse their evidence shapes;
  do not call the export builder just to calculate summary counts.

## Implementation decisions

### 1. Pure reducer, usable on snapshots and exported JSON

Implement a deterministic, versioned analysis helper on a minimal structural input
of session kinds, headers, messages, and origins. Add thin adapters for existing
snapshots and schemaVersion 3 JSON so the same reducer can analyze an exported
file in a local script/test without a server or an LLM. Do not duplicate the SDK
message schema or introduce a classification framework/dependency.

Return summary numbers plus compact evidence records for failed/unmatched calls
and unchanged retries: session id/kind, message index, part index, tool id,
timestamp, rule id, and classification. Do not return full prompts/outputs in the
summary API. Full exports remain the evidence source; an evidence disclosure in
the panel can list these references without a new transcript viewer.

### 2. Deduplicate before any counting

- Never concatenate restart histories and count them as new execution.
- Prefer stable message ids with matching timestamps and contents/metrics;
  inherited copies contribute once. Recognize conflicting identity reuse as an
  ambiguity, not an opportunity to silently merge distinct turns.
- For tools, use tool id, timestamp, canonical arguments, lineage, and the
  `toolOrigins` annotations together. Canonicalize object key order for argument
  comparison; preserve array order and string whitespace. An id alone is not
  enough when evidence conflicts. Distinct ids with identical arguments are
  separate calls, potentially retries, not duplicates.
- Seeded/compacted copies of an observed call do not count again. If a call is
  visible only in inherited history, retain it once as observed historical
  evidence, flag its provenance, and do not assign it a fabricated execution time.
- Ignore `liveTail` display messages for totals (possible overlap). Expose this
  gap while a capture has a live tail.
- Deduplicate sessions themselves before calculating session counts or intervals.

### 3. Summary fields and semantics

| Field | Definition |
| --- | --- |
| First recorded start | Earliest valid segment start; unknown if unavailable. Not card creation. |
| Last recorded end | Latest valid segment end; incomplete/open segments remain explicit. Not merge time. |
| Recorded session span | Union of valid closed start/end intervals across all included classes; show scope, missing interval count, and coverage. Includes waits inside sessions; excludes gaps between sessions. Never label this active runtime. |
| Session counts | Working, review, verification-repair; restarts are multiple recorded working segments, not automatically crashes. |
| Models | Distinct provider/model pairs from headers and message metadata; flag mixed models. Do not infer actual server configuration from a provider label. |
| Model responses | Distinct assistant responses, including a separate count with reported metrics. |
| Reported usage | Separate cumulative input/output/cache-read/cache-write counters across distinct measured assistant responses, with per-counter coverage. Missing stays unknown, zero stays zero. |
| Peak reported input | Maximum observed per-response input metric; not a context-utilization estimate. |
| Tool calls | Distinct calls and counts by tool name. |
| Reported tool failures | Calls whose matched result explicitly reports failure; count each call once, even when several nested commands fail. |
| Unmatched calls | Calls with no observed result, separately from confirmed failures. |
| Unchanged failed retries | Later calls with identical tool name/arguments after the prior identical invocation reported failure; report count and both evidence references. No conclusion about whether the retry was justified. |

Provider input/cache counters can overlap. Preserve reported values and document
provider semantics if verified; never add input plus cache counts into a supposed
grand token total or infer cache savings. These are cumulative request counters,
not unique context tokens, server timing, actual reasoning duration, or cost.

Historical exports cannot establish exact executing-agent runtime. Do not infer
it from `task.updatedAt`, summary `updatedAt`, card Done time, or session liveness
(which includes awaiting review). Instrumenting explicit turn start/stop/wait
events is a future task if exact runtime is needed; no instrumentation or storage
migration belongs in this PR.

### 4. Classification: deterministic first, clear limits

- Confirmed failures: tool-result `is_error`, or documented structured
  `success: false`, including the direct object arrays used by `run_commands`.
  Inspect the installed tool implementations and actual result shapes. Parse
  JSON text only where the tool's result schema calls for it; do not recursively
  search arbitrary source-code/output strings for `success: false`.
- Editor categories: replacement mismatch, missing required old text, other
  explicit editor failure. Category rules must match actual feedback, not any
  incidental mention of a keyword in source text.
- Keep **reported failure** separate from **validation failure**, **expected
  negative probe**, and **suspected masked command failure**. A failing typecheck
  can be useful feedback; a grep with no matches can be intentional.
- V1 guarantees structural failures and unchanged retries. Small, documented
  rules for known validation summaries/nonzero statuses may produce heuristic
  evidence tags; unmatched text remains unclassified. A pipeline containing
  `tail`/`grep` is only a masking-risk flag unless output independently shows a
  failure. Never mark every such pipeline as failed.
- Show heuristic tags separately from confirmed totals; do not call either an
  avoidable-error score or success rate. Do not promise the reducer will find
  every failure that a human can find in full logs.
- Do not load archived full-output files in the normal summary query. Indicate
  truncated-result coverage; full-log masked-failure analysis is deferred.
- No LLM classifier, reasoning/whitespace-loop detector, repair timeline, prompt
  tuning, or model-effort experiment in this PR.

### 5. Explicit on-demand loading and compact UI

Add one typed summary query and a **Load recorded summary** action in the
diagnostics panel. It reads only this task and its review/repair lineage through
the existing scoped snapshot path. Never hydrate unrelated SDK history. Do not
attach transcript analysis to board refreshes, phase batches, panel mount, or
the existing frequently reused diagnostics response.

Use bounded concurrency (one task analysis per workspace in flight; share the
promise for identical task requests), explicit loading/error states, and manual
refresh. Keep only compact reducer output after the request. Avoid a durable
cache, background scans, schema migrations, or fetching exports into the browser.
Preserve existing workspace authorization and ownership filters.

Place time/span, usage, tool counts, and retry counts above git details. Display
capture time and complete/partial/unavailable coverage with reasons. Historical
results on a running task must be marked as a snapshot. Reset summary state on
workspace/task changes and ignore stale responses from prior selections.

Native transcript availability and terminal-summary availability must be separate:
the baseline includes four complete native transcripts plus an extra terminal
summary claiming no structured history. Do not discard measured native totals or
claim those native messages are missing. Retain the source warning without
silently overwriting the export's existing overall completeness classification.

## Validation and completion

Use small synthetic fixtures, never commit the user's unredacted diagnostics.
Cover inherited messages across four restarts, id collisions, canonical argument
equality, actual nested command result arrays, validation versus negative probes,
zero/missing counters, missing results, truncated results, mixed models,
overlapping/invalid/missing session intervals, review/repair lineage, and live tails.
Add API tests proving workspace isolation, target-only unhydrated listing,
in-flight deduplication, and graceful source failure; preserve HOME/USERPROFILE
isolation in tests that touch workspace state. Add UI tests for snapshot coverage,
unavailable data, refresh, and changing task while a request is pending.

If the operator supplies the PRLINK-10 baseline locally, verify these independently
established expectations: four native segments, 700 raw / 195 distinct tool calls,
90 run_commands / 68 editor / 36 read_files / 1 search_codebase, 164 measured
assistant responses, 165,612 output tokens, 17 editor failures, four additional
command calls reporting nested failure, and three exact repeated failed edits.
The nine extra visible command/check failures from human analysis are **not** a
required deterministic count; report which rules detect them and remaining gaps.
Locally summing stable assistant id+timestamp copies in this attachment also gives
25,280,930 input, 23,532,080 cache-read, and 0 cache-write tokens. Treat these as
cross-checks, not hardcoded fixtures; verify SDK/provider accounting before
interpreting them together.

Run the repository Biome formatting/checks, backend/web typechecks, and relevant
reducer/API/UI tests. One Ready for Review PR; prominently document deployment
requirements (expected: ordinary rebuild/redeploy, no environment variables or
server settings), added fields and semantics, limitations, and how to test each
feature. Do not merge or deploy. No device/server settings change is required.
