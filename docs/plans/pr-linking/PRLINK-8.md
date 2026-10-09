# PRLINK-8 — Link from a URL sent in native task chat

**Status: READY FOR IMPLEMENTATION. Depends on v1; independent of 6/7/9.**
Master plan: [v1](../complete/pr-linking/PR_LINKING_PLAN.md). Shared context: [follow-ups](PRLINK-FOLLOWUPS.md).
Deliver as one native-Cline chat PR. Terminal input support is explicitly deferred.

## Fixed user behavior

Only the native `sendTaskChatMessage` route participates. Never scan `sendTaskSessionInput`:
it also transports terminal keystrokes/control input and does not guarantee complete messages.
Do not scan assistant messages, tool output, initial task prompts, history replay, home-agent
sessions, slash commands or messages rejected by the send operation.

A trimmed message that is **exactly one valid bare HTTP(S) PR URL**, with no attached images,
automatically links it as source:manual after successful send acceptance. A suffix such as /files
or a fragment is permitted and canonicalized by the shared parser. Markdown links, angle-bracket
wrappers, code fences, trailing prose punctuation, multiple URLs, attached images and accompanying
text use the suggestion path, never auto-link. No broader-auto-link setting is added.

Use the shared extractPullRequestLinks/parsePullRequestUrl helpers for suggestions; deduplicate by
canonical identity in appearance order and return at most three. Skip consumed slash commands.
An already linked identity renders **Already linked**, with no clickable duplicate suggestion.
Keep the user's original text/images and normal agent turn behavior unchanged.

A lone URL is an explicit shortcut, **not proof that the PR was created by this task**.
A user can still send a lone reference URL in a review task; acknowledge that limitation with a
visible **Linked <repository>#<number> · Remove link** confirmation. Prose mentions never attach
automatically. Do not claim URL-only classification solves every review-task false positive.

Closed/merged PRs and cross-repository PRs are allowed with manual semantics and repository labels.
No network lookup is needed before linking. Linking does not mark primary or select an Automation PR
explicitly; the existing foundation may reconcile eligibility under its own validated rules.
Do not bypass branch mapping, settings, generation or ownership checks.

## Server contract and write ordering

Classify before send using a pure helper, but apply a link only after the actual send succeeds,
including the successful rebind/retry path. Slash-command handling returns before classification.
Use workspace scope plus the durable task card, not session cwd, and recheck that card exists.
Call the existing recorder/manual-link mutation; broadcast only if changed. Preserve the existing
20-entry cap and protections from PRLINK-6 if installed.

Add an optional `pullRequestLinking` field to the native chat-send response only:
- status: linked | already_linked | suggestions | failed;
- links: canonical parsed identifiers/URLs (up to three);
- error?: concise sanitized message for failed linkage.

Leave the field absent when there are no candidates or the send is unsuccessful/excluded.
The current recorder conflates duplicate/no-task/write-failure: extend its internal result or
re-read authoritative persisted entries before reporting linked/already_linked. A false changed
value alone is never success. A failed record returns failed while retaining send ok:true;
the UI explains **Message sent; PR link could not be saved** and offers the normal Add action.
Never resend the user's message to retry linking.

Keep durable truth only in card.pullRequests. Confirmation/suggestion UI is local to the active
chat, keyed by originating send/task, not injected into the model transcript or persisted as a new
message type. On reload it may disappear; do not retrospectively auto-link or recreate chips from
history. PR links already saved remain. No persistent per-message suggestion ledger.

## UI and concurrent requests

Render a lightweight notice under the composer for the latest completed send, with distinct
repository labels and up to three **Link <repository>#<number> to this task** buttons. A chip calls
workspace.addTaskPullRequest and uses pending/error states; success reads as Linked. Remove link
uses the existing unlink API and its automation invalidation rules. Never hide pending/failed
notices behind another send; serialize composer submission until the send response is handled.
Clear notices on task/workspace change and guard late callbacks against the captured scope.
The board broadcast remains authoritative. Do not attach notices to listMessages().at(-1), which
may already be an assistant/tool message when the send finishes.

## Verification and acceptance

- Pure classifier: bare URL/whitespace/suffixes, images, prose, wrappers, multiple/duplicate URLs,
  slash commands, rejected shapes (/pull/new, /compare, /issues), supported providers.
- Runtime: successful normal/rebound send links once; failed send/clear/home-agent do nothing;
  duplicate vs write failure distinguished; failure preserves message send; removed task race.
- UI: confirmation, suggestions, duplicate notice, Add/Remove errors and pending clicks;
  overlapping send guard and task-switch response isolation; no notice enters model input.
- A GitHub/GitLab/Bitbucket URL supported by the installed shared parser works without provider CLI.
  Self-hosted scheme/port additions arrive in 9; no parser fork here.

Acceptance: bare-URL shortcut works without reload; prose references require a user click;
link-save errors do not fail or repeat the agent turn.
Follow the shared verification/deployment rules in PRLINK-FOLLOWUPS.md.
