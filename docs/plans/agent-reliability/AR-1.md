# AR-1: Correct recorded diagnostics and evidence classification

Status: planned. One implementation PR into `main`. Dependencies: none.
Read [README.md](./README.md) and [EVIDENCE.md](./EVIDENCE.md).

## Outcome

Summaries on native snapshots and exported JSON agree on structural tool failures
and do not turn unknown arguments, source fixtures, or pipeline risks into false facts.
This establishes the baseline for later behavior changes; it does not change execution.

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
