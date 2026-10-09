# Kanban reliability and sequential delivery implementation plan

Document revision: 3  
Prepared: 2026-09-15 (revision 2: 2026-09-16)  
Status: B-0 partially deployed and validated; restart recovery failed; application reliability fixes remain planned.  
Source baseline: abd4912c27ce6b7f18b5a8106c145fd838e90cc4 (Kanban 0.1.70).  
Inspected installed SDK: @clinebot/core 0.0.38 and @clinebot/shared 0.0.38.  
Fork: https://github.com/billy-the-ape/kanban  
Upstream: https://github.com/cline/kanban

## Purpose and delivery summary

Make Markdown-planned feature implementation dependable with a locally hosted model: execute one task, review and repair its changes in a separate context, run configured checks, commit and integrate using application code, push and verify, then start the next eligible task with fresh context. Preserve recoverable work through every failure. Keep the implementation modular and suitable for small upstream PRs, while allowing independent tasks to run concurrently when hardware permits.

B-0 establishes the reproducible deployment. B-1 captures evidence and regression fixtures. B-2 and B-3 repair context handling. B-4 and B-5 establish durable completion and preservation. B-6 and B-7 separate review from verification. B-8 implements deterministic Git delivery. B-9 handles sequential handoff. B-10 exposes useful controls and diagnostics. B-11 validates optional parallel execution. B-12 validates the complete workflow and documents rollout.

The B identifiers are implementation milestones, not upstream package versions. Subtasks use stable identifiers such as B-6.2. Do not renumber completed milestones. Record later additions under a new B number.

## Requirements

1. Use the existing local-model route, including an OpenAI-compatible llama-swap endpoint. Do not require a cloud model for planning, coding, review, compaction, or commit messages.
2. Preserve configurable agent rules and enforceable tool/terminal permissions in every agent phase.
3. Retain the Cline coding loop rather than replacing the working agent harness.
4. Give review/fix its own bounded agent session, followed by application-controlled verification and Git delivery.
5. Commit, integrate onto the selected feature branch, push to the configured origin branch, and verify before advancing dependent tasks.
6. Start each new task with fresh conversation history and durable references to its requirements and prerequisite results.
7. Default the target workflow to one active model worker; design for dependency-aware parallel workers without simultaneous writes to the same checkout.
8. Treat approximately 262k tokens as the reported operating ceiling. Verify the actual server configuration; do not assume the exact number or rely on context extension.
9. A failed attempt must leave discoverable, preserved code and an explicit resumable stage.
10. Keep private infrastructure details, credentials, live task contents, and private repository logs out of the public fork.

## Evidence and uncertainties

### Confirmed in the inspected baseline

- src/cline-sdk/cline-context-overflow-compaction.ts implements a temporary Kanban fallback. It keeps approximately the latter half of the message array, advances to a user message, and adds a notice containing a preview of the first user message capped at 300 characters. This is truncation with a notice, not a comprehensive semantic summary.
- src/cline-sdk/cline-task-session-service.ts contains retryAfterContextOverflow, which reads persisted history, applies the fallback, stops the session, and restarts it with retained messages.
- The installed SDK exposes CoreCompactionConfig, including enabled, strategy, thresholdRatio, reserveTokens, preserveRecentTokens, contextWindowTokens, and a compaction callback. This proves API availability, not that the correct policy is active in every Kanban request.
- Kanban never configures that API. No file under src/ or web-ui/src/ references CoreCompactionConfig, thresholdRatio, reserveTokens, preserveRecentTokens, or contextWindowTokens. The only compaction code in the repository is the Kanban-side fallback named above. Whatever compaction behavior exists today is therefore the SDK default, unconfigured by Kanban.
- The runtime provider-model contract carries no context capacity. src/core/api-contract.ts defines runtimeClineProviderModelSchema with id, name, supportsVision, supportsAttachments, and supportsReasoningEffort only. There is no contextWindow field anywhere in the runtime contract, so no served context limit currently reaches Kanban through provider metadata. A web UI test fixture already supplies contextWindow: null on a model object, which the schema would strip.
- src/config/runtime-config.ts defines a model-driven commit prompt. It asks for staging, committing, finding the base checkout, possibly stashing, cherry-picking, and resolving conflicts.
- That default commit prompt does not explicitly require a full pre-commit code review. The user's observed revalidation may result from agent behavior, project rules, or customized prompts. Capture the effective prompt before assigning the cause.
- web-ui/src/hooks/use-review-auto-actions.ts arms auto-completion after requesting a Git action, then treats zero changed files as evidence for moving the task to Done. A clean worktree does not prove destination integration or push success.
- src/commands/task.ts couples trash/Done handling to worktree deletion and starting linked tasks. Existing dependency and cleanup mechanisms must be audited across CLI and UI paths.
- Done and Trash are the same column. src/state/workspace-state.ts declares exactly four board columns: backlog, in_progress, review, and { id: "trash", title: "Done" }. Marking a task complete and discarding it are one board transition, which is why completion currently implies worktree deletion. Separating them is a persisted board-schema and UI change, not only a predicate change.
- trashTaskById in src/commands/task.ts performs its side effects in this order: mutate board state, stop the task session, start every ready dependent, then delete the task workspace. Dependents are therefore dispatched with no delivery evidence of any kind, and a throw from any startTask call aborts the loop before deleteTaskWorkspace runs, leaving the card in Done, the worktree present, dependents partially started, and nothing recorded.
- retryAfterContextOverflow restarts the session with the original prompt plus compacted history. The prompt itself is never reduced, and no attempt counter bounds the path, so an oversized prompt cannot be recovered by removing history.
- isContextOverflowError returns false unless the value is an instanceof Error, so structured or nested provider error objects are not classified at all. Its pattern list is also broad enough that any message merely containing the words "context window" or "context length" matches.
- The MacBook checkout has origin pointing to the fork and upstream pointing to Cline. The user reported a successful build and clean checkout. The Linux fork baseline has now been deployed and partly validated; see Verified progress below for passed checks and the failed restart test.

### Not yet proven

- The exact provider error shape, assembled request size, and effective context limit at a failing commit.
- Whether the SDK's own default compaction (running unconfigured, as confirmed above) triggers at all on the failing request path, and whether configuring CoreCompactionConfig is by itself sufficient.
- Whether all reported cleanup incidents share the same cause.
- Whether the SDK already solves some proposed changes when configured correctly.
- Whether upstream will accept the proposed review stage or deterministic-delivery mode as bug fixes or require feature discussion.
- Whether existing sessions use custom Git prompts with behavior different from defaults.

B-1 must resolve enough of these uncertainties to select the smallest repair. Never implement a second compactor simply because an existing compactor appears absent in the UI.

## Architecture and invariants

### Target execution flow

~~~text
eligible task + verified prerequisite revision
    -> fresh implementation session
    -> durable implementation handoff
    -> fresh review/fix session
    -> stop agent writes
    -> deterministic verification of candidate tree
    -> create task commit
    -> integrate into selected destination branch
    -> verify integrated result if its tree changed
    -> push
    -> verify remote contains delivered commit
    -> record completion
    -> unlock dependents with a new session
    -> cleanup only when preservation conditions pass
~~~

Review and model activity may run out of context. Git delivery must not require a functioning model. Failed verification returns bounded diagnostic context to repair; it does not silently waive checks.

### Proposed module boundaries

Names below are proposals, not claims about existing files.

- Context policy adapter under src/cline-sdk/: resolve settings, use SDK interfaces, normalize overflow diagnostics, and preserve valid message structure.
- Completion coordinator, preferably under a focused src/task-completion/ directory: durable phase transitions, attempts, recovery, cancellation, and deduplication.
- Review service: fresh-session creation, task-scoped evidence, structured review outcomes, repair limits.
- Verification service: configured commands, bounded output, exit status, timeouts, artifact references, and tested-tree identity.
- Git delivery service under the existing workspace layer: task commits, destination integration, push verification, and recovery refs. src/workspace/git-sync.ts already runs fetch/pull/push through runGit with argument arrays and a dirty-tree guard, and is the closest existing component to reuse. Note that its push action is a bare ["push"] with no explicit refspec, which is exactly the ambiguity B-8.6 must remove.
- Scheduler service: dependency readiness, worker capacity, restart reconciliation, and exclusive task ownership.
- UI/CLI adapters: invoke the same backend services and render their state. Browser hooks must not be the authoritative scheduler.

Reuse existing schemas, persistence locks, Git environment helpers, SDK types, and API patterns. Extract domain behavior rather than introducing pass-through wrappers. No application module may contain host-specific usernames, network addresses, or model IDs.

### Mandatory invariants

- A model's statement that work is complete is only a request to verify it.
- Zero changed files is not a delivery receipt.
- Every attempt records repository identity, starting commit, workspace location, target branch, policy, and session IDs.
- Every completed task has a durable receipt appropriate to its configured completion mode.
- Agent and external edits after review/verification invalidate the corresponding evidence.
- Mutation phases have one owner per task; destination integration has one owner per repository and target ref.
- A timeout after a side effect is ambiguous until reconciliation establishes the actual Git/remote state.
- No force-push, destructive reset, automatic user stash manipulation, or guessed stale-lock deletion is part of ordinary completion.
- Context compaction never edits repository files.
- Rules, permissions, model/provider settings, and cancellation behavior survive session restart and phase changes.
- Uncommitted/untracked data and committed-but-unintegrated work remain protected independently.
- The board remains usable with its browser closed; restarting the service cannot duplicate execution.
- Repeated failures terminate at a configured limit with recoverable state.

## Verified progress — 2026-09-16

B-0 is **partially complete**. The unchanged fork baseline at commit
5deb96185bc1be97db2fa3d7fa690ad52f62c487 was built and deployed on Linux. No reliability
fixes in B-1 through B-12 are claimed as implemented.

| B-0 item | Status | Evidence / remaining work |
| --- | --- | --- |
| B-0.1 | Partial | Fork/remotes and clean checkout confirmed; Node 22.22.1, npm 9.2.0, source SHA and lockfile hashes recorded. Deployed SDK inventory still needs explicit capture. |
| B-0.2 | Complete | Locked backend/frontend dependency installation and production build passed; operator reported 59 test files / 581 tests passing. |
| B-0.3 | Complete | Separate root-owned revision release; Linux dependencies; stable systemd override selects executable; working directory and provider configuration preserved. |
| B-0.4 | Partial | Manual build/cutover/health/rollback procedure exercised. Reusable exact-commit deployment command and Actions automation remain unimplemented. |
| B-0.5 | Partial | Service account, effective unit, override, ingress and runtime verified; tasks drained before cutover. Complete configuration inventory and agent-rule enforcement checks remain. |
| B-0.6 | Partial; restart defect | HTTPS, local inference, editing, tests, commit/integration and local-origin push passed. Transcript survived restart, but session continuation failed. |
| B-0.7 | Partial | Executable rollback to npm and restoration to fork passed. Private homelab documentation correction PR opened; merge is not asserted. |
| B-0.8 | Planned | Add the manual Actions deployment described below; no runner or workflow changes have been applied. |

The disposable task created two small JavaScript files and passed three node:test tests.
The destination checkout was independently inspected and retested after the Commit action.
It was one commit ahead of origin: Commit integrated the work but did not push it.
A separate agent request pushed to a local bare origin and reported identical full hashes.
This does not validate GitHub authentication, automatic task chaining, deterministic delivery,
or any B-8 implementation. Private machine paths, network details and operational manifests
remain in the private homelab runbook.

**Restart defect:** after a service restart, the original messages remained visible, but a
follow-up failed with "No previous Cline session config is available for task ...".
The deployed restart path reads lastStartRequestByTaskId and fails when the configuration is
missing. Capture a regression under B-1 and reconstruct restart configuration under B-4.
Do not treat this as context-window exhaustion or suppress it by deleting the task.

B-1 may begin reproducing this known failure on the available deployed baseline while B-0
remains open. This diagnostic work does not waive B-0's restart acceptance criterion.

## Milestone index and dependencies

B-0 is partially deployed and validated; all later implementation milestones remain planned. See Verified progress for evidence and unresolved acceptance criteria.

| Version | Deliverable | Prerequisites | Upstream approach |
| --- | --- | --- | --- |
| B-0 | Reproducible fork development and deployment baseline | None | Keep host operations separate |
| B-1 | Failure evidence, diagnostics, regression harness | B-0 | Issue and focused tests |
| B-2 | Effective context budget and proactive compaction | B-1 | SDK/configuration fix where appropriate |
| B-3 | Safe bounded overflow recovery | B-1, B-2 | Recovery bug fix |
| B-4 | Durable completion state and backend ownership | B-1 | Reliability foundation |
| B-5 | Preservation and cleanup safety | B-4 | Focused data-preservation fix |
| B-6 | Separate review and bounded repair | B-3, B-4, B-5 | Feature discussion if required |
| B-7 | Deterministic verification and evidence binding | B-4, B-6 | Shared verification service |
| B-8 | Deterministic commit, integration, push, receipt | B-5, B-7 | Discuss replacement/opt-in behavior |
| B-9 | Sequential task handoff with fresh context | B-3, B-8 | Dependency correctness |
| B-10 | Operational controls and diagnostics | B-2 through B-9 | Thin UI/CLI integration |
| B-11 | Optional parallel scheduling and integration | B-9, B-10 | Preserve existing compatibility |
| B-12 | End-to-end release qualification and documentation | B-0 through B-10; B-11 for parallel claims | Release evidence |

B-10's listed prerequisites describe when B-10 is *complete*, not when it may start. Each of B-4 through B-9 must ship the minimal phase visibility for its own behavior as part of that milestone; B-10 then consolidates those surfaces into one coherent interface. Recommended execution is B-0 through B-10, then the sequential portion of B-12. B-11 may follow when hardware is available; B-12 must remain explicit about whether parallel operation is qualified. B-4 and B-5 can be developed independently of context fixes after B-1, but the initial local-model task queue should still run one task at a time.

## B-0 — Reproducible development and server deployment

### Outcome

Develop on the MacBook, accept cloud-agent changes through fork PRs, and deploy an exact reviewed fork revision on the server under its existing agent account. Preserve easy updates and rollback.

### Implementation tasks

- [ ] B-0.1 Record fork/default branch, upstream commit, Node/npm versions, lockfile hashes, and installed SDK versions. Confirm local clean state and remote mappings. Keep fork main aligned with upstream; use separate repair branches and an explicitly named integration/deployment branch only when needed.
- [x] B-0.2 Verify installation with locked dependencies for backend and web UI. Run upstream build and checks. Record pre-existing failures rather than fixing unrelated code opportunistically.
- [x] B-0.3 Define the Linux deployment layout: source checkout owned by the agent account, versioned build/release directories, and a stable active-release path. Build native dependencies on Linux; do not transfer Mac node_modules. Retain the existing working directory and model configuration unless deliberately migrated.
- [ ] B-0.4 Prepare a repeatable deployment procedure taking an explicit commit, checking checkout cleanliness, fetching it from the fork, building before cutover, recording a manifest, and switching the service only after readiness checks.
- [ ] B-0.5 Verify the live system service, effective user, proxy route, configuration location, runtime state, and permissions. Drain active work before switching. Preserve provider configuration and credentials; permission to discard old board tasks is not permission to delete source worktrees indiscriminately.
- [ ] B-0.6 Deploy the unchanged baseline first. Smoke-test browser access, a disposable task, local inference, persistence across restart, and branch write capability in a disposable repository.
- [ ] B-0.7 Test rollback to the previous release. Keep backups outside the public repository. Update the private homelab documentation with verified paths, commands, revisions, and rollback steps.
- [ ] B-0.8 Implement and verify a manual GitHub Actions exact-commit deployment with health checks, host locking, bounded privileges, and rollback. See the deployment design below.

### Acceptance and tests

A deployment manifest identifies source SHA and dependency versions. The new service runs the intended build, existing ingress works, a local-model task succeeds, and rollback is demonstrated. Do not infer deployment from a successful Mac build.

### Settings and deployment

No new application environment variables are required by the plan. Record any actual build or service requirements discovered during implementation. Preserve the installed authentication boundary. The current environment blocks automated SSH; server commands must be run by the operator unless an authorized supported execution route becomes available.

### Handoff

Record build/test evidence, baseline SHA, Linux release identifier, and documentation PR. Keep operational host details in the private documentation repository, not the public fork.

### B-0.8 — Manual GitHub Actions deployment (planned)

Goal: select an approved exact source commit from GitHub's Actions UI, build a Linux release,
switch only the Kanban executable, verify health, and restore the previous release automatically
on failure. This is a proposal, not an installed workflow.

- Register a separate repository-scoped runner service for this fork on the existing Linux host,
  with its own installation/work directory and a unique Kanban deployment label. Keep the
  existing application runner registration unchanged. A repository-scoped runner cannot accept
  another repository's jobs merely because it has the same label.
- Alternatively, organization-scoped runners can serve selected repositories within an
  organization. Another option is a deployment-broker workflow in the already registered
  repository which explicitly checks out this fork. Neither migration nor cross-repository
  dispatch is part of the initial recommendation.
- Use workflow_dispatch initially, with a full commit-SHA input and explicit confirmation that
  task execution has been drained. Resolve/validate the commit against an approved branch or
  release policy. Do not evaluate workflow inputs as shell code.
- Keep the deployment workflow on a trusted branch. Run ordinary PR validation on GitHub-hosted
  runners; do not run pull_request or pull_request_target jobs on the production runner.
  Manual dispatch alone does not make arbitrary selected code trustworthy.
- Use a dedicated deployment environment where available, minimal contents:read permission,
  checkout without persisted credentials, and an explicit workflow timeout. Verify environment
  protection availability for the repository's plan before making approvals a dependency.
- Use a deployment concurrency group with cancel-in-progress:false. GitHub concurrency groups
  are repository-scoped: if different repos must serialize host operations, use a host lock in
  addition to workflow concurrency.
- Build/check before downtime using locked dependencies and the supported Node version.
  Record source SHA, dependency versions and checksums. Build under an unprivileged account;
  never run npm scripts as root.
- Install a revision release through a narrowly scoped, root-owned deployment helper. Confirm
  the runner account and grant only the necessary helper/service operations; do not grant
  blanket passwordless sudo or let arbitrary runner input select a service/path to overwrite.
  Account/privilege setup requires a one-time host operation and private runbook update.
- Refuse cutover while tasks are active. Until reliable backend drain detection exists, require
  an operator idle confirmation and prevent new starts during the maintenance window; document
  that this is not an atomic drain guarantee.
- Persist previous and candidate revisions before switching. Preserve account, working
  directory, provider settings and service hardening. Check listener/proxy health with bounded
  retries, then publish a run summary with deployed SHA, checks, and rollback result.
- Restore the prior executable on failed readiness. Handle interrupted runs through persisted
  deployment state/host reconciliation; a workflow failure handler cannot handle every runner
  crash. Keep task data and worktrees intact.
- Provide an explicit rollback dispatch for previously installed releases; validate state-schema
  compatibility. Do not reset repositories or delete retained releases in the deployment path.
- Initial settings to finalize: runner label, deployment environment, allowed source refs,
  full source SHA, target service, release root, health endpoint, and timeout. Private host
  values belong in host configuration or repository/environment settings, not hardcoded in
  this public plan. No new token is expected for reading this public fork; registration and
  actual permission requirements must still be verified.
- Acceptance: successful deployment from Actions, failed-build leaves live service unchanged,
  failed-health restores the previous release, duplicate runs serialize, active work blocks
  cutover, and explicit rollback succeeds. Update the private homelab documentation last.

References: [runner scope](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners)
and [adding a runner](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners).

## B-1 — Reproduce and classify failures

### Outcome

Produce a specific failing test and evidence for each proposed repair, including failures around commit and cleanup.

### Implementation tasks

- [ ] B-1.1 Trace implementation, review entry, manual Commit, auto-commit, session restart, and Done/cleanup through CLI, backend, and UI. Document where provider calls actually occur.
- [ ] B-1.2 Capture a sanitized reproduction: effective provider/model metadata, configured/served context capacity, reported input/output usage, requested output allowance, phase, request identifier, SDK version, and exception code/shape. Do not record full prompts or secrets by default.
- [ ] B-1.3 Inspect effective Git prompts and project rules. Distinguish a full review from conflict resolution or repeated file reads. Record whether the failure happens before the helper/tool is called.
- [ ] B-1.4 Build a fake OpenAI-compatible provider with a configurable small context ceiling and fixture error responses matching observed failures. Use it for fast automated tests without loading the real local model.
- [ ] B-1.5 Add disposable Git fixtures with a main checkout, detached task worktree, and local bare origin. Reproduce manual commit during auto-completion, push failure, service interruption, and clean-but-unintegrated work.
- [ ] B-1.6 Read existing upstream issues and all their comments before drafting related issues. Separate confirmed bugs from feature proposals, and route the latter to the upstream Feature Request discussion category rather than a PR, since upstream is not accepting feature PRs and may close PRs that have no corresponding issue. Do not submit public logs containing private work.
- [ ] B-1.7 Turn the September 16 restart failure into a deterministic regression: preserve transcript, recreate the backend process, send a follow-up to an existing task, and assert configuration reconstruction without replaying previous tool calls. Separate runtime configuration restoration from message persistence.

### Acceptance and tests

At least one context failure and one incorrect-completion/cleanup scenario are reproducible deterministically. Tests identify the failing boundary rather than depending on real SDK subprocess startup in unit suites.

### Settings and deployment

Diagnostics are off or minimal by default, opt-in for detailed metadata, and bounded in size. No production behavior changes in this milestone.

### Handoff

A short evidence report lists observed facts, hypotheses, exact fixtures, failing assertions, and recommended ownership: Kanban, SDK, provider configuration, or model server.

## B-2 — Correct context budgeting and proactive compaction

### Outcome

Requests fit the actual served model capacity, including implementation and review sessions, without relying on a larger model window.

### Implementation tasks

- [ ] B-2.1 Trace model metadata from settings through src/cline-sdk/cline-provider-service.ts, SDK boundaries, and the request pipeline. Verify the LiteLLM-compatible and custom OpenAI-compatible routes used by local inference.
- [ ] B-2.2 Define context-limit precedence: explicit validated deployment/model override, then reliable provider metadata, then a documented conservative fallback. Use the most restrictive known served limit. Display the source of the selected limit. The middle tier does not exist yet and depends on B-2.8; until it does, precedence collapses to override then fallback.
- [ ] B-2.3 Reuse SDK compaction configuration. Budget system text, tool schemas, current messages, incoming file/tool content, expected output, and a safety margin. Do not count the same reserve twice if the SDK already subtracts it.
- [ ] B-2.4 Trigger before the assembled request would exceed its input budget. Start evaluation around 80% utilization as a proposed tuning value, not a hardcoded universal answer; use measured behavior to choose defaults.
- [ ] B-2.5 Bound large file reads, command output, and diff results using pagination or excerpts with local artifact references. A single large result must not bypass the budget merely because previous usage was low.
- [ ] B-2.6 Apply the same policy to implementation, review, repair, and any optional summarization calls. Serialize local-model usage under the worker limit.
- [ ] B-2.7 Expose additive configuration through existing settings/schema paths. If the defect is in SDK estimation or provider request assembly, fix it there and consume a released/pinned dependency rather than patching node_modules.
- [ ] B-2.8 Carry context capacity through the runtime contract. runtimeClineProviderModelSchema in src/core/api-contract.ts has no context-window field, so provider metadata cannot currently inform any budget. Add an optional capacity field, populate it from the SDK model list and the LiteLLM /model/info route where each supplies one, and treat absence as unknown rather than unlimited. Reconcile the existing web UI test fixture that already passes contextWindow: null.

### Acceptance and tests

Test missing/mistaken provider metadata, an explicit smaller server limit, output reservations, tool-schema overhead, a large next tool result, and near-limit history. Verify requests against a fake provider with its own tokenizer/limit accounting where practical. Label approximate estimates as estimates.

### Settings and deployment

Proposed settings: effective context override, compaction strategy, trigger threshold, output reserve, and safety margin. Final names follow the SDK/schema. Reject invalid values. No new cloud credentials or automatic provider fallback.

### Handoff

Record the tested effective budget, before/after request sizes, SDK responsibility, and any dependency release needed for deployment.

## B-3 — Safe bounded overflow recovery

### Outcome

Unexpected overflows recover without losing critical task instructions, invalidating tool-message structure, or replaying side effects.

### Implementation tasks

- [ ] B-3.1 Normalize actual provider error objects, nested causes, codes, and message strings through existing SDK utilities. Two defects are already known and must both be fixed: the instanceof Error guard drops structured and nested provider errors before any pattern runs, and the pattern list matches any message merely mentioning a context window or context length. Classify on provider error code and shape first, and treat message matching as a last resort.
- [ ] B-3.2 Prefer the SDK's supported compaction policy. Preserve task requirements, rules, relevant decisions, phase, outstanding findings, file references, and tool call/result pairing. Retain the original transcript separately for inspection.
- [ ] B-3.3 Replace or retire the message-count-halving fallback only after proving the SDK path covers its cases. If a fallback remains, make it token-budget-aware and explicit about omitted history.
- [ ] B-3.4 Bound the summarizer request itself. Use persisted handoff/checkpoint data and bounded chunks if the history already exceeds capacity. If essential pinned material cannot fit, pause with an actionable reason rather than silently discarding it.
- [ ] B-3.5 Retry only the failed inference request with a smaller valid context and a fixed recovery limit. Do not repeat completed tools, edits, commits, or pushes. If a tool's completion is uncertain, reconcile or pause before retry.
- [ ] B-3.6 Preserve provider selection, model, tool policies, rules, cancellation, and task/attempt mapping when restarting. A canceled task must not be revived by recovery.
- [ ] B-3.7 Include the restart prompt in the recovery budget. The current path re-sends the original prompt unchanged alongside compacted history, so a prompt that does not fit by itself can never be recovered by removing history. Measure the prompt against the effective budget from B-2, and when it alone exceeds capacity, pause with that specific reason instead of restarting.

### Acceptance and tests

Cover tiny message counts with huge content; paired tool messages; first-task requirements beyond 300 characters; repeated overflow; summarizer failure; nested provider errors; cancellation; and preservation of filesystem state. Assert that actual request size decreases and completed tools execute at most once.

### Settings and deployment

Proposed bounded context-recovery attempt count, with an explicit recoverable-error state after exhaustion. Existing transcripts remain available; do not overwrite them irreversibly during compaction.

### Handoff

Document the chosen strategy and what information it intentionally omits. Report preserved invariants and the next action for irreducibly oversized tasks.

## B-4 — Durable completion lifecycle

### Outcome

The backend knows which completion phase has actually succeeded and can resume safely after interruption.

### Implementation tasks

- [ ] B-4.1 Define typed completion phases: implementation, review, verification, committing, integrating, integrated verification when needed, pushing, remote verification, complete. Represent blocked/failed/canceled status separately with a resumable phase.
- [ ] B-4.2 Persist attempt ID, task ID, repo identity, starting SHA, candidate tree, target ref, session IDs, policy version, review/check evidence, task commit, integrated commit, remote receipt, timestamps, and failure reason. Store logs by reference.
- [ ] B-4.3 Use existing durable state conventions and locks. Add schema versioning and migration; old Done cards without receipts must not automatically unlock new reliable-mode tasks.
- [ ] B-4.4 Introduce idempotent backend phase commands shared by UI and CLI. Double-clicks, duplicate browser tabs, hooks, and restart events must resolve to one attempt owner.
- [ ] B-4.5 Persist intent before Git side effects and reconcile actual state after restart. Handle the crash between a successful operation and its completion record.
- [ ] B-4.6 Define cancellation per phase. Do not leave locks permanent; do not assume killing a Git process undoes a ref update.
- [ ] B-4.7 Define what happens to an in-flight attempt when reliable mode is disabled or the code is rolled back mid-attempt. An attempt parked at committing, integrating, or pushing must either finish under the mode it started in or stop at a phase an operator can resume by hand; it must never silently fall back to the legacy prompt path partway through. Record the mode and policy version on the attempt so this is decidable after restart.
- [ ] B-4.8 Reconstruct existing task launch configuration after process restart instead of relying solely on lastStartRequestByTaskId. Restore model/provider, workspace, rules, tools and approval behavior from supported durable metadata; resolve credentials through existing configuration without copying secrets into task records. Bind the persisted transcript, avoid duplicate sessions/tools, and pass B-1.7 before declaring restart recovery complete.

### Acceptance and tests

Crash/restart after every transition, including after side effect but before receipt persistence. Duplicate completion commands cannot create duplicate commits, pushes, or successor sessions. Unknown evidence pauses instead of guessing success.

### Settings and deployment

Introduce a versioned, opt-in reliable-completion mode during rollout. Preserve legacy/custom-prompt mode explicitly until migration is decided. Back up state before schema changes; code rollback must account for schema compatibility.

### Handoff

Publish the state-transition contract, migration behavior, reconciliation table, and which component owns every side effect.

## B-5 — Preserve work and make cleanup conditional

### Outcome

Manual commits, session errors, and card moves cannot make unfinished work disappear.

### Implementation tasks

- [ ] B-5.1 Replace clean-worktree success inference with completion evidence in reliable mode. Audit use-review-auto-actions.ts and every CLI/API Done/delete path, not only the visible button. Note that the hook's terminal action is requestMoveTaskToTrash, so the UI path and the delete path are literally the same call.
- [ ] B-5.2 Establish a durable task branch or namespaced recovery ref before relying on ephemeral detached HEAD state. Retain task ID, workspace path, starting SHA, latest known commit, and preservation status.
- [ ] B-5.3 Preserve uncommitted tracked changes, untracked files, and relevant binary content separately from Git refs. A patch alone may be insufficient. Automatic preservation failure must stop cleanup.
- [ ] B-5.4 Reconcile unexpected external commits or branch changes. A clean workspace containing an unintegrated manual commit is recoverable work, not evidence to delete it.
- [ ] B-5.5 Separate task completion from workspace garbage collection. Default failed/blocked workspaces to retained. Cleanup requires durable recovery, no active writer, and delivery evidence appropriate to the mode.
- [ ] B-5.6 Make restore use the preserved task revision rather than recreating a worktree from an older base. Expose a supported locate/recover action.
- [ ] B-5.7 Define explicit disposal behavior and retention limits. Retention expiry must not silently discard unpreserved work; provide a visible blocked-cleanup reason.
- [ ] B-5.8 Separate completion from disposal on the board itself. Today src/state/workspace-state.ts maps one column, id "trash" titled "Done", to both meanings, so a completed task and a discarded task are indistinguishable in persisted state. Introduce a distinct completed state with its own persisted representation, migrate existing trash-column cards, and keep both the CLI column vocabulary and the web UI consistent with the result. This is a prerequisite for B-5.5, which cannot separate completion from garbage collection while both share one column.
- [ ] B-5.9 Make the trash/Done transition atomic and correctly ordered. trashTaskById currently mutates board state, stops the session, starts every ready dependent, and only then deletes the workspace, so a failure while starting a dependent leaves the card completed, the worktree alive, and dependents half-started with nothing recorded. Persist the intended transition first, dispatch dependents only after delivery evidence exists per B-9, and make workspace deletion a separate reconcilable step whose failure is visible.

### Acceptance and tests

Reproduce manual commit while auto-completion is armed, hidden/untracked and binary files, failed preservation writes, stale metadata, and service restart during cleanup. Restore yields the expected task content. No failed task automatically starts dependents.

### Settings and deployment

Document workspace retention and recovery storage. Default to retaining failed attempts. Validate disk-full behavior. This milestone can ship independently as a preservation bug fix.

### Handoff

Include a tested recovery recipe and evidence that cleanup predicates hold across UI, CLI, bulk cleanup, and shutdown.

## B-6 — Separate review and bounded repair

### Outcome

Review runs in a fresh context focused on this task's changes, before any deterministic Git completion.

### Implementation tasks

- [ ] B-6.1 Persist an implementation handoff with task ID, authoritative Markdown paths and revisions/hashes, acceptance criteria, changed paths, design decisions, tests attempted, known limitations, and unresolved questions.
- [ ] B-6.2 Start a new review session in the same preserved workspace after the implementation writer has stopped. Carry rules and permissions forward; do not append the entire implementation transcript.
- [ ] B-6.3 Review against the task's recorded starting revision, including uncommitted and untracked content. Inspect relevant cross-file context on demand; paginate large diffs and retain a coverage checklist.
- [ ] B-6.4 Require a structured result: findings with file/line evidence, blocking status, fixes applied, requirements covered, and unresolved items. A parsing failure is not a pass.
- [ ] B-6.5 Permit scoped fixes only. Default maximum repair rounds should be finite, initially two for evaluation. Avoid broad refactors, new requirements, dependency upgrades, and unrelated formatting unless the task requires them.
- [ ] B-6.6 Deny Git publication and worktree cleanup through review-phase tool policy. Keep existing project rules and tool approvals effective. Command filtering is not a complete security sandbox; preserve existing OS isolation too.
- [ ] B-6.7 Bind the review result to the candidate content/tree. Any subsequent edit invalidates the result or requires explicit scoped re-review. At limit exhaustion, retain the workspace and findings.

### Acceptance and tests

Review finds an intentionally seeded bug, repairs it, and hands off to verification without invoking Git delivery. Test new-context identity, large multi-file diffs, missing requirements, malformed review output, policy violations, and repeated repair failure.

### Settings and deployment

Proposed review policy: required/off, review instructions, model override only when explicitly configured, and maximum repair rounds. Target workflow uses required review and the existing local model. Never silently switch to a cloud model.

### Handoff

Produce a small review artifact referencing the authoritative plan, exact candidate tree, findings, fixes, and readiness for deterministic checks.

## B-7 — Deterministic verification gate

### Outcome

Configured checks, not the agent's narrative, determine whether the reviewed content is eligible for delivery.

### Implementation tasks

- [ ] B-7.1 Define trusted project verification configuration: command/argv, working directory, timeout, environment allowlist, expected exit behavior, and required/optional status. Prefer direct executable invocation; explicit shell commands require the existing policy boundary.
- [ ] B-7.2 Freeze agent writes during verification. Record candidate tree identity before and after checks; preserve full logs locally with bounded model/UI excerpts.
- [ ] B-7.3 Capture exit status, timeout/cancellation, start/end times, tested revision/tree, and artifact paths. An absent required check, interrupted test, or empty output cannot be treated as success without its configured exit semantics.
- [ ] B-7.4 If a check changes source content, invalidate prior review/verification as appropriate. Do not commit unreviewed formatter changes or test-generated source accidentally.
- [ ] B-7.5 Feed failed-check evidence into a fresh bounded repair session with existing rules, then rerun required checks. Share one explicit attempt budget so review/verification cannot bounce forever.
- [ ] B-7.6 Bind accepted evidence to the candidate that will be committed. Re-run checks after integration whenever the resulting tree differs from the verified tree.
- [ ] B-7.7 Decide and document where verification configuration is stored before implementing it: global runtime configuration alongside the existing prompt templates, per-workspace state, or both with a defined precedence. Because B-7.1 treats this as trusted executable configuration, the storage location is the security boundary; a location writable by task content or by an agent during a task is not acceptable. Record the chosen path, who may write it, and how the application validates it on load.

### Acceptance and tests

Cover successful checks, test failure, timeout, nonzero exit with plausible success text, huge output, missing executable, post-test edit, generated files, and repair exhaustion. No Git publication occurs on failure.

### Settings and deployment

Project check configuration is trusted executable configuration, not something an untrusted task document can rewrite to waive verification. Projects without required checks need an explicit policy decision; the target workflow must not silently skip them.

### Handoff

A verification receipt contains exact tree identity, checks and results, artifact references, and validity status.

## B-8 — Deterministic Git delivery

### Outcome

Application code commits the verified task, integrates it, pushes it, and verifies delivery even when the model is unavailable.

### Implementation tasks

- [ ] B-8.1 Implement a Git service using existing subprocess/environment conventions and argument arrays. Validate repository/worktree identity, target ref, remote, permissions, and operation state. Do not interpolate task text into a shell.
- [ ] B-8.2 Stage only intended task changes according to a recorded change manifest, including reviewed new files. Exclude secrets, generated logs, and unrelated user changes. Use a deterministic task-title message fallback; model-generated messages are optional.
- [ ] B-8.3 Create a commit anchored by a durable ref. Respect Git hooks and signing settings; failures remain actionable rather than bypassing policy.
- [ ] B-8.4 For the initial sequential policy, require the destination to match the recorded base and fast-forward to the task commit. If destination is checked out, refuse dirty state and use the appropriate worktree-aware operation. If not checked out, use an expected-old-SHA ref update.
- [ ] B-8.5 If the destination advanced or diverged, pause with clear evidence. Do not silently stash user changes, cherry-pick, resolve conflicts, delete lock files, or force-push. Later parallel integration belongs to B-11.
- [ ] B-8.6 Push an explicit refspec using existing credentials, reusing the Git invocation conventions in src/workspace/git-sync.ts rather than its bare ["push"] argument list, which relies on ambient push configuration and cannot state what was delivered. Honor protected-branch settings; the target deployment uses a feature branch. Serialize integration/publication for the destination.
- [ ] B-8.7 Verify the remote equals or contains the delivered commit. Fetch the relevant ref for ancestry validation when it advanced. Remote movement that excludes the candidate blocks completion.
- [ ] B-8.8 Persist the delivery receipt before unlocking dependents. If push times out after server acceptance, reconcile before retry. Reuse existing commits; do not create a new commit merely because the client lost its response.
- [ ] B-8.9 Keep optional PR creation separate from commit/push. If supported here, use API/CLI with structured metadata, deduplicate by head/base, and preserve the pushed commit on PR creation failure. The primary workflow is many task commits on one feature branch, followed by a later overall PR.

### Acceptance and tests

Run with a model stub that refuses all requests during delivery. Test detached worktrees, checked-out targets, no-op tasks with explicit evidence, user-created commits, dirty destinations, signing/hook failures, push rejection, ambiguous push timeout, remote advancement, process crash, and retry deduplication.

### Settings and deployment

Proposed policy fields: destination branch, remote, push required, protected targets, integration strategy, and optional PR requirement. Require push for the target sequential workflow. Preserve legacy custom Git prompt mode as an explicit alternative during migration; never execute both paths for one attempt.

### Handoff

Receipt records task commit, integrated commit, destination ref, tested tree, remote observation, operation ID, and completion timestamp.

## B-9 — Sequential handoff with fresh context

### Outcome

An unattended chain reliably builds upon previous verified commits while using a new context window for each task.

### Implementation tasks

- [ ] B-9.1 Move reliable-mode readiness decisions into the backend. Consume completion receipts, not card deletion or browser-only timers.
- [ ] B-9.2 Validate dependency direction, missing tasks, cycles, failed prerequisites, and cancellation. A manually moved Done card does not substitute for required delivery evidence.
- [ ] B-9.3 Reserve one worker by default across implementation, review, repair, and model-based compaction. Git-only phases do not need a model slot but must respect repository locks.
- [ ] B-9.4 Resolve the next task's base only when its prerequisites are satisfied. Verify the selected revision contains their delivered results; do not reuse a stale pre-created worktree.
- [ ] B-9.5 Create a new session with the current task document, selected global requirements, rules, concise prerequisite handoffs, and exact base SHA. Do not preload the whole feature plan or previous transcripts indiscriminately.
- [ ] B-9.6 Persist readiness and ownership before launch. On restart, reconcile live sessions and receipts before dispatch. Bound retries and expose blocked prerequisites.
- [ ] B-9.7 Ensure failed push, failed review, or interrupted verification blocks successor execution even if the predecessor workspace is clean.

### Acceptance and tests

A three-task fixture must require task two to use task one's API and task three to extend task two. Each starts from the correct delivered revision with a distinct session. Repeat with browser closed, duplicate clients, service restart, and a push failure in the middle. Maximum model concurrency remains one.

### Settings and deployment

Reliable queue enabled per project; worker limit defaults to one for this workflow. Dependency metadata is durable and independent of visual column placement.

### Handoff

Record the three-task execution trace, base/commit relationships, session IDs, and restart proof.

## B-10 — Controls, status, and usable diagnostics

### Outcome

Users can understand, resume, and recover work without searching hidden directories or reading raw internal logs.

### Implementation tasks

- [ ] B-10.1 Display meaningful phases: Implementing, Reviewing, Checking, Committing, Integrating, Pushing, Verifying remote, Done, and Needs attention. Done here means the completed state introduced in B-5.8 and must remain visually and behaviorally distinct from discarding a task.
- [ ] B-10.2 Show branch, commit, workspace location, last successful phase, blocked reason, and preserved-work status in task details. Offer open/copy actions.
- [ ] B-10.3 Provide backend-backed Retry current phase, Resume repair, Cancel, and Recover workspace actions. Disable invalid transitions and deduplicate requests.
- [ ] B-10.4 Show context usage as measured or estimated, effective capacity, last compaction event, and omitted-history notice. Do not imply a summary is lossless.
- [ ] B-10.5 Add CLI/JSON equivalents for status, receipts, queue control, and recovery. Keep scripting output stable and human errors actionable.
- [ ] B-10.6 Add explicit settings for reliable completion, required review/checks, push requirement, and worker capacity. Document how legacy custom prompts behave.
- [ ] B-10.7 Export redacted diagnostic bundles only through an explicit user action. Exclude API keys, prompts, private code, and raw environment by default.

### Acceptance and tests

UI and CLI show the same durable state after reload/restart. A failed push can be resumed without rerunning implementation. Tests cover duplicate clicks, stale status, inaccessible workspaces, and redaction.

### Settings and deployment

No new authentication boundary. Extend existing API validation and access checks. Minimal phase visibility ships inside each of B-4 through B-9 for the behavior that milestone introduces; B-10 consolidates those surfaces rather than introducing status display for the first time. The prerequisite list for B-10 is therefore a completion constraint, not a start constraint.

### Handoff

Screenshots or UI test evidence, CLI examples, settings migration notes, and troubleshooting guide.

## B-11 — Optional parallel execution

### Outcome

Increase worker capacity for independent tasks without breaking the sequential guarantees or losing work during integration.

### Implementation tasks

- [ ] B-11.1 Reuse dependency readiness from B-9. Run only tasks with satisfied prerequisites, each in an isolated workspace and fresh session.
- [ ] B-11.2 Honor a shared resource budget across all model phases. Retain one-worker defaults; optionally distinguish model-endpoint capacity where actual deployment requires it.
- [ ] B-11.3 Serialize destination integration. Record each task's original base, candidate, and current destination.
- [ ] B-11.4 Integrate concurrent results in a dedicated clean integration workspace with an explicit merge/cherry-pick policy. Never mutate a dirty user's checkout or rewrite a published branch.
- [ ] B-11.5 Review affected interactions and rerun required checks against the combined tree. Conflict resolution becomes a bounded agent task or explicit operator action, not an unbounded Git phase.
- [ ] B-11.6 Release dependent tasks only after every prerequisite is present in the verified integration revision. Preserve both task commits when integration is blocked.

### Acceptance and tests

Two independent branches integrate into one target, then a dependent task sees both results. Test overlapping edits, changed APIs, integration-test failure, restart under contention, and remote advancement. Use fake model workers for CI; real multi-worker local inference is a later hardware qualification.

### Settings and deployment

Worker limit greater than one is opt-in. A serial integration lock remains required even with multiple model workers.

### Handoff

Document verified concurrency limits and distinguish simulated scheduler qualification from real-model performance testing.

## B-12 — Release qualification, rollout, and documentation

### Outcome

Ship a measured, reversible release with evidence that the user's actual workflow works.

### Implementation tasks

- [ ] B-12.1 Run all required upstream checks: npm run check, npm run build, and relevant web UI tests/typecheck. Run Linux Git/process integration tests in addition to Mac development tests. Compare failures against B-0.
- [ ] B-12.2 Execute the three-task sequential chain on the real local-model endpoint. Include review/fix, checks, commit/integration, push, remote verification, and fresh contexts.
- [ ] B-12.3 Force a near-limit context case and verify recovery with the real provider. Reuse deterministic fixtures for extreme limits rather than wasting repeated full-window runs.
- [ ] B-12.4 Inject failures at review, verification, commit, push, remote confirmation, successor dispatch, and cleanup. Restart the service between side effect and receipt where practical.
- [ ] B-12.5 Upgrade from baseline persisted state and exercise rollback. If schemas cannot be downgraded, restore a backed-up state snapshot while retaining newer Git work separately; never pretend code rollback alone restores compatibility.
- [ ] B-12.6 Enable reliable mode first in a disposable repository, then a selected real feature branch. Keep failed work retained. Do not enable parallel mode until B-11 qualification is complete.
- [ ] B-12.7 Prepare focused upstream PRs, each tied to an accepted issue, since upstream may close PRs that have none. Submit only the milestones that are defensible as bug fixes or compatibility work; anything upstream classifies as a feature goes to a Feature Request discussion first and stays fork-only until that discussion concludes. Remove carried patches once equivalent upstream fixes ship; avoid duplicating the upstream SDK.
- [ ] B-12.8 Finish with a private homelab-documentation PR recording every device/service change, deployed SHA, settings, local provider capacity, test results, rollback procedure, and unresolved limitations.

### Release acceptance

All of the following must hold:

- Three sequential tasks build on one another and are verified on the selected origin feature branch.
- Every task uses a fresh implementation context; review uses a separate context.
- Inference overflow cannot prevent deterministic delivery of an already verified candidate.
- Failed checks or push block dependents.
- Browser closure and service restart do not duplicate execution or lose progress.
- Manual commits and untracked work remain recoverable.
- No cleanup occurs solely because a worktree becomes clean.
- Required permissions and rules apply in implementation, review, and repair.
- Rollback has been tested, and deployment/documentation reflect the actual verified state.
- Parallel capability is either qualified under B-11 or explicitly labeled unqualified/disabled.

### Settings and deployment

Reliable mode is enabled per project in the order given by B-12.6, starting disposable and ending on one real feature branch. Parallel mode stays off until B-11 qualifies it. Record the deployed SHA, the effective context limit the server actually served, and every setting changed from default. Back up persisted state before the upgrade; B-12.5 owns the downgrade path when schemas cannot move backward.

### Handoff

A release record containing the qualification results for each acceptance item above, the deployed SHA and manifest, the settings in force, known unqualified capabilities, the rollback procedure as executed rather than as designed, and the patch ledger described under upstream maintenance.

## Task packaging for fresh-context agents

Each B-x.y subtask should become a separate card when it has a distinct implementation and test boundary. Do not place an entire large milestone into one context merely because it shares a version number.

Every implementation card must include:

| Field | Required content |
| --- | --- |
| Identity | B version, subtask ID, short title |
| Starting point | Repository, branch, exact base SHA, prerequisite receipts |
| Objective | One concrete behavior change |
| Context | This plan section and relevant source paths; authoritative requirement references |
| Scope | Allowed areas and explicit non-goals |
| Implementation | Granular steps and decisions already settled |
| Verification | Specific regression case and required commands |
| Acceptance | Observable success and failure behavior |
| Deployment | Settings, migration, dependency and operator requirements, or explicitly none |
| Handoff | Changed files, decisions, checks, candidate/commit, unresolved items |
| Stop conditions | Unexpected scope, blocked prerequisites, failed checks, unknown repository state |

The agent must reread current code before exact edits and note drift from the baseline. A handoff is a navigation aid, not a replacement for source or requirements. Record progress in artifacts, not solely in conversation history.

## Upstream and fork maintenance

- Keep fork main as an upstream mirror. Create one topic branch per focused fix; use a separate integration branch for combined unmerged changes.
- Use GitHub OAuth for cloud-agent edits and PR creation. Do not commit directly to main. Local development follows the user's approved workflow.
- Before a substantial upstream fix, read related issues and all comments, then agree on the issue/approach. Do not automatically post private repro details.
- Upstream CONTRIBUTING.md states plainly that "We are not currently accepting feature PRs" and directs feature ideas to the Feature Request discussion category at https://github.com/cline/kanban/discussions/categories/feature-requests. It also warns that "PRs without a corresponding issue may be closed". Treat both as hard gates: B-6, B-7, B-8, B-9, and B-11 are not submittable as PRs today and need an accepted discussion first, and every upstream PR from any milestone needs a pre-agreed issue. This constrains upstream submission strategy, not the ability to maintain the feature in the fork.
- Put SDK-specific fixes in the SDK when appropriate. Pin a released compatible version with lockfiles; never edit installed packages as the durable solution.
- Keep host-specific service definitions and operational records separate from generic application behavior.
- Every PR description must prominently state environment/settings changes, migrations, deployment actions, rollback, and concise steps to test each changed behavior.
- A B milestone may span several PRs if SDK and Kanban ownership differ. Completion requires all prerequisite pieces, not merely one merged PR.
- Maintain a small patch ledger: B ID, fork PR, upstream issue/PR, dependency revision, deployment SHA, and whether the patch can be retired.
- No code change, deployment, or milestone completion is implied by approval of this planning document.

## Source references

Inspected against the source baseline above:

- [Repository guidance](https://github.com/cline/kanban/blob/abd4912c27ce6b7f18b5a8106c145fd838e90cc4/AGENTS.md)
- [Contribution policy](https://github.com/cline/kanban/blob/abd4912c27ce6b7f18b5a8106c145fd838e90cc4/CONTRIBUTING.md)
- [Build and dependency definitions](https://github.com/cline/kanban/blob/abd4912c27ce6b7f18b5a8106c145fd838e90cc4/package.json)
- [Overflow fallback](https://github.com/cline/kanban/blob/abd4912c27ce6b7f18b5a8106c145fd838e90cc4/src/cline-sdk/cline-context-overflow-compaction.ts)
- [Task-session service](https://github.com/cline/kanban/blob/abd4912c27ce6b7f18b5a8106c145fd838e90cc4/src/cline-sdk/cline-task-session-service.ts)
- [Default Git prompts](https://github.com/cline/kanban/blob/abd4912c27ce6b7f18b5a8106c145fd838e90cc4/src/config/runtime-config.ts)
- [Auto-review and clean-worktree completion](https://github.com/cline/kanban/blob/abd4912c27ce6b7f18b5a8106c145fd838e90cc4/web-ui/src/hooks/use-review-auto-actions.ts)
- [Task commands and lifecycle](https://github.com/cline/kanban/blob/abd4912c27ce6b7f18b5a8106c145fd838e90cc4/src/commands/task.ts)
- [Worktree handling](https://github.com/cline/kanban/blob/abd4912c27ce6b7f18b5a8106c145fd838e90cc4/src/workspace/task-worktree.ts)
- [Existing fetch/pull/push implementation](https://github.com/cline/kanban/blob/abd4912c27ce6b7f18b5a8106c145fd838e90cc4/src/workspace/git-sync.ts)
- [Board column definitions](https://github.com/cline/kanban/blob/abd4912c27ce6b7f18b5a8106c145fd838e90cc4/src/state/workspace-state.ts)
- [Runtime API contract and provider-model schema](https://github.com/cline/kanban/blob/abd4912c27ce6b7f18b5a8106c145fd838e90cc4/src/core/api-contract.ts)

SDK API observations were read from installed @clinebot/core 0.0.38 type declarations, including dist/types/config.d.ts and dist/extensions/context/compaction.d.ts. Confirm actual runtime behavior during B-1; type declarations alone do not prove effective configuration.
