# Team integration

## Managed background review

`magic_review_run backend=team` calls the EXISTING `team` tool's `run backend=background` API. It does not open Herdr panes, interrupt existing members, or implement a second persistent team controller.

The engine creates up to three independently scoped discovery invocations, awaits their completion, deduplicates candidates and runs a separate verification invocation. Each invocation receives the same bounded evidence pack. Only confirmed canonical findings are exported; duplicates/rejections/uncertainty remain in audit. Failure aborts siblings and awaits settlement. Timeouts/cancelled requests with unknown provider outcomes cannot replay.

Workers receive a dynamic unique role, evidence in the task, and an explicit read-only tool selection. They must not read unrelated files, spawn agents, edit sources or publish comments. Tool selection is not an OS sandbox. Existing team runtime may execute multiple model turns: maxCalls is a cap on managed worker invocations, not an underlying turn limit, and token accounting/preflight estimates are not a hard remote spending cap. Use the tool-free model backend when that stronger execution restriction is needed.

## Existing persistent team members

A user may independently delegate a review to an existing pane member. That member can load the same skills and run `backend=model`; it must not recursively request backend=team. The lead provides absolute skill path, working directory, target SHA/base or TeX evidence path/hash, focus, scope and budget. Member sessions do not inherit conversation context automatically.

Review evidence before resolving existing pane tasks; use actual team completion notifications, not shell sleep loops. Do not silently reuse busy members or change an unrelated team's monitoring policy. Existing pane lifecycle, permissions, paused state and recovery remain owned by the team extension.

User-scope installation makes skills available under standard member discovery. Resource-disabled profiles require explicit skill paths. Missing team tools fail explicitly; never pretend a team ran or silently substitute another backend.
