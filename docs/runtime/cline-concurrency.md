# Cline and Pi model concurrency

Cline turns share a process-wide capacity queue keyed by normalized API endpoint
and model ID. Implementation, home-agent, review and verification-repair runtimes
use the same budget. A live but idle Cline session holds no capacity. A
Cline turn reserves a slot through SDK startup, generation, tool execution,
and compaction, and releases it when the SDK turn resolves or fails.

**Every Pi coding turn Kanban starts** now uses the same queue — the initial
prompt and any later input Kanban submits (task chat, and the automated PR
feedback handoff) — holding capacity until a Pi `agent_settled` hook or process
exit. A Pi turn can run shell commands and
sleep while reserving a slot; raising the override allows other agents to
run during these gaps. A queued Pi turn never blocks its request: the
card records a **Waiting for model capacity** summary and Kanban spawns the
CLI, or writes the follow-up input, in the background once a slot frees.
A live session that already holds a slot is written to immediately, because its
in-flight turn already reserves the card's slot.
Only typing directly into a card's own terminal bypasses this queue, because
Kanban cannot queue another client's keystrokes.
This is not a hard inference-provider request limit.

## Automatic discovery

Leave **Settings → General → Concurrent agent turns per model** empty. Kanban reads
`GET /props?model=<model-id>` from the provider endpoint, removing a final `/v1`
from the URL while retaining any reverse-proxy prefix. A positive integer
`total_slots` is the parallel capacity. Pi obtains its model and endpoint from
its own `settings.json` and `models.json`, without reading credentials.
Model names are URL-encoded; configured
API keys are sent as Bearer authorization. No context size is changed or inferred
from the slot count.

Discovery has a 2.5-second timeout and a 30-second cache, including fallback
results. Providers without an explicit base URL, missing `/props`, invalid data,
authentication failures and unavailable servers fall back to one concurrent turn.
A slow cold model load can therefore temporarily use the fallback; after loading,
the next discovery after cache expiry reads the actual slot count.

## Manual override

Enter an integer from 1 to 64 to bypass discovery. The override applies to every
endpoint/model pool; it is not a single global maximum. Clear the field to restore
automatic discovery. For compatibility the global preference is still stored
under the existing `clineConcurrencyLimit` key
in Kanban's runtime config (`null` or absent means automatic). No environment
variables or database migrations are required. Settings affect new admissions;
queued turns retain the capacity resolved when they entered the queue, and active
turns are not interrupted when the setting changes.

Cline turns remain In Progress with **Waiting for model capacity**, then run
when capacity becomes available. A new Pi start answers its request immediately
instead of waiting inside it: with no slot free the card records **Waiting for a
free model slot** (an idle, process-less summary carrying the same capacity-wait
marker a queued Cline turn uses, plus its queue position) and the CLI spawns by
itself once capacity frees, so automatic backlog dispatch never holds its brief
per-workspace dispatch lock across another task's whole turn. The waiting card
keeps the dispatch worker slot it was given — the capacity queue reports the cards
it is still waiting for, since a summary left behind by a restart would otherwise
hold a slot forever — so the worker limit still caps how many cards start. A
follow-up to a live Pi session waits the same way: the session keeps running and
its own summary gains the capacity-wait marker and queue position, and Kanban
writes the input once a slot frees; a session whose in-flight turn already
reserves the card's slot is written to immediately. Stop
cancels a
queued Pi turn - its CLI is never launched and a queued follow-up is never
written; a queued CLI that cannot spawn
marks the card failed. Bulk-stopping a workspace's sessions — runtime shutdown,
project removal, workspace disposal — cancels that workspace's queued starts the
same way, because the stop can only reach processes and the slot it just freed
would otherwise admit a new CLI against a manager being torn down; the card is
left idle rather than failed, and relaunched by the next reconciliation. Cline
pause, abort, clear/trash cleanup and runtime disposal cancel pending admissions
so they cannot start later. The waiting queue
is held in memory; interrupted work must be resumed after a runtime restart.

## Other limits

- The reliable backlog dispatch policy's `taskDispatchPolicy.workerLimit` remains
  an independent per-workspace launch cap (default 1, maximum 4). Set it to 2 via
  the runtime config API if two automatically dispatched cards are desired. This
  policy still requires deterministic delivery when enabled. A Pi card waiting for
  a model slot counts against this cap while it waits, exactly as a running card
  does, so a queue of waiting cards cannot drain the backlog into In Progress.
  Manually started
  cards use the model queue directly.
- Reservations cover this Kanban process, not other clients (such as Home
  Assistant) or separate Kanban processes. Server queuing and HTTP limits remain
  authoritative for those clients.
- Different model IDs, including inference-server model aliases, have separate
  pools. Use the same model ID for consumers that should share a budget.
- `/props` is llama-server metadata, not a standard OpenAI API. Custom provider
  authentication requiring headers other than Bearer may need a manual override.

## Deployment and verification

Use the existing build/deploy workflow and refresh the browser after deployment.
For Qwen with two 262,144-token slots, keep llama-server's `--ctx-size 524288
--parallel 2` and the advertised per-request context at 262,144. Confirm:

```sh
curl -fsS 'http://127.0.0.1:8080/props?model=qwen3.8-27b' \
  | jq '{total_slots, n_ctx: .default_generation_settings.n_ctx}'
```

1. With the override empty, start three independent tasks using that endpoint
   and model. Two run; the third displays the waiting activity without a start
   failure or a move to In Review.
2. Complete one turn. The third starts automatically even if the completed SDK
   session remains live and idle.
3. Repeat, pausing the waiting card before capacity frees. It must not launch
   later. Send a new message or start it again to resume.
4. Set the override to 1 and start two tasks. One waits. Clear the override and
   start fresh turns to return to discovery.
5. Test a provider without `/props`: tasks serialize and queue without errors.
   A failing turn must release capacity for the next queued task.
6. With both slots busy on Pi, send a message to a settled Pi task from task
   chat. The card shows **Waiting for model capacity** with its queue position
   while the session stays live, and the message reaches Pi by itself once a
   slot frees. Stop cancels the wait and never writes the input.

Waiting board cards show `q #1`, `q #2`, and so on in place of the phase badge. Positions are FIFO within each endpoint/model pool and update when a waiting turn is canceled or admitted. The normal phase badge returns when the turn starts. A queued Pi start has no queue-position badge, because that badge belongs to a running queued Cline turn: its card shows the waiting summary text instead, and the record carries the same queue position for diagnostics until its CLI spawns.


## Returning an unstarted queued task to Backlog

Drag an eligible queued card from In Progress to Backlog. Only an initial turn that has never reached the SDK/model is eligible; queued follow-ups, restarts with session history, and tasks with prior work cannot be returned. The runtime checks eligibility again at drop time. If the turn has started since the browser rendered its queue badge, the return is rejected.

For a successful return, Kanban cancels the waiting admission, drains its pending start, removes the clean detached worktree, and clears its prepared baseline and preparation-only recovery metadata. The queued initial chat entry and session summary are cleared. The card keeps its model, prompt, images, base ref and **Update base ref before starting** preference. Its next manual start runs preparation again; with updating enabled, it fetches the current base and creates a new worktree from that baseline.

A dirty worktree, untracked files, actual ignored files/directories, task commits/branches, saved patches, preserved archives, or delivery/session history block the return before cancellation or cleanup. Mirrored ignored dependency/config symlinks are permitted; their source files are not removed. Cleanup uses Git's normal worktree removal, with no forced deletion. If cleanup fails after cancellation, the card stays In Progress in an interrupted state with the error available.

A durable manual deferral prevents automatic backlog dispatch or restart reconciliation from immediately launching the returned card again. Start it manually (including Start all) to clear the deferral. No new settings or environment variables are required; deploy Kanban and refresh the browser.

## Pi PR / CI handoff

Every **non-empty initial Pi coding prompt** now includes the shared PR CI handoff
instruction: complete local verification, publish the PR, report it and end the
turn. Do not sleep, poll for checks, run `gh pr checks --watch`, or wait for
CI/reviewer completion. The reviewer and Kanban's comment handling own follow-up
feedback. Explicit user instructions to monitor CI still take precedence.
Empty session-restore prompts stay empty, preventing accidental replay.
