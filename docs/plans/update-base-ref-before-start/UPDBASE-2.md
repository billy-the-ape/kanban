# UPDBASE-2 — Base-refresh module: safe local-branch update

Master plan: `PLAN.md`, section "Git update semantics / Safely updating a local branch". First
implementation PR group (with UPDBASE-0 … UPDBASE-6).
Depends on: UPDBASE-1 (classifier, bounded fetch, failure types in the same module).
Blocks: UPDBASE-4 (runtime integration).

## Purpose

Complete `src/workspace/task-base-refresh.ts` with the local-branch fast-forward step: given a
fetched target SHA for a local origin branch, fast-forward it safely whether or not it is
currently checked out — or block with a structured `BaseRefreshFailure`.

## Implementation

`updateLocalBranchToTarget(cwd, localRef, targetSha): { updated: boolean } | BaseRefreshFailure`

1. Locate checkouts: parse `git worktree list --porcelain` for the worktree whose HEAD branch
   matches `localRef`.
2. If the branch **is checked out**:
	- Require that checkout to have no tracked changes, no staged changes, no untracked files,
	  and no merge/rebase operation in progress; otherwise `dirty_checkout` with the affected
	  checkout path in the safe diagnostics.
	- Recheck state **and** branch identity immediately before the mutation (TOCTOU guard); a
	  mismatch → `concurrent_change`, nothing mutated.
	- Fast-forward in place to the fetched target SHA (equivalent to `pull --ff-only` after the
	  fetch, e.g. `git merge --ff-only <targetSha>` in that checkout, or the closest existing
	  helper). **Never `update-ref` a checked-out branch.**
3. If the branch is **not checked out**:
	- `git merge-base --is-ancestor <oldSha> <targetSha>`; if the old tip is not an ancestor →
	  `local_ahead_or_diverged` with the PLAN.md remedy: “The base branch has local commits not
	  on origin. Push or reconcile it, or disable the update option.”
	- Move the ref with compare-and-swap: `git update-ref refs/heads/<name> <targetSha> <oldSha>`.
	  A CAS failure means an external change raced in → `concurrent_change`; fail safely, never
	  overwrite.
4. Equal tips (`oldSha === targetSha`) → successful no-op (`{ updated: false }`, not a failure).
5. Invariants:
	- Never check out the selected base branch in an unrelated workspace just to run a pull.
	- A dirty **unrelated** checkout does not block updating a clean, unoccupied base branch.
	- A fetch may legitimately refresh remote-tracking refs even when this step fails; this step
	  must never change local file contents on failure.
	- The application lock (UPDBASE-4) serializes Kanban operations, but the CAS and checkout
	  rechecks are still required for external (non-Kanban) changes.

## Tests

New cases in the base-refresh suite (temporary repo + local bare origin + second clone):

- Unoccupied branch behind origin → CAS update succeeds (old SHA passed as the CAS argument);
  no checkout anywhere is touched.
- Checked-out clean branch → in-place fast-forward succeeds; HEAD advances; status stays clean.
- Checked-out branch with a tracked change / staged change / untracked file → `dirty_checkout`;
  files and branch tip intact.
- Checked-out branch with a merge or rebase in progress → blocked; the in-progress operation
  is untouched.
- Local-ahead and diverged histories → `local_ahead_or_diverged` with the remedy text; ref
  unchanged.
- Equal tips → no-op success, no ref write.
- Concurrent change: move the branch ref between the ancestor check and the update (simulated
  in the test) → `concurrent_change`; the external state is preserved.
- Differing local/remote names (`feature` tracking `origin/feature-v2`) → target resolved from
  the tracking configuration, upstream config never rewritten.

## Verification

```sh
npx @biomejs/biome check src test
npm run typecheck
npx vitest run test/workspace/task-base-refresh
```

## Acceptance criteria

- Both occupied-clean and unoccupied bases update to exactly the fetched target SHA; equal
  tips no-op; every other outcome is a structured failure with category and remedy.
- No code path runs `update-ref` on a checked-out branch, checks out the base in an unrelated
  workspace, or leaves local file contents changed on failure.
- Concurrent external ref/checkout changes are detected and never overwritten.

## Stop conditions

- Cross-worktree serialization needs (locking scope) surface here — that is UPDBASE-4's scope;
  flag it for that task rather than redesigning locks in the module.
- A dirty-state signal (staged vs untracked vs in-progress operation) cannot be told apart
  with non-interactive Git commands as array args — record the gap; do not fall back to
  parsing ambiguous output.
