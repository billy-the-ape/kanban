# PRLINK-9 — Provider boundaries and explicit linked-PR refresh

**Status: READY FOR IMPLEMENTATION. Depends on v1 and PRLINK-6.**
Master plan: [v1](../complete/pr-linking/PR_LINKING_PLAN.md). Shared context: [follow-ups](PRLINK-FOLLOWUPS.md).
Deliver as one provider/read-path PR. This replaces the draft's unbounded multi-provider rollout.

## Fixed scope

Separate pure URL/detection policy from workspace I/O and reuse the existing GitHub tracking adapter,
coordinator, access scope and read limiter in `src/pr-tracking/`. Do not introduce another GitHub
client, timer, token database, automation provider registry or credential UI.

GitHub.com: branch discovery and explicit metadata refresh.
GitHub Enterprise: parsing/manual links and existing branch-discovery compatibility only.
GitLab (including self-hosted): parsing/manual links and existing creation detection only.
Bitbucket Cloud: parsing/manual links only.
No new glab dependency, GitLab/Bitbucket remote lookup, provider delivery path or automation support.
Those are separately planned future features; an interface is not a claim of provider support.
GitHub delivery creation/dedupe remains in git-delivery.ts with unchanged behavior.

## Provider architecture

Keep pure policies in `src/core/pull-request-providers/` with provider id, URL parser and existing
creation-command gate rules. Expose them through the shared pull-request-links/detection entry points.
No execFile, Node-only imports, environment or tokens in code imported by web-ui.
Workspace provider capabilities declare branch discovery and metadata refresh separately.
Resolve provider from the parsed URL identity; resolve branch-discovery context from origin remote
(HTTPS or SSH, including scp form), never from title or from an arbitrary first linked PR.
Missing/unrecognized remotes yield unsupported/no discovery, not a guessed GitHub repository.

Branch discovery retains the existing limit five, bounded direct command execution and best-effort
Review-with-no-links trigger. Do not turn it into live tracking. Normalized draft state must use the
provider draft bit, and merged/closed wins over draft. Existing delivery tests must remain valid;
lookup tests may change to assert the intentionally improved draft/freshness behavior.

## URL policy (settled)

Use URL parsing plus provider path validation. Reject credentials/userinfo, unsafe schemes, missing/
unsafe-positive numbers, invalid ports and malformed repository segments. Known provider hosts cannot
accept another provider's path shape. Unknown hosts use the existing GitHub/GitLab shape rules;
Bitbucket Server and installations under a URL path prefix remain unsupported.
Support DNS/localhost and IPv4 authorities with optional valid port; IPv6 is deferred and rejected.

Lowercase host; `host` includes a nondefault port. Preserve existing case-insensitive repository
identity; remove trailing PR path/query/fragment. Known public hosts retain HTTPS canonicalization;
self-hosted HTTP is accepted only with an explicit nondefault port and then preserves HTTP.
Other portless HTTP links retain v1 HTTPS canonicalization. URL's default-port normalization applies;
http://host:80 is portless for this policy. Scheme is not part of identity: same host/port/repo/number
deduplicates, HTTPS wins if both forms are observed. Different nondefault ports remain distinct.
Existing portless identities do not change and require no migration. Never rewrite a stored HTTP
self-hosted URL merely by rendering it.

This is URL/manual-link support, not authorization to send credentials to an unknown host.
No provider query is made for arbitrary self-hosted pasted links in this milestone.

## Refresh semantics and API

Current workspace.refreshTaskPullRequests only lists current branch PRs; it misses manual links.
Keep that route as **Find PRs for branch** (including Review fallback). Add
workspace.refreshTaskPullRequest({ taskId, url }) for one already-linked PR and
workspace.refreshLinkedTaskPullRequests({ taskId }) for all existing links, capped at 20.
Single-link refresh never adds a link or performs branch discovery. Both are explicit actions,
not reads caused by mounting a view.

For github.com, use a one-shot metadata operation in the shared tracking coordinator. Extend the
foundation read contract here so it works without an active task subscription; the current
prTracking.refreshTaskPrSnapshot requires a subscription and is insufficient for historical links.
Resolve the runtime service's active access scope, coalesce with that PR's existing in-flight read
and obey existing auth/backoff/rate limits. Do not create a subscription, resume stopped tracking,
clear terminal markers or invoke automation consumers from a display-only request. Scheduled
eligible observations still follow their existing lifecycle independently.

Return per-identity outcomes: refreshed | unsupported | failed | unlinked, plus checkedAt/error
where applicable, and an updated count. Aggregate partial success is visible; unsupported or failed
entries preserve their last snapshot/time. A successful unchanged/304 read advances stateCheckedAt
using validated cached data, without inventing a snapshot if none exists. Observation timestamp
follows 6's throttle. Project title/state into card display fields; title needs an optional addition
to the authorized metadata contract/normalizer, not a second fetch/client. Maintain accessScopeId
authorization checks; do not display a previous credential scope's tracked snapshot as current.

Fetch outside workspace locks, then reread/revalidate task and canonical link inside the mutation;
a removed/replaced link is never resurrected. Ignore results older than the currently stored
stateCheckedAt. Do not update primary/source/createdAt/Automation PR selection.
Batch at most four reads concurrently through the shared runtime limiter; each request has the
existing 30-second/8-MiB bound and all-link refresh has a 60-second overall deadline, no retry loop.
Apply completed valid results and report remaining timeouts; task disappearance applies nothing.
Coalesce duplicate refresh clicks, disable pending actions and show concise sanitized outcomes.

## Verification and acceptance

- Parser matrix: public providers, GHE/GitLab nesting, SSH remote resolution, scheme/port policy,
  credentials, unsafe numbers, foreign host/path, unsupported IPv6/path prefixes/Bitbucket Server.
- Missing binary/auth/remote, malformed output, empty discovery, correct draft mapping.
- Metadata: stored manual PR from another branch/repo and Done task refresh by identity; no worktree
  needed for identity refresh; no subscription/consumer effect with tracking disabled/stopped.
- Same PR on two tasks: shared access-scoped read and limiter; scope switch, partial failure, 304,
  deadlines, stale response and unlink/task-delete races; no revision for failed/unsupported reads.
- GitHub delivery regression, creation detection gates and web-ui shared parsing/labels remain valid.

Follow the shared verification/deployment rules in PRLINK-FOLLOWUPS.md.
