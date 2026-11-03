# AM-1: Persist task opt-in and repository-level merge policy

**Status:** implemented. **One implementation PR into `main`.** Depends on: none. Read [README.md](./README.md).

## Deliverable

Backend data contracts and dedicated mutations for a new, disabled-by-default task setting `autoMergeWhenApproved`, plus one shared versioned policy per GitHub repository. No GitHub reads or writes and no automatic merge behavior in this PR.

## Decisions

- Place `autoMergeWhenApproved?: boolean` on `RuntimeBoardCard`, alongside `autoAddressComments` and `autoFinishOnMerge`. Missing/legacy values are false. **Do not** silently enable `autoFinishOnMerge`; the operator may elect one or both.
- Keep this flag server-owned via the existing PR settings mutation and stale whole-board save shielding. Extend `settingsRevision` CAS and responses; a stale client must not overwrite a newer toggle or selected PR.
- Keep V1's approving-review threshold **fixed at at least one** effective review, not exactly one: there is no configurable approval count, reviewer-role rule, CODEOWNERS setting, or generic policy editor in this PR. Additional GitHub-enforced requirements remain GitHub's responsibility.
- Store the **policy per normalized canonical `owner/repo`**, not as a global unchecked default and not in every task. Use one durable, atomic, revision-checked store under the existing runtime home (or a closely related existing settings store if inspected code clearly offers one). Policy: `requiredChecks: string[]` (nonempty, unique, trimmed, case-sensitive exact GitHub check names), `mergeMethod: "merge" | "squash" | "rebase"` (default `merge`), `revision`, `updatedAt`. No tokens or credentials in this file.
- A missing or malformed policy is **not armed**. Do not accept `requiredChecks: []`, glob patterns, vague workflow names, or an implicit "all required GitHub checks" fallback. Validate repository identity against the server-resolved selected automation PR. Reject disallowed merge methods when repository metadata later proves the method unavailable.
- At enable time, bind the task's opt-in to the current policy revision (`armedAutoMergePolicyRevision` or equivalent durable field). A later policy edit invalidates prior arms; require deliberate re-arming to avoid silently broadening an existing opt-in. Changing selected Automation PR or unlinking it disarms auto-merge; editing other PR settings should not.
- Enforce the existing eligible columns (`in_progress`/`review`), selected-PR resolution, and revision conflicts at the server boundary. Do not trust UI checkboxes or an unvalidated repository string from the client.
- Choose stable schema/field names after inspecting current conventions, but preserve these behaviors and the independent `autoFinishOnMerge` setting. No new unrestricted whole-board mutation path.

## Expected files

`src/core/api-contract.ts`, `src/core/task-board-mutations.ts`, `src/state/workspace-state.ts`, `src/trpc/pr-tracking-api.ts`; a small `src/pr-tracking/auto-merge-policy-store.ts` or an existing versioned settings store. Extend tests for board save/reload, schema compatibility, race conflicts, selection changes, and auth of policy writes.

## Acceptance tests

1. Upgrading with old cards and no policy displays disabled without migration or crash.
2. Concurrent settings writes cannot silently flip the new option; stale whole-board saves retain server-owned fields.
3. A policy created for repository A cannot arm an unrelated selected PR in repository B; malformed/missing/empty check contexts fail closed.
4. Policy revision updates disarm previous arms; selecting/unlinking a different automation PR disarms. Enabling does not toggle auto-completion.
5. Tests demonstrate no GitHub merge calls, extra pollers, or runtime execution changes.

## Deployment

No runtime merging becomes possible from AM-1 alone. No environment variable or manual data migration. Persist the policy in the existing runtime-home backup scope; retain policy data across deploys. The AM-5 UI will expose policy configuration and task opt-in.

## Implementation notes (final state)

- `RuntimeBoardCard` gains `autoMergeWhenApproved?: boolean` and `armedAutoMergePolicyRevision?: number` (both optional; absent = false/unarmed). `settingsRevision` CAS covers the new flag.
- `updateTaskPrSettings` resolves the auto-merge half against the fresh card: enabling requires a selected Automation PR whose repository has a current server-resolved policy (`options.autoMergePolicy`), binds `armedAutoMergePolicyRevision`, and no-ops (no revision bump) when already armed at that revision; disabling always wins and drops the armed revision. Fail-closed reasons: `no_selected_pr`, `no_policy`.
- `setTaskSelectedAutomationPr` (select/clear) and `removeTaskPullRequest` disarm auto-merge; other settings edits never do.
- `saveWorkspaceState` treats the two new fields as server-owned: existing cards keep persisted values; new cards never accept client values.
- New durable store `src/pr-tracking/auto-merge-policy-store.ts`: `<runtimeHome>/auto-merge/policies.json` (version 1), file-locked, per-repository revision-checked CAS. Missing/malformed/wrong-version stores fail closed (no policy, no migration, corrupt file never overwritten). Repositories normalize to lowercase `owner/repo`; check names are trimmed, deduped, exact (no globs/whitespace).
- New trpc procedures `getAutoMergePolicy` / `updateAutoMergePolicy` (audited `deps.warn` on every write outcome) and extended `setTaskPrSettings` / `getTaskTrackingState` responses. The policy store instance lives on the runtime server's PR tracking state.
- No GitHub reads/writes, no merge execution, no pollers in this PR.
- Tests: `test/runtime/pr-tracking/auto-merge-policy-store.test.ts` (new), `test/runtime/task-board-mutations.test.ts`, `test/runtime/pr-tracking/pr-tracking-api.test.ts`, `test/integration/workspace-state.integration.test.ts`, `web-ui/src/components/card-detail-view.test.tsx`.
