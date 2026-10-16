# AR-7: Show evidence-linked recovery episodes in diagnostics

Status: planned. One implementation PR into `main`. Dependencies: AR-1, AR-3, AR-6.
Read [README.md](./README.md) and [EVIDENCE.md](./EVIDENCE.md).

## Outcome and UI budget

The existing on-demand quality summary helps select and inspect completed tasks with
timeouts, repeated failed edits, or review repairs. Add one compact expandable evidence
list and a few summary fields. No board-wide scan, dashboard, task score, or automatic
LLM evaluation. Reuse the current load/refresh action and source evidence references.

## Current integration points

- `src/core/task-quality-summary.ts` and summary contracts in `src/core/api-contract.ts`.
- `src/cline-sdk/cline-task-export-snapshot.ts` and export-v3 evidence shapes.
- `web-ui/src/components/detail-panels/task-quality-summary-section.tsx`, its hook,
  `task-diagnostics-panel.tsx`, and current API/reducer/UI tests.
- Launch persistence and AR-3's recorded job receipts; AR-6's review-turn receipts.

## Required deterministic data

1. Expose timeout and editor-failure category counts, unmatched/unknown outcomes and
   unchanged retries from AR-1. Clearly separate structural failures, pipeline risk,
   failed checks, probes, and heuristic episodes. Do not assign a single mistake total.
2. Build conservative edit episodes: a failed editor call, subsequent attempts/read
   evidence, and the next successful editor call on the same canonical file in that
   task, or an explicit unresolved end. Label it "next successful edit on this file",
   not proven recovery of the intended change. Unknown paths cannot be matched.
3. Deduplicate inherited calls first. Use session/message/part/tool-call references that
   distinguish working/review/repair groups; local segment indices alone are ambiguous.
   Include original failure/result references, candidate next-success reference, timestamps,
   classification rule/version, and any invalid/missing timestamp warning.
4. Episode elapsed time is wall-clock interval, including intervening work and waits.
   Do not call it reasoning time or savings. Avoid double-counting overlapping episodes;
   do not subtract episode sums from total runtime. Never bridge an unrecorded gap and
   present it as active work. Cap the returned list at 100 episodes with total/omitted
   counts; retain existing aggregate counters over the complete source.
5. Show working, bounded-review, and verification-repair spans from actual lineage with
   interval-union semantics. A task-kind session addressing comments remains task-kind
   unless a stored dispatch/receipt authoritatively identifies its role. Unknown work
   stays unclassified; do not infer implementation/publication phases from a title.
6. Show recorded provider/model, reducer version, deterministic composed-prompt fingerprint,
   and SDK/tool version only where captured in launch metadata. Fingerprint exact recorded
   prompt bytes; dynamic cwd/rules mean equal behavior may still have different hashes.
   Mixed values stay mixed, missing historical versions stay unknown. Never assign the
   currently installed SDK version or guessed model settings to old sessions.
7. Extend new-session metadata minimally if needed to record actual SDK version and a
   Kanban-owned guidance version for future comparisons. Preserve existing launches.
   Show available measured compaction records separately from estimated context; do not
   manufacture a compaction count or raw provider finish reason from missing telemetry.
8. AR-3 job events show started/completed/failed/timeout/cancelled state and retained-log
   reference. Status/read actions are observations of a job, not new test executions.

## Evidence navigation and acceptance

- Render a small category/count summary with the expandable list sorted by elapsed
  interval. Labels explain observed versus inferred facts. Existing token coverage,
  terminal-source warning, partial status, and on-demand loading remain visible.
- Each item opens the existing task transcript/evidence view if its target is available.
  Otherwise offer a copyable precise session/message/tool reference for the export;
  do not add a full transcript browser or invent an invalid deep link.
- Reducer tests cover inherited histories, repeated/parallel same-file edits, ambiguous
  identities, multiple session kinds, missing timestamps/versions, overlaps, gaps,
  unclosed episodes, capped lists, and job log reads versus executions.
- UI tests cover empty/partial data, many episodes, clear time labels, unknown metadata,
  evidence navigation/fallback, task switch and refresh. No automatic analysis on opening
  every card or periodic workspace scans; retain target-only snapshot and in-flight dedupe.
- Run focused reducer/API/hook/UI tests, both typechecks, formatting, and a browser smoke
  of one successful task and one failed/recovered task. Do not commit private exports.

## Deployment

Normal deploy; no environment variables or database migration. Bump summary semantic
version if output interpretation changes. Historical metadata remains unknown where
absent; new native sessions receive the added provenance. Recompute on explicit refresh.
