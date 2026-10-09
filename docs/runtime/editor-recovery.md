# Native Cline editor limits and recovery

Local Kanban sessions accept up to 32,000 characters in each editor text field
(`old_text` and `new_text`). The prompt recommends staying below 30,000.
The model-facing SDK schema descriptions are updated to match.

The installed SDK 0.0.38 rejects either field above 6,000 in its tool wrapper,
before the filesystem executor runs. It exposes no configuration for that check.
Kanban's local beforeTool adapter delegates small calls to the original tool and
larger calls to the SDK's exported default editor executor. It keeps SDK path
restrictions, exact unique replacement matching, insertion semantics, result
envelopes, and a 30-second timeout. It does not modify node_modules or split writes
automatically. Runtime approval remains on the same editor tool.
The larger limit does not prevent model output limits or transport truncation.

This adapter uses local SDK hooks, as does Kanban's existing failure recovery.
Hub-backed execution retains the upstream limits and feedback behavior.
Recheck the SDK wrapper/executor contract when upgrading; remove the adapter if
the SDK provides a configurable limit.

On missing old_text, missing/ambiguous anchors, invalid insertion lines, or
oversized arguments, the afterTool recovery hook preserves the original error
and adds targeted instructions in the tool result's `recovery` field. The SDK
persists that result and includes it in the next model request. A repeated
identical failure adds an explicit warning; the existing three-failure guard and
timeout policy remain in place. Successful intermediate calls still reset the guard.
Instructions require a fresh file read and a corrected unique anchor, or a valid
one-based insertion boundary for pure additions.

Tests run the real SDK tool and agent loop against temporary files, and inspect
the next model request to verify both original errors and recovery guidance.
This proves delivery, not that the model follows the instructions.

## Deployment and verification

No new environment variables or migrations. Deploy normally and restart the
runtime; start a new task session so it receives the hooks and current prompt.
With existing editor tracing enabled, the trace's result phase intentionally
captures the original result before recovery; it does not display the added
model-facing recovery envelope.

Verify a 7,000–21,000-character new-file edit succeeds, then try an incorrect
replacement anchor in a disposable file. The model-facing tool result should
contain the original error plus a request to reread the file and choose a fresh
anchor. Payloads exceeding 32,000 must fail without a write.
