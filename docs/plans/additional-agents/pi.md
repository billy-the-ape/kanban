# Add Pi to Kanban

Status: AA-P1 implemented in this repository (terminal launch, exact-session resume,
task-scoped lifecycle extension, capability and configuration contracts, settings and
onboarding surface). Pi's JSON/RPC mode remains deferred; see
“Future RPC integration boundary”.
Depends on [AA-S1 in shared.md](./shared.md). Planning inspection baseline:
`e7b2097af06364b01410c6b69d353d52d22a6aa4`, 2026-11-19.
Benchmark context and evaluation protocol are in [shared.md](./shared.md).

## Goal and integration decision

Add Pi as a selectable coding agent using the same task-worktree and terminal experience
as the existing external agents. Connect to the user's local Qwen endpoint through
Pi's native provider/model configuration. Support prompts, follow-ups, precise resume,
cancellation, activity, attention and trustworthy end-of-turn reporting.

Initial implementation uses Pi's TUI in the existing PTY manager plus a small task-scoped
Pi extension to report semantic events. This fits Kanban's actual architecture and avoids
reimplementing a chat UI just to add a runner. Pi's JSON/RPC mode is valuable for later
structured integration, but cannot be sent through xterm as if it were a TUI.
Do not feed JSON-RPC commands into an interactive terminal session.

A future RPC integration should use the exported typed RpcClient or SDK and a deliberate
generic session presentation contract. It is explicitly deferred from initial support;
do not claim structured chat, native Cline tool cards or automatic RPC parity.

## Current repository integration points

Pi is absent from runtimeAgentIdSchema, RUNTIME_AGENT_CATALOG and the exhaustive
ADAPTERS map. Initial additions touch these surfaces:

| Existing file/surface | Planned work |
| --- | --- |
| `src/core/api-contract.ts` | Add pi identity and capability response validation without invalidating existing persisted sessions |
| `src/core/agent-catalog.ts` | Pi label, binary, install documentation and supported capabilities |
| `src/config/runtime-config.ts` | Identity normalization/persistence; keep existing defaults and auto-selection priority |
| `src/terminal/agent-registry.ts` | PATH/version/configuration reporting through existing catalog mechanism |
| `src/terminal/agent-session-adapters.ts` | Register Pi adapter; keep provider-specific work in small Pi modules |
| `src/terminal/session-manager.ts` | Reuse lifecycle/input/persistence; add only required exact-session metadata plumbing |
| `src/terminal/hook-runtime-context.ts`, `src/commands/hooks.ts`, `src/trpc/hooks-api.ts` | Existing task-scoped hook delivery, final-turn metadata and review checkpoint/notification path |
| `web-ui/src/components/runtime-settings-dialog.tsx` | Explicit Pi order and clear agent-native configuration instructions |
| Existing terminal/session/settings tests | Add Pi cases and retain exhaustive identity coverage |

New modules shipped as `src/terminal/pi-session-options.ts` (paths, session identity and
launch arguments; this is what the plan sketched as `pi-paths.ts`),
`src/terminal/pi-session-adapter.ts` and `src/terminal/pi-hook-extension.ts`, with the
shared launch helpers extracted into `src/terminal/agent-launch-helpers.ts`. The
monolithic adapter file keeps only the exhaustive `ADAPTERS` registration, and no parallel
task/session store was created.

## Implementation status (AA-P1)

### What shipped

| Surface | Owned behaviour |
| --- | --- |
| `src/core/api-contract.ts` | `pi` added to `runtimeAgentIdSchema` (ordered before `cline`), so persisted cards, board state and API validation accept it |
| `src/core/agent-catalog.ts` | Pi entry (`label: "Pi"`, `binary: "pi"`, empty `baseArgs`, empty `autonomousArgs` because Pi has no bypass flag, upstream install URL) and membership in `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS`, which is what makes it selectable and launchable |
| `src/core/agent-capabilities.ts` | Pi capability row (terminal presentation, explicit session resume, images, `planMode: "none"`, `approvalMode: "none"`, hook completion, automated delivery) and the agent-native model configuration (locations `~/.pi/agent/settings.json`, `~/.pi/agent/auth.json`, `~/.pi/agent/models.json`; note that Pi owns its model and runs tool calls without an approval prompt) |
| `src/config/runtime-config.ts` | `normalizeAgentId` is now schema-driven instead of a hand-maintained `||` chain, so adding an agent never means editing that list |
| `src/terminal/pi-session-options.ts` | Pi session id derivation, Kanban-owned session directory, launch-argument builder, Pi-settings default provider/model read, durable session-record read |
| `src/terminal/pi-session-adapter.ts` | `preparePiLaunch` (plan-mode refusal, exact-session flags, generated extension, forwarded model, attempt-scoped teardown) and `piAdapter` |
| `src/terminal/agent-session-adapters.ts`, `src/terminal/agent-launch-helpers.ts` | Pi registered in the exhaustive `ADAPTERS` map; the shared launch helpers (`resolveHookContext`, `createScopedHookResources`, `ensureTextFile`, `withPrompt`, `hasCliOption`, `toResourceScopeSegment`) moved out of the monolithic adapter file so the Pi module does not enlarge it |
| `src/terminal/pi-hook-extension.ts` | The Kanban-owned extension source, generated per launch attempt and loaded with `--extension` |
| `src/commands/hook-events/pi-hook-events.ts`, `src/commands/hooks.ts` | `normalizePiHookMetadata` for `source: "pi"` notifications, so Pi wording is owned by the Pi normalizer instead of shared heuristics |
| `src/prompts/append-system-prompt.ts` | Pi in the append-prompt agent list plus its own Linear MCP guidance line (`pi mcp add linear --url ...`, then `pi mcp login linear`) |
| `web-ui/src/components/runtime-settings-dialog.tsx` | Pi in the settings agent order and a model-configuration line under each agent-native row |
| `web-ui/src/components/task-start-agent-onboarding-carousel.tsx` | Pi in the onboarding agent order with install copy that names its own `~/.pi/agent` configuration |
| Tests | `test/runtime/pi-hook-events.test.ts` (6), `test/runtime/terminal/pi-session-adapter.test.ts` (16), `test/runtime/terminal/pi-hook-extension.test.ts` (11, runs the generated extension against a recorder stand-in for `kanban hooks notify`, including a recovered tool error and the dialog round-trip), updated `test/runtime/core/agent-capabilities.test.ts` and `test/runtime/terminal/agent-registry.test.ts` (exhaustive identity coverage, catalog-sized PATH probe count) |

### Launch contract actually implemented

- Session: `derivePiSessionId` mints `kanban-<hex>` from workspace + task, which satisfies
  the documented `--session-id` charset (letters, numbers, `.`, `_`, `-`, starting and
  ending alphanumeric). Sessions live in a Kanban-owned directory per workspace/task,
  passed with `--session-dir`; Kanban never uses `--continue`/`--resume` and never
  rewrites `PI_CODING_AGENT_SESSION_DIR`.
- A user-supplied session selection (`--session`, `--continue`, `--resume`), trust choice
  or model choice is left untouched, because `--session-id` cannot legally be combined
  with those session flags.
- `--no-approve` is the default so an unattended run cannot trust project-local `.pi`
  resources inside a worktree; `--approve` from the user wins.
- The task prompt is appended as a positional message after `--`, so a task that starts
  with a dash cannot be read as an option.
- Model: only Pi's own `defaultProvider`/`defaultModel` from its settings (or
  `PI_CODING_AGENT_DIR`) are forwarded, and only as `--provider X --model Y` or bare
  `--model Y`. Pi's documented rule that `--provider` requires `--model` is respected, no
  Kanban-side provider name is invented, and no credential ever enters argv, env, board
  state or a generated file.
- Completion: `agent_settled` is the only end-of-turn signal, and only when no
  continuation is queued. A failed tool call is never the turn outcome by itself — a red
  test run, an empty grep or a retried edit stays activity metadata, and the next
  assistant message without an error signal clears it. Only a failure still standing when
  the run settles (an assistant message with `stopReason: "error"` or `error`, or a turn
  that stops immediately after a failed tool call) is reported as an error.
- A blocking extension dialog (`ui_prompt_start` / `ui_prompt_end`) moves the card to
  Review while the terminal waits for the user and back to In Progress when it closes,
  because Pi does not fire `agent_start` again mid-run. A close with no matching start, or
  one that arrives after the turn already settled, moves nothing.
- An errored or aborted turn deliberately stays In Progress instead of moving to Review:
  `to_review` through the hook boundary is always `reviewReason: "hook"`, which fires the
  review-ready notification and captures a review checkpoint, so it would advertise failed
  work as ready to review. The failure is reported as activity with
  `notification-type: error` and the reason instead. Showing "needs you, but is not
  review-ready" would require a review reason in the hook contract, which affects every
  agent and is outside AA-P1.

### Deliberately not implemented

- No Pi version is pinned or claimed. The generated extension emits
  `pi_agent_version: null` because Kanban does not shell out to `pi --version` per launch;
  unknown usage stays unknown.
- No isolated `models.json`/provider config is generated for the local endpoint. An
  endpoint is Pi's own configuration, so Kanban reads Pi's decision instead of writing
  Pi's files (this replaces the earlier "isolated agent dir" sketch: no
  `getPiIsolatedAgentDir` / `buildPiIsolatedModelConfig` exists).
- Kanban's global "bypass permissions" setting is not translated into a Pi flag. Pi has
  none; the absence is disclosed in the capabilities note and in the model-configuration
  line shown under the Pi row in settings.
- JSON/RPC mode, structured chat and native tool cards stay deferred (see below).
- AA-E1 benchmark work is not part of this change.

### Verification actually performed

- `npm run typecheck`, `npm run lint` (Biome) and `web-ui` `npm run typecheck` are clean.
  `npx vitest run test/runtime test/utilities` reports 1988 passing tests and `web-ui`
  `npx vitest run` reports 792. The only failure in this environment was the known
  environment-dependent `test/runtime/server/middleware.test.ts` host/origin case (it
  compares against the ambient runtime host and port); the live-fetch
  `test/runtime/cline-sdk/cline-editor-transport-capture.test.ts` case is an intermittent
  loaded-runner flake. Neither is Pi-related.
- Upstream facts were re-checked against `earendil-works/pi` documentation
  (2026-11-21): the flags `--session-dir`, `--session-id`, `-e/--extension`,
  `-na/--no-approve`, `--provider`, `--model` and the `pi mcp add --url` form in
  `packages/coding-agent/docs/cli.md`, and the events `session_start`,
  `session_before_switch`, `session_before_fork`, `agent_start`, `agent_settled`,
  `message_end`, `tool_execution_end`, `model_select`, `ui_prompt_start`, `ui_prompt_end`
  in `packages/coding-agent/docs/extensions.md`.
- **Not performed here:** the manual smoke table below. No `pi` binary is installed in the
  implementation environment, so every Pi assertion above is exercised by unit tests
  against a recorder stand-in or an in-process fake, not by a live Pi process. Run the
  smoke list on a host with Pi installed (and one local endpoint) before describing Pi as
  verified end to end.


## Implementation slices

Implemented as designed, except where “Deliberately not implemented” above records a
deviation: no release was pinned (AA-P1a step 1) and no isolated Pi configuration
directory is generated (AA-P1a step 3), because Pi's own configuration is the contract.

### AA-P1a: version contract, identity and configuration

1. Select and pin a Pi release. Capture `pi --version`, `pi --help`, public extension
   types, session options and package engine requirements. Current upstream package
   identity is `@earendil-works/pi-coding-agent`; historical articles use
   `@mariozechner` packages. Do not mix generations.
2. Add pi to runtimeAgentIdSchema, catalog, normalization and exhaustive adapter maps.
   Keep it launch-disabled until the complete adapter acceptance suite passes.
   Persisted configurations for existing agents must round-trip unchanged.
3. Resolve Pi configuration/session directories using supported overrides and platform
   conventions from the pinned release. Current docs describe models.json custom
   providers; preserve auth and user extensions. Never rewrite global settings or
   change HOME merely to isolate one task.
4. Require explicit provider and model for a configured local-only session. Use Pi's
   OpenAI-compatible Chat Completions path for the existing endpoint, with actual
   context/output limits and supported reasoning capabilities. Do not guess the model
   from Cline's settings, force Responses API, or fall back to a cloud provider.
5. Expose configuration guidance and effective model identity in settings/diagnostics.
   Store credential references rather than secrets in board state. Base URL is the
   route reachable from the Kanban host, not necessarily localhost on the browser.

Use native configuration rather than adding a second provider-settings UI in AA-P1a.
If endpoint quirks require compatibility fields, use Pi's supported options after
checking installed types; do not silently strip reasoning/tool information.

### AA-P1b: launch, session ownership and extension

Launch the binary directly in the task worktree through the PTY manager.
Use the installed version's documented CLI options for explicit provider/model,
initial prompt, task-specific extension and session storage. Prompts must remain data,
including multiline text, Unicode and shell metacharacters.

Allocate a durable per-workspace/task session location and an attempt-scoped integration
directory outside the tracked worktree. Capture the exact Pi session path/identifier
from supported session APIs/extension events. Resume that session explicitly; never
use Pi's global latest-session selection. Reloading a terminal view must not resend
the initial task prompt or create a second live owner.

Generate a small Pi extension against public installed types. Register only Kanban's
lifecycle listeners; preserve Pi's normal tools, prompt and user extensions.
Use the shared launch attempt identity and existing hook command/ingestion boundary.
Invoke subprocesses with argument arrays, avoid shell interpolation of assistant text,
and bound metadata. Failed notifications should be observable but should not break a
tool's execution.

| Pi observation | Required translation |
| --- | --- |
| User turn / agent start | Running for the owned session and attempt |
| Tool start/result, assistant progress | Bounded activity metadata |
| Extension dialog / approval / question | Attention when observable; native terminal handles user response |
| Agent turn ends normally | Review candidate with final assistant evidence after outcome validation |
| Agent/tool/model error | Error metadata; normal completion must not be inferred |
| Session switch / new session / fork | Rebind only through an explicit supported action; otherwise reject task ownership change |
| Abort/process exit | Interrupted/error/exit handling through existing manager |

Verify actual event names and ordering in the pinned release; this table describes
semantics, not invented Pi API names. An agent-end event may also accompany errors or
abort: inspect terminal outcome, retry state and pending follow-up/steering queues before
signaling completion. Queued continuation must not publish a premature review notification.
Events from tools or a nested Pi launched by the agent cannot terminate the parent task.

Ensure the extension does not propagate parent hook ownership into a child Pi session.
Preserve the final assistant output and PR URL observations for existing diagnostics
and PR recorders. Unknown usage remains unknown, not zero.

### AA-P1c: permissions, UI and automation support

Show Pi in settings with installation/version checks and agent-native model guidance.
Use the existing terminal panel and composer/input route. Hide Cline-specific reasoning,
compaction and MCP settings for Pi. Declare unsupported images/plan mode explicitly
until verified for the CLI and model; do not silently drop attachments.

Pi is intentionally extensible and historical versions lack built-in plan mode,
MCP and permission gates. Read current installed capabilities rather than relying on
the historical blog. Do not translate Kanban's autonomous toggle into an invented flag.
If the selected release executes tools without approval, disclose that capability
accurately and prevent the UI from promising an interactive approval policy it cannot
enforce. Supporting a restricted mode would require a tested blocking extension before
tool execution, not a prompt saying "ask first." No such restriction is assumed here.

Pi's local provider support does not grant access to Open WebUI's per-user OAuth tools.
Initial Pi integration does not import those tokens or promise MCP parity.
Native CLI tools and separately configured extensions can be evaluated later.

Trace commit/PR actions, automated review repair, PR comment addressing, trash restore,
dispatch and reliable-completion gates as required by AA-S1. Keep reviewer configuration
independent. Unsupported Cline-native automation must be capability-gated with a clear
explanation; ordinary terminal task execution can ship without falsely advertising it.
A successful Pi turn does not bypass verification, review or push requirements.

## Tests and manual validation

Use fake executables and recorded typed event fixtures, not live provider calls, in CI.

| Scenario | Required assertion |
| --- | --- |
| Identity added | Config/API/catalog/settings and persisted sessions accept pi; existing identities unchanged |
| Binary missing or unsupported | Clear install/version remediation; no phantom running session |
| Local config invalid | No cloud request or default-provider fallback |
| Literal/multiline prompt | Arrives once, byte-correct; no shell execution |
| User extensions/config exist | Kanban extension adds its behavior without deleting/replacing user resources |
| Normal turn, failed turn, abort, pending retry | Correct distinct outcomes; review only for eligible final turns |
| Queued follow-up or steering | No early completion between automatic continuation turns |
| Two tasks / retry attempts / nested child Pi | Events affect only the current owned task attempt |
| Resume after restart or trash restore | Exact persisted session and correct worktree; no latest-session guessing |
| Slow/hung provider and tool subprocess | Cancellation terminates owned work and cleanup completes |
| Unavailable capabilities | API rejects and UI explains; no Cline fallthrough |
| Duplicate hooks / browser reconnect | No duplicate prompt, checkpoint or review notification |

Filesystem tests isolate HOME/USERPROFILE; Git subprocesses use repository-safe test
environments. Add focused tests alongside adapter/registry/session/state/hooks suites,
and settings component tests. Run backend/frontend typechecks, CI and Biome for source.

Manual smoke with local Qwen: a file edit plus meaningful test, one follow-up, one
tool failure and recovery, cancellation during generation, cancellation during a tool,
server restart/resume and two concurrent tasks. Inspect actual endpoint traffic,
model identity, task state and sanitized diagnostic export. Then run the common
comparison suite from shared.md. Do not judge quality from one successful demo.

Acceptance: supported task flows work without manual terminal setup per task; exact
resume and isolation hold; local-only selection cannot silently invoke hosted models;
unsupported features are visible; no Cline behavior regresses.

## Future RPC integration boundary

If native structured chat becomes a requirement, create a separately scoped plan/PR.
Use Pi's typed RpcClient for subprocess isolation or SDK for an explicitly chosen
in-process architecture. Add bounded JSONL framing, response-ID correlation, event
reconciliation, cancellation, restart and extension-UI handling. Keep stdout protocol
separate from stderr and terminal logs. Prove the generalized session UI/storage and
writer admission can represent Pi before replacing the PTY transport.
The RPC documentation says installed `pi --help` is authoritative; pin protocol
fixtures to the supported release. This work is not hidden inside AA-P1.

## Deployment and rollback

Planning PR: no deployment, environment changes or dependencies.
Implementation: install the pinned Pi CLI on Kanban host PATH, configure its local
provider/model in the user's native configuration, deploy Kanban, then explicitly select Pi.
The implementation PR must list tested CLI version, any actual override variables,
config file locations, permission behavior and smoke results. No new environment
variable is mandated by this plan.

Keep the default agent unchanged. Rollback disables new Pi launches and removes only
Kanban-owned integration resources after stopping their processes; retain sessions,
logs and user configuration. Separately authorized host/model changes require a
homelab-documentation PR.

## Upstream references

Accessed 2026-11-19. Recheck release-specific definitions before implementation.

- [Pi overview, modes and package identity](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- [Model and endpoint configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
- [Extension interfaces](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [RPC boundary and typed client](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Historical design and benchmark report](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
