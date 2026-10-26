# AR-1: Correct recorded diagnostics and evidence classification

Status: implemented (reducer version 2). One implementation PR into `main`. Dependencies: none.
Read [README.md](./README.md) and [EVIDENCE.md](./EVIDENCE.md).

## Outcome

Summaries on native snapshots and exported JSON agree on structural tool failures
and do not turn unknown arguments, source fixtures, or pipeline risks into false facts.
This establishes the baseline for later behavior changes; it does not change execution.

## Implementation outcome (reducer version 2)

Implemented in `src/core/task-quality-summary.ts`,
`src/core/task-diagnostics-export-artifacts.ts`, and `src/core/api-contract.ts`
(evidence `resultIsError` field + documented `reducerVersion`), with compatible
labels in `web-ui/src/components/detail-panels/task-quality-summary-section.tsx`.

- **Native adapter (`extractDurableToolResultText`)** preserves, in addition to
  string results and text blocks (kept even when mixed with image/file
  blocks, which carry no documented text): (a) a direct structured
  command-entry array persisted as the
  tool_result content itself (serialized with `JSON.stringify`), and (b) Kanban's
  `{ recovery, output }` envelope persisted as a record, including array-valued
  `output`. Nothing else is serialized or scanned.
- **`argumentStatus` provenance** (`present` / `empty` / `unavailable`) is carried on
  every `TaskQualitySummaryToolPart` (computed by `argumentStatusForToolUse` in the
  adapter; `"unavailable"` on tool_result parts).
- **Classification (`classifyToolCall`)** interprets only documented envelopes:
  - confirmed failures, each call counted once: tool-result `is_error` (an
    `is_error` result on the `editor` tool now reports the documented category —
    `editor_replacement_mismatch`, `editor_missing_old_text`, `editor_input_too_large`,
    else `editor_other` — instead of being erased to `tool_result_is_error`; other
    tools keep `tool_result_is_error`); the `{ recovery, output }` envelope;
    documented structured `success: false` (top-level object, via the envelope's
    original output when present); and the run_commands command-entry arrays, found
    as a direct array, as `{ output: [...] }`, or inside a recovery envelope
    (`extractCommandEntries` accepts the array directly). Entries whose documented
    `error` is a timeout (`isClineToolTimeout`) classify as the distinct
    `command_timeout` rule when every failing entry is a timeout; any non-timeout
    failure entry in the same call stays `run_commands_nested_failure`.
  - heuristic tags unchanged: masked pipeline, expected negative probes, nonzero
    exit status. A pipeline's presence alone never proves a failure.
- **Unchanged failed retries** are declared only when the recorded arguments can
  prove identity: `present`, or `empty` for a tool documented to accept entirely
  optional input (`EMPTY_INPUT_VALID_TOOLS` — no built-in tool currently qualifies,
  so `{}` can never claim identity). Empty/unavailable calls are excluded; missing
  provenance is reported as an `argument_provenance_unknown` ambiguity, never
  claimed identical.
- **Evidence** carries `resultIsError` (the recorded result's `is_error` flag;
  `false` for unmatched calls). The response `reducerVersion` documents the
  v1/v2 semantics; the schema stays `min(1)` for backward compatibility.
- **Artifact reference extraction** is restricted to the documented bounding
  envelopes: the standalone `Full content: <path>` marker line
  (`/^Full content: (\S+)$/gm`) and the bracketed
  `[truncated N (chars|lines); full output: <path>]` marker. Quoted source,
  diff/fixture lines, and prose mentions are ignored; a bare `full output: <path>`
  line is not a reference. All collected references are deduplicated: exactly one
  distinct reference resolves; several distinct references return an explicit
  `ambiguous` gap (never guessed). Containment/symlink checks are unchanged.
- **Web UI**: the header shows the reducer version (`reducer v2`); "Reported
  failures" is labeled "confirmed structural, once per call"; evidence rows show a
  `· is_error` marker when the recorded result carried the structural flag.

**Tests**: inherited restart snapshots carry identical totals (a direct structured
array failure is counted exactly once across segments); `is_error` editor results
report the documented category with `resultIsError: true`; timeouts are distinct and
nested output text is never scanned (log-inspection fixture); quoted/fixture/prose
failure text produces no failure evidence; recovery envelopes (text block and direct
array output) are structural failures; empty `{}` and unavailable (`null`) editor
arguments are excluded from unchanged-retry identity (unavailable →
`argument_provenance_unknown` ambiguity) while proven-argument retries still count;
raw persisted structured arrays survive the native adapter (modeled in the fixture
through one explicit cast, since the typed persisted shape cannot express them);
artifact reference extraction resolves only the documented styles, ignores
diff/quoted/bare-phrase lines, returns an explicit `ambiguous` gap for multiple
distinct references, and retains the escape/sibling/symlink regression coverage.

## Current integration points

- `src/core/task-quality-summary.ts`: `extractDurableToolResultText`, durable adapter,
  `classifyToolCall`, deduplication, unchanged-failed-retry reducer.
- `src/core/task-diagnostics-export-artifacts.ts`: sidecar/deterministic/legacy lookup.
- `src/core/task-diagnostics-export-v3.ts`, `src/core/api-contract.ts` and existing
  summary UI only as needed to expose added categories/version/unknown coverage.
- `test/runtime/core/task-quality-summary.test.ts` and artifact/export tests.

The classifier already handles JSON command arrays. The missing path is the native
adapter's structured array representation; fix the adapter, not a duplicate analyzer.

## Required implementation

1. Preserve documented string results, text blocks, direct structured command arrays,
   and Kanban's `{ recovery, output }` envelope, including array-valued `output`.
   Interpret only these envelopes. Never recursively scan arbitrary command stdout,
   code, fixture JSON, or quoted error prose for `success: false`.
2. Count one failed call when several command entries fail. Preserve original structural
   evidence separately from editor category; an `is_error` flag must not erase a known
   missing-anchor/mismatch category. Keep negative probes, failed validation, timeouts,
   and pipeline risk distinguishable. Pipeline presence alone proves no failure.
3. Track argument availability/parse-error metadata where the persisted SDK shape has
   it. Empty or unavailable arguments for a malformed call are ineligible for unchanged
   retry comparison. For tools where `{}` is valid, retain valid equality comparisons.
   If provenance is absent for an invalid empty editor input, label it unknown rather
   than declaring identity. Object key ordering still does not change argument equality.
4. Retain sidecar and deterministic artifact lookup first. Restrict legacy reference
   extraction to actual bounding envelopes/standalone marker lines, excluding quoted
   source and diff/test-fixture lines. Ambiguous legacy provenance stays explicit;
   do not hide genuinely missing indexed artifacts or relax containment/symlink checks.
5. Bump the reducer semantic version; adapt API/UI labels compatibly and document the
   interpretation change. Keep on-demand loading and task/workspace isolation.

## Acceptance and verification

- Synthetic native snapshot and equivalent v3 export produce identical counts for
  direct arrays, text blocks, recovery arrays, mixed successes, and inherited snapshots.
- A baseline-shaped fixture reproduces the four formerly missed command failures.
  Actual PRLINK-10, if supplied locally, should yield 195 calls and 21 structural
  failures; never hardcode those numbers into production or commit raw exports.
- Two malformed editor calls with `{}` do not become unchanged retries. Real repeated
  valid arguments still do; identity conflicts and unmatched calls remain visible.
- Successful editor output containing fixture `success: false` and `Full content:`
  strings creates neither a failed call nor a claimed missing artifact. Genuine
  indexed missing/ambiguous/unsafe artifacts retain their gap classifications.
- Log-inspection commands are not counted as new failing test executions solely because
  they print an earlier failure. A no-match probe is not called an implementation mistake.
- Run the focused reducer/artifact/export suites, affected API/UI tests and typechecks;
  apply repository formatting. Compare the operator's retained exports if available.
  Missing private exports must not block the synthetic regression tests.

## Deployment and exclusions

No model calls, execution changes, new database, export-schema rewrite, or diagnostic
dashboard. Rebuild/redeploy normally; no environment variables or data migration.
Historical summaries recompute on explicit load; preserve version labels for comparisons.
