# PR conflict repair ("Resolve conflicts")

A task's tracked pull request can stop merging cleanly when the base branch
moves. Kanban exposes exactly one action for that state — the **Resolve
conflicts** button on the PR row — and it is a human-clicked, server-rendered
agent turn against the task's own checkout. There is no automatic repair, no
rebase/squash, no PR merge, no approval or protection bypass, and no
force-push anywhere in this lane.

## Conflict state (`RuntimePrConflictState`)

`getTaskTrackingState` carries a `conflict` block computed by
`createConflictStateService` (`src/pr-tracking/conflict-state-service.ts`):

- **Provider snapshot first.** The durable PR record's latest snapshot is
  authoritative: `mergeable === false` → `conflicting`, `mergeable === true`
  → `clean`, `mergeable === null` → `unknown` ("still computing"). A dirty
  `mergeableState` hint is corroborating text only — it never sets the state.
  When the snapshot is missing or stale, the service fires one debounced
  `refreshPrMetadataOnce` in the background; the 5s panel poll picks the
  result up. Nothing here depends on auto-merge being opted in.
- **Local probe fallback.** Only when no provider snapshot exists (and the
  card is active), an advisory `git merge-tree --write-tree` probe runs
  against the freshly fetched remote base
  (`src/workspace/pr-merge-probe.ts`). It fetches into a throwaway ref under
  `refs/kanban/merge-probe/` with `--no-tags --no-write-fetch-head` and
  deletes it afterwards: the working tree, index, and HEAD are never
  touched. Results are cached per (workspace, task, PR) for
  `CONFLICT_PROBE_TTL_MS` and refreshed in the background — the response
  never blocks on git, and the last completed view stays displayed while a
  TTL re-probe is in flight (blanking it would flip the row back to
  Re-check every TTL).
- **Never green, never red, on inference.** Probe results carry
  `source: "local_probe"`; a local *clean* renders as `unknown` (merge-tree
  follows local merge drivers, rename heuristics and LFS pointers, and
  cannot see provider state), and only a provider `mergeable === false` (or
  a local conflict, labeled) renders as `conflicting`. Hosts without
  metadata reads and without a probe report `unsupported` with an
  explanatory note.
- **Re-check** (`refreshTaskPrConflict`) forces exactly one provider read
  (the coordinator coalesces and honors Retry-After) and never claims a
  green light the provider has not reported.

## The repair turn (`resolveTaskPrConflicts`)

`src/pr-tracking/conflict-repair-dispatch.ts` mirrors the comment-repair
delivery contract and refuses visibly (machine-readable `reason` +
human-readable `error`) before any side effect:

| Refusal | Cause |
| --- | --- |
| `no_task` / `inactive_task` | card missing, or not In Progress/In Review |
| `no_automation_pr` / `pr_mismatch` | the clicked PR is not the task's resolved Automation PR |
| `agent_unsupported` | effective agent is not native Cline or Pi |
| `launch_unsupported` | `checkTaskLaunchRequirements` refuses (never a silent downgrade) |
| `worktree_missing` | no task checkout to merge in; no substitute checkout is used |
| `git_operation_in_progress` / `unmerged_index` | shared markers probe (`src/workspace/git-operation-state.ts`) |
| `writer_active` | the card's own agent still holds the writer |
| `comment_repair_pending` | a comment-repair turn is queued/running for the same PR/session |
| `auto_merge_attempting` | the fenced auto-merge executor is writing to this PR |
| `no_snapshot` / `pr_not_open` / `native_auto_merge` / `head_unknown` / `clean_merge` / `invalid_ref` / `no_head_remote` | provider re-verification immediately before dispatch (head re-read included); `invalid_ref` additionally enforces a conservative branch allow-list (`[A-Za-z0-9._/@+-]`) because `git check-ref-format` accepts shell metacharacters and the refs name a push command in a prompt an agent with push rights may run through a shell |
| `already_dispatched` | a repair is outstanding for this PR **and head SHA** (refusal carries the dispatch time) |
| `pr_reserved` | another operation holds the PR reservation |
| `prompt_invalid` | the template renders empty or a required token has no value |
| `send_failed` | the turn could not be delivered (the record keeps `status: "failed"` so a retry is possible) |

Delivery: native Cline via the shared task-chat sender (`mode: "act"`,
`source: "automated"`); Pi via the prepared-repair paste with the shared
model-capacity gate (`sendPreparedPiRepair`). The dispatch record is claimed
compare-and-set **before** the PR reservation is taken (see below), and the
reservation is then held for the dispatch window only (acquire → send →
release in all outcomes); the repair turn itself re-checks the remote before
pushing.

### Dispatch record and restart safety

`card.conflictRepair` (`prKey`, `headSha`, `dispatchedAt`, `status`,
`error?`) is server-owned (`mergeServerOwnedConflictRepair` in
`src/state/workspace-state.ts`). The claim is a **compare-and-set under the
workspace lock** (`claimConflictRepair`): it refuses to overwrite an
outstanding `dispatched` record for the same PR key and head SHA, so two
clicks racing in separate tabs can both pass the earlier board read but only
one can land — the loser is refused with the winner's dispatch time. (The PR
reservation cannot close this gap: `reservePrOperation` treats a second
reservation by the same task and operation as an idempotent success.) The
claim runs before the reservation so a losing call never releases the
winner's hold. Any failure after the claim — a rejected send, a thrown send,
an unexpected throw — settles the record as `failed`, keeping the retry lane
open for the same head. It is never replayed after a restart — it only
explains the state; a fresh click against the current head is what retries.
After a successful repair push the head SHA changes, so the record
naturally expires on the next read.

## Prompt template

`conflictPromptTemplate` mirrors the commit/PR templates (global + project
config, settings dialog third variant, `...Default` projection). Rendering
is server-side (`src/pr-tracking/conflict-prompt.ts`) with the shared
interpolator (`src/core/prompt-template-interpolation.ts`):

- Required tokens (`{{pr_url}}`, `{{repository}}`, `{{head_branch}}`,
  `{{base_branch}}`, `{{task_worktree_path}}`) refuse the dispatch when the
  value is missing — never an empty substitution.
- Optional tokens (`{{head_sha}}`, `{{base_sha}}`, `{{base_ref}}`) drop
  their whole line when missing — never a rendered `null`.
- Unknown `{{tokens}}` are left untouched.
- Every value is sanitized (line breaks collapsed, length-capped) because
  branch names and provider strings are untrusted text entering a turn that
  has push rights; branch refs that reach the prompt are additionally gated
  by the dispatch allow-list, and the default template quotes the branch
  placeholders as a second layer. The hard refusals (no force-push, no
  merges, no bypass) also live in the dispatch guards, since operators may
  edit the template.

## Test surfaces

- `test/runtime/pr-tracking/pr-conflict-state.test.ts` — resolution rules.
- `test/runtime/workspace/pr-merge-probe.test.ts` — real-git probe fixtures
  (clean, conflict, rename, delete/modify) and the no-mutation contract.
- `test/runtime/pr-tracking/conflict-state-service.test.ts` — lazy refresh
  and cached background probe behavior.
- `test/runtime/pr-tracking/conflict-prompt.test.ts` — renderer rules.
- `test/runtime/pr-tracking/conflict-repair-dispatch.test.ts` — guard
  ordering, reservation, both delivery lanes, concurrent-click claim, thrown-
  send failure record.
- `web-ui/src/components/detail-panels/task-pull-request-row.test.tsx` —
  the CTA contract (unknown → Re-check; conflicting → Resolve; dispatched →
  disabled with the reason; failed → retry allowed).
- `web-ui/src/state/board-state.test.ts` — `card.conflictRepair` survives
  board hydration (the row only ever sees the normalized board) and
  malformed records are dropped.
