# UPDBASE-1 — Base-refresh module: ref classification and bounded fetch

Master plan: `PLAN.md`, section "Git update semantics / Supported ref policy". First
implementation PR group (with UPDBASE-0 … UPDBASE-6).
Depends on: nothing (independent of UPDBASE-0).
Blocks: UPDBASE-2 (safe local-branch update extends this module), transitively UPDBASE-4.

## Purpose

Introduce `src/workspace/task-base-refresh.ts` with: (1) unambiguous classification of the
task's selected base ref, (2) a bounded, non-interactive `git fetch origin` that verifies the
specific target remote ref was refreshed, and (3) the structured failure type shared by the
module and the start path. This task ships the module and its tests; it is not yet called by
any start path.

## Re-verify before starting (code moves)

- Git execution convention: `runGit` in `src/workspace/git-utils.ts` (argument arrays,
  `RunGitOptions` including timeout) and `getGitCommandErrorMessage`.
- `src/workspace/git-sync.ts` shows fetch/pull usage (`fetch --all --prune`, `pull --ff-only`)
  for the **current checkout** — reuse the execution convention, never that behavior, for a
  different selected base.

## Conventions (AGENTS.md — must follow)

- All Git arguments passed as arrays through `runGit`; **never** interpolate the selected ref
  into a shell string.
- Non-interactive only: `GIT_TERMINAL_PROMPT=0` (and no askpass/browser) in the fetch env;
  bound network/command time via `RunGitOptions`; scrub tokens and credential-bearing URLs
  from every error and log string.

## Implementation

1. Structured failure type (single source for all refresh failures, consumed later by
   UPDBASE-5's start-failure wiring):

```ts
export type BaseRefreshFailureCategory =
	| "missing_origin"
	| "missing_remote_ref"
	| "unsupported_ref"
	| "dirty_checkout"
	| "local_ahead_or_diverged"
	| "auth_network_timeout"
	| "concurrent_change"
	| "worktree_setup_failure";

export interface BaseRefreshFailure {
	category: BaseRefreshFailureCategory;
	selectedRef: string;
	remoteTarget: string | null;
	reason: string; // safe, credential-free Git diagnostics
	remedy: string; // specific user action (push/reconcile, configure tracking, uncheck and retry, ...)
}
```

2. Ref classification — `classifyBaseRef(cwd, baseRef)` with unambiguous outcomes covering the
   full PLAN.md policy table:
	- Local branch tracking an origin branch → `{ kind: "local_origin_branch", localRef,
	  remoteRef }`, respecting differing local/remote names (read `branch.<name>.remote` /
	  `branch.<name>.merge` config).
	- Local branch without upstream → if `refs/remotes/origin/<same-name>` exists **after fetch**,
	  use it explicitly (never rewrite upstream configuration); otherwise `missing_remote_ref`
	  with a "configure tracking or uncheck" remedy.
	- Local branch tracking a remote other than origin → `unsupported_ref` (feature is
	  explicitly origin-based).
	- Explicit `refs/remotes/origin/<x>` (or `origin/<x>`) → `{ kind: "origin_remote_ref",
	  remoteRef }` — fetch origin and resolve the refreshed remote ref; no local pull.
	- Tag, commit SHA, or any other non-branch ref → `unsupported_ref`.
	- No `origin` remote configured → `missing_origin`.
3. Bounded fetch — `fetchOrigin(cwd, remoteTarget?)`:
	- `git fetch origin` with a bounded timeout and non-interactive env.
	- Then refresh the specific target explicitly (e.g. `git fetch origin
	  +refs/heads/<target>:refs/remotes/origin/<target>` or the equivalent `runGit` form) so a
	  restricted/custom fetch refspec cannot leave the target stale; verify the target remote ref
	  resolves **after** fetch and fail `missing_remote_ref` rather than accepting a cached ref.
	- Timeout/auth errors → `auth_network_timeout` with a retry-safe remedy.

## Tests

New `test/workspace/task-base-refresh.test.ts` (real temporary repos; no external network):

- Table-driven classification over the full PLAN.md policy table: local branch tracking a
  same-name origin branch; tracking a differently named remote branch; no upstream with a
  same-name origin branch present; no upstream without one; branch tracking `upstream`;
  explicit `origin/main`; tag; full SHA; short SHA; missing origin; missing remote branch.
- Bounded fetch: success; timeout (unroutable host or a short bound) classified as
  `auth_network_timeout`; restricted fetch refspec (`+refs/heads/main:...` only) with target
  `feature` → explicit target refresh succeeds or fails `missing_remote_ref`, never a cached
  ref.
- A remote URL containing `user:token` never appears in an error or log string.

## Verification

```sh
npx @biomejs/biome check src test
npm run typecheck
npx vitest run test/workspace/task-base-refresh
```

(Run `npm run test:fast` if the suite is placed under `test/runtime/` instead.)

## Acceptance criteria

- Every PLAN.md "Supported ref policy" row maps to a deterministic classifier outcome, with a
  category and remedy for blocked rows.
- The fetch never prompts, never exceeds its bound, and never leaks credentials.
- A stale cached target ref is never accepted; a restricted fetch refspec cannot hide a
  missing or advanced target.
- The module is not yet wired into any start path (no behavior change in this task).

## Stop conditions

- A real ref shape encountered in a fixture is ambiguous under the policy table — stop and
  record the case; do not invent policy.
- `RunGitOptions` cannot express the needed timeout/env isolation — extend `runGit` options
  rather than spawning a shell.
