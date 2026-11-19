# Task auto-merge

Auto-merge defaults to **on** for tasks without a saved preference. A saved
`false` remains off. The checkbox is editable before a PR is linked or CI is
configured; checking it saves the preference immediately.

A checked box means auto-merge is requested. The status explains whether it is
waiting for setup, approval, CI, or comment repairs, blocked, merging, or merged.

## Repository setup

For each repository, use **Repository CI policy → Configure** to choose the exact
required check names and merge method. **Suggest from PR** reads available check
names. Saving the policy activates enabled tasks automatically; no extra checkbox
or PR-selection step is needed for a task with exactly one linked PR. Multiple
linked PRs require selecting the Automation PR.

Without this policy, auto-merge waits even if GitHub shows green checks. The
policy prevents an empty or incomplete set of observed checks from being treated
as a successful pipeline.

Execution still verifies fresh CI results, a non-author approval of the current
head, mergeability, GitHub repository rules, and no active writer/comment repair.
Unresolved review threads do not independently block an approved PR. Outstanding
change requests still block; if GitHub requires resolving conversations, GitHub
enforces that rule during the merge.
Changing a configured policy requires turning an already armed task off and back
on. Changing or removing its Automation PR disarms it; this also applies to a sole
linked PR whose identity changes. Turning auto-merge off persists across reloads
and server restarts.

**Auto complete when the PR merges** independently controls moving the card to
Done and releasing dependent tasks. Auto-merge performs the GitHub merge itself.

## Deployment

No new environment variables or migrations. Deploy the server and web UI together.
Existing tasks with no saved auto-merge preference now default to on and may merge
when their repository CI policy is configured and all execution requirements pass.
Explicitly disabled tasks remain disabled. Existing GitHub credentials still need
permission to merge into the target repository.

On startup, Kanban rechecks stored uncertain comment-publication captures against
their original tool results. A REST reply truncated after its complete ID and API
URL can be recovered when it matches one explicit write to the tracked PR. The
reply is recorded as already published and is not posted again. Captures without
enough matching evidence still require manual Resume.
