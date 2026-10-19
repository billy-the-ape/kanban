This file captures tribal knowledge-the nuanced, non-obvious patterns that make the difference between a quick fix and hours of debugging.
When to add to this file:
- User had to intervene, correct, or hand-hold
- Multiple back-and-forth attempts were needed to get something working
- You discovered something that required reading many files to understand
- A change touched files you wouldn't have guessed
- Something worked differently than you expected
- User explicitly asks to add something
Proactively suggest additions when any of the above happen-don't wait to be asked.
What NOT to add: Stuff you can figure out from reading a few files, obvious patterns, or standard practices. This file should be high-signal, not comprehensive.

---

TypeScript principles
- No any types unless absolutely necessary.
- Check node_modules for external API type definitions instead of guessing.
- Prefer SDK-provided types, schemas, helpers, and model metadata over local redefinitions. For things like Cline SDK reasoning settings, use the SDK's source of truth whenever possible instead of recreating unions, support checks, or shapes in Kanban.
- NEVER use inline imports. No await import("./foo.js"), no import("pkg").Type in type positions, and no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies. Upgrade the dependency instead.
- In async code, a `const x = await ...; if (x === null) { fail(); }` narrowing does NOT survive a later `await` (TS resets it), so passing `x` (narrowed to non-null) to a function after another await is a type error. Use `const x = (await ...) ?? fail();` (where `fail(): never`) to keep the value non-null across awaits.

Code quality
- Use `npm run format` first whenever lint or formatting is a concern, and only fix whatever remains after.
- Tool parameter inputs, especially editor, should be kept below 5000 characters
- Write production-quality code, not prototypes
- Break components into small, single-responsibility files. 
- Extract shared logic into hooks and utilities. 
- Prioritize maintainability and clean architecture over speed. 
- Follow DRY principles and maintain clean architecture with clear separation of concerns.
- In `web-ui`, prefer `react-use` hooks (via `@/kanban/utils/react-use`) whenever possible
- Before adding custom utility code, evaluate whether a well-maintained third-party package can reduce complexity and long-term maintenance cost.

Architecture opinions
- Avoid thin shell wrappers that only forward props or relocate JSX for a single call site.
- Prefer extracting domain logic (state, effects, async orchestration) over presentation-only pass-through layers.
- Do not optimize for line count alone. Optimize for codebase navigability and clarity.

Git guardrails
- NEVER commit to main unless user asks.

GitHub issues
When reading issues:
- Always read all comments on the issue.
- Use this command to get everything in one call:
  gh issue view <number> --json title,body,comments,labels,state

When closing issues via commit:
- Include fixes #<number> or closes #<number> in the commit message. This automatically closes the issue when the commit is merged.

web-ui Stack
- Kanban web-ui uses Tailwind CSS v4 for styling, Radix UI for accessible headless primitives, and Lucide React for icons.
- Custom UI primitives live in `src/components/ui/` (button, dialog, tooltip, kbd, spinner, cn utility).
- Toast notifications use `sonner`. Import `{ toast }` from `"sonner"` or use `showAppToast` from `@/components/app-toaster`.

Styling mental model
- Use Tailwind utility classes as the primary styling system. Prefer `className` over inline `style={{}}`.
- Prefer Tailwind classes over adding custom CSS in `globals.css` when possible. Conditional Tailwind classes via `cn()` are better than CSS overrides for state-driven styling (e.g. selected/active variants). Reserve `globals.css` for things Tailwind can't express: complex selectors (sibling combinators, attribute selectors), app-level layout glue, or styles that genuinely need to cascade.
- Only use inline `style={{}}` for truly dynamic values (colors from props/variables, computed positions from drag-and-drop, runtime-dependent dimensions).
- The design system tokens are defined in `globals.css` inside `@theme { ... }`. Use Tailwind utilities that reference them: `bg-surface-0`, `text-text-primary`, `border-border`, etc.

Design tokens (defined in globals.css @theme)
- Surface hierarchy: `surface-0` (#1F2428, app bg / columns), `surface-1` (#24292E, navbar / project col / raised), `surface-2` (#2D3339, cards/inputs), `surface-3` (#353C43, hover), `surface-4` (#3E464E, pressed/scrollbars)
- Borders: `border` (#30363D, default), `border-bright` (#444C56, more visible), `border-focus` (#0084FF, focus rings)
- Text: `text-primary` (#E6EDF3), `text-secondary` (#8B949E), `text-tertiary` (#6E7681)
- Accent: `accent` (#0084FF), `accent-hover` (#339DFF)
- Status: `status-blue` (#4C9AFF), `status-green` (#3FB950), `status-orange` (#D29922), `status-red` (#F85149), `status-purple` (#A371F7), `status-gold` (#D4A72C)
- Border radius: `rounded-sm` (4px), `rounded-md` (6px), `rounded-lg` (8px), `rounded-xl` (12px)

UI primitives (src/components/ui/)
- `Button` from `@/components/ui/button`: `variant="default"|"primary"|"danger"|"ghost"`, `size="sm"|"md"`, `icon={<LucideIcon />}`, `fill`, children for text content.
- `Dialog`, `DialogHeader`, `DialogBody`, `DialogFooter` from `@/components/ui/dialog`: For modals. `DialogHeader` takes a `title` string.
- `AlertDialog`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`, `AlertDialogCancel` from `@/components/ui/dialog`: For destructive confirmations.
- `Tooltip` from `@/components/ui/tooltip`: `<Tooltip content="text"><trigger/></Tooltip>`.
- `Spinner` from `@/components/ui/spinner`: `size` (number), `className`.
- `Kbd` from `@/components/ui/kbd`: Keyboard shortcut display.
- `cn` from `@/components/ui/cn`: Utility for conditional className joining.

Icons
- Use `lucide-react` for all icons. Import individual icons: `import { Settings, Plus, Play } from "lucide-react"`.
- Standard icon sizes: 14px for small buttons, 16px for default contexts.
- Pass icons as JSX elements to button `icon` prop: `icon={<Settings size={16} />}`.

Radix UI primitives
- Use Radix directly for headless behavior: `@radix-ui/react-popover`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-checkbox`, `@radix-ui/react-switch`, `@radix-ui/react-collapsible`, `@radix-ui/react-select`.
- Style Radix components with Tailwind classes. Use `data-[state=checked]:` for state-driven styling.

Dark theme
- The app is always in dark theme. Colors are set via CSS custom properties in `globals.css`.
- Surface hierarchy: `bg-surface-0` (app background) -> `bg-surface-1` (raised panels) -> `bg-surface-2` (cards/inputs) -> `bg-surface-3` (hover) -> `bg-surface-4` (pressed).
- Do NOT use Blueprint, Tailwind's light-mode defaults, or any `dark:` prefix. The theme is always dark.

Misc. tribal knowledge
- Native Cline summaries and terminal summaries have different live owners. The terminal manager also hydrates saved Cline records, so its `running` flag alone is not liveness. Use `resolveWorkspaceSessionSummaries` for workspace snapshots/saves: it reconciles orphaned records and prefers the current Cline owner. Do not overlay every terminal summary onto current Cline state; an old pre-pause record can otherwise lock a completed card after reload.
- The repo's formatter is Biome (`biome.json`: tabs, 120 cols). This fork does not install or run repository-managed pre-commit checks; validate formatting before committing and leave automated validation to CI. There is no Prettier config — running `prettier --write` (default 2-space/80 cols) mangles tabs and line wrapping across whole files. If a file was accidentally prettier-formatted, restore it with `npx biome check --write <files>`, not Prettier.
- Kanban's native Cline agent is powered by the installed `@clinebot/core` and `@clinebot/shared` packages plus the local `src/cline-sdk/` boundary layer, so when Cline behavior is unclear, inspect those packages and `src/cline-sdk/` for the real implementation details.
- Kanban is launched from the user's shell and inherits its environment. For agent detection and task-agent startup, prefer direct PATH checks and direct process launches over spawning an interactive shell. Avoid `zsh -i`, shell fallback command discovery, or "launch shell then type command into it" on hot paths. On setups with heavy shell init like `conda` or `nvm`, doing that per task can freeze the runtime and even make new Terminal.app windows feel hung when several tasks start at once. It's fine to use an actual interactive shell for explicit shell terminals, not for normal agent session work.
- If CI hangs on Node 22 after tests seem to finish, suspect a live subprocess or SDK-host startup path before assuming a slow test body. Read `.plan/docs/node22-ci-hanging-tests-investigation.md` before repeating that investigation. `test/runtime/cline-sdk/cline-task-session-service.test.ts` was the big prior culprit because a unit-style suite was still booting the real Cline SDK host.
- When Kanban runs on a headless remote Linux instance (for example over SSH+tunnel), native folder picker commands may be unavailable (`zenity`/`kdialog`). Treat this as a normal remote-runtime limitation and use manual path entry fallback instead of requiring desktop packages.
- Git refs are files in a hierarchy, so `refs/kanban/tasks/<id>` and `refs/kanban/tasks/<id>/<anything>` can never both exist ("cannot lock ref ... exists"). The B-5 preservation ref already owns `refs/kanban/tasks/<id>` (kept current while a worktree lives), so new per-task refs need their own namespace (e.g. B-8 uses `refs/kanban/delivery/<id>`). Git tests that never create the preservation ref will not catch a collision.
- Tests that touch workspace state, task worktrees, delivery receipts, or dispatch records must redirect `process.env.HOME` (and `USERPROFILE`) to a temp dir in `beforeEach` and restore it in `afterEach` — those paths resolve through `os.homedir()` at call time (`getTaskWorktreesHomePath()`/`getWorkspacesRootPath()`), so without isolation tests write into the user's real `~/.cline/` and leak state between runs (a leftover `exhausted` dispatch record silently changes later assertions). Verify with `ls ~/.cline/worktrees ~/.cline/kanban/workspaces` after a run. Task worktrees live at `~/.cline/worktrees/<taskId>/<repoFolderLabel>` (nested), not `~/.cline/worktrees/<taskId>`. Mocking the board or session services does not exempt a suite from this: runtime API helpers like `gatherTaskDiagnosticsCore` still perform real reads of dispatch records, delivery receipts, and preservation state under `os.homedir()`, and replacing an old suite with a narrower one (e.g. a write mutation → read-only plan method) must carry the HOME isolation over.
- `moveTaskToColumn` (src/core/task-board-mutations.ts) returns a result object (`{ moved, board, task, ... }`), not a board — a common mistake is passing the result directly where a board is expected, which then fails zod validation on the next read ("columns: expected array, received undefined"). Similarly, `mutateWorkspaceState<void>(cwd, ...)` returns a response object, so a dep typed `Promise<void>` needs an `async` wrapper.
- `test/runtime/trpc/projects-api.test.ts` ("resolves clone destination relative to serverCwd") shells out to a real `git clone https://example.com/repo.git` and expects it to fail fast. On networks that silently hang the connection instead of rejecting it, the test times out at 15s. It's environment-dependent, not a regression — verify with `git status` on the test and its code under test before debugging.
- `test/runtime/server/middleware.test.ts` ("handleSocketUpgrade passes through upgrades whose Host and Origin are both allowed") compares against `getAllowedHostHeaders()`, which is computed at runtime from `getKanbanRuntimeHost()`/`getKanbanRuntimePort()` (i.e. the ambient `KANBAN_HOST`/port env). In sandbox shells where those resolve to something other than `127.0.0.1:3484`/`localhost:3484`, the test fails even on an unmodified tree — environment-dependent, not a regression.
- In this sandbox, GNU tar 1.35 **extraction that creates files** fails with `tar: <file>: Cannot open: Function not implemented`: the container kernel returns ENOSYS for `openat2(..., RESOLVE_BENEATH)`, which GNU tar uses when extracting under an existing directory. The B-5 archive fallback (`extractTaskWorktreeArchive` in src/workspace/task-preservation.ts) therefore cannot succeed here, and `test/integration/task-worktree.integration.test.ts` ("resumes a trashed task from the preserved snapshot when the saved patch is invalid") fails even on a pristine HEAD. Environment-dependent, not a regression — confirm with `strace -e trace=openat2` before debugging the preservation code.
- In this environment, tool call commands are killed after ~30s along with their whole process group, so a bare `npx vitest run ... > log 2>&1 &` background run dies with the caller. To run suites longer than 30s, launch fully detached — `setsid bash -c '<cmd> > /tmp/x.log 2>&1; echo EXIT=$? >> /tmp/x.log' < /dev/null > /dev/null 2>&1 &` — then poll the log file from separate short commands. Integration suites (e.g. `test/integration/runtime-state-stream.integration.test.ts`) take ~30-60s, so never expect them to fit one call.
- CI's `build-check-test` run has intermittent single-test flakes unrelated to the PR diff: integration suites can fail at server startup with "Failed to start Kanban: Lock file is already being held" under parallel load, and `test/runtime/core/task-diagnostics-export-artifacts.test.ts` ("classifies a multi-MB document by streaming") can blow its 15s timeout on a loaded runner. Before debugging a red CI on a PR branch, identify which file failed and run that file locally — if it passes locally and the diff doesn't touch it, treat it as a flake and re-run the run instead.
- Fresh Kanban task worktrees in this fork ship without `node_modules`; run `npm install` before typechecks or vitest, and expect `tsc`/`vitest` to be absent until then.
- `web-ui/src/runtime/types.ts` is just `export type * from "@runtime-contract"` (src/core/api-contract.ts). When you add a required field to a contract response (e.g. `reliableCompletion` on `RuntimeConfigResponse`), tsc catches only the uncast test mocks; mocks built with `as unknown as RuntimeConfigResponse` bypass typechecking and crash at render time instead — grep for every factory building the response, not just the tsc error list.
- The local-mode compaction `beforeModel` hook (src/cline-sdk/cline-compaction-before-model-hook.ts) only rewrites the outgoing request; the SDK keeps the full `state.messages`. So once a session exceeds the budget, compaction re-runs from scratch over the whole history on **every** model call, and anything it drops is invisible to the model for the rest of the session. A compactor that over-trims (the original assistant-first strategy dropped everything but the last step) produces a looping agent that "rediscovers" its own edits, not an error. Judge compaction changes by what survives on a realistic tool-call/tool-result history (see the turn-based regression tests), not by whether the result fits the budget.
- Avoid using non-null assertions, even within test files. They are forbidden by the linter.
- In `@clinebot/core` 0.0.38 local mode, `start()` creates a live session but the durable record is created only on the first `send()`. Calling `update()` before that returns `{ updated: false }`. Seed restart-critical metadata through `start({ sessionMetadata })`; tests that persist the record immediately in fake `start()` conceal this defect.
- `lockedFileSystem.withLock` (src/fs/locked-file-system.ts) wraps proper-lockfile, which keys its in-process `locks` map by the resolved `path` argument — NOT by `lockfilePath`/`lockfileName`. Two `LockRequest`s that share a `path` but differ only in lockfile collide: the second acquisition overwrites the first's in-process entry, and releasing one marks the other "already released" (`Lock is already released` / `ENOTACQUIRED` + `ECOMPROMISED`), leaving a window where neither lockfile is protected. Give each distinct lock a distinct `path` (see `getTaskBaseRefreshLock` vs `getTaskWorktreeSetupLock` in src/workspace/task-worktree.ts); the on-disk lockfile name can still be controlled separately via `lockfilePath`.
- Git hooks export repository-routing environment variables. A test subprocess can modify the real checkout even with a temporary `cwd` or `git -C`; use `createGitTestEnv()` for every fixture Git subprocess. The October 2026 pre-commit run leaked the B27 fixture commit into a task branch; a disposable hook reproduction also changed the shared `core.bare` through `git init --bare`. Removing the hook avoids that trigger but does not repair unsanitized tests or make manual test execution under a contaminated environment safe.
- Under vitest fake timers, `vi.advanceTimersByTimeAsync(bigInterval)` only sweeps the fake clock — it does NOT run real fs I/O, so async chains that await `fs.promises` make zero progress during a big advance and only resume when the test yields the event loop in small clock steps. This bites hard with `proper-lockfile` (see `lockedFileSystem`): its retry backoff (25ms × 200) is scheduled via faked `setTimeout`, so two overlapping lock acquisitions on the same `path` either resolve only after you advance ~5s of fake time or hang forever (manifesting as "Hook timed out" in `afterEach` waiting on a stuck in-flight job). The pattern that works (see `settle()` in `test/runtime/pr-tracking/pr-tracking-coordinator.test.ts`): after each large advance, flush with ~120 × `await vi.advanceTimersByTimeAsync(25)` so fs ops and lock retries progress; keep that window below the smallest real timer interval (60s poll) so no extra ticks fire; and never overlap two store operations on the same lock `path` without a settle in between. Also expect fake-clock drift: a poll cycle completes a few settle steps after its timer fires, so assert cadence/backoff with bounded tolerances (±one settle window), not exact timestamps.
- A single fixed `settle()` window is not enough under parallel vitest load: when an assertion depends on a background path that does real lockfile I/O (e.g. the coordinator's startup orphan classification in `test/runtime/pr-tracking/pr-tracking-coordinator.test.ts`), poll with a `waitFor(probe)` loop (advance a settle window until the observable effect appears) instead of asserting right after one settle. This flake showed up only in the full-suite run, never standalone.
- Git object-existence probes: `git rev-parse --verify <40-hex>` SUCCEEDS for a well-formed SHA even when the object does not exist locally (it only validates rev syntax); use `git cat-file -e <sha>` to check existence. Related: after a squash or rebase merge, the PR's original commits are NOT ancestors of the landed commit, so a plain `rev-list --count base..HEAD` count reads the merged work itself as "local commits" — exclude the merged PR head with `rev-list base..HEAD --not <headSha>` (and treat a missing/unfetchable head as unverifiable-retry, never a guessed block; see `defaultInspectWorktree` in src/pr-tracking/pr-merge-completion.ts and its real-git matrix test).
- `useTrpcQuery` (web-ui/src/runtime/use-trpc-query.ts) re-fires its query effect whenever `queryFn` identity changes, and an inline arrow `queryFn` changes identity every render — combined with the `isLoading` true/false toggling that loops the effect forever (an infinite query loop that surfaces in vitest as a 5s test timeout, not an obvious render error). Always pass a `useCallback`-memoized `queryFn` (see `use-runtime-config.ts`). Same trap for any hook whose effect deps include a per-render callback.
- A new `@runtime-*` alias for web-ui must be registered in THREE places: `web-ui/tsconfig.json` (`paths`), `web-ui/vite.config.ts` (`resolve.alias`), and `web-ui/vitest.config.ts` (its own separate alias list). Missing the vitest one makes tsc and `vite build` pass but component tests fail with "Failed to resolve import".
- During long tasks, the worktree's base branch can be refreshed under a running session (files on disk change: `old_text` suddenly mismatches, grep hits content that shouldn't be there, mtimes newer than your edits). If an edit that used to match stops matching, check `stat`/`git log` on the file before retrying — re-read the current version and re-apply your changes on top of it rather than assuming your earlier reads are still valid.
- The browser tab title is owned by `useReviewReadyNotifications` (web-ui/src/hooks/use-review-ready-notifications.ts) via `useDocumentTitle`, not App.tsx — format `(N) <body>` where the pending-count prefix comes from review-ready events and `<body>` is the workspace path's last segment (or "Kanban"); when a task detail is open, App passes `selectedTaskTitle` so the body becomes `<task title> • <project>`.
