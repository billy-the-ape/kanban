# PR conflict repair — an explicit "Resolve conflicts" action

**Status: planning.** Not implemented. Source baseline: `main` @ `e003a49c`. Re-inspect current code before implementing; `AGENTS.md` and repo conventions take precedence over this document.

## Goal

When Kanban knows that a task's tracked pull request no longer merges cleanly into its base branch, offer **one explicit button** that sends a conflict-repair turn to that task's own agent session. The turn is told to (1) establish the current state, (2) explain the source of each conflict, (3) merge the base into the PR head and reconcile both intents, (4) validate locally, and (5) push a normal (non-forced) update to the existing PR branch — then end the turn.

This is the third explicit git action beside **Commit** and **Open PR**, but for a state those two cannot express: the work is finished and pushed, the tree is clean, and only the merge is broken.

## Non-goals (V1)

- No automatic / unattended conflict repair. The trigger is always human-clicked.
- No auto-resolving conflicts without a model. Kanban has no authority to pick a side.
- No rebase, squash-then-force-push, history rewrite, PR merge, approval, or protection bypass.
- No repair for tasks in `done`/`trash` whose worktree is already gone (V1 refuses and explains).
- No new GitHub-hosted workflow, no polling for CI/review after publishing (`PR_CI_HANDOFF_GUIDANCE` still applies).

## What exists today

| Concern | Today | File |
| --- | --- | --- |
| Conflict detected | `mergeable === false` → blocker code `merge_conflicts` ("The current head does not merge cleanly into the base branch.") | `src/pr-tracking/auto-merge-eligibility.ts` |
| Conflict rendered | Auto-merge status line only, and only when the task is opted in | `web-ui/src/utils/auto-merge-status.ts`, `web-ui/src/components/detail-panels/task-pr-auto-merge-settings.tsx` |
| Where the metadata comes from | One REST PR read → access-scoped snapshot with `head.ref`, `base.ref`, `head.sha`, `base.sha`, `mergeable`, `mergeable_state` | `src/pr-tracking/github-gh-adapter.ts` (`readPrMetadata`), `src/pr-tracking/pr-snapshots.ts` (`normalizePrMetadata`), `githubPrMetadataSnapshotSchema` |
| Snapshot without any subscription | `refreshPrMetadataOnce()` persists the snapshot; the PRs panel's **Refresh linked PRs** already calls it | `src/pr-tracking/pr-tracking-coordinator.ts`, `src/workspace/task-pull-request-refresh.ts` |
| Explicit git actions | Client-side template render + send, review-only, `{{base_ref}}` is the only variable | `web-ui/src/git-actions/build-task-git-action-prompt.ts`, `web-ui/src/hooks/use-git-actions.ts` |
| Server-driven repair turn | PR comment repair: prompt built server-side, git refreshed first, delivered as a Cline turn or a Pi paste | `src/pr-tracking/comment-handling-prompt.ts`, `comment-git-refresh.ts`, `src/pr-tracking/pi-repair-dispatch.ts` |
| Per-review-episode send dedupe | `card.sentGitActionPrompt = { action: "commit" \| "pr", sentAt }`, acquire/release under the workspace lock | `src/workspace/task-git-action-prompt.ts` |

## Decisions worth arguing about before code

1. **Server-rendered prompt, not client-rendered.** The commit/PR templates only need `{{base_ref}}`, which the browser has. A conflict prompt needs the *provider-authoritative* head/base branch and SHAs, which the browser does not have (`RuntimeTaskWorkspaceInfoResponse.branch` is null for the usual detached-HEAD task worktree; `card.baseRef` is the card's base, not the PR's base). Build and dispatch in a tRPC mutation so the numbers in the prompt are facts, not guesses.
2. **Keep the templates operator-editable** like the other two, so the wording is a setting rather than a fork.
3. **The trigger must not inherit auto-merge's opt-in.** Today `deriveAutoMergeStatus()` returns `null` unless `autoMergeWhenApproved === true`, and provider polling only happens when a consumer is armed (`computeTaskSubscriptionDemand`). A conflict button that silently requires auto-merge is a bug, not a feature.
4. **Scope the repair to one PR**, named by the row the user clicked, never by "whichever PR the automation would pick".

---

## PCR-1 — Conflict signal (read-only, no dispatch)

Add a conflict block to the task tracking state so the UI can offer the action regardless of the auto-merge checkbox.

```ts
// runtimeTaskTrackingStateResponseSchema (additive, optional)
conflict: {
  state: "clean" | "conflicting" | "unknown" | "unsupported";
  prKey: string | null;
  headRef: string | null;
  baseRef: string | null;
  headSha: string | null;
  baseSha: string | null;
  checkedAt: number | null;
  source: "provider_snapshot" | "local_probe" | "none";
  note: string | null;   // "mergeability not computed yet", "gh unavailable", …
} | null;
```

Resolution order for `state`:

1. **Provider snapshot** (authoritative, github.com only): newest access-scoped `GitHubPrMetadataSnapshot` for the requested PR. `mergeable === false` → `conflicting`; `mergeable === true` → `clean`; `mergeable === null` → `unknown` (GitHub has not computed it yet). `mergeableState === "dirty"` is a corroborating signal, never the only one.
2. **Local probe** (fallback for GHE/GitLab/no `gh`): `git merge-tree --write-tree <base> <head>` after a scoped `--no-tags --no-write-fetch-head` fetch of both refs, mirroring `refreshCommentWorktree`'s ref hygiene. Advisory only: report `source: "local_probe"` and never claim `clean` from a probe that could not see GitHub's merge drivers.
3. Otherwise `unsupported`/`unknown` with a `note`.

Also:
- Populate the snapshot lazily on the PRs-panel read via the existing one-shot refresh, so opening the PRs tab is enough to know the answer (no consumer checkboxes involved).
- Surface `unknown` as a neutral "GitHub is still computing mergeability" line with a **Re-check** affordance, never as green and never as a conflict.
- Keep `merge_conflicts` in the auto-merge status; the new block is the trigger, the auto-merge line stays the explanation.

**Tests:** `test/runtime/pr-tracking/pr-snapshots.test.ts` (mergeable mapping), new `test/runtime/pr-tracking/pr-conflict-state.test.ts` (resolution order, `null` mergeability, non-github host, stale snapshot), `test/runtime/workspace/conflict-local-probe.test.ts` (real bare-origin fixture: clean, conflicting, rename, deleted-file).

---

## PCR-2 — The repair turn

### Trigger placement

- **Primary:** per-PR row action **Resolve conflicts** in `web-ui/src/components/detail-panels/task-pull-request-row.tsx` (actions come from `web-ui/src/hooks/use-task-pull-request-actions.ts`), enabled only when `conflict.state === "conflicting"`.
- **Secondary:** a one-line CTA under the auto-merge status when the blocker list contains `merge_conflicts`.
- **Not** on the board card: `showReviewGitActions` in `web-ui/src/components/board-card.tsx` is gated on `changedFiles > 0`, which is normally false exactly when this feature is wanted (work is committed and pushed). Card placement would also require shipping conflict state into the board payload for every card.

### New configuration

Mirror `commitPromptTemplate` / `openPrPromptTemplate` everywhere, adding `conflictPromptTemplate` + `conflictPromptTemplateDefault`:

- `src/config/runtime-config.ts` — `DEFAULT_CONFLICT_PROMPT_TEMPLATE`, `normalizePromptTemplate`, global + project read/save, `...Default` projection.
- `src/core/api-contract.ts` — `runtimeConfigResponseSchema` and `runtimeConfigSaveRequestSchema`.
- `src/terminal/agent-registry.ts` — project it into `RuntimeConfigResponse`.
- `web-ui/src/components/runtime-settings-dialog.tsx` — third variant in the existing commit/PR template selector (`{{token}}` help list must document the new variables).

### Variables (rendered server-side)

| Token | Source | Missing-value rule |
| --- | --- | --- |
| `{{pr_url}}` | the clicked link's canonical URL | required — refuse |
| `{{repository}}` | `owner/repo` from the PR link | required — refuse |
| `{{head_branch}}` | snapshot `head.ref` | required — refuse with "open the PRs tab and Refresh linked PRs" |
| `{{base_branch}}` | snapshot `base.ref` | required — refuse |
| `{{head_sha}}` / `{{base_sha}}` | snapshot `head.sha` / `base.sha` | optional — omit the sentence, never render `null` |
| `{{base_ref}}` | `card.baseRef` (the task's own base) | optional; add an explicit "card base ref may differ from the PR base; the PR base wins" clause |
| `{{task_worktree_path}}` | `resolveTaskCwd({ ensure: false })` | required — refuse when the worktree is missing, and refuse rather than substitute a scratch checkout (it names the only checkout the turn may touch) |

Rendering rules: reuse a shared `interpolateTemplate` (extract from `build-task-git-action-prompt.ts` so both paths share it); **never** substitute an empty string for a required token; leave unknown `{{tokens}}` untouched so an operator template stays intact; length-cap and single-quote every interpolated value (branch names and PR text are untrusted and end up in a turn that has push rights).

### Pre-dispatch guards (all refusals must be visible, not silent)

| Guard | Why | Reuse |
| --- | --- | --- |
| Card in `in_progress`/`review`; worktree exists and is readable | a Done/Trash card has no checkout to merge in | `resolveTaskCwd`, `PR_OWNER_ACTIVE_COLUMNS` |
| Worktree is the task's own and its base ref still matches the card | avoid repairing in a reused/stale checkout | `matchesWorkspaceInfoSelection` semantics |
| No `MERGE_HEAD` / `rebase-merge` / `rebase-apply` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` / `sequencer`, no unmerged index entries | a half-finished operation must not be inherited | the marker loop in `refreshCommentWorktree` |
| No active writer on the card, no in-flight comment repair | two prompts, one session | `isTaskWriterActive`, comment dispatch hold |
| Auto-merge journal is not `attempting` for this task | never push under a fenced merge write | `autoMergeAttempt.state` |
| PR reservation free / acquire one for the repair | browser, CLI and delivery must not race the PR | `reservePrOperation` / `validatePrOperation` |
| PR still open, not draft, branch not deleted, `native_auto_merge` absent | otherwise the turn can only fail | snapshot `state`, `autoMergePresent` |
| `head_ref` and `base_ref` pass `git check-ref-format`; head repo matches a configured remote | a fork head with no local remote means "push" is a lie | `refreshCommentWorktree`'s remote matching |
| Re-read head immediately before dispatch and embed the expected SHA | the user may have pushed meanwhile | `refreshCommentWorktree`'s "PR branch changed during refresh" |
| `startInPlanMode` forced false; `checkTaskLaunchRequirements` for the effective agent | a plan-mode repair is a read-only repair | `src/core/task-launch-requirements.ts` |

### Delivery

Follow the comment-repair contract rather than inventing a third sender:

- Native Cline: `createTaskChatMessageSender` with `mode: "act"`, `source: "automated"` (so `lastPrompt` and PR-linking classification stay clean); the existing rebind path resumes a persisted session after a restart.
- Pi: `sendPreparedPiRepair` with a `ClineTurnPreparation`, restore-only, bracketed paste with control characters stripped, and the **Pi capacity gate** for the turn (a queued Pi start is `idle` + `pid: null` and is invisible to liveness checks).
- Every other terminal agent: refuse with "open this task's terminal and keep it idle, then press Resolve conflicts" (mirrors `isCommentServableAgent`). Do not pretend the paste landed.
- Never route it into a bounded review session: `src/cline-sdk/review-tool-policy.ts` denies `git push`, commits, merges and `gh pr create` by design.

### Dispatch record and restart safety

Do **not** overload `card.sentGitActionPrompt` (its union is `commit | pr` and it is cleared when the card leaves Review; a failed repair must be re-triggerable while a duplicate from a second tab must not be). Add a small durable record keyed by head SHA:

```ts
conflictRepair: { prKey, headSha, dispatchedAt, status: "dispatched" | "failed", error?: string }
```

- Set before the send; clear/overwrite on a later dispatch; a second click while `dispatched` for the same head is refused with the timestamp.
- On restart, a `dispatched` record is **not** replayed (same rule as comment repair: an accepted prompt is never re-run). It only explains the state; a fresh click against the current head is what retries.
- After a successful push the head SHA changes, so the record naturally expires on the next read; the UI then shows `unknown` ("GitHub is recomputing mergeability") rather than a stale conflict.

---

## Default template

`PR_CI_HANDOFF_GUIDANCE` is already the last paragraph of the requested text, so append the shared constant instead of duplicating it (as `DEFAULT_OPEN_PR_PROMPT_TEMPLATE` does). Add one precedence clause, because the same session may still be under "do not pull, fetch, rebase, reset, or merge" from a comment-repair turn and "do not run destructive commands" from the commit template:

```
Resolve merge conflicts for the tracked pull request:

PR: {{pr_url}}
Repository: {{repository}}
Head branch: {{head_branch}}
Base branch: {{base_branch}}
Known remote head: {{head_sha}}   Known remote base: {{base_sha}}

This turn is the explicit exception to the standing "do not fetch, pull,
rebase, or merge" guidance: fetching the base and merging it into the PR head
is required. Everything else in that guidance still applies. Never force-push,
never rewrite published history, never touch any checkout other than the ones
named here, and never merge the pull request.

Your goal is to preserve the intended behavior of both the PR and the latest
base branch, resolve their conflicts, and push a tested update to the existing
PR branch.

1. Establish the current state
   - Read the repository's AGENTS.md and relevant contribution instructions.
   - Retrieve the PR's current head/base branches and commit SHAs from the
     remote provider. Treat these as authoritative; the supplied metadata may
     be stale.
   - Fetch both branches and inspect the working tree.
   - Work only in the task checkout at {{task_worktree_path}}. Do not create or
     switch to another worktree or checkout, and do not touch any other working
     copy — including the one holding the base branch. Use it only if it is on
     the PR head, either as the head branch itself or as a detached HEAD at that
     commit (the Kanban default), and only if its state is understood; preserve
     uncommitted work. If it is unusable (missing, dirty beyond your work,
     mid-operation, or diverged from the PR head), stop and report instead of
     improvising.
   - Confirm that a conflict still exists against the latest base. If it has
     already been resolved, report that and make no unnecessary changes.

2. Explain the source of the conflicts
   Before resolving them, inspect:
   - The PR description and changes relative to its merge base.
   - The relevant changes introduced on the base branch.
   - The conflicting files, surrounding code, and affected callers or tests.
   Identify what each side intended and explain why the changes conflict.
   Distinguish overlapping edits from behavioral incompatibilities, renames,
   deletions, generated files, and dependency changes.

3. Resolve the conflicts
   Merge the latest remote base branch into the PR head branch. Prefer a merge
   commit so existing PR history is preserved; do not rebase or force-push.
   Resolve each conflict by reconciling the intended behavior of both sides.
   Do not blindly accept "ours" or "theirs," discard tests, weaken assertions,
   or remove functionality merely to obtain a clean merge.
   Follow existing architecture and formatting conventions. If dependencies or
   generated files conflict, reconcile their source inputs and regenerate
   outputs using the repository's documented tools and pinned tool versions.
   Keep the repair focused. If the intended behavior cannot be determined from
   the code, tests, PR context, and repository instructions, stop and describe
   the exact decision needed rather than guessing.

4. Validate the result
   - Confirm that no unmerged index entries or unintended conflict markers remain.
   - Review the staged diff and resulting changes relative to the latest base.
   - Run relevant tests, type checks, linting, formatting checks, and builds as
     appropriate for the affected code.
   - Add or update focused tests where the reconciliation changes behavior or
     exposes a regression that existing tests do not cover.
   - Verify that both the PR's intended behavior and relevant base-branch
     behavior are preserved.
   - Clearly report any checks that could not run and why. Do not describe an
     untested repair as fully verified.

5. Publish safely
   - Before pushing, check whether the remote PR head changed while you worked.
     If it did, fetch and incorporate those changes, then repeat relevant
     validation. Do not overwrite another actor's commits.
   - Commit the resolution and push normally to the existing PR head branch.
     The task checkout is usually a detached HEAD with no local branch of the
     PR's own, so push the current commit to the remote ref explicitly:
     `git push <remote-for-the-head-repository> HEAD:refs/heads/<head_branch>`.
     Never force. A rejected (non-fast-forward) push means the remote moved:
     fetch, re-verify, and incorporate it — do not reach for `--force` or
     `--force-with-lease`, and do not push a new branch into another
     repository.
   - If the base moved again, assess whether another merge is necessary. Avoid
     an unbounded repair loop; report persistent concurrent updates.
   - Leave the PR open for CI and review. Do not merge the PR, approve it,
     bypass repository protections, or poll waiting for CI/review completion.

Finish with:
- The source of each conflict.
- How the resolution preserves the intent of both branches.
- Validation performed and any remaining limitations.
- The pushed commit SHA and PR URL.

If blocked, explain the concrete blocker and leave the checkout in a clearly
reported state. Do not claim the conflict is resolved unless the repair has
been committed and pushed successfully.
```

Three additions over the requested text, each failure-shaped:
- The **known SHAs** line + "treat these as authoritative" pair, so the model can prove the remote moved instead of trusting a stale Kanban render.
- A **pinned checkout**: step 1 names `{{task_worktree_path}}` as the only working copy the turn may touch. Without it, "never touch any checkout other than the ones named here" names nothing, and gotchas 11 and 18 become live risks rather than closed ones. This is why the token is required rather than optional.
- The **detached-HEAD push-target** clause (the Kanban default is a detached worktree with no local PR branch): `git push <remote> HEAD:refs/heads/<head_branch>`, non-forced only, with "a rejected push means the remote moved — fetch, re-verify, never `--force`". A non-fast-forward rejection is the safety net; do not let `--force-with-lease` talk it out of the model's head.

**Anything this block is meant to instruct must live inside the block.** PCR-2 copies the fenced text into `DEFAULT_CONFLICT_PROMPT_TEMPLATE` verbatim; a bullet written after the closing fence is documentation for us and silence for the model. Both of this document's first-draft contradictions came from exactly that: a push-target rule described below the fence but absent from step 5, and a scratch-worktree invitation inside the fence that gotchas 11 and 18 argued against. Re-read the fenced block on its own before editing it — the template must be self-consistent with no outside prose to lean on.

---

## Gotchas and pitfalls

### Detection

1. **Conflicts are invisible unless a consumer is armed.** Polling demand needs one of `autoAddressComments`, `autoFinishOnMerge`, or an *armed* `autoMergeWhenApproved`, and `deriveAutoMergeStatus()` returns `null` when auto-merge is off. A button driven off that path is dead for most cards. PCR-1 must read the snapshot directly (or refresh once), not borrow auto-merge's status.
2. **`mergeable: null` is the common case, not an edge case.** GitHub computes mergeability asynchronously, so a freshly pushed head often reports `null` + `mergeable_state: "unknown"`. Treating `null` as "no conflict" hides the button; treating it as "conflict" invents work. Both are the same trap the auto-merge evaluator already names `mergeability_unknown` for.
3. **Card base ≠ PR base.** Eligibility flags `pr_identity_mismatch` when the PR's base differs from `card.baseRef`. Interpolating `{{base_ref}}` as the PR base, or vice versa, sends the model to merge the wrong baseline. Ship both and say which wins.
4. **`merge_conflicts` shares one red line with unrelated blockers** (`check_missing`, `no_approval`, `mergeability_unknown`). The button needs the *code*, not "the status is red".
5. **Local probes can disagree with GitHub.** `git merge-tree` follows local merge drivers (`.gitattributes merge=binary|ours|theirs`), rename heuristics, LFS pointers, and cannot see GitHub-side state at all. Advisory only; never render a local "clean" as a green light.
6. **Non-github.com links.** `supportsPrMetadataRefresh` is github.com-only, so GHE/GitLab links have no snapshot — the local probe (or an honest `unsupported`) is the only path.

### The checkout

7. **Kanban task worktrees are detached by default.** `workspaceInfo.branch` is null and `refs/heads/<head_branch>` usually does not exist locally, so "your branch" is a fiction. Prompt accordingly, and never let the model `checkout -b` a local branch and `git push origin <same-name>` into the *base* repository.
8. **The worktree may not exist at all.** `cleanupInterruptedTaskWorktrees` in `src/server/shutdown-coordinator.ts` removes In Progress/Review worktrees on shutdown, and done/trash paths remove them too. A button that survives a restart but has nothing to merge in must refuse, not silently `ensure` a fresh worktree at the current base (that would *lose* the PR's commits from the local view and invite a "reimplement it" turn).
9. **The worktree may be behind or diverged from the PR head.** Reuse `refreshCommentWorktree`'s discipline: clean tree only, fast-forward only, refuse on divergence, and re-verify HEAD/attachment after the fetch.
10. **Uncommitted local work belongs to the user.** Commit-template language ("preserve pre-existing user uncommitted changes") is not a substitute for a policy: state whether to stash, and forbid `stash`/`reset --hard`/`clean -fd` in the repair turn if the tree is dirty (refuse instead).
11. **Scratch worktrees are a PCR-4 problem, so step 1 forbids them.** A second checkout for isolation sounds safer but breaks validation: worktree pruning races, `node_modules`/venvs are absent so test/lint steps silently no-op (this fork's task worktrees ship without `node_modules`), and Kanban's own cleanup may delete what the model created mid-turn. V1 pins the repair to `{{task_worktree_path}}` and tells the model to stop when that checkout is unusable; if isolation is ever needed, that variant has to provision dependencies and exempt its own scratch path from cleanup first.

### The push

12. **Fork heads are the norm.** When `headRepository !== baseRepository`, `origin` is the *base* repo. Pushing "the branch" creates a new branch upstream and leaves the PR untouched — a silent failure that looks like success. Match the remote against `headRepository` first (as `refreshCommentWorktree` does) and refuse when no remote can carry the commit; also account for `maintainer can modify` and fork push permissions.
13. **Credentials live in the Kanban server's inherited shell env.** A headless/SSH-tunnel runtime may have no askpass, no SSH agent, and `GIT_TERMINAL_PROMPT=0` in Kanban's own calls. A model sitting on an interactive credential prompt looks exactly like a hung session. Preflight push reachability (a dry-run or remote-permission read) and surface it *before* the turn burns tokens.
14. **A push costs an approval round-trip.** New commits invalidate current-head approvals and re-run checks, and repos that dismiss stale reviews on push will reset the user's one approval to zero. Auto-merge evidence is keyed to the head SHA, so `autoMergeAttempt` identity changes and the whole CI/approval wait starts over. Say this in the button tooltip — it is the most common "why is it red again" support question.
15. **`native_auto_merge` present, PR closed/merged/draft, branch deleted, protected head** — each needs its own refusal text, not a prompt.
16. **Squash-merge repos:** a merge commit inside the PR is discarded at merge time, so the resolution's *content* is what survives. Not a blocker, but worth a line so the model does not consider the merge commit itself the deliverable.

### Concurrency

17. **Multiple writers on one PR.** Competing with: comment-repair turns (same session), deterministic delivery B-8 (`gitDeliveryPolicy.enabled` routes Commit/Open PR through the app and can integrate/push under the repair), the auto-merge executor's fenced merge, `reservePrOperation` holders from browser/CLI, and base-refresh/worktree-setup locks (`getTaskBaseRefreshLock` vs `getTaskWorktreeSetupLock` must stay distinct paths). Take the PR reservation for the repair and refuse while it is held.
18. **The base branch checkout is someone else's.** The commit template habitually walks the model to the base checkout (`git worktree list` → `git -C P cherry-pick`). Repair must stay in the task worktree, which is what the `{{task_worktree_path}}` sentence in step 1 buys; keep the token and that sentence together, or the prompt says "other checkouts are off-limits" while naming none.
19. **The `autoReviewEnabled` path can fire right after the repair ends** (a review episode re-evaluates when the session settles) and the review-episode dedupe record is shared with commit/PR. Keep conflict repair out of `sentGitActionPrompt` and check `autoReviewEnabled` before promising the card will idle.

### Delivery to the agent

20. **Only Cline and Pi are reliably addressable server-side.** `sendTaskSessionInput` returns "Task session is not running." for a stopped terminal agent, and comment automation deliberately limits itself to `isCommentServableAgent`. V1 should be equally honest; a silently dropped prompt in a terminal agent is worse than a refusal.
21. **Terminal paste mechanics**: multiline prompts need the bracketed-paste frame + a separate `\r`, control-character stripping (the Pi path already does this), and — for Pi — the model-capacity gate. Skipping the gate breaks the per-model concurrency budget; forgetting the `\r` leaves the text sitting in the input box with nothing running.
22. **Do not reuse review sessions or plan mode.** `createReviewToolPolicy` denies push/commit/merge/`gh pr create`; `startInPlanMode: true` yields a read-only "resolve it" that can only talk about the conflict. An unsupported request must be a refusal, never a downgrade to Act mode.
23. **Long conflict turns are the norm** (fetch + merge + full validation). Any UI "still working?" affordance must key on writer admission (`isTaskWriterActive` / `getTaskWriterActivity`), not a summary's `running` flag alone.

### Prompt-content risks

24. **Injection.** PR titles/bodies, branch names, and base-branch commits all reach a turn that holds push rights. Interpolate only canonical, length-capped values; never paste PR body text into the prompt (point at `gh pr view` instead); treat the template as the single source of truth and append nothing after it except the shared CI-handoff constant.
25. **The template is a config string.** Empty/whitespace templates fall back to the default via `normalizePromptTemplate`; a template that drops the guardrail paragraphs is the operator's choice, so the hard refusals (no force-push, no merges, no bypass) must also live in Kanban's guards, not only in prose.
26. **Conflicting standing guidance in the same session**: "Do not pull, fetch, rebase, reset, or merge" (comment repair), "Do not run destructive commands" (commit template), plus the repo's own `AGENTS.md`. The repair prompt must state which rule it lifts and for how long, or the model will politely refuse to fetch.

### Repo plumbing (this fork specifically)

27. **`RuntimeConfigResponse` additions break cast mocks.** Adding `conflictPromptTemplate` is invisible to `as unknown as RuntimeConfigResponse` fixtures (e.g. `runtime-settings-dialog.test.tsx` hand-builds config); grep every factory, do not just read the tsc error list.
28. **Any new `@runtime-*` alias needs three registrations**: `web-ui/tsconfig.json`, `web-ui/vite.config.ts`, `web-ui/vitest.config.ts`.
29. **Tests that touch worktrees/receipts/dispatch records must redirect `HOME`/`USERPROFILE`** to a temp dir in `beforeEach`; real-push behavior belongs in a bare-origin fixture (`test/integration/task-dispatch.integration.test.ts` MERGE-1 pattern). `git rev-parse --verify <sha>` proves syntax, not existence — use `cat-file -e`.
30. **`npm run format` rewrites ~10 unrelated tracked files** in this fork; run it, then `git checkout --` anything the change does not touch.
31. **Bounded environment truths:** GNU tar extraction failures and `middleware`/`projects-api` suites are environment-dependent failures; do not debug them as regressions while validating this feature.

---

## UI contract

- Row action **Resolve conflicts** (`Button size="sm"`, `icon` = `Spinner` while pending, `GitMerge` icon otherwise), disabled with a tooltip when: no workspace scope, PR not open, `conflict.state !== "conflicting"`, a repair is already dispatched for this head, no agent session is reachable.
- Status line after the click: `repair dispatched · head a1b2c3d · 12:04` → on the next re-read either `conflicts resolved` (green) or `still conflicting` (red, with the retained reason) or `GitHub is recomputing mergeability` (neutral).
- Tooltip on the button: "Fetches the latest base, merges it into `<head_branch>`, and pushes a normal commit to the existing PR branch. Existing approvals and check runs reset on the new head. Kanban will not merge or force-push."
- Refusals are inline text next to the row, not toasts only; the destructive-adjacent nature of a push means the reason must survive a re-render.
- Mobile: same row action with `min-h-11`, no new browser poller (reuse the PRs panel's existing 5s `getTaskTrackingState` poll).

## Suggested PR sequence

| PR | Scope | Depends on |
| --- | --- | --- |
| PCR-1 | Conflict block on the tracking state, provider snapshot + local probe fallback, PRs-panel status, tests | — |
| PCR-2 | Template config + settings UI + server renderer + `resolveTaskPrConflicts` mutation + guards + Cline/Pi delivery + dispatch record + row action | PCR-1 |
| PCR-3 | Lifecycle hardening: PR reservation, auto-merge/delivery interplay, restart reconciliation copy, `docs/runtime/pr-conflict-repair.md`, post-repair status polish | PCR-2 |
| PCR-4 (optional) | Other terminal agents (explicit terminal-first flow), non-github hosts, scratch-worktree repair for Done cards | PCR-3 |

## Open questions before implementation

1. Should **Re-check** force a provider read, or is the 5s snapshot re-read enough? (Rate limits argue for a debounce.)
2. Is **conflict repair from a Done card** worth PCR-4's complexity, or does "reopened card" cover it?
3. Should the local probe be the default when `gh` is missing, or strictly opt-in via a setting so we never advertise a conflict GitHub has not reported?
4. Should this button also be exposed through the CLI (`kanban task repair-conflicts --task-id …`), which would make the mutation the single entry point for browser, CLI, and any future automation?
