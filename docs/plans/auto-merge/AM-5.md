# AM-5: PR-panel controls, status, end-to-end verification and rollout

**Status:** implemented. **One implementation PR into `main`.** Depends on: AM-4. Read [README.md](./README.md).

## Deliverable

Expose deterministic auto-merge in the **existing task PR tracking panel**, with understandable prerequisites, server-owned state and a safe opt-in. Verify the entire flow through its existing task-completion and successor-dispatch integration.

## UX contract

- Add **"Auto-merge when CI passes and at least one review approves"** beside existing **"Auto complete when the PR merges"** in `web-ui/src/components/detail-panels/task-pr-tracking-settings.tsx`. Help text: **"Automatically merge the selected PR when all configured CI checks pass and at least one valid approving GitHub review is present. GitHub's repository rules still apply."** Keep checkboxes independent; default both unchanged (new one defaults off). Approval count is a fixed minimum of one; there is no count-setting UI in V1.
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

## Final state (implemented)

- **`web-ui/src/components/detail-panels/task-pr-auto-merge-settings.tsx`** — the opt-in surface, rendered inside the existing `TaskPrTrackingSettings` panel:
  - "Auto-merge when CI passes and at least one review approves" checkbox, independent of "Auto complete when the PR merges", defaulting off. Enabling first opens an explicit confirmation dialog stating the action really merges into the target base (and that GitHub branch protections/rulesets may require more); disarming is a direct setting write.
  - Arming is disabled with an explicit reason until the server preconditions hold: a selected Automation PR (ambiguous selection blocks it), a stored repository CI policy, and no armed-vs-current policy revision drift (a changed policy requires toggle-off/on to re-arm). Server write failures (no selected PR / no policy / conflict) surface as inline errors.
  - Status line derived purely from server-persisted facts (`deriveAutoMergeStatus`, `web-ui/src/utils/auto-merge-status.ts`): `off` (checkbox state), `waiting: approval` / `waiting: CI` / `waiting: writer/comment repair` (AM-3 summary code categories), `blocked` (codes humanized), `merging` (AM-4 `attempting` journal or fresh eligible summary), `merged` (only the remote-confirmed `merged_confirmed` journal, with merge-commit abbreviation), `needs attention` (terminal journal). Includes last-verified time and head abbreviation; a stale (older than the 2-minute evidence budget) eligible summary is shown as `waiting`, never as merging or merged.
  - When `autoFinishOnMerge` is off, an explicit note explains the PR can auto-merge while the card stays In Review; the existing checkbox remains the independent toggle.
- **`web-ui/src/components/detail-panels/task-pr-auto-merge-policy.tsx`** — the per-repository CI policy affordance in the same panel: shows configured required check names, merge method and revision; edit mode with a one-per-line exact-names textarea and merge-method select (revision-checked save); "Add names observed on the PR" calls the new read-only candidates endpoint and only ADDS names to the draft — saving is an explicit operator confirmation (no autofill).
- **`src/core/api-contract.ts`** — `autoMergeCheckCandidateSchema` / `autoMergeCheckCandidatesRequestSchema` / `autoMergeCheckCandidatesResponseSchema` (candidates + `repository`, `headSha`, `checkedAt`, stable error tokens) and `runtimeTaskTrackingStateResponseSchema.autoMergeAttempt` (the read-only AM-4 journal exposed to the browser).
- **`src/trpc/app-router.ts`** — `prTracking.listAutoMergeCheckCandidates` read query (workspace-scoped, zod-validated).
- **`src/trpc/pr-tracking-api.ts`** — `listAutoMergeCheckCandidates`: resolves the task's selected Automation PR (no_selected_pr / ambiguous_selection), reuses the task's live access scope when a subscription exists, issues ONE coalesced coordinator `readAutoMergeEvidence` (no new poller), refuses incomplete evidence (`evidence_incomplete`, never green), and returns only checks that RAN and PASSED on the exact head with exact identity (dedup by name, sources tracked, deterministically sorted).
- **Tests** — `test/integration/auto-merge-e2e.integration.test.ts` (full fake-GitHub loop: coordinator → AM-3 consumer → AM-4 executor → fenced merge write → remote confirmation → `merged_confirmed` → merge-completion consumer moves the task Done and dispatches successors, then a second poll proves idempotence with exactly one merge write); `test/runtime/pr-tracking/pr-tracking-api.test.ts` (tracking-state exposes `autoMergeAttempt`; candidate endpoint: exact-head success filtering/dedup/sort, evidence_incomplete, no_selected_pr, ambiguous_selection, coordinator_unavailable); `web-ui/src/utils/auto-merge-status.test.ts` (status mapping: opt-in off, first-wait, fresh/stale eligible, waiting categories, blocked, merged/attempting/needs-attention journal precedence, shortSha).

## Implementation notes (deviations worth remembering)

- The candidate endpoint only suggests checks that SUCCEEDED on the exact head (`conclusion === "success"`, `sha === envelope.headSha`, non-zero `runId`, non-null `sourceId`), for both check runs and commit statuses. An in-flight, failed, skipped, stale-head, or identity-less check is omitted — suggesting it would produce a policy that fails closed forever once armed.
- Suggestions never write: the endpoint is a pure read and the UI only appends names to an editable draft; the policy write still goes through the revision-checked `updateAutoMergePolicy`.
- The browser never writes the AM-4 attempt journal or the merge; it only reads `autoMergeAttempt` from the tracking state. All merge causality stays server-side (AM-3/AM-4).
- `deriveAutoMergeStatus` only lets the attempt journal take precedence over the eligibility summary when the journal describes the SAME evidence identity the summary does (head SHA, base SHA, policy revision) — mirroring the executor's rule that `needs_attention`/`waiting` journal entries bind only their own attemptId. `merged_confirmed` is unconditional; a journal entry left over from an older head or policy revision never paints the current evidence red or "merging". An eligible summary older than the 2-minute budget reads as `waiting` (the executor only merges from fresh evidence).
- The opt-in checkbox's arming preconditions gate turning the setting ON only: a checked box is always clickable (disabled while acting, or while OFF and preconditions fail) so the operator can always disarm — the server accepts `autoMergeWhenApproved: false` unconditionally and re-arms at the current policy revision on re-enable — even while the armed revision drifts.
- The tracking-state response exposes `explicitAutomationPrKey` (the card's raw explicit selection, null when unset or no longer linked): the arming write requires an EXPLICIT selection while `selectedAutomationPrKey` also resolves a sole linked PR implicitly, so the checkbox gates on the explicit one. The Automation PR selector also renders for a single linked PR while the explicit selection is unset; it is driven by the explicit value with a placeholder option (never the implicitly-resolved key, which would make the sole option "already selected" and fire no change event), so picking the PR always persists the selection.
- The e2e integration test runs the REAL coordinator + in-memory store + fake `gh` adapter under fake timers with a 60 s poll cadence; the AM-4 handoff is fire-and-forget (as in production), so its confirm reads run off the poll cycle and never coalesce onto the in-flight poll.
