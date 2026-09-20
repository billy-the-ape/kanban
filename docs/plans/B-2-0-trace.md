# B-2-0 — Model capacity metadata trace (Kanban → SDK)

Evidence artifact for **B-2-0** (B-2.1 metadata trace + session-start diagnostics).
Verified against base SHA `7f27259` with `@clinebot/core` **0.0.38** installed.
Every file:line below was re-read before writing this document; SDK line numbers
refer to the installed `node_modules/@clinebot/core/dist` declaration files.

## 1. SDK defaults that currently govern every Kanban session

Kanban never passes `compaction` (or any context metadata) to the SDK session
host, so unconfigured behavior is decided entirely inside `@clinebot/core`:

| Constant | Value | Location |
| --- | --- | --- |
| `DEFAULT_CONTEXT_WINDOW_TOKENS` | `200000` | `@clinebot/core/dist/extensions/context/compaction-shared.d.ts:1` |
| `DEFAULT_THRESHOLD_RATIO` | `0.95` | `compaction-shared.d.ts:2` |
| `DEFAULT_RESERVE_TOKENS` | `16384` | `compaction-shared.d.ts:3` |
| `DEFAULT_PRESERVE_RECENT_TOKENS` | `20000` | `compaction-shared.d.ts:4` |
| `DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS` | `1024` | `compaction-shared.d.ts:5` |

The compiled bundle applies them as nullish defaults (`contextWindowTokens ?? …`,
`thresholdRatio ?? …`, and `compaction.enabled ?? true` — verified in
`@clinebot/core/dist/index.js`). So today **every** Kanban session, regardless of
the real model limit, compacts at `200000 × 0.95 = 190000` tokens:

- A 32K local model overflows the provider **before** SDK compaction can fire
  (the B-2 trigger incident class).
- A 1M-context model compacts far earlier than needed (cost + information loss).

The SDK *does* accept explicit configuration via `CoreSessionConfig`
(`@clinebot/core/dist/types/config.d.ts`): `providerConfig?: ProviderConfig`
(line 13), `knownModels?: Record<string, ModelInfo>` (line 14 / line 56), and
`compaction?: CoreCompactionConfig` (line 156). Kanban passes none of them.
`CoreModelInfo` carries `contextWindow?: number` / `maxTokens?: number`
(`config.d.ts:22-23`).

## 2. Where capacity metadata is produced (sources)

| Source | Capacity fields | Where |
| --- | --- | --- |
| `@clinebot/llms` model catalog (`ModelInfo`) | `contextWindow?`, `maxTokens?` | `@clinebot/llms/dist/models.d.ts:285-286`; re-exported by `@clinebot/shared/dist/model-info.d.ts:3-4` |
| SDK catalog via `resolveProviderConfig` → `ProviderConfig.knownModels` / `ProviderConfig.contextWindow` | `CoreModelInfo.contextWindow` / `maxTokens`, `contextWindow` | `@clinebot/core/dist/types/config.d.ts:127,133,22-23` |
| Persisted SDK provider settings (`SdkProviderSettings`) | `contextWindow?` | `@clinebot/core/dist/services/llms/provider-settings.d.ts:151`; also in `@clinebot/shared/dist/rpc/runtime.d.ts:217` (`SaveProviderSettingsActionRequest.contextWindow?`) |
| LiteLLM `/model/info` (and `/models`) HTTP response | passthrough fields (e.g. `max_tokens`, `context_length`) — retained by the parse schema via `.passthrough()` | `src/cline-sdk/cline-provider-service.ts:62-64` |
| SDK `ProviderModel` (local-provider model list, incl. OpenAI-compatible list sources) | **none** — the type has no capacity fields | `@clinebot/shared/dist/rpc/runtime.d.ts:122-128` |

Note the last row: for providers whose model list comes from `getLocalProviderModels`
(LiteLLM, OpenAI-compatible, custom), **no capacity metadata exists at the source**
in the SDK's own types — it is not being discarded, it is simply absent there.
Only the catalog path and LiteLLM's raw HTTP response can carry capacity.

## 3. Hop-by-hop trace

### Hop 1 — UI settings → SDK provider settings

- tRPC save contract `runtimeClineProviderSettingsSaveRequestSchema`
  (`src/core/api-contract.ts:789-813`) accepts: `providerId`, `modelId`, `apiKey`,
  `baseUrl`, `reasoningEffort`, `region`, `aws`, `gcp`. **No capacity field.**
- `InMemoryClineProviderService.saveProviderSettings`
  (`src/cline-sdk/cline-provider-service.ts:982-1160`) maps those fields onto
  `SdkProviderSettings`. The SDK schema *could* store `contextWindow`
  (`provider-settings.d.ts:151`) and the settings spread
  (`cline-provider-service.ts:1011-1014`) would preserve a hand-edited value —
  but no Kanban code path ever sets it.
- Read-back `getSelectedProviderSettings` (`cline-provider-service.ts:353-361`)
  returns the full raw settings (so a hand-written `contextWindow` would survive
  a round trip), but the UI summary `toProviderSettingsSummary`
  (`cline-provider-service.ts:331-351`) and `runtimeClineProviderSettingsSchema`
  (`src/core/api-contract.ts:604-615`) expose only
  provider/model/baseUrl/reasoningEffort/auth state.

**Drift vs B-2-0.md:** none material — the card did not name the save schema;
this hop confirms the UI cannot set `contextWindow`.

### Hop 2 — Model listing (three sources, two discards)

`InMemoryClineProviderService.getProviderModels`
(`src/cline-sdk/cline-provider-service.ts:873-910`) merges:

1. **Local-provider list**: `listSdkProviderModels`
   (`src/cline-sdk/sdk-provider-boundary.ts:375-381`) → SDK
   `getLocalProviderModels` returns `ProviderModel[]`
   (`@clinebot/core/dist/services/providers/local-provider-service.d.ts:43-46`),
   a type with **no capacity fields** (§2, last row) → `toSdkProviderModel`
   (`sdk-provider-boundary.ts:321-327`) → `toRuntimeProviderModel`
   (`cline-provider-service.ts:229-237`). Nothing to discard; the source has no
   capacity data.
2. **Catalog**: `listSdkProviderCatalog`
   (`sdk-provider-boundary.ts:317-319`) → SDK `resolveProviderConfig` whose
   `knownModels` **do carry** `contextWindow`/`maxTokens` →
   `toSdkProviderModelFromCatalog` (`sdk-provider-boundary.ts:331-347`) maps
   only `id`, `name`, and capability booleans.
   **DISCARD 1** — catalog capacity metadata dropped here.
3. **LiteLLM server list**: `fetchLiteLlmBaseUrlModels`
   (`cline-provider-service.ts:265-314`) parses `/models` and `/model/info`
   through `LITELLM_MODELS_RESPONSE_SCHEMA` (lines 62-64) which *keeps* extra
   fields via `.passthrough()`, but `resolveLiteLlmModelListItemId`
   (lines 260-263) reads only `id`/`model_name` and line 304 rebuilds each model
   as `{ id, name: id }`.
   **DISCARD 2** — server-provided `max_tokens`/`context_length` dropped at the mapper.

All three converge on `runtimeClineProviderModelSchema`
(`src/core/api-contract.ts:697-704`: `id`, `name`, `supportsVision`,
`supportsAttachments`, `supportsReasoningEffort`) — the tRPC contract has no
capacity field, and zod's default strip behavior would remove any that leaked in.
**DISCARD 3 (contractual)** — even a fixed upstream mapper could not deliver
capacity to the web-ui without a schema change.

### Hop 3 — Launch resolution

- tRPC `startTaskSession` (`src/trpc/runtime-api.ts:168`) calls
  `clineProviderService.resolveLaunchConfig` (line 221; also lines 427, 628 for
  reload/home-agent paths).
- `resolveLaunchConfig` (`cline-provider-service.ts:782-869`) reads
  `getSelectedProviderSettings`, validates provider+model, and returns
  `ResolvedClineLaunchConfig` (`cline-provider-service.ts:74-80`):
  `providerId`, `modelId`, `apiKey`, `baseUrl`, `reasoningEffort`.
  **DISCARD 4** — even though the selected raw `SdkProviderSettings` object is in
  scope and *can* carry `contextWindow` (§1, §Hop 1), the launch config shape has
  no capacity field and the resolver does not copy one.

### Hop 4 — Task session service

- `runtime-api.ts:232` → `InMemoryClineTaskSessionService.startTaskSession`
  (`src/cline-sdk/cline-task-session-service.ts:320-439`), request type
  `StartClineTaskSessionRequest` (lines 59-77): taskId/cwd/prompt/taskTitle/
  images/resume flags/providerId/modelId/mode/apiKey/baseUrl/reasoningEffort/
  systemPrompt. No compaction or context fields. The detached start IIFE
  forwards exactly these fields to `sessionRuntime.startTaskSession`
  (lines 391-432). **No discard here — there is nothing to forward.**

### Hop 5 — Session runtime → SDK host (the effective discard)

- `InMemoryClineSessionRuntime.startTaskSession`
  (`src/cline-sdk/cline-session-runtime.ts`) calls `sessionHost.start` with a
  `ClineCoreStartInput` config carrying: `sessionId`, `providerId`, `modelId`,
  `apiKey`, `baseUrl`, `reasoningEffort`, `cwd`, `mode`, `enableTools`,
  `enableSpawnAgent`, `enableAgentTeams`, `execution.maxConsecutiveMistakes`,
  `systemPrompt`, plus `localRuntime` (logger, user instructions, MCP tools).
- **DISCARD 5 (effective)**: `compaction?`, `providerConfig?`, `knownModels?`
  (`@clinebot/core/dist/types/config.d.ts:13,14,156`) are all accepted by the
  SDK but never passed — no context limit reaches the SDK at all, so the §1
  defaults govern every session.

### Hop 6 — SDK runtime (what actually happens today)

With `compaction` unset, the 0.0.38 context pipeline applies
`contextWindowTokens ?? 200000`, `thresholdRatio ?? 0.95`,
`reserveTokens ?? 16384`, and runs compaction (enabled by default) at
190,000 tokens — see §1. There is no model-aware narrowing anywhere in the
Kanban→SDK path.

## 4. Discard-point summary

| # | Location | What is lost |
| --- | --- | --- |
| 1 | `src/cline-sdk/sdk-provider-boundary.ts:331-347` (`toSdkProviderModelFromCatalog`) | Catalog `ModelInfo.contextWindow`/`maxTokens` |
| 2 | `src/cline-sdk/cline-provider-service.ts:260-263,304` (LiteLLM mapper) | Server-provided `max_tokens`/`context_length` |
| 3 | `src/core/api-contract.ts:697-704` (`runtimeClineProviderModelSchema`) | Contractual: no capacity field can reach the web-ui |
| 4 | `src/cline-sdk/cline-provider-service.ts:74-80,782-869` (`ResolvedClineLaunchConfig` / `resolveLaunchConfig`) | Persisted `SdkProviderSettings.contextWindow` (if ever set) |
| 5 | `src/cline-sdk/cline-session-runtime.ts` (`sessionHost.start` call) | No `compaction`/`providerConfig`/`knownModels` → SDK defaults (200000/0.95/16384) govern |

## 5. Drift vs the B-2-0.md "Known metadata path"

- `toRuntimeProviderModel` is at `cline-provider-service.ts:229` (card said
  ~229 — matches). `resolveLaunchConfig` is at `cline-provider-service.ts:782`
  (card said ~782 — matches). `ResolvedClineLaunchConfig` is defined in
  `cline-provider-service.ts:74-80`, not in `api-contract.ts`.
- The LiteLLM mapper lives in `cline-provider-service.ts`
  (`LITELLM_MODELS_RESPONSE_SCHEMA` at line 62, mapper at 260-314), not in
  `sdk-provider-boundary.ts` as the card's §5 phrasing suggested.
- `CoreSessionConfig.knownModels` is `Record<string, ModelInfo>` (a map), not an
  array, per `@clinebot/core/dist/types/config.d.ts:14`.
- Everything else matches the card.

## 6. Observability added by this card (B-2.1)

One diagnostic log at session start (and restart, which re-enters the same
path via `restartTaskSession` → `startTaskSession`), emitted in
`InMemoryClineSessionRuntime.startTaskSession`
(`src/cline-sdk/cline-session-runtime.ts`, immediately before `sessionHost.start`):

```json
{
  "ts": "…",
  "level": "info",
  "message": "Cline session start: effective context metadata",
  "metadata": {
    "runtime": "kanban",
    "taskId": "…",
    "providerId": "litellm",
    "modelId": "qwen3-32b",
    "baseUrlHost": "host:port or null",
    "contextLimitTokens": 200000,
    "contextLimitSource": "unconfigured-sdk-default",
    "clineCoreVersion": "0.0.38"
  }
}
```

- `contextLimitTokens` is `CLINE_SDK_DEFAULT_CONTEXT_WINDOW_TOKENS`
  (`src/cline-sdk/sdk-runtime-boundary.ts`), a documented mirror of the SDK's
  unexported `DEFAULT_CONTEXT_WINDOW_TOKENS`; `contextLimitSource` is the
  placeholder `"unconfigured-sdk-default"` until B-2-2 lands a real resolver
  (provider override → catalog → SDK default).
- `baseUrlHost` is `new URL(baseUrl).host` only — never the key, path, or
  credentials; malformed URLs log `null`.
- `clineCoreVersion` comes from `getClineCorePackageVersion()`
  (`sdk-runtime-boundary.ts`): the SDK exports no version constant, and its
  `exports["."]` map only defines ESM conditions (`development`/`types`/
  `import` — no `require`/`default`), so `require.resolve` cannot find the
  entry point either. Kanban therefore walks up from the boundary file and
  reads the first `node_modules/@clinebot/core/package.json` it finds (works
  with npm and pnpm hoisting). Best-effort; falls back to `"unknown"` and can
  never break startup.
- Emission is gated by `CLINE_LOG_ENABLED` like all Cline runtime logs
  (`src/cline-sdk/cline-runtime-logger.ts:30-36`); default log file
  `~/.cline/logs/kanban.log` (or `CLINE_LOG_PATH`). **Zero behavior change** to
  requests or compaction.

### How to verify at runtime

```sh
CLINE_LOG_ENABLED=1 kanban   # or export it
# start one task, then:
grep "effective context metadata" ~/.cline/logs/kanban.log
```

## 7. Unresolved SDK questions (handoff to B-2-2)

1. Does 0.0.38 honor `providerConfig.contextWindow` / `knownModels` at runtime
   for compaction decisions, or only `compaction.contextWindowTokens`? The
   declaration files prove the fields exist; the minified bundle does not make
   the read order obvious. B-2-2 should decide experimentally (or by reading
   SDK source) which field to prefer.
2. `compaction.enabled` appears to default to `true` in the 0.0.38 bundle
   (`.enabled??!0`), but no declaration documents that default.
3. Whether `SdkProviderSettings.contextWindow` (the persisted-settings field)
   is read by the SDK's compaction path — if so, B-2-2 could potentially use it
   instead of (or in addition to) `CoreSessionConfig.compaction`.

