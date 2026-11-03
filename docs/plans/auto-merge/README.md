# Deterministic PR auto-merge — implementation plan

Status: **planning** (2026-11-02). Each AM-N document is a **separate focused implementation PR** into `main`. This planning PR adds documentation only. The implementation is not enabled by these documents.

Source baseline: `main` at `c5734fb56a3b3011104540d5170c93f3082ea6a5` (PR #121 merged). Agents must re-inspect current code before implementation. Repo conventions and `AGENTS.md` take precedence.

## Goal

After a selected, ready-for-review GitHub PR has a current, valid **APPROVED review** and all configured CI checks **succeed**, Kanban merges that exact PR head commit deterministically using its own server process. No agent prompt, model inference, new GitHub-hosted workflow, or paid GitHub plan is needed. The existing `autoFinishOnMerge` mechanism independently moves the task to Done and releases successors **only after GitHub confirms the merge**.

The opt-in belongs in the task's PR tracking panel beside **Auto complete when the PR merges**. The two settings remain distinct. Runtime-wide repository policy supplies required CI check names and the merge method; configure it once per repository, not once per task.

**V1 checkbox label:** **Auto-merge when CI passes and at least one review approves**.

**V1 helper text:** "Automatically merge the selected PR when all configured CI checks pass and at least one valid approving GitHub review is present. GitHub's repository rules still apply."

**At least one** is the fixed V1 threshold: one valid approval suffices for Kanban, and two or more are also acceptable. No approval-count setting is included in V1.

## Alternatives and facts checked

- **GitHub native auto-merge is available to public repositories on GitHub Free.** This repository is public, but its `allow_auto_merge` flag is currently false and `main` is unprotected. Native auto-merge requires GitHub-side merge requirements to be configured. See [GitHub native auto-merge](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request).
- The GitHub REST merge endpoint supports `sha` (expected head), `merge_method`, and GitHub's enforcement of active repository rules. See [GitHub REST API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request).
- An agent-directed merge is possible but unnecessarily nondeterministic. **Build the Kanban-side option requested here**, without disabling native GitHub protections or assuming they exist. Detect native auto-merge if present and do not compete with it.

**Non-negotiable:** `main` currently has no required status checks. A rule of "all GitHub-required checks succeeded" is vacuously true with zero required checks. Never infer merge eligibility from an empty checks list, a green PR summary, a status for an older commit, or a reviewer's prose. Require a user-configured, **nonempty set of check names** in the Kanban repository policy.

## Scope: Kanban trigger versus GitHub merge rules

V1 implements **one explicit policy**, not a configurable replacement for GitHub rules:

- **CI:** every explicitly configured check must be successful on the current PR head; an empty or incomplete check list does not count as passing.
- **Approval:** at least one effective, submitted, current-head GitHub `APPROVED` review from a non-author. Additional approvals are fine. A currently effective `CHANGES_REQUESTED` review remains a blocker, as do stale/dismissed approvals or prose-only comments.
- **Safety:** ready-for-review, correct repository and target, mergeable, no unresolved actionable review threads, no concurrent comment repair/writer, and fresh identity checks. These are fixed safeguards, not knobs.
- **GitHub enforcement:** GitHub branch protection and rulesets remain the final authority. GitHub may require two or more approvals, CODEOWNER review, deployments, or other conditions. A PR satisfying Kanban's one-approval threshold is only a *candidate* for GitHub's merge API. Surface a denied merge as a blocker; never bypass GitHub restrictions or loop on the same denial.

Do not add approval-count options, reviewer-role rules, rule expressions, or a general workflow-policy builder in AM-1 through AM-5.

## Implementation PRs

| Plan | Scope | Depends on |
| --- | --- | --- |
| [AM-1](./AM-1.md) | Persist explicit task opt-in and repository policy, with safe API contracts | None |
| [AM-2](./AM-2.md) | Read complete GitHub approval and CI evidence for an exact head SHA | AM-1 |
| [AM-3](./AM-3.md) | Pure fail-closed eligibility evaluation and coalesced orchestration | AM-2 |
| [AM-4](./AM-4.md) | Fenced, audited, restart-safe GitHub merge execution | AM-3 |
| [AM-5](./AM-5.md) | PR-panel controls, explanations, end-to-end verification and release | AM-4 |

Implement in order: **AM-1 → AM-2 → AM-3 → AM-4 → AM-5**. Each PR should be ready for review when opened. Do not have an implementation agent carry all five at once, or create them automatically as part of the planning PR.

## Shared behavior and ownership

1. **Explicit opt-in:** default off. Only an active task (`in_progress`/`review`) selecting the exact automation PR, with an armed policy revision, may request a merge. Multiple eligible tasks for one PR are ambiguous until ownership is resolved. Turning the setting off cancels future attempts.
2. **One runtime authority:** the existing `PrTrackingCoordinator` already coalesces polls per canonical PR and access scope; `PrConsumerRegistry`, `PrRecordStore`, `pr-reservations` and `pr-task-subscriptions` own lifecycle. Extend, don't introduce another free-running poller, credential store, or second PR registry. Keep per-PR reads bounded and don't fetch CI/reviews for tasks with auto-merge disabled.
3. **Approval:** require a published `APPROVED` GitHub review by a distinct non-author reviewer, effective on the **current head SHA**; latest submitted review per reviewer governs, `DISMISSED`/`PENDING` is never approval, and an effective `CHANGES_REQUESTED` blocks. A bot review is acceptable if GitHub records it as an actual review and it is not the PR author's own approval. Text comments like "LGTM" are not approvals. Require complete pagination and known identity.
4. **CI:** all explicitly configured check contexts must exist on the exact current head and conclude `success`; no observed pending, failing, cancelled, timed-out or unknown relevant head check is accepted. Combine check runs and commit statuses correctly; handle duplicate names and source identities deterministically. Missing, zero, incomplete or stale evidence blocks. Treat `neutral`/`skipped` as non-success in v1 (no silent exceptions).
5. **Other guards:** PR open and not draft, base repo/ref matches the selected task's expected remote target, head identity verified, GitHub reports mergeability without conflicts, no active request for changes, no unresolved actionable review threads, no pending/running/failed unresolved Kanban comment repair, no active task writer or conflicting PR reservation, authenticated write permission, and no policy/selection/HEAD change since evaluation. Any unavailable proof is a blocker, not a pass.
6. **Exactly once in effect:** persist a bounded attempt/decision journal, reserve by PR and head mapping, freshly re-read all mutable preconditions immediately before write, send GitHub's expected `sha`, then **read back GitHub merge state**. After timeout, never blindly send a second merge; reconcile remote state first. Never move the task to Done from a merge-request result alone.
7. **Operational UX:** present `off`, `awaiting approval`, `awaiting CI`, `blocked`, `merging`, `merged` and `needs attention` with explicit evidence timestamps and concise reasons. Show auth/permission failures. Operator can disable, re-arm after a policy change, or retry only after fixing and acknowledging a terminal failure.
8. **Separation of concerns:** comment repair and merge-completion remain independent. Existing `autoFinishOnMerge` stays the sole automatic task-completion and successor-dispatch mechanism. Avoid unrelated changes to model prompts, CI polling by agents, PR creation behavior, task runner or branch protection.

## Possible future extensions (documentation only)

Later iterations **could** support configurable minimum approval counts (e.g. two or three), CODEOWNER/team approvals, human-only reviewer constraints, per-branch policies, repository-rule discovery, deployment/security/label gates, or release windows. These are **not** requirements, commitments, or implementation tasks for AM-1 through AM-5.

Preserve the separation between **GitHub evidence**, **pure eligibility evaluation**, **small versioned repository policy**, and **fenced merge execution** to keep future additions possible. Do not implement a speculative plugin architecture, generic rule language, or policy-editor framework now. Prefer to let GitHub enforce its native policies rather than reproducing every GitHub rule in Kanban.

## Known code touchpoints

- `src/core/api-contract.ts`, `src/core/task-board-mutations.ts`, `src/state/workspace-state.ts`: server-owned task fields and schema; old boards remain loadable.
- `src/trpc/pr-tracking-api.ts`, `src/server/runtime-server.ts`: mutations, runtime wiring, single coordinator.
- `src/pr-tracking/pr-consumer-registry.ts`, `pr-task-subscriptions.ts`, `pr-tracking-coordinator.ts`, `github-gh-adapter.ts`, `pr-snapshots.ts`, `pr-record-store.ts`, `pr-reservations.ts`: shared PR lifecycle, credential scope, read budget, fencing and durable outcomes.
- `src/pr-tracking/pr-merge-completion.ts`: **consume merged observation only**, unchanged authoritative Done/successor pathway.
- `web-ui/src/components/detail-panels/task-pr-tracking-settings.tsx`, `task-pr-tracking-panel.tsx`, `web-ui/src/hooks/use-task-pr-tracking-state.ts`: settings and state visible in the existing PR panel.
- `test/runtime/pr-tracking/`, `test/runtime/pr-tracking/pr-tracking-api.test.ts`, relevant UI tests: deterministic fakes, race tests and integration coverage.
- CI reference: `.github/workflows/test.yml` includes job `build-check-test`; verify its **actual GitHub check-run name** (including possible workflow prefix) before configuring a policy. Do not hardcode this repository's job into general-purpose Kanban.

## Agent instructions, testing and PR reporting

For each AM-N implementation: read this index, only the chosen plan, `AGENTS.md`, current source, and affected tests. Implement only that plan; update the plan's status and implementation notes in its PR. Use strongly typed contracts, bounded noninteractive GitHub commands, Biome (tabs, 120 columns), and existing Vitest/testing conventions. Do not use Prettier on this repository. Run focused tests, lint, typechecks and relevant builds. Use synthetic GitHub API fixtures; do **not** execute live merges in tests.

Every implementation PR description must prominently state: (a) all deployment settings/required GitHub permissions and any env vars; (b) migrations and rollback; (c) all features; (d) exact test commands/results; (e) an operator smoke test for each feature. No new secrets are planned; the existing server `gh` authentication must have appropriate repository write permissions for AM-4. Explicitly describe setting a repository's required CI contexts before enabling auto-merge.

## Deployment for this planning PR

Documentation only. **No service changes, new environment variables, credentials, migrations, hardware modifications, or deployment actions.** Do not enable auto-merge on any current PR. Hardware/homelab docs do not change because no devices are modified.
