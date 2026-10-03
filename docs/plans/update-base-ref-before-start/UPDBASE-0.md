# UPDBASE-0 — Persist the `updateBaseRefBeforeStart` task policy

Master plan: `PLAN.md` (feature **Update task base ref before starting**). This is task 0 of the
UPDBASE series (UPDBASE-0 … UPDBASE-9). UPDBASE-0 through UPDBASE-6 form the first implementation
PR (runtime); UPDBASE-7 through UPDBASE-9 form the second (UI).
Depends on: nothing — first task in the series.
Blocks: every other UPDBASE task (the persisted policy is what the runtime refresh and the UI
checkbox both read).

## Purpose

Add the backward-compatible per-task boolean `updateBaseRefBeforeStart` and carry it through the
API contract, board mutations, CLI/API inputs, automated task creation, and web-ui type/normalization
parity. Absent values normalize to `true`; an explicit `false` must survive save, reload, and board
serialization. This task ships the persisted field only — no rendered UI, no Git behavior change.

## Re-verify before starting (code moves)

- Task create/update inputs are validated in `src/core/task-board-mutations.ts` (`baseRef` is
  required and trimmed); the persisted card schema lives in `src/core/api-contract.ts`.
- `web-ui/src/types/board.ts` and `web-ui/src/state/board-state.ts` carry the task fields and
  normalization; `web-ui/src/runtime/types.ts` re-exports the contract.
- Automated creation paths: `src/task-dispatch/task-dispatch-service.ts` (dependency dispatch),
  review follow-up creation, and child task creation all build board mutation inputs.
- CLI task inputs: `src/commands/task.ts`.

## Conventions (AGENTS.md — must follow)

- Biome (tabs, 120 cols) via `npx @biomejs/biome check`; **no Prettier**. No `any`, no non-null
  assertions, no inline imports.
- `web-ui/src/runtime/types.ts` re-exports the contract. Keep the on-card field **optional**; a
  required contract field would crash uncast test mocks (`as unknown as ...`) at render time
  instead of failing tsc. Grep the web-ui for mock card factories after the change.

## Implementation

1. Contract (`src/core/api-contract.ts`):
	- Card schema: `updateBaseRefBeforeStart: z.boolean().optional()` (legacy boards carry no key).
	- Task create/update inputs: accept `z.boolean().optional()`. Zod `.default(true)` on the
	  create input is acceptable — `.default` fires only for `undefined`, so an explicit `false`
	  survives. For **update** inputs, an omitted field must leave the stored value untouched
	  (do not re-default on edit).
	- One shared read-side normalizer, e.g. `normalizeUpdateBaseRefBeforeStart(value): boolean`
	  (undefined → `true`), used everywhere a policy decision is made. Never a truthiness fallback
	  (`!!value`, `value || true`) — the field's whole point is that `false` is meaningful.
2. Board mutations (`src/core/task-board-mutations.ts`):
	- `createTask`: store the normalized boolean (absent input → `true`).
	- `updateTask`: store an explicit `true`/`false`; omit → no change.
3. Creation path defaults (all default to `true` when absent, per PLAN.md — same default for
   inline creation, multi-create, CLI/API creation, and automatically created tasks):
	- CLI (`src/commands/task.ts`) and the tRPC/API create inputs.
	- Automated: `task-dispatch-service.ts`, review follow-ups, child creation (do **not** inherit
	  the parent's value; default is `true`).
4. Web-ui parity (no UI rendering in this task): update `web-ui/src/types/board.ts` and
   `board-state.ts` normalization so the client type and state normalization match the server
   (absent → `true`, explicit `false` preserved).

## Tests

- Board mutation tests (`test/runtime/task-board-mutations.test.ts` or the matching suite):
	- Create without the field → stored `true`; create with explicit `false` → stored `false`.
	- Update with `false` → stored `false`; update with `true` → stored `true`; update omitting
	  the field → stored value unchanged.
- Serialization round-trip: a legacy card without the key reads as `true` through the normalizer;
  an explicit `false` survives persist → reload → re-serialize.
- Default checks for CLI/API create and automated creation (dispatch, review follow-up, child).
- Web-ui: board-state normalization covers absent → `true` and `false` preserved.

## Verification

```sh
npx @biomejs/biome check src test
npm run typecheck
npm run test:fast
npm run web:typecheck && npm run web:test
```

## Acceptance criteria

- A new task with no input stores `updateBaseRefBeforeStart: true`; explicit `false` stores `false`.
- Explicit `false` survives every path: mutation → `board.json` persistence → reload →
  serialization → web-ui state, for inline, multi-create, CLI/API, dispatch, review follow-up,
  and child creation.
- The normalizer is the only undefined → `true` site; no truthy fallback exists anywhere.
- No user-visible behavior change; no Git command is introduced.

## Stop conditions

- A shared input schema turns out to merge create and update in a way that cannot distinguish
  "field omitted" from "explicit `false`" — stop and record the design decision instead of
  silently re-defaulting on edit.
