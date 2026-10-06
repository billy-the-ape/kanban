# PRLINK-8 — Link a PR by pasting its URL into the task chat

**Status: PROPOSED (draft for refinement; execute only after PR-linking v1 has merged).**

Master plan: `PR_LINKING_PLAN.md`. Index: `PRLINK-FOLLOWUPS.md`.
Depends on: **PRLINK-1** (`recordTaskPullRequests`), **PRLINK-5** (manual link route and `source: "manual"`).
Related: **PRLINK-9** (provider abstraction) so the same flow works for GitLab/Bitbucket.

## Purpose

Today a user links a PR by opening the top-bar popover and pasting the URL. They would rather just paste the PR link into the chat with the agent, since that is where they already are. GitHub first, but the flow must not hard-code GitHub.

## Why this needs care

Master plan Requirement 1 says PRs are captured from the *act of creating a PR*, never by scanning prose. A **user** pasting a URL is a different signal, but still ambiguous: a user may paste a PR URL for the agent to *review*, to *compare against*, or because it is *this task's* PR. Auto-attaching every pasted PR would reproduce exactly the false positives the plan was designed to avoid (a review task adopting PR #205 because the user mentioned it).

## Proposed behavior

Detect on the **user's outgoing message** and decide by confidence:

1. **High confidence, auto-link**: the whole trimmed message is a single PR URL (nothing else). Record it with `source: "manual"` and show a short confirmation line in the chat ("Linked PR #123 to this task"). The message is still forwarded to the agent unchanged.
2. **Ambiguous, ask**: the message contains one or more PR URLs among other text. Do not link automatically. Show a non-blocking inline action under the sent message: **"Link PR #123 to this task"** (one chip per distinct PR, max 3). One click records it as `manual`.
3. **No PR URL**: nothing happens; no extra work on the hot path beyond a cheap regex test.

A message that the existing slash-command handling consumes (for example the Cline `clear` command) is never scanned.

## Implementation notes

- **Where to detect.** Server-side in the two message entry points in `src/trpc/runtime-api.ts`: `sendTaskChatMessage` (~line 1597, native Cline chat) and `sendTaskSessionInput` (~line 1354, terminal agents). Both already receive the raw text. Use the existing strict parser (`extractPullRequestLinks` / `parsePullRequestUrl` in `src/core/pull-request-links.ts`); do not add a second URL matcher. Do detection after the message has been accepted so a failed send does not link anything.
- **Single write path.** Call `recordTaskPullRequests({ source: "manual", ... })` from `src/workspace/task-pull-requests.ts`, then broadcast only if `changed`. Best-effort: a failed record never fails the message send.
- **Return the outcome to the UI.** Extend the send response with an optional `linkedPullRequests` / `pullRequestSuggestions` field (optional, so uncast mocks and older clients are unaffected) so the chat can render the confirmation line or the "Link PR" chips without a second round trip. The chips call the existing `workspace.addTaskPullRequest` route; no new write route is needed.
- **Task scoping.** Home-agent sessions (`isHomeAgentSession`) have no card; skip detection for them.
- **Provider neutrality.** Detection goes through the shared parser, which already classifies GitHub, GitLab and Bitbucket URLs. Nothing here should mention `gh`. Any provider-specific enrichment (title/state lookup) belongs behind the provider interface from PRLINK-9 and is optional for this milestone: the link is recorded from the URL alone, as manual adds are today.
- **UI.** The chat composer area is under `web-ui/src/components/detail-panels/` (`cline-chat-composer.tsx` and the message list). Render the confirmation / chips as a lightweight system-style row, not as part of the user's message text. For terminal agents (xterm-based, no message list) there is no chat surface: either skip the chips and only auto-link the pure-URL case with a toast, or defer terminal agents. State the choice in the implementation notes.

## Edge cases

- Same URL pasted twice: no-op (identity dedupe), confirmation says "already linked".
- URL for a different repository than the task's workspace: still allowed (manual semantics), but the chip text includes `owner/repo#123` so the user sees it.
- `/pull/new/<branch>`, `/compare`, `/issues/<n>`: rejected by the parser, no chip.
- More than the 20-entry cap: existing eviction rules apply (manual entries are evicted last).
- Pasted into a review session (a Cline review session reading someone else's PR): the ambiguous path asks rather than links, which is the point.

## Tests

- Unit: message classification (pure URL, URL with text, multiple URLs, no URL, slash command, `pull/new`), including GitLab and Bitbucket URLs.
- `runtime-api` tests with `HOME`/`USERPROFILE` isolation: pure-URL message records a `manual` PR and still reaches the agent; mixed text records nothing and returns suggestions; home-agent sessions record nothing; a record failure does not fail the send.
- web-ui: confirmation row and chip rendering, chip click calls `addTaskPullRequest`.

## Acceptance

- Pasting a lone GitHub PR URL into the task chat links it to the task and the card/top bar update without a reload.
- A PR URL inside a longer message offers a one-click link and never links by itself.
- A review task that merely discusses another PR does not adopt it.

## Open questions

1. Is "pure URL only" the right auto-link threshold, or should the user opt in to broader auto-linking in settings?
2. Terminal agents have no chat surface: toast only, or defer?
3. Should a pasted URL for a **closed or merged** PR be auto-linked (it could be the user pointing at an old reference)? Needs the snapshot, which needs the provider lookup from PRLINK-9; until then, treat all the same.
