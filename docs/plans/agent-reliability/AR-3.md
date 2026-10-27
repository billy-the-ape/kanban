# AR-3: Run long validation as observable local jobs

Status: implemented (see [Final state](#final-state)). One implementation PR into `main`. Dependencies: none.
Read [README.md](./README.md) and [EVIDENCE.md](./EVIDENCE.md).

## Outcome and scope boundary

A native local Cline session can start a check once, observe progress, read retained
output, and obtain its actual exit status beyond the ordinary 30-second command limit.
Keep this to one local tool, one job service, runtime wiring, focused tests, and docs.
No scheduler, daemon, tRPC control API, terminal UI, or general workflow engine.

## Current integration points

- `src/cline-sdk/cline-session-runtime.ts`: localRuntime extraTools and model calibration
  already combine MCP tools. Merge the new tool into both paths, including restored
  sessions, without treating its presence as permission to disable MCP settings tools.
- `src/cline-sdk/sdk-runtime-boundary.ts`: derive extra-tool types from installed SDK
  public contracts; local `extraTools` is the supported extension point.
- `src/cline-sdk/review-tool-policy.ts`: apply existing command approvals/review rules.
- `src/workspace/task-artifacts.ts` and artifact index: archive completed logs using
  existing ownership/evidence conventions. Inspect current helpers before implementing.

## Fixed contract

1. Add `validation_job` with discriminated actions `start`, `status`, `read`, `cancel`.
   `start` takes one executable plus string `args` and an optional worktree-relative
   cwd. Spawn directly without shell parsing. Explicit shell executables remain subject
   to existing command policy; the name validation does not make arbitrary input safe.
   Other actions require an opaque job ID owned by this task/session.
2. Starting returns promptly with job ID, start timestamp, and running state. Starting
   the same tool-call ID twice returns the same receipt without a second process.
   Repeating a command under a new call ID while its identical job is live returns that
   live job. Other concurrent starts in the same task return a clear busy result.
   Intentional reruns after completion are allowed. Never infer that equal commands on
   changed source have equal results, and never auto-retry a process.
3. Reuse normal command approval and review restrictions before spawning. A rejected
   review publication command must remain rejected through this tool. Approval occurs
   once for the start; status/read/cancel only access the owned job. Preserve worktree
   cwd constraints and avoid exposing a new route around existing tool policies.
4. Keep the process under runtime ownership; do not rely on shell `nohup`/`setsid` recipes.
   Store stdout/stderr in an owner-only spool and return bounded excerpts. Status has
   state, start/end times, exit code or signal, and timeout/cancellation/log-truncation
   fields. A nonzero exit is a failed check; polling success does not turn it into a pass.
5. Use one live job per task, a 30-minute wall deadline, and a 25 MiB log-spool limit.
   On the log limit, keep draining without retaining additional bytes and disclose the
   omitted bytes. Mark the final artifact incomplete; do not claim it is a full log.
   Keep read pages bounded to 8 KiB with byte cursors; polling never blocks to wait.
6. Cancel/stop/trash/shutdown kills the owned process group and settles status; cover
   supported platform behavior explicitly. After a runtime crash, any retained running
   record is interrupted/unknown, never automatically resumed or killed by a reused PID.
   Do not promise that arbitrary daemonized grandchildren are a sandboxed workload.
7. On settlement, archive an immutable retained log through the existing artifact writer
   and return its evidence reference. Preserve status even if archival fails. Attach job
   results to native history so AR-7 can associate start and completion without new scans.
   Persist minimal versioned ownership/status metadata; bound retention with the task's
   existing cleanup lifecycle rather than keeping orphan logs indefinitely.

## Proposed capability wording

Advertise only when the tool is actually registered and permitted in this session.

```text
For validation likely to outlast run_commands, start a validation_job and use its job ID to check status and read the retained log. Check the recorded exit status before reporting success. Inspect another log range instead of rerunning an unchanged check only to obtain a different excerpt. Rerun after relevant changes or when deliberately checking flakiness. Do not start a duplicate while its job is still running.
```

This does not require every quick command to use a job or reduce required checks.

## Acceptance and verification

- Real child process exceeding 30 seconds completes through start/status/read. Most
  deadline tests use injected timers/processes; include one gated slow integration test.
- Nonzero exit, signals, cancellation, timeout, log cap, spawn failure, fast completion,
  duplicate start, new intentional rerun, process cleanup, and shutdown are covered.
- Workspace/task isolation and review denial hold. A job cannot read/cancel another
  task's job. Log pages never rerun commands. Approval denial creates no process/spool.
- Tool schemas, calibration, initial/restored tool lists and capability text agree.
  Preserve MCP registration and existing publication attribution tests.
- Run focused lifecycle/runtime/policy/artifact tests, backend typecheck and formatting.
  Document a disposable long-running success/failure/cancel manual smoke test.

## Deployment

Normal rebuild/redeploy and new native local sessions. No new environment variables,
model settings, database migration, or server-side configuration. Report filesystem
spool/retention and local-mode availability prominently in the implementation PR.

## Final state

Implemented as a single PR against `main`:

- `src/cline-sdk/validation-job-service.ts` — `ValidationJobService`: one live job per task,
  direct spawn with no shell parsing, the approval gate resolves before anything is spawned,
  per-tool-call-id receipts (duplicate/reuse/busy semantics), owned process-group lifecycle
  (POSIX process group, Windows child), a 30-minute wall deadline, a 25 MiB owner-only (0o600)
  spool with truncation disclosure, bounded byte-cursor reads (8 KiB pages), and cancel/status
  actions that never block. Per-job versioned metadata lives under
  `<task worktrees home>/<taskId>/validation-jobs/`, a sibling of the task's worktree state, so
  the task's existing cleanup lifecycle bounds retention. On settlement the retained log is
  archived through `writeTaskContextArtifact` keyed by the start tool-call id (AR-7
  start/completion correlation); status is preserved when archival fails, and the spool is
  dropped once consumed.
- `src/cline-sdk/validation-job-tool.ts` — the single `validation_job` extraTool with the
  discriminated `start`, `status`, `read`, and `cancel` actions, bounded string output, and
  the proposed capability wording (`VALIDATION_JOB_CAPABILITY_TEXT`).
- `src/cline-sdk/cline-session-runtime.ts` — local SDK hosts are detected by the absence of
  `runtimeAddress` on the session host (hub-backed hosts expose it), so the tool is registered
  and advertised (system-prompt append, idempotent across restarts) only where it actually
  works. It merges into the same `extraTools` list the B-2.5 compaction calibration measures.
  One service per task is created on every session start (replaced sessions settle first as
  `canceled`), settled on stop/abort/clear/session-ended/shutdown, and resumed sessions adopt
  any retained `running` record as `interrupted` — never auto-resumed, never killed by a
  possibly-reused PID.
- `src/cline-sdk/review-tool-policy.ts` — bounded review sessions deny `validation_job` starts
  carrying Git publication / PR-creation / destructive-worktree commands and delegate every
  other action to the workspace approval gate, so a rejected review publication command stays
  rejected through the tool.
- Tests: `test/cline-sdk/validation-job-service.test.ts` and
  `test/cline-sdk/validation-job-tool.test.ts` (HOME-isolated, real child processes), additions
  to `test/cline-sdk/review-tool-policy.test.ts` and
  `test/runtime/cline-sdk/cline-session-runtime.test.ts`, plus the gated
  `test/integration/validation-job.integration.test.ts` (observes a job beyond the 30-second
  command deadline in real time; run with `KANBAN_AR3_INTEGRATION=1`).

Notes and follow-ups:

- Review hardening (PR feedback): `settle()` now publishes the settled fields
  (state, times, exit info, archive reference) to the shared record only in one
  synchronous stretch after archival completes, so `status` never reports a settled
  job with missing fields and a new start never mistakes a settling job for live.
  `start()` is serialized on a promise chain so concurrent tool calls cannot
  double-book the single live slot. Job ids are validated against the generated
  UUID shape in `getJob`/`readJobLog`/`cancelJob`/`readRecord` (a mismatch between
  the record's own id and the file name is rejected), and `read` only opens
  `record.artifactPath` when it lies inside the task's context-artifacts directory.
- Review hardening, round 2 (PR feedback): the review-session policy scans a
  `validation_job` start's structured argv (`[command, ...tokenizeCommandArgs(args)]`)
  instead of a whitespace-joined string, so a quoted arg containing whitespace can no
  longer mask a forbidden subcommand (e.g. `git "-c" "core.x=a b" push`). `spawn` is
  wrapped so a synchronous throw closes the spool and settles a `spawn_failed` record
  instead of leaking the fd and a phantom `running` record, and NUL bytes in the
  command or args are rejected up front. A `closed` flag is set by `cancelAllJobs` and
  re-checked after approval and just before `spawn`, so a stop/clear/abort during
  approval or the start chain can never leave a spawn running on a removed service.
- Review hardening, round 3 (PR feedback): `logTruncated` is now also set when a chunk
  is dropped entirely because the spool is already exactly full (previously
  `logBytesOmitted > 0` with `logTruncated === false` skipped the truncation marker and
  the tool's "NOT complete" note). The spool is only removed after the final record is
  published and the live slot released, so a reader racing settlement always sees the
  spool (running) or the archive (settled), never an empty "end of retained log" page.
- The job status is not yet surfaced in the task diagnostics export (B-3); the scope boundary
  excludes a new tRPC control API, so the diagnostics wiring lands as a follow-up.
- Killing covers the owned process group (POSIX) or child (Windows); daemonized grandchildren
  are explicitly not a sandboxed workload, per the fixed contract.
- The tool is advertised to models only on local runtime hosts; hub-backed sessions are
  unaffected and their persisted launch configs never carry the local-only tool.

