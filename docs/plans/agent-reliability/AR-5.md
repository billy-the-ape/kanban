# AR-5: Standardize publication wording in native coding sessions

Status: planned. One implementation PR into `main`. Dependencies: none.
Change type: **primarily improve existing prompting**. Review the exact wording below.
Read [README.md](./README.md) and [EVIDENCE.md](./EVIDENCE.md).

## Outcome

When a coding agent is authorized to publish a PR or feedback, Markdown arrives intact
without shell command substitution or literal escaped-newline corruption. Existing
publication identity capture, bounded comment batches, and tool choice remain intact.

## Current integration points

- `web-ui/src/git-actions/build-task-git-action-prompt.ts` already instructs Auto-PR to
  write UTF-8 and use `gh pr create --body-file`. Preserve this working instruction.
- `src/cline-sdk/sdk-runtime-boundary.ts`: native coding system prompt composition.
- `src/pr-tracking/comment-handling-prompt.ts`: execution prompts and publication contract.
- `src/pr-tracking/pr-publication-attribution.ts` and current tests: IDs/output capture.
- `src/cline-sdk/review-tool-policy.ts`: bounded reviewers cannot commit/push/publish.

The gap is ordinary coding/user-driven publication that does not receive the Auto-PR
prompt. Do not rewrite attribution, add a GitHub client, remove terminal access, force
one provider tool, or replace current structured publication output instructions.

## Proposed wording

```text
When publication is authorized, preserve the exact intended Markdown. If using gh CLI for a multiline PR description or comment, write the body as UTF-8 to a file and use the command's supported --body-file option. For an API operation, use its supported structured input or file input. Keep backticks, dollar signs, quotes, and real newlines out of shell-interpolated body arguments. Keep temporary body files out of commits.

Verify the stored body once after publication, and retain the identity/output required by the current workflow. If publication times out or its identity is unclear, inspect the existing remote state before creating another object. Follow the current bounded feedback instructions when choosing which comments to address.
```

The wording does not authorize publication, broaden a feedback snapshot, or require
checking for fresh comments throughout an implementation loop. Native/API/connector
publication that already accepts structured text need not create a body file.

## Required implementation

1. Add a short named native coding guidance constant at the actual composer; use existing
   Auto-PR wording as the source of truth and avoid contradictory duplicate paragraphs.
   Scope it to publication-capable coding sessions. Do not inject a publication instruction
   into the sidebar-only or bounded-review role. Preserve explicit tool/provider preferences.
2. Reuse or minimally align wording only where an existing automatic publication prompt
   contradicts this contract. Keep plan diffs small; a reusable helper is warranted only
   for real shared behavior, not to create a new cross-layer prompt framework.
3. Preserve current PR identity JSON/output instructions and comment-exclusion/feedback
   snapshot rules. Prefer a temporary file or existing artifact location; never stage
   the body file with `git add .`. No credential or environment requirements are added.

## Acceptance and verification

- Include the literal before/after prompt diff and affected routes in the implementation
  PR. Test ordinary native composition and existing Auto-PR prompt generation.
- A local stub `gh` captures argv and body-file bytes for Markdown containing backticks,
  `$(...)`, dollar signs, quotes, Unicode, and blank lines. No interpolation executes.
  Use no real remote writes in automated tests; do not use JSON stringification as shell
  escaping for the fixture. Verify stored structured-input bytes on the non-CLI path.
- Existing publication-attribution tests and bounded comment prompt tests pass. A timeout
  example checks existing-object inspection guidance, not automatic publication retry.
- A bounded-review prompt still prohibits publication; no new instruction weakens it.
- Run affected prompt/attribution suites, backend and frontend typechecks as applicable,
  and repository formatting. Prompt tests do not establish live-model compliance.

## Deployment and rollback

Normal deploy and new native coding sessions; no environment variables, migration,
model setting, or new GitHub authorization. Roll back this wording independently if it
causes duplicate lookups, unsolicited publication, or conflicts with feedback boundaries.
