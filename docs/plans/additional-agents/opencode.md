# Add OpenCode to Kanban

Status: planned; documentation only.
Depends on [AA-S1 in shared.md](./shared.md). Inspection baseline:
`e7b2097af06364b01410c6b69d353d52d22a6aa4`, 2026-11-19.
Benchmark context and evaluation protocol are in [shared.md](./shared.md).

## Goal and scope

Enable OpenCode as a supported task agent using the existing terminal UI and worktree
lifecycle. Support an explicitly selected local Qwen provider/model, task prompts,
follow-ups, cancellation, exact-session resume, activity and attention reporting.
Keep existing defaults, native Cline UI, review/verification and publication behavior.

This is a repair and activation of dormant code, not a greenfield adapter.
A structured OpenCode server/chat integration is a possible later project, not a
requirement for initial terminal support. Do not introduce a shared global OpenCode
server as an unexamined shortcut.

## Current implementation and concrete hazards

- `src/core/agent-catalog.ts` already defines opencode, binary opencode and empty
  autonomous arguments; its launch-supported entry is disabled.
- `src/core/api-contract.ts` already accepts opencode. Runtime config normalizes
  unsupported identities back to the default; activation must be coordinated.
- `src/terminal/agent-session-adapters.ts` includes opencodeAdapter,
  buildOpenCodePluginContent and preferred-model inference.
- `src/terminal/opencode-paths.ts` discovers config, auth and saved model paths.
- Existing launch adds `--prompt`, uses `--continue` on trash resume and optionally
  `--agent plan` with an experimental environment flag. These are historical choices,
  not promises that current OpenCode supports identical semantics.
- With hook context, launch writes a hook config containing `plugin: [fileUrl]` and
  points OPENCODE_CONFIG at it. Verify whether and how the selected OpenCode version
  merges the user's provider settings; reading the old config only to infer a model
  does not prove the provider configuration survives.
- Generated plugin code has a process-global installation flag and keeps root-session
  state. Shared OpenCode server processes can therefore change isolation assumptions.
- Current docs use `plugins` with local directory entries; explicit single-file paths
  are skipped. Current CLI docs also describe a shared background service by default.
  These conflict with assumptions in the dormant adapter.
- Settings ordering and adapter tests have explicit agent lists. The launch gate alone
  is not the entire integration.

Read `test/runtime/terminal/agent-session-adapters.test.ts` and
`test/runtime/terminal/agent-registry.test.ts` before changing these paths.
Treat old snapshots under `.plan/docs/CLI References/` as historical.

## Architecture decision

Use a directly launched OpenCode terminal process in the existing PTY manager.
For the selected supported version, choose its documented isolated/standalone mode
so task-specific environment, config and hooks do not leak into another task's server.
If the chosen version cannot guarantee that mode, own a task-specific private server
with explicit lifecycle and bind address; do not activate support until isolation is proven.

Own Kanban integration resources under a workspace/task/attempt directory outside the
tracked worktree. Preserve the user's config and credentials. Add only Kanban-owned
integration settings through a documented overlay/merge mechanism for the pinned version.
Do not rewrite global config or load arbitrary credentials just to guess a default model.

Use OpenCode's documented plugin/event API for semantic lifecycle events. Keep PTY
output for presentation and diagnostic replay. Do not scrape "done" text to determine
successful completion. Prefer installed/public OpenCode types or schemas over handwritten
copies of API definitions; keep version-specific translation in one adapter boundary.

## Implementation slices

### AA-O1a: establish supported version and repair launch

1. Capture `opencode --version` and relevant `--help` output from the pinned release;
   record version, source revision and tested OS matrix in the implementation docs.
   Reconcile the modern config/plugin schema against actual installed types.
2. Repair prompt injection, argument precedence, plan mode, explicit session selection
   and isolated-server selection. Use argument arrays; support spaces, Unicode,
   multiline prompts and literal shell characters. Explicit CLI options beat defaults.
3. Replace global "continue latest" resume with the exact persisted external session.
   If that session is missing, fail with a recovery choice instead of continuing an
   unrelated session. Resume must remain bound to the same task worktree.
4. Preserve JSON/JSONC provider definitions, custom base URL, authentication references,
   model capabilities, existing plugins, instructions and MCP settings when adding
   the hook integration. Avoid a new ad hoc JSONC parser; use maintained or upstream
   config machinery where possible.
5. Require an explicitly resolved provider/model for local-only operation. Validate
   the requested model exists; do not search auth files and silently prefer OpenRouter,
   Anthropic or another hosted provider. Record effective identity in diagnostics.
6. Keep missing/unsupported versions visible with installation/version guidance.
   Do not enable the catalog gate until the lifecycle and configuration tests pass.

Deliverable: focused adapter/config changes plus fixture tests. Keep launch unsupported
until AA-O1b and AA-O1c acceptance is satisfied.

### AA-O1b: task-scoped event bridge and lifecycle

Replace the stale plugin shape with the pinned version's documented shape.
Filter every event by external root-session ID and launch attempt; child sessions
may contribute activity but may not terminate the parent task.

| External observation | Kanban behavior |
| --- | --- |
| Prompt accepted / resumed user turn | Running and current-turn identity updated |
| Tool starts/finishes, assistant progress | Bounded activity metadata |
| Permission request or user question | Attention state, preserving pending interaction |
| Successful root turn reaches final idle state | End-of-turn review candidate through existing hooks/checkpoint path |
| Error, model disconnect, failed startup | Error diagnostics; no success/delivery claim |
| Cancel or process termination | Interrupted/error/exit fact through existing state machine |

An idle event alone can follow errors or blocked interactions; verify preceding turn
outcome before treating it as normal completion. Coalesce noisy activity, deduplicate
events, and retain the final assistant text and observed PR URLs within existing bounds.
Publish PR observations through existing recorders, not a second polling subsystem.

When an approval/question is answered in the terminal, clear attention only on observed
continuation. Clean generated resources on all exit paths. Persist resume metadata and
sanitized diagnostics before teardown. Two tasks must never share a root-session cache
or a hook resource that can be overwritten by the other.

### AA-O1c: settings, task actions and activation

Add OpenCode to the settings order and supported catalog only after launch acceptance.
Show binary/version, agent-native config location, model identity and supported features.
Do not expose Cline-only provider/reasoning controls as OpenCode controls.

Trace task starts, task follow-up actions, image attachments, plan requests, trash
restore, review repair, comment addressing and sequential dispatch. Route supported
actions through existing machinery; capability-gate the rest. Image support depends on
both the CLI and selected model; preserve task attachments or explain unsupported input.

Confirm whether automatic commit/PR prompts can be sent to the live terminal safely
through current APIs. Preserve verification/review gates and PR linking. If automation
requires native Cline interfaces, show its limitation and leave reliable-completion
support disabled for OpenCode until a separate implementation closes the gap.
The reviewer may remain Cline; show its independent configuration.

Autonomous mode must map to the pinned version's actual permission policy. Empty
autonomousArgs is not proof of unattended execution. Never broadly relax global
permissions; scope any task policy and retain an interactive approval route.

## Test matrix and acceptance

Use fixture binaries/events for CI; use the real local endpoint only for manual smoke tests.

| Case | Required result |
| --- | --- |
| User JSONC config plus Kanban overlay | Local provider/auth references, custom plugins and instructions survive |
| Explicit model conflicts with saved history | Explicit model wins, effective local model recorded |
| Missing local model/provider | Useful failure; zero hosted inference requests |
| Two worktrees and root/child sessions | No cross-task activity, completion, config or cancellation |
| Permission/question followed by answer | Attention then continuation; no premature completion |
| Error followed by idle | Error remains distinguishable from successful turn |
| Duplicate/stale completion event | At most one review checkpoint/notification for current turn |
| Stop during model/tool execution | Owned process tree stops; task is interrupted and resumable |
| Restart/trash restore with another session newer | Exact task session resumes or explicitly reports unavailable |
| Missing CLI / incompatible version | No phantom live session; clear remediation |
| Existing agents | Catalog, settings, config and session regressions stay green |

Implementation checks: focused adapter/registry/session/hooks/settings tests, backend and
frontend typechecks, repository CI, and Biome on changed supported files.

Manual smoke: select OpenCode with local Qwen; request a small edit and test; answer a
question; send a follow-up; stop and resume; restart Kanban and resume; run two tasks
concurrently; exercise a failed endpoint. Confirm logs identify the selected local route.
Run publication only in an explicitly designated test repository and through existing gates.

Acceptance: all listed supported operations work; limitations are visible; original
configuration is unchanged; task events and resume are isolated; no accidental cloud
fallback; OpenCode can be disabled without corrupting saved tasks.

## Deployment and rollback

Planning PR: none. Implementation deployment: install the pinned OpenCode CLI on the
Kanban host's PATH; configure its own local provider/base URL/model and credential
reference; deploy Kanban after tests. OPENCODE_CONFIG is an existing version-sensitive
integration setting, not a new globally required environment variable.
Document any new setting names only after implementing them.

No shared model key or global OpenCode permission change is required by this plan.
A separately authorized AI-MONSTER setup change needs a homelab-documentation PR.
Rollback disables new OpenCode launches, stops only Kanban-owned processes, preserves
conversation/configuration history, and leaves other agents available.

## Upstream references

Accessed 2026-11-19. Pin a release and inspect installed definitions before implementing;
these moving documentation URLs are not a compatibility guarantee.

- [CLI, noninteractive execution and service ownership](https://opencode.ai/docs/cli/)
- [Models and local-compatible providers](https://opencode.ai/docs/models/)
- [Provider configuration](https://opencode.ai/docs/providers/)
- [Plugin configuration and discovery](https://opencode.ai/docs/plugins/)
- [Permissions](https://opencode.ai/docs/permissions/)
