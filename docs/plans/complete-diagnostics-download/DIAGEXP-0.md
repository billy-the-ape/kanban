# DIAGEXP-0 — Expanded tool I/O visibility in the chat panel

Part of the **complete task diagnostics as a browser download** feature. The master plan
lives in [PLAN.md](./PLAN.md). This document is a self-contained execution brief for the
first implementation PR (slice **DIAGEXP-0**: expanded tool I/O visibility in the chat
panel). It represents a single PR.

| Field | Value |
| --- | --- |
| Document revision | 1 |
| Prepared | 2026-10-08 |
| Status | planned; no milestone started |
| Source baseline | `7a64060` (main) |
| Fork | https://github.com/billy-the-ape/kanban |
| Prerequisites | None — independent of DIAGEXP-1/2/3 |
| Follow-on | DIAGEXP-1 and DIAGEXP-2 (independent of each other), then DIAGEXP-3 after both |

## Purpose

The current Export diagnostics button writes a redacted JSON file to the runtime host,
removing the entire session transcript including tool arguments, outputs, errors, and
reasoning. During investigation of task `0e05l`, this prevented distinguishing an omitted
editor `old_text` argument from suspected argument stripping. This brief closes that
visibility gap at the cheapest layer: the chat panel's expanded tool blocks.

In the expanded tool block:

1. Retain the existing readable `run_commands` rendering unchanged.
2. Also show the **exact recorded JSON input** for editor and other tools, with output and
   error sections.
3. Distinguish SDK-level errors from structured per-operation errors.
4. Make JSON selectable/copyable; long content may use a scrollable block, but content must
   not disappear solely because the tool is not `run_commands`.
5. Render recorded content as text, **never execute HTML**.
6. Keep collapsed summaries unchanged.

Immediately after this PR, a remote user can open an expanded editor tool block in the
browser and see the exact recorded `old_text`/`new_text` arguments — no SSH, no export
file. The full-download feature (DIAGEXP-2/3) is not required for this brief to be useful.

## Fixed decisions carried in from the master plan

These are settled. Implementation may choose local helper names and file layout, but not
the product rules.

- The existing full-input block is hard-labelled "Command"
  (`cline-chat-message-item.tsx:80`); once it also shows editor/other JSON, the label must
  read `Input` for non-`run_commands` tools.
- The expanded view parses the display string by line prefix (`parseToolMessageContent`:
  lines equal to `Input:`/`Output:`/`Error:`/`Duration:` switch sections). Pretty-printed
  JSON inputs are safe (strings are escaped), but a raw string output containing a line
  that is exactly `Error:` would be mis-sectioned. **Note this limitation in the code and
  cover it with a test** rather than inventing a new encoding.
- "The UI labels any persisted excerpt as such" means detecting `Full content:` /
  `full output:` / `...[truncated` in the persisted prose. This is the exact parsing the
  export path deliberately avoids — it is fine for the UI because the UI only labels, it
  does not recover content.
- Archived full outputs need not be loaded into every chat block; the export (DIAGEXP-2)
  includes them. Do not add artifact fetching to the chat panel.
- This is a display-only brief: no new API, no export behavior, no changes to how tool
  input/output is recorded, bounded, or persisted.

## Scope

Allowed:

- `web-ui/src/components/detail-panels/cline-chat-message-utils.ts` — `getToolDisplay`,
  `parseToolMessageContent` (section parsing, `Error:`-line limitation, excerpt-label
  detection), and the display-string helpers used by the expanded block.
- `web-ui/src/components/detail-panels/cline-chat-message-item.tsx` — expanded tool block
  rendering: JSON input display for non-`run_commands` tools, output/error sections,
  selectable/copyable + scrollable content, `Input` vs `Command` labelling, text-only
  rendering.
- `web-ui/src/components/detail-panels/cline-chat-message-utils.test.ts` (and any adjacent
  web-UI test suites) — the tests below.

Explicit non-goals:

- No changes to `src/cline-sdk/` event adaptation, tool-result bounding, or persistence. If
  a needed display string is already produced by the SDK adapter, render it; do not change
  what the adapter records.
- No export/download changes, no new tRPC or HTTP surface, no backend changes.
- No collapsed-summary changes, no new UI settings, no new dependencies.

## Source map (reinspect before editing; baseline is historical)

- `web-ui/src/components/detail-panels/cline-chat-message-item.tsx` — expanded tool block;
  the full-input block at `:80` is hard-labelled "Command" and the panel hides input for
  non-`run_commands` tools today.
- `web-ui/src/components/detail-panels/cline-chat-message-utils.ts` — `getToolDisplay` /
  `parseToolMessageContent`; the display string is parsed by line prefix into sections.
- `src/cline-sdk/cline-event-adapter.ts` and `src/cline-sdk/cline-session-state.ts` — where
  raw events become chat messages and tool display strings (read-only context for this
  brief; these are the source of truth for the display string format).
- `src/cline-sdk/cline-tool-result-bounding-hook.ts` / `cline-command-output-excerpt.ts` —
  produce the `Full content:` / `full output:` / `... [truncated` prose that the UI must
  detect and label as an excerpt (read-only reference).
- Styling: Tailwind utility classes with the existing design tokens (`bg-surface-2`,
  `text-text-secondary`, `border-border`, `rounded-md`); no `dark:` prefixes; no Blueprint.

## Implementation tasks (in this order)

- [ ] DIAGEXP-0.1 **Exact recorded JSON input for non-`run_commands` tools.** In the expanded
      tool block, show the exact recorded input for editor and other tools as JSON (the same
      recorded values the SDK persisted — do not re-derive or re-pretty-format from the
      collapsed summary). Retain the existing readable `run_commands` rendering as-is.
- [ ] DIAGEXP-0.2 **Input labelling.** Relabel the full-input block: `Command` for
      `run_commands` (unchanged), `Input` for all other tools.
- [ ] DIAGEXP-0.3 **Output/error sections.** Show output and error sections for all tools,
      distinguishing SDK-level errors from structured per-operation errors. Keep the
      line-prefix section parsing (`Input:`/`Output:`/`Error:`/`Duration:`) and document the
      known limitation: a raw output line that is exactly `Error:` is mis-sectioned.
- [ ] DIAGEXP-0.4 **Selectable, scrollable, text-only rendering.** Make the JSON/content
      blocks selectable and copyable; use a scrollable block for long content. Render
      recorded content as text only — never execute HTML (no `dangerouslySetInnerHTML` on
      recorded content; hostile markup displays as inert text). Content must not disappear
      solely because the tool is not `run_commands`.
- [ ] DIAGEXP-0.5 **Excerpt labelling.** Detect `Full content:` / `full output:` /
      `...[truncated` in the persisted prose and label the displayed block as an excerpt.
      Do not fetch archived full outputs into the chat block.
- [ ] DIAGEXP-0.6 **Tests** (ship with this PR) — see the acceptance table below.

## Acceptance and tests

Web-UI suite at minimum:

| Scenario | Required result |
| --- | --- |
| Expanded editor block, recorded input present | Shows actual JSON input with `old_text` present and exactly as recorded |
| Expanded editor block, recorded `old_text` absent/empty | Absent/null/empty distinctions preserved in the displayed JSON — no invented values |
| Tool with output and error | Output and error sections render; SDK-level error vs structured per-operation error are distinguishable |
| `run_commands` expanded block | Readability identical to today (regression check) |
| Hostile markup in recorded content (e.g. `<script>`, `<img onerror=…>`) | Displayed as inert text; nothing executes |
| Raw output line that is exactly `Error:` | Behaves per the documented limitation (mis-sectioned), covered by an explicit test that pins the current behaviour |
| Persisted excerpt prose (`Full content:` / `full output:` / `...[truncated`) | Block labelled as excerpt |
| Collapsed summaries | Unchanged (regression check) |

Run: web typecheck, the focused web-UI suites, Biome on changed files, and the repository's
required checks. Do not run Prettier.

## Settings, rollout, and documentation

No new environment variables, configuration, services, or storage. UI-only and
independently deployable: any `main` commit can be picked for a manual deploy
(`workflow_dispatch`-only workflow; see the master plan's deployment note). The PR
description must state that this closes the `0e05l` editor-input visibility gap, that
recorded content renders as text only, and the documented `Error:`-line limitation.

## Handoff

Record: changed files, the `Input`/`Command` labelling rule, the excerpt-detection strings,
the documented parsing limitation and its test, test commands and results, and any baseline
drift discovered against `7a64060`. DIAGEXP-1/2 then proceed independently; nothing in this
PR is a prerequisite for them.

## Stop conditions

- The recorded tool input for a tool type is not present in the display string or chat
  message data at all — record the gap and escalate to the master plan's owner rather than
  inventing a new recording path in this UI-only brief.
- A test requires executing recorded HTML or fetching archived artifacts — that violates
  this brief's non-goals; rework the fixture instead.
