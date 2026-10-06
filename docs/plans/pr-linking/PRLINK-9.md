# PRLINK-9 — Provider abstraction (GitHub first, GitLab/Bitbucket next)

**Status: PROPOSED (draft for refinement; execute only after PR-linking v1 has merged).**

Master plan: `PR_LINKING_PLAN.md`. Index: `PRLINK-FOLLOWUPS.md`.
Depends on: PR-linking v1. Enables full multi-platform behavior for **PRLINK-8** and the lookups in **PRLINK-5**.

## Purpose

The v1 *stored shape* and *URL parser* are provider-neutral (`provider: "github" | "gitlab" | "bitbucket"`, host, repository, number; GHE and self-hosted GitLab classified by URL shape). The v1 *behavior* is GitHub-only in several places. This milestone puts those behind a small provider interface so adding a platform is one new module, not edits across the runtime.

## Where v1 is GitHub-specific (verified)

- `src/workspace/task-pull-request-lookup.ts`: branch lookup shells out to `gh pr list --head <branch> --state all --json number,url,title,state` and maps gh's `OPEN/MERGED/CLOSED` states.
- `src/workspace/git-delivery.ts`: PR open/dedupe uses `gh pr list` and `gh pr create`; the receipt and `GhCommandResult` are gh-shaped.
- `src/core/pull-request-detection.ts`: the creation gate already knows `glab mr create` and `hub pull-request`, but MCP detection and output parsing are only exercised against GitHub and GitLab shapes.
- UI: label formatting handles `MR !123` for GitLab; state tinting and `validatePullRequestUrlShape` are tuned to the three URL shapes.
- `http://` hosts are canonicalized to `https://`, and hosts with ports do not match, which matters for self-hosted instances.

## Proposed design

```ts
interface PullRequestProvider {
	id: RuntimeTaskPullRequestProvider;
	/** Classify a URL for this provider (replaces the per-provider regexes in the parser). */
	parseUrl(raw: string): ParsedPullRequestLink | null;
	/** Command gate patterns for creation detection (gh pr create, glab mr create, ...). */
	isCreationCommand(tokens: string[]): boolean;
	/** Optional, best-effort, never required for linking. */
	lookupByBranch?(input: { cwd: string; branch: string }): Promise<ProviderPullRequestSnapshot[]>;
	fetchSnapshot?(link: ParsedPullRequestLink, cwd: string): Promise<ProviderPullRequestSnapshot | null>;
}
```

- Providers live in `src/core/pull-request-providers/` (parsing and detection, pure) and `src/workspace/pull-request-providers/` (CLI execution, I/O). The pure half stays importable by web-ui through the alias, as the shared parser is today.
- A registry resolves a provider from a parsed link or a remote URL. `ParsedPullRequestLink` and the stored schema do **not** change.
- **GitHub provider**: move the existing `gh` code behind the interface with no behavior change. This is the milestone's regression anchor; the existing lookup and delivery tests must pass unchanged.
- **GitLab provider** (`glab`): `glab mr list --source-branch`, state mapping `opened/merged/closed/locked`, `!<n>` labels already present in the UI. Delivery integration is **out of scope** unless delivery itself gains a GitLab path.
- **Bitbucket**: URL parsing and manual link only (no stable first-party CLI). Snapshot lookup via API is a later decision.
- All CLI calls keep the existing rules: direct `execFile`, no interactive shell, bounded timeouts, silent degrade on missing binary or auth failure.
- Self-hosted fixes folded in: preserve the original scheme when it was `http://` and the host explicitly carried a port; allow `host:port` in the host matcher; add tests.

## Out of scope

- Live PR status sync, webhooks, or creating PRs from the UI (unchanged from the master plan non-goals).
- Authentication handling beyond what the CLI already has.

## Tests

- Table-driven parser tests per provider, including GHE, self-hosted GitLab with subgroups, Bitbucket, ports and `http://`.
- Provider contract tests: each provider's `lookupByBranch` with a fake runner (missing binary, unauthenticated, empty, malformed JSON).
- GitHub provider parity: existing `task-pull-request-lookup.test.ts` and `git-delivery.test.ts` pass without edits.
- web-ui: label, tint and URL-shape validation per provider driven from one shared table.
- `HOME`/`USERPROFILE` isolation and `createGitTestEnv()` for any test that touches workspace state or Git.

## Acceptance

- Adding a platform requires a new provider module and a registry entry only.
- GitHub behavior is byte-for-byte unchanged.
- Pasting a GitLab MR URL (PRLINK-8) links it correctly even without `glab` installed.

## Open questions

1. Is Bitbucket worth a provider at all beyond URL parsing?
2. Should provider selection be inferred from the repository's `origin` remote when the URL host is unknown (for example a GHE host the parser guessed)?
3. Does delivery (B-8) grow a provider interface too, or stay GitHub-only for now?
