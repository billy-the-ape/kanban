# Bounded tool failure recovery

Implemented for native Cline sessions using the local SDK agent runtime. A failed tool must return control to the model or stop with a visible error, rather than leaving the task displaying Thinking after the run has ended.

## Behavior

Only **timeouts** are handled by these hooks. A tool error is a timeout when its text matches `timed out`, `timeout`, `ETIMEDOUT`, `ESOCKETTIMEDOUT`, or `deadline exceeded` (`isClineToolTimeout`). Every other failure (invalid input, oversized `editor` call, `old_text` not found, missing file, unknown tool, denied approval) is returned to the model unchanged as an ordinary tool result. The model sees the error and repairs it itself; nothing is replayed, counted, or allowed to end the run. An earlier version treated every failure as fatal after one repair, which ended tasks that the model could have fixed on its own.

1. For `read_files`, `search_codebase`, and `fetch_web_content`, retry a timed-out call (thrown error or structured error result) once inside tool execution, without another model request. Cancellation never retries.
2. After both attempts time out, mark the tool result as an error and include its name, input, original output, and guidance to retry once (narrowed) or use a different tool.
3. Commands, file writes, and MCP tools are not replayed automatically. A timeout goes straight to the model with guidance to check whether a PR, commit, push, or write already succeeded before retrying once. Automatic replay of an arbitrary `gh pr create` timeout could create duplicate PRs.
4. The budget is per call (tool name plus input): a call that times out again after its one retry ends the run with `Tool timed out again after one retry`. A call that succeeds in between clears its strike. Identical calls in the same batch share a single strike.
5. A new user turn resets all state. Stop/trash cancellation remains cancellation. Existing approval gates are preserved; the retry wrapper only runs after SDK approval.

Structured SDK errors (`error` fields in result arrays) and MCP `isError` envelopes are inspected for timeouts. No-match searches and nonzero test exit codes contained in ordinary command output remain normal model-visible results.

Recovery runs before ingestion-time output bounding. Original output is preserved with the timeout guidance. Interrupted tool-call repair still precedes recovery and compaction. On exhaustion, the guard throws before the next model request, after tool results have been persisted, preserving transcript pairings for manual continuation.

Terminal errors use the existing session warning in task detail and a red `err` badge on the board. SDK `ended` events preserve the error reason. Failed SDK replies that resolve without an error event are also reconciled to a stopped task with an error. This change does not add a timer that restarts arbitrary long-running inference.

Known gap: if the model rewords a timing-out call each time, each variant gets its own strike, so only the SDK's own limits bound that loop.

## Deployment

No new environment variables, settings, migrations, or dependencies. Build and deploy Kanban through the existing release workflow; restart the Kanban service to load the new runtime. Existing live sessions need a restart to receive the hooks. This behavior applies to native Cline local SDK mode; hub-backed sessions and external agent runners do not execute these local hooks.

## Verification

- Run `npx vitest run test/runtime/cline-sdk/cline-tool-failure-recovery.test.ts`: exercises the installed SDK agent loop with a scripted model, including safe timeout retry, retry exhaustion, model-fixable errors passing through, batch timeouts, unknown tools, denied approval, cancellation, and new-turn budget reset.
- Run `npx vitest run test/runtime/cline-sdk/cline-event-adapter.test.ts test/runtime/cline-sdk/cline-task-session-service.test.ts`: terminal event ordering and failed replies without error events.
- Run `npm run web:test -- task-phase-badge board-card`: red error badge, stale phase replacement, and clearing on another user turn.
- For a manual smoke test, use a disposable task that triggers a model-fixable error (a missing-file read, or an oversized `editor` call). The model must see the error and continue; the task must not enter `err`. To exercise the bound, make a read time out twice and then time out again on the model's retry: Thinking must disappear, task detail must show the error, and the board must show red `err`. Sending another message must clear the badge.
- For a command timeout, verify that the command runs once, the model receives verification guidance, and any retry is a model decision made after checking existing side effects.
