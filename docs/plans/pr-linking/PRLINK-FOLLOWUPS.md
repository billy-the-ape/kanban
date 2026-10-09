# PR linking — settled post-v1 implementation tasks

Updated: 2026-10-09. **Planning only; no follow-up implementation is delivered by this PR.**
These five documents are implementation-ready specifications, one PR each. Preserve their IDs.
The landed v1 plans now live in [complete/pr-linking](../complete/pr-linking/PR_LINKING_PLAN.md);
the old PL numbering in that historical master plan does not create another card series.

## Execution order

| Task | Deliverable | Requires |
| --- | --- | --- |
| [PRLINK-6](PRLINK-6.md) | Observation timestamps and primary display preference | Landed v1 |
| [PRLINK-7](PRLINK-7.md) | Mobile primary anchor and shared manager | v1 + 6 |
| [PRLINK-8](PRLINK-8.md) | Native chat bare-URL shortcut and explicit prose suggestions | v1 |
| [PRLINK-9](PRLINK-9.md) | Pure provider boundaries and identity-based explicit refresh | v1 + 6 + existing tracking foundation |
| [PRLINK-10](PRLINK-10.md) | PR view in changes panel with shared management | 6 + 7 + 9 |

Recommended sequence: 6 → 7 → 8 → 9 → 10. Each task includes decisions, integration points,
error/concurrency behavior and acceptance. Do not add a preliminary planning PR or expand into
extra implementation PRs by default. Each agent reads its task, this index, relevant existing code
and the dependency contracts.

## Review findings resolved

The original drafts left timestamp duplication/throttling, fallback ordering, mobile placement,
terminal input handling, provider delivery scope, tab state and refresh semantics undecided.
They also predated the tracking foundation now present on main. These documents settle those choices:

- createdAt is first recorded; lastSeenAt is throttled observation, not snapshot freshness.
- Primary for display and Automation PR are separate. Display selection never authorizes automation.
- Mobile uses a direct primary anchor plus a consistent manager button beside Chat/Diff.
- Native chat supports the lone-URL shortcut; prose needs a click. Raw terminal input is excluded.
- GitHub.com explicit metadata reads share the existing tracking coordinator. Other providers retain
  parsing/manual links; no new GitLab/Bitbucket networking or delivery.
- PRs occupy a UI view, not a git-diff API mode. External anchors retain their external behavior.
- Find PRs for branch and Refresh linked PRs are distinct operations.

## Integration ownership and baseline

PR #63 originally targeted feat/task-pr-links at 0e4f3ec. V1 is now landed and archived.
These revised plans are based on main 292e12cbbcfdcfca04a7c9a6a6cc79602a9bc72d and preserve current
source. Reinspect the current implementation before each task; historical line numbers and status
labels in older master plans are not proof of current behavior.

Read the [tracking foundation](../github-pr-tracking/github-pr-tracking-master-plan.md),
[merge tracking](../pr-merge-tracking/pr-merge-tracking-master-plan.md) and
[comment handling](../pr-comment-handling/pr-comment-handling-master-plan.md) contracts.
They own settings, Automation PR validation, auth scopes, subscriptions, polling, repair ownership,
operation gates, terminal/reopen markers and completion. Reuse them; these follow-ups add no second
automation selection, poller or task lifecycle. A linked reference PR is not a completion signal.
The foundation's checkboxes remain opt-in; confirmed merge acceptance stays unchanged.

Known source anchors: src/core/api-contract.ts; pull-request-links.ts/pull-request-detection.ts;
task-board-mutations.ts; src/state/workspace-state.ts; src/workspace/task-pull-requests.ts and
task-pull-request-lookup.ts; src/trpc/workspace-api.ts/runtime-api.ts/pr-tracking-api.ts;
src/pr-tracking/; web-ui task-pull-request-manager, card-detail-view, top-bar, board-card and
detail-panels/task-pr-tracking-panel. The current recorder conflates duplicates/failures and current
branch lookup cannot refresh all stored links; task 8/9 must explicitly address those limitations.

## Shared implementation verification and rollout

Follow root AGENTS.md. Keep server-owned fields protected from stale board saves, use optional
contract additions and update mocks. Execute network/model work outside board locks; revalidate
task/link/scope before committing a result. Share identity and parser logic with web-ui.
Use sanitized timestamped logs for new operational errors; never log tokens or full chat text.

Run focused backend/UI tests, backend/web typechecks where touched, Biome on supported changed
files, and required CI. Markdown is outside biome.json's configured includes: preserve ordinary
Markdown layout/trailing newlines; do not run Prettier over the repository.
Isolate HOME/USERPROFILE in persistence tests and use createGitTestEnv for fixture subprocesses.
Each implementation PR prominently lists deployment/settings/migrations/rollback and an easy
manual test for every added behavior; do not claim fixture tests prove production rollout.

This planning PR adds **no environment variables, dependencies, migrations or deployment steps**.
Tasks 6/7/8/10 need no new service configuration; task 9 reuses runtime service gh authentication,
which is separate from the chat author's existing GitHub OAuth connection. Optional metadata fields
must remain backward-compatible; preserve them and tracking records during rollback.
Do not enable automation, request login or modify devices as part of these documentation changes.
After any later real service/device update, append a final operational task to update
billy-the-ape/homelab-documentation through the established Ready for Review PR workflow.
