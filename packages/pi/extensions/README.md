# Extensions

The extension set is grouped by responsibility:

| Group | Files | Purpose |
| --- | --- | --- |
| Display | `compact-display.ts` | Fold long thinking blocks and bash titles while showing omitted counts |
| Header | `magic-header.ts` | Custom startup header; show compact Skills and Extensions as one bullet per line |
| Safety | `command-guard.ts` | Review heavy/destructive commands and collect rejection feedback |
| Interaction | `magic-ui.ts`, `../themes/magic.json` | Codex-style editor/footer, matching theme, and upstream IDs appended to `/session` |
| Session | `clear.ts` | Start a clean session with confirmation |
| Quota | `codex-quota.ts` | Clear stale quota status; no credential access or polling |
| Sampling | `siflow-sampling.ts` | Override sampling only for the explicitly matched siflow model |

See [package setup](../README.md) for installation and migration. The optional legacy `install-extensions.sh` removes listed legacy extensions; native package installation does not. Run the following test commands from the package directory (`packages/pi/`), not this `extensions/` directory.

`magic-header.ts` formats the compact `[Skills]` and `[Extensions]` sections as lists without
changing expanded resource details. Pi 1.1 has no public resource-list renderer
hook, so this uses a guarded, in-memory adapter for the matching startup component.
It does not modify Pi package files or global prototypes, and restores the
component when the header is disposed. A future Pi version that changes these
internals may require an adapter update. Reload after installing the extension.
Run its formatting, narrow-width, and adapter lifecycle tests with:

```sh
node --test tests/extensions-list.test.mjs
```

`codex-quota.ts` currently clears the weekly quota status and performs no polling
or credential access. The new `openai` ChatGPT OAuth token is rejected by the
legacy usage endpoint; no compatible quota source has been verified yet.
`/quota` explains this limitation instead of showing an unavailable placeholder.
Run quota tests with `node --test tests/codex-quota.test.mjs`.

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
