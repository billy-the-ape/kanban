# Add OpenCode to Kanban

Status: implemented (AA-O1a, AA-O1b, AA-O1c) against the pinned OpenCode release
1.19.6; see the implementation record at the end of this file.
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

### How each hazard resolved

- **Config merge.** 1.19.6 treats `OPENCODE_CONFIG` as one *additional* source, so
  pointing it at the Kanban overlay leaves the user's global and project config
  (providers, credentials, agents, instructions, MCP servers) in force. The overlay
  only adds the bridge, and it uses the `plugin` key with a **directory** entry:
  the newer `plugins` key is rejected as an unsupported setting, and explicit
  single-file paths are skipped, so the directory ships with a
  `package.json` (`"type": "module"`, `main: "./index.js"`) for the `export default`
  entry point.
- **Bridge text reaching the card.** Every ingest call carries `--source opencode`,
  which selects `normalizeOpenCodeHookMetadata`
  (`src/commands/hook-events/opencode-hook-events.ts`): it owns the bridge's own
  payload keys (`final_message`, `activity_text`, `tool_input_summary`, `tool_name`,
  `hook_event_name`, `notification_type`) and clips the text to the shared bounds. On
  the shared parser that payload is unidentified, so the card would move and the text
  would be dropped; the plugin suite therefore drives the emitted argv and payload
  through the real `normalizeHookMetadata` rather than asserting on the argv alone.
- **A user who exports `OPENCODE_CONFIG` themselves.** That file is a source only
  because of the variable, so repointing it would silently discard the user's
  providers, agents and MCP servers. Kanban parses it (JSONC), carries every
  top-level key into the generated overlay, resolves the user's own `plugin`
  entries against the directory they were written in, and appends the bridge last.
  A file Kanban cannot parse is left exactly as it is: the launch says the bridge is
  inactive, which is visible, rather than quietly dropping configuration it was not
  given. Model discovery ranks the same way the CLI loads: global files, then
  `OPENCODE_CONFIG`, then the project files.
- **Isolation.** Kanban launches one OpenCode process per card in that card's PTY, so
  no shared background service is involved; `OPENCODE_DISABLE_AUTOUPDATE=1` stops a
  task launch from downloading a different build behind the version check. Every
  generated resource lives in the per-attempt hook directory owned by the launch.
- **Credential and model-state reads.** Removed: `src/terminal/opencode-paths.ts` and
  its test are gone. Model discovery now reads only OpenCode *configuration* files
  (`opencode.json`/`opencode.jsonc` in the XDG/legacy global dirs, the project dir, or
  `OPENCODE_CONFIG`) and never the auth store or the saved-model state file.
- **`--continue`.** No longer emitted. A saved command that still carries it is
  rewritten on every path — a fresh launch, and a resume, where it would otherwise sit
  next to the pinned `--session` and leave the CLI to choose — and the launch records a
  warning, because "most recent session" is not a per-card fact.
- **Explicit agent lists.** The launch gate, the capability row, the registry
  assertions and the settings ordering all moved together; the registry test now pins
  the launchable id list, so adding a CLI without its capability row fails there.


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
continuation, and the bridge reports that continuation itself: this release answers a
permission inside the running tool, so the approved tool finishing is what returns the
turn to busy and lets its final idle complete the card. Clean generated resources on all
exit paths. Persist resume metadata and
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

Manual smoke: the required pre-rollout checklist under **Deployment and rollback** is the
current form of this run - one card per case, with the observed card state recorded next
to each step; confirm logs identify the selected local route.
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

### Required before production rollout (not yet performed)

CI never calls a real model, so the event contract in this document is verified against
fixtures and the CLI's help output only. Before enabling OpenCode for real work, run one
card per case below on a host with OpenCode 1.19.6 and the intended local provider, and
record the observed card state next to each step:

1. **Small edit plus test.** Card goes to in progress once at the prompt, each tool
   reports activity with a non-empty tool detail on both its start and its finish, and
   the turn ends in exactly one review whose summary is this turn's assistant text.
2. **Permission request.** Card parks with the attention reason and the terminal stays
   interactive; approving lets the tool finish, and that same turn then produces the
   completion review - no extra prompt is needed to resume the turn.
3. **Tool-only or empty follow-up.** The new turn's review carries no summary from the
   previous turn.
4. **Stop during a model call, then resume; restart Kanban and resume.** The recorded
   session is resumed, or Kanban says a new session is needed instead of attaching to an
   unrelated conversation.
5. **Two cards concurrently in different worktrees.** No cross-task activity, review or
   cancellation, and a sub-agent session moves neither card.
6. **Unreachable or failed endpoint.** The card shows the error reason and never claims
   completion.

If any step disagrees with the contract table above, the correction belongs in
`src/terminal/opencode-plugin-source.ts` (version-specific translation stays there) and
this document is updated with the observed behavior.

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

## Implementation record (AA-O1)

Pinned release: **1.19.6** (`OPENCODE_PINNED_VERSION`), with
`OPENCODE_MINIMUM_VERSION` = 1.19.0. The adapter runs `opencode --version` on every
launch: a detected release below the minimum throws with install/upgrade guidance, an
unreadable version stays launchable (guidance beats a false block), and a missing CLI
never produces a phantom live session. Tested on Linux (CI fixtures + the sandbox
host); macOS/Windows rely on the same argv and env contract.

### Files

| Path | Role |
| --- | --- |
| `src/terminal/opencode-integration.ts` | version probe + compatibility, session-existence probe, model selection, config discovery, launch overlay layout, selector validation. Replaces `src/terminal/opencode-paths.ts` (deleted). |
| `src/terminal/opencode-plugin-source.ts` | generates the per-attempt bridge (`index.js` + `package.json`) for the pinned event/hook API. |
| `src/terminal/agent-session-adapters.ts` | `opencodeAdapter`: version gate, exact `--session` resume, `--continue` removal, `--agent plan`, `--auto`, overlay wiring, `--model`, single-element `--prompt`. |
| `src/commands/hooks.ts`, `src/core/api-validation.ts`, `src/core/api-contract.ts` | `--session-id` on `hooks ingest` and `externalSessionId` on the session summary. |
| `src/commands/hook-events/opencode-hook-events.ts` | normalizes the bridge payload (final text, activity sentence, tool detail) into the shared activity metadata; chosen by `--source opencode`, like the Pi normalizer. |
| `src/trpc/hooks-api.ts` | records the reported session id and maps the notification type to the review reason (`error`, `attention`, `hook`). |
| `src/terminal/session-manager.ts` | `applyExternalSessionId`, passes the stored id into the next launch, surfaces adapter `warningMessage`. |
| `src/core/agent-catalog.ts`, `src/core/agent-capabilities.ts` | launch-supported entry, `--auto` autonomous args, capability row, agent-native model note and config locations. |
| `web-ui/src/components/runtime-settings-dialog.tsx` | settings agent order includes OpenCode. |

### Model policy (AA-O1a requirement 5)

`--model` is passed only for a model a human selected: `KANBAN_OPENCODE_MODEL`,
else the `model` key of the user's own OpenCode config (project file wins over the
global one, matching OpenCode's merge), else nothing at all so OpenCode applies its
own default. Kanban never reads `auth.json`, the saved-model state file, or a
credential store, and never prefers a hosted provider. A value that is not a
`provider/model` selector is reported as a launch warning and dropped rather than
guessed; selectors accept slashes and colons inside the model id
(`openrouter/anthropic/claude-...`, `ollama/qwen2.5-coder:32b`) and reject
anything that starts like a flag.

### Event bridge contract (AA-O1b)

| Observation | Kanban behavior |
| --- | --- |
| `session.busy` / `session.status{busy}` | card back to in progress, once per turn |
| `session.idle` / `session.status{idle}` while busy | one review per turn (`activity_text: "OpenCode finished the turn"`, `final_message` = the assistant text **of this turn**; a genuinely new turn forgets the previous turn's text, so a tool-only or empty follow-up reports none instead of repeating a read summary) |
| `tool.execute.before/after` | bounded activity with `tool_name` and `tool_input_summary`; the summary is read before the call is forgotten, so the after-event carries the same detail as the before-event |
| `permission.ask` with `status: "ask"` | review with `notification_type: "permission.asked"` → attention reason; the following idle is not completion |
| `session.error` | review with `notification_type: "error"` → error reason, deduplicated per turn |

Ownership: `KANBAN_OPENCODE_SESSION_ID` is set **only for a resume**, because a fresh
launch starts a new conversation and a bridge pinned to the previous id would reject
every event from the running one. When it is set the bridge answers only for that
session; otherwise the first non-child session becomes the root and child sessions
(`session.parentID`) contribute nothing. A non-resume start therefore clears the stored
`externalSessionId` and lets the bridge report the new id. Every notification carries
`source: "opencode"`, the session id, and a base64 payload, and is best-effort with a
20s kill so a bridge failure can never break a session.

### Settings and environment

- `KANBAN_OPENCODE_MODEL` (optional, read by Kanban only): `provider/model` override for
  the current user's launches.
- `KANBAN_OPENCODE_SESSION_ID` (Kanban-owned, resume launches only): pins the root
  session for the generated bridge.
- `OPENCODE_CONFIG` and `OPENCODE_DISABLE_AUTOUPDATE` (Kanban-owned, per launch): additive
  overlay and no auto-update during a task.
- Settings shows OpenCode with its binary, config locations
  (`~/.config/opencode/opencode.json`, `<project>/.opencode/opencode.json`) and the
  model note above; Cline-only provider/reasoning controls stay Cline-only.

### Tests

`test/runtime/terminal/opencode-integration.test.ts` (version contract, selectors,
config discovery that never touches auth/state, JSONC parsing, overlay shape,
fixture-script session probes), `test/runtime/terminal/opencode-plugin-source.test.ts`
(the generated file is imported and driven with a fake client; Kanban calls are
captured from a recorder script, and the captured argv plus payload are then run through
the real `normalizeHookMetadata` so the card text is verified end to end, including a
permission answered inside the tool), the OpenCode block in
`test/runtime/terminal/agent-session-adapters.test.ts`, capability rows in
`test/runtime/core/agent-capabilities.test.ts`, id list plus capability/command
assertions in `test/runtime/terminal/agent-registry.test.ts`, and session-identity and
review-reason cases in `test/runtime/trpc/hooks-api.test.ts`.

### Verified against the installed CLI (1.19.6)

These were checked by running the pinned release (`opencode-linux-x64` 1.19.6) with a
throwaway `HOME` and an empty project, through Kanban's own `probeOpenCodeVersion` /
`verifyOpenCodeSession` and the overlay Kanban generates:

- `opencode --version` prints `1.19.6`; Kanban's probe parses it and the compatibility
  gate reports `supported` with no remediation.
- `opencode --help` documents every flag the adapter passes to the interactive form:
  `-s, --session` (session id to continue), `--prompt`, `--agent`, `--auto`
  (“auto-approve permissions that are not explicitly denied (dangerous!)”) and
  `-m, --model` (“model to use in the format of provider/model”), alongside
  `-c, --continue`, which the adapter strips.
- `opencode session list` is a real command and prints nothing for a project with no
  sessions (exit 0), so the exact-resume probe correctly answers "does not exist" there.
- Configuration really is additive: one run logs the global config paths **and** the
  `OPENCODE_CONFIG` overlay. With the newer `plugins` key the CLI logs
  `level=WARN … kind=unsupported action="Omitted native setting that cannot be
  represented in V1"` and loads nothing; with `plugin: ["<absolute directory>"]` the
  bridge module is loaded; a `plugin` entry naming a single `.js` file never loads.
- Cost of loading a local plugin directory: the first run took ~5s against a ~1s control
  and settled to ~1s afterwards, so a card's first OpenCode launch starts a few seconds
  slower. Separate first loads contended long enough to exceed 15s each, which is why
  concurrent first OpenCode launches on one machine can start slowly.
- Not covered: the positive path of the session probe (creating a session requires a
  provider) and a real model turn. Which events 1.19.6 really emits, in which order and
  with which payload keys, is therefore verified against fixtures and the CLI's own help
  output only; a run against a real provider is still required before this contract can
  be called confirmed (see Known limitations).

### Known limitations

- Image attachments are refused with a message (`images: false`): only OpenCode's
  one-shot `run` form has an attachment flag, and Kanban keeps the TUI so a card can
  take follow-up input.
- Commit/PR automation prompts are still plain terminal input; the pre-existing
  `automatedDelivery` row was not changed here, so reliable-completion behavior for
  OpenCode is whatever that policy already allowed.
- CI never calls a real model. Version and session probes use fixture executables, so the
  required pre-rollout smoke run under **Deployment and rollback** is still outstanding on
  a host with OpenCode 1.19.6 and a real local provider: the event contract, the approval
  resume and the per-turn summary are fixture-verified only.
- The first-run onboarding carousel keeps its original curated list; OpenCode is
  selectable in Settings and the task-start picker.
- A card's first OpenCode launch on a machine starts a few seconds late, because loading
  a configured local plugin directory costs ~4s on top of the CLI's ~1s startup and
  settles to ~1s afterwards; parallel first loads can contend further. Nothing is
  installed per launch and `OPENCODE_DISABLE_AUTOUPDATE=1` keeps the version fixed.
- `--session` resume requires the id the bridge reported. A card created before AA-O1
  (or a session OpenCode has since dropped) fails with an explicit "start a new session"
  message instead of attaching to another conversation.
- Merging a user's `OPENCODE_CONFIG` rewrites only their `plugin` entries into absolute
  paths; any *other* relative path inside their configuration (an `instructions` file,
  for example) is carried as written and then resolves against the generated overlay
  rather than the file it came from. A card whose variable points at something Kanban
  cannot parse runs without the bridge, so it never moves itself to review; the launch
  warning names the file.
