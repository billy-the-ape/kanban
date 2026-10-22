# AR-3: Run long validation as observable local jobs

Status: planned. One implementation PR into `main`. Dependencies: none.
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
