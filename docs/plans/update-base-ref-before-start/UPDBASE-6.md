# UPDBASE-6 — Runtime and Git integration test coverage (first-PR gate)

Master plan: `PLAN.md`, section "Acceptance and test matrix". First implementation PR group
(with UPDBASE-0 … UPDBASE-6); this is the final gate task of the runtime PR.
Depends on: UPDBASE-0 through UPDBASE-5.
Blocks: nothing inside the runtime PR; the second PR (UPDBASE-7 …) starts only after this PR
is merged.

## Purpose

Prove the runtime rows of the PLAN.md acceptance matrix with real local-Git integration tests
(no external networking), run the repository's required checks, and gate the first
implementation PR on them.

## Implementation

- Fixtures: temporary repo + local bare origin + a second clone that advances the remote
  branch (pattern from `test/integration/task-worktree-delivery.integration.test.ts`). No test
  may depend on external networking.
- AGENTS.md isolation: every test touching workspace state, task worktrees, delivery receipts,
  or dispatch records redirects `process.env.HOME` (and `USERPROFILE`) to a temp dir in
  `beforeEach` and restores it in `afterEach`. Task worktrees live at
  `~/.cline/worktrees/<taskId>/<repoFolderLabel>` (nested).
- Git-ref caution: `refs/kanban/tasks/<id>` is owned by the B-5 preservation ref while a
  worktree lives; any test creating new per-task refs must use a distinct namespace (this
  series should need none).
- Unit-style suites must not boot real SDK hosts (see the Node 22 CI-hang history in
  AGENTS.md); if a suite needs the real host, it belongs in the integration location.

Matrix rows this task must cover (from PLAN.md "Acceptance and test matrix"):

| Scenario | Required result |
| --- | --- |
| Origin advances a stale local feature base | First task worktree HEAD equals the new origin SHA; local base fast-forwards; first prompt runs afterward |
| Checkbox unchecked | No refresh fetch/update; worktree starts at the existing local SHA |
| New and legacy task defaults | Checked; explicit false survives schema normalization, persistence, and reload |
| Checked-out clean base versus an unoccupied base | Both update safely without switching an unrelated checkout |
| Dirty selected checkout, staged/untracked files, active operation | Start blocked; files and local base remain intact |
| Different tracking branch name, no upstream with same-name origin | Intended origin target is used; no upstream settings are rewritten |
| Local-ahead, diverged, other remote, missing origin/branch, pinned ref | Clear block and remedy; no stale fallback, forced reset, merge, or agent prompt |
| Explicit origin ref and restricted fetch refspec | Correct remote target is refreshed or start blocks |
| Existing worktree, review retry, restart, trash restore, saved patch | No refresh/recreation; task HEAD and work survive remote advancement |
| Prepared baseline but missing worktree | Recover pinned task state or block; never switch to a newer base |
| Double start and two tasks sharing a repo | Lock serializes refresh/create; each uses its own resolved immutable SHA |
| Network failure or timeout | No task worktree/prompt; task remains backlog; retry succeeds after fault removal |
| Crash after worktree creation or preparation persistence | Retry reconciles worktree and durable baseline without discarding work |
| Shell/inspection before initial start | No premature stale worktree creation that bypasses the start refresh |
| Ref or checkout changes outside Kanban during preparation | Detect and block without overwriting the external change |

(Rows that also involve UI save/create paths or the start UX are finished in UPDBASE-9; the
runtime-side proof for those rows lands here where it is testable without the UI.)

## Verification

```sh
npx @biomejs/biome check src test
npm run typecheck
npm run test:fast
npm run test:integration
npx vitest run test/workspace test/runtime
npm run web:typecheck && npm run web:test   # parity check only; no UI in this PR
```

After the suites pass, verify `ls ~/.cline/worktrees ~/.cline/kanban/workspaces` shows no
test leakage into the real home.

## Acceptance criteria

- Every runtime row in the table above passes offline in CI.
- No test writes to the real `~/.cline`; no unit suite boots a real SDK host.
- The PR description records: changed files, the durable record location/format, the chosen
  lock scope, the full caller-audit table (UPDBASE-5), the chosen early-ensure resolution,
  test commands and results, and any baseline drift against the plan's source baseline.

## Stop conditions

- A row is only reachable with external networking or a real SDK host — rework the fixture;
  if genuinely impossible, record the row as a manual-verification item for UPDBASE-9 rather
  than silently dropping it.
- A test fails only in environments with unusual network behavior (see the known
  environment-dependent `projects-api` clone test in AGENTS.md) — diagnose the environment
  first; do not "fix" correct code to satisfy a flaky environment.
