# Bounded tool failure recovery

Implemented for native Cline sessions using the local SDK agent runtime. A failed tool must return control to the model or stop with a visible error, rather than leaving the task displaying Thinking after the run has ended.

## Behavior

1. For `read_files`, `search_codebase`, and `fetch_web_content`, retry a thrown error or structured error result once inside tool execution, without another model request. Cancellation never retries.
2. After both attempts fail, mark the tool result as an error and include its name, input, original output, and guidance to reformat the call or choose another tool. The run gets one model repair opportunity.
3. Commands, file writes, and MCP tools go directly to the model repair step after their first failure. Their outcome may be uncertain or include partial side effects. The repair guidance explicitly requires checking whether a PR, commit, push, or write already succeeded before repeating it. Automatic replay of an arbitrary `gh pr create` timeout could create duplicate PRs.
4. A further tool failure in a later model iteration ends the run with `Tool recovery exhausted`. Successful intermediate calls do not replenish the repair budget. Multiple failures in the initial batch share the same repair opportunity.
5. A new user turn resets the budget. Stop/trash cancellation remains cancellation. Existing approval gates are preserved; the retry wrapper only runs after SDK approval.

Structured SDK errors (`error` fields in result arrays) and MCP `isError` envelopes count as tool failures. No-match searches and nonzero test exit codes contained in ordinary command output remain normal model-visible results. Unknown tool calls and invalid call JSON that bypass SDK tool hooks are checked before the next model request.

Recovery runs before ingestion-time output bounding. Original output is preserved with repair guidance. Interrupted tool-call repair still precedes recovery and compaction. On exhaustion, the guard throws before the next model request, after tool results have been persisted, preserving transcript pairings for manual continuation.

Terminal errors use the existing session warning in task detail and a red `err` badge on the board. SDK `ended` events preserve the error reason. Failed SDK replies that resolve without an error event are also reconciled to a stopped task with an error. This change does not add a timer that restarts arbitrary long-running inference.

## Deployment

No new environment variables, settings, migrations, or dependencies. Build and deploy Kanban through the existing release workflow; restart the Kanban service to load the new runtime. Existing live sessions need a restart to receive the hooks. This behavior applies to native Cline local SDK mode; hub-backed sessions and external agent runners do not execute these local hooks.

## Verification

- Run `npx vitest run test/runtime/cline-sdk/cline-tool-failure-recovery.test.ts`: exercises the installed SDK agent loop with a scripted model, including safe retry, exhausted repair, successful repair, batch failures, unknown tools, denied approval, cancellation, and new-turn budget reset.
- Run `npx vitest run test/runtime/cline-sdk/cline-event-adapter.test.ts test/runtime/cline-sdk/cline-task-session-service.test.ts`: terminal event ordering and failed replies without error events.
- Run `npm run web:test -- task-phase-badge board-card`: red error badge, stale phase replacement, and clearing on another user turn.
- For a manual smoke test, use a disposable task with a missing file read. After two failed reads the model should receive repair guidance. If its next tool fails, Thinking must disappear and task detail must show the exhaustion error; the board must show red `err`. Sending another message must clear the badge and allow another bounded attempt.
- For a command timeout, verify that the command runs once, the model receives verification guidance, and any retry is a model decision made after checking existing side effects.
