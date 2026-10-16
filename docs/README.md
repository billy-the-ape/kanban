# Engineering Docs

This folder is the starting point for engineers working on Kanban itself.

This follows the usual split a small engineering team would want:

- `README.md` explains the product, local setup, and everyday usage.
- `docs/` holds stable onboarding and architecture references for humans.
- `.plan/docs/` holds active plans, handoffs, and deeper change-history context for larger refactors.

If you are new to the codebase, read these in order:

1. [`../README.md`](../README.md) for the product overview and local setup.
2. [`architecture.md`](./architecture.md) for the system map, runtime model, and key file guide.

Runtime topic references:

- [`runtime/pr-comment-execution.md`](./runtime/pr-comment-execution.md) — approval filtering, execution-time refresh, Git blockers, and bounded feedback batches
- [`runtime/cline-concurrency.md`](./runtime/cline-concurrency.md) — model-aware Cline task concurrency limits and admission
- [`runtime/diagnostics-export.md`](./runtime/diagnostics-export.md) — the task diagnostics download: what the bundle contains, completeness semantics, and the browser/CLI transport
- [`runtime/editor-recovery.md`](./runtime/editor-recovery.md) — editor tool failure recovery and file state handling
- [`runtime/editor-trace.md`](./runtime/editor-trace.md) — editor trace event contract and consumer behavior

Operational references:

- [`deployment/ai-monster.md`](./deployment/ai-monster.md) — deploying releases to the ai-monster host through the manual GitHub Actions workflow

Completed plan archives live in [`plans/complete/`](./plans/complete/) and are preserved for history.

This `docs/` folder should stand on its own for normal onboarding. Active plans and handoffs may still exist in `.plan/docs`, but a new engineer should not need those to understand the current architecture.

When adding new engineering docs, prefer putting stable explanations here and linking them from this index.
