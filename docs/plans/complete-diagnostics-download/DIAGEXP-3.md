# DIAGEXP-3 — Download route, browser download, CLI repoint, old-contract removal, and docs

Part of the **complete task diagnostics as a browser download** feature. The master plan
lives in [PLAN.md](./PLAN.md). This document is a self-contained execution brief for the
final wiring PR (slice **DIAGEXP-3**). It represents a single PR.

| Field | Value |
| --- | --- |
| Document revision | 1 |
| Prepared | 2026-10-08 |
| Status | planned; no milestone started |
| Source baseline | `7a64060` (main) |
| Fork | https://github.com/billy-the-ape/kanban |
| Prerequisites | DIAGEXP-1 (extracted auth gate) and DIAGEXP-2 (snapshot + schemaVersion 3 builder + streaming serializer) must be landed |
| Follow-on | Final brief of the feature — manual ai-monster acceptance closes it out |

## Purpose

Replace the host-disk export with a complete JSON download on the user's browser:

- **3a** — a dedicated authenticated HTTP GET on the existing runtime origin,
  `/api/task-diagnostics/download?workspaceId=<id>&taskId=<id>`, dispatched in
  `runtime-server.ts` after the DIAGEXP-1 gate function and before the unmatched-`/api/`
  404.
- **3b** — browser download: fetch → Blob → object URL → temporary anchor click, with an
  exporting state, duplicate-start rejection, and actionable errors.
- **3c** — CLI repoint: `kanban task export-diag` streams the same route to a required
  `--output` file instead of writing to `~/.cline/kanban/diagnostics`.
- **3d** — removal of the write-to-host export contract in the same commit.
- **3e** — documentation.

The download contains task content and can contain secrets printed by tools. Put a short
persistent caption next to the export action: "Includes the full conversation, system
prompt, and tool inputs, outputs, and errors. Review before sharing." Do not add a
confirmation dialog or a second redacted export mode. Do not include provider credentials,
raw environment dumps, passcode state, or arbitrary files outside the task's recorded
evidence.

## Fixed decisions carried in from the master plan

These are settled. Implementation may choose local helper names and file layout, but not
the architecture or product rules.

1. **Format/transport.** A single UTF-8 JSON file (schemaVersion 3, built and streamed by
   DIAGEXP-2), filename `task-<safeTaskId>-<timestampMs>.json`, served as
   `Content-Type: application/json; charset=utf-8`,
   `Content-Disposition: attachment; filename="..."`, `Cache-Control: no-store`. Sanitize
   only the download filename; preserve the task ID in the bundle.
2. **Auth.** Transport is an authenticated GET on the existing runtime origin, dispatched
   **after** the inline passcode/session/bearer gate (now the DIAGEXP-1 shared function,
   `runtime-server.ts:452-477` pre-extraction) and **before** the unmatched-`/api/` 404
   (`:493`). Browser authentication is the `SameSite=Strict; HttpOnly` session cookie,
   sent automatically for same-origin requests; in every supported topology the browser is
   same-origin (prod serves the UI from the runtime origin, dev uses the
   `web-ui/vite.config.ts` proxy), so no `Access-Control-Expose-Headers` requirement is
   needed — the client builds the filename from `taskId` and does not depend on reading
   `Content-Disposition`. The internal bearer token stays a CLI-only concern. Do not
   invent a second auth mechanism, put auth tokens in URLs, or allow caller-supplied
   filesystem paths. Never bypass auth in the production route.
3. **Task membership rule.** The task must exist on the scoped workspace board (any
   column, including trash), else a 404 JSON error. Check this before touching the
   filesystem — `taskId` comes from the query string and feeds
   `getTaskContextArtifactsDir` and `buildSessionIdPrefix`
   (`normalizeTaskIdForWorktreePath` only rejects separators and `..`), and
   `gatherTaskDiagnosticsCore` returns `task: null` for unknown ids rather than failing,
   so without this rule the route would happily "export" nonexistent or foreign ids.
   Permanently deleted tasks (sessions cleared by `clearTaskSessions`) also return 404.
4. **Streamed response.** Stream with backpressure; no base64 or whole-bundle tRPC.
   Validate/read the initial snapshot before starting the response so auth, missing-task,
   and initial read errors return a clear non-2xx JSON error. If streaming fails after
   headers, terminate the response; the browser must report failure instead of downloading
   an apparently complete success. Missing historical artifacts are represented as gaps
   (DIAGEXP-2 completeness semantics), not transport failures. Respect backpressure and
   disconnects; no background export continues after cancellation.
5. **Browser download.** Replace the host-path export wrapper with a browser fetch helper:
   `fetch("/api/task-diagnostics/download?workspaceId=…&taskId=…", { credentials: "same-origin" })`.
   There is no "runtime base URL" helper in web-ui (the tRPC client uses the relative
   `/api/trpc`). Check status, await Blob creation, create an object URL, click a
   temporary anchor with the client-built filename, then remove it and revoke the URL
   after download initiation. Preserve an exporting state and reject duplicate export
   starts. Surface actionable errors; do not show a host-path or redaction toast.
   Success text: "Diagnostics download started."
6. **CLI repoint, not removal.** `kanban task export-diag` is the CLI/JSON equivalent of
   the button (B-10.5). Authenticate with the existing `getRuntimeFetch()`
   (`src/core/runtime-endpoint.ts:136`), which already attaches the internal bearer token
   and handles HTTPS, combined with `buildKanbanRuntimeUrl("…")` — the same pair
   `createRuntimeTrpcClient` uses (`task.ts:250`). The command **requires** `--output
   <file>`: `runTaskCommand` prints a `printJson` result record (or
   `{ ok: false, error }`) on every success/failure (`task.ts:1470-1480`), so streaming
   the bundle to stdout would corrupt that scripting surface. Stream to the file, then
   return the normal record `{ ok, outputPath, bytes, completeness }`; on non-2xx or a
   truncated stream delete the partial file and return `ok: false` with a non-zero exit.
   Never write to `~/.cline/kanban/diagnostics`. Update the command description text
   (`task.ts:1801`).
7. **Removal is in the same commit.** Do not leave a hidden disk-writing fallback. Existing
   manually created diagnostic files need not be deleted or migrated.
8. **Read-only export.** The route never sends a model request, starts/restarts a session,
   compacts messages, or changes the board/task (inherited from DIAGEXP-2).
9. **Deploy coupling.** Backend and frontend deploy together (any `main` commit can be
   picked for a manual deploy; `workflow_dispatch`-only workflow). Because the host-path
   export contract is removed, an already-open browser tab running the old UI will see a
   "runtime request error" on Export until it is reloaded — state this in the PR
   description and deployment instructions.

## Scope

Allowed:

- `src/server/runtime-server.ts` — wire the GET handler after the extracted gate function
  and before the unmatched-`/api/` 404.
- A small new server module for the GET download handler (snapshot validation, membership
  check, headers, streaming passthrough into the DIAGEXP-2 writer).
- `src/core/api-contract.ts`, `src/core/api-validation.ts`, `src/trpc/app-router.ts`,
  `src/trpc/runtime-api.ts`, `src/core/task-diagnostics-export.ts` — removals per 3d.
- `src/commands/task.ts` — `taskExportDiagnosticsCommand` (`:1339`) repointed to the GET
  route; `--output` required; registration description updated (`:1800-1801`).
- `web-ui/src/hooks/use-task-diagnostics.ts`, `web-ui/src/runtime/task-diagnostics.ts`,
  `web-ui/src/components/detail-panels/task-diagnostics-panel.tsx` — browser fetch
  helper, Blob/anchor download, exporting state, caption, success/error toasts.
- `docs/runtime/diagnostics-export.md` (new), `docs/README.md` (link),
  `docs/plans/B-10.md:191` and `:201`, `docs/plans/B_IMPLEMENTATION_PLAN.md:528` (B-10.7
  wording updates), CLI help text.
- Tests: `test/runtime/` HTTP composition suite, web-UI jsdom suite.

Explicit non-goals:

- No new environment variables, storage directories, services, or database migration.
- No changes to DIAGEXP-2's snapshot/builder semantics (consume them; fix bugs via a
  recorded gap, not silent behavior changes).
- No second auth mechanism, no tokens in URLs, no caller-supplied paths.
- No ZIP, external upload, or new export modes.
- No Playwright/e2e assertions (see the acceptance notes below).

## Source map (reinspect before editing; baseline is historical)

- `src/server/runtime-server.ts` — `requestHandler`; gate function from DIAGEXP-1
  (pre-extraction inline gate `:452-477`, session cookie `:436-443`, unmatched-`/api/`
  404 at `:493`). The scoped review session service is at `:192` (already threaded for
  DIAGEXP-2's review snapshots).
- `src/server/middleware.ts` — `handleHttpRequest` (`:111`) and origin/host checks run
  **before** the gate; their unit coverage stays in `middleware.test.ts` — the gate alone
  cannot observe them.
- `src/trpc/runtime-api.ts` — `gatherTaskDiagnosticsSnapshot`,
  `buildTaskDiagnosticsResponse`, and the `exportTaskDiagnostics` mutation (including the
  `lockedFileSystem.writeTextFileAtomic` write) to remove in 3d.
- `src/core/api-contract.ts:2353-2366` — `runtimeDiagnosticsExportRequestSchema` /
  response (`bundlePath`, `redactions`) to remove.
- `src/core/api-validation.ts:379` — `parseDiagnosticsExportRequest` to remove.
- `src/trpc/app-router.ts:310` (type) and `:629` (`workspaceProcedure`) — to remove.
- `src/core/task-diagnostics-export.ts` — `buildTaskDiagnosticsExportBundle`
  (schemaVersion 2 redaction builder) to remove.
- `src/commands/task.ts` — `taskExportDiagnosticsCommand` (`:1339`), result-record
  printing (`:1470-1480`), registration (`:1800-1801`), `createRuntimeTrpcClient` pair
  (`:250`).
- `src/core/runtime-endpoint.ts:136` — `getRuntimeFetch()` (bearer + HTTPS) and
  `buildKanbanRuntimeUrl`.
- `web-ui/src/hooks/use-task-diagnostics.ts` / `runtime/task-diagnostics.ts` /
  `components/detail-panels/task-diagnostics-panel.tsx` — current export action and
  host-path toast.
- `test/runtime/core/task-diagnostics-export.test.ts` — asserts v2 redaction behaviour
  (`redactions`, `[redacted]` titles); delete in 3d, replaced by the DIAGEXP-2 builder
  tests.
- `test/runtime/server/ws-upgrade-passcode.test.ts` / `middleware.test.ts` — the
  composition pattern to follow (no test boots `createRuntimeServer`).
- `web-ui/playwright.config.ts` — starts only the Vite dev server (no runtime boot); no
  CI workflow runs e2e, so there is no Playwright assertion here.

## Implementation tasks (in this order)

- [ ] DIAGEXP-3.1 **3a: GET download route.** Add the GET handler as a small server module
      wired into `runtime-server.ts`, dispatched after the DIAGEXP-1 gate function and
      before the unmatched-`/api/` 404. Resolve the existing workspace scope, apply the
      task-membership rule (decision 3 above) before touching the filesystem, and invoke
      the DIAGEXP-2 export assembly. Set `Content-Type: application/json; charset=utf-8`,
      `Content-Disposition: attachment; filename="task-<safeTaskId>-<timestampMs>.json"`,
      and `Cache-Control: no-store`. Sanitize only the download filename; preserve the
      task ID in the bundle. Validate/read the initial snapshot before starting the
      response (non-2xx JSON errors for auth/membership/initial read); if streaming
      fails after headers, terminate the response. Respect backpressure and disconnects;
      no background export after cancellation.
- [ ] DIAGEXP-3.2 **3b: Browser download.** Replace the host-path export wrapper with the
      browser fetch helper (decision 5 above): same-origin fetch, status check, Blob,
      object URL, temporary anchor with the client-built filename, remove anchor and
      revoke URL after download initiation. Exporting state, duplicate-start rejection,
      actionable errors, no host-path/redaction toast. Success text: "Diagnostics download
      started." Add the persistent caption: "Includes the full conversation, system
      prompt, and tool inputs, outputs, and errors. Review before sharing."
- [ ] DIAGEXP-3.3 **3c: CLI repoint.** `kanban task export-diag` streams the GET route to a
      required `--output` file via `getRuntimeFetch()` + `buildKanbanRuntimeUrl`; returns
      `{ ok, outputPath, bytes, completeness }`; on non-2xx or a truncated stream deletes
      the partial file and returns `ok: false` with non-zero exit. Never writes to
      `~/.cline/kanban/diagnostics`. Update the command description text
      (`task.ts:1801`).
- [ ] DIAGEXP-3.4 **3d: Remove the write-to-host export in the same commit.**
      - `runtimeDiagnosticsExportRequestSchema` / response schemas in
        `src/core/api-contract.ts:2353-2366`
      - `exportTaskDiagnostics` type at `src/trpc/app-router.ts:310` and the
        `workspaceProcedure` at `:629`
      - `parseDiagnosticsExportRequest` in `src/core/api-validation.ts:379`
      - `exportTaskDiagnostics` mutation in `src/trpc/runtime-api.ts` (including the
        `lockedFileSystem.writeTextFileAtomic` write)
      - `buildTaskDiagnosticsExportBundle` (the schemaVersion 2 redaction builder) in
        `src/core/task-diagnostics-export.ts`
      - The old wrapper in `web-ui/src/hooks/use-task-diagnostics.ts` /
        `runtime/task-diagnostics.ts`
      - Delete `test/runtime/core/task-diagnostics-export.test.ts` (replaced by the
        DIAGEXP-2 builder tests — the "no test references the removed contract" check's
        explicit owner)
- [ ] DIAGEXP-3.5 **3e: Docs.**
      - New `docs/runtime/diagnostics-export.md` documents the browser-download behavior,
        content caption, and completeness/gap semantics, linked from `docs/README.md`.
      - Update B-10.7's old redacted-host-file requirement in all three places:
        `docs/plans/B-10.md:191` (the requirement "Exclude API keys, prompts, private code,
        and raw environment by default"), `docs/plans/B-10.md:201` (acceptance: "Tests
        cover … redaction"), and `docs/plans/B_IMPLEMENTATION_PLAN.md:528` (the unchecked
        copy). Keep the wording explicit that provider credentials and raw environment
        dumps remain excluded while prompts and code are now included, so the history does
        not read as a silent policy flip.
      - CLI help text updated per 3c.
- [ ] DIAGEXP-3.6 **Tests** — see the acceptance sections below.

## Acceptance and tests

### HTTP integration test (Node level)

The HTTP test composes `handleHttpRequest` → extracted gate → route handler the way
`requestHandler` does (a small `http.createServer` wrapper in the test is fine; no full
server boot). Cover:

| Scenario | Required result |
| --- | --- |
| Authenticated download, passcode enabled | 200; streamed JSON reads to completion and `JSON.parse` succeeds (fake export assembler) |
| Unauthenticated request (passcode on) | Rejected; no download |
| Origin/host rejection | Rejected per middleware semantics (unit coverage stays in `middleware.test.ts`; the gate alone cannot observe it) |
| Missing/foreign workspace or task | 404 JSON error, before any filesystem access |
| Response headers | Correct `Content-Type`, `Content-Disposition` filename, `Cache-Control: no-store` |
| Initial error (auth/membership/initial read) | Non-2xx JSON error before headers |
| Stream failure after headers | Response terminated; never a truncated "successful" file |
| Client disconnect mid-stream | No background export continues |
| Removed contract | No test (or production code) references `runtimeDiagnosticsExportRequestSchema`, `exportTaskDiagnostics`, or `buildTaskDiagnosticsExportBundle` |

### Browser test layer (jsdom)

jsdom with mocked `fetch` / `URL.createObjectURL` / anchor click covers: one download per
click with the correct filename; duplicate-click blocking; loading reset on success and
failure; bad HTTP/download failure error; object-URL cleanup.

There is no Playwright assertion: `web-ui/playwright.config.ts` starts only the Vite dev
server (no runtime boot) and no CI workflow runs e2e, so the "real download with parseable
JSON" property is covered by the Node-level HTTP integration test above, with the true
end-to-end download left to the manual acceptance below.

### Manual acceptance (ai-monster)

In a remote browser connected to ai-monster: export a stopped task with failed editor
calls and a task with archived oversized command output. A browser file download must
start without SSH or a host export path. Parse the downloaded JSON, find the failure in
its conversation segment, and inspect the exact recorded input plus error. Verify an
archived output is fully present beyond the model excerpt. Test with passcode
authentication and after a Kanban restart. Confirm no new file appeared under
`~/.cline/kanban/diagnostics` from either export, and that `kanban task export-diag`
writes to the requested file, not `~/.cline/kanban/diagnostics`.

Run: the focused `test/runtime` suites (server, trpc), web typecheck, backend typecheck,
Biome on changed files, and the repository's required checks. Do not run Prettier.

## Settings, rollout, and documentation

No new environment variables, account setup, services, storage directories, or database
migration. Backend and frontend deploy together. The PR description must prominently
include deployment instructions and tests for complete transcript context, full archived
tool output, browser downloading (and the DIAGEXP-0 expanded tool input visibility if
landed in the same deploy), the deploy-coupling note that already-open tabs show a
"runtime request error" on Export until reloaded, and rollback guidance (revert both
sides together; historical exports and missing historical evidence stay unchanged).

## Handoff

Record: changed files, the route path/headers/membership rule, the CLI `--output` contract
and record shape, the full removal list, the doc updates (including the three B-10.7
wording changes), the Node-level HTTP test and jsdom test results, the manual
ai-monster acceptance outcome, and any baseline drift discovered against `7a64060`. This
completes the feature; no further briefs remain.

## Stop conditions

- DIAGEXP-1 or DIAGEXP-2 has not landed — this PR is blocked; do not re-extract the gate or
  re-implement the snapshot/serializer inline.
- A test would require bypassing auth in the production route, booting a full server, or
  running real e2e — rework the fixture per the acceptance sections above.
- Removing the old contract would leave a reachable disk-writing path (fallback, alias, or
  test) — fix the removal in this commit rather than deferring it.
- Manual acceptance shows a file appearing under `~/.cline/kanban/diagnostics` — that is a
  leaked write-to-host path; stop and record it before closing the feature.
