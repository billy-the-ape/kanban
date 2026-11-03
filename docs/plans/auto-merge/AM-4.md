# AM-4: Fenced, audited, restart-safe merge executor

**Status:** planned. **One implementation PR into `main`.** Depends on: AM-3. Read [README.md](./README.md).

## Deliverable

Implement the **only** code path allowed to write a GitHub PR merge. Trigger it from AM-3's eligible callback. It must not ask an agent to merge or invoke a local git merge/push.

## Write protocol (in order)

1. Accept a typed eligibility decision containing canonical PR, task, access scope, policy revision, exact expected head/base SHA and evaluation time. Treat it as a **candidate**, not authorization.
2. Acquire the existing durable per-PR and head-ref fencing/reservation gate (`src/pr-tracking/pr-reservations.ts`); introduce `auto_merge` operation kind and document interaction with `comment_followup` and `merge_completion`. Never hold the registry mutex during network requests. A single scheduler owner performs writes; second runtime with same storage root must not merge.
3. Under the reservation, re-read task/card/selected PR, policy/arm revision and auth scope. Check there is no live agent writer or pending comment repair. Fetch **fresh, complete** approvals, CI and PR metadata; rerun AM-3 evaluation. Reject any shift in head SHA, base SHA/ref/repository, task selection, policy or approval since candidate evaluation. Fail closed if revalidation cannot finish.
4. Persist a small journal entry **before** invoking GitHub: `attemptId`, `prKey`, `task`, `headSha`, `baseSha`, `policyRevision`, `mergeMethod`, `startedAt`, `state=attempting`, `reason`. Use version-checked, crash-safe storage; record one attempt per immutable evidence identity, not a burst of retries.
5. Make one noninteractive, bounded GitHub REST merge call (`PUT /repos/{owner}/{repo}/pulls/{n}/merge`) with `sha=<validated head SHA>` and allowed `merge_method`, using the established server GitHub authentication. **Never** force-push or use GitHub rules bypass. Honor 403/405/409/422 and merge conflict responses.
6. Regardless of the immediate response (success, error or timeout), fetch the PR again and verify `merged`, `merge_commit_sha` and the expected PR identity. **Only** this remote observation lets the existing merge-completion consumer move Done and dispatch successors. The executor does not directly complete tasks.
7. On clear precondition failure (checks no longer green, review changed, head changed), mark the attempt not merged with a reason and return to ordinary waiting/polling when safe. On permission/policy/configuration failure, persist a terminal **needs attention** reason. On ambiguous timeout, reconcile remote state before any further attempt; never blind-retry the same merge. Release reservation in `finally` only after durable outcome/reconciliation state is persisted.

## Concurrency, crash recovery and audit

- State machine: `idle → attempting → merged_confirmed | waiting | needs_attention`; durable attempt identity and timestamps. On startup, reconcile `attempting` records **by reading GitHub first**, not by repeating writes. Unknown outcomes stay blocked until an explicit recovery action.
- One PR may be linked to multiple tasks, but at most one task/opt-in can own an automatic merge. Distinct task records cannot race for the same PR or remote head branch. Existing merge-completion uses its own reservation after merge is observed.
- Credential changes, repo permissions, dismissed reviews, new commits, draft/closed state, policy changes and user disabling must invalidate pending candidates before write. Cancellation cannot undo a request already accepted by GitHub; surface that limitation accurately.
- Bound every network call and journal; redact secrets and review bodies. Log evidence SHA and blocker codes, not raw tokens. Preserve existing scheduler-lock behavior and rate-limit backoff. Do not create a general-purpose arbitrary-repo GitHub merge endpoint callable by a browser.
- If GitHub native auto-merge is enabled on the PR, avoid a competing write and let the ordinary merged observer handle completion.

## Expected files

New `src/pr-tracking/auto-merge-executor.ts`, extensions in `src/pr-tracking/pr-reservations.ts`, `pr-record-store.ts`, `github-gh-adapter.ts`, `src/server/runtime-server.ts`, `src/core/api-contract.ts`, and `test/runtime/pr-tracking/` suites. Reuse the existing runtime `gh` process/env abstraction; do not depend on a coding agent's CLI environment.

## Required test scenarios

1. One successful merge with expected head SHA, permitted merge method and confirmed post-write remote state.
2. 409 (HEAD moved), 405 conflict, 403 permission, 422 validation, timeout, process crash before/after write, duplicate observations, process restart and stale reservation. Assert no unverified duplicate write.
3. CI turns red, approval dismissed, task disarmed, policy changes, PR closes/turns draft or native auto-merge appears **between** eligible observation and write. Assert no merge call.
4. Competing PRs on a shared remote head, two tasks on one PR, active comment repair, two scheduler owners. Assert serialization and safe recovery.
5. Merge completes but task-completion consumer is temporarily unavailable: task stays In Review until the existing merge-completion path reconciles; successors start only after confirmed merge+durable completion.
6. All tests use injected fake GitHub adapter and temp HOME; **never merge a real repository from CI or local tests**.

## Deployment

Existing Kanban server-side `gh` auth must have repo contents **write** permission to use the merge endpoint, plus checks/reviews read. Ensure `gh auth status` is valid in the **running Kanban server's environment**. No paid subscription, additional workflow or new secret is required. No direct admin bypass; GitHub branch/ruleset restrictions still apply. Existing settings remain off, so installing AM-4 must not merge any existing PR. Roll back by disabling auto-merge flags and stopping the executor; do not roll back merged Git commits automatically.
