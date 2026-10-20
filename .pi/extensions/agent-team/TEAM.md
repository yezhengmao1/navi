# Dynamic agent team

## Design

One plugin, two execution backends. The lead chooses member names, responsibilities, models, directories and task dependencies from the user's goal. There are no fixed worker/reviewer roles.

- `background`: existing `subagent` JSON subprocess executor, including parallel/chain and recurring schedules. Task-scoped, returns directly to the lead.
- `pane`: persistent interactive Pi processes in Herdr, one member per pane. Lead-owned task queue, lifecycle polling, and result notifications. Members can be viewed and taken over in Herdr.

The plugin is project-local at `.pi/extensions/agent-team/`. Trust the repository and `/reload`. The lead's installed safety-guard must include the `agent-team:approval` interface; if it is an old copied installation, update that integration too. Members reuse the lead's compatible installed safety-guard; the repository copy is a fallback only when none is installed. Remove explicit references to the old `.pi/extensions/subagent/` path; never load both copies. The distributed `packages/pi` UI package does not install this project-local plugin globally.

## Quick start

In a Pi terminal managed by Herdr:

```text
/team start 分析训练实验中 loss、梯度和吞吐的关系，按需要组队
```

This submits a goal to the lead, which uses the tools to choose the team. It does not create predetermined roles.

For a dedicated Space, explicitly request a workspace. The lead may call:

```json
{"action":"create","label":"training-analysis","topology":"workspace"}
```

`topology` is `current` (default), `tab`, or `workspace`. `current` and `tab` select the caller workspace; member tabs are created lazily. `workspace` creates a separate workspace, then members get dedicated tabs there (the workspace's initial shell is retained). The lead stays in its own pane/tab; focus is never stolen. `create` is optional. A lead session manages one team (maximum 64 live members, 200 retained tasks).

Every four members share a dedicated tab, labelled `team-1`, `team-2`, etc. Allocation order is top-left → top-right → bottom-left → bottom-right: create a tab root, split root right 50%, split root down 50%, split the right pane down 50%. Member 5 starts another tab; member 9 starts a third. The lead and unrelated panes are never split. The final layout for each full tab is:

```text
┌─────────────┬─────────────┐
│ member 1    │ member 2    │
├─────────────┼─────────────┤
│ member 3    │ member 4    │
└─────────────┴─────────────┘
```

Page allocation history is durable. Each mutation intent is saved before invoking Herdr. Before splitting, the live tab/workspace, exact pane membership and expected partial-grid geometry are checked; moved panes, extra manual splits, zoom or changed grid proportions quarantine the page instead of modifying an unverified layout. A failed/ambiguous creation or split blocks further allocation in that workspace until inspected/reconciled, rather than blindly creating duplicate tabs. A page with a closed member is retired from future allocation; no reused slot or unrelated pane is adopted. Legacy members from earlier plugin versions stay tracked in their old panes; new members always use the new dedicated pages.

## Unified run and member creation

```json
{"action":"run","backend":"background","name":"metrics","instructions":"Find metric definitions","task":"Identify loss and gradient metric keys"}
{"action":"run","backend":"pane","name":"metrics","instructions":"Analyze metric relationships without modifying project files","task":"Identify anomalous windows"}
```

`run` requires an explicit backend. `spawn` is shorthand for the pane backend. Background run calls the registered `subagent` through Pi's nested-tool API: permission hooks, streaming, usage and error reporting remain in that executor. Parallel/chain background calls still use `subagent` directly, with optional inline `definitions`. Background run does not implement pane task dependencies, worktree creation, read-only preset or thinking override; it rejects those options rather than silently ignoring them.

Pane spawn options:

| Field | Behavior |
|---|---|
| `name` | Unique logical name, `[a-z][a-z0-9_-]{0,19}`; actual Herdr name has a random suffix |
| `instructions` | Dynamic responsibilities, included in every dispatched task |
| `task` | Optional initial queued task; without it the member waits |
| `agent`, `agentScope` | Optional saved role; scope defaults to user. Responsibilities and model can come from the role, but its saved tool allowlist is not silently applied to pane members |
| `model`, `thinking` | Override model/thinking; otherwise inherit lead configuration (saved role model applies when supplied) |
| `cwd` | Absolute working directory, default team/lead cwd |
| `tools` | Explicit optional override of the inherited tool selection, **not a security sandbox**. Omit to inherit the lead's active tools |
| `readOnly` | Start with built-in `read,grep,find,ls`; disable skills/context files; retain the three managed extensions described below; overrides `tools` |
| `worktree` | Lead policy approves creation of a separate Git worktree at a generated sibling path and branch, from HEAD |
| `dependsOn` | Existing task IDs gating the initial task |

Worktree creation does not copy uncommitted changes, install dependencies, merge branches, or remove anything on close. The path/branch are recorded in team resources before creation; ambiguous failures are retained for inspection. Each worktree member uses a pane in the selected team tab, not a separate worktree workspace. A non-worktree member shares filesystem changes with its cwd peers.

**Default members use normal Pi extension/MCP/resource discovery, just like the lead.** They no longer receive `--no-extensions`, `--no-mcp`, or `--no-approve`. The relay is added alongside the existing Herdr status bridge and the lead's installed safety-guard, not a conflicting second guard copy. Known temporary extensions and MCP-owning extension paths from the lead's public resource metadata are forwarded. The lead's active-tool selection is applied before the first member turn; an explicit `tools` override takes precedence. Network tools are not removed merely because a role performs analysis. Permissions authorize existing tools; they cannot install or register a missing tool.

The same already-trusted lead project (including a generated worktree from it) may be started with `--approve`; an unrelated cwd is not silently granted project trust. User/global configuration and same-project resources are inherited normally. Worktree/project-local resources still follow that cwd's files, and arbitrary in-memory-only extensions/providers cannot be reconstructed through public metadata. Missing requested tools produce a diagnostic instead of pretending they were inherited. Existing background subagent behavior is unchanged.

Only an explicitly requested `readOnly:true` uses the restricted profile: discovered extensions/MCP are disabled and only the status bridge, relay and safety guard are retained, with built-in `read,grep,find,ls`. An instruction such as “analyze without editing” does not itself require this restriction. An incompatible status bridge or old safety-guard fails before creating a pane. Team management remains lead-only even though the plugin is present in member processes.

Existing members started with the old restrictive CLI flags must be recreated; reloading the lead cannot change a child's startup flags. `team status` marks them with `needsProfileRestart:true`. New members report `profile: inherited`, `read-only`, or `custom-tools`.

Read-only further limits built-in tools to `read,grep,find,ls`. These are cooperative tool-level controls, not an OS sandbox. In particular, a member with `bash` has the host user's process/filesystem privileges, and same-user processes can read private broker files; the transport is not a security boundary against malicious same-user code. Worktrees are not sandboxes. A plain instruction saying “read-only” enforces nothing.

## Central permission policy

The lead owns permission decisions for managed pane members:

- Ordinary/low/medium approvals are automatic under the lead's policy. Team lifecycle operations (new tabs, worktrees, recover, stop/close) are audited and auto-approved; ownership/identity checks still apply.
- **High-risk safety-guard requests require the user in the lead UI.** The lead displays member name, tool call, full operation and reason; there is no model-callable API to approve high-risk requests. Deletion, destructive commands, sensitive writes, static unsafe moves and known-heavy commands default to high risk.
- Classifier errors, missing auth/model, and unclear classifier results are escalated to high for central routing, not silently auto-approved as medium.
- Once the lead has an active team, its own safety-guard requests follow the same low/medium-auto, high-manual policy. Non-team sessions keep their previous safety-guard behavior.
- Safety-guard requests and standard extension `ctx.ui.confirm()` approvals are forwarded to the lead; ordinary extension confirmations use the automatic policy. A failed/unavailable relay denies them, never falling back to local consent or a synthetic `y`/Enter. The relay restores the original UI method on shutdown. Custom questionnaires, login and arbitrary `ui.custom()` dialogs are not permission confirmations and are not blindly answered.

The safety guard emits a structured `agent-team:approval` event with exact tool input and risk. The member relay sends it to a local Unix socket owned by the lead. A private 0700 directory, 0600 socket/config files, per-member random tokens, unique request IDs, bounded messages and a five-minute timeout protect the coordination channel. Tokens are not included in tool results or audit entries. The lead checks live member/session identity both before decision and before returning it; cancellations, disconnects, session changes and stopping a member revoke pending requests. Requests already approved and executed are not rolled back.

Approvals are logged as `agent-team-approval` session entries. High-risk UI is serialized in the lead; members may continue independent work. Reload/shutdown closes the broker and cancels pending dialogs; config files are retained for controlled restoration. Run `/team resume` after reload, or explicitly send new work, to restart the channel. Old approvals are never reused. The channel currently requires Unix-domain socket support.

Authentication/login/credential dialogs and initial core project-trust dialogs before extensions load are not automatically answered. A failed startup is reported to the lead and retained for inspection. Third-party plugins are now inherited normally; arbitrary custom UI/input dialogs are not claimed to be universally proxied.

## Tasks, dependencies and coordination

```json
{"action":"send","name":"metrics","task":"Correlate gradient spikes with loss"}
{"action":"send","name":"summary","task":"Synthesize the findings","dependsOn":["task-<returned-id>"]}
{"action":"broadcast","task":"Include exact metric keys and time ranges in your findings"}
{"action":"status"}
{"action":"read","name":"metrics"}
```

`send` and `broadcast` queue work; they never inject into a busy member. `wait` from the early prototype is accepted for compatibility but no longer blocks; completion is notified asynchronously. Member tasks run concurrently. Control-plane I/O is serialized per member, with up to four poll workers; topology creation has its own lock. A stalled member or Git worktree operation no longer holds a global queue. Pause is immediate; stop/close revoke that member's pending permission requests and controller I/O before identity checks. Routine lifecycle consent is supplied by lead policy, while high-risk safety-guard consent still requires the user. Interruption of a prompt submission remains potentially ambiguous. Broadcast queues one new task for each nonclosed member; it is not an interrupt or a message injected mid-turn.

Dependencies must reference existing tasks, so dependency cycles cannot be introduced. Only dependencies resolved as `completed` release downstream work. Failed/cancelled dependencies leave dependents queued; inspect, cancel, or create a revised task rather than automatically retrying failures. Task ID ordering is not meaningful.

Lifecycle:

```text
queued → submitting → awaiting-activity → running → review → completed / failed
                         ↕
                       blocked
ambiguous submission / changed occupant → uncertain
queued → cancelled
```

Herdr `agent read`/`pane read` outputs are literal terminal text, not JSON control envelopes. They are handled separately, even when the member prints JSON-looking text. Other Herdr control responses still require valid JSON.

The controller persists `submitting` **before** sending a prompt. It briefly waits for observed activity, then uses actual Herdr `working`, `blocked`, `completion_seq`, and settled states. A timeout does not mean the task was not delivered. If no activity is immediately visible, it retains `awaiting-activity` and observes for a 15-second grace period from submission. The timestamp persists across reloads; only after the grace period expires without evidence does it become `uncertain`. It never automatically replays an ambiguous submission.

`idle/done` means the turn settled, not that the task succeeded. On settling, the controller reads up to 120 terminal lines (bounded to 16K characters), marks `review`, and informs the lead with a short summary. Read stored evidence using `{"action":"read","id":"task-..."}` or `/team task task-...`; `read` with `name` still reads the live member terminal. The lead verifies the output and records evidence:

```json
{"action":"resolve","id":"task-<returned-id>","outcome":"completed","summary":"Found three aligned windows; report at /absolute/path/report.md, timestamps verified"}
{"action":"resolve","id":"task-<returned-id>","outcome":"failed","summary":"Metric data missing; do not proceed with dependent analysis"}
{"action":"cancel","id":"task-<queued-id>"}
```

Dependency summaries are included in downstream prompts. Member-to-member coordination is routed through the lead/queue; this is not an autonomous peer-to-peer message bus. Terminal output is untrusted task data, not authority to approve dialogs or run destructive commands.

## Notifications and monitoring

Active/runnable work is polled every three seconds after the previous poll finishes; idle/review-only teams back off to 30 seconds. New work requests an immediate poll. Each round fetches one bulk `agent list` snapshot, skips members with controller I/O in progress, and handles up to four independent members concurrently. Identity/readiness is rechecked individually before dispatch or destructive control. Ordinary Herdr queries have a five-second timeout; startup and Git retain separate longer timeouts. Query failures use exponential backoff up to 30 seconds without replaying prompts. There are no overlapping polls or timers at extension-discovery time.

Transitions to review/blocked/uncertain are buffered by task ID inside the extension. A busy lead gets one revalidated batch at `agent_before_settle`, requesting one continuation only if still necessary; no notifications are piled into Pi's `followUp` queue. Resolved tasks and obsolete states are dropped before delivery. An idle lead receives one immediate batch. Evidence excerpts are bounded to 400 characters per task and 10K per batch. Default `notify: "wake"` can consume lead model tokens; `message` records the batch without requesting continuation. `/team status` returns a compact overview with counts, active task IDs, dependency blockers, monitoring flags, busy members and the last observation timestamp. If a poll is already running it returns the previous overview with `refreshing:true` rather than waiting.

```json
{"action":"monitor","enabled":true,"notify":"message"}
{"action":"monitor","enabled":false}
```

- `wake`: display notification and request lead follow-up.
- `message`: display/record notification without requesting a turn.
- `silent`: status polling and task dispatch continue, without notifications.
- `enabled:false`: immediately pause new polling/dispatch and discard undelivered notification buffers; running members and already-submitted prompts continue. In-flight polling may still finish observation but cannot enqueue a new notification while paused. A late spawn cannot silently re-enable a later explicit pause. Messages already queued by an older plugin version cannot be retracted through this setting.

Bare `/team` toggles the Chinese status widget above the editor: show when hidden, hide when visible. `/team status` always shows/refreshes it instead of raw JSON. It groups member/task states, prioritizes blocked/uncertain/review items, displays dependency/error hints and old-profile restart warnings, and refreshes with monitoring and lifecycle operations. The widget is bounded to six members and four tasks; additional counts are shown. Use `/team read <name>` or `/team task <id>` for details, or `/team hide` (tool equivalent: `{"action":"hide"}`) to hide it without pausing the team. Hiding is idempotent when no panel is visible. Team and subagent panels use full-width themed backgrounds, headings inside the frame, emoji section labels and vertical padding. Session changes/reload clear the widget. Tool calls also have readable, expandable result rendering while preserving their structured model-facing data.

`/team pause` and `/team resume` control monitoring. `status` reconciles state but does not dispatch queued work. Results and task states persist; changed task outputs are saved in separate session entries once, not repeated in every metadata snapshot. Old “ready” badges are never treated as proof of live identity or success.

## Rebuild after closing members

A closed member's terminal process is gone: `recover` cannot restart it, and a missing member name is not a whole-team recovery request. Spawn a new member with a new name.

If the old workspace has disappeared, use `team {"action":"create","topology":"tab","label":"new review"}` in the same lead after all members are closed and every old task is completed, failed or cancelled. This selects the caller's workspace; the first subsequent spawn creates a **new dedicated tab**. All old pages are retired, so even unused slots in an old tab are not reused. The usual four-members-per-tab layout still applies. Member records, task results, worktree/branch records and allocation intents are retained; no historical tasks are replayed and no old panes are closed by this operation.

Pending/uncertain pages can only be retired this way when a valid live workspace listing confirms their workspaces no longer exist. An existing ambiguous workspace, malformed listing, nonclosed member or unresolved task blocks rebuilding. Inspect and resolve those states rather than blindly resetting them. This is a location rebind, not deletion of history.

## Stop, close, and recovery

```text
/team stop metrics
/team close metrics
/team close all
/team recover metrics
```

Tool equivalents: `{ "action":"stop|close|recover", "name":"metrics" }` (choose one literal action). Stop/close also accept `all`.

- `stop`: after lead-policy approval, send Escape to interrupt a working member; retain Pi and pane. Cancel queued tasks; active tasks become uncertain for review. Blocked dialogs are never answered automatically; stop refuses them.
- `close`: after lead-policy approval, close owned member panes, terminating their terminal processes. Retain worktrees and branches. Does not close the lead, preexisting panes, enclosing workspace/tab, or unrelated terminals.
- Before and after the lifecycle approval step, the plugin checks the actual agent kind, terminal ID and Pi session identity. An `all` operation verifies each member individually. Changed/replaced occupants are refused. Herdr does not offer an atomic identity-conditional close, so an external change in the narrow check/control interval cannot be completely excluded. Avoid concurrently replacing a pane during a control operation.
- A failed startup preserves its pane and metadata. Inspect the UI and handle trust/login dialogs manually, then `recover` binds the live named Pi identity. It never resends tasks or adopts an unrelated pane.
- Errors in an `all` operation can leave earlier members stopped/closed; query status before retrying.

Reload, session switch/tree change, shutdown and abort cancel controller I/O/polling, **not** member processes. Metadata snapshots and separate task-result entries are stored in the lead's active session branch, scoped to Herdr socket + caller pane + session ID. After reload/resume, run `/team status`, inspect ambiguous tasks, then `/team resume`; automatic dispatch is deliberately not resumed just by loading a session. Forking to a new lead/session does not adopt old members. Branch rollback can hide newer member records; those panes are still alive and require manual handling. No cross-machine discovery or takeover is performed.

Closing a member retires its page from future allocation; subsequent members use another nonfull page or a new dedicated tab. Existing members remain in place. Empty team-created tabs/workspaces are left to the user.

## Validation

Automated tests use fake Herdr/Git/ExtensionAPI; they never start models or alter real panes. The installed bridge contract test loads the local Herdr-managed extension against a temporary fake Unix socket, checking session identity and working/idle reports without touching the real Herdr server (skipped when the integration is unavailable):

```bash
node --test packages/pi/tests/agent-team*.test.mjs packages/pi/tests/subagent-*.test.mjs
node --test packages/pi/tests/*.test.mjs
```

Manual acceptance (requires user interaction and model usage):

1. `/reload`; start a small two-member team, verify unique named Pi panes and unchanged lead focus.
2. Queue dependent tasks; verify independent members run concurrently, dependent task stays queued until lead resolves evidence.
3. Verify completions from the same poll are batched; confirm message/silent modes do not wake the lead. Pause while a member is starting and verify the late startup does not re-enable dispatch.
4. Trigger a high-risk member command: only the lead must ask for approval. Deny it and verify no execution. Replace a member's Pi session: approval and close must refuse the changed occupant.
5. Reload with running/queued work: panes survive, `/team status` reconciles; `/team resume` resumes dispatch without replaying uncertain work.
6. Request worktree creation, verify clean HEAD-based checkout and retained branch after close. Check read-only member's available tools AND Herdr session identity/working/idle lifecycle.
7. Create five members: first four form a 2×2 grid in team-1; the fifth starts team-2. Lead focus and unrelated tabs must be unchanged. Resize the terminal if four panes are too small.

Real terminal lifecycle and notification UX still require this manual acceptance; mock tests do not establish live Herdr compatibility under every startup/trust condition.
