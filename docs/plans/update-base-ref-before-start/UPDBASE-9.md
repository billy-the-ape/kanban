# UPDBASE-9 — End-to-end verification, documentation, and plan consistency

Master plan: `PLAN.md`, sections "Acceptance and test matrix" (final rows) and "Deployment
and settings". Second implementation PR (with UPDBASE-7 … UPDBASE-9); final task of the series.
Depends on: UPDBASE-7, UPDBASE-8, and the merged runtime PR (UPDBASE-0 … UPDBASE-6).
Blocks: nothing — closing this task closes the feature's full acceptance matrix.

## Purpose

Close the remaining end-to-end rows of the PLAN.md matrix, run the manual validation, update
the user documentation, and keep the master plan and this task series consistent with what
actually shipped.

## Implementation

1. End-to-end regression coverage (extend the `test/` and `web-ui` suites):
	- Checked and unchecked starts from the UI.
	- Backlog rollback after a blocked update; refresh retry after fault removal
	  (network/dirty/diverged) succeeds and uses the refreshed SHA.
	- Automated (dispatch) starts honor the persisted policy identically to UI starts.
	- Resume of an existing started task after another remote advance → its worktree and work
	  are unchanged; no refresh runs.
	- Legacy/unstarted task defaults read as checked in both UI and runtime.
2. Manual validation (per PLAN.md, recorded in the PR description):
	- Advance a feature branch remotely; edit a backlog task to select its stale local branch;
	  leave the checkbox checked; start it. Confirm the base and the detached worktree match the
	  fetched tip.
	- Repeat unchecked. Then resume the first task after another remote advance and confirm its
	  worktree is unchanged.
	- Exercise a blocked dirty or diverged base and confirm no agent prompt was sent.
3. User documentation: document the checkbox — placement, default (enabled, including
   unstarted legacy tasks), the blocked cases and their remedies, and the uncheck-and-retry
   escape hatch — in the relevant settings/task documentation pages.
4. Plan consistency: update `PLAN.md` (field names, durable record format, file paths, status)
   to match the shipped implementation — a consistency pass only, no re-planning. If the
   implementation deviated from a UPDBASE task doc, record the deviation in the PR description
   and note it in the affected task file.
5. Full-matrix sign-off: map every PLAN.md acceptance row to its covering test (or the
   recorded manual step) in the PR description.

## Verification

```sh
npx @biomejs/biome check src test web-ui/src
npm run typecheck && npm run web:typecheck
npm run test:fast
npm run test:integration
npx vitest run test/workspace test/runtime
npm run web:test
```

## Acceptance criteria

- Every row of the PLAN.md acceptance matrix is closed by an automated test or a recorded
  manual validation step.
- The documentation describes the shipped behavior (default, blocked cases, remedies).
- `PLAN.md` and the UPDBASE task docs match the final implementation.
- With this task done, the feature is complete: no runtime behavior, UI surface, or matrix
  row remains unhandled.

## Stop conditions

- A remaining matrix row can only be closed by fixing a runtime (UPDBASE-0 … 6) defect — do
  not smuggle runtime Git changes into this UI PR; open a scoped follow-up and record it here.
- Documentation and PLAN.md consistency edits start colliding with an unrelated open plan PR
  in the same files — stop and coordinate rather than force-merging documentation changes.
