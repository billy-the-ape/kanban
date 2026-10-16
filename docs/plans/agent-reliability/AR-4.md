# AR-4: Encourage proportionate planning without reducing investigation

Status: planned. One implementation PR into `main`. Dependencies: none.
Change type: **primarily improve existing prompting**. Review the exact wording below.
Read [README.md](./README.md) and [EVIDENCE.md](./EVIDENCE.md).

## Outcome

The coding agent gathers sufficient context, makes a plan proportional to the work,
and implements it. It revisits the plan when evidence changes instead of repeatedly
announcing a new final plan with the same content. Complex work can still require
extended analysis, design decisions, experiments, and additional source reads.

## Current integration points and constraint

- `src/cline-sdk/sdk-runtime-boundary.ts`: `resolveClineSdkSystemPrompt` calls the SDK's
  default prompt builder and appends editor guidance. This is the coding-session path.
- `src/cline-sdk/cline-task-launch-config.ts`: launch prompt persistence/restart behavior.
- `src/cline-sdk/review-prompt.ts` is a separate bounded-review role; preserve its mandate.
- `src/prompts/append-system-prompt.ts` is the sidebar board-management role. Do not put
  coding/execution instructions there or weaken its role restriction.

Historical prompts explicitly said the initial plan could be quite long. Inspect the
installed SDK's actual generated prompt, repository rules, and current composition
before modifying it. Do not replace the whole SDK prompt or patch package files.

## Proposed wording

```text
Planning and execution:
Gather enough context to understand the requirements, relevant code, risks, and verification before editing. State an implementation plan proportional to the task. Expand the plan when complexity or uncertainty warrants it, including design decisions and experiments needed for correctness.

Once the plan is sufficient, proceed with implementation and verification. Revisit it when new evidence changes the approach, requirements, or risk. Avoid restating an unchanged plan; use brief progress updates to explain what changed and what comes next. Follow explicit user requests for planning, and preserve all required checks and review steps.
```

This is guidance about repeated communication and execution, not a cap on internal
reasoning. No word/token/turn limits, mandated first-edit deadline, forced one-plan
rule, ban on rereads, weaker verification, or reasoning-effort/budget changes.

## Required implementation

1. Place this in the native coding prompt composer as one named constant, applied once.
   Keep it separate from tool recovery/publication guidance for review and rollback.
2. Resolve any direct conflict with the SDK's verbose-initial-plan sentence at the
   narrow composition point. Use the SDK-supported customization if available; otherwise
   replace only the inspected exact paragraph with a tested compatibility helper.
   If that expected paragraph changes, preserve the upstream prompt, append the new
   explicit guidance once, and surface the compatibility discrepancy in tests/docs.
   Never regex-delete broad reasoning, verification, approval, or safety sections.
3. Keep explicit plan-mode/user instructions authoritative. Preserve review acceptance
   coverage and sidebar role boundaries. Persist the final composed prompt so exports
   and resumed sessions describe what actually ran. Existing stored launches must not
   be silently rewritten on deployment; use existing new-session semantics.
4. Add focused composition tests for act mode, explicit planning, complex investigation,
   role isolation, duplicate application, and unchanged SDK guardrails. These tests
   verify prompt composition, not that a real model improves.

## Acceptance and evaluation

- Include a literal before/after prompt diff in the implementation PR description.
  List the exact generated sections affected and any compatibility fallback.
- Compare a small task, a complex task, and a review repair against the AR-1 baseline.
  Check acceptance coverage and review defects first, then repeated planning episodes,
  output tokens, peak input, compaction when recorded, and elapsed spans.
- Do not claim all earlier planning time was avoidable, classify every long response as
  waste, or approve the experiment solely because output got shorter. Allow longer
  analysis where it finds a real risk or avoids downstream repair.
- Run focused system-prompt/launch-persistence tests and backend typecheck; format changed
  files. No broad prompt rewrite, sampling changes, or new per-task settings UI.

## Deployment and rollback

No environment variables or migrations. Ordinary deploy; evaluate new native sessions
only, separately from tool changes. Revert this prompt constant/composition change if
quality declines. Retain diagnostic exports and actual prompt fingerprints for comparison.
