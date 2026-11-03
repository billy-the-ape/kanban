# AM-5: PR-panel controls, status, end-to-end verification and rollout

**Status:** planned. **One implementation PR into `main`.** Depends on: AM-4. Read [README.md](./README.md).

## Deliverable

Expose deterministic auto-merge in the **existing task PR tracking panel**, with understandable prerequisites, server-owned state and a safe opt-in. Verify the entire flow through its existing task-completion and successor-dispatch integration.

## UX contract

- Add **"Auto-merge when CI passes and at least one review approves"** beside existing **"Auto complete when the PR merges"** in `web-ui/src/components/detail-panels/task-pr-tracking-settings.tsx`. Help text: **"Automatically merge the selected PR when all configured CI checks pass and at least one valid approving GitHub review is present. GitHub\'s repository rules still apply."** Keep checkboxes independent; default both unchanged (new one defaults off). Approval count is a fixed minimum of one; there is no count-setting UI in V1.
- Show the selected **Automation PR** identity. If multiple linked PRs exist and selection is ambiguous, display a blocker and do not enable. The existing `Automation PR` selector remains authoritative.
- Add a small **repository CI policy** affordance in the same panel: configured exact required check names; selected merge method (`merge`, `squash`, `rebase`); evidence that the contexts actually exist. Configure the policy once per normalized GitHub repository. Never autofill with an unverified placeholder. For convenience, suggest names from observed GitHub check runs **but require explicit operator confirmation**. When policy is missing, empty, incompatible or changed, disable arming and show why.
- Before enabling, make the merge consequences explicit (this action actually merges into the target base, not merely marks the card Done). Explain that GitHub branch protections and rulesets can impose additional approval or deployment requirements that Kanban does not override. On successful enable, show armed policy revision. When policy changes, mark existing opt-ins disarmed and require re-arm.
- Present separate concise status: `off`, `waiting: approval`, `waiting: CI`, `waiting: writer/comment repair`, `blocked: missing policy/ambiguous PR/permission/conflicts`, `merging`, `merged`, `needs attention`. Include last verified time and current head abbreviation; never show stale evidence as green.
- If `autoFinishOnMerge` is off, explain that the **PR can auto-merge while the card remains In Review**. Offer an independent checkbox, not a forced implicit toggle.
- Show explicit server error/conflict feedback for policy writes and task toggles. Support a retry/re-arm affordance only where the state machine allows; do not add a one-click bypass of CI or approval.
- Do not add configurable approval counts, reviewer roles or custom conditions in V1. Future options are documented in the roadmap only.
- UI remains accessible on mobile and does no expensive GitHub parsing. Keep `useTaskPrTrackingState`'s existing visible-panel poll strategy; no new browser poller or extra body-sized payloads.

## E2E acceptance matrix

| Input | Expected |
| --- | --- |
| Opt-in off; approved + CI green | No auto-merge |
| Opt-in on; CI pending or review missing | Wait; no merge |
| CI succeeds then valid review; or review then CI | Exactly one verified merge attempt |
| Two approvals and green CI | Same Kanban eligibility as one approval |
| One approval, green CI, but GitHub requires two approvals | GitHub denies the merge; show a blocker; never bypass or retry indefinitely |
| No configured CI names despite green-looking GitHub PR | Configuration blocker, no merge |
| Old-head approval or successful check; draft; conflicts; missing permissions | Block, never merge |
| Comment repair in progress; unaddressed changes request; head moves | Wait or block; re-evaluate before write |
| Double runtime, duplicate polls, restart after timeout | No double merge; reconcile remote |
| GitHub confirms merge; `autoFinishOnMerge` on | Task moves Done and linked successors dispatch as already implemented |
| GitHub confirms merge; `autoFinishOnMerge` off | PR merged; task not auto-completed |
| Disable or change selected PR before write | No merge |
| Mobile panel open/closed | Clear status; no costly hidden polling |

## Expected files and tests

`web-ui/src/components/detail-panels/task-pr-tracking-settings.tsx`, `task-pr-tracking-panel.tsx`, `web-ui/src/hooks/use-task-pr-tracking-state.ts`, `src/trpc/pr-tracking-api.ts`, `src/core/api-contract.ts` and relevant UI tests; add a full fake-GitHub integration test covering the coordinator → eligibility → executor → remote merge observation → task Done → successor release. Test no runtime-wide PR tracking regressions with commenting and merge completion.

Run focused Vitest suites and applicable `npm run lint`, `npm run typecheck`, `npm run build`, web-ui tests/typechecks; format TypeScript with Biome. Include a deliberate mobile smoke test to avoid slowing the task detail panel.

## Rollout, deployment and rollback

1. Deploy with all task opt-ins off (safe by default). Existing server GitHub credentials must have required repo read/write permissions; no new env vars or GitHub subscription.
2. Configure the actual exact check context names for one test repository/PR from GitHub check-run evidence, then enable one test task; ensure a formal submitted current-head approval and a successful head CI run. Observe one merge and existing task lifecycle.
3. Validate missing approval, pending CI, failed CI, stale approval and comment-repair race in a **disposable test repository**; do not test negative paths by risking an important PR.
4. Review status/logs and rollback procedure, then enable additional task opt-ins selectively. No automatic backfill/arming of old cards.
5. To stop future merges, turn off task opt-ins (or server-side merger feature flag **only if added explicitly**); rollback of deployed code cannot undo GitHub merges. Keep journal data for diagnostics.

**PR description checklist:** feature summary, API/credential permissions, policy configuration, any new settings/env vars, persistent-data migration and rollback, exact tests and outcomes, and a short reproduction/verification flow for each status.
