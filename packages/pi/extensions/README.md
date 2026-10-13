# Extensions

The extension set is grouped by responsibility:

| Group | Files | Purpose |
| --- | --- | --- |
| UI | `magic-ui/index.ts` | Single entry point for all UI modules below |
| Work recap | `idle-summary.ts` | After five idle minutes, append a Markdown work recap beneath the conversation |
| Safety | `safety-guard.ts` | Review heavy/destructive commands, confirm sensitive writes and `/clear`, and collect rejection feedback |
| Sampling | `siflow-sampling.ts` | Override sampling only for the explicitly matched siflow model |

See [package setup](../README.md) for installation and migration. The optional legacy `install-extensions.sh` removes listed legacy extensions; native package installation does not. Run the following test commands from the package directory (`packages/pi/`), not this `extensions/` directory.

## Idle work summary

`idle-summary.ts` starts a five-minute timer after `agent_settled` (not while tools or model responses are running). In TUI mode it appends a custom transcript entry beneath the conversation: a short Markdown title and emoji-prefixed bold labels, with the theme's `customMessageBg` background and no extra horizontal rule. The prompt requests four concise items (task, progress, caveat, next step), about 140 Chinese characters. It makes at most one attempt per completed work period. New input/work cancels pending generation but does not remove past summaries; dialogs pause the timer. Session navigation, compaction and shutdown cancel it. It does not generate summaries just because a session was opened.

The extension uses the current model for one additional, bounded request (up to 700 output tokens, 60-second timeout); provider charges apply. Only the latest 24 user/assistant text messages, capped at 24,000 characters, are considered. Tool output, tool arguments, images and thinking are excluded. Common credential patterns and links are redacted on input and output, but this is not a guarantee against all sensitive data. Summaries are persisted as custom entries in the existing session file and restored in the transcript by the entry renderer. They are not sent to the LLM as context and do not create compaction entries or separate files. The summary is a best-effort reminder, not authoritative task state; errors are silently skipped until new work completes. RPC/print modes do not make requests. Reloading clears the timer, not historical summary entries.

Use `/idle-summary` to inspect loading, pending timer and the latest generation outcome without making a model request. Use `/idle-summary now` in an idle TUI to immediately test generation (one billed model request). Diagnostics are in memory only and omit provider error bodies. Reload after updating; reload itself does not start a summary timer.

Run `node --test tests/idle-summary.test.mjs` for offline lifecycle, cancellation, diagnostics and redaction tests.

## Magic UI modules

Only `magic-ui/index.ts` is discovered as an extension; other modules are imported by it:

- `header.ts`: startup wordmark and resource-list presentation.
- `editor-footer.ts`: editor, footer, selection-card renderer, working indicator and session info.
- `compact.ts`: folded thinking and bash call display (does not change command execution).
- `block-timing.ts`: right-aligned, dim per-block durations for Thinking, Output and tool calls.
- `questionnaire.ts`: generic `questionnaire` tool with `single`, `multiple`, `confirm` questions. Defaults are not consent; `cancelled: true` always returns empty `answers`. Not a credential input form.
- `quota.ts`: `/quota` command and optional quota snapshot status.

`magic-ui/header.ts` shows a static NAVI wordmark in the theme accent color, followed by
`Hey Listen! · π <version>` in muted color. Narrow terminals fall back to a compact
`NAVI` label; the header has no animation timer. Shortcuts and expanded help remain available.

It also formats the compact `[Skills]` and `[Extensions]` sections as aligned,
width-responsive tables (up to four columns, falling back to one) without
changing expanded resource details. Pi 1.1 has no public resource-list renderer
hook, so this uses a guarded, in-memory adapter for the matching startup component.
It does not modify Pi package files or global prototypes, and restores the
component when the header is disposed. A future Pi version that changes these
internals may require an adapter update. Reload after installing the extension.
Run its formatting, narrow-width, and adapter lifecycle tests with:

```sh
node --test tests/extensions-list.test.mjs
```

`magic-ui/block-timing.ts` adds a dim right-aligned duration to each assistant content
block's header and each tool call's first visible line. Live times refresh once per
second; finalized times remain visible when collapsed or expanded. Thinking and
Output measure locally observed stream start/end events, **not provider-internal
compute time**; initial response/network wait is excluded. Adjacent thinking blocks
that Pi renders together show their summed durations. Missing historical timings
are not estimated. Assistant timings persist as custom session entries excluded
from model context; tools use Pi's persisted `durationMs`. Branch switches restore
only that branch's timing data. Tool timing labels and their padding inherit the
native pending/success/error background, without inheriting bold title styling.

When safety-guard triggers AI review or a confirmation dialog, the same tool header
shows `审查 1.2s · 等待确认 5.3s · 执行 0.1s`. Active stages update live; denied
or interrupted calls show `已阻止` / `已中断` instead of execution time. Ordinary
static checks add no labels. Review and user wait are measured separately using
async-local per-call state, published through `safety-guard:timing`, and persisted
as non-context custom entries. Pi emits tool start before guards, so the live
execution estimate restarts after approval; final execution uses Pi's recorded
duration. Late guard updates after a session switch are discarded.

Pi 1.1/1.2 have no assistant-block renderer hook, so a guarded instance adapter
is mounted through the header and restored on disposal;
no package files or global prototypes are changed. Test after Pi upgrades:
`node --test tests/block-timing.test.mjs tests/guard-timing.test.mjs`.

`magic-ui/quota.ts` performs no background polling. `/quota` only queries the official
legacy Codex usage endpoint for an active `openai-codex` model using OAuth, with a
valid legacy account claim. It rejects custom gateways and API keys, does not follow
redirects, and discards responses after model/session switches. Results are timestamped
snapshots, not a live meter; window names come from actual durations, not assumptions.

The current new `openai` OAuth login was tested against the legacy endpoint and returned
HTTP 401 `no_matching_rule`. No compatible quota source has been verified for that login.
The command explains this limitation without fetching its credentials or polling.
Legacy success handling is covered with mocked responses, not a live legacy account.
Run quota tests with `node --test tests/codex-quota.test.mjs`.

The `questionnaire` tool accepts `{title, questions, submitLabel?}`. Each question has an
`id`, `prompt`, and `type`. `single`/`multiple` questions include `options: [{value,label}]`;
`default` is a string/array respectively. `multiple` supports `min`/`max` constraints.
`confirm` has an optional boolean `default` (false when omitted). Submit returns
`{cancelled:false, answers:{[id]: string | string[] | boolean}}`; cancel/abort/non-TUI
returns `{cancelled:true, answers:{}, reason}`. Space selects, Enter submits, Esc cancels.
Question IDs and option values must be unique; do not use the tool for secrets.
Questions and their business effects belong in skills, not this extension.

Deletion confirmation lists only absolute target paths in its body.
Long paths wrap instead of being truncated. Literal paths, quoted spaces,
`~/` paths, and a simple `cd directory && rm ...` are supported. Glob patterns
are shown without expansion, shell redirections are omitted, and expressions
whose absolute paths cannot be resolved are shown as written without extra labels.

`/session` keeps the built-in statistics and adds the latest upstream response ID
from the current branch. Request, trace, and upstream session IDs are captured
from a limited set of response headers and saved as `pi.upstream-response` custom
entries in the session JSONL; they are not added to the model context. Existing
sessions can display their saved `message.responseId`, but headers from earlier
requests cannot be recovered. Header names are displayed as returned (lowercase),
so upstream session IDs remain distinct from response IDs and the local pi ID.

The footer shows today’s token usage across local pi sessions (input, output, and
cache tokens, using the machine’s local date). Copied branch entries are counted
once. Usage refreshes every 15 seconds and after responses. The speed is output
tokens per second for the latest completed response, measured from the provider
request including first-token latency; it shows `—` until measured. Speed color
interpolates through the active theme's accent (0 tok/s), warning (75), and
thinking text (150+) colors, with pi handling the 256-color fallback.
The `magic` dark theme uses a Sichuan University-inspired warm-red palette:
vermilion accents, warm gold highlights, and ivory text. Thinking-level borders
progress from muted warm red to pale gold; green remains reserved for success
and added diff lines. Select `magic` in `/settings` after installing the theme.

The working indicator follows stream events: `Thinking` for reasoning,
`Responding` for answer text, `Preparing tool` for tool arguments, and
`Running tools` during execution. Before output starts it shows `Working`.
Each phase shows elapsed time (for example, `Running tools · 12s` or
`Thinking · 1m 5s`), refreshed every second and reset when the phase changes.
Parallel tools share a timer until all finish; timers stop on completion,
session switching, and shutdown.

Run all included tests with Node, optionally setting `PI_PACKAGE_ROOT` to the installed
`@earendil-works/pi-coding-agent` package directory:

```sh
node --test tests/*.test.mjs
```

The tests default to the installation selected by `~/.pi/agent/install/current-version`.
Selection-card rendering and event lifecycle tests are in `tests/magic-selection.test.mjs`.
No dedicated session-info test file is included in this package.

Good next additions:

- Context meter: show context-window usage and warn before compaction.
- Completion notification: terminal/desktop notification when a long turn finishes.
- Session labels/bookmarks: quickly name and return to useful branches.
