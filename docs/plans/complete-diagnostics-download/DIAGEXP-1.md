# DIAGEXP-1 — Extract the runtime auth gate and workspace-scope resolution

Part of the **complete task diagnostics as a browser download** feature. The master plan
lives in [PLAN.md](./PLAN.md). This document is a self-contained execution brief for the
auth-gate extraction PR (slice **DIAGEXP-1**). It represents a single PR.

| Field | Value |
| --- | --- |
| Document revision | 1 |
| Prepared | 2026-10-08 |
| Status | planned; no milestone started |
| Source baseline | `7a64060` (main) |
| Fork | https://github.com/billy-the-ape/kanban |
| Prerequisites | None — independent of DIAGEXP-0 and DIAGEXP-2 |
| Follow-on | DIAGEXP-3 dispatches its new GET route **after** the extracted gate function |

## Purpose

No test today boots `createRuntimeServer`, and the passcode/session/bearer gate plus
workspace-scope resolution is inline in `requestHandler`
(`src/server/runtime-server.ts:376-477`); `test/runtime/server/ws-upgrade-passcode.test.ts`
re-implements the gate logic instead of exercising it.

Extract the gate (and workspace-scope resolution) into a shared function that the
production `requestHandler` **and the tests all call** — behaviour-preserving by intent, and
landed/reviewed on its own so that a security-sensitive refactor is never bundled with a new
streaming route, a CLI repoint, and a contract removal (all of which are DIAGEXP-3).

This PR is behaviour-neutral: no request that succeeds today starts failing, no request
that fails today starts succeeding, no headers, status codes, or logs change in any
observable way beyond the refactor itself.

## Fixed decisions carried in from the master plan

- The extraction covers the inline passcode/session/bearer gate (`:452-477`) and the
  workspace-scope resolution in `requestHandler` (`:376-477`). The session cookie remains
  `SameSite=Strict; HttpOnly` (`:436-443`); unmatched `/api/` paths still 404 at `:493`.
- The production `requestHandler` and the tests must call the **same** shared function —
  the point is that the tests now exercise the real gate code instead of a re-implementation
  (`ws-upgrade-passcode.test.ts` moves from re-implementing the logic to calling the
  extracted function).
- Behaviour is preserved exactly; this is a pure extraction. Do not fix, tighten, or loosen
  any gate decision in this PR — if a latent security issue is found, record it for a
  separate brief rather than changing behaviour here.
- No new auth mechanism, no bearer-token-in-URL, no origin-policy change. Origin/host
  checks stay where they are today (`handleHttpRequest` at `middleware.ts:111` runs before
  the passcode gate and keeps its own coverage in `middleware.test.ts`).

## Scope

Allowed:

- `src/server/runtime-server.ts` — replace the inline gate/scope-resolution block in
  `requestHandler` with a call to the new shared function.
- A new small server module (e.g. under `src/server/`) containing the extracted
  gate + workspace-scope resolution function, typed against the existing
  `CreateRuntimeApiDependencies` / server state shapes.
- `test/runtime/server/` — update `ws-upgrade-passcode.test.ts` to call the extracted
  function, and add the behaviour-preservation cases below.
- `src/server/middleware.ts` — only if the gate function needs to import existing helpers
  from there; no behavioural change to middleware.

Explicit non-goals:

- No new routes (the DIAGEXP-3 download route is not part of this PR).
- No contract, tRPC, CLI, or web-UI changes.
- No change to passcode storage, session cookie attributes, bearer-token validation, or
  origin checks.
- No new dependencies.

## Source map (reinspect before editing; baseline is historical)

- `src/server/runtime-server.ts` — `requestHandler` (`:376-477`); session cookie set at
  `:436-443`; passcode/session/bearer gate at `:452-477`; unmatched `/api/` 404 at `:493`;
  scoped review session service at `:192` (do not touch).
- `src/server/middleware.ts` — `handleHttpRequest` (`:111`) and origin checks run **before**
  the gate; the gate alone cannot observe them.
- `test/runtime/server/ws-upgrade-passcode.test.ts` — currently re-implements the gate
  logic; becomes the first consumer of the extracted function. No test boots
  `createRuntimeServer` — keep that property; compose pieces in tests instead.

## Implementation tasks (in this order)

- [ ] DIAGEXP-1.1 **Shared gate function.** Extract the passcode/session/bearer gate and
      workspace-scope resolution from `requestHandler` into a shared, exported function with
      an explicit typed input/output (the gate decision plus the resolved workspace scope).
      `requestHandler` becomes a thin dispatch over it.
- [ ] DIAGEXP-1.2 **Repoint the production path.** `requestHandler` calls the shared function;
      remove the inline copy so there is exactly one implementation.
- [ ] DIAGEXP-1.3 **Repoint the tests.** Update `ws-upgrade-passcode.test.ts` to call the
      shared function instead of re-implementing the logic.
- [ ] DIAGEXP-1.4 **Behaviour-preservation tests** — see the acceptance table below.

## Acceptance and tests

Tests prove the gate decision is unchanged for at minimum:

| Scenario | Required result |
| --- | --- |
| Passcode off | Unauthenticated `/api/` requests allowed exactly as today |
| Passcode on + valid session cookie | Allowed; scope resolution identical |
| Passcode on + valid bearer token | Allowed (internal/CLI path) exactly as today |
| Passcode on + no auth | Rejected with the same status/shape as today |
| `/api/passcode/*` paths | Exempt/handled exactly as today |
| Static asset requests | Not gated exactly as today |
| WS upgrade path (`ws-upgrade-passcode.test.ts`) | Same decisions as the pre-extraction re-implementation |

No test boots `createRuntimeServer` (preserve the existing property); compose the extracted
function directly. Run: the focused `test/runtime/server` suites, backend typecheck, Biome
on changed files, and the repository's required checks. Do not run Prettier.

## Settings, rollout, and documentation

No new environment variables, configuration, or storage. Independently deployable and
behaviour-neutral. The PR description must state that this is a pure extraction, that the
tests now exercise the real gate function, and that no gate decision changed.

## Handoff

Record: changed files, the shared function's location and signature, the gate-decision test
matrix results, and any baseline drift discovered against `7a64060`. DIAGEXP-3 then wires
its GET download route after this gate function; if a latent security issue was noted
during the extraction, hand it off as a separate brief — do not fix it in DIAGEXP-3.

## Stop conditions

- The inline gate behaves differently from what the existing tests re-implement — stop and
  record the divergence; resolving it is a behaviour change and belongs in its own brief.
- A "natural" extraction would require changing a decision, a status code, or a log — stop;
  extraction must be behaviour-preserving.
