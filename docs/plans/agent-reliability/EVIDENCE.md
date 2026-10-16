# Historical diagnostic evidence

Study date: 2026-10-16. Nine deliberately selected completed tasks, including the
PRLINK-10 baseline; this is a case study, not a representative benchmark.
Exports were schemaVersion 3. Raw transcripts contain code and prompts and are not
committed here. Task IDs, session/message references, and tool IDs below let the
operator locate the source in their retained exports.

## Comparable observed counts

Inherited snapshots were deduplicated using stable message/call identities and
arguments, with origin/timestamp checks. Raw replayed entries are not executions.

| Task | Recorded session span, minutes | Distinct model responses | Distinct tool calls | Failed editor calls | Reported output tokens |
| --- | --- | --- | --- | --- | --- |
| `47ba3`, Auto-PR fix | 18.8 | 32 | 30 | 0 | 13,224 |
| `hg3b2`, DIAG-1 | 59.2 | 48 | 68 | 0 | 41,078 |
| `cf2ht`, DIAG-0 | 60.5 | 101 | 102 | 10 | 62,261 |
| `blwzb`, PRLINK-10 | 127.2 | 164 | 195 | 17 | 165,612 |
| `ogp7z`, Remove installedPrConsumers | 245.0 | 278 | 333 | 31 | 120,839 |
| `sg5pr`, PR #71 repairs | 249.5 | 230 | 264 | 11 | 146,615 |
| `5uskm`, PAUSED-PILL | 259.2 | 468 | 495 | 38 | 234,177 |
| `0c587`, PRTRACK-0 | 641.2 | 816 | 823 | 43 | 1,086,195 |
| `k78hy`, PRTRACK-1 | 905.2 | 1,170 | 1,232 | 91 | 877,654 |

All have recorded model label `lmstudio/qwen3.8-27b-gsq-iq3s`. That label does not
prove equal effective sampling, server load, GPU power limit, or tool configuration.
The older slow tasks had a 6,000-character editor wrapper limit; later tasks had the
larger local adapter. Session spans include waits and exclude between-session gaps;
they are not active inference or CPU time.

## Concrete episodes and limitations

- **Baseline aggregation:** `blwzb` has 195 distinct calls, despite 700 raw call entries.
  Reducer v1 matched calls, responses, and tokens but reported 17 failures versus 21
  independently verified structural failures. The durable-result adapter drops
  structured command arrays. Its 64 pipeline-risk tags are not 64 failed commands.
- **Malformed arguments:** seven malformed editor calls in `k78hy`/`0c587` account for
  36.8%/40.6% of their reported output tokens. Input plus output lands within 59 tokens
  of 262,144 for each. Parsed arguments are empty; raw payload and finish reason are
  unavailable. Context-boundary truncation is a hypothesis, not an established cause.
  Treating unknown arguments as `{}` creates false unchanged-retry evidence.
- **Failed session from repeated omissions:** `5uskm` initial session
  `5uskm-1792012081662-rwe28e13`, messages 377/379/381, sends the same existing-file edit
  without `old_text` three times. Final tool call `cz1CmOrtsq1otHFgtBJ4rPR76I7HwaBS`
  returns the retry guard; the session ends failed, exit 1. Across the task: 30 missing
  anchors and eight replacement mismatches. Recovery instructions already existed.
- **Claimed versus submitted corrections:** `ogp7z` initial session messages 74/78/80
  submit identical wrong indentation while reasoning claims correction. Selected
  messages 72-94 account for about 10.9 minutes of model-turn turnaround. The review
  session messages 538-550 add about 6.5 minutes, including literal backslash-t input.
- **Planning:** `47ba3` has two planning-heavy responses totaling 4,521 output tokens
  and about 6.1 minutes turnaround. `sg5pr` initial session messages 21 and 38 total
  16,699 output tokens and about 23.7 minutes. These are manual episode labels, not
  a deterministic classification of all reasoning, and not proven recoverable savings.
- **Publication:** `hg3b2` embedded Markdown/backticks in a double-quoted shell argument,
  causing command substitution and a corrupted PR description. Repair/verification
  involved about 5.5 minutes turnaround. `47ba3` received body-file guidance and
  published successfully. Current Auto-PR already contains body-file guidance.
- **Long validation:** `sg5pr` messages 164/166/170/196 in its initial session and
  426/461/468/478 in its final merge session explicitly time out after 30,000 ms.
  These include foreground checks, background launches, and polling. A shell's
  `timeout 600` cannot extend the outer tool deadline. Baseline-failure reproductions
  and ordinary failing validation are not automatically avoidable mistakes.
- **Review feedback freshness:** `cf2ht` repair round 1 ends with no findings and
  passing checks (`msg_dP8KBlOf`). Round 2 repeats the original finding; its final
  `msg_R6ad90k5` says the fix was already applied and verifies it again. The extra
  session lasts about 1.1 minutes. The saved handoff also has null `startingCommit`,
  empty `changedPaths`, and empty `planDocuments`; the reviewer reconstructed the
  change set. Turn/result correlation is a candidate cause, not yet reproduced.
- **Coverage false positives:** `cf2ht` artifact warnings reference fixture markers
  in successful editor diffs, including tool `ZUv7894ilv9SouBZ5DUkUNQCZa7zSLPX`.
  Those are not demonstrated missing execution logs. The common empty terminal
  summary warning is separate from native transcript completeness.
- **Unknown outcome:** failed `sg5pr-1791898525431-59qtmhvm` retains one unmatched
  command call `xKhF7jK2BkfXej4vLf1LSfcWgmpwYrQh`. No result establishes whether the
  command ran or failed; the later resume succeeded.

Model-turn turnaround includes generation, prompt processing, and possible queues.
Task activity overlap does not prove simultaneous GPU inference. Large task totals
also include review rounds, publication, requested merges, and legitimate verification.
No estimate above is a promised time saving.
