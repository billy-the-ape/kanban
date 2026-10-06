# PR linking — follow-up milestones (post v1)

These are **proposed** follow-ups to PR linking v1 (`PRLINK-0` … `PRLINK-5`, master plan `PR_LINKING_PLAN.md`). They are drafts to refine; none is scheduled and none should be started until v1 has merged. They are written to be executed independently, so an agent only needs its own file plus the master plan.

| Doc | Milestone | One line | Depends on |
| --- | --- | --- | --- |
| `PRLINK-6.md` | PR metadata and "primary" PR | `lastSeenAt` (and first-seen), a user-settable primary flag, deterministic fallback, shown first on the card and task detail | v1 |
| `PRLINK-7.md` | Mobile task detail | Primary PR link and manage popover reachable on mobile (the top-bar git section is desktop-only today) | v1 (better with 6) |
| `PRLINK-8.md` | Paste a PR URL into the chat | Link a PR to the task from the chat, auto-link only when the message is a lone URL, otherwise a one-click suggestion; GitHub first, provider-neutral | v1 (parser, manual route) |
| `PRLINK-9.md` | Provider abstraction | Move `gh` code behind a provider interface; GitLab (`glab`) and Bitbucket parsing next; self-hosted URL fixes | v1 |
| `PRLINK-10.md` | PRs tab (exploratory) | A "Pull requests" tab beside All Changes / Last Turn with state, source, seen dates and per-PR actions | 6, 7, ideally 9 |

## Suggested order

`PRLINK-6` → `PRLINK-7` → `PRLINK-8` (GitHub) → `PRLINK-9` → `PRLINK-10`. 6 comes first because 7 and 10 both want the primary PR; 8 can move earlier since it only needs v1; 9 can run in parallel with 6 and 7 because it touches the lookup/delivery layer rather than the card UI.

## Confirmed facts about v1 that these docs rely on

- Each PR is one object (`runtimeTaskPullRequestSchema`): provider, host, repository, number, canonical url, source, `createdAt`, optional title/state/`stateCheckedAt`.
- v1 has no primary flag; the board card shows the **last element** of the list and the top bar shows all of them (3 inline, then "+N").
- The board card link renders in every column and on every viewport. The top-bar links, "Link PR" popover and Refresh render **only on desktop** (`!isMobile` branch in `top-bar.tsx`).
- `pullRequests` is a server-owned card field; any new PR fields stay server-owned.

## Not covered here

Live PR status sync, webhooks, creating PRs from the UI and auto-moving cards on merge remain the master plan's non-goals. The v1 review items (Refresh feedback toast, web-ui duplication of the shared identity key, stale plan status) belong on the v1 PR, not in these milestones.
