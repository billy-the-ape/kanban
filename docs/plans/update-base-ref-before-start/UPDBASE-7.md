# UPDBASE-7 — Checkbox in backlog editing and creation surfaces

Master plan: `PLAN.md`, section "User experience and persistence" (items 1–4, 7). Second
implementation PR (with UPDBASE-7 … UPDBASE-9).
Depends on: UPDBASE-0 (persisted field) **and** the merged runtime PR (UPDBASE-0 … UPDBASE-6)
— do not merge a UI that promises refresh before runtime support exists.
Blocks: UPDBASE-8.

## Purpose

Expose the persisted `updateBaseRefBeforeStart` policy in every UI surface that already
exposes the Worktree base ref selector: backlog task editing, inline creation, multi-create,
and child creation. An explicit `false` must reach the server unchanged on every path.

## Re-verify before starting (code moves)

- `web-ui/src/hooks/use-task-editor.ts` loads and saves `baseRef`; the editor closes when the
  task leaves backlog.
- Creation surfaces: `web-ui/src/components/task-create-dialog.tsx` and
  `web-ui/src/components/task-inline-create-card.tsx` (task options including the base
  selector); multi-create and child creation follow the same board-mutation inputs.
- UI conventions: Radix `Checkbox`, `@/components/ui` primitives, Tailwind v4 design tokens,
  dark theme only, `cn()` for conditional classes.

## Implementation

1. Backlog task editing: an accessible checkbox **Update base ref before starting** directly
   below the Worktree base ref selector, with the optional helper text: “Fetch origin and
   fast-forward the base branch before creating this task's worktree.”
	- Load the persisted (normalized) value; changing the selected branch must **not** reset
	  the checkbox.
	- For already-started tasks — including those returned to backlog — hide or disable the
	  control with a short explanation that the initial-start baseline is fixed; the saved value
	  is untouched.
2. Creation surfaces: default the checkbox to **checked** in inline creation, multi-create,
   and child creation (and any other surface that exposes the base selector).
3. Persistence: on every save/create path an unchecked box sends an explicit `false` (never
   an absent field); a checked box sends `true`. This is a persisted task property — not a
   browser-only preference, and no truthy fallback may be introduced in the client.

## Tests

- `web-ui/src/hooks/use-task-editor.test.tsx` (extend): loads the stored value; save sends
  explicit `false` when unchecked; changing the base ref does not reset the checkbox; the
  control is hidden/disabled (and the saved value untouched) for started tasks.
- Create dialog / inline card / multi-create / child creation tests: default checked; an
  unchecked submit sends `false` in the mutation input.
- Component assertions: placement directly below the base selector, label association
  (accessible name), helper text present.

## Verification

```sh
npx @biomejs/biome check web-ui/src
npm run web:typecheck && npm run web:test
```

## Acceptance criteria

- Explicit `false` reaches the server unchanged on every UI save/create path; new tasks
  default to checked.
- Started tasks cannot change the policy from the UI.
- No refresh progress or failure rendering in this task (that is UPDBASE-8).

## Stop conditions

- A creation surface has no base selector and no natural home for the option — record it as an
  intentional gap matching PLAN.md ("corresponding creation forms that already expose the base
  selector"); do not invent a new surface.
- The editor's load/save shape cannot carry the field without a contract change — stop and
  flag it; the field is UPDBASE-0's scope.
