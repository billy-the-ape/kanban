# Validation waiting and CI handoff

Native local Cline sessions can run long local checks with `validation_job`:

1. `start` launches the check once and returns its job ID.
2. `wait` observes that ID until completion or a bounded timeout. `timeoutMs`
   defaults to 25000 and accepts integers from 1000 through 25000. A wait
   timeout returns `running`; it does not kill or restart the check.
3. `read` pages the retained log. Inspect the recorded exit status before
   claiming success; a nonzero exit is still a failed check.

Repeated identical `status`/`read` observations of a running job are paced at
least one second apart. Prefer `wait` when there is no other useful work.
Different log pages remain immediately available. Cancellation of a wait
interrupts the observation; session stop/cancel still owns job cleanup.
The existing 30-minute job deadline remains in force.

The local repetition guard exempts successful `status`, `wait`, and `read`
calls only while the identified job belongs to this task and is running.
Unknown jobs, failed observations, repeated observations after completion,
duplicate starts, edits, and shell sleep loops retain the three-call warning
and five-call stop. The separate repeated-failure and timeout guards remain
active. The final tool result is persisted before a loop stops the run.
Hub-backed sessions retain the SDK's own loop guard and do not advertise the
local validation tool.

PR creation and repair prompts tell agents to finish required local checks,
publish, report their results, and end the turn. CI and review are asynchronous;
the reviewer consumes CI results and Kanban dispatches later feedback in a
separate turn. An explicit user request to monitor CI takes precedence.

## Deployment

No environment variables, dependencies, or data migrations are required.
Deploy and restart Kanban normally. New native coding sessions receive the
updated system guidance and local guard. Existing live sessions retain their
launch-time prompt and hooks; start a replacement session to adopt the change.
The default Auto-PR template changes; saved custom templates remain intact and
can be updated in Settings with the same CI handoff guidance. Generated PR
comment-repair turns receive the guidance independently of that template.

## Verification

Focused suites cover loop protection, owned-job observations, early completion,
wait cancellation, job cancellation/deadlines, observation pacing, local/hub
configuration, and prompt composition. Run the real 35-second process regression
with:

```sh
KANBAN_AR3_INTEGRATION=1 npx vitest run test/integration/validation-job.integration.test.ts
```

It makes more than five identical bounded waits through the real SDK agent loop
and verifies that the process finishes successfully beyond the ordinary
30-second command deadline.
