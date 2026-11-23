# Task worktree recovery

Removing a task checkout preserves its local Git commit through a task recovery
ref, captures a binary patch when possible, and writes a full worktree archive.
Cards and chat history are separate from the checkout. A remote branch is not
required to recover while the local repository's recovery ref and objects remain
available; the archive alone is not a replacement for backing up that repository.

Archive creation and extraction drain subprocess output without Node's `execFile`
buffer limit. A noisy tar process can finish; a failed process reports its actual
exit code or signal and bounded first/last stderr diagnostics. A nonzero exit is
still a failure, even if some files were extracted successfully.

Recovery, task start, and workspace ensure reject failed preserved-content
restoration. They remove the newly created incomplete checkout, retain the
preservation assets, and do not mark preservation active. An explicit retry can
then restore from the retained assets after the underlying error is corrected.
If both patch application and archive fallback fail, both errors are reported.

## Deployment and existing partial restores

Deploy the updated Kanban server. No new environment variables, migration, or
timer installation is needed. This change does not enable scheduled archival.

An existing checkout left by an older failed recovery is not automatically
overwritten: recovery treats an existing valid Git checkout as authoritative.
Keep that task paused and inspect its preserved archive and live contents before
repairing it. Do not delete or rearchive an incomplete checkout over its good
preservation assets. A tar comparison checks archived entries but does not detect
extra live files absent from the archive.

On AI-MONSTER, task `045zr` initially reported `stderr maxBuffer length exceeded`.
Its archive extracted successfully into an empty temporary directory. Comparison
against the partial checkout found matching source content but missing
`node_modules` entries. Direct extraction into the paused checkout completed with
exit 0 and no stderr, followed by a full archive comparison with exit 0. The
original service-side tar diagnostics were lost to the buffer error; the precise
cause of those diagnostics remains unconfirmed.

## Validation

```sh
npx vitest run test/runtime/workspace/task-archive.test.ts test/integration/task-preservation.integration.test.ts test/integration/task-worktree.integration.test.ts
npm run typecheck
```

The tests cover multi-megabyte subprocess output, real exit/signal/spawn errors,
and failed restore/retry behavior through all three preservation entry points.
