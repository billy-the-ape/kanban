# Agent reliability implementation plans

Status: planned. Each `AR-N.md` is one implementation task and one PR into `main`.
This planning PR changes documentation only. Merge it before creating implementation tasks.

## Objective and quality boundary

Improve successful completion through implementation, review repair, and publication.
Reduce avoidable failed calls, repeated planning, unnecessary reruns, and context growth
without weakening investigation, testing, review, or the existing safety boundaries.
Shorter output is a secondary result, not the success criterion.

The nine-task study is summarized in [EVIDENCE.md](./EVIDENCE.md). Observations are
historical; filenames and integration points below were inspected at main commit
`fbb5665369f6110ede676a65b7e7dc745cd7c92c` on 2026-10-16. Recheck current code before
implementation. Historical defects are not evidence that the deployed version still has them.

## Tasks, order, and scope

| Plan | One-PR implementation | Main change | Dependencies |
| --- | --- | --- | --- |
| [AR-1](./AR-1.md) | Correct recorded diagnostics and evidence classification | Reducer/export code | None; implement first for a trustworthy baseline |
| [AR-2](./AR-2.md) | Enrich failed-editor feedback with bounded current-source evidence | Runtime feedback plus reviewed wording | None; evaluate using AR-1 |
| [AR-3](./AR-3.md) | Run long validation commands as owned, observable jobs | Local SDK tool and process lifecycle | None; before AR-7 |
| [AR-4](./AR-4.md) | Encourage proportionate planning and evidence-driven execution | **Primarily existing system-prompt wording** | None; deploy separately from AR-2/AR-3 for comparison |
| [AR-5](./AR-5.md) | Standardize safe publication wording in native coding sessions | **Primarily existing publication prompting** | None; existing Auto-PR behavior is the reference |
| [AR-6](./AR-6.md) | Bind review completion to the current turn and trustworthy change set | Review orchestration/handoff | None; before AR-7 |
| [AR-7](./AR-7.md) | Show compact, evidence-linked recovery episodes and comparison metadata | On-demand diagnostics API/UI | AR-1, AR-3, AR-6 |

Suggested sequence: AR-1, AR-2, AR-3, AR-4, AR-5, AR-6, AR-7. Independent tasks
may be implemented separately, but deploy one behavior change at a time when measuring
its effect. Do not automatically create or start all tasks as part of this planning PR.

AR-4 and AR-5 contain the exact proposed prompt additions. AR-2 and AR-3 also include
small model-facing feedback/capability messages; review those before implementation.
All wording is proposed, not already applied. User instructions and repository rules
remain authoritative. Avoid adding a second contradictory instruction block.

## Shared implementation contract

- Read this index, the selected task, relevant current code, and applicable `AGENTS.md`.
  Implement only that task; update its status, files changed, tests, and deployment notes.
- Preserve existing approvals, review write/publication restrictions, cancellation,
  worktree isolation, and PR feedback publication attribution. Do not silently repair
  malformed model input, apply fuzzy edits, auto-replay writes, or suppress failed checks.
- Keep native Cline local-hook changes isolated from terminal agents and hub-backed
  sessions. An unsupported capability must not be advertised to the model.
- Use the SDK boundary and installed public types. Never patch `node_modules` or create
  a parallel SDK integration. Extend existing summaries, artifacts, and hooks.
- Preserve historical interpretation: unknown is not zero; a pipeline tag is not a
  confirmed failure; reported tokens are not necessarily the retained text length.
- Run the relevant focused tests plus backend/frontend typechecks where affected and
  repository-required checks. Format changed supported files with Biome; Markdown is
  outside the inspected Biome include patterns, so check links, whitespace, and fences.
- Every implementation PR description must prominently state deployment/settings,
  migration needs, features, exact verification commands/results, and a short manual
  smoke test for each feature. No hardware/model/server setting changes are authorized
  by these plans. If later requested, add the homelab-documentation update task.

## Evaluate conservatively

Capture a baseline after AR-1 using completed tasks with comparable scope, actual
recorded model/provider, prompt fingerprint, SDK/tool version when available, and known
concurrency. Retain original exports outside the repository. Compare completion,
review findings/repairs, observed failures/retries, recorded spans, output tokens,
peak input, and available compaction records. Inspect adverse cases manually.
Do not claim causality or a fixed percentage saving from this selected sample.

Scripted prompt/tool tests prove contracts and delivery, not model quality. Supplement
them with several ordinary tasks, including a complex task and a review-repair task.
If a prompt change reduces necessary investigation, testing, or review quality, roll it
back or revise it even if output tokens fall. Each prompt PR must be independently revertible.

## Deferred deliberately

- Sampling, reasoning effort/budget, context limits, preserved reasoning, and hardware
  settings: establish effective request settings and a stable wrapper baseline first.
- Compact successful editor diffs: investigate the SDK's displaced-line output before
  rewriting it. Preserve full evidence; do not fabricate a diff from guessed preimages.
- A dashboard, cross-project database scan, background transcript analysis, automatic
  LLM classification, efficiency score, automatic task splitting, or harsher retry limits.
- Raw provider-response capture: current parsed input cannot establish what was generated
  before parsing. A future bounded telemetry design needs its own explicit scope.

## Deployment for this planning PR

Documentation only. No runtime deploy, environment variables, migrations, new
dependencies, device changes, or service restart. Implementation PRs follow their own
deployment sections; this index does not activate any feature.
