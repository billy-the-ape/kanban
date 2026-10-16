# AR-2: Give failed edits bounded current-source evidence

Status: planned. One implementation PR into `main`. Dependencies: none.
Read [README.md](./README.md) and [EVIDENCE.md](./EVIDENCE.md).

## Outcome

After a failed editor call, the next model request contains the actual argument
defect and useful current-file evidence. The model can correct its input without
guessing tab counts or assuming that a parameter was dropped by the harness.

## Current integration points

- `src/cline-sdk/cline-tool-failure-recovery.ts`: existing targeted recovery envelope.
- `src/cline-sdk/cline-session-runtime.ts`: recovery before result bounding; trace
  currently records the original result before recovery.
- `src/cline-sdk/cline-editor-limit.ts`, `sdk-runtime-boundary.ts` and existing SDK
  executor/path contracts; `docs/runtime/editor-recovery.md`.
- Existing failure-recovery/editor-limit tests under `test/runtime/cline-sdk/`.

## Required implementation

1. Extend the existing envelope with additive, machine-readable editor evidence. Include
   field presence/type and lengths, exact-match count when safely calculable, and a
   timestamped current-source excerpt. Never echo the entire replacement payload.
2. Evidence reads are best effort after an approved failed call, confined to the task
   worktree after realpath checks. Skip external paths, symlink escapes, binary files,
   files over 256 KiB, and unreadable files with a reason. Use asynchronous bounded I/O;
   evidence failure must preserve the original editor error and never fail the session.
3. For nonempty `old_text`, count exact occurrences using SDK-equivalent semantics.
   For zero matches, a whitespace-normalized candidate may locate nearby source for
   explanation only. Mark candidates as approximate; do not invent an exact match.
   Show at most two windows, eight surrounding lines each, 6,000 characters total.
   If no trustworthy candidate exists, say so and request a targeted source read.
4. Show leading whitespace counts and literal escapes distinctly from source text:
   e.g. submitted two TABs versus candidate three TABs, or literal backslash-t versus
   a TAB. If `old_text` is absent, say it is absent in the parsed call; do not claim
   what the raw provider generated. Missing fields do not justify a full-file read.
5. For an unchanged repeated failure, reference the earlier call and explain which
   relevant fields remain unchanged. Keep existing guard thresholds/reset semantics,
   approvals, cancellation, and result pairing. Do not replay or rewrite the edit.
6. Preserve original output/error and existing artifact bounding. The final model-facing
   recovery envelope must retain the compact explanation within its output budget.

## Proposed feedback wording

Use only the sentence appropriate to the measured condition; substitute actual facts.
This is a replacement for overlapping existing recovery sentences, not a second essay.

```text
The parsed editor call is missing old_text. For a replacement, include path, an exact unique old_text anchor, and new_text in the actual arguments. Use insert_line only for an intended insertion.

The submitted anchor matched 0 times in the current file. The nearby source below is diagnostic evidence, not an automatically corrected anchor. Copy a short exact anchor from current source and include enough context to make it unique. Let the repository formatter handle indentation introduced by your edit.

This repeats the earlier failed arguments. The relevant fields have not changed. Correct the identified mismatch or read a targeted current section before another attempt.
```

Do not always insist on rereading when the returned fresh excerpt is sufficient.
Do not tell the model that source certainly stayed unchanged, that all mismatches are
whitespace, or that the tool removed a field. Source may change after the evidence read.

## Acceptance and verification

- Exercise missing anchors, absent/empty fields, ambiguous matches, wrong tabs, literal
  backslash-t, Unicode, long lines, CRLF, stale source, external paths, and read failures.
- A scripted SDK agent loop receives the original error plus enrichment on its next
  model request; run it with result bounding enabled and realistic large failure output.
- Input and repository files remain byte-identical after failed calls. Exact replacement,
  insertion, file creation, size limits, guard resets, denied calls, and cancellation retain
  existing behavior. No hidden enrichment read follows an approval denial.
- Run focused recovery/limit/bounding tests and backend typecheck; format changed files.
  Operator smoke: disposable file, wrong indentation then corrected unique anchor.

## Deployment and exclusions

No fuzzy application, automatic tool switching, new retry budget, raw provider logging,
or successful-diff rewriting. No settings/migrations. Normal rebuild/redeploy and new
native local session; hub-backed/terminal behavior remains capability-specific.
