# Bounded tool failure recovery

Implemented for native Cline sessions using the local SDK agent runtime. A failed tool must return control to the model or stop with a visible error, rather than leaving the task displaying Thinking after the run has ended.

## Behavior

Only **timeouts** are retried or given timeout guidance. A tool error is a timeout only when it matches one of the exact shapes the SDK and Kanban's MCP layer emit, checked one line at a time (`isClineToolTimeout`): `<Command|File read|Search|Web fetch|Editor operation|apply_patch|...> timed out after Nms` (with an optional `Command failed: ` style prefix), `MCP error -32001: Request timed out`, `MCP request timed out for "<server>" (...)`, and `HTTP 408/504/524`. A free-text search for "timeout" is wrong: stderr, file paths, regexes, and echoed model input routinely contain it (`Test timed out in 5000ms`, `src/utils/timeout.ts`, `--timeout=5`) and are model-fixable. Every other failure (invalid input, oversized `editor` call, `old_text` not found, missing file, unknown tool, denied approval) is returned to the model unchanged as an ordinary tool result so it can repair it itself. An earlier version treated every failure as fatal after one repair, which ended tasks the model could have fixed on its own.

1. For `read_files`, `search_codebase`, and `fetch_web_content`, retry a timed-out call (thrown error or structured error result) once inside tool execution, without another model request. Cancellation never retries.
2. After both attempts time out, mark the tool result as an error and include its name, input, original output, and guidance to retry once (narrowed) or use a different tool.
3. Commands, file writes, and MCP tools are not replayed automatically. A timeout goes straight to the model with guidance to check whether a PR, commit, push, or write already succeeded before retrying once. Automatic replay of an arbitrary `gh pr create` timeout could create duplicate PRs.
4. The budget is per call (tool name plus input): a call that times out again after its one retry ends the run with `Tool timed out again after one retry`. A call that succeeds in between clears its strike. Identical calls in the same batch share a single strike.
5. Repeated-failure guard: the same call (tool name plus input) failing with the same error text three times, with no successful tool call in between, ends the run with `Tool call failed 3 times in a row with the same error...`. This catches a stuck agent that resends an identical failing call. Any successful tool call clears every streak, as does a changed call or error. Identical calls in the same batch share one strike. Timeouts have their own per-call budget above and are not counted here.
6. A new user turn resets all state. Stop/trash cancellation remains cancellation. Existing approval gates are preserved; the retry wrapper only runs after SDK approval.

Structured SDK errors (`error` fields in result arrays) and MCP `isError` envelopes are inspected for timeouts. No-match searches and nonzero test exit codes contained in ordinary command output remain normal model-visible results.

Recovery runs before ingestion-time output bounding. Original output is preserved with the timeout guidance. Interrupted tool-call repair still precedes recovery and compaction. On exhaustion, the guard throws before the next model request, after tool results have been persisted, preserving transcript pairings for manual continuation.

Terminal errors use the existing session warning in task detail and a red `err` badge on the board. SDK `ended` events preserve the error reason. Failed SDK replies that resolve without an error event are also reconciled to a stopped task with an error. This change does not add a timer that restarts arbitrary long-running inference.

Known gaps: if the model rewords a failing call each time, each variant gets its own strike, so only the SDK's own limits bound that loop. A successful tool call between identical failures (for example a diagnostic command) restarts the repeated-failure count. Timeouts that surface only on `error.cause` (for example an undici connect timeout, which the SDK reports as `fetch failed`) are indistinguishable from other fetch errors and are treated as ordinary errors. Unknown-tool calls never reach the `afterTool` hook, so they are not counted by the repeated-failure guard.

## Editor size guidance

The SDK's `editor` tool rejects `new_text` over 6000 characters, and nothing in the SDK's default prompt says so. Kanban appends `CLINE_EDITOR_SIZE_GUIDANCE` to the system prompt (`resolveClineSdkSystemPrompt`) telling the agent to keep each editor call under **5000** characters, because instructing the exact limit still leaves the model over it, and to split large additions into sequential edits or a new file.

## Deployment

No new environment variables, settings, migrations, or dependencies. Build and deploy Kanban through the existing release workflow; restart the Kanban service to load the new runtime. Existing live sessions need a restart to receive the hooks. This behavior applies to native Cline local SDK mode; hub-backed sessions and external agent runners do not execute these local hooks.

## Verification

- Run `npx vitest run test/runtime/cline-sdk/cline-tool-failure-recovery.test.ts`: exercises the installed SDK agent loop with a scripted model, including safe timeout retry, retry exhaustion, model-fixable errors passing through, batch timeouts, the repeated-failure guard and its reset on success, timeout-classifier false positives, unknown tools, denied approval, cancellation, and new-turn budget reset.
- Run `npx vitest run test/runtime/cline-sdk/cline-event-adapter.test.ts test/runtime/cline-sdk/cline-task-session-service.test.ts`: terminal event ordering and failed replies without error events.
- Run `npm run web:test -- task-phase-badge board-card`: red error badge, stale phase replacement, and clearing on another user turn.
- For a manual smoke test, use a disposable task that triggers a model-fixable error (a missing-file read, or an oversized `editor` call). The model must see the error and continue; the task must not enter `err`. To exercise the bound, make a read time out twice and then time out again on the model's retry: Thinking must disappear, task detail must show the error, and the board must show red `err`. Sending another message must clear the badge.
- For a command timeout, verify that the command runs once, the model receives verification guidance, and any retry is a model decision made after checking existing side effects.
