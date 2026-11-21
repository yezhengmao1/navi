# Delegated review (`--team` / `backend=team`)

Use `magic_review_run` for orchestration. With explicit user authorization for delegation, pass `backend=team`. This is a review mode, not a request to operate a persistent team. It requires the `subagent` tool from `.pi/extensions/subagent/index.ts`. If that tool is unavailable, report the error; do not silently switch backends.

The engine dispatches each discovery track and the independent verifier as separate single-subagent calls. Each receives an ephemeral role with only `read` selected. Workers should use only the evidence in the task; they must not delegate, edit files or publish comments. Tool selection is not an OS sandbox.

Only verified, nonduplicate findings are exported. Failure cancels sibling workers and awaits settlement. Do not replay uncertain calls. `maxCalls` counts worker invocations, not underlying model turns; token estimates are not hard spending caps. The default `backend=model` needs no subagent and uses tool-free requests.
