# Cline model concurrency

Cline turns share a process-wide capacity queue keyed by normalized API endpoint
and model ID. Implementation, home-agent, review and verification-repair runtimes
use the same budget. A live but idle session holds no capacity. A turn holds its
reservation through SDK startup, generation, tool execution and compaction, and
releases it when the SDK turn resolves or fails.

## Automatic discovery

Leave **Settings → Cline → Concurrent Cline turns per model** empty. Kanban reads
`GET /props?model=<model-id>` from the provider endpoint, removing a final `/v1`
from the URL while retaining any reverse-proxy prefix. A positive integer
`total_slots` is the parallel capacity. Model names are URL-encoded; configured
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
automatic discovery. The global preference is stored as `clineConcurrencyLimit`
in Kanban's runtime config (`null` or absent means automatic). No environment
variables or database migrations are required. Settings affect new admissions;
queued turns retain the capacity resolved when they entered the queue, and active
turns are not interrupted when the setting changes.

Excess turns remain In Progress with **Waiting for model capacity**, then run when
capacity becomes available. Pause, abort, clear/trash cleanup and runtime disposal
cancel pending admissions so they cannot start later. The waiting queue is held
in memory; interrupted work must be resumed after a runtime restart.

## Other limits

- The reliable backlog dispatch policy's `taskDispatchPolicy.workerLimit` remains
  an independent per-workspace launch cap (default 1, maximum 4). Set it to 2 via
  the runtime config API if two automatically dispatched cards are desired. This
  policy still requires deterministic delivery when enabled. Manually started
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

Waiting board cards show `q #1`, `q #2`, and so on in place of the phase badge. Positions are FIFO within each endpoint/model pool and update when a waiting turn is canceled or admitted. The normal phase badge returns when the turn starts.
