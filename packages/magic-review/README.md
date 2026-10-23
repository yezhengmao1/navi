# magic-review 0.2

Pi extension + skills for **local commit/range** and **LaTeX project** review. The managed pipeline now executes discovery, independent verification, deduplication, durable state and report export—not just prompts telling an agent to do so.

## Install / reload

```bash
pi install ./packages/magic-review
```

Already installed local packages load in place. Run `/reload`; existing team members need reload/restart. Host Pi supplies peer packages; no npm dependencies need installing.

## Entry points

```text
/magic-review code HEAD
/magic-review code main..feature
/magic-review code HEAD --team
/magic-review paper "paper/main.tex"
/magic-review paper "paper/main.tex" --team
/magic-review list
/magic-review show <run-UUID>
/magic-review cancel <run-UUID>
/magic-review resume <run-UUID>
```

Natural language also works: “帮我 review 最新 commit，重点看整洁和设计”, “用 team 审 main.tex”. A conservative input hook routes explicit code/paper requests to their skill; implementation requests, ambiguous mixed requests and negations are not rewritten. General language recognition still has limits; commands and `/skill:magic-review-code` or `/skill:magic-review-paper` are deterministic fallbacks.

Merge commits need an explicit base via the preparation tool/natural language. `A..B` is an **explicit aggregate base-to-target comparison** with up to 50 selected commits of metadata, not merge-base PR semantics or per-commit defect attribution. No worktree checkout or index changes.

## Managed pipeline

1. `magic_review_prepare`: collect evidence, create a UUID run and persist its budget. Optional `focus`, `base`, `previousId` and `budget` fields.
2. `magic_review_run`: claim the run, reserve each invocation before dispatch, discover candidates, validate every candidate in a separate request, and deduplicate by underlying issue.
3. Strict response validation: one verdict per candidate; confirmed, rejected, uncertain or duplicate. Duplicates must reference a confirmed canonical finding. Invalid responses cannot create a completed report.
4. Only confirmed canonical findings are exported; all candidate decisions and raw worker responses remain in the audit.
5. Save Markdown/JSON report revisions and run state under `<cwd>/.local/magic-review/<UUID>/`.

Default model backend uses **tool-free** model calls, not an unrestricted agent. Separate requests provide independent context, not a guarantee of independent reasoning or factual correctness. Findings include location, category, priority, trigger/claim, evidence, consequence, confidence basis, verification and suggestion. Cleanliness/design are first-class review dimensions, not automatically blocking defects.

### Evidence and partial coverage

Code collection uses fixed SHA objects for changed files, ancestor AGENTS.md/CLAUDE.md, and bounded heuristic tests/callers via `git grep`. No external diff/textconv runs. Context limits: 100 files, 2 MiB total, 256 KiB/file; filename-stem search is not a full symbol graph.

TeX collection supports literal input/include/subfile, import/subimport, main-root and referring-directory candidates, local cls/sty, bibliography, graphics paths and static label/ref/cite observations. Limits: 100 files, 2 MiB total, 256 KiB/file. Dependencies cannot escape the entry directory. It does not expand macros or emulate TeX search/scoping exactly; ambiguous/missing references are observations, not proof of build failure.

The model evidence pack preserves identity, file paths and up to 24k patch characters before bounded per-file context. The total prompt cap is 60k characters. Omitted character/hunk ranges are explicit. Collection completeness and actual review coverage are different. Large inputs may require smaller review scopes; omitted material is never represented as reviewed.

Long evidence strings use `{encoding:"concatenate-chunks",chunks:[...]}` so line-based Pi reads can reach all collected content. Concatenate with no separator.

### Images and reference metadata

For an image-capable model backend, up to four PNG/JPEG/WebP assets (2 MiB aggregate) are attached after signature, containment and full snapshot-hash checks. File order is listed in visualCoverage. Changed, unsupported and partial-hash assets are excluded with reasons. Team workers currently receive text only. PDF/SVG/EPS conversion is **not implemented**; no claim of final layout inspection is made without supplied images.

`magic_review_references` requests explicit interactive authorization to query literal bibliography DOI identifiers against HTTPS Crossref. Redirects, oversized responses and timeouts are bounded. Metadata availability does not establish citation relevance, novelty or scientific truth. Reference audit is saved separately, not silently injected into an existing immutable review.

## Findings UI and history

`/magic-review show <id>` opens a width-safe, scrollable findings browser:

- ↑/↓ navigate; Enter opens details; Esc goes back/exits.
- `p`: priority filter; `s`: triage filter; `c`: verification-decision filter.
- `a/d/r/o`: accepted / dismissed / resolved / open.
- `v`: independent recheck; `q`: discuss the selected finding.
- `x`: cancel owned active work; `u`: request safe resume.

Default list shows confirmed findings. Human triage is separate from verification verdicts. Recheck uses the **same snapshot**; changed source requires a new run with `previousId`. `magic_review_manage` provides list/read/compare/status/cancel operations outside the browser. Comparisons return added/persisting/notObserved using exact stable fingerprints; moved/reworded findings can appear new, and notObserved never automatically means resolved.

The widget shows stage, calls, tokens, recorded cost and elapsed time when stage updates arrive. Stored Markdown reports are immutable revisions; later triage is authoritative in `run.json`/the browser rather than rewriting prior report history.

## Team execution

`backend=team` / `--team` directly invokes the existing `team run backend=background` tool: up to three discovery tracks, then a verifier. It does not create Herdr panes or disturb an existing persistent team's members. Results are persisted, schema-checked and consolidated; failures cancel siblings and wait for settlement.

Normal persistent team members can themselves load this package and use `backend=model`. They must not recursively spawn reviewer teams. See [skills/team.md](skills/team.md).

**Budget boundary:** defaults are 8 managed invocations, 400,000 estimated tokens and 10 minutes. Invocation count and deadline are enforced by the engine. Token reservations are conservative estimates, with usage reconciled after responses—not a guaranteed remote billing ceiling. Existing external team agents can make multiple model turns and do not expose a hard output/turn cap through their API. Therefore `maxCalls` is **worker invocation count**, not external model-turn count; the team backend's token cap is advisory/accounting, not a hard pre-spend limit. The tool-free model backend has an explicit per-response output cap. Team workers receive a read-only tool selection, which is not an OS sandbox.

## Cancellation, recovery and persistence

Store updates use bounded mkdir locks, atomic replacements and schema validation. Competing starts reject without revoking a live owner. Locks are not silently stolen. Reload/startup never starts paid work.

Cancel propagates an abort signal to owned model/team invocations and waits for settlement. A submitted call without a known response is **uncertain**, even if cancellation was requested: it might have executed remotely. Such runs require inspection and a fresh run, never automatic replay. Known failed runs can reuse completed discovery only with identical evidence/settings. Another process's live run is not stopped or adopted by this extension. Artifacts persist across sessions; they are not an OS-security boundary against a malicious same-user process.

## Isolated tests / TeX compilation

`magic_review_verify action=probe` reports capabilities. `action=execute` requires an explicit interactive user selection for the exact request; noninteractive execution is denied. It requires usable Linux **bubblewrap + prlimit**, not merely installed binary names.

- No host fallback when isolation is unavailable.
- Read-only source mount, no network, no inherited credentials/home, dropped capabilities.
- Fixed system executable allowlist and argv, no shell parsing.
- CPU/address-space/file/process limits, bounded logs, timeout/abort process-group termination.
- Writable `/tmp` and `/out` are separate 64 MiB ephemeral tmpfs mounts, not host-writable directories; output files are discarded.
- TeX uses `-no-shell-escape`. Successful compilation is not mathematical validation.

Source trees (including hidden files) are readable inside the sandbox: choose a credential-free tree. This is Linux process/filesystem isolation, not proof against kernel exploits or every host-wide resource attack. Rootless sandbox execution must be tested on the deployment host.

On the current development host, **bubblewrap and TeX/PDF tools are unavailable**. Capability denial was tested; real sandboxed compilation was not. The plugin does not install system packages or silently weaken isolation.

## Testing and acceptance

```bash
cd packages/magic-review
npm test                         # offline fixtures/mocked workers; no model calls
python scripts/acceptance.py --live --team  # REAL calls; costs tokens
python scripts/acceptance.py --live --scenario team
```

Tests cover Git history/ranges/configuration, TeX confinement and observations, FIFO/byte limits, concurrent store and engine ownership, cancellation uncertainty, verification gates, semantic duplicate links, context packing, image hashes, mocked DOI requests, UI navigation/width/control sanitization, command routing and extension integration.

Live acceptance passed for a deliberately defective commit, a deliberately flawed TeX paper, and the real background team integration. The team acceptance exposed duplicate root-cause reports; the verifier contract was strengthened and rerun successfully with one canonical finding. See [ACCEPTANCE.md](ACCEPTANCE.md) for evidence paths and limitations. UI tests are automated component tests, not a claim of manual coverage on every terminal.

Research sources and adopted/rejected methods: [RESEARCH.md](RESEARCH.md).
