# Additional agents: shared groundwork and benchmark evidence

Status: AA-S1 implemented in this repository (shared agent contracts, launch provenance,
attempt-scoped events). AA-O1 (OpenCode), AA-P1 (Pi) and AA-E1 (evaluation) remain planned;
no additional agent is enabled by this change.
Research and repository inspection date: 2026-11-19.
Inspected Kanban main: `e7b2097af06364b01410c6b69d353d52d22a6aa4`.
Re-read current code and applicable AGENTS.md before implementation.

## Outcome and implementation order

Add OpenCode and Pi as explicitly selectable agents that can use the existing local
Qwen endpoint, operate in Kanban task worktrees, accept follow-up input, and report
activity, attention, failures, and end-of-turn status accurately. Keep Kanban responsible
for task ownership, worktree preparation, verification, review, and publication.

| Order | Implementation PR | Deliverable |
| --- | --- | --- |
| 1 | AA-S1 (implemented): shared agent contracts and lifecycle groundwork | Explicit capabilities, configuration provenance, task-scoped event ownership, regression coverage |
| 2 | [AA-O1: OpenCode](./opencode.md) | Repair existing dormant adapter and enable supported, tested versions |
| 3 | [AA-P1: Pi](./pi.md) | Add Pi identity, terminal adapter, task-scoped extension, configuration and lifecycle support |
| 4 | AA-E1: comparative evaluation | Run the same frozen local-Qwen task suite across available runners; publish results separately |

Each agent plan defines further implementation slices if a single PR becomes too large.
OpenCode and Pi both depend on AA-S1; neither depends on the other. Do not start or
deploy implementation work merely by merging this planning PR.

## What exists in this fork

These are observations from inspected source, not assumptions about upstream Kanban.

| Existing surface | Implication |
| --- | --- |
| `src/core/agent-catalog.ts` | OpenCode already has a catalog entry, but is commented out of RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS. Pi is absent. |
| `src/core/api-contract.ts` | runtimeAgentIdSchema already includes opencode; adding pi affects persisted and API validation. |
| `src/config/runtime-config.ts` | normalizeAgentId checks identities and launch support; auto-selection priority is separate. |
| `src/terminal/agent-registry.ts` | PATH detection and selectable definitions come from the catalog; configuration response includes Cline-specific settings. |
| `src/terminal/agent-session-adapters.ts` | Existing OpenCode launch, model inference, config paths and generated event plugin; adapter map is exhaustive over RuntimeAgentId. |
| `src/terminal/session-manager.ts` | Existing PTY launch/input, output, cleanup and session persistence; use it for initial terminal integrations. |
| `src/terminal/session-state-machine.ts` | Running, awaiting-review and interrupted states; exit code zero is an exit observation, not proof of task correctness. |
| `src/trpc/hooks-api.ts` and `src/commands/hooks.ts` | Existing hook ingestion, activity, checkpoints, PR discovery and review notifications. |
| `src/server/task-writer-activity.ts` | Admission depends on actual native/terminal writer activity, not saved running flags alone. |
| `src/server/runtime-server.ts` | Native Cline and terminal session services are separate; reviewer sessions have their own Cline service. |
| `src/task-dispatch/task-dispatch-service.ts` | Existing dispatch and delivery must be checked for agent-specific assumptions. |
| `web-ui/src/components/runtime-settings-dialog.tsx` | Explicit agent order currently lists Cline, Claude, Codex, Droid and Kiro; several settings are Cline-only. |

Read the existing agent-reliability plans at
[`../agent-reliability/README.md`](../agent-reliability/README.md).
Do not apply native Cline SDK compaction, model selection or prompt hooks to other
agents by casting types or copying Cline records. The older
`.plan/docs/tui-agent-integration-plan.md` and CLI reference snapshots explain history;
they are not authoritative descriptions of current external CLI versions.

## AA-S1: shared implementation contract

### Capability and configuration boundaries

Extend the existing catalog/API response with the smallest typed capability description
needed by these integrations. Proposed concepts: terminal presentation, explicit resume,
images, plan mode, approval mode, completion signal and automated-delivery support.
Use capability checks to control UI and API validation; unsupported operations must
return a useful error rather than silently falling through to Cline behavior.
Do not build a universal agent SDK or replace the existing Cline boundary.

Keep default agent and auto-selection priority unchanged. Adding an executable to PATH
must not switch an existing user to a new runner. Missing binaries remain selectable
only for installation guidance; starting them fails before creating a phantom session.

Use agent-native model configuration initially. Show its configuration location and the
resolved provider/model when available. Do not label Cline's configured Qwen as the
model used by every agent. Require explicit model resolution for a configured local-only
run; missing/invalid model configuration must never fall back to a hosted provider.
Do not introduce shared API keys or copy OAuth tokens into agent settings.

Snapshot launch provenance with the task session: agent/version, model/provider,
configuration fingerprint with secrets removed, effective cwd, task/workspace/session
identity and attempt identifier. Distinguish requested settings from observed model
identity; unknown values remain unknown. Pin a running process to its launch settings.
A deliberate resume after a configuration change must display and record the change;
do not silently continue a different agent's session.

### Process and event ownership

Continue direct PATH discovery and process launch. Do not run interactive login shells
for discovery or type a startup command into a shell. Preserve existing platform-specific
PTY behavior and Windows support.

Generated integration resources must be scoped at least by workspace, task and launch
attempt. Persist the exact external session identifier/path; never use a global
"most recent session" to resume. A stale child, hook or plugin must not advance another
task or a later attempt of the same task. Add the minimal attempt token validation at
the existing hook boundary if current context only validates task/workspace identity.
Keep tokens out of public diagnostics.

Represent input-needed, normal end-of-turn, cancellation, transport failure, process
exit and verified delivery as distinct facts. Reuse the state machine, hook ingestion,
writer admission, checkpoint and review-notification paths. A tool finishing, an idle
screen, an error, a permission request, or process exit alone must not report verified
task completion. Generic PTY heuristics remain best-effort attention detection.

Stop owned processes and descendants, unregister callbacks and clean temporary resources
on cancellation, startup failure, normal teardown and server shutdown. Preserve durable
conversation state for resume. Browser disconnect is not cancellation.
Never mark a saved session live until a live owner is established after restart.

### Automation and publication

Trace user task start, follow-up, pause/resume, trash/restore, commit/PR actions,
review repair, sequential dispatch and PR comment addressing through current callers.
For each, explicitly classify support for a terminal agent. In particular, a native
Cline reviewer can remain Cline even when the implementation agent is OpenCode or Pi;
do not silently claim the reviewer uses Qwen or the new harness.

Wire supported actions through existing review/verification/delivery gates. If a path
fundamentally assumes Cline SDK sessions, reject or disable that action for the new
agent with a clear reason until a separate implementation provides it. Never report
full reliable-completion support merely because hooks can move a card to In Review.
Do not remove existing gates to make a new runner work.

Agent credentials on a single-user Kanban host are not the same mechanism as Open
WebUI's per-user OAuth tools. A future Open WebUI bridge is out of scope. Preserve
existing authentication; any separately authorized device/configuration deployment
must update homelab-documentation.

### Tests and acceptance

Add focused tests to the existing catalog, runtime-config, session adapter, state
transition, hooks and settings suites. Use fake executables and captured versioned
event fixtures for lifecycle tests; do not require live models or cloud accounts in CI.
Cover two tasks in parallel, two attempts of one task, stale and duplicate events,
missing binaries, invalid config, startup failure, denied approval, interrupted turn,
restart, cleanup and resumption of the exact session.

Prove existing Cline/Claude/Codex/Droid/Kiro persisted configuration still loads and
launches as before. Isolate filesystem tests under temporary HOME/USERPROFILE and
sanitize Git subprocess environments using the repository helpers.

Implementation validation: relevant focused tests, `npm run typecheck`,
`npm run web:typecheck`, and repository CI. Use Biome for supported source files.
The inspected biome.json excludes Markdown, so this planning change needs Markdown
link, fence, whitespace and scope checks rather than an unrelated formatter.

Acceptance: new capability/config fields are backward compatible; unavailable features
are visibly unavailable; task-scoped events cannot affect another attempt; existing
agents pass regression tests; no settings silently select a different model.

### Implementation status (AA-S1)

Landed in this repository; AA-O1 and AA-P1 build on it without changing it.

- Capability table: `src/core/agent-capabilities.ts` is the exhaustive, typed description of
  terminal presentation, explicit resume, images, plan mode, approval mode, completion
  signal and automated delivery, plus where each agent's model is configured
  (`kanban-settings`, `agent-native` or `unknown`) and that configuration's locations. Only
  Cline reports Kanban-owned model settings and card-backed session resume; every other
  agent is agent-native and resumes "the most recent session", never the session Kanban
  started.
- Response surface: `runtimeAgentDefinitionSchema` in `src/core/api-contract.ts` carries
  `capabilities`, `modelConfiguration` and `installUrl`, filled by
  `buildRuntimeAgentDefinition` in `src/terminal/agent-registry.ts`. Previously persisted
  project and global configuration still loads because no existing field changed meaning.
- Unsupported operations: `getUnsupportedAgentLaunchOperations` classifies what an agent
  cannot honor (for example autonomous mode on OpenCode, or explicit resume on any
  CLI-launched agent) and `formatUnsupportedAgentLaunchError` names the agent and the
  operation. A missing binary yields `formatMissingAgentInstallError` with the catalog
  install URL, so no phantom session is created.
- Attempt ownership: `createLaunchAttemptId` mints one token per launch, the adapter hands
  it to the agent as `KANBAN_HOOK_ATTEMPT_ID_ENV`, the session summary stores it as
  `launchAttemptId`, and `createHooksApi().ingest` refuses card mutations and activity
  writes for an event whose token differs from the running attempt while still answering the
  hook with `{ ok: true }`. An event without a token cannot be proven stale and stays
  accepted, which keeps older integrations working.
- Scoped generated resources: the session adapters write settings, plugins and hook scripts
  under `~/.cline/kanban/hooks/<agent>/<workspace>/<task>/<attempt>` instead of a shared
  per-agent directory, point the agent at exactly that path, and delete only that directory
  on exit through the new `PreparedAgentLaunch.cleanup` hook. Kiro keeps its own
  agent-definition directory but now uses a per-task agent name. Sessions with no workspace
  context (the home agent) keep the previous shared path because they never addressed a
  generated file.
- Launch provenance: `src/terminal/launch-provenance.ts` records agent, binary, requested
  model (read back from launch arguments), observed model and version only when the agent
  actually reports them, model configuration source and locations, effective cwd, and
  task/workspace/attempt identity. The configuration fingerprint keeps configuration-shaped
  arguments and environment values, drops prompt text, drops credentials entirely, ignores
  hook identity tokens, and normalizes home, temp and attempt-scoped paths so a plain
  restart is not reported as a configuration change. Both the current and the previous
  launch fingerprint are stored on the session summary, and the exported
  `didLaunchConfigurationChange` turns them into one change fact; showing that change to
  a user is deliberately left to the agent slice that needs it, so AA-S1 records the
  difference without inventing a settings-screen banner no agent has asked for yet.
- Test coverage: `test/runtime/core/agent-capabilities.test.ts` and
  `test/runtime/terminal/launch-provenance.test.ts` are new;
  `test/runtime/terminal/agent-session-adapters.test.ts`,
  `test/runtime/terminal/hook-runtime-context.test.ts` and
  `test/runtime/trpc/hooks-api.test.ts` now cover per-attempt scoping and teardown, two
  parallel tasks in one workspace, two attempts of one task, stale and unowned events,
  credential-free fingerprints and the capability table. Web fixtures that only exercise the
  pre-AA-S1 fields spread `agentDefinitionTestDefaults` from
  `web-ui/src/runtime/agent-definition-test-defaults.ts`.
- Still out of scope here: the AA-E1 benchmark protocol, rendering per-agent capability rows
  in the settings dialog (the existing rows already surface install links and not-installed
  state from the same catalog), and enabling automated delivery for terminal agents -
  `automatedDelivery` and the `hook` completion signal describe what a runner can report,
  not reliable-completion support.

## Existing benchmark evidence

### Interpretation rules

A score belongs to a specific model, harness build, benchmark revision, inference
configuration and resource budget. Treat vendor runs as vendor-reported evidence.
Do not compare percentages across different benchmark suites or revisions, mix pass@1
with best-of-N, or infer local quantized-Qwen performance from hosted Claude/GPT runs.
No controlled comparison of all discussed harnesses on this user's exact Qwen GGUF,
llama.cpp build and endpoint was located in this research.

Search queries returned incomplete coverage, and some live leaderboards did not expose
their rows in fetched HTML. The entries below are retrievable primary evidence,
not an exhaustive survey or a current global ranking. "Not located" does not mean
that no benchmark exists.

| Harness/evidence | Result or method | What it establishes and limits |
| --- | --- | --- |
| Factory Droid, 2025-09-25 [F1] | Terminal-Bench Core v0.1.1, 80 tasks: Droid Opus 4.1 58.8%, GPT-5 52.5%, Sonnet 4 50.5%; article compares Claude Code Opus 43.2% and Codex CLI 42.8%. | Historical vendor-reported harness/model comparisons; GPT-5 pairing is informative, but budgets/builds must be checked before claiming a controlled causal improvement. Not Terminal-Bench 2.0 and not local Qwen. |
| Pi, 2025-11-30 article updated with December results [P1, P2] | Author describes five trials per task on Terminal-Bench 2.0 with Opus 4.5. Submitted JSON reports mean 0.4786516854, 445 total trials, 428 trials in its eval entry and 71 errors. | About 47.9% as the submitted artifact reports it. Counts and error treatment need reconciliation before deriving a replacement metric; a single author-run artifact is not a harness-only comparison or current ranking. |
| Cline open-weight evaluation, 2026-08-18 [C1] | Reports repeated-run spreads, e.g. MiniMax M3 43.8–56.2% across five reruns. A truncation/final-stack comparison moves MiniMax M2.7 32.6→46.1%, GLM-5.1 48.3→57.3%, DeepSeek V4 Flash 48.3→41.6%. | Concrete evidence that harness changes interact with model choice and results vary. Final-stack deltas combine changes; do not attribute all gain to one truncation knob. These are vendor experiments, not Qwen measurements. |
| Cline-Bench, published 2026-11-19 [C2] | 47 real-request tasks, three trials each, Cline CLI 3.0.74, four-hour limit. Opus 5.5 pass@1 48.9%, pass@3 59.6%, all-three pass 42.6%. | Useful real-repository evaluation method and consistency reporting. Holds harness fixed and varies models; cannot rank Cline against Pi/OpenCode. Installed Kanban Cline SDK is a different integration/build. |
| Aider polyglot [A1] | 225 Exercism tasks in six languages. Published GPT-5 high row: 88.0% after the benchmark's second pass versus 52.0% first pass. | Editing/instruction benchmark, not general autonomous repository work; second-pass score is not a single attempt or cross-harness comparison. |
| Aider architect/editor, 2024-09-26 [A2] | Claude 3.5 Sonnet baseline 77.4% versus same-model architect/editor 80.5%; GPT-4o baseline 71.4% versus same-model pair 75.2%. | Direct workflow-change evidence with the model held nominally constant, but two inference stages spend more compute. Historical editing suite, distinct from the later polyglot benchmark. |
| Claude Code and Codex CLI | Historical comparison rows in [F1]; Pi compares against other harnesses with their respective native models [P1]. | Evidence of capable systems and harness headroom, not clean proof that one harness is universally better. |
| OpenCode, Goose, Kiro, native Open WebUI loop | No reproducible, controlled same-Qwen cross-harness result located in the inspected primary sources. | Integrate based on fit and measure locally; do not invent a score or treat missing evidence as poor performance. |

Terminal-Bench tests end-to-end terminal tasks; SWE-bench tests repository issue
resolution; Aider's exercises emphasize code editing. SWE-bench's Bash Only view holds
mini-SWE-agent constant across models [S1], so it is primarily model evidence.
The fetched Terminal-Bench site exposed headings and confidence-interval descriptions
but no populated result rows [T1]; no current ranks are transcribed from it.

### Sources

All URLs accessed 2026-11-19; dates above are publication/run dates, not freshness guarantees.

- [F1: Factory Terminal-Bench report](https://factory.com/news/terminal-bench)
- [P1: Pi author's design and benchmark report](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- [P2: Pi submitted result JSON](https://gist.github.com/badlogic/f45e8f6e481e5ab7d3a50659da84edaa)
- [C1: Cline open-weight evaluation experiments](https://cline.bot/blog/open-sourcing-evals-for-open-weight-agents)
- [C2: Cline-Bench methods and results](https://cline.bot/blog/cline-bench-faithful-and-fair-evaluation-of-agents-on-real-user-requests)
- [A1: Aider polyglot leaderboard](https://aider.chat/docs/leaderboards/)
- [A2: Aider architect/editor evaluation](https://aider.chat/2024/09/26/architect.html)
- [T1: Terminal-Bench](https://www.tbench.ai/)
- [S1: SWE-bench methodology and leaderboard](https://www.swebench.com/)

## AA-E1: local comparison protocol

Start with Cline, Droid if configured, OpenCode and Pi. Freeze one exact local Qwen
model revision/quantization, llama.cpp revision, llama-swap route, chat template,
context/output limits, sampling and supported reasoning settings. Record rather than
pretend to equalize model-specific options. Use the same endpoint and initial task
prompt; preserve each runner's normal system prompt/tool design because those are the
experimental variable. Disable incidental cloud helpers or record their use in a
separate mixed-model arm.

Use 12 fixed, runnable repository tasks: three small fixes, three multi-file features,
two test/debug repairs, two long-context investigations followed by edits, and two
follow-up/review-repair tasks. Freeze starting commits, dependencies, task descriptions
and independent acceptance tests. Run each task three times per harness from fresh
worktrees/sessions; randomize run order and keep GPU concurrency constant, initially one.
Use the same declared wall-clock and output budget; record timeout versus completion.
For follow-up tasks use identical scripted feedback at the same semantic checkpoint.

Primary outcome: independently verified completion with no human intervention.
Report per-trial pass rate, tasks passed at least once, tasks passed all three times,
median and tail elapsed time, input/output and cache tokens where actually available,
peak context, tool errors/retries, intervention count and review defects.
Tokens from different tokenizers/reporting conventions require care; unknown is not zero.
Separate model/tool/adapter/infrastructure failures and retain all failed runs.

Grade final patches in clean environments with protected tests; inspect unnecessary edits
and validation claims. Store sanitized full traces, configuration fingerprints, prompts,
versions and run manifests outside this planning PR; publish a compact result table and
artifact references in a later evaluation PR. Report paired task outcomes and uncertainty,
not just a winner from one task. Do not hill-climb on the evaluation set without a
separate held-out confirmation set.

## Deployment and rollback

This PR requires no environment variables, dependencies, migration, runtime deployment
or service restart. Later implementation needs pinned external CLI versions on the
Kanban host and per-agent endpoint/model configuration. No new agent becomes the default.
Rollback consists of disabling selection for the affected agent while preserving task
history and existing agents; failed runs must remain diagnosable.
